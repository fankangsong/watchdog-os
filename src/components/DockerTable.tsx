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
      { id: 'name', title: '容器名', accessor: (c) => c.name, width: 140 },
      { id: 'image', title: '镜像', accessor: (c) => c.image, sortable: false },
      { id: 'status', title: '状态', accessor: (c) => c.status },
      { id: 'cpu', title: 'CPU', accessor: (c) => c.cpu, align: 'right', render: (c) => cellRes(parseFloat(c.cpu) || 0, c.cpu) },
      { id: 'mem', title: '内存占用', accessor: (c) => c.mem, align: 'right' },
      { id: 'memPct', title: '内存%', accessor: (c) => c.memPct, align: 'right', render: (c) => cellRes(parseFloat(c.memPct) || 0, c.memPct) },
      { id: 'net', title: '网络 I/O', accessor: (c) => c.net, align: 'right', sortable: false },
      { id: 'block', title: '磁盘 I/O', accessor: (c) => c.block, align: 'right', sortable: false },
      { id: 'pids', title: 'PIDs', accessor: (c) => c.pids, align: 'right', sortable: false },
    ],
    []
  );

  if (!state) return <p className="sp-dim">加载中…</p>;
  if (!state.available) return <p className="sp-dim">{state.error || 'Docker 不可用'}</p>;
  if (!state.containers || state.containers.length === 0) return <p className="sp-dim">无运行中的容器</p>;

  return (
    <ClassicyTable
      columns={columns}
      rows={state.containers}
      getRowId={(c) => c.name}
    />
  );
}
