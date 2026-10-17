// HEIC 转换器（Converter）：启动仅提供 Choose File 按钮，点击后经 converterBridge
// 调起 Macintosh HD（Finder）选文件模式——用户在 Finder 中双击 .heic/.heif 文件确认，
// Finder 窗口自动关闭回到本窗口，转换结果 JPEG 保存到原文件所在目录。
// 数据源与 Finder 一致（/api/fs/*，Cookie 鉴权）；解码在浏览器端完成：
// heic-to（libheif WASM，动态 import 按需加载 ~2MB chunk），EXIF orientation 经
// exifr 读取后手动应用到 canvas——heic-to 不应用 EXIF 方向，竖拍 iPhone 照片
// （存储横向 + Orientation=6）会整体旋转 90°，必须补偿。
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
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyHelpMenu,
} from 'classicy';
import type { ClassicyMenuItem } from 'classicy';
import { fsRawUrl, fsUpload, logout, Unauthorized } from '../api';
import type { FsEntry } from '../api';
import { fmtBytes } from '../format';
import { quitMenuItem } from '../quitMenuItem';
import {
  CONVERTER_PICK_EVENT,
  startConverterPick,
} from '../converterBridge';
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
  /** 质量档位 value */
  quality: string;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>;
    return {
      quality: QUALITY_LEVELS.some((q) => q.value === raw.quality) ? (raw.quality as string) : 'high',
    };
  } catch {
    return { quality: 'high' };
  }
}

