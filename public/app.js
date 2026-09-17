/* 系统探针监控 - 前端逻辑 */
'use strict';

const $ = (s) => document.querySelector(s);
const CIRC = 2 * Math.PI * 45; // 仪表盘弧长

let timer = null;
let countdownTimer = null;
let countdownSec = 5;
let paused = false;
let intervalSec = 5;
let lastHistory = [];

/* ---------- 工具 ---------- */
function fmtBytes(b) {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return b.toFixed(i >= 2 ? 1 : 0) + ' ' + units[i];
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}天${h}时${m}分` : h > 0 ? `${h}时${m}分` : `${m}分`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* "12.30%" / "1.942GiB / 3GiB" 之类字符串里取百分比数字 */
function pctOf(s) {
  const m = String(s || '').match(/([\d.]+)\s*%/);
  return m ? +m[1] : null;
}

function levelClass(pct) {
  return pct < 60 ? 'c-ok' : pct < 85 ? 'c-warn' : 'c-bad';
}
function levelColor(pct) {
  return pct < 60 ? 'var(--ok)' : pct < 85 ? 'var(--warn)' : 'var(--bad)';
}

/* 资源占用迷你条 + 数值 */
function cellRes(pct, text) {
  if (pct == null) return text || '-';
  return `<span class="cell-res"><span class="mini-bar"><span class="mini-fill" style="width:${Math.min(pct, 100)}%;background:${levelColor(pct)}"></span></span><span class="${levelClass(pct)}">${text}</span></span>`;
}

/* ---------- 错误横幅 ---------- */
function showError(msg) {
  const el = $('#err-banner');
  el.textContent = '⚠ ' + msg;
  el.classList.add('show');
}
function hideError() {
  $('#err-banner').classList.remove('show');
}

/* ---------- 倒计时 ---------- */
function renderCountdown() {
  const el = $('#countdown');
  el.textContent = paused ? '已暂停' : `${countdownSec}s 后刷新`;
}
function resetCountdown() {
  countdownSec = intervalSec;
  renderCountdown();
}
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  resetCountdown();
  countdownTimer = setInterval(() => {
    if (paused) { renderCountdown(); return; }
    countdownSec -= 1;
    if (countdownSec <= 0) countdownSec = intervalSec;
    renderCountdown();
  }, 1000);
}

/* ---------- 主题 ---------- */
function applyTheme(t) {
  document.body.setAttribute('data-theme', t);
  localStorage.setItem('sp_theme', t);
}
$('#theme-btn').addEventListener('click', () => {
  const cur = document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(cur === 'light' ? 'dark' : 'light');
  drawHistory(lastHistory); // 主题切换后重绘曲线配色
});

/* ---------- 仪表盘 ---------- */
/* 主题色读取：CPU 固定用 --accent(蓝)，内存固定用 --ok(绿)，双主题自适应 */
function cssVar(name, fallback) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}
const CPU_COLOR = () => cssVar('--accent', '#38bdf8');
const MEM_COLOR = () => cssVar('--ok', '#34d399');

function setGauge(arcId, pct, textId, text, color) {
  const arc = $(arcId);
  arc.style.strokeDashoffset = CIRC * (1 - Math.min(pct, 100) / 100);
  arc.style.stroke = color;
  const el = $(textId);
  el.textContent = text;
  el.style.color = color;
}

/* ---------- CPU/内存 历史曲线（自适应高分屏） ---------- */
function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  const h = cv.clientHeight || 56;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawHistory(history) {
  lastHistory = history;
  const cv = $('#cpu-history');
  const { ctx, w, h } = sizeCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  // 网格线
  ctx.strokeStyle = 'rgba(148,163,184,.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const y of [0.25, 0.5, 0.75]) {
    ctx.moveTo(0, h * y); ctx.lineTo(w, h * y);
  }
  ctx.stroke();

  if (history.length < 2) return;
  const n = history.length;
  const draw = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - (Math.min(p[key], 100) / 100) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  draw('cpu', CPU_COLOR());
  draw('mem', MEM_COLOR());
}

let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => drawHistory(lastHistory));
});

/* ---------- 渲染 ---------- */
function renderCpu(d) {
  setGauge('#cpu-arc', d.cpu.usage, '#cpu-pct', d.cpu.usage.toFixed(1) + '%', CPU_COLOR());
  $('#cpu-load').textContent =
    d.cpu.loadavg ? `负载 ${d.cpu.loadavg.map((v) => v.toFixed(2)).join(' / ')}` : '';

  const coresBox = $('#cpu-cores');
  if (coresBox.childElementCount !== d.cpu.cores.length) {
    coresBox.innerHTML = d.cpu.cores
      .map((_, i) => `<div class="core"><span>C${i}</span><div class="core-bar"><div class="core-fill" id="cf${i}"></div></div></div>`)
      .join('');
  }
  d.cpu.cores.forEach((v, i) => {
    const bar = $('#cf' + i);
    if (bar) {
      bar.style.width = v + '%';
      bar.style.background = levelColor(v);
    }
  });
}

function renderMem(d) {
  if (!d.mem) return;
  setGauge('#mem-arc', d.mem.usagePct, '#mem-pct', d.mem.usagePct.toFixed(1) + '%', MEM_COLOR());
  $('#mem-detail').textContent = `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`;

  const swapBox = $('#swap-box');
  if (d.swap) {
    swapBox.hidden = false;
    $('#swap-pct').textContent = `${fmtBytes(d.swap.used)} / ${fmtBytes(d.swap.total)}（${d.swap.usagePct}%）`;
    const bar = $('#swap-bar');
    bar.style.width = d.swap.usagePct + '%';
    bar.style.background = levelColor(d.swap.usagePct);
  } else {
    swapBox.hidden = true;
  }
}

function renderTemps(temps) {
  const el = $('#host-temp');
  if (!el) return;
  if (!temps || temps.length === 0) {
    el.textContent = '-';
    el.title = '未检测到硬件温度传感器（常见于虚拟机/Windows）';
    el.className = 'dim';
    return;
  }
  const items = temps.slice(0, 8).map((t) => `${t.label} ${t.temp}°C`);
  const max = Math.max(...temps.map((t) => t.temp));
  el.textContent = items.join(' · ');
  el.title = temps.map((t) => `${t.label} ${t.temp}°C`).join('\n');
  el.className = max < 60 ? 'c-ok' : max < 75 ? 'c-warn' : 'c-bad';
}

function renderDisks(disks) {
  const box = $('#disks');
  if (!disks || disks.length === 0) {
    box.innerHTML = '<p class="dim">无挂载点数据</p>';
    return;
  }
  box.innerHTML = disks
    .map((d) => {
      if (d.error) {
        return `<div class="bar-item"><div class="bar-label"><span>${esc(d.mount)}</span><span class="dim">${d.error}</span></div></div>`;
      }
      return `<div class="bar-item">
        <div class="bar-label"><span>${esc(d.mount)}</span><span>${d.usagePct}% · ${fmtBytes(d.used)} / ${fmtBytes(d.total)}</span></div>
        <div class="bar"><div class="bar-fill" style="width:${d.usagePct}%;background:${levelColor(d.usagePct)}"></div></div>
      </div>`;
    })
    .join('');
}

function renderDocker(docker) {
  const tbody = $('#docker-tbody');
  if (!docker.available) {
    $('#docker-count').textContent = '不可用';
    tbody.innerHTML = `<tr><td colspan="9" class="dim">${docker.error || 'docker 不可用'}</td></tr>`;
    return;
  }
  const cs = docker.containers || [];
  $('#docker-count').textContent = cs.length ? `${cs.length} 个运行中` : '无运行容器';
  if (cs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="dim">当前没有运行中的容器</td></tr>';
    return;
  }
  tbody.innerHTML = cs
    .map((c) => {
      const cpu = pctOf(c.cpu);
      const memPct = pctOf(c.memPct);
      return `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td class="dim">${esc(c.image)}</td>
      <td class="c-ok">${esc(c.status)}</td>
      <td class="num">${cellRes(cpu, c.cpu)}</td>
      <td class="num">${esc(c.mem)}</td>
      <td class="num">${cellRes(memPct, c.memPct)}</td>
      <td class="num dim">${esc(c.net)}</td>
      <td class="num dim">${esc(c.block)}</td>
      <td class="num dim">${esc(c.pids)}</td>
    </tr>`;
    })
    .join('');
}

function renderHost(d) {
  const h = d.host;
  const setText = (sel, v) => {
    const el = $(sel);
    if (el) el.textContent = v;
  };
  setText('#host-name', h.hostname);
  setText('#host-os', `${h.platform} ${h.release} · ${h.arch}`);
  setText('#host-cpu', `${h.cpuModel} × ${h.cpuCount}`);
  setText('#host-uptime', fmtUptime(h.uptime));
  setText('#host-lan', (h.lanIp || []).join(', ') || '-');
  setText('#host-wan', h.wanIp || '-');
  setText('#page-title', h.hostname);
  document.title = `${h.hostname} · 系统探针`;
}

/* ---------- 数据拉取 ---------- */
async function refresh() {
  try {
    const r = await fetch('./api/metrics');
    if (r.status === 401) { location.href = './login'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderHost(d);
    renderCpu(d);
    renderMem(d);
    renderTemps(d.temps);
    renderDisks(d.disks);
    renderDocker(d.docker);
    drawHistory(d.history || []);
    hideError();
    $('#update-time').textContent = '数据更新于 ' + new Date(d.collectedAt || Date.now()).toLocaleTimeString();
  } catch (e) {
    showError('数据刷新失败：' + e.message + '（将在下个周期自动重试）');
  }
  resetCountdown();
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (!paused) refresh(); }, intervalSec * 1000);
  startCountdown();
}

/* ---------- 进程列表 ---------- */
let allProcs = [];
let procSort = { key: 'cpuPct', dir: 'desc' };
let procKeyword = '';

function compareProc(a, b) {
  const k = procSort.key;
  let va = a[k], vb = b[k];
  if (k === 'user' || k === 'etime' || k === 'cmd') {
    va = String(va || '').toLowerCase();
    vb = String(vb || '').toLowerCase();
    return procSort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  }
  va = +va || 0; vb = +vb || 0;
  return procSort.dir === 'asc' ? va - vb : vb - va;
}

function renderProcs() {
  const tbody = $('#proc-tbody');
  let rows = allProcs;
  if (procKeyword) {
    const kw = procKeyword.toLowerCase();
    rows = rows.filter(
      (p) => (p.cmd || '').toLowerCase().includes(kw) || String(p.pid).includes(kw) || (p.user || '').toLowerCase().includes(kw)
    );
  }
  rows = rows.slice().sort(compareProc);

  // 表头箭头
  document.querySelectorAll('#proc-table th.sortable').forEach((th) => {
    th.querySelector('.arrow').textContent = th.dataset.key === procSort.key ? (procSort.dir === 'asc' ? '▲' : '▼') : '';
  });

  $('#proc-count').textContent = rows.length ? `${rows.length} 条` : '';
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="dim">无匹配进程</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (p) => `<tr>
      <td class="num dim">${p.pid}</td>
      <td>${esc(p.user) || '-'}</td>
      <td class="num">${cellRes(p.cpuPct, p.cpuPct.toFixed(1))}</td>
      <td class="num">${fmtBytes(p.mem)}</td>
      <td class="num">${p.memPct != null ? p.memPct.toFixed(1) : '-'}</td>
      <td class="num dim">${esc(p.etime) || '-'}</td>
      <td><span class="proc-cmd" title="${esc(p.cmd)}">${esc(p.cmd)}</span></td>
    </tr>`
    )
    .join('');
}

async function refreshProcs() {
  try {
    const r = await fetch('./api/processes');
    if (r.status === 401) { location.href = './login'; return; }
    if (!r.ok) return;
    const d = await r.json();
    allProcs = d.available ? d.list || [] : [];
    if (!d.available) {
      $('#proc-count').textContent = '不可用';
      $('#proc-tbody').innerHTML = `<tr><td colspan="7" class="dim">${d.error || '进程信息不可用'}</td></tr>`;
      return;
    }
    renderProcs();
  } catch { /* 下轮重试 */ }
}

/* 搜索防抖 */
let searchTimer = 0;
$('#proc-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    procKeyword = e.target.value.trim();
    renderProcs();
  }, 150);
});

/* 表头点击排序：同列再点切换升降序 */
document.querySelectorAll('#proc-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (procSort.key === key) {
      procSort.dir = procSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      procSort = { key, dir: key === 'cpuPct' || key === 'mem' || key === 'memPct' ? 'desc' : 'asc' };
    }
    renderProcs();
  });
});

/* ---------- 控件 ---------- */
$('#interval').addEventListener('change', (e) => {
  intervalSec = +e.target.value;
  startTimer();
});

$('#pause-btn').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? '▶ 继续' : '⏸ 暂停';
  renderCountdown();
});

$('#logout-btn').addEventListener('click', async () => {
  if (!confirm('确定退出登录？')) return;
  await fetch('./api/logout', { method: 'POST' }).catch(() => {});
  location.href = './login';
});

refresh();
startTimer();
refreshProcs();
setInterval(refreshProcs, 10000);
