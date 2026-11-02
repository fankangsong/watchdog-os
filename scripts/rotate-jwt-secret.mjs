#!/usr/bin/env node
/**
 * 生成新的 JWT_SECRET 并写回 .env（密钥轮换）。
 *
 * 用法：
 *   node scripts/rotate-jwt-secret.mjs              # 生成并写入 .env
 *   node scripts/rotate-jwt-secret.mjs --dry-run    # 只生成并展示，不改文件
 *   npm run secret:rotate
 *
 * 行为：
 *   1. 生成 crypto.randomBytes(32) 的 hex 串（64 字符 = 32 字节），满足
 *      server/config.js 对 JWT_SECRET「≥32 字节」的启动校验；
 *   2. .env 存在 → 就地替换所有 JWT_SECRET 行的值，保留键名、缩进、引号风格、
 *      行尾注释与文件换行风格（CRLF / LF）；
 *      .env 不存在 → 以 .env.example 为模板创建（权限 600）；
 *      没有 JWT_SECRET 行 → 追加到文件末尾；
 *   3. 先写同目录临时文件再 rename，避免写到一半留下损坏的 .env。
 *
 * 注意：
 *   - 轮换密钥会让所有已签发的会话令牌立即失效（用户需重新登录），不影响 PASSWORD；
 *   - 生效需要重启服务（systemd: ./run.sh restart）；
 *   - 脚本不打印完整密钥，避免终端日志 / 截图泄露。
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(repoRoot, '.env');
const ENV_EXAMPLE_FILE = path.join(repoRoot, '.env.example');

const KEY = 'JWT_SECRET';
/** 与 server/config.js 的下限一致（32 字节），hex 编码后为 64 字符 */
const SECRET_BYTES = 32;

const USAGE = `用法：node scripts/rotate-jwt-secret.mjs [--dry-run]

  --dry-run   只生成并校验新密钥，不写文件
  -h, --help  显示本帮助

生成 ${SECRET_BYTES} 字节随机密钥（hex，${SECRET_BYTES * 2} 字符），写入项目根目录 .env 的 ${KEY} 字段。
.env 不存在时以 .env.example 为模板创建（权限 600）。`;

/** 解析字段值：去掉成对引号与行尾注释（仅识别无引号值中的 ' #'） */
function parseValue(raw) {
  let value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const hash = value.indexOf(' #');
  if (hash !== -1) value = value.slice(0, hash);
  return value.trim();
}

/** 拆出行内值的引号风格与行尾注释，供写回时原样保留 */
function analyzeValue(raw) {
  const value = raw.trimStart();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    return { quote, comment: end === -1 ? '' : value.slice(end + 1) };
  }
  const hash = value.indexOf(' #');
  return { quote: '', comment: hash === -1 ? '' : value.slice(hash) };
}

function mask(value) {
  if (!value) return '(未配置)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 原子写入 .env；失败时退化为直接覆盖，绝不先删原文件 */
function writeEnv(content) {
  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  let mode = 0o600;
  if (existsSync(ENV_FILE)) {
    try {
      mode = statSync(ENV_FILE).mode & 0o777;
    } catch {
      // 读不到权限就沿用 600
    }
  }
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows 上 chmod 近似无效，忽略
    }
    try {
      renameSync(tmp, ENV_FILE);
    } catch {
      // Windows 上目标被占用时 rename 可能 EPERM：直接覆盖写（非原子但不会丢文件）
      writeFileSync(ENV_FILE, content, { encoding: 'utf8' });
      try {
        unlinkSync(tmp);
      } catch {
        // 残留临时文件不影响正确性
      }
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能不存在
    }
    console.error(`❌ 写入 ${ENV_FILE} 失败：${err.message}`);
    process.exit(1);
  }
}

function warnMissingPassword(text) {
  const m = /^\s*PASSWORD\s*=(.*)$/m.exec(text);
  if (!m || !parseValue(m[1])) {
    console.error('⚠️  PASSWORD 仍为空，服务会拒绝启动：请在 .env 中设置访问密码。');
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`❌ 未知参数：${unknown.join(' ')}`);
    console.error(USAGE);
    process.exit(2);
  }

  const secret = randomBytes(SECRET_BYTES).toString('hex');

  const fromTemplate = !existsSync(ENV_FILE);
  let text = '';
  if (fromTemplate) {
    if (existsSync(ENV_EXAMPLE_FILE)) text = readFileSync(ENV_EXAMPLE_FILE, 'utf8');
  } else {
    text = readFileSync(ENV_FILE, 'utf8');
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lineRe = new RegExp(`^(\\s*(?:export\\s+)?${KEY}\\s*=)([^\\r\\n]*)(\\r?)$`, 'gm');
  let oldValue = '';
  let replaced = 0;
  let out = text.replace(lineRe, (_line, prefix, rest, cr) => {
    const lead = (rest.match(/^\s*/) ?? [''])[0];
    const { quote, comment } = analyzeValue(rest);
    if (!oldValue) oldValue = parseValue(rest);
    replaced += 1;
    return `${prefix}${lead}${quote}${secret}${quote}${comment}${cr}`;
  });

  if (replaced === 0) {
    if (out.length > 0 && !/\r?\n$/.test(out)) out += eol;
    if (out.length > 0) out += eol;
    out += `# 由 scripts/rotate-jwt-secret.mjs 生成${eol}${KEY}=${secret}${eol}`;
  }

  console.log('');
  console.log(`🔑 新 ${KEY}：${mask(secret)}（${SECRET_BYTES} 字节，hex ${secret.length} 字符）`);
  console.log(`   原值：${mask(oldValue)}`);
  console.log(`   目标：${ENV_FILE}${fromTemplate ? '（自 .env.example 新建）' : ''}`);
  console.log(`   动作：${replaced > 0 ? `替换 ${replaced} 处` : '追加新行'}`);

  if (dryRun) {
    console.log('   --dry-run：未写入文件');
    return;
  }

  writeEnv(out);
  console.log('✅ 已写入。');
  console.log('   轮换密钥会让所有已签发的令牌失效（用户需重新登录），重启服务后生效。');
  warnMissingPassword(out);
}

main();
