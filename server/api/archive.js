/**
 * 压缩 / 解压模块（Files 应用）：调用系统归档工具的子进程 + **单请求 NDJSON 进度流**。
 *
 * 为什么不用 job + 轮询：解压/压缩本身是一次线性任务，前端只需要「开始 → 进度 → 结果」。
 * 这里把整条流包成一次 HTTP 响应（`application/x-ndjson`，每行一个事件），
 * 前端 await 同一个 Promise 即拿到最终结果，进度事件在同一连接内下发；
 * 取消走 AbortController → 服务端 `res.on('close')` 杀进程并清理半成品。
 *
 * 跨平台：能力按工具探测结果分派，不按 OS 硬编码。
 * - Windows 10 1803+ 自带 %SystemRoot%\System32\tar.exe（bsdtar），zip / tar.gz 读写通吃；
 *   但 PATH 上的 `tar` 常是 Git 的 GNU tar（不支持 zip），所以必须显式优先 System32 并校验 `--version`。
 * - macOS 的 /usr/bin/tar 就是 bsdtar，零额外依赖。
 * - Linux 用 GNU tar + unzip / zip；Alpine 的 busybox unzip 不支持 `-Z1`，列表走三级降级。
 *
 * 安全：路径校验复用 fs.js 的 FS_ROOTS 白名单；解压前对归档条目做 Zip Slip 校验（整包拒绝），
 * 解到临时目录 `.wdpart-*` 成功后再 rename 到目标，用户永远看不到半成品。
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { cfg } = require('../config');
const { send, readBody } = require('../lib/http');
const { fsResolveRaw, fsAllowed, fsIsRoot, fsSafeName, fsFreeNumbered } = require('./fs');

/* ---------- 常量 ---------- */

const MAX_ENTRIES = 200000; // 归档条目上限（列表阶段超限直接拒，防内存与 UI 爆掉）
const MAX_LIST_BYTES = 8 * 1024 * 1024; // 列表输出读取上限
const MAX_SOURCES = 100; // 单次压缩的源条目上限
const JOB_MAX_MS = 6 * 60 * 60 * 1000; // 单任务硬上限
const KILL_GRACE_MS = 3000; // SIGTERM → SIGKILL 宽限
const CAPS_TTL_MS = 5 * 60 * 1000; // 工具探测结果缓存
const PROBE_TIMEOUT_MS = 3000;
const HEARTBEAT_MS = 2000; // 心跳间隔（防反代 idle 超时）
const HEARTBEAT_IDLE_MS = 1500; // 无帧超过该时长才补心跳
const PROGRESS_THROTTLE_MS = 100; // 进度帧最小间隔

/* 归档里允许的格式；扩展名判定与前端 archiveFormatOf 保持一致 */
const FORMAT_ZIP = 'zip';
const FORMAT_TARGZ = 'tar.gz';

/* ---------- 小工具 ---------- */

/** 判断是否为可执行文件（Windows 不检查权限位） */
function isExecFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 中查找可执行文件（零依赖版 which）。
 * Windows 按 PATHEXT 枚举，且**只接受 .exe / .com**：.cmd / .bat 是 scoop/choco 的 shim，
 * spawn 不带 shell 会 ENOENT，带 shell 又要重新处理转义，收益不抵风险。
 */
function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) return isExecFile(name) ? name : null;
  const exts =
    process.platform === 'win32'
      ? String(process.env.PATHEXT || '.COM;.EXE').split(';').filter((e) => /^\.(exe|com)$/i.test(e))
      : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isExecFile(p)) return p;
    }
  }
  return null;
}

