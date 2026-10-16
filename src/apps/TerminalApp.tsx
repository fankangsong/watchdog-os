import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyButton,
  ClassicyCheckbox,
  ClassicyContextualMenuTarget,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyInput,
  ClassicyKbd,
  ClassicyPopUpMenu,
  ClassicyWindow,
  useClassicyAboutMenu,
  useClassicyHelpMenu,
} from 'classicy';
import type { ClassicyAlertType, ClassicyMenuItem } from 'classicy';
import { getTerminalToken, TerminalUnavailable, Unauthorized } from '../api';

import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须用 ?no-inline（仅 ?url 不够，它不绕过 assetsInlineLimit）让 Vite 输出独立文件 URL。
// classicy 桌面图标把图标地址写进 CSS 自定义属性 --classicy-icon-mask: url(...)，
// 而 Vite 的 svgToDataURL 在「非 base64 分支」会把 SVG 的双引号全换成单引号
// （产出 data:image/svg+xml,<svg xmlns='...'>）。CSS 无引号 url() 不允许出现 '，
// 整条声明非法 → 浏览器 CSSOM 拒绝 setProperty → style 属性整个丢失 → 遮罩失效。
// 内置 PNG 图标走 base64 分支，无引号，故不受影响。
import terminalIcon from '../assets/icons/terminal.svg?no-inline';

const APP_ID = 'srv-terminal.app';
const APP_NAME = 'Terminal';
/** 应用图标：自绘 SVG（Mac OS 9 窗口 + 终端提示符），见 src/assets/icons/terminal.svg */
const ICON = terminalIcon;

/* ttyd 客户端帧协议（1.7.x）：二进制帧首字节为操作码（ASCII 字符） */
const OP_INPUT = 0x30;  // '0' 键盘输入
const OP_RESIZE = 0x31; // '1' 终端尺寸 {columns, rows}
/* WebSocket 子协议：ttyd（含 1.6.x / 1.7.x）要求客户端在握手时声明 'tty'，
   否则握手成功后连接会被立即关闭（表现为黑屏、无任何输出） */
const WS_SUBPROTOCOL = 'tty';

/** WS 握手失败/连接中断的统一提示：经反向代理访问时最常见原因是 WS 升级未放行，
 *  或服务端 PUBLIC_ORIGIN 未包含当前访问域名（watchdog 的 Origin 校验会拒绝升级）。
 *  历史上该失败只打 console，界面停在「只闪光标无任何反馈」的状态。 */
const WS_FAILED_MSG =
  'Cannot reach the terminal server (WebSocket handshake failed). ' +
  'If you access this through a reverse proxy, make sure WebSocket upgrades are allowed.';

const enc = new TextEncoder();

/** 复制文本到剪贴板：优先异步 Clipboard API，非安全上下文（如 http 局域网）时降级 execCommand */
function copyToClipboard(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyViaExecCommand(text));
    return;
  }
  copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* 复制失败时暂无更优降级方案，静默忽略 */
  } finally {
    document.body.removeChild(ta);
  }
}

/* 字体大小可选项（px）。夜间/高分辨率场景下 18 仍显小，提供到 32 的可选项 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
const DEFAULT_FONT_SIZE = 14;

/* 字体族可选项：label 为菜单显示名，css 为 xterm fontFamily */
const FONT_FAMILIES: { label: string; css: string }[] = [
  { label: 'Monaco / Menlo / Consolas', css: '"Monaco", "Menlo", "Consolas", monospace' },
  { label: 'Cascadia Mono', css: '"Cascadia Mono", "Cascadia Code", monospace' },
  { label: 'Consolas', css: '"Consolas", monospace' },
  { label: 'Courier New', css: '"Courier New", monospace' },
];
/* 默认字体族：Courier New 笔画清晰、识别度高，日常命令输出观感更好 */
const DEFAULT_FONT_FAMILY = FONT_FAMILIES[3].css;

/* ---------- 设置持久化（localStorage） ---------- */
const PREFS_KEY = 'srv-terminal-prefs';

/** 终端设置：两个复制/粘贴开关 + 字体字号，整体持久化，刷新或重开窗口后保留 */
interface TerminalPrefs {
  /** 选中自动复制：拖选文本时自动写入剪贴板 */
  autoCopy: boolean;
  /** 快捷键粘贴：同时控制 Ctrl/⌘+V 与 Shift+Insert */
  pasteHotkey: boolean;
  fontSize: number;
  fontFamily: string;
}

const DEFAULT_PREFS: TerminalPrefs = {
  autoCopy: false,
  // 粘贴是终端高频操作，默认开启；非安全上下文中 ⌘V 仍走浏览器原生粘贴，不受影响
  pasteHotkey: true,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,
};

