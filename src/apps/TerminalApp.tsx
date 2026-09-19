import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyIcons,
  ClassicyWindow,
} from 'classicy';
import { getTerminalToken, TerminalUnavailable, Unauthorized } from '../api';

const APP_ID = 'srv-terminal.app';
const APP_NAME = 'Terminal';
const ICON = ClassicyIcons.system.network.terminal;

/* ttyd 客户端帧协议（1.7.x）：二进制帧首字节为操作码（ASCII 字符） */
const OP_INPUT = 0x30;  // '0' 键盘输入
const OP_RESIZE = 0x31; // '1' 终端尺寸 {columns, rows}
/* WebSocket 子协议：ttyd（含 1.6.x / 1.7.x）要求客户端在握手时声明 'tty'，
   否则握手成功后连接会被立即关闭（表现为黑屏、无任何输出） */
const WS_SUBPROTOCOL = 'tty';

const enc = new TextEncoder();

/* 字体大小可选项（px），默认 12 */
const FONT_SIZES = [10, 12, 14, 16, 18];
const DEFAULT_FONT_SIZE = 12;

/* 字体族可选项：label 为菜单显示名，css 为 xterm fontFamily */
const FONT_FAMILIES: { label: string; css: string }[] = [
  { label: 'Monaco / Menlo / Consolas', css: '"Monaco", "Menlo", "Consolas", monospace' },
  { label: 'Cascadia Mono', css: '"Cascadia Mono", "Cascadia Code", monospace' },
  { label: 'Consolas', css: '"Consolas", monospace' },
  { label: 'Courier New', css: '"Courier New", monospace' },
];
const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0].css;

/**
 * 终端应用：xterm.js 直连 server.js 代理的 ttyd WebSocket。
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
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [fontFamily, setFontFamily] = useState(DEFAULT_FONT_FAMILY);

  const handleLogout = useCallback(() => {
    onLogout?.();
  }, [onLogout]);

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
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      };
      ws.onerror = () => {
        console.error('[Terminal] WebSocket 连接失败');
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
      console.error('[Terminal] 连接失败：', e);
    }
  }, [handleLogout]);

  useEffect(() => {
    if (disabled || !container) return;

    let ro: ResizeObserver | null = null;
    let term: Terminal | null = null;
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
      wsRef.current?.close();
      wsRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [container, attempt, connect, disabled]);

  // ttyd 未就绪时后端会退避重试拉起；前端每 5s 自动重连一次（也可手动重试）
  useEffect(() => {
    if (disabled || !error) return;
    const timer = setTimeout(() => setAttempt((a) => a + 1), 5000);
    return () => clearTimeout(timer);
  }, [disabled, error, attempt]);

  // 菜单切换字体大小/字体族：直接更新 xterm 选项并重新 fit（不重建终端，保留回滚缓冲）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily;
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);

  // 桌面顶部菜单栏（窗口聚焦时显示）：Terminal > Reconnect / Font Size / Font Family + System > Sign Out
  const appMenu = useMemo(
    () => [
      {
        id: 'terminal',
        title: 'Terminal',
        menuChildren: [
          { id: 'reconnect', title: 'Reconnect', onClickFunc: reconnect },
          {
            id: 'font-size',
            title: 'Font Size',
            menuChildren: FONT_SIZES.map((size) => ({
              id: `font-size-${size}`,
              // 当前选中项以 ✓ 标记
              title: `${fontSize === size ? '✓ ' : ''}${size} px`,
              onClickFunc: () => setFontSize(size),
            })),
          },
          {
            id: 'font-family',
            title: 'Font Family',
            menuChildren: FONT_FAMILIES.map((font) => ({
              id: `font-family-${font.label.replace(/\s+/g, '-').toLowerCase()}`,
              title: `${fontFamily === font.css ? '✓ ' : ''}${font.label}`,
              onClickFunc: () => setFontFamily(font.css),
            })),
          },
        ],
      },
      {
        id: 'sys',
        title: 'System',
        menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: handleLogout }],
      },
    ],
    [reconnect, handleLogout, fontSize, fontFamily]
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
            终端功能未启用：请在服务器 config.json 中设置 terminal.enabled = true，并确认已安装 ttyd。
          </div>
        ) : (
          <div className="sp-term-wrap">
            {/* xterm 容器常驻：错误态用浮层提示，避免重建终端导致自动重连失效 */}
            <div className="sp-term" ref={setContainer} />
            {error && (
              <div className="sp-term-overlay">
                <div className="sp-term-overlay-msg">终端暂时不可用：{error}</div>
                <div className="sp-term-overlay-tip">服务端会自动重试拉起 ttyd，也可手动重试。</div>
                <ClassicyButton buttonSize="small" onClickFunc={reconnect}>
                  重试
                </ClassicyButton>
              </div>
            )}
          </div>
        )}
      </ClassicyWindow>
    </ClassicyApp>
  );
}
