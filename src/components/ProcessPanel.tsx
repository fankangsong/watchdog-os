import { useMemo, useState } from 'react';
import { ClassicyControlGroup, ClassicyInput, ClassicyTable, type ClassicyTableColumn } from 'classicy';
import type { ProcItem, Processes } from '../api';
import { fmtBytes, levelColor } from '../format';

function cellRes(pct: number, text: string) {
  return (
    <span className="sp-cellres">
      <span className="sp-cellres-bar">
        <span style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: levelColor(pct) }} />
      </span>
      <span>{text}</span>
    </span>
  );
}

// 系统进程面板：ClassicyInput 搜索 + ClassicyTable 列表（表格在页内滚动，表头常驻）
export function ProcessPanel({ processes }: { processes: Processes | null }) {
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    if (!processes || !processes.list) return [];
    let rows = processes.list;
    const query = q.trim().toLowerCase();
    if (query) {
      rows = rows.filter(
        (p) => p.cmd.toLowerCase().includes(query) || String(p.pid).includes(query)
      );
    }
    return rows;
  }, [processes, q]);

  // 固定列给像素宽，Command 列不设 width（由 CSS 置为 auto 吃掉剩余空间）；
  // Command 关闭拖拽，避免列宽拖拽与弹性宽度互相覆盖。
  const columns = useMemo<ClassicyTableColumn<ProcItem>[]>(
    () => [
      { id: 'pid', title: 'PID', accessor: (p) => p.pid, align: 'right', width: 48 },
      { id: 'user', title: 'User', accessor: (p) => p.user || '-', width: 84 },
      { id: 'cpuPct', title: 'CPU%', accessor: (p) => p.cpuPct, align: 'right', width: 104, render: (p) => cellRes(p.cpuPct, p.cpuPct.toFixed(1)) },
      { id: 'mem', title: 'Memory', accessor: (p) => fmtBytes(p.mem), align: 'right', width: 80 },
      { id: 'memPct', title: 'Mem %', accessor: (p) => (p.memPct != null ? p.memPct : -1), align: 'right', width: 56 },
      { id: 'etime', title: 'Uptime', accessor: (p) => p.etime || '-', align: 'right', width: 76 },
      { id: 'cmd', title: 'Command', accessor: (p) => p.cmd, sortable: false, resizable: false, render: (p) => <span className="sp-cmd" title={p.cmd}>{p.cmd}</span> },
    ],
    []
  );

  if (!processes) {
    return <ClassicyControlGroup label="Processes"><p className="sp-dim">Loading…</p></ClassicyControlGroup>;
  }
  if (!processes.available) {
    return <ClassicyControlGroup label="Processes"><p className="sp-dim">{processes.error || 'Process data unavailable'}</p></ClassicyControlGroup>;
  }

  const total = processes.list.length;
  const filtering = q.trim().length > 0;
  const label = `Processes (${list.length}${filtering ? ` / ${total}` : ''})`;

  return (
    <ClassicyControlGroup label={label}>
      <div className="sp-proc-search">
        <ClassicyInput
          id="sp-proc-search"
          placeholder="Search processes / PID…"
          prefillValue={q}
          onChangeFunc={(e) => setQ(e.target.value)}
        />
      </div>
      {list.length === 0 ? (
        <p className="sp-dim">{filtering ? 'No processes match.' : 'No processes.'}</p>
      ) : (
        <div className="sp-proc-table-wrap">
          <ClassicyTable
            className="sp-proc-table"
            columns={columns}
            rows={list}
            getRowId={(p) => String(p.pid)}
            defaultSort={{ columnId: 'cpuPct', desc: true }}
          />
        </div>
      )}
    </ClassicyControlGroup>
  );
}
