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

// 系统进程面板：ClassicyInput 搜索 + ClassicyTable 列表
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

  const columns = useMemo<ClassicyTableColumn<ProcItem>[]>(
    () => [
      { id: 'pid', title: 'PID', accessor: (p) => p.pid, align: 'right', width: 64 },
      { id: 'user', title: '用户', accessor: (p) => p.user || '-' },
      { id: 'cpuPct', title: 'CPU%', accessor: (p) => p.cpuPct, align: 'right', render: (p) => cellRes(p.cpuPct, p.cpuPct.toFixed(1)) },
      { id: 'mem', title: '内存', accessor: (p) => fmtBytes(p.mem), align: 'right' },
      { id: 'memPct', title: '内存%', accessor: (p) => (p.memPct != null ? p.memPct : -1), align: 'right' },
      { id: 'etime', title: '运行时长', accessor: (p) => p.etime || '-', align: 'right' },
      { id: 'cmd', title: '命令 / 进程名', accessor: (p) => p.cmd, sortable: false, render: (p) => <span className="sp-cmd" title={p.cmd}>{p.cmd}</span> },
    ],
    []
  );

  if (!processes) {
    return <ClassicyControlGroup label="系统进程"><p className="sp-dim">加载中…</p></ClassicyControlGroup>;
  }
  if (!processes.available) {
    return <ClassicyControlGroup label="系统进程"><p className="sp-dim">{processes.error || '进程数据不可用'}</p></ClassicyControlGroup>;
  }

  return (
    <ClassicyControlGroup label={`系统进程（${list.length}）`}>
      <div style={{ marginBottom: 8 }}>
        <ClassicyInput
          id="sp-proc-search"
          placeholder="搜索进程 / PID…"
          prefillValue={q}
          onChangeFunc={(e) => setQ(e.target.value)}
        />
      </div>
      <ClassicyTable
        columns={columns}
        rows={list}
        getRowId={(p) => String(p.pid)}
        defaultSort={{ columnId: 'cpuPct', desc: true }}
      />
    </ClassicyControlGroup>
  );
}
