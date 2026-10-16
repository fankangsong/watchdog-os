// HEIC 转换器（Converter）：在面板内浏览文件系统，把 .heic/.heif 图片转换为 JPEG，
// 并保存到原文件所在目录（与 Finder 一致的 /api/fs/* 数据源与鉴权）。
// 解码在浏览器端完成：heic-to（libheif WASM，动态 import 按需加载 ~2MB chunk），
// EXIF orientation 经 exifr 读取后手动应用到 canvas——heic-to 不应用 EXIF 方向，
// 竖拍 iPhone 照片（存储横向 + Orientation=6）会整体旋转 90°，必须补偿。
// 零后端改动：读经 /api/fs/raw，写经 /api/fs/upload（既有 50MB 上限与越权防护）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyBalloonHelp,
  ClassicyButton,
  ClassicyIcons,
  ClassicyKbd,
  ClassicyPopUpMenu,
  ClassicyProgressBar,
  ClassicyTable,
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyHelpMenu,
} from 'classicy';
import type { ClassicyMenuItem, ClassicyTableColumn } from 'classicy';
import { fsList, fsRawUrl, fsUpload, logout, Unauthorized } from '../api';
import type { FsEntry } from '../api';
import { fmtBytes } from '../format';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须带 ?no-inline（仅 ?url 不够，它不绕过 assetsInlineLimit），
// 否则 classicy 桌面图标遮罩会静默失效（见 docs/icon-pipeline.md §6.2）
import converterIcon from '../assets/icons/converter.svg?no-inline';
// HEIC 内嵌 EXIF 读取（exifr 支持 HEIF 容器，体积小，静态引入）
import exifr from 'exifr';

const APP_ID = 'srv-converter.app';
const APP_NAME = 'Converter';
/** 应用图标：自绘 SVG（双照片 + 箭头，表示图片格式转换），见 src/assets/icons/converter.svg */
const ICON = converterIcon;
const MAIN_WIN_ID = 'converter-main';
const HELP_WIN_ID = 'converter-help';
/** 偏好持久化键（srv- 前缀，规范 §10） */
const PREFS_KEY = 'srv-converter-prefs';

/** 可转换的图片扩展名（iPhone 默认为 .heic，部分相机/工具产出 .heif） */
const HEIC_EXT = ['.heic', '.heif'];
/** 「只显示图片」过滤覆盖的扩展名：源格式（heic/heif）+ 输出（jpg）及其它常见图片，
 *  保证转换结果立即可见（不再被过滤挡掉） */
const IMAGE_EXT = ['.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];

/** JPEG 质量档位（value 同时作为持久化标识） */
const QUALITY_LEVELS = [
  { value: 'high', label: 'High', quality: 0.92 },
  { value: 'medium', label: 'Medium', quality: 0.8 },
  { value: 'low', label: 'Low', quality: 0.6 },
];

interface ConvAlert {
  alertType: 'caution' | 'stop';
  label: string;
  message?: string;
  /** 指定默认按钮 id；有数据丢失风险的确认必须指向安全项（Cancel） */
  defaultButtonId?: string;
  buttons: Array<{ id: string; label: string; role?: 'default' | 'cancel' | 'normal'; onClick?: () => void }>;
}

interface Prefs {
  /** 只显示图片文件（目录始终显示，保证可导航）——含 HEIC 源与转换出的 JPG，结果立即可见 */
  onlyPics: boolean;
  showHidden: boolean;
  /** 质量档位 value */
  quality: string;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { onlyPics: true, showHidden: false, quality: 'high' };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>;
    return {
      onlyPics: raw.onlyPics !== false,
      showHidden: raw.showHidden === true,
      quality: QUALITY_LEVELS.some((q) => q.value === raw.quality) ? (raw.quality as string) : 'high',
    };
  } catch {
    return fallback;
  }
}

function isHeicName(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i > 0 && HEIC_EXT.includes(name.slice(i).toLowerCase());
}

function isImageName(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i > 0 && IMAGE_EXT.includes(name.slice(i).toLowerCase());
}

/** 同目录输出名：IMG_0001.HEIC → IMG_0001.jpg */
function jpgNameFor(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) + '.jpg';
}

/** 取父目录（文件所在目录——转换结果保存位置） */
function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/** 拼接目录 + 文件名（按目录自身风格选分隔符；根目录不重复斜线） */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** 上一级目录；根目录返回 ''（根列表视图），与 Finder 行为一致 */
function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  if (!norm) return '';
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 0) return norm[0] === '/' ? '/' : '';
  if (i === 2 && /^[a-zA-Z]:$/.test(norm.slice(0, 2))) return norm.slice(0, 3);
  return norm.slice(0, i);
}

