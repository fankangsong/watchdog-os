// classicy 内置 Finder（Macintosh HD）接入宿主机文件系统的适配器（FS Adapter 桥）：
//
//   reconcile（启动时）：调 /api/fs/list 把 FS_ROOTS 白名单目录翻译成 classicy FS 树，
//     以 { action: 'replace' } 整树替换内存假数据——Finder 从此显示宿主机真实目录；
//   onChange（操作时）：把 Finder 里的 mkdir / write / rmdir 回放为 /api/fs/* 调用落盘，
//     内存树先生效、磁盘随后跟上；回放失败只告警，下次启动 reconcile 以磁盘为准纠正。
//
// 路径映射：classicy 路径以冒号分段（如 'Macintosh HD:D_code:src:a.ts'），首段是卷名，
//   第二段是 FS_ROOTS 根的「安全名」（Windows 盘符 'D:\' 等含冒号/非法字符的路径
//   统一替换为 '_'），经 rootMap 还原为宿主机绝对路径后调用后端 API。
//
// 已知取舍：
//   - classicy FS 是全量内存树并持久化进 localStorage，SEED_DEPTH 限制递归深度，
//     未展开的深层目录显示为空壳（完整文件操作请用项目自带的 FinderApp / srv-finder.app）；
//   - 树里的文件只有元数据不含内容（_data 只适合内联文本），文本类标为 text_file/markdown
//     交由 EditorApp 打开（它经 /api/fs/read 现读现显），其余类型双击无处理器；
//   - meta（重命名/移动等元数据变更）与 load（整树替换）暂不回放磁盘，重启后以磁盘为准。
import {
  ClassicyFileSystemEntryFileType,
  ClassicyIcons,
  registerClassicyFileSystemAdapter,
} from 'classicy';
import type {
  ClassicyFileSystemEntry,
  ClassicyFileSystemJournalEntry,
  ClassicyFileSystemReconcileResult,
} from 'classicy';
import { dispatch, useClassicyFileSystem, useAppManager } from 'classicy';
import { useEffect } from 'react';
import { fsDelete, fsList, fsMkdir, fsWrite } from './api';

/** 卷名（桌面磁盘图标名 + classicy 路径首段）。classicy 以冒号分段，不能含冒号 */
const VOLUME_NAME = 'Macintosh HD';

/** 拉取深度：1=只列 FS_ROOTS 根的内容，2=再深一层……整树会持久化进 localStorage，勿设过大 */
const SEED_DEPTH = 2;

