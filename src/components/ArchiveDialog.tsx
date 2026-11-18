// Files 应用「Extract… / Compress…」对话框：右键菜单或 File 菜单调起。
//
// 进度模型：**一次请求 + 一个 Promise**。后端把解压/压缩过程以 NDJSON 流下发，
// 这里 await promise 即等到任务结束（无 job id、无轮询、无定时器）；
// 进度靠 onProgress 回调实时刷新；取消 = abort() 断开连接，服务端负责杀进程与清理半成品。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyButton,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyProgressBar,
  ClassicyWindow,
} from 'classicy';
import { ArchiveError, fsCompress, fsExtract } from '../api';
import type { ArchiveCaps, ArchiveFormat, ArchivePhase, ArchiveProgress, ArchiveResult, FsEntry } from '../api';
import { fmtBytes } from '../format';

export type ArchiveMode = 'extract' | 'compress';

/** 归档扩展名判定（与服务端 formatOf 保持一致，大小写不敏感） */
export function archiveFormatOf(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}

/** 去掉归档扩展名（只剥归档后缀，`a.txt` 保持原样 → 压缩后是 `a.txt.zip`） */
export function archiveStemOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return name.slice(0, -7);
  if (lower.endsWith('.tgz')) return name.slice(0, -4);
  if (lower.endsWith('.zip')) return name.slice(0, -4);
  return name;
}

function baseName(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  if (!norm) return '';
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 0) return norm[0] === '/' ? '/' : '';
  if (i === 2 && /^[a-zA-Z]:$/.test(norm.slice(0, 2))) return norm.slice(0, 3);
  return norm.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** 目标文件夹重名预演：foo → foo 2 → foo 3（实际由服务端按目录真实内容再校验一次） */
function freeNumbered(dir: string, stem: string, siblings: string[] | undefined): string {
  if (!siblings || siblings.length === 0) return joinPath(dir, stem);
  const taken = new Set(siblings.map((s) => s.toLowerCase()));
  if (!taken.has(stem.toLowerCase())) return joinPath(dir, stem);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return joinPath(dir, candidate);
  }
  return joinPath(dir, stem);
}

function phaseLabel(mode: ArchiveMode, phase: ArchivePhase): string {
  if (phase === 'listing') return mode === 'extract' ? 'Reading archive…' : 'Counting items…';
  if (phase === 'finalizing') return 'Finishing…';
  return mode === 'extract' ? 'Extracting…' : 'Compressing…';
}

const EMPTY_PROGRESS: ArchiveProgress = { phase: 'listing', processed: 0, total: null, percent: 0, current: '' };