function baseName(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** 英文日期（规范 §8 界面文案一律英文）：今天「Today HH:mm」、今年「Oct 3, 14:30」、往年「2024-10-03」 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  if (isNaN(+d)) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const today =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (today) return `Today ${hm}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (d.getFullYear() === now.getFullYear()) return `${months[d.getMonth()]} ${d.getDate()}, ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function kindLabel(e: FsEntry): string {
  if (e.type === 'dir') return 'Folder';
  if (isHeicName(e.name)) return 'HEIC Picture';
  return isImageName(e.name) ? 'Picture' : 'File';
}

function iconFor(e: FsEntry): string {
  if (e.type === 'dir') return ClassicyIcons.system.folders.directory;
  return isImageName(e.name) ? ClassicyIcons.system.files.photo : ClassicyIcons.system.files.file;
}

/** heic-to 为命名导出（1.6.x 起无 default），动态 import 让 WASM 单独成 chunk、按需加载 */
type HeicToFn = (opts: { blob: Blob; type: 'image/jpeg'; quality: number }) => Promise<Blob>;
let heicToPromise: Promise<HeicToFn> | null = null;
function loadHeicTo(): Promise<HeicToFn> {
  if (!heicToPromise) {
    heicToPromise = import('heic-to').then((m) => m.heicTo as unknown as HeicToFn);
  }
  return heicToPromise;
}

/**
 * 按 EXIF Orientation 旋转/翻转图像（值与 createImageBitmap 的 from-image 语义一致）。
 * 1/undefined 为正常方向直接返回原 blob；2-8 走 canvas 变换后重新编码 JPEG。
 */
async function applyExifOrientation(blob: Blob, orientation: number, quality: number): Promise<Blob> {
  if (!(orientation >= 2 && orientation <= 8)) return blob;
  const bmp = await createImageBitmap(blob);
  const swap = orientation >= 5; // 5-8 旋转 90/270°，宽高需交换
  const canvas = document.createElement('canvas');
  canvas.width = swap ? bmp.height : bmp.width;
  canvas.height = swap ? bmp.width : bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, bmp.width, 0); break; // 水平翻转
    case 3: ctx.transform(-1, 0, 0, -1, bmp.width, bmp.height); break; // 180°
    case 4: ctx.transform(1, 0, 0, -1, 0, bmp.height); break; // 垂直翻转
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break; // 转置
    case 6: ctx.transform(0, 1, -1, 0, bmp.height, 0); break; // 顺时针 90°
    case 7: ctx.transform(0, -1, -1, 0, bmp.height, bmp.width); break; // 转置 + 翻转
    case 8: ctx.transform(0, -1, 1, 0, 0, bmp.width); break; // 逆时针 90°
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      quality
    );
  });
}

/** 单个 HEIC → JPEG Blob（读原文件字节 → 解码 → 应用 EXIF 方向） */
async function convertOne(entry: FsEntry, quality: number, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch(fsRawUrl(entry.path), { signal });
  if (r.status === 401) throw new Unauthorized();
  if (!r.ok) throw new Error(`Read failed: HTTP ${r.status}`);
  const src = new Blob([await r.arrayBuffer()], { type: 'image/heic' });
  let orientation = 1;
  try {
    const ex = await exifr.parse(src, ['Orientation']);
    const v = Number(ex?.Orientation);
    if (v >= 2 && v <= 8) orientation = v;
  } catch {
    // 无 EXIF 块或解析失败：按存储方向输出
  }
  const heicTo = await loadHeicTo();
  const out = await heicTo({ blob: src, type: 'image/jpeg', quality });
  return await applyExifOrientation(out, orientation, quality);
}