function isHeicName(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i > 0 && HEIC_EXT.includes(name.slice(i).toLowerCase());
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

function iconFor(e: FsEntry): string {
  if (e.type === 'dir') return ClassicyIcons.system.folders.directory;
  return isHeicName(e.name) ? ClassicyIcons.system.files.photo : ClassicyIcons.system.files.file;
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

/** 应用：启动仅 Choose File 按钮；选中文件后显示文件卡 + Convert（HEIC → JPEG） */
export function ConverterApp({ onLogout }: { onLogout: () => void }) {
  /** 经 Macintosh HD 选定的待转换文件（null 为空闲/取消） */
  const [picked, setPicked] = useState<FsEntry | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  /** 转换进行中的文件名（null 表示空闲） */
  const [job, setJob] = useState<string | null>(null);
  /** 上次转换结果摘要（状态栏左区） */
  const [summary, setSummary] = useState<{ text: string; error: boolean } | null>(null);
  const [alert, setAlert] = useState<ConvAlert | null>(null);
  /** 帮助窗口显隐（条件渲染：classicy 0.79 的常驻窗口会在 app 打开时自开并抢焦点，
   *  TerminalApp 的快捷键窗即条件渲染模式；静态内容无保留状态的必要） */
  const [helpOpen, setHelpOpen] = useState(false);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  /** 取消标志与在途请求中止句柄（Cancel 按钮用） */
  const cancelRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const uploadAbortRef = useRef<(() => void) | null>(null);

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

  // 消费 Macintosh HD 的选择结果：entry=确认选择；null=取消（含关窗/Esc）
  useEffect(() => {
    const onPick = (e: Event) => {
      const entry = (e as CustomEvent<{ entry: FsEntry | null }>).detail?.entry ?? null;
      setPicked(entry);
      setSummary(null);
    };
    window.addEventListener(CONVERTER_PICK_EVENT, onPick);
    return () => window.removeEventListener(CONVERTER_PICK_EVENT, onPick);
  }, []);

  /** 调起 Macintosh HD 选文件（空闲与已选状态均可再次发起，换选文件） */
  const startPick = useCallback(() => {
    startConverterPick();
  }, []);

  const qualityLevel = QUALITY_LEVELS.find((q) => q.value === prefs.quality) ?? QUALITY_LEVELS[0];

  /** 单文件转换 + 保存（overwrite=false 遇同名 409，由 runConvert 转 caution 确认） */
  const runConvert = useCallback(
    async (overwrite: boolean) => {
      if (!picked || job) return;
      cancelRef.current = false;
      setSummary(null);
      setJob(picked.name);
      const outName = jpgNameFor(picked.name);
      try {
        const controller = new AbortController();
        fetchAbortRef.current = controller;
        const blob = await convertOne(picked, qualityLevel.quality, controller.signal);
        const file = new File([blob], outName, { type: 'image/jpeg' });
        // 保存到原文件所在目录（覆盖策略由调用方经 alert 确认后决定）
        const up = fsUpload(parentOf(picked.path), file, overwrite);
        uploadAbortRef.current = up.abort;
        await up.promise;
        setSummary({ text: `Saved ${joinPath(parentOf(picked.path), outName)}`, error: false });
      } catch (e) {
        if (e instanceof Unauthorized) {
          void handleLogout();
          return;
        }
        const msg = (e as Error).message || String(e);
        if (msg === 'File already exists') {
          setAlert({
            alertType: 'caution',
            label: 'File Exists',
            message: `“${outName}” already exists in the original folder. Overwrite it?`,
            defaultButtonId: 'cancel',
            buttons: [
              { id: 'cancel', label: 'Cancel', role: 'cancel' },
              { id: 'ok', label: 'Overwrite', role: 'normal', onClick: () => void runConvertRef.current?.(true) },
            ],
          });
          return;
        }
        if (cancelRef.current || msg === 'Upload canceled') {
          setSummary({ text: 'Conversion canceled', error: false });
          return;
        }
        stopAlert('Conversion Failed', msg);
      } finally {
        fetchAbortRef.current = null;
        uploadAbortRef.current = null;
        setJob(null);
      }
    },
    [picked, job, qualityLevel.quality, handleLogout, stopAlert]
  );

  // 覆盖确认按钮需要重新触发 runConvert（回调内自引用不便），经 ref 转发最新实例
  const runConvertRef = useRef<(overwrite: boolean) => void>(null);
  useEffect(() => {
    runConvertRef.current = (o) => void runConvert(o);
  }, [runConvert]);

  const cancelJob = useCallback(() => {
    cancelRef.current = true;
    fetchAbortRef.current?.abort();
    uploadAbortRef.current?.();
  }, []);

  const closeWindow = useCallback(() => {
    dispatch({ type: 'ClassicyWindowClose', app: { id: APP_ID }, window: { id: MAIN_WIN_ID } });
  }, []);

  const openHelpWindow = useCallback(() => {
    setHelpOpen(true);
  }, []);

  const canConvert = !!picked && picked.type === 'file' && isHeicName(picked.name);

  // 快捷键真实绑定：classicy 的 keyboardShortcut 仅作展示、不自动生效。
  // ⌘O 选文件 / ⌘E 转换；焦点在输入框时放行，不劫持打字。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        startPick();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        if (canConvert && !job) runConvertRef.current?.(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startPick, canConvert, job]);

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
            id: 'cv-m-choose',
            title: 'Choose File…',
            keyboardShortcut: '⌘O',
            disabled: !!job,
            onClickFunc: startPick,
          },
          {
            id: 'cv-m-convert',
            title: 'Convert…',
            keyboardShortcut: '⌘E',
            disabled: !canConvert || !!job,
            onClickFunc: () => runConvertRef.current?.(false),
          },
          { id: 'spacer' },
          { id: 'cv-m-close', title: 'Close Window', onClickFunc: closeWindow },
        ],
      },
    ],
    [aboutMenuItem, job, startPick, canConvert, closeWindow]
  );

  // 状态栏左区：转换中 > 上次结果 > 常规提示（规范 §6.1）
  const statusLeft = job
    ? `Converting ${job}…`
    : summary
      ? summary.text
      : picked
        ? 'Ready'
        : 'No file selected';

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow={MAIN_WIN_ID}>
      <ClassicyWindow
        id={MAIN_WIN_ID}
        title={`${APP_NAME}${picked ? ' · ' + picked.name : ''}`}
        icon={ICON}
        appId={APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={['52%', '52%']}
        initialPosition={['center', 'center']}
        minimumSize={[520, 360]}
        appMenu={appMenu}
      >
        {/* 工具栏仅在已选文件后出现（启动态只有内容区 Choose File 按钮，见 landing） */}
        {picked && (
          <div className="sp-toolbar">
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
        )}

        {!picked ? (
          /* 启动落地页：仅一个 Choose File 按钮（点击调起 Macintosh HD 选文件） */
          <div className="sp-conv-landing">
            <img className="sp-conv-landing-icon" src={ICON} alt="" draggable={false} />
            <div className="sp-conv-landing-title">Convert HEIC Pictures to JPEG</div>
            <div className="sp-conv-landing-text">
              Pick a .heic / .heif picture in Macintosh HD.
              <br />
              Each JPEG is saved next to its original file.
            </div>
            <ClassicyButton isDefault onClickFunc={startPick}>
              Choose File…
            </ClassicyButton>
          </div>
        ) : (
          <>
            {/* 已选文件卡：图标 + 名称/路径/大小/修改时间 + 换选/转换操作 */}
            <div className="sp-conv-file">
              <img className="sp-conv-file-icon" src={iconFor(picked)} alt="" draggable={false} />
              <div className="sp-conv-file-meta">
                <span className="sp-conv-file-name" title={picked.name}>
                  {picked.name}
                </span>
                <span className="sp-conv-file-path" title={picked.path}>
                  {picked.path}
                </span>
                <span className="sp-conv-file-sub">
                  {picked.type === 'dir'
                    ? 'Folder'
                    : `${fmtBytes(picked.size)} · Modified ${picked.mtime ? fmtDate(picked.mtime) : '—'}`}
                </span>
              </div>
              <div className="sp-conv-file-actions">
                <ClassicyButton disabled={!!job} onClickFunc={startPick}>
                  Choose Another…
                </ClassicyButton>
                <ClassicyButton
                  isDefault
                  disabled={!canConvert || !!job}
                  onClickFunc={() => runConvertRef.current?.(false)}
                >
                  Convert…
                </ClassicyButton>
              </div>
            </div>
            {!canConvert && !job && (
              <div className="sp-conv-warn">
                Converter supports .heic / .heif pictures — choose another file.
              </div>
            )}
          </>
        )}

        {/* 转换进度区（任务进行中显示）：当前文件名 + 取消 */}
        {job && (
          <div className="sp-conv-progress">
            <span className="sp-conv-progress-name" title={job}>
              {job}
            </span>
            <span className="sp-conv-progress-label">Converting…</span>
            <ClassicyBalloonHelp content="Cancel conversion">
              <ClassicyButton
                buttonSize="small"
                padding="sm"
                margin="sm"
                onClickFunc={cancelJob}
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
            <li>
              Click <b>Choose File…</b> — the Macintosh HD window opens.
            </li>
            <li>
              Browse to a folder and double-click a <b>.heic</b> / <b>.heif</b> file to choose it
              (the window closes and returns here).
            </li>
            <li>
              Click <b>Convert…</b>. The JPEG is saved next to the original file.
            </li>
          </ol>
          <div className="sp-conv-help-title">Notes</div>
          <ul className="sp-conv-help-notes">
            <li>Only the primary image of the file is converted.</li>
            <li>EXIF orientation is applied automatically — portrait iPhone photos stay upright.</li>
            <li>An existing JPEG with the same name is never overwritten without confirmation.</li>
            <li>Conversion runs entirely in your browser; files never leave this server.</li>
          </ul>
          <div className="sp-conv-help-title">Keyboard Shortcuts</div>
          <div className="sp-conv-help-kbd">
            <span>
              <ClassicyKbd variant="keycaps" shortcut="⌘O" /> Choose File
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="⌘E" /> Convert
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="↩" /> Confirm file in Macintosh HD
            </span>
            <span>
              <ClassicyKbd variant="keycaps" shortcut="Esc" /> Cancel choosing (in Macintosh HD)
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