/* 字号合法区间：挡住手改 localStorage 写入的 NaN / 0 / 超大值，避免破坏 xterm.options */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 72;

/**
 * 读取持久化设置：逐字段做类型与范围校验，非法值回退默认。
 * localStorage 可能被手改或残留旧版本结构，不能让异常值进入终端初始化。
 */
function loadPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const j = JSON.parse(raw) as Partial<TerminalPrefs> | null;
    if (!j || typeof j !== 'object') return { ...DEFAULT_PREFS };
    return {
      autoCopy: typeof j.autoCopy === 'boolean' ? j.autoCopy : DEFAULT_PREFS.autoCopy,
      pasteHotkey: typeof j.pasteHotkey === 'boolean' ? j.pasteHotkey : DEFAULT_PREFS.pasteHotkey,
      fontSize:
        typeof j.fontSize === 'number' &&
        Number.isFinite(j.fontSize) &&
        j.fontSize >= FONT_SIZE_MIN &&
        j.fontSize <= FONT_SIZE_MAX
          ? j.fontSize
          : DEFAULT_PREFS.fontSize,
      fontFamily:
        typeof j.fontFamily === 'string' && j.fontFamily.trim().length > 0
          ? j.fontFamily
          : DEFAULT_PREFS.fontFamily,
    };
  } catch {
    // JSON 解析失败（被手改成非法 JSON）时静默回退默认
    return { ...DEFAULT_PREFS };
  }
}

/** 写入持久化设置：隐私模式 / 配额超限时忽略，设置仅本次会话生效 */
function savePrefs(prefs: TerminalPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略写入失败 */
  }
}

/**
 * macOS 才启用 ⌘A 全选快捷键：Windows / Linux 的 Ctrl+A 是 readline 的「行首」，
 * 必须原样交给远端 shell，否则会破坏命令行编辑。
 */
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/**
 * 能否直接读取剪贴板：项目常以 http 局域网地址 + Nginx 子路径部署（非安全上下文），
 * 此时 navigator.clipboard 为 undefined，粘贴只能依赖浏览器原生 paste 事件。
 */
function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';
}

/** 读取剪贴板文本：不支持或被权限拒绝时返回 null，由调用方决定提示还是降级（不打印剪贴板内容） */
async function readClipboardText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    return typeof text === 'string' ? text : null;
  } catch (e) {
    console.warn('[Terminal] 读取剪贴板失败：', e);
    return null;
  }
}

/** 快捷键粘贴后抑制浏览器原生 paste 事件的时长（ms） */
const NATIVE_PASTE_BLOCK_MS = 400;
/** 同一段文本在该时长（ms）内重复触发时视为重复粘贴，只处理一次 */
const PASTE_DEDUP_MS = 400;

/** 终端内的提示弹窗（仅用于「读不到剪贴板」这类需要用户知晓的失败） */
interface TermAlert {
  alertType: ClassicyAlertType;
  label: string;
  message: string;
}

/**
 * 终端应用：xterm.js 直连后端代理的 ttyd WebSocket。
 * 鉴权复用 Dashboard 的 JWT Cookie（token 接口 + WS 升级均由后端校验）。
 */