/** 应用：HEIC 图片转 JPEG，结果保存到原文件所在目录 */
export function ConverterApp({ onLogout }: { onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  /** 转换任务进行中的进度（null 表示空闲） */
  const [job, setJob] = useState<{ total: number; done: number; name: string } | null>(null);
  /** 上次转换结果摘要（状态栏左区） */
  const [summary, setSummary] = useState<{ text: string; error: boolean } | null>(null);
  const [alert, setAlert] = useState<ConvAlert | null>(null);
  /** 帮助窗口显隐（条件渲染：classicy 0.79 的常驻窗口会在 app 打开时自开并抢焦点，
   *  TerminalApp 的快捷键窗即条件渲染模式；静态内容无保留状态的必要） */
  const [helpOpen, setHelpOpen] = useState(false);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  /** 取消标志与在途请求（Cancel 按钮用） */
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // 持久化失败不影响本次切换
      }
      return next;
    });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  const stopAlert = useCallback((label: string, message: string) => {
    setAlert({ alertType: 'stop', label, message, buttons: [{ id: 'ok', label: 'OK', role: 'default' }] });
  }, []);

  const fetchDir = useCallback(
    async (p: string): Promise<FsEntry[] | null> => {
      setLoading(true);
      try {
        const r = await fsList(p);
        setEntries(r.entries);
        setSelected([]);
        setCurrent(r.path);
        return r.entries;
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout(), null;
        // 目录加载均为用户主动动作，失败弹 alert 说明原因；已有列表保留
        stopAlert('Cannot Read Folder', (e as Error).message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [handleLogout, stopAlert]
  );

  const navigate = useCallback(
    (p: string, pushHistory = true) => {
      if (pushHistory) {
        setBackStack((s) => (current && current !== p ? [...s.slice(-30), current] : s));
      }
      void fetchDir(p);
    },
    [fetchDir, current]
  );

  // 挂载即加载根列表（与 Finder 一致：空路径为允许根视图）
  useEffect(() => {
    void fetchDir('');
  }, [fetchDir]);

  const visibleEntries = useMemo(
    () =>
      entries.filter((e) => {
        if (!prefs.showHidden && e.name.startsWith('.')) return false;
        // 目录始终显示（保证可导航）；文件按 onlyPics 过滤（图片含 HEIC 源与 JPG 结果）
        if (prefs.onlyPics && e.type === 'file' && !isImageName(e.name)) return false;
        return true;
      }),
    [entries, prefs.showHidden, prefs.onlyPics]
  );

  const entryIndex = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);
  const selectedEntries = useMemo(
    () => selected.map((id) => entryIndex.get(id)).filter((e): e is FsEntry => !!e),
    [selected, entryIndex]
  );
  /** 选中项中可转换的 HEIC 文件 */
  const heicSelected = useMemo(
    () => selectedEntries.filter((e) => e.type === 'file' && isHeicName(e.name)),
    [selectedEntries]
  );
  const heicCount = useMemo(
    () => visibleEntries.filter((e) => e.type === 'file' && isHeicName(e.name)).length,
    [visibleEntries]
  );
  const qualityLevel = QUALITY_LEVELS.find((q) => q.value === prefs.quality) ?? QUALITY_LEVELS[0];

  const goBack = useCallback(() => {
    setBackStack((s) => {
      if (!s.length) return s;
      const prev = s[s.length - 1];
      void fetchDir(prev);
      return s.slice(0, -1);
    });
  }, [fetchDir]);

  const goUp = useCallback(() => {
    navigate(parentPath(current), false);
  }, [navigate, current]);

  const closeWindow = useCallback(() => {
    dispatch({ type: 'ClassicyWindowClose', app: { id: APP_ID }, window: { id: MAIN_WIN_ID } });
  }, []);

  const openHelpWindow = useCallback(() => {
    setHelpOpen(true);
  }, []);

  /** 执行批量转换（顺序执行：WASM 解码内存峰值高，并发易 OOM） */
  const doConvert = useCallback(
    async (list: FsEntry[], overwrite: boolean) => {
      cancelRef.current = false;
      setSummary(null);
      setJob({ total: list.length, done: 0, name: list[0].name });
      const okPaths: string[] = []; // 成功产出的 JPG 路径（用于刷新后选中）
      const failed: Array<{ name: string; error: string }> = [];
      let canceled = false;
      for (let i = 0; i < list.length; i++) {
        if (cancelRef.current) {
          canceled = true;
          break;
        }
        const entry = list[i];
        setJob({ total: list.length, done: i, name: entry.name });
        try {
          const controller = new AbortController();
          abortRef.current = controller;
          const blob = await convertOne(entry, qualityLevel.quality, controller.signal);
          const file = new File([blob], jpgNameFor(entry.name), { type: 'image/jpeg' });
          // 保存到原文件所在目录（覆盖策略由调用方经 alert 确认后决定）
          await fsUpload(parentOf(entry.path), file, overwrite);
          okPaths.push(joinPath(parentOf(entry.path), jpgNameFor(entry.name)));
        } catch (e) {
          if (e instanceof Unauthorized) {
            abortRef.current = null;
            setJob(null);
            void handleLogout();
            return;
          }
          failed.push({ name: entry.name, error: (e as Error).message || String(e) });
        } finally {
          abortRef.current = null;
        }
      }
      setJob(null);
      const refreshed = await fetchDir(current);
      if (canceled) {
        setSummary({ text: `Canceled after ${okPaths.length} of ${list.length}`, error: false });
        return;
      }
      const parts: string[] = [];
      if (okPaths.length) parts.push(`Converted ${okPaths.length}`);
      if (failed.length) parts.push(`${failed.length} failed`);
      setSummary({ text: parts.join(' · ') || 'Nothing converted', error: failed.length > 0 });
      // 转换结果立即可见且选中（对齐 Finder 粘贴后选中新建项）：只选刷新后仍存在的条目
      if (refreshed && okPaths.length) {
        const created = new Set(okPaths);
        const createdPaths = refreshed.filter((e) => created.has(e.path)).map((e) => e.path);
        if (createdPaths.length) setSelected(createdPaths);
      }
      if (failed.length) {
        setAlert({
          alertType: 'stop',
          label: failed.length === 1 ? 'Conversion Failed' : `${failed.length} Conversions Failed`,
          message: failed.map((f) => `${f.name}: ${f.error}`).join('\n'),
          buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
        });
      }
    },
    [qualityLevel.quality, current, fetchDir, handleLogout]
  );

  /** 转换入口：目标已存在时先 caution 确认（覆盖有数据丢失风险，默认按钮为 Cancel） */
  const requestConvert = useCallback(
    (list: FsEntry[]) => {
      if (!list.length || job) return;
      const existingNames = new Set(
        entries.filter((e) => e.type === 'file').map((e) => e.name.toLowerCase())
      );
      const existing = list.filter((e) => existingNames.has(jpgNameFor(e.name).toLowerCase()));
      if (existing.length > 0) {
        setAlert({
          alertType: 'caution',
          label: existing.length === 1 ? 'File Exists' : `${existing.length} Files Exist`,
          message:
            existing.length === 1
              ? `“${jpgNameFor(existing[0].name)}” already exists in this folder. Overwrite it?`
              : `${existing.length} JPEG files with the same names already exist in this folder. Overwrite them?`,
          defaultButtonId: 'cancel',
          buttons: [
            { id: 'cancel', label: 'Cancel', role: 'cancel' },
            { id: 'ok', label: 'Overwrite', role: 'normal', onClick: () => void doConvert(list, true) },
          ],
        });
        return;
      }
      void doConvert(list, false);
    },
    [entries, job, doConvert]
  );

  /** 双击/回车激活：目录进入、HEIC 转换、其它文件无操作 */
  const onActivate = useCallback(
    (id: string) => {
      const entry = entryIndex.get(id);
      if (!entry) return;
      if (entry.type === 'dir') return navigate(entry.path);
      if (isHeicName(entry.name)) requestConvert([entry]);
    },
    [entryIndex, navigate, requestConvert]
  );

  // 快捷键真实绑定：classicy 的 keyboardShortcut 仅作展示、不自动生效。
  // ⌘E 转换 / ⌘[ 后退 / ⌘↑ 上一级；焦点在输入框时放行，不劫持打字。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key === '[') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        goUp();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        requestConvert(heicSelected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, goUp, requestConvert, heicSelected]);

  // Help 菜单由系统渲染，这里只注册帮助项（items 需保持引用稳定）
  const helpItems = useMemo<ClassicyMenuItem[]>(
    () => [{ id: 'cv-m-help', title: 'Converter Help…', onClickFunc: openHelpWindow }],
    [openHelpWindow]
  );
  useClassicyHelpMenu(APP_ID, helpItems);

  const appMenu = useMemo(
    () => [
      {
        id: 'cv-app',
        title: APP_NAME,
        menuChildren: [aboutMenuItem, { id: 'spacer' }, quitMenuItem(APP_ID, APP_NAME, ICON)],
      },
      {
        id: 'cv-file',
        title: 'File',
        menuChildren: [
          {
            id: 'cv-m-convert',
            title: 'Convert…',
            keyboardShortcut: '⌘E',
            disabled: heicSelected.length === 0 || !!job,
            onClickFunc: () => requestConvert(heicSelected),
          },
          { id: 'spacer' },
          { id: 'cv-m-close', title: 'Close Window', onClickFunc: closeWindow },
        ],
      },
      {
        id: 'cv-view',
        title: 'View',
        menuChildren: [
          {
            id: 'cv-m-onlyheic',
            title: 'Show Only Pictures',
            checked: prefs.onlyPics,
            onClickFunc: () => setPref('onlyPics', !prefs.onlyPics),
          },
          {
            id: 'cv-m-hidden',
            title: 'Show Hidden Files',
            checked: prefs.showHidden,
            onClickFunc: () => setPref('showHidden', !prefs.showHidden),
          },
          { id: 'spacer' },
          // checked 一致性：本菜单含 checked 项，非切换项也必须显式声明（规范 §2）
          { id: 'cv-m-refresh', title: 'Refresh', checked: false, onClickFunc: () => void fetchDir(current) },
        ],
      },
      {
        id: 'cv-go',
        title: 'Go',
        menuChildren: [
          {
            id: 'cv-m-back',
            title: 'Back',
            keyboardShortcut: '⌘[',
            disabled: backStack.length === 0,
            onClickFunc: goBack,
          },
          {
            id: 'cv-m-parent',
            title: 'Open Parent Folder',
            keyboardShortcut: '⌘↑',
            disabled: !current,
            onClickFunc: goUp,
          },
        ],
      },
    ],
    [
      aboutMenuItem,
      heicSelected.length,
      job,
      requestConvert,
      closeWindow,
      prefs.onlyPics,
      prefs.showHidden,
      setPref,
      fetchDir,
      current,
      backStack.length,
      goBack,
      goUp,
    ]
  );

  const columns = useMemo<Array<ClassicyTableColumn<FsEntry>>>(
    () => [
      {
        id: 'name',
        title: 'Name',
        accessor: (r) => r.name,
        width: 400,
        render: (r) => (
          <span className="sp-conv-name">
            <img src={iconFor(r)} alt="" />
            {r.name}
          </span>
        ),
      },
      {
        id: 'size',
        title: 'Size',
        accessor: (r) => (r.type === 'dir' ? -1 : r.size),
        align: 'right',
        width: 90,
        render: (r) => (r.type === 'dir' ? '—' : fmtBytes(r.size)),
      },
      {
        id: 'mtime',
        title: 'Modified',
        accessor: (r) => r.mtime,
        width: 150,
        render: (r) => (r.mtime ? fmtDate(r.mtime) : '—'),
      },
      {
        id: 'kind',
        title: 'Kind',
        accessor: (r) => kindLabel(r),
        width: 120,
        render: (r) => <span title={`Permissions: ${r.mode}`}>{kindLabel(r)}</span>,
      },
    ],
    []
  );

  // 状态栏左区：转换中 > 上次结果 > 常规计数（规范 §6.1）
  const statusLeft = job
    ? `Converting ${job.done + 1} of ${job.total}…`
    : summary
      ? summary.text
      : loading
        ? 'Loading…'
        : `${visibleEntries.length} items · ${heicCount} HEIC`;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow={MAIN_WIN_ID}>
      <ClassicyWindow
        id={MAIN_WIN_ID}
        title={`${APP_NAME}${current ? ' · ' + (baseName(current) || current) : ''}`}
        icon={ICON}
        appId={APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={['70%', '68%']}
        initialPosition={['center', 'center']}
        minimumSize={[620, 420]}
        appMenu={appMenu}
      >
        {/* 窗口操作按钮带（规范 §3.2）：浅色容器带钉在顶部，按钮不随内容滚动。
            Convert 虽为明确主操作，但不设 isDefault 双线环：Return 需留给表格的「回车激活行」
            （双击/回车目录进入、HEIC 转换），避免默认按钮抢走回车 */}
        <div className="sp-toolbar">
          <ClassicyButton disabled={backStack.length === 0} onClickFunc={goBack}>
            Back
          </ClassicyButton>
          <ClassicyButton disabled={!current} onClickFunc={goUp}>
            Up
          </ClassicyButton>
          <ClassicyButton disabled={heicSelected.length === 0 || !!job} onClickFunc={() => requestConvert(heicSelected)}>
            Convert…
          </ClassicyButton>
          <ClassicyPopUpMenu
            id="cv-quality"
            label="Quality"
            labelPosition="left"
            size="small"
            options={QUALITY_LEVELS.map((q) => ({ value: q.value, label: q.label }))}
            selected={prefs.quality}
            onChangeFunc={(e) => setPref('quality', e.target.value)}
          />
        </div>

        {loading && entries.length === 0 ? (
          <div className="sp-conv-empty">Loading…</div>
        ) : visibleEntries.length === 0 ? (
          <div className="sp-conv-empty">
            {prefs.onlyPics ? 'No pictures in this folder.' : 'This folder is empty.'}
          </div>
        ) : (
          <div className="sp-conv-table">
            <ClassicyTable
              columns={columns}
              rows={visibleEntries}
              getRowId={(r) => r.path}
              selectionMode="multi"
              selected={selected}
              onSelectionChange={setSelected}
              onActivateRow={onActivate}
              defaultSort={{ columnId: 'name' }}
              // 选中态对齐 OS8 经典列表视图：只高亮名称标签（同 Macintosh HD 规则）
              rowClassName={(_r, sel) => (sel ? 'sp-conv-row-selected' : undefined)}
            />
          </div>
        )}

        {/* 转换进度区（任务进行中显示）：总进度 + 当前文件名 + 取消 */}
        {job && (
          <div className="sp-conv-progress">
            <span className="sp-conv-progress-name" title={job.name}>
              {job.name}
            </span>
            <span className="sp-conv-progress-bar">
              <ClassicyProgressBar value={job.done} max={job.total || 1} />
            </span>
            <span className="sp-conv-progress-count">
              {job.done}/{job.total}
            </span>
            <ClassicyBalloonHelp content="Cancel conversion">
              <ClassicyButton
                buttonSize="small"
                padding="sm"
                margin="sm"
                onClickFunc={() => {
                  cancelRef.current = true;
                  abortRef.current?.abort();
                }}
              >
                ×
              </ClassicyButton>
            </ClassicyBalloonHelp>
          </div>
        )}

        {/* 状态栏：左上下文 / 右全局信息（规范 §6.1） */}
        <div className="sp-conv-status">
          <span className={summary?.error ? 'sp-conv-status-err' : undefined}>{statusLeft}</span>
          <span className="sp-conv-status-right">JPEG · {qualityLevel.label}</span>
        </div>
      </ClassicyWindow>

      {/* 帮助窗口：条件渲染（同 TerminalApp 快捷键窗模式）——classicy 0.79 中常驻渲染的
          未开窗口会在 app 打开时经挂载自注册变为可见并抢占焦点，故不用 Open/Focus 双发模式 */}
      {helpOpen && (
      <ClassicyWindow
        id={HELP_WIN_ID}
        title="Converter Help"
        icon={ICON}
        appId={APP_ID}
        resizable
        closable
        scrollable={false}
        initialSize={[460, 400]}
        initialPosition={['center', 'center']}
        minimumSize={[400, 320]}
        onCloseFunc={() => setHelpOpen(false)}
      >
        <div className="sp-conv-help">
          <div className="sp-conv-help-title">How to Convert</div>
          <ol className="sp-conv-help-steps">
            <li>Browse to a folder containing HEIC pictures.</li>
            <li>
              Select one or more <b>.heic</b> / <b>.heif</b> files (click, or ⌘-click / Shift-click for multiple).
            </li>
            <li>
              Choose <b>Convert…</b>. Each JPEG is saved next to its original file.
            </li>
          </ol>
          <div className="sp-conv-help-title">Notes</div>
          <ul className="sp-conv-help-notes">
            <li>Only the primary image of each file is converted.</li>
            <li>EXIF orientation is applied automatically — portrait iPhone photos stay upright.</li>
            <li>Existing JPEGs with the same name are never overwritten without confirmation.</li>
            <li>Conversion runs entirely in your browser; files never leave this server.</li>
          </ul>
          <div className="sp-conv-help-title">Keyboard Shortcuts</div>
          <div className="sp-conv-help-kbd">
            <span>
              <ClassicyKbd variant="keycaps" shortcut="⌘E" /> Convert
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="⌘[" /> Back
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="⌘↑" /> Open Parent Folder
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="↩" /> Open folder / Convert file
            </span>
          </div>
        </div>
      </ClassicyWindow>
      )}

      {alert && (
        <ClassicyAlert
          appId={APP_ID}
          alertType={alert.alertType}
          label={alert.label}
          message={alert.message}
          defaultButtonId={alert.defaultButtonId}
          buttons={alert.buttons}
          onClose={() => setAlert(null)}
        />
      )}
      {aboutWindow}
    </ClassicyApp>
  );
}