/** classicy 段名不能含分隔符/Windows 非法字符（盘符 'D:\' → 'D'） */
function safeSegment(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

/** 顶层根目录显示名：去尾分隔符与盘符冒号取末段（'D:\' → 'D'，'/' → 'root'） */
function rootLabel(rootPath: string): string {
  const trimmed = rootPath.replace(/[/\\]+$/, '').replace(/:$/, '');
  const base = trimmed.split(/[/\\]/).pop() ?? '';
  return safeSegment(base || 'root');
}

/** 顶层安全名 → 宿主机绝对路径。reconcile 成功后填充，onChange / classicyToHost 依赖它 */
const rootMap = new Map<string, string>();

/**
 * classicy 冒号路径 → 宿主机路径（'Macintosh HD:D_code:src:a.ts' → 'D:\code\src\a.ts'）。
 * 非本卷路径或未知顶层段返回 null——调用方（EditorApp）应原样使用该路径
 * （例如自研 FinderApp 打开编辑器时传入的本来就是宿主机路径）。
 */
export function classicyToHost(classicyPath: string): string | null {
  const segs = classicyPath.split(':');
  if (segs[0] !== VOLUME_NAME || segs.length < 2) return null;
  const root = rootMap.get(segs[1]);
  if (!root) return null;
  const rest = segs.slice(2).filter(Boolean);
  if (rest.length === 0) return root;
  const base = root.replace(/[/\\]+$/, '');
  const isWin = /^[A-Za-z]:/.test(root) || root.includes('\\');
  return `${base}${isWin ? '\\' : '/'}${rest.join(isWin ? '\\' : '/')}`;
}

/** 递归列目录并翻译为 classicy 条目；depth 到 0 时子目录只留空壳（惰性展示）。
 *  单个目录读取失败（无权限的受保护目录、悬空链接等）降级为空壳，不拖垮整树。 */
async function listDir(
  hostPath: string,
  depth: number
): Promise<Record<string, ClassicyFileSystemEntry>> {
  let entries;
  try {
    ({ entries } = await fsList(hostPath));
  } catch (e) {
    console.warn(`[hostFsAdapter] listDir failed for ${hostPath}; leaving empty`, e);
    return {};
  }
  const out: Record<string, ClassicyFileSystemEntry> = {};
  for (const e of entries) {
    const safe = safeSegment(e.name);
    if (!safe || safe in out) continue; // 安全化后撞名（极罕见）直接跳过
    if (e.type === 'dir') {
      out[safe] = {
        _type: ClassicyFileSystemEntryFileType.Directory,
        _icon: ClassicyIcons.system.folders.directory,
      };
      if (depth > 0) Object.assign(out[safe], await listDir(e.path, depth - 1));
    } else {
      // 文本类标 text_file/markdown（EditorApp 注册处理，双击可直接打开）；
      // 其余保持 'file'：树里没有内容、无内容处理器，预览请走自研 FinderApp。
      // _modifiedOn 用 Date 对象：模型类型声明为 Date，JSON 持久化时自动转 ISO 字符串
      const md = e.previewable === 'markdown';
      out[safe] = {
        _type: md
          ? ClassicyFileSystemEntryFileType.Markdown
          : e.previewable === 'text'
            ? ClassicyFileSystemEntryFileType.TextFile
            : ClassicyFileSystemEntryFileType.File,
        _mimeType: md ? 'text/markdown' : 'text/plain',
        _size: e.size,
        ...(e.mtime > 0 ? { _modifiedOn: new Date(e.mtime) } : {}),
      } as ClassicyFileSystemEntry;
    }
  }
  return out;
}

let registered = false;

/** 注册宿主机文件系统适配器（幂等）。须在桌面渲染前生效——import 本文件即自动注册 */
export function registerHostFsAdapter(): void {
  if (registered) return;
  registered = true;
  registerClassicyFileSystemAdapter({
    id: 'watchdog-host-fs',

    // 时机① 启动同步：真实目录整树替换内存数据；后端不可达/无根时保留本地旧树。
    // 根列表拉取失败才整体降级——单个子目录失败由 listDir 内部消化为空壳
    async reconcile(): Promise<ClassicyFileSystemReconcileResult> {
      let rootEntries;
      try {
        ({ entries: rootEntries } = await fsList('')); // 不传 path：后端返回 FS_ROOTS 根列表
      } catch (e) {
        console.warn('[hostFsAdapter] reconcile failed; keeping local FS', e);
        return { action: 'useLocal' };
      }
      try {
        if (rootEntries.length === 0) return { action: 'useLocal' };
        rootMap.clear();
        resetHostFsHydration(); // 整树替换后旧的"已水合"记录全部失效
        const roots: Record<string, ClassicyFileSystemEntry> = {};
        for (const r of rootEntries) {
          let label = rootLabel(r.path);
          while (label in roots) label += '_'; // 多个根同 basename 时追加下划线去重
          rootMap.set(label, r.path);
          roots[label] = {
            _type: ClassicyFileSystemEntryFileType.Directory,
            _icon: ClassicyIcons.system.folders.directory,
          };
          if (SEED_DEPTH > 0) Object.assign(roots[label], await listDir(r.path, SEED_DEPTH - 1));
        }
        return {
          action: 'replace',
          // 模型类型把整棵树按「单条目」声明（要求顶层 _type），运行时实际是
          // 「卷名 → 条目」映射（与内置种子 DefaultFSContent 同构），此处按运行时真实形状断言
          tree: {
            [VOLUME_NAME]: {
              _type: ClassicyFileSystemEntryFileType.Drive,
              _icon: ClassicyIcons.system.drives.disk,
              ...roots,
            },
          } as unknown as ClassicyFileSystemEntry,
        };
      } catch (e) {
        console.warn('[hostFsAdapter] reconcile failed; keeping local FS', e);
        return { action: 'useLocal' };
      }
    },

    // 时机② 操作回放：把 Finder 里的改动落盘（与 classicy 语义一致：write 为覆盖写）
    async onChange(entry: ClassicyFileSystemJournalEntry): Promise<void> {
      if (entry.op === 'load') return; // 整树替换（reconcile 自身触发），无需回放
      const hostPath = classicyToHost(entry.path);
      if (!hostPath) return; // 非本卷路径（回收站等派生条目）不回放
      try {
        switch (entry.op) {
          case 'mkdir':
            await fsMkdir(hostPath);
            break;
          case 'write':
            await fsWrite(hostPath, entry.data ?? '');
            break;
          case 'rmdir':
            await fsDelete(hostPath);
            break;
          default:
            break; // meta（重命名/移动等）：暂不回放，重启后以磁盘为准
        }
      } catch (e) {
        // 内存树已生效，仅落盘失败：告警留痕，下次启动 reconcile 自动纠正
        console.warn(`[hostFsAdapter] replay ${entry.op} failed for ${hostPath}`, e);
      }
    },
  });
}

registerHostFsAdapter();

// ---------------------------------------------------------------------------
// 惰性加载（Lazy Hydration）
//
// SEED_DEPTH 限制种子树深度，更深的目录只是空壳。这里监听内置 Finder 打开的
// 目录路径（窗口 data.openPaths）：用户点进某个目录时，若其宿主机路径尚未拉取过，
// 就调 /api/fs/list 取一层子项写入 FS 树（子目录仍为空壳、继续惰性），再经
// load + flushNow + fsVersionBump 让 Finder 立即重渲染——与 DriveSetup 的
// Initialize 是同一套官方刷新机制。
// ---------------------------------------------------------------------------

/** 已水合的宿主机目录（host 绝对路径）。reconcile 整树替换时重置 */
const hydratedDirs = new Set<string>();

function resetHostFsHydration(): void {
  hydratedDirs.clear();
}

/** 水合单个 classicy 目录：拉后端一层子项替换该节点的旧内容并刷新 Finder */
async function hydrateDir(fs: ReturnType<typeof useClassicyFileSystem>, classicyPath: string) {
  const hostPath = classicyToHost(classicyPath);
  if (!hostPath) return; // 卷根本身或非本卷路径（Applications 等派生目录）
  if (hydratedDirs.has(hostPath)) return;
  hydratedDirs.add(hostPath);

  // listDir(path, 0)：取一层子项，子目录留空壳（继续惰性）
  let children: Record<string, ClassicyFileSystemEntry>;
  try {
    children = await listDir(hostPath, 0);
  } catch (e) {
    console.warn(`[hostFsAdapter] hydrate failed for ${hostPath}`, e);
    return;
  }

  // 在当前树中定位该节点（快照 → 修改 → 整树装回，DriveSetup Initialize 同款流程）
  const tree = JSON.parse(fs.snapshot()) as Record<string, unknown>;
  let node: Record<string, unknown> | undefined = tree[VOLUME_NAME] as Record<string, unknown>;
  for (const seg of classicyPath.split(':').slice(1)) {
    if (!node || typeof node !== 'object') return;
    node = node[seg] as Record<string, unknown> | undefined;
  }
  if (!node || typeof node !== 'object') return;

  // 清掉旧的非元数据键（空壳/过期种子），写入新子项
  for (const k of Object.keys(node)) if (!k.startsWith('_')) delete node[k];
  Object.assign(node, children);

  fs.load(JSON.stringify(tree)); // 触发 'load' 日志（onChange 中忽略，不会回放磁盘）
  fs.flushNow(); // 立即持久化 localStorage
  dispatch({ type: 'ClassicyDesktopFileSystemVersionBump' }); // 让所有 FS 订阅者重建
}

/** Finder 当前打开的目录路径（app.data.openPaths，按打开顺序） */
function useFinderOpenPaths(): string {
  return useAppManager((s) => {
    const op = s.System.Manager.Applications.apps['Finder.app']?.data?.openPaths;
    return Array.isArray(op) ? op.filter((p): p is string => typeof p === 'string').join('\u0000') : '';
  });
}

/** 挂载在 Provider 内：Finder 打开新目录时自动水合（幂等，放桌面即可） */
export function HostFsLazyLoader() {
  const fs = useClassicyFileSystem();
  const openPaths = useFinderOpenPaths();
  useEffect(() => {
    if (!fs) return;
    for (const p of openPaths.split('\u0000')) {
      if (p) void hydrateDir(fs, p);
    }
  }, [fs, openPaths]);
  return null;
}
