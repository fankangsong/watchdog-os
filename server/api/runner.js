/**
 * 脚本任务引擎（RunnerApp / BlogApp 共用数据源）：远程触发脚本任务（单槽锁）
 * + 日志落盘/轮转/回读。通过 createScriptRunner 工厂实例化，每个实例独立
 * 的进程槽与日志文件；脚本路径只来自服务端配置，客户端不可传路径。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/** 生成 job id：YYYYMMDD-HHmmss-xxxx（本地时间 + 4 位随机 hex） */
function newJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = crypto.randomBytes(2).toString('hex');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`
  );
}

/** 展开 config 里的 ~ 前缀（如 BLOG_SCRIPT 默认值 ~/workspace/...） */
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 创建一个脚本任务引擎实例。
 * @param {object} opts
 * @param {string} opts.name   实例名（日志标签，如 'runner' / 'blog'）
 * @param {string} opts.logFile 日志文件绝对路径（轮转时追加 .old 后缀）
 * @param {() => {enabled: boolean, scriptPath: string, shell: string, maxLogBytes: number}} opts.getConfig
 *   每次操作时实时取配置（便于测试注入与运行期改 .env 后重启生效前的读法一致）
 */
function createScriptRunner({ name, logFile, getConfig }) {
  const LOG_OLD = logFile + '.old';
  let proc = null;  // 当前脚本子进程；null 表示空闲
  let job = null;   // 当前 job 元信息 { id, startedAt, script }
  let last = null;  // 最近一次结束的 job 摘要 { id, startedAt, finishedAt, exitCode, failed, durationMs }

  /**
   * 启动脚本任务。返回 { job } 或 { error, ... }；错误码由路由映射：
   * 'Job already running'→409、'Script not found'→400、其余→500（'disabled' 已由路由先行拦截，此处为防御）
   */
  function startJob() {
    const r = getConfig();
    if (proc) return { error: 'Job already running', job };
    if (!r.enabled || !r.scriptPath) return { error: `${name} disabled` };
    const scriptAbs = path.resolve(expandTilde(r.scriptPath));
    let st = null;
    try {
      st = fs.statSync(scriptAbs);
    } catch { /* 不存在 → 下方 400 */ }
    if (!st || !st.isFile()) return { error: 'Script not found' };

    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* 已存在忽略 */ }
    // 日志轮转：上次日志超阈值则归档为 .old（构建日志量大，防止单文件无限增长）
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > r.maxLogBytes) {
        fs.renameSync(logFile, LOG_OLD);
      }
    } catch { /* 轮转失败不阻塞构建 */ }

    const cur = { id: newJobId(), startedAt: Date.now(), script: scriptAbs };
    try {
      fs.appendFileSync(logFile, `\n===== [${new Date(cur.startedAt).toISOString()}] job ${cur.id}\n===== $ ${r.shell} ${scriptAbs}\n`, 'utf8');
    } catch { /* 日志失败不阻塞构建 */ }

    let p;
    try {
      // 用相对文件名 + cwd 定位脚本：Windows 下 Git Bash 不识别 C:\ 绝对路径（exit 127），
      // Linux 绝对路径虽可用，但相对名 + cwd 在两平台行为一致；build.sh 类脚本用 BASH_SOURCE 自定位目录，不受影响
      p = spawn(r.shell, [path.basename(scriptAbs)], {
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
      try { fs.appendFileSync(logFile, `[spawn error] ${e.message}\n`, 'utf8'); } catch { /* 忽略 */ }
      return { error: 'Spawn failed', detail: e.message };
    }
    proc = p;
    job = cur;
    const append = (c) => {
      try { fs.appendFileSync(logFile, c, 'utf8'); } catch { /* 磁盘异常丢日志不崩服务 */ }
    };
    p.stdout.on('data', append);
    p.stderr.on('data', append);
    p.on('error', (e) => append(`[spawn error] ${e.message}\n`));
    p.on('exit', (code, signal) => {
      append(`[exit code ${code === null ? `null(${signal})` : code}]\n`);
      if (proc !== p) return;
      const finishedAt = Date.now();
      last = {
        id: cur.id,
        startedAt: cur.startedAt,
        finishedAt,
        exitCode: code,
        failed: code !== 0,
        durationMs: finishedAt - cur.startedAt,
      };
      proc = null;
      job = null;
    });
    console.log(`[sysprobe] ${name} 已启动: job=${cur.id} script=${scriptAbs}`);
    return { job: cur };
  }

  /** 停止当前任务（SIGTERM）；有任务返回 true */
  function stopJob() {
    if (proc) {
      proc.kill('SIGTERM');
      return true;
    }
    return false;
  }

  /** 读日志尾部 lines 行（文件受 maxLogBytes 轮转约束，整体读入取尾即可） */
  function readLog(lines) {
    try {
      const arr = fs.readFileSync(logFile, 'utf8').split('\n');
      // 文件以换行结尾时 split 会多出一个尾部空串，先去掉再取尾，保证 lines=1 能取到最后一行内容
      if (arr.length && arr[arr.length - 1] === '') arr.pop();
      return arr.slice(Math.max(0, arr.length - lines)).join('\n');
    } catch {
      return '';
    }
  }

  /** 组装 status 响应体（lines 已由路由裁剪） */
  function statusPayload(lines) {
    const r = getConfig();
    return {
      enabled: !!(r.enabled && r.scriptPath),
      script: r.scriptPath || '',
      running: !!proc,
      job: job ? { ...job, exitCode: null, finishedAt: null } : null,
      last,
      log: readLog(lines),
    };
  }

  return { startJob, stopJob, currentJob: () => job, statusPayload };
}

/* Runner 默认实例（running_page build.sh；日志 data/runner.log） */
const { cfg } = require('../config');
const runner = createScriptRunner({
  name: 'runner',
  logFile: path.join(__dirname, '..', '..', 'data', 'runner.log'),
  getConfig: () => cfg.runner,
});

module.exports = {
  createScriptRunner,
  startRunnerJob: runner.startJob,
  stopRunnerJob: runner.stopJob,
  currentJob: runner.currentJob,
  runnerStatusPayload: runner.statusPayload,
};
