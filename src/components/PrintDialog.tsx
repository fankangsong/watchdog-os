// Files 应用「Print…」对话框：选中文件后由 File 菜单 / 右键菜单 / 预览窗口菜单调起。
// 打印配置（打印机 / 纸张大小 / 彩色黑白 / 页码范围）先在前端校验，再经
// POST /api/printer/print 交给 CUPS；服务端另做 FS_ROOTS 路径白名单与文件内容嗅探。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ClassicyButton,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyRadioInput,
  ClassicyWindow,
} from 'classicy';
import { fetchPrinter, printFile, Unauthorized } from '../api';
import type { FsEntry, PrinterInfo } from '../api';
import { fmtBytes } from '../format';

/** 纸张尺寸：value 必须与 server/api/printer.js 的 PRINT_PAPER_SIZES 白名单一致 */
const PAPER_SIZES = [
  { value: 'A4', label: 'A4 (210 × 297 mm)' },
  { value: 'A3', label: 'A3 (297 × 420 mm)' },
  { value: 'A5', label: 'A5 (148 × 210 mm)' },
  { value: 'Letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'Legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'Executive', label: 'Executive (7.25 × 10.5 in)' },
  { value: 'Tabloid', label: 'Tabloid (11 × 17 in)' },
  { value: 'B5', label: 'B5 (176 × 250 mm)' },
];

/** 页码范围：1-3、5、8- 等，逗号分隔；空串表示全部（与服务端 PRINT_PAGE_RANGE_RE 一致） */
const PAGE_RANGE_RE = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;
function normalizePageRange(raw: string): string | null {
  const v = raw.replace(/\s+/g, '');
  if (!v) return '';
  return PAGE_RANGE_RE.test(v) ? v : null;
}

export interface PrintSubmitted {
  printer: string;
  jobId: string;
  title: string;
  pageRange: string;
}

export function PrintDialog({
  appId,
  icon,
  winId,
  entry,
  onClose,
  onLogout,
  onSubmitted,
}: {
  appId: string;
  icon: string;
  /** 父窗口 id：多浏览窗口实例并存时保证对话框 id 全局唯一 */
  winId: string;
  entry: FsEntry;
  onClose: () => void;
  onLogout: () => void;
  onSubmitted: (r: PrintSubmitted) => void;
}) {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersError, setPrintersError] = useState('');
  const [printersLoading, setPrintersLoading] = useState(true);
  const [printer, setPrinter] = useState('');
  const [paperSize, setPaperSize] = useState('A4');
  const [colorMode, setColorMode] = useState<'color' | 'mono'>('color');
  const [pageRangeRaw, setPageRangeRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // 打开对话框时才拉一次打印机列表（不订阅轮询）：列表稳定、无需常驻请求
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await fetchPrinter();
        if (!alive) return;
        const list = s.available ? s.printers : [];
        setPrinters(list);
        setPrinter(list[0]?.name || '');
        if (!s.available) setPrintersError(s.error || 'Printer service is unavailable.');
      } catch (e) {
        if (!alive) return;
        if (e instanceof Unauthorized) return onLogout();
        setPrintersError((e as Error).message || 'Failed to load printers.');
      } finally {
        if (alive) setPrintersLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [onLogout]);

  const printerOptions = useMemo(
    () =>
      printers.length > 0
        ? printers.map((p) => ({ value: p.name, label: p.state === 'idle' ? p.name : `${p.name} (${p.state})` }))
        : [{ value: '', label: printersLoading ? 'Loading printers…' : 'No printers available' }],
    [printers, printersLoading]
  );

  const colorInputs = useMemo(
    () => [
      { id: `fm-print-color-${winId}-color`, label: 'Color', checked: colorMode === 'color' },
      { id: `fm-print-color-${winId}-mono`, label: 'Black & White', checked: colorMode === 'mono' },
    ],
    [colorMode, winId]
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      const range = normalizePageRange(pageRangeRaw);
      if (range === null) {
        setError('Invalid page range. Use something like 1-3, 5, 8-');
        return;
      }
      if (!printer) {
        setError('No printer is available.');
        return;
      }
      setError('');
      setSubmitting(true);
      void (async () => {
        try {
          const r = await printFile({
            path: entry.path,
            printer,
            paperSize,
            colorMode,
            pageRange: range,
          });
          // 成功即关窗（父窗口弹已提交提示）；不在卸载后再 setState
          onSubmitted({ printer: r.printer, jobId: r.jobId, title: r.title, pageRange: r.pageRange });
        } catch (err) {
          if (err instanceof Unauthorized) return onLogout();
          setError((err as Error).message || 'Print failed.');
          setSubmitting(false);
        }
      })();
    },
    [submitting, pageRangeRaw, printer, paperSize, colorMode, entry.path, onSubmitted, onLogout]
  );

  return (
    <ClassicyWindow
      id={`fm-print-${winId}`}
      appId={appId}
      title={`Print · ${entry.name}`}
      icon={icon}
      modal
      closable={false}
      zoomable={false}
      collapsable={false}
      resizable={false}
      initialSize={[400, 0]}
      initialPosition={['center', 'center']}
    >
      <ClassicyForm
        layout="dialog"
        onSubmitFunc={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !submitting) onClose();
        }}
      >
        <div className="sp-print-doc">
          <img src={icon} alt="" />
          <span className="sp-print-doc-name" title={entry.name}>
            {entry.name}
          </span>
          <span className="sp-print-doc-size">{fmtBytes(entry.size)}</span>
        </div>

        <div className="sp-print-field">
          <label htmlFor={`fm-print-printer-${winId}`}>Printer</label>
          <ClassicyPopUpMenu
            id={`fm-print-printer-${winId}`}
            options={printerOptions}
            selected={printer}
            placeholder="Loading printers…"
            disabled={printersLoading || printers.length === 0}
            onChangeFunc={(e) => setPrinter(e.target.value)}
          />
        </div>
        <div className="sp-print-field">
          <label htmlFor={`fm-print-paper-${winId}`}>Paper Size</label>
          <ClassicyPopUpMenu
            id={`fm-print-paper-${winId}`}
            options={PAPER_SIZES}
            selected={paperSize}
            onChangeFunc={(e) => setPaperSize(e.target.value)}
          />
        </div>
        <div className="sp-print-field">
          <label>Color</label>
          <ClassicyRadioInput
            name={`fm-print-color-${winId}`}
            align="columns"
            inputs={colorInputs}
            onClickFunc={(id) => setColorMode(id.endsWith('-mono') ? 'mono' : 'color')}
          />
        </div>
        <div className="sp-print-field">
          <label htmlFor={`fm-print-pages-${winId}`}>Pages</label>
          <ClassicyInput
            id={`fm-print-pages-${winId}`}
            prefillValue=""
            placeholder="All"
            onChangeFunc={(e) => setPageRangeRaw(e.target.value)}
          />
        </div>
        <div className="sp-print-note">Leave blank for all pages · e.g. 1-3, 5, 8-</div>

        {printersError && <div className="sp-print-error">{printersError}</div>}
        {error && <div className="sp-print-error">{error}</div>}

        <ClassicyFormButtonRow>
          <ClassicyButton disabled={submitting} onClickFunc={onClose}>
            Cancel
          </ClassicyButton>
          <ClassicyButton isDefault buttonType="submit" disabled={submitting || printersLoading || !printer}>
            {submitting ? 'Printing…' : 'Print'}
          </ClassicyButton>
        </ClassicyFormButtonRow>
      </ClassicyForm>
    </ClassicyWindow>
  );
}