/** 跑一个探测命令：只关心「能不能跑起来」，退出码非 0 也算可用（busybox 等用法差异大） */
function probeRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const code = (err && err.code) || '';
      const spawnFailed = code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ETIMEDOUT';
      resolve({ ran: !spawnFailed, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

/** 平台相关的安装提示（工具缺失时展示在对话框里） */
function toolHint(kind) {
  if (process.platform === 'win32') {
    return kind === 'zip'
      ? 'Windows 10 1803+ 自带 bsdtar（C:\\Windows\\System32\\tar.exe）即可创建 zip；若 PATH 上的 tar 是 GNU tar，请改用系统自带 tar.exe，或安装 7-Zip / zip 后重试。'
      : 'Windows 10 1803+ 自带 bsdtar（C:\\Windows\\System32\\tar.exe）；也可安装 unzip 或 7-Zip 后重试。';
  }
  if (process.platform === 'darwin') return 'macOS 自带 /usr/bin/tar（bsdtar）；若缺失请运行 xcode-select --install。';
  if (kind === 'zip') return '请安装 zip：sudo apt-get install zip（Debian/Ubuntu）或 sudo dnf install zip（RHEL/Fedora）';
  if (kind === 'unzip') return '请安装 unzip：sudo apt-get install unzip（Debian/Ubuntu）或 sudo dnf install unzip（RHEL/Fedora）';
  return '请安装 tar 与 gzip（base 系统一般自带）：sudo apt-get install tar gzip';
}

/* ---------- 工具探测 ---------- */

let toolsCache = null; // { at, value }
let toolsPending = null;

/** tar 候选：配置覆盖 → Windows System32 bsdtar → PATH bsdtar → PATH tar */
function tarCandidates() {
  const forced = String((cfg.archive && cfg.archive.tarPath) || '').trim();
  if (forced) return [forced];
  const out = [];
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    out.push(path.join(sysRoot, 'System32', 'tar.exe'));
    out.push('bsdtar');
  }
  out.push('tar');
  return out;
}

/** 解析 tar：只有 --version 输出 bsdtar / libarchive 才认为支持 zip */
async function resolveTar() {
  const seen = new Set();
  for (const cand of tarCandidates()) {
    const cmd = isExecFile(cand) ? cand : whichSync(cand);
    if (!cmd) continue;
    const key = process.platform === 'win32' ? cmd.toLowerCase() : cmd;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await probeRun(cmd, ['--version']);
    if (!r.ran) continue;
    const out = r.out.toLowerCase();
    const kind = out.includes('bsdtar') || out.includes('libarchive') ? 'bsdtar' : 'gnutar';
    const version = (r.out.split(/\r?\n/)[0] || '').trim().slice(0, 120);
    return { cmd, kind, version };
  }
  return null;
}

/** 解析 unzip / zip / gzip：配置覆盖优先，非空即「只用它，不回落」 */
async function resolveTool(name, forced) {
  const raw = String(forced || '').trim();
  const cmd = raw ? (isExecFile(raw) ? raw : null) : whichSync(name);
  if (!cmd) return null;
  const r = await probeRun(cmd, ['-h']);
  if (!r.ran) return null;
  return { cmd };
}

function buildCaps(tools) {
  const tar = tools.tar;
  const unzip = tools.unzip;
  const zip = tools.zip;
  const gzip = tools.gzip;
  // GNU tar / busybox tar 的 -z 依赖外部 gzip；bsdtar 内建 zlib，无需外部工具
  const tarGzOk = !!tar && (tar.kind === 'bsdtar' || !!gzip);
  const can = {
    extractZip: tar && tar.kind === 'bsdtar'
      ? { ok: true, via: 'bsdtar', hint: null }
      : unzip
        ? { ok: true, via: 'unzip', hint: null }
        : { ok: false, via: null, hint: toolHint('unzip') },
    extractTarGz: tarGzOk
      ? { ok: true, via: tar.kind === 'bsdtar' ? 'bsdtar' : 'gnutar', hint: null }
      : { ok: false, via: null, hint: toolHint('tar') },
    compressZip: tar && tar.kind === 'bsdtar'
      ? { ok: true, via: 'bsdtar', hint: null }
      : zip
        ? { ok: true, via: 'zip', hint: null }
        : { ok: false, via: null, hint: toolHint('zip') },
    compressTarGz: tarGzOk
      ? { ok: true, via: tar.kind === 'bsdtar' ? 'bsdtar' : 'gnutar', hint: null }
      : { ok: false, via: null, hint: toolHint('tar') },
  };
  return {
    platform: process.platform,
    tools: {
      tar: tar ? { path: tar.cmd, kind: tar.kind, version: tar.version } : null,
      unzip: unzip ? { path: unzip.cmd } : null,
      zip: zip ? { path: zip.cmd } : null,
      gzip: gzip ? { path: gzip.cmd } : null,
    },
    can,
    checkedAt: Date.now(),
  };
}

/** 探测工具能力（异步一次，结果缓存；force=true 强制重探） */
function detectTools(force = false) {
  if (!force && toolsCache && Date.now() - toolsCache.at < CAPS_TTL_MS) return Promise.resolve(toolsCache.value);
  if (toolsPending) return toolsPending;
  const p = (async () => {
    const tar = await resolveTar();
    const unzip = await resolveTool('unzip', cfg.archive && cfg.archive.unzipPath);
    const zip = await resolveTool('zip', cfg.archive && cfg.archive.zipPath);
    const gzip = await resolveTool('gzip', '');
    return buildCaps({ tar, unzip, zip, gzip });
  })();
  toolsPending = p;
  p.then((value) => {
    toolsCache = { at: Date.now(), value };
  })
    .catch(() => {})
    .finally(() => {
      if (toolsPending === p) toolsPending = null;
    });
  return p;
}

/* ---------- 归档格式 ---------- */

function formatOf(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.zip')) return FORMAT_ZIP;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return FORMAT_TARGZ;
  return null;
}

/** 去掉归档扩展名：a.zip → a，a.tar.gz / a.tgz → a */
function archiveStem(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.tar.gz')) return name.slice(0, -7);
  if (lower.endsWith('.tgz')) return name.slice(0, -4);
  if (lower.endsWith('.zip')) return name.slice(0, -4);
  return name;
}

/* ---------- 进程启动 / 终止 ---------- */

function spawnOpts(opts) {
  const env = { ...process.env };
  const o = opts || {};
  if (process.platform !== 'win32') {
    // tar / unzip 用 C locale：消息固定英文，关键字映射（no space left 等）才可靠。
    // zip（Info-ZIP）例外：它按 locale 判断文件名编码，C locale 下中文名不会写 UTF-8
    // 标志位（bit 11），zip 回到 Windows 解压就是乱码；故 zip 传 localeC:false 走 C.UTF-8。
    const loc = o.localeC === false ? 'C.UTF-8' : 'C';
    env.LC_ALL = loc;
    env.LANG = loc;
  }
  return {
    cwd: o.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX 建独立进程组：GNU tar -z 会另起 gzip，kill 负号 pid 才能连坐清理
    detached: process.platform !== 'win32',
    env,
  };
}

/** 日志用的命令行（含空格的参数加引号，便于从 journalctl 直接复制复现） */
function formatCmd(cmd, args) {
  return `${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
}

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {
      /* 进程已退出 */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  const t = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }, KILL_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
}

/** 进程退出兜底：同步杀（execFileSync 保证在 process.on('exit') 里也能生效） */
function killTreeSync(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已退出 */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/* ---------- 输出行解析 ---------- */

/** 跨 chunk 行缓冲（StringDecoder 保证多字节字符不被切断；无换行超长缓冲只留尾部） */
function createLineReader(onLine) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    feed(chunk) {
      buf += dec.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        emit(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > 8192) buf = buf.slice(-8192);
    },
    flush() {
      const rest = buf + dec.end();
      buf = '';
      if (rest.trim()) emit(rest);
    },
  };
}

/* tar 系列（bsdtar / GNU tar / busybox tar）的诊断行；条目名不会是 `tar:` 这种前缀 */
const TAR_NOISE = /^(tar|bsdtar|gzip|bzip2|xz|warning|error|note)\s*[::]/i;
/* Info-ZIP unzip -o 的条目行：inflating / creating / linking / extracting / copying */
const UNZIP_ENTRY = /^\s*(inflating|extracting|creating|linking|copying):\s*(.+)$/;
/* Info-ZIP zip -r 的条目行：`  adding: name (deflated 42%)` */
const ZIP_ENTRY = /^\s+adding:\s*(.+?)(?:\s+\((?:deflated|stored|shrunk|imploded|bzip2|deflate64|fallback)[^)]*\))?\s*$/;

function cleanName(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
}

/** 按工具选择「这一行是否是一个归档条目」，命中则回调条目名 */
function createEntryMatcher(via, onEntry) {
  if (via === 'unzip') {
    return (line) => {
      const m = UNZIP_ENTRY.exec(line);
      if (m) onEntry(cleanName(m[2]));
    };
  }
  if (via === 'zip') {
    return (line) => {
      const m = ZIP_ENTRY.exec(line);
      if (m) onEntry(cleanName(m[1]));
    };
  }
  return (line) => {
    const s = line.trim();
    if (!s || TAR_NOISE.test(s)) return;
    const arrow = s.indexOf(' -> ');
    onEntry(cleanName(arrow > 0 ? s.slice(0, arrow) : s));
  };
}

/* ---------- 命令构造 ---------- */

function listCommand(tool, format, archiveAbs) {
  if (tool.kind === 'bsdtar') return { cmd: tool.cmd, args: ['-t', '-f', archiveAbs] };
  return { cmd: tool.cmd, args: ['-tzf', archiveAbs] };
}

function extractCommand(tool, via, archiveAbs, destDir) {
  if (via === 'bsdtar') return { cmd: tool.cmd, args: ['-x', '-v', '-f', archiveAbs, '-C', destDir] };
  if (via === 'unzip') return { cmd: tool.cmd, args: ['-o', archiveAbs, '-d', destDir] };
  return { cmd: tool.cmd, args: ['-x', '-z', '-v', '-f', archiveAbs, '-C', destDir] };
}

function compressCommand(tool, via, outAbs, names, srcDir, format) {
  if (via === 'bsdtar') {
    // -a 按输出扩展名自动选压缩器；-- 终止选项解析，避免以 - 开头的文件名被当作参数
    return { cmd: tool.cmd, args: ['-c', '-a', '-v', '-f', outAbs, '--', ...names], cwd: srcDir };
  }
  if (via === 'zip') {
    // zip 不支持 --，以 - 开头的名字加 ./ 前缀规避
    const safe = names.map((n) => (n.startsWith('-') ? `./${n}` : n));
    return { cmd: tool.cmd, args: ['-r', outAbs, ...safe], cwd: srcDir };
  }
  return {
    cmd: tool.cmd,
    args: format === FORMAT_TARGZ ? ['-c', '-z', '-v', '-f', outAbs, ...names] : ['-c', '-v', '-f', outAbs, ...names],
    cwd: srcDir,
  };
}

/* ---------- 子进程执行 ---------- */

/**
 * 跑一次「只收集输出」的命令（列表阶段）。
 * @param {{child: object|null}} ctl 取消句柄，用于外部 abort 时杀当前子进程
 */
function runCapture(cmd, args, ctl, maxLines) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, spawnOpts({}));
    } catch (e) {
      return resolve({ code: -1, lines: [], overflow: false, spawnError: e.message });
    }
    ctl.child = child;
    console.log(`[archive] spawn ${formatCmd(cmd, args)}`);
    const lines = [];
    let bytes = 0;
    let overflow = false;
    let settled = false;
    const reader = createLineReader((line) => {
      if (!line.trim()) return;
      if (lines.length >= maxLines) {
        overflow = true;
        return;
      }
      lines.push(line);
    });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (ctl.child === child) ctl.child = null;
      resolve(r);
    };
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes <= MAX_LIST_BYTES) reader.feed(c);
    });
    // stderr 必须消费掉，否则管道写满会让子进程卡死
    child.stderr.on('data', () => {});
    child.on('error', (e) => finish({ code: -1, lines, overflow, spawnError: e.message }));
    child.on('close', (code) => {
      reader.flush();
      finish({ code: typeof code === 'number' ? code : -1, lines, overflow });
    });
  });
}

/**
 * 跑一次「边跑边计数」的命令（解压/压缩阶段）。
 * stdout 与 stderr 都喂给同一个条目匹配器，但分别计数后取 max：
 * - bsdtar / GNU tar / zip / unzip 把条目写在 stdout；
 * - busybox tar 的 -v 走 stderr；
 * 取 max 而不是求和，避免两路重复输出时把进度算成两倍。
 */
function runStreaming(cmd, args, opts, ctx) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, spawnOpts(opts));
    } catch (e) {
      return resolve({ code: -1, spawnError: e.message, signal: null });
    }
    ctx.ctl.child = child;
    console.log(`[archive] spawn ${formatCmd(cmd, args)}`);
    const counts = { out: 0, err: 0 };
    const onEntry = (which) => (name) => {
      counts[which] += 1;
      ctx.onProgress(Math.max(counts.out, counts.err), name);
    };
    const outReader = createLineReader(createEntryMatcher(ctx.via, onEntry('out')));
    const errMatcher = createEntryMatcher(ctx.via, onEntry('err'));
    const errReader = createLineReader((line) => {
      errMatcher(line);
      const s = line.trim();
      if (s) ctx.onErrLine(s);
    });
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (ctx.ctl.child === child) ctx.ctl.child = null;
      resolve(r);
    };
    child.stdout.on('data', (c) => outReader.feed(c));
    child.stderr.on('data', (c) => errReader.feed(c));
    child.on('error', (e) => finish({ code: -1, spawnError: e.message, signal: null }));
    child.on('close', (code, signal) => {
      outReader.flush();
      errReader.flush();
      finish({ code: typeof code === 'number' ? code : -1, spawnError: null, signal: signal || null });
    });
  });
}

/* ---------- NDJSON 下发 ---------- */

/**
 * NDJSON 事件下发器。
 * **延迟开流**：第一次 write 才写响应头 —— 列条目 / Zip Slip 校验 / 工具缺失这类
 * 前置失败还没写头，可以照常返回 400/403/503 的 JSON，前端不必把两种渠道混在一起解析。
 * 列大归档超过 30s 时会主动发一帧（见 runExtract），避免反代 idle 超时。
 */
function createEmitter(res) {
  const progress = { phase: 'listing', processed: 0, total: null, percent: 0, current: '' };
  let started = false;
  let ended = false;
  let lastWrite = Date.now();
  const ensure = () => {
    if (started) return;
    started = true;
    openStream(res);
  };
  const write = (evt) => {
    if (ended || res.writableEnded) return;
    ensure();
    lastWrite = Date.now();
    try {
      res.write(JSON.stringify(evt) + '\n');
    } catch {
      /* 连接已断：由 res 'close' 收尾 */
    }
  };
  const push = (patch) => {
    Object.assign(progress, patch);
    write({ t: 'progress', ...progress });
  };
  const hb = setInterval(() => {
    if (!started || ended) return;
    if (Date.now() - lastWrite >= HEARTBEAT_IDLE_MS) write({ t: 'progress', ...progress });
  }, HEARTBEAT_MS);
  if (typeof hb.unref === 'function') hb.unref();
  return {
    progress,
    push,
    get started() {
      return started;
    },
    done: (payload) => write({ t: 'done', ...payload }),
    fail: (payload) => write({ t: 'error', ...payload }),
    end: () => {
      if (ended) return;
      ended = true;
      clearInterval(hb);
      if (!started) return; // 未开流：由 JSON 错误响应自己结束
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    },
  };
}

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // Nginx 等反代默认会对响应做缓冲：进度会攒到任务结束才一次性出现
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // 长任务：关闭 socket idle 超时（默认由 server 层控制）
  res.setTimeout(0);
}

/* ---------- 错误对象 ---------- */

function archiveError(code, message, detail, status) {
  const e = new Error(message);
  e.archiveCode = code;
  e.detail = detail || null;
  e.status = status || 400;
  return e;
}

function canceledError() {
  return archiveError('CANCELED', 'Task canceled', null, 499);
}

function toErrorPayload(e, hint) {
  const code = (e && e.archiveCode) || mapErrno(e) || 'INTERNAL';
  return {
    t: 'error',
    code,
    error: (e && e.message) || String(e),
    detail: (e && e.detail) || null,
    hint: hint || null,
  };
}

function mapErrno(e) {
  const c = (e && e.code) || '';
  if (c === 'ENOSPC') return 'DISK_FULL';
  if (c === 'EACCES' || c === 'EPERM') return 'PERMISSION_DENIED';
  if (c === 'ENOENT') return 'NOT_FOUND';
  if (c === 'ENOTDIR' || c === 'EISDIR') return 'DEST_NOT_DIR';
  return null;
}

/** 错误码 → HTTP 状态码（仅用于「开流前」的 JSON 错误） */
function statusOfCode(code) {
  if (code === 'PERMISSION_DENIED') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'DISK_FULL') return 507;
  if (code === 'TOOL_MISSING') return 503;
  if (code === 'ARCHIVE_TOO_LARGE') return 413;
  if (code === 'TOOL_FAILED' || code === 'INTERNAL' || code === 'UNEXPECTED_END') return 500;
  return 400;
}

/* ---------- 归档列表与安全校验 ---------- */

const UNZIP_LONG_ROW = /^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/;
const UNZIP_LONG_TOTAL = /^\s*(\d+)\s+files?\b/i;

function parseUnzipLong(lines) {
  const names = [];
  let total = null;
  for (const line of lines) {
    const t = UNZIP_LONG_TOTAL.exec(line);
    if (t) {
      total = parseInt(t[1], 10);
      continue;
    }
    const m = UNZIP_LONG_ROW.exec(line);
    if (m) names.push(m[1]);
  }
  return { names: names.length ? names : null, total };
}

/**
 * 列出归档条目。
 * 返回 { names | null, total | null, overflow, code, detail }：
 * - names 为 null 表示无法取得条目名（极端精简的 unzip），此时只做解压后路径校验；
 * - total 为 null 表示条目数未知，前端进度退化为不确定态。
 */
async function listArchive(tool, via, format, archiveAbs, ctl) {
  if (via === 'bsdtar' || via === 'gnutar') {
    const { cmd, args } = listCommand(tool, format, archiveAbs);
    const r = await runCapture(cmd, args, ctl, MAX_ENTRIES + 1);
    if (r.spawnError) return { names: null, total: null, overflow: false, spawnError: r.spawnError };
    const names = r.lines.map((l) => l.trim()).filter(Boolean);
    return { names: names.length ? names : null, total: names.length, overflow: r.overflow, code: r.code };
  }

  // unzip：-Z1（zipinfo 模式）最干净；busybox 不支持 → 退回 -l 解析；再不行则只给 total
  let r = await runCapture(tool.cmd, ['-Z1', archiveAbs], ctl, MAX_ENTRIES + 1);
  if (r.spawnError) return { names: null, total: null, overflow: false, spawnError: r.spawnError };
  const direct = r.lines.map((l) => l.trim()).filter(Boolean);
  if (r.code === 0 && direct.length) return { names: direct, total: direct.length, overflow: r.overflow, code: 0 };

  r = await runCapture(tool.cmd, ['-l', archiveAbs], ctl, MAX_ENTRIES + 10);
  if (r.spawnError) return { names: null, total: null, overflow: false, spawnError: r.spawnError };
  const parsed = parseUnzipLong(r.lines);
  return { names: parsed.names, total: parsed.total, overflow: r.overflow, code: r.code };
}

/**
 * Zip Slip 校验：绝对路径、盘符、任意一段 `..`、NUL、超长名字 → 整包拒绝。
 * 归档规范用 `/`，但 Windows 打的包可能用 `\`，先归一再分段。
 */
function findUnsafeEntry(names) {
  for (const raw of names) {
    const name = String(raw).replace(/\\/g, '/');
    if (!name) continue;
    if (name.length > 4096) return { name: name.slice(0, 200), reason: 'Entry name is too long' };
    if (name.includes('\u0000')) return { name: name.slice(0, 200), reason: 'Entry name contains NUL' };
    if (name.startsWith('/')) return { name: name.slice(0, 200), reason: 'Entry uses an absolute path' };
    if (/^[A-Za-z]:/.test(name)) return { name: name.slice(0, 200), reason: 'Entry uses a drive-letter path' };
    if (name.split('/').some((seg) => seg === '..')) {
      return { name: name.slice(0, 200), reason: 'Entry contains a parent-directory segment' };
    }
  }
  return null;
}

/** 解压后兜底校验：目标目录内不允许出现越界路径（符号链接按链接目标检查，不跟随遍历） */
async function verifyContainment(root, limit) {
  const rootAbs = path.resolve(root);
  const stack = [rootAbs];
  let seen = 0;
  while (stack.length && seen < limit) {
    const dir = stack.pop();
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      seen += 1;
      const abs = path.join(dir, it.name);
      const rel = path.relative(rootAbs, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
      if (it.isSymbolicLink()) {
        const target = await fsp.readlink(abs).catch(() => '');
        if (target) {
          const resolved = path.resolve(path.dirname(abs), target);
          const r = path.relative(rootAbs, resolved);
          if (r.startsWith('..') || path.isAbsolute(r)) return abs;
        }
        continue;
      }
      if (it.isDirectory()) stack.push(abs);
    }
  }
  return null;
}

/** 递归统计压缩源条目数（含目录自身，与 tar -v / zip adding 的行数对齐） */
async function countSources(sources) {
  let n = 0;
  const stack = sources.slice();
  while (stack.length) {
    const p = stack.pop();
    n += 1;
    let st = null;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let items = [];
      try {
        items = await fsp.readdir(p);
      } catch {
        /* 无权限：跳过子项 */
      }
      for (const name of items) stack.push(path.join(p, name));
    }
    if (n > MAX_ENTRIES) throw archiveError('ARCHIVE_TOO_LARGE', `Too many entries (limit ${MAX_ENTRIES})`);
    if (n % 300 === 0) await new Promise((r) => setImmediate(r));
  }
  return n;
}

/* ---------- 校验辅助 ---------- */

async function readJson(req) {
  try {
    const raw = await readBody(req, 64 * 1024);
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function fail(res, status, code, message, extra) {
  return send(res, status, Object.assign({ code, error: message }, extra || {}));
}

/* ---------- 解压 ---------- */

async function handleExtract(req, res) {
  const body = await readJson(req);
  if (!body) return fail(res, 400, 'INVALID_BODY', 'Invalid request body');
  if (body.path == null || !String(body.path).trim()) return fail(res, 400, 'INVALID_PATH', 'Archive path is required');

  const archiveAbs = fsResolveRaw(body.path);
  if (!archiveAbs || !fsAllowed(archiveAbs)) return fail(res, 403, 'OUTSIDE_ROOTS', 'Path is outside the allowed roots');

  const format = formatOf(archiveAbs);
  if (!format) return fail(res, 400, 'UNSUPPORTED_FORMAT', 'Only .zip, .tar.gz and .tgz archives can be extracted');

  const st = await fsp.stat(archiveAbs).catch(() => null);
  if (!st || !st.isFile()) return fail(res, 404, 'NOT_FOUND', 'Archive does not exist');
  if (st.size === 0) return fail(res, 400, 'EMPTY_ARCHIVE', 'Archive is empty');

  const caps = await detectTools(false);
  const cap = format === FORMAT_ZIP ? caps.can.extractZip : caps.can.extractTarGz;
  if (!cap.ok) {
    return fail(res, 503, 'TOOL_MISSING', `No tool available to extract ${format} archives`, {
      hint: cap.hint,
      tools: caps.tools,
    });
  }
  // 工具路径必须与 via 成对（见 pickTool 注释）；取不到就明确 503
  const tool = pickTool(caps, cap.via);
  if (!tool) {
    return fail(res, 503, 'TOOL_MISSING', `Archive tool for ${cap.via} is not configured`, { hint: cap.hint });
  }

  if (active) return fail(res, 409, 'BUSY', 'Another archive task is running', { task: active.label });

  // 同步占槽：dest 解析与 openStream 之间有 await，若不先占槽，两个并发请求会同时通过上面的检查
  const label = `extract ${path.basename(archiveAbs)}`;
  active = { label, cancel: () => {}, killSync: () => {}, staging: null };
  let destInfo;
  try {
    destInfo = await resolveExtractDest(archiveAbs, body.dest, body.overwrite === true);
  } catch (e) {
    active = null;
    throw e;
  }
  if (destInfo.error) {
    active = null;
    return send(res, destInfo.error.status, destInfo.error);
  }

  const jobId = crypto.randomBytes(4).toString('hex');
  // 不在这里写响应头：runExtract 的 emitter 会在第一帧进度时延迟开流，
  // 这样列条目 / Zip Slip 校验失败仍能返回 400，而不是 200 + error 帧。
  await runExtract(req, res, {
    jobId,
    archiveAbs,
    format,
    destInfo,
    via: cap.via,
    tool,
  });
}

/**
 * 把能力矩阵里的 via 映射成实际要执行的二进制。
 *
 * ⚠️ 必须与 compressCommand / extractCommand 的 via 分支严格成对：
 * 曾经漏掉 'zip' 分支，导致 Linux（有 Info-ZIP、via='zip'）拿到 tar 的路径、
 * 却按 zip 拼出 `-r` 参数，tar 报 `Options '-Aru' are incompatible with '-f -'`。
 * 取不到路径时返回 null，由调用方回 503，绝不把 A 工具的路径配 B 工具的参数。
 */
function pickTool(caps, via) {
  const tool = via === 'unzip' ? caps.tools.unzip : via === 'zip' ? caps.tools.zip : caps.tools.tar;
  if (!tool || !tool.path) return null;
  return { cmd: tool.path, kind: via };
}

/** 解析解压目标：不存在 / 空目录 → staging（原子落位）；非空 → 需 overwrite（direct） */
async function resolveExtractDest(archiveAbs, destRaw, overwrite) {
  const parent = path.dirname(archiveAbs);
  const stem = archiveStem(path.basename(archiveAbs)) || 'Extracted';
  let dest;
  const autoDest = destRaw == null || !String(destRaw).trim();
  if (autoDest) {
    dest = await fsFreeNumbered(parent, stem);
    if (!dest) {
      return { error: { status: 409, code: 'NAME_EXHAUSTED', error: 'Too many items with the same name' } };
    }
  } else {
    dest = fsResolveRaw(destRaw);
    if (!dest || !fsAllowed(dest)) {
      return { error: { status: 403, code: 'OUTSIDE_ROOTS', error: 'Destination is outside the allowed roots' } };
    }
  }
  if (fsIsRoot(dest)) {
    return { error: { status: 400, code: 'DEST_IS_ROOT', error: 'Cannot extract into a root folder' } };
  }

  const st = await fsp.stat(dest).catch(() => null);
  if (!st) return { dest, mode: 'staging', createdDest: true, removeEmpty: false, autoDest };
  if (!st.isDirectory()) {
    return { error: { status: 400, code: 'DEST_NOT_DIR', error: 'Destination exists and is not a folder' } };
  }

  const items = await fsp.readdir(dest).catch(() => null);
  if (!items) {
    return { error: { status: 403, code: 'PERMISSION_DENIED', error: 'Destination is not readable' } };
  }
  if (items.length === 0) return { dest, mode: 'staging', createdDest: true, removeEmpty: true, autoDest };
  if (!overwrite) {
    return { error: { status: 409, code: 'DEST_NOT_EMPTY', error: 'Destination is not empty', dest } };
  }
  return { dest, mode: 'direct', createdDest: false, removeEmpty: false, autoDest };
}

async function runExtract(req, res, ctx) {
  const { archiveAbs, format, destInfo, via, tool } = ctx;
  const em = createEmitter(res);
  const ctl = { child: null, canceled: false };
  const staging = destInfo.mode === 'staging' ? path.join(path.dirname(destInfo.dest), `.wdpart-${ctx.jobId}`) : null;
  const warnings = [];
  const errTail = [];
  let finished = false;
  let aborted = false;

  const onClose = () => {
    if (finished) return;
    aborted = true;
    ctl.canceled = true;
    killTree(ctl.child);
  };
  res.on('close', onClose);

  active = {
    label: `extract ${path.basename(archiveAbs)}`,
    cancel: () => {
      ctl.canceled = true;
      killTree(ctl.child);
    },
    killSync: () => killTreeSync(ctl.child),
    staging,
  };

  const maxTimer = setTimeout(() => {
    ctl.canceled = true;
    killTree(ctl.child);
  }, JOB_MAX_MS);
  if (typeof maxTimer.unref === 'function') maxTimer.unref();

  try {
    // 目标目录：staging 用同父目录临时名，direct 直接建目标
    if (staging) await fsp.mkdir(staging, { recursive: true });
    else await fsp.mkdir(destInfo.dest, { recursive: true });

    // 1) 列条目：拿总数 + Zip Slip 校验。
    //    此时可能还没有开流（先写头会让后面的 400 只能以 error 帧下发），
    //    所以列大归档时用 30s 心跳逼出一次写头，避免反代 idle 超时把请求掐掉。
    const listHeartbeat = setTimeout(() => {
      em.push({ phase: 'listing', processed: 0, total: null, percent: 0, current: '' });
    }, 30000);
    if (typeof listHeartbeat.unref === 'function') listHeartbeat.unref();
    let listed;
    try {
      listed = await listArchive(tool, via, format, archiveAbs, ctl);
    } finally {
      clearTimeout(listHeartbeat);
    }
    if (ctl.canceled) throw canceledError();
    if (listed.spawnError) throw archiveError('TOOL_FAILED', 'Failed to start archive tool', listed.spawnError);
    if (listed.overflow) throw archiveError('ARCHIVE_TOO_LARGE', `Too many entries (limit ${MAX_ENTRIES})`);
    const total = listed.total != null ? listed.total : listed.names ? listed.names.length : null;
    if (listed.names) {
      const bad = findUnsafeEntry(listed.names);
      if (bad) throw archiveError('UNSAFE_ARCHIVE', `Refusing to extract “${bad.name}”`, bad.reason);
    } else if (listed.code !== 0) {
      throw archiveError('TOOL_FAILED', 'Cannot read archive contents', errTail.join('\n') || null);
    } else if (total) {
      warnings.push('Entry names could not be pre-checked; verified the extracted paths instead.');
    }

    // 2) 解压：边跑边计数
    const target = staging || destInfo.dest;
    const { cmd, args } = extractCommand(tool, via, archiveAbs, target);
    em.push({ phase: 'running', processed: 0, total, percent: 0, current: '' });

    let processed = 0;
    let lastPush = 0;
    const onProgress = (count, name) => {
      processed = count;
      const now = Date.now();
      if (now - lastPush < PROGRESS_THROTTLE_MS) return;
      lastPush = now;
      em.push({
        processed: count,
        total,
        percent: total ? Math.min(99, Math.floor((count * 100) / total)) : 0,
        current: name,
      });
    };
    const run = await runStreaming(cmd, args, {}, { ctl, via, onProgress, onErrLine: pushTail(errTail) });
    if (ctl.canceled) throw canceledError();
    if (run.spawnError) {
      console.warn(`[archive] extract (${via}) spawn failed: ${run.spawnError}`);
      throw archiveError('TOOL_FAILED', 'Failed to start archive tool', run.spawnError);
    }
    if (run.code !== 0) {
      console.warn(`[archive] extract (${via}) failed: exit=${run.code} ${errTail.join(' | ')}`);
      throw archiveError(
        mapToolFailure(errTail) || 'TOOL_FAILED',
        `Extraction failed (exit code ${run.code}${run.signal ? `, signal ${run.signal}` : ''})`,
        errTail.join('\n') || null
      );
    }

    // 3) 收尾：staging → dest（原子 rename）
    em.push({ phase: 'finalizing', processed: total || processed, percent: 99, current: '' });
    if (staging) {
      if (destInfo.removeEmpty) await fsp.rmdir(destInfo.dest).catch(() => {});
      // 自动目标（未手填路径）且归档只有一个顶层目录时，把它上提一层：
      // sample.zip 内含 sample/ 时得到 sample/ 而不是 sample/sample/（对齐 macOS 归档工具）。
      // 用户显式指定的目标保持归档原始结构，不做任何重排。
      let src = staging;
      if (destInfo.autoDest) {
        const top = await fsp.readdir(staging, { withFileTypes: true }).catch(() => null);
        if (top && top.length === 1 && top[0].isDirectory()) src = path.join(staging, top[0].name);
      }
      await fsp.rename(src, destInfo.dest);
      if (src !== staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    } else if (!listed.names) {
      const escaped = await verifyContainment(destInfo.dest, 20000);
      if (escaped) warnings.push(`Path escaped the destination folder: ${escaped}`);
    }

    em.done({
      dest: destInfo.dest,
      items: processed,
      createdDest: destInfo.createdDest,
      warnings,
    });
  } catch (e) {
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (aborted || ctl.canceled) {
      /* 客户端已断开：无接收方，清理后静默结束 */
    } else if (em.started) {
      em.fail(toErrorPayload(e));
    } else {
      // 还没开流：按普通 JSON 错误返回，前端统一走 ArchiveError
      const p = toErrorPayload(e);
      send(res, statusOfCode(p.code), { code: p.code, error: p.error, detail: p.detail, hint: p.hint });
    }
  } finally {
    finished = true;
    clearTimeout(maxTimer);
    res.off('close', onClose);
    if (staging) {
      // 成功时 staging 已被 rename 走；失败/取消时这里兜底清残留
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    active = null;
    em.end();
  }
}

/** stderr 只保留尾部若干线，作为失败详情 */
function pushTail(errTail) {
  return (line) => {
    errTail.push(line.slice(0, 300));
    if (errTail.length > 20) errTail.shift();
  };
}

/** 依据工具 stderr 关键字给出更准确的状态码映射 */
function mapToolFailure(errTail) {
  const text = errTail.join('\n').toLowerCase();
  if (!text) return null;
  if (text.includes('no space left')) return 'DISK_FULL';
  if (text.includes('permission denied') || text.includes('operation not permitted')) return 'PERMISSION_DENIED';
  if (text.includes('not a directory') || text.includes('is a directory')) return 'DEST_NOT_DIR';
  return null;
}

/* ---------- 压缩 ---------- */

async function handleCompress(req, res) {
  const body = await readJson(req);
  if (!body) return fail(res, 400, 'INVALID_BODY', 'Invalid request body');

  const format = body.format === FORMAT_TARGZ ? FORMAT_TARGZ : body.format === FORMAT_ZIP ? FORMAT_ZIP : null;
  if (!format) return fail(res, 400, 'UNSUPPORTED_FORMAT', 'Format must be zip or tar.gz');

  const rawPaths = Array.isArray(body.paths) ? body.paths : [];
  if (!rawPaths.length) return fail(res, 400, 'EMPTY_SELECTION', 'No items selected');
  if (rawPaths.length > MAX_SOURCES) return fail(res, 400, 'TOO_MANY_SOURCES', `At most ${MAX_SOURCES} items can be compressed at once`);

  const sources = [];
  const seen = new Set();
  for (const raw of rawPaths) {
    const abs = fsResolveRaw(raw);
    if (!abs || !fsAllowed(abs)) return fail(res, 403, 'OUTSIDE_ROOTS', 'Path is outside the allowed roots');
    if (fsIsRoot(abs)) return fail(res, 400, 'DEST_IS_ROOT', 'Cannot compress a root folder');
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return fail(res, 404, 'NOT_FOUND', `Item does not exist: ${path.basename(abs)}`);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ abs, name: path.basename(abs), isDir: st.isDirectory() });
  }
  if (!sources.length) return fail(res, 400, 'EMPTY_SELECTION', 'No items selected');

  const dirs = new Set(sources.map((s) => path.dirname(s.abs)));
  if (dirs.size > 1) return fail(res, 400, 'MIXED_SOURCES', 'All selected items must be in the same folder');
  const srcDir = path.dirname(sources[0].abs);

  const destDir = body.dest == null || !String(body.dest).trim() ? srcDir : fsResolveRaw(body.dest);
  if (!destDir || !fsAllowed(destDir)) return fail(res, 403, 'OUTSIDE_ROOTS', 'Destination is outside the allowed roots');
  const dst = await fsp.stat(destDir).catch(() => null);
  if (!dst) return fail(res, 404, 'NOT_FOUND', 'Destination folder does not exist');
  if (!dst.isDirectory()) return fail(res, 400, 'DEST_NOT_DIR', 'Destination is not a folder');

  const caps = await detectTools(false);
  const cap = format === FORMAT_ZIP ? caps.can.compressZip : caps.can.compressTarGz;
  if (!cap.ok) {
    return fail(res, 503, 'TOOL_MISSING', `No tool available to create ${format} archives`, {
      hint: cap.hint,
      tools: caps.tools,
    });
  }
  // 工具路径必须与 via 成对（见 pickTool 注释）；取不到就明确 503
  const tool = pickTool(caps, cap.via);
  if (!tool) {
    return fail(res, 503, 'TOOL_MISSING', `Archive tool for ${cap.via} is not configured`, { hint: cap.hint });
  }
  if (active) return fail(res, 409, 'BUSY', 'Another archive task is running', { task: active.label });

  // 同步占槽：产物名去重是异步的，不先占槽会让并发请求同时通过检查
  active = { label: `compress ${sources.length} item(s)`, cancel: () => {}, killSync: () => {}, staging: null };
  let outAbs;
  try {
    const ext = format === FORMAT_ZIP ? '.zip' : '.tar.gz';
    const fallbackName = sources.length === 1 ? archiveStem(sources[0].name) : path.basename(srcDir) || 'Archive';
    const wanted = fsSafeName(body.name || '') || fallbackName;
    const base = (archiveStem(wanted) || fallbackName).slice(0, 120);
    outAbs = await fsFreeNumbered(destDir, base + ext);
  } catch (e) {
    active = null;
    throw e;
  }
  if (!outAbs) {
    active = null;
    return fail(res, 409, 'NAME_EXHAUSTED', 'Too many items with the same name');
  }

  // 产物不能落在被压缩的目录内部（否则会把归档自己打进去）
  for (const s of sources) {
    if (!s.isDir) continue;
    const rel = path.relative(s.abs, outAbs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      active = null;
      return fail(res, 400, 'OUTPUT_INSIDE_SOURCE', 'The archive cannot be created inside a folder being compressed');
    }
  }

  const jobId = crypto.randomBytes(4).toString('hex');
  // 同 extract：延迟开流，统计条目数失败时仍可返回 JSON 错误
  await runCompress(req, res, {
    jobId,
    sources,
    srcDir,
    format,
    outAbs,
    via: cap.via,
    tool,
  });
}

async function runCompress(req, res, ctx) {
  const { sources, srcDir, format, outAbs, via, tool } = ctx;
  const em = createEmitter(res);
  const ctl = { child: null, canceled: false };
  const errTail = [];
  const warnings = [];
  let finished = false;
  let aborted = false;

  const onClose = () => {
    if (finished) return;
    aborted = true;
    ctl.canceled = true;
    killTree(ctl.child);
  };
  res.on('close', onClose);

  active = {
    label: `compress ${path.basename(outAbs)}`,
    cancel: () => {
      ctl.canceled = true;
      killTree(ctl.child);
    },
    killSync: () => killTreeSync(ctl.child),
    staging: null,
  };

  const maxTimer = setTimeout(() => {
    ctl.canceled = true;
    killTree(ctl.child);
  }, JOB_MAX_MS);
  if (typeof maxTimer.unref === 'function') maxTimer.unref();

  try {
    // 1) 统计条目数（给百分比一个分母）
    //    注意：这里**不发帧**（发帧就会写响应头，后面的 ARCHIVE_TOO_LARGE 就只能走 error 帧）。
    //    客户端在提交后立刻进入「Counting…」不确定态，不依赖服务端第一帧。
    let total = null;
    try {
      total = await countSources(sources.map((s) => s.abs));
    } catch (e) {
      if (e && e.archiveCode === 'ARCHIVE_TOO_LARGE') throw e;
      total = null;
    }
    if (ctl.canceled) throw canceledError();

    // 2) 压缩
    const { cmd, args, cwd } = compressCommand(tool, via, outAbs, sources.map((s) => s.name), srcDir, format);
    em.push({ phase: 'running', processed: 0, total, percent: 0, current: '' });

    let processed = 0;
    let lastPush = 0;
    const onProgress = (count, name) => {
      processed = count;
      const now = Date.now();
      if (now - lastPush < PROGRESS_THROTTLE_MS) return;
      lastPush = now;
      em.push({
        processed: count,
        total,
        percent: total ? Math.min(99, Math.floor((count * 100) / total)) : 0,
        current: name,
      });
    };
    // zip 需要 UTF-8 locale 才会给中文名置 UTF-8 标志位；tar / unzip 保持 C locale
    const run = await runStreaming(cmd, args, { cwd, localeC: via !== 'zip' }, { ctl, via, onProgress, onErrLine: pushTail(errTail) });
    if (ctl.canceled) throw canceledError();
    if (run.spawnError) {
      console.warn(`[archive] compress (${via}) spawn failed: ${run.spawnError}`);
      throw archiveError('TOOL_FAILED', 'Failed to start archive tool', run.spawnError);
    }
    if (run.code !== 0) {
      console.warn(`[archive] compress (${via}) failed: exit=${run.code} ${errTail.join(' | ')}`);
      throw archiveError(
        mapToolFailure(errTail) || 'TOOL_FAILED',
        `Compression failed (exit code ${run.code}${run.signal ? `, signal ${run.signal}` : ''})`,
        errTail.join('\n') || null
      );
    }

    em.push({ phase: 'finalizing', processed: total || processed, percent: 99, current: '' });
    const st = await fsp.stat(outAbs).catch(() => null);
    if (!st) throw archiveError('TOOL_FAILED', 'Archive was not created');

    em.done({
      dest: outAbs,
      items: processed,
      bytes: st.size,
      createdDest: true,
      warnings,
    });
  } catch (e) {
    // 失败/取消：删掉半成品归档
    await fsp.unlink(outAbs).catch(() => {});
    if (aborted || ctl.canceled) {
      /* 客户端已断开 */
    } else if (em.started) {
      em.fail(toErrorPayload(e));
    } else {
      const p = toErrorPayload(e);
      send(res, statusOfCode(p.code), { code: p.code, error: p.error, detail: p.detail, hint: p.hint });
    }
  } finally {
    finished = true;
    clearTimeout(maxTimer);
    res.off('close', onClose);
    active = null;
    em.end();
  }
}

/* ---------- 路由 ---------- */

/** 当前正在跑的归档任务（单槽：同一时刻只允许一个，避免多窗口把磁盘打满） */
let active = null;

async function archiveRoute(req, res, p, url) {
  const method = req.method || 'GET';
  try {
    if (p === '/api/fs/archive/caps' && method === 'GET') {
      const caps = await detectTools(url.searchParams.get('refresh') === '1');
      return send(res, 200, caps);
    }
    if (p === '/api/fs/archive/extract' && method === 'POST') return await handleExtract(req, res);
    if (p === '/api/fs/archive/compress' && method === 'POST') return await handleCompress(req, res);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    // 流已经开始：只能结束响应（错误已通过 error 帧下发）
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
      return;
    }
    const code = (e && e.archiveCode) || mapErrno(e) || 'INTERNAL';
    return send(res, statusOfCode(code) || 500, {
      code,
      error: (e && e.message) || String(e),
      detail: (e && e.detail) || null,
    });
  }
}

/** 停止当前任务（systemd stop / Ctrl-C）：返回是否有任务被终止 */
function stopArchiveJob() {
  if (!active) return false;
  try {
    active.cancel();
  } catch {
    /* 忽略 */
  }
  return true;
}

/** 进程退出兜底：同步杀子进程 + 清理 staging 残留 */
function cleanupSync() {
  if (!active) return;
  try {
    active.killSync();
  } catch {
    /* 忽略 */
  }
  if (active.staging) {
    try {
      fs.rmSync(active.staging, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = {
  archiveRoute,
  stopArchiveJob,
  cleanupSync,
  // 仅测试用：pickTool 的 via→二进制映射必须与命令构造严格成对（见 pickTool 注释）
  __test: { pickTool, compressCommand },
};
