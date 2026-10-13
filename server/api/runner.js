/**
 * Runner 模块（RunnerApp 数据源）：远程触发脚本任务（单槽锁）+ 日志落盘/轮转/回读。
 * 从 server.js 原样搬移（原 744-875 行），函数体不变。
 * 脚本路径只来自服务端 config.json / RUNNER_SCRIPT，客户端不可传路径。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { cfg } = require('../config');

const RUNNER_LOG_DIR = path.join(__dirname, '..', '..', 'data');
const RUNNER_LOG_FILE = path.join(RUNNER_LOG_DIR, 'runner.log');
const RUNNER_LOG_OLD = RUNNER_LOG_FILE + '.old';
let runnerProc = null;  // 当前脚本子进程；null 表示空闲
let runnerJob = null;   // 当前 job 元信息 { id, startedAt, script }
let runnerLast = null;  // 最近一次结束的 job 摘要 { id, startedAt, finishedAt, exitCode, failed, durationMs }

/** 生成 job id：YYYYMMDD-HHmmss-xxxx（本地时间 + 4 位随机 hex） */
function runnerNewJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = crypto.randomBytes(2).toString('hex');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`
  );
}

/**
 * 启动脚本任务。返回 { job } 或 { error, ... }；错误码由路由映射：
 * 'Job already running'→409、'Script not found'→400、其余→500（'Runner disabled' 已由路由先行拦截，此处为防御）
 */
function startRunnerJob() {
  const r = cfg.runner;
  if (runnerProc) return { error: 'Job already running', job: runnerJob };
  if (!r.enabled || !r.scriptPath) return { error: 'Runner disabled' };
  const scriptAbs = path.resolve(r.scriptPath);
  let st = null;
  try {
    st = fs.statSync(scriptAbs);
  } catch { /* 不存在 → 下方 400 */ }
  if (!st || !st.isFile()) return { error: 'Script not found' };

  try { fs.mkdirSync(RUNNER_LOG_DIR, { recursive: true }); } catch { /* 已存在忽略 */ }
  // 日志轮转：上次日志超阈值则归档为 .old（构建日志量大，防止单文件无限增长）
  try {
    if (fs.existsSync(RUNNER_LOG_FILE) && fs.statSync(RUNNER_LOG_FILE).size > r.maxLogBytes) {
      fs.renameSync(RUNNER_LOG_FILE, RUNNER_LOG_OLD);
    }
  } catch { /* 轮转失败不阻塞构建 */ }

  const job = { id: runnerNewJobId(), startedAt: Date.now(), script: scriptAbs };
  try {
    fs.appendFileSync(RUNNER_LOG_FILE, `\n===== [${new Date(job.startedAt).toISOString()}] job ${job.id}\n===== $ ${r.shell} ${scriptAbs}\n`, 'utf8');
  } catch { /* 日志失败不阻塞构建 */ }

  let proc;
  try {
    // 用相对文件名 + cwd 定位脚本：Windows 下 Git Bash 不识别 C:\ 绝对路径（exit 127），
    // Linux 绝对路径虽可用，但相对名 + cwd 在两平台行为一致；build.sh 类脚本用 BASH_SOURCE 自定位目录，不受影响
    proc = spawn(r.shell, [path.basename(scriptAbs)], {
      cwd: path.dirname(scriptAbs),
      // 注入 git safe.directory：服务用户（如 systemd root）与仓库属主不一致时，
      // git 会报 "detected dubious ownership in repository" 而失败。
      // 用 GIT_CONFIG_* 环境变量注入，不依赖运行用户的 HOME/全局 gitconfig；
      // 脚本路径只来自服务端配置，放开所有权检查不扩大攻击面。
      env: {
        ...process.env,
        // systemd 服务环境默认无 HOME，git 等工具会因此读不到 ~/.gitconfig
        // （报 "unable to auto-detect email address"）；无 HOME 时从 passwd 兜底解析
        HOME: process.env.HOME || os.homedir(),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    try { fs.appendFileSync(RUNNER_LOG_FILE, `[spawn error] ${e.message}\n`, 'utf8'); } catch { /* 忽略 */ }
    return { error: 'Spawn failed', detail: e.message };
  }
  runnerProc = proc;
  runnerJob = job;
  const append = (c) => {
    try { fs.appendFileSync(RUNNER_LOG_FILE, c, 'utf8'); } catch { /* 磁盘异常丢日志不崩服务 */ }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);
  proc.on('error', (e) => append(`[spawn error] ${e.message}\n`));
  proc.on('exit', (code, signal) => {
    append(`[exit code ${code === null ? `null(${signal})` : code}]\n`);
    if (runnerProc !== proc) return;
    const finishedAt = Date.now();
    runnerLast = {
      id: job.id,
      startedAt: job.startedAt,
      finishedAt,
      exitCode: code,
      failed: code !== 0,
      durationMs: finishedAt - job.startedAt,
    };
    runnerProc = null;
    runnerJob = null;
  });
  console.log(`[sysprobe] runner 已启动: job=${job.id} script=${scriptAbs}`);
  return { job };
}

/** 停止当前任务（SIGTERM）；有任务返回 true */
function stopRunnerJob() {
  if (runnerProc) {
    runnerProc.kill('SIGTERM');
    return true;
  }
  return false;
}

/** 当前 job 元信息（stop 接口回包需要） */
function currentJob() {
  return runnerJob;
}

/** 读日志尾部 lines 行（文件受 maxLogBytes 轮转约束，整体读入取尾即可） */
function runnerReadLog(lines) {
  try {
    const arr = fs.readFileSync(RUNNER_LOG_FILE, 'utf8').split('\n');
    // 文件以换行结尾时 split 会多出一个尾部空串，先去掉再取尾，保证 lines=1 能取到最后一行内容
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch {
    return '';
  }
}

/** 组装 status 响应体（lines 已由路由裁剪） */
function runnerStatusPayload(lines) {
  return {
    enabled: !!(cfg.runner.enabled && cfg.runner.scriptPath),
    script: cfg.runner.scriptPath || '',
    running: !!runnerProc,
    job: runnerJob ? { ...runnerJob, exitCode: null, finishedAt: null } : null,
    last: runnerLast,
    log: runnerReadLog(lines),
  };
}

module.exports = { startRunnerJob, stopRunnerJob, currentJob, runnerStatusPayload };
