/**
 * 用户数据文件（~/.watchdog-os/data.json）读写：收藏夹（api/fs.js）与 Editor 视图偏好
 * （api/prefs.js）等多个模块共用的落盘基座。与项目目录解耦：同步脚本 / 重部署不丢用户数据。
 *
 * 文件为通用 JSON 对象，各模块占用各自的顶层键（favorites / editor …）：
 * 任何写入都必须是「保留未知键的合并写」，否则会互相覆盖写丢。
 */
'use strict';

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.watchdog-os');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* 内存缓存：惰性加载一次；saveUserData 写成功后刷新 */
let cache = null;

/* 写串行化：并发 saveUserData 依次执行，避免交叉写 */
let writeChain = Promise.resolve();

/** 读取全部用户数据（惰性加载 + 缓存；文件缺失 / 损坏 / 非纯对象一律回落空对象，不抛错） */
async function loadUserData() {
  if (cache) return cache;
  try {
    const j = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    cache = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * 合并写入：patch 逐键覆盖，其余键（含其它模块的键）原样保留。
 * 每次写前重读磁盘作基座（缓存可能已被外部编辑 / 其它进程改写而过期），
 * 经「临时文件 + rename」原子替换后刷新缓存；并发调用按调用顺序串行执行。
 */
function saveUserData(patch) {
  const run = writeChain.then(async () => {
    let base = {};
    try {
      const j = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) base = j;
    } catch {
      /* 文件缺失 / 损坏：以空对象为基座 */
    }
    const data = Object.assign({}, base, patch);
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, DATA_FILE);
    cache = data;
    return data;
  });
  // 串行链继续向下传递；单次写失败不影响后续写（失败由调用方的 promise 感知）
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

module.exports = { DATA_DIR, DATA_FILE, loadUserData, saveUserData };