export function TerminalApp({ onLogout }: { onLogout?: () => void }) {
  // 窗口内容由 classicy 按需挂载（app.open 时才渲染 children）：
  // 必须用 callback ref + state，容器真实挂载/卸载时才能触发 effect 重跑
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [attempt, setAttempt] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  // 当前是否存在选区：驱动 Edit / 右键菜单里 Copy 的置灰状态
  const [hasSelection, setHasSelection] = useState(false);

  // 设置懒初始化：终端首次 new Terminal 就使用持久化值，避免先按默认字体渲染再跳变
  const [storedPrefs] = useState(loadPrefs);
  const [autoCopy, setAutoCopy] = useState(storedPrefs.autoCopy);
  const [pasteHotkey, setPasteHotkey] = useState(storedPrefs.pasteHotkey);
  const [fontSize, setFontSize] = useState(storedPrefs.fontSize);
  const [fontFamily, setFontFamily] = useState(storedPrefs.fontFamily);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [alert, setAlert] = useState<TermAlert | null>(null);

  /* 开关/选区变化同步给注册一次的监听器（onSelectionChange、自定义按键处理器）：
     切换开关不重建终端、不重连 WebSocket */
  const autoCopyRef = useRef(autoCopy);
  const pasteHotkeyRef = useRef(pasteHotkey);
  const hasSelectionRef = useRef(false);
  useEffect(() => {
    autoCopyRef.current = autoCopy;
  }, [autoCopy]);
  useEffect(() => {
    pasteHotkeyRef.current = pasteHotkey;
  }, [pasteHotkey]);
  const lastCopiedRef = useRef('');
  /* 粘贴防重：busy 锁覆盖异步读取窗口，blockUntil 覆盖原生 paste 事件，文本+时间去重兜底 */
  const pasteBusyRef = useRef(false);
  const nativePasteBlockUntilRef = useRef(0);
  const lastPasteAtRef = useRef(0);
  const lastPasteTextRef = useRef('');

  // 渲染期快照：非安全上下文中恒为 false，用于菜单置灰与设置面板提示
  const clipboardReadable = canReadClipboard();

  // 任一入口（设置面板 / 菜单）改动设置都落盘
  useEffect(() => {
    savePrefs({ autoCopy, pasteHotkey, fontSize, fontFamily });
  }, [autoCopy, pasteHotkey, fontSize, fontFamily]);

  const handleLogout = useCallback(() => {
    onLogout?.();
  }, [onLogout]);

  /** 复制当前选区到剪贴板；无选区时静默返回（菜单项已置灰） */
  const doCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) copyToClipboard(sel);
    // 焦点可能停在菜单项上，动作结束必须还给终端，否则后续键盘输入会丢失
    term.focus();
  }, []);

  /** 全选终端回滚缓冲（不拦截 Windows/Linux 的 Ctrl+A，那属于远端 readline） */
  const doSelectAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    term.focus();
  }, []);

  /** 读不到剪贴板时的统一提示（非安全上下文 / 权限被拒） */
  const notifyPasteUnavailable = useCallback(() => {
    setAlert({
      alertType: 'caution',
      label: '无法读取剪贴板',
      message:
        'This deployment is not a secure context (http LAN access), so the browser blocks script access to the clipboard. ' +
        'Use Ctrl+V instead, or right-click in the terminal and choose Paste.',
    });
  }, []);

  /**
   * 粘贴：读取剪贴板 → term.paste()。
   * term.paste 内部按行触发 onData，复用既有 ttyd 0x30 帧链路，多行文本直接粘贴不做二次确认。
   * 返回 false 表示读不到剪贴板，调用方负责提示。
   *
   * 防重复粘贴（三层，任一层生效即可保证「一次按键只粘贴一次」）：
   * 1. busy 锁：剪贴板读取（异步）期间的重复触发直接忽略；
   * 2. 原生 paste 抑制：本次粘贴后的一小段时间内，拦掉浏览器原生 paste 事件，
   *    避免「剪贴板 API 粘贴」与「浏览器原生粘贴」两条通道叠加；
   * 3. 短时间去重：同一段文本在极短时间内被重复触发时只粘贴一次。
   */
  const doPaste = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (!term) return false;
    // 正在粘贴中：本次触发视为重复（已由前一次处理），不再发起第二次读取
    if (pasteBusyRef.current) return true;

    const now = Date.now();
    pasteBusyRef.current = true;
    // 从这一刻起屏蔽浏览器原生 paste，防止与本次 API 粘贴叠加
    nativePasteBlockUntilRef.current = now + NATIVE_PASTE_BLOCK_MS;
    try {
      term.focus(); // 异步读取前先把焦点放回终端
      const text = await readClipboardText();
      if (text === null) return false;
      if (text.length > 0) {
        const duplicated =
          text === lastPasteTextRef.current && now - lastPasteAtRef.current < PASTE_DEDUP_MS;
        if (!duplicated) {
          lastPasteTextRef.current = text;
          lastPasteAtRef.current = now;
          console.debug('[Terminal] 粘贴剪贴板内容', text.length, '字符');
          term.paste(text);
          // 读取可能耗时较久（首次读剪贴板要等权限），粘贴完成后再顺延一段抑制窗口，
          // 确保「迟到的原生 paste 事件」也落在窗口内
          nativePasteBlockUntilRef.current = Date.now() + NATIVE_PASTE_BLOCK_MS;
        } else {
          console.debug('[Terminal] 忽略重复粘贴请求（与上次内容相同）');
        }
      }
      term.focus();
      return true;
    } finally {
      pasteBusyRef.current = false;
    }
  }, []);

  /** 菜单 / 右键菜单 / 快捷键共用的粘贴入口：失败统一弹提示 */
  const doPasteWithNotice = useCallback(() => {
    void doPaste().then((ok) => {
      if (!ok) notifyPasteUnavailable();
    });
  }, [doPaste, notifyPasteUnavailable]);

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const token = await getTerminalToken();
      // 与 api.ts 的 './api' 相对路径约定一致，兼容任意 basePath 部署
      const url = new URL('./api/terminal/ws', window.location.href);
      url.searchParams.set('token', token);
      const ws = new WebSocket(url.toString(), WS_SUBPROTOCOL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setError(null);
        const t = termRef.current;
        // ttyd 1.7.x：首条 JSON 消息携带认证令牌与初始尺寸
        ws.send(JSON.stringify({ AuthToken: token, columns: t?.cols ?? 80, rows: t?.rows ?? 24 }));
        t?.focus();
        fitRef.current?.fit();
      };
      ws.onmessage = (ev: MessageEvent) => {
        const t = termRef.current;
        if (!t) return;
        const u8 = new Uint8Array(ev.data as ArrayBuffer);
        if (u8.length === 0) return;
        const op = String.fromCharCode(u8[0]);
        if (op === '0') {
          t.write(u8.subarray(1));
        } else if (op === '1') {
          // SET_WINDOW_TITLE：通常为主机名
          setTitle(new TextDecoder().decode(u8.subarray(1)));
        }
        // '2' SET_PREFERENCES 忽略
      };
      ws.onclose = () => {
        // 仅当前连接（未被重建/清理替换）的关闭才视为故障：设置变更等主动重建时
        // wsRef.current 已被置空或替换，不能误报错误触发重连浮层
        if (wsRef.current === ws) {
          wsRef.current = null;
          // 握手失败或连接中断：给出可见提示并接入 5s 自动重连，
          // 避免界面停在「只闪光标、无法输入、无任何反馈」
          setError(WS_FAILED_MSG);
        }
      };
      ws.onerror = () => {
        console.error('[Terminal] WebSocket 连接失败');
        if (wsRef.current === ws) setError(WS_FAILED_MSG);
      };
    } catch (e) {
      if (e instanceof Unauthorized) {
        handleLogout();
        return;
      }
      if (e instanceof Error && e.message === 'Terminal disabled') {
        setDisabled(true);
        return;
      }
      // ttyd 进程未就绪（未安装 / 端口被占用 / 重试中）：展示错误并等待自动重连
      if (e instanceof TerminalUnavailable) {
        setError(e.message);
        return;
      }
      // 其余失败（如令牌接口网络错误）：同样给出可见提示并自动重连，不静默
      console.error('[Terminal] 连接失败：', e);
      setError((e as Error).message || 'Connection failed');
    }
  }, [handleLogout]);

  useEffect(() => {
    if (disabled || !container) return;

    let ro: ResizeObserver | null = null;
    let term: Terminal | null = null;
    // 点击终端区域时主动把焦点还给 xterm（窗口焦点切换/菜单收起后可能丢失）。
    // 必须在 try 外声明：若 try 中途抛错，清理函数引用到的仍是已初始化的绑定，
    // 否则卸载时会触发 ReferenceError（TDZ）导致整桌崩溃（classicy Sad Mac）
    const refocus = () => termRef.current?.focus();
    /**
     * 抑制「快捷键粘贴」之后的浏览器原生 paste 事件。
     * xterm 在 helper textarea 的目标阶段监听 paste 并把内容发给远端 shell；若它与
     * 剪贴板 API 粘贴同时发生，用户看到的就是同一段文本被粘贴两次。这里用捕获阶段
     * （container 上的 capture listener 先于 textarea 的目标阶段触发）+ stopPropagation
     * 把原生 paste 挡在 xterm 之前，保证一次按键只走一条通道。
     */
    const blockNativePaste = (ev: ClipboardEvent) => {
      if (Date.now() >= nativePasteBlockUntilRef.current) return;
      ev.preventDefault();
      ev.stopPropagation();
      console.debug('[Terminal] 已拦截浏览器原生 paste 事件（避免与快捷键粘贴重复）');
    };
    try {
      term = new Terminal({
        fontSize,
        fontFamily,
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#000000', foreground: '#E5E5E5', cursor: '#8AE234' },
      });
      const fit = new FitAddon();
      termRef.current = term;
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      // 立即聚焦：键盘输入只有在 xterm 获得焦点时才会触发 onData
      term.focus();

      container.addEventListener('pointerdown', refocus);
      container.addEventListener('paste', blockNativePaste, true);

      // 键盘输入 → 0x30 + 文本 的二进制帧
      term.onData((data) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const payload = enc.encode(data);
        const frame = new Uint8Array(1 + payload.length);
        frame[0] = OP_INPUT;
        frame.set(payload, 1);
        ws.send(frame);
      });

      // xterm 尺寸变化（含 FitAddon fit）→ 0x31 + JSON {columns, rows}
      term.onResize(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const body = enc.encode(JSON.stringify({ columns: term!.cols, rows: term!.rows }));
        const frame = new Uint8Array(1 + body.length);
        frame[0] = OP_RESIZE;
        frame.set(body, 1);
        ws.send(frame);
      });

      // 选中自动复制：选区变化（拖动过程中每次不同选区至多复制一次）时写入剪贴板
      term.onSelectionChange(() => {
        const sel = term!.getSelection();
        const has = sel.length > 0;
        // 选区有无只影响菜单置灰，用 ref 比较避免每次拖动都触发 React 渲染
        if (has !== hasSelectionRef.current) {
          hasSelectionRef.current = has;
          setHasSelection(has);
        }
        if (!autoCopyRef.current || !sel || sel === lastCopiedRef.current) return;
        lastCopiedRef.current = sel;
        copyToClipboard(sel);
      });

      /**
       * 快捷键：Copy / Paste / Select All 在终端本地拦截。
       * 菜单里同名的项都标了 nativeShortcut（字形照常显示），classicy 全局快捷键派发器
       * 会跳过它们，因此这里 preventDefault + return false 后不会双发。
       */
      term.attachCustomKeyEventHandler((ev) => {
        const key = ev.key.toLowerCase();

        // Paste：⌘V / Ctrl+V。关闭开关或读不到剪贴板时交回浏览器原生 paste（xterm 内置处理）
        if (key === 'v' && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
          if (!pasteHotkeyRef.current || !canReadClipboard()) return true;
          ev.preventDefault();
          doPasteWithNotice();
          return false;
        }

        // Paste：⇧Insert（X11 传统粘贴键，无修饰键 → 全局派发器不覆盖，只能本地处理）
        if (ev.key === 'Insert' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          if (!pasteHotkeyRef.current) return true;
          ev.preventDefault();
          if (!canReadClipboard()) {
            notifyPasteUnavailable();
            return false;
          }
          doPasteWithNotice();
          return false;
        }

        // Copy：⇧⌘C / Ctrl+Shift+C（不劫持 ⌘C / ^C，保留 shell 的 SIGINT 中断语义）
        if (key === 'c' && ev.shiftKey && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
          ev.preventDefault();
          doCopy();
          return false;
        }

        // Select All：仅 macOS ⌘A；Windows/Linux 的 ^A 是 readline 行首，交给远端 shell
        if (IS_MAC && key === 'a' && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
          ev.preventDefault();
          doSelectAll();
          return false;
        }

        return true;
      });

      // Classicy 窗口缩放/折叠 → 容器尺寸变化 → 重新 fit
      ro = new ResizeObserver(() => fitRef.current?.fit());
      ro.observe(container);
    } catch (e) {
      // xterm 初始化失败时也照常尝试连接，错误打印到控制台避免静默卡死
      console.error('[Terminal] xterm 初始化失败：', e);
    }

    connect();

    return () => {
      ro?.disconnect();
      container.removeEventListener('pointerdown', refocus);
      container.removeEventListener('paste', blockNativePaste, true);
      wsRef.current?.close();
      wsRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      // 终端重建后选区必然清空，同步复位避免菜单置灰状态残留
      hasSelectionRef.current = false;
      setHasSelection(false);
    };
    // 注意：不要把 autoCopy / pasteHotkey / fontSize / fontFamily 放进依赖，
    // 否则设置变更会重建终端并触发 WebSocket 重连抖动（改用 ref 同步）
  }, [container, attempt, connect, disabled]);

  // ttyd 未就绪时后端会退避重试拉起；前端每 5s 自动重连一次（也可手动重试）
  useEffect(() => {
    if (disabled || !error) return;
    const timer = setTimeout(() => setAttempt((a) => a + 1), 5000);
    return () => clearTimeout(timer);
  }, [disabled, error, attempt]);

  // 菜单切换字体大小/字体族：直接更新 xterm 选项，随后强制重绘并重新 fit
  // （不重建终端，保留回滚缓冲；xterm 6 下仅改 options 可能不刷新已渲染行）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let changed = false;
    if (term.options.fontSize !== fontSize) {
      term.options.fontSize = fontSize;
      changed = true;
    }
    if (term.options.fontFamily !== fontFamily) {
      term.options.fontFamily = fontFamily;
      changed = true;
    }
    if (changed && term.rows > 0) {
      term.refresh(0, term.rows - 1); // 强制重绘当前缓冲区，让新字体立即生效
    }
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  /**
   * Edit 组：Copy / Paste / Select All。
   * 三项都标 nativeShortcut —— 字形照常渲染，但全局派发器不拦截按键，
   * 由终端的 attachCustomKeyEventHandler 统一处理，杜绝一次按键被粘贴两次。
   */
  const editMenuItems = useMemo<ClassicyMenuItem[]>(
    () => [
      {
        id: 'terminal-m-copy',
        title: 'Copy',
        keyboardShortcut: '⇧⌘C',
        nativeShortcut: true,
        disabled: !hasSelection,
        onClickFunc: doCopy,
      },
      {
        id: 'terminal-m-paste',
        title: 'Paste',
        keyboardShortcut: '⇧⌘V',
        nativeShortcut: true,
        // 非安全上下文读不到剪贴板，菜单点击无意义，置灰并由设置面板给出说明
        disabled: !clipboardReadable,
        onClickFunc: doPasteWithNotice,
      },
      {
        id: 'terminal-m-select-all',
        title: 'Select All',
        // ⌘A 只在 macOS 生效：Windows/Linux 的 ^A 属于远端 readline，不展示字形也不拦截
        keyboardShortcut: IS_MAC ? '⌘A' : undefined,
        nativeShortcut: true,
        onClickFunc: doSelectAll,
      },
    ],
    [hasSelection, clipboardReadable, doCopy, doPasteWithNotice, doSelectAll]
  );

  /** 终端区域右键菜单：classicy 解析顺序为 wrapped control > window > app > 桌面默认 */
  const contextMenuItems = useMemo<ClassicyMenuItem[]>(
    () => [
      { id: 'terminal-ctx-copy', title: 'Copy', disabled: !hasSelection, onClickFunc: doCopy },
      { id: 'terminal-ctx-paste', title: 'Paste', disabled: !clipboardReadable, onClickFunc: doPasteWithNotice },
      { id: 'terminal-ctx-select-all', title: 'Select All', onClickFunc: doSelectAll },
    ],
    [hasSelection, clipboardReadable, doCopy, doPasteWithNotice, doSelectAll]
  );

  // Help 菜单由系统渲染，这里只注册帮助项（items 需保持引用稳定）
  const helpItems = useMemo<ClassicyMenuItem[]>(
    () => [
      {
        id: 'terminal-m-shortcuts',
        title: 'Keyboard Shortcuts…',
        onClickFunc: () => setShortcutsOpen(true),
      },
    ],
    []
  );
  useClassicyHelpMenu(APP_ID, helpItems);

  // 桌面顶部菜单栏（窗口聚焦时显示）：应用名菜单 + Edit + Session/Font 特有菜单；Sign Out 由 Apple 菜单全局提供
  const appMenu = useMemo(
    () => [
      {
        id: 'terminal-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          {
            id: 'terminal-m-settings',
            title: 'Settings…',
            onClickFunc: () => setSettingsOpen(true),
          },
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
      {
        id: 'terminal-edit',
        title: 'Edit',
        menuChildren: editMenuItems,
      },
      {
        id: 'terminal-session',
        title: 'Session',
        menuChildren: [{ id: 'terminal-m-reconnect', title: 'Reconnect', onClickFunc: reconnect }],
      },
      {
        id: 'terminal-font',
        title: 'Font',
        menuChildren: [
          {
            id: 'terminal-m-font-size',
            title: 'Font Size',
            menuChildren: FONT_SIZES.map((size) => ({
              id: `terminal-m-font-size-${size}`,
              // 选中态用 checked 字段渲染 ✓，不手拼前缀
              title: `${size} px`,
              checked: fontSize === size,
              onClickFunc: () => setFontSize(size),
            })),
          },
          {
            id: 'terminal-m-font-family',
            title: 'Font Family',
            menuChildren: FONT_FAMILIES.map((font) => ({
              id: `terminal-m-font-family-${font.label.replace(/\s+/g, '-').toLowerCase()}`,
              title: font.label,
              checked: fontFamily === font.css,
              onClickFunc: () => setFontFamily(font.css),
            })),
          },
        ],
      },
    ],
    [aboutMenuItem, editMenuItems, reconnect, fontSize, fontFamily]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="terminal-main">
      <ClassicyWindow
        id="terminal-main"
        title={title ? `${APP_NAME} · ${title}` : APP_NAME}
        icon={ICON}
        appId={APP_ID}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[900, 560]}
        initialPosition={['center', 'center']}
        minimumSize={[520, 340]}
        appMenu={appMenu}
      >
        {disabled ? (
          <div className="sp-term-disabled">
            Terminal is disabled: set TERMINAL_ENABLED=true in the server .env and make sure ttyd is installed.
          </div>
        ) : (
          // 右键菜单需要真实包裹终端容器才能覆盖桌面默认菜单；
          // ClassicyContextualMenuTarget 会渲染一层 div，用 sp-term-ctx 保持原有的撑满布局
          <ClassicyContextualMenuTarget className="sp-term-ctx" menuItems={contextMenuItems}>
            <div className="sp-term-wrap">
              {/* xterm 容器常驻：错误态用浮层提示，避免重建终端导致自动重连失效 */}
              <div className="sp-term" ref={setContainer} />
              {error && (
                <div className="sp-term-overlay">
                  <div className="sp-term-overlay-msg">Terminal unavailable: {error}</div>
                  <div className="sp-term-overlay-tip">The server retries automatically; you can also retry now.</div>
                  <ClassicyButton buttonSize="small" onClickFunc={reconnect}>
                    Retry
                  </ClassicyButton>
                </div>
              )}
            </div>
          </ClassicyContextualMenuTarget>
        )}
      </ClassicyWindow>
      {aboutWindow}
      {/* 设置对话框：菜单 Terminal > Settings… 打开；使用草稿状态，点「好」才生效，取消/关闭则丢弃 */}
      {settingsOpen && (
        <TerminalSettingsDialog
          initial={{ autoCopy, pasteHotkey, fontFamily, fontSize }}
          onSave={(p) => {
            setAutoCopy(p.autoCopy);
            setPasteHotkey(p.pasteHotkey);
            setFontFamily(p.fontFamily);
            setFontSize(p.fontSize);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {/* 快捷键说明：Help > Keyboard Shortcuts… */}
      {shortcutsOpen && <TerminalShortcutsWindow onClose={() => setShortcutsOpen(false)} />}
      {/* 粘贴失败提示（非安全上下文 / 剪贴板权限被拒） */}
      {alert && (
        <ClassicyAlert
          appId={APP_ID}
          alertType={alert.alertType}
          label={alert.label}
          message={alert.message}
          buttons={[{ id: 'ok', label: 'OK', role: 'default' }]}
          onClose={() => setAlert(null)}
        />
      )}
    </ClassicyApp>
  );
}

/**
 * 终端设置对话框（模态窗口）：
 * - 复制/粘贴：选中自动复制、快捷键粘贴（Ctrl+V / Shift+Insert 共用一个开关）
 * - 字体：预设菜单 + 自定义填写（CSS font-family）
 * - 字号：预设尺寸下拉
 * 关闭/取消不生效，点「好」才把草稿提交给终端；确认后写入 localStorage。
 */
function TerminalSettingsDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: TerminalPrefs;
  onSave: (p: TerminalPrefs) => void;
  onClose: () => void;
}) {
  // 每次打开对话框都会重新挂载，用 useState 初始化草稿即可拿到最新设置
  const [draftAutoCopy, setDraftAutoCopy] = useState(initial.autoCopy);
  const [draftPasteHotkey, setDraftPasteHotkey] = useState(initial.pasteHotkey);
  const [draftFont, setDraftFont] = useState(initial.fontFamily);
  const [draftSize, setDraftSize] = useState(String(initial.fontSize));

  // 当前字体是否命中预设（否则属于自定义字体，下拉显示「自定义…」）
  const presetUsed = FONT_FAMILIES.some((f) => f.css === draftFont);
  // 非安全上下文（http 局域网）读不到剪贴板，需要在面板里说明快捷键的实际行为
  const clipboardReadable = canReadClipboard();

  const save = () => {
    const size = Number(draftSize);
    onSave({
      autoCopy: draftAutoCopy,
      pasteHotkey: draftPasteHotkey,
      fontFamily: draftFont.trim() || DEFAULT_FONT_FAMILY,
      fontSize: Number.isFinite(size) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX ? size : DEFAULT_FONT_SIZE,
    });
    onClose();
  };

  return (
    <ClassicyWindow
      id="terminal-settings"
      appId={APP_ID}
      title={`${APP_NAME} · Settings`}
      icon={ICON}
      modal
      closable
      zoomable={false}
      collapsable={false}
      resizable={false}
      scrollable={false}
      initialSize={[480, 395]}
      initialPosition={['center', 'center']}
      onCloseFunc={onClose}
    >
      <ClassicyForm
        layout="dialog"
        onSubmitFunc={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <ClassicyCheckbox
          id="term-settings-autocopy"
          checked={draftAutoCopy}
          onClickFunc={(checked) => setDraftAutoCopy(checked)}
          label="选中自动复制（Copy on Select）"
          labelSize="small"
          labelPosition="right"
        />
        <ClassicyCheckbox
          id="term-settings-paste-hotkey"
          checked={draftPasteHotkey}
          onClickFunc={(checked) => setDraftPasteHotkey(checked)}
          label="快捷键粘贴（Ctrl+V / Shift+Insert）"
          labelSize="small"
          labelPosition="right"
        />
        <div className="sp-term-hint">
          {clipboardReadable
            ? '当前环境支持直接读取剪贴板，Ctrl+V 与 Shift+Insert 均可粘贴。'
            : '当前为非安全上下文（http 局域网访问），浏览器禁止脚本读取剪贴板：Ctrl+V 仍由浏览器原生粘贴处理，Shift+Insert 需 https / localhost 才可用。'}
        </div>
        <ClassicyPopUpMenu
          id="term-settings-font-preset"
          label="字体"
          labelSize="small"
          labelPosition="above"
          selected={presetUsed ? draftFont : 'custom' /* 自定义字体时显示「自定义…」 */}
          options={[
            ...FONT_FAMILIES.map((font) => ({ value: font.css, label: font.label })),
            { value: 'custom', label: '自定义…' },
          ]}
          onChangeFunc={(e) => {
            if (e.target.value !== 'custom') setDraftFont(e.target.value);
          }}
        />
        <ClassicyInput
          id="term-settings-font-custom"
          labelTitle="自定义字体"
          labelSize="small"
          labelPosition="above"
          prefillValue={draftFont}
          placeholder='CSS 字体栈，例如 "Fira Code", monospace'
          onChangeFunc={(e) => setDraftFont(e.target.value)}
        />
        <ClassicyPopUpMenu
          id="term-settings-font-size"
          label="字号"
          labelSize="small"
          labelPosition="above"
          selected={draftSize}
          options={FONT_SIZES.map((size) => ({ value: String(size), label: `${size} px` }))}
          onChangeFunc={(e) => setDraftSize(e.target.value)}
        />
        <ClassicyFormButtonRow>
          <ClassicyButton buttonSize="small" onClickFunc={onClose}>
            取消
          </ClassicyButton>
          <ClassicyButton buttonSize="small" isDefault buttonType="submit">
            好
          </ClassicyButton>
        </ClassicyFormButtonRow>
      </ClassicyForm>
    </ClassicyWindow>
  );
}

/* 快捷键说明表的行：keys 为 classicy 快捷键字形串（⇧⌘V / ⇧Insert 等） */
const SHORTCUT_ROWS: { label: string; keys: string; macOnly?: boolean; note?: string }[] = [
  { label: '复制选区', keys: '⇧⌘C', note: '不占用 ⌘C，远端 Ctrl+C 仍是中断信号' },
  { label: '粘贴剪贴板', keys: '⇧⌘V' },
  { label: '粘贴（传统键）', keys: '⇧Insert' },
  { label: '全选终端缓冲', keys: '⌘A', macOnly: true, note: 'Windows / Linux 的 Ctrl+A 保留给远端 shell' },
];

/**
 * 快捷键说明窗口（Help > Keyboard Shortcuts…）：
 * 用 ClassicyKbd 的 keycaps 变体逐键渲染，字形与实际拦截逻辑一一对应。
 */
function TerminalShortcutsWindow({ onClose }: { onClose: () => void }) {
  const rows = useMemo(() => SHORTCUT_ROWS.filter((r) => !r.macOnly || IS_MAC), []);
  return (
    <ClassicyWindow
      id="terminal-shortcuts"
      appId={APP_ID}
      title={`${APP_NAME} · Keyboard Shortcuts`}
      icon={ICON}
      modal
      closable
      zoomable={false}
      collapsable={false}
      resizable={false}
      scrollable={false}
      initialSize={[440, 260]}
      initialPosition={['center', 'center']}
      onCloseFunc={onClose}
    >
      <div className="sp-term-kbd-list">
        {rows.map((row) => (
          <div className="sp-term-kbd-row" key={row.keys}>
            <span className="sp-term-kbd-label">{row.label}</span>
            <ClassicyKbd variant="keycaps" shortcut={row.keys} />
          </div>
        ))}
        <div className="sp-term-kbd-row">
          <span className="sp-term-kbd-label">选中自动复制</span>
          <span className="sp-term-hint">在 Settings… 中开启</span>
        </div>
        <div className="sp-term-kbd-row">
          <span className="sp-term-kbd-label">快捷键粘贴</span>
          <span className="sp-term-hint">在 Settings… 中开启</span>
        </div>
      </div>
    </ClassicyWindow>
  );
}