export function ArchiveDialog({
  appId,
  icon,
  winId,
  mode,
  entry,
  entries,
  currentDir,
  siblings,
  caps,
  subjectIcon,
  onClose,
  onDone,
  onReveal,
}: {
  appId: string;
  icon: string;
  /** 抬头行图标（归档/文件夹类型图标）；缺省回退窗口图标 */
  subjectIcon?: string;
  /** 父窗口 id：多浏览窗口并存时保证对话框 id 全局唯一（对齐 PrintDialog 约定） */
  winId: string;
  mode: ArchiveMode;
  /** mode=extract 时必传：被解压的归档 */
  entry?: FsEntry;
  /** mode=compress 时必传：被压缩的条目（至少一个） */
  entries?: FsEntry[];
  /** 当前浏览目录（压缩目标的默认值） */
  currentDir: string;
  /** 当前目录已有条目名：用于前端预演同名去重（服务端仍会按真实目录再校验） */
  siblings?: string[];
  /** 工具能力；null = 尚未探测到（乐观放行，由服务端返回 503 兜底） */
  caps: ArchiveCaps | null;
  onClose: () => void;
  /** 成功回调：用于让 Files 刷新目录缓存 */
  onDone: (result: ArchiveResult) => void;
  /** 点「Show in Files」：导航到结果路径 */
  onReveal?: (path: string) => void;
}) {
  const [view, setView] = useState<'form' | 'running' | 'done' | 'error' | 'canceled'>('form');
  const [progress, setProgress] = useState<ArchiveProgress>(EMPTY_PROGRESS);
  const [result, setResult] = useState<ArchiveResult | null>(null);
  const [error, setError] = useState<ArchiveError | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // 压缩格式：只列出服务端真正支持的（caps 未知时两者都给，失败由服务端报 503）
  const formatOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [];
    if (!caps || caps.can.compressZip.ok) opts.push({ value: 'zip', label: 'ZIP (.zip)' });
    if (!caps || caps.can.compressTarGz.ok) opts.push({ value: 'tar.gz', label: 'TAR.GZ (.tar.gz)' });
    return opts;
  }, [caps]);
  const [formatRaw, setFormat] = useState<ArchiveFormat>('zip');
  const format: ArchiveFormat = formatOptions.some((o) => o.value === formatRaw)
    ? formatRaw
    : ((formatOptions[0]?.value as ArchiveFormat | undefined) ?? 'zip');

  const extractFormat = entry ? archiveFormatOf(entry.name) : null;
  const [dest, setDest] = useState(() => {
    if (mode !== 'extract' || !entry) return '';
    const parent = parentPath(entry.path);
    const stem = archiveStemOf(entry.name) || 'Extracted';
    // 归档不在当前目录时拿不到兄弟条目，先给基础名，服务端会做真实去重
    return freeNumbered(parent, stem, parent === currentDir ? siblings : undefined);
  });
  const [destDir, setDestDir] = useState(currentDir);
  const [name, setName] = useState(() => {
    if (mode !== 'compress' || !entries || entries.length === 0) return 'Archive';
    if (entries.length === 1) return archiveStemOf(entries[0].name) || 'Archive';
    return baseName(currentDir) || 'Archive';
  });

  // 卸载时断开仍在跑的请求（对话框运行中不可关闭，这里是应用整体关闭等极端情况的兜底）
  useEffect(
    () => () => {
      abortRef.current?.();
    },
    []
  );

  // Esc 关闭：运行中不允许（误触会直接断掉任务），覆盖确认框打开时也不抢它的 Esc
  useEffect(() => {
    if (view === 'running' || confirmOverwrite) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, confirmOverwrite, onClose]);

  const cap = useMemo(() => {
    if (!caps) return null;
    if (mode === 'extract') return extractFormat === 'tar.gz' ? caps.can.extractTarGz : caps.can.extractZip;
    return format === 'tar.gz' ? caps.can.compressTarGz : caps.can.compressZip;
  }, [caps, mode, extractFormat, format]);

  const unavailable = !!cap && !cap.ok;
  const ext = format === 'zip' ? '.zip' : '.tar.gz';

  const submit = useCallback(
    async (overwrite = false) => {
      if (view === 'running') return;
      setProgress(EMPTY_PROGRESS);
      setView('running');
      const job =
        mode === 'extract'
          ? fsExtract(entry?.path || '', dest.trim(), overwrite, setProgress)
          : fsCompress(
              (entries || []).map((e) => e.path),
              format,
              destDir.trim(),
              name.trim(),
              setProgress
            );
      abortRef.current = job.abort;
      try {
        const r = await job.promise; // ← 一次 await 到完成：无轮询、无 job 轮询
        abortRef.current = null;
        setResult(r);
        setView('done');
        onDone(r);
      } catch (e) {
        abortRef.current = null;
        if (e instanceof Error && e.name === 'AbortError') {
          setView('canceled');
          return;
        }
        if (e instanceof ArchiveError && e.code === 'DEST_NOT_EMPTY') {
          // 目标非空：回到表单并弹确认，确认为「覆盖」后才带 overwrite 重发
          setView('form');
          setConfirmOverwrite(e.dest || dest.trim());
          return;
        }
        setError(
          e instanceof ArchiveError ? e : new ArchiveError((e as Error)?.message || 'Unknown error', 'INTERNAL')
        );
        setView('error');
      }
    },
    [view, mode, entry, dest, entries, format, destDir, name, onDone]
  );

  const cancelJob = useCallback(() => {
    abortRef.current?.();
  }, []);

  const indeterminate = progress.phase === 'listing' || progress.total === null;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  const subject =
    mode === 'extract'
      ? entry?.name || ''
      : entries && entries.length === 1
        ? entries[0].name
        : `${entries?.length || 0} items`;

  return (
    <>
      <ClassicyWindow
        id={`fm-archive-${winId}`}
        appId={appId}
        title={mode === 'extract' ? 'Extract Archive' : 'Compress'}
        icon={icon}
        modal
        closable={false}
        zoomable={false}
        collapsable={false}
        resizable={false}
        initialSize={[440, 0]}
        initialPosition={['center', 'center']}
      >
        <div className="sp-arch">
          <div className="sp-arch-head">
            <img src={subjectIcon || icon} alt="" className="sp-arch-icon" />
            <div className="sp-arch-head-text">
              <div className="sp-arch-title" title={subject}>
                {subject}
              </div>
              <div className="sp-arch-meta">
                {mode === 'extract'
                  ? `${fmtBytes(entry?.size || 0)} · ${extractFormat === 'tar.gz' ? 'TAR.GZ archive' : 'ZIP archive'}`
                  : `Create a ${format === 'zip' ? 'ZIP' : 'TAR.GZ'} archive`}
              </div>
            </div>
          </div>

          {view === 'form' && mode === 'extract' && (
            <ClassicyForm
              layout="dialog"
              onSubmitFunc={(e) => {
                e.preventDefault();
                void submit(false);
              }}
            >
              <ClassicyInput
                id={`${winId}-arch-dest`}
                labelTitle="Extract To"
                labelPosition="left"
                prefillValue={dest}
                onChangeFunc={(e) => setDest(e.target.value)}
              />
              <p className="sp-arch-note">
                A new folder is created next to the archive; if the name is taken, a number is appended.
              </p>
              {unavailable && (
                <div className="sp-arch-error">
                  <div>{`${mode === 'extract' ? 'Extraction' : 'Compression'} is unavailable for this format on the server.`}</div>
                  {cap?.hint && <code className="sp-arch-hint">{cap.hint}</code>}
                </div>
              )}
              <ClassicyFormButtonRow>
                <ClassicyButton onClickFunc={onClose}>Cancel</ClassicyButton>
                <ClassicyButton
                  isDefault
                  buttonType="submit"
                  disabled={!dest.trim() || !!unavailable || !extractFormat}
                >
                  Extract
                </ClassicyButton>
              </ClassicyFormButtonRow>
            </ClassicyForm>
          )}

          {view === 'form' && mode === 'compress' && (
            <ClassicyForm
              layout="dialog"
              onSubmitFunc={(e) => {
                e.preventDefault();
                void submit(false);
              }}
            >
              <ClassicyInput
                id={`${winId}-arch-name`}
                labelTitle="Save As"
                labelPosition="left"
                prefillValue={name}
                onChangeFunc={(e) => setName(e.target.value)}
              />
              <ClassicyPopUpMenu
                id={`${winId}-arch-format`}
                label="Format"
                labelPosition="left"
                options={formatOptions}
                selected={format}
                disabled={formatOptions.length <= 1}
                onChangeFunc={(e) => setFormat(e.target.value as ArchiveFormat)}
              />
              <ClassicyInput
                id={`${winId}-arch-destdir`}
                labelTitle="Where"
                labelPosition="left"
                prefillValue={destDir}
                onChangeFunc={(e) => setDestDir(e.target.value)}
              />
              <p className="sp-arch-note">
                Saved as <code>{`${archiveStemOf(name.trim() || 'Archive')}${ext}`}</code> — an existing file is
                never overwritten (a number is appended instead).
              </p>
              {unavailable && (
                <div className="sp-arch-error">
                  <div>Compression is unavailable for this format on the server.</div>
                  {cap?.hint && <code className="sp-arch-hint">{cap.hint}</code>}
                </div>
              )}
              <ClassicyFormButtonRow>
                <ClassicyButton onClickFunc={onClose}>Cancel</ClassicyButton>
                <ClassicyButton
                  isDefault
                  buttonType="submit"
                  disabled={!name.trim() || !destDir.trim() || !!unavailable || formatOptions.length === 0}
                >
                  Compress
                </ClassicyButton>
              </ClassicyFormButtonRow>
            </ClassicyForm>
          )}

          {view === 'running' && (
            <div className="sp-arch-progress">
              <div className="sp-arch-phase">{phaseLabel(mode, progress.phase)}</div>
              <div className="sp-arch-progress-row">
                <span className="sp-arch-bar">
                  <ClassicyProgressBar indeterminate={indeterminate} autoSwitch value={percent} max={100} />
                </span>
                <span className="sp-arch-pct">{indeterminate ? '' : `${percent}%`}</span>
              </div>
              <div className="sp-arch-current" title={progress.current}>
                {progress.current || '…'}
              </div>
              <div className="sp-arch-count">
                {progress.processed}
                {progress.total != null ? ` / ${progress.total}` : ''} item
                {progress.processed === 1 ? '' : 's'}
              </div>
              <div className="sp-arch-actions">
                <ClassicyButton onClickFunc={cancelJob}>Cancel</ClassicyButton>
              </div>
            </div>
          )}

          {view === 'done' && result && (
            <div className="sp-arch-done">
              <div className="sp-arch-phase">
                {mode === 'extract' ? `Extracted ${result.items} items to` : 'Created archive'}
              </div>
              <div className="sp-arch-path" title={result.dest}>
                {result.dest}
              </div>
              {mode === 'compress' && result.bytes ? (
                <div className="sp-arch-meta">{fmtBytes(result.bytes)}</div>
              ) : null}
              {(result.warnings || []).map((w, i) => (
                <div key={i} className="sp-arch-note sp-arch-warn">
                  {w}
                </div>
              ))}
              <div className="sp-arch-actions">
                {onReveal && (
                  <ClassicyButton
                    onClickFunc={() => {
                      onReveal(result.dest);
                      onClose();
                    }}
                  >
                    Show in Files
                  </ClassicyButton>
                )}
                <ClassicyButton isDefault onClickFunc={onClose}>
                  Done
                </ClassicyButton>
              </div>
            </div>
          )}

          {view === 'error' && error && (
            <div className="sp-arch-error-view">
              <div className="sp-arch-phase">Could not {mode === 'extract' ? 'extract' : 'compress'}</div>
              <div className="sp-arch-error-text">{error.message}</div>
              {error.code !== 'INTERNAL' && <div className="sp-arch-meta">error code: {error.code}</div>}
              {error.hint && <code className="sp-arch-hint">{error.hint}</code>}
              {error.detail && <pre className="sp-arch-detail">{error.detail}</pre>}
              <div className="sp-arch-actions">
                <ClassicyButton onClickFunc={onClose}>Close</ClassicyButton>
                <ClassicyButton
                  isDefault
                  onClickFunc={() => {
                    setError(null);
                    setView('form');
                  }}
                >
                  Try Again
                </ClassicyButton>
              </div>
            </div>
          )}

          {view === 'canceled' && (
            <div className="sp-arch-done">
              <div className="sp-arch-phase">Canceled</div>
              <p className="sp-arch-note">
                No completed files were left behind. If you extracted into an existing folder, partial files may
                remain there.
              </p>
              <div className="sp-arch-actions">
                <ClassicyButton isDefault onClickFunc={onClose}>
                  Close
                </ClassicyButton>
              </div>
            </div>
          )}
        </div>
      </ClassicyWindow>

      {confirmOverwrite && (
        <ClassicyAlert
          appId={appId}
          alertType="caution"
          label="Replace Existing Files?"
          message={`“${baseName(confirmOverwrite)}” already contains files. Extracting here overwrites files with the same name; other files are kept.`}
          defaultButtonId="cancel"
          buttons={[
            { id: 'cancel', label: 'Cancel', role: 'cancel' },
            {
              id: 'replace',
              label: 'Replace',
              role: 'normal',
              onClick: () => {
                setConfirmOverwrite(null);
                void submit(true);
              },
            },
          ]}
          onClose={() => setConfirmOverwrite(null)}
        />
      )}
    </>
  );
}
