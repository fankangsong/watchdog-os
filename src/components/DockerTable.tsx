import { useMemo } from 'react';
import { ClassicyTable, type ClassicyTableColumn } from 'classicy';
import type { DockerContainer, DockerState } from '../api';
import { levelColor } from '../format';

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

// Docker 容器列表：ClassicyTable 只读展示
export function DockerTable({ state }: { state: DockerState | null }) {
  const columns = useMemo<ClassicyTableColumn<DockerContainer>[]>(
    () => [
      { id: 'name', title: 'Name', accessor: (c) => c.name, width: 140 },
      { id: 'image', title: 'Image', accessor: (c) => c.image, sortable: false },
      { id: 'status', title: 'Status', accessor: (c) => c.status },
      { id: 'cpu', title: 'CPU', accessor: (c) => c.cpu, align: 'right', render: (c) => cellRes(parseFloat(c.cpu) || 0, c.cpu) },
      { id: 'mem', title: 'Memory', accessor: (c) => c.mem, align: 'right' },
      { id: 'memPct', title: 'Mem %', accessor: (c) => c.memPct, align: 'right', render: (c) => cellRes(parseFloat(c.memPct) || 0, c.memPct) },
      { id: 'net', title: 'Net I/O', accessor: (c) => c.net, align: 'right', sortable: false },
      { id: 'block', title: 'Block I/O', accessor: (c) => c.block, align: 'right', sortable: false },
      { id: 'pids', title: 'PIDs', accessor: (c) => c.pids, align: 'right', sortable: false },
    ],
    []
  );

  if (!state) return <p className="sp-dim">Loading…</p>;
  if (!state.available) return <p className="sp-dim">{state.error || 'Docker unavailable'}</p>;
  if (!state.containers || state.containers.length === 0) return <p className="sp-dim">No running containers</p>;

  return (
    <ClassicyTable
      columns={columns}
      rows={state.containers}
      getRowId={(c) => c.name}
    />
  );
}
