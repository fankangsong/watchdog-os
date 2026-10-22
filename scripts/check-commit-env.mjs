#!/usr/bin/env node
/**
 * git 提交检查：防止 .env 中的字段值（密码 / 密钥等）被提交进仓库。
 *
 * 用法：
 *   - 由 .githooks/pre-commit 自动调用（git config core.hooksPath .githooks）
 *   - 也可手动运行：node scripts/check-commit-env.mjs
 *
 * 规则：
 *   1. .env 本身被暂存 → 拦截（.env 在 .gitignore 中，出现即为误操作）
 *   2. 暂存新增行中出现 .env 任一字段的「值」→ 拦截（值只取自 .env）
 *   3. 暂存新增行中出现敏感字段（PASSWORD / *_SECRET / *_KEY / *_TOKEN）的
 *      `KEY=值` 硬编码赋值 → 拦截（可捕获与 .env 当前值不同的新密钥）
 *
 * 字段清单来源：.env.example 的全量 KEY 与 .env 的 KEY 取并集；
 * 检测用的「值」只来自 .env（.env.example 的值均为空或示例默认值，可安全提交）。
 *
 * 例外（不扫描的文件）：
 *   - .env.example / config.example.json：入库的配置模板，允许出现字段名与示例值
 *
 * 值跳过规则（避免误伤）：空值、纯布尔、纯数字、长度 < 4
 *   （普通字段名不做名字匹配：PORT / HOST 等名字在代码与文档中合法出现，
 *    按名匹配会拦掉所有正常开发提交；敏感字段走规则 3 的赋值模式检查）
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(repoRoot, '.env');
const ENV_EXAMPLE_FILE = path.join(repoRoot, '.env.example');

/** 入库的模板文件：字段名出现是预期行为，不扫描 */
const EXCLUDED_FILES = new Set(['.env.example', 'config.example.json']);

/** 敏感字段名模式：额外检查 `KEY=值` 硬编码赋值 */
const SENSITIVE_KEY_RE = /PASSWORD|SECRET|TOKEN|(?:API_)?KEY/i;

/** 在值匹配中不作为泄密检测目标的值模式 */
function isSkippableValue(v) {
  if (!v || v.length < 4) return true;
  if (/^(true|false|yes|no|on|off)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  return false;
}

/** 解析 .env / .env.example，返回 [key, value] 列表（容忍行尾注释与成对引号） */
function parseEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // 文件不存在
  }
  const fields = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉行尾注释（仅对无引号包裹的值，如 COLLECT_INTERVAL=2000  # 注释）
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    // 去掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields.push([key, value]);
  }
  return fields;
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

/** 遮蔽敏感值用于报错展示 */
function mask(value) {
  if (!value) return '(空)';
  if (value.length <= 6) return '*'.repeat(value.length);
  return value.slice(0, 3) + '…' + value.slice(-2);
}

function main() {
  // 字段清单：.env.example 全量 KEY ∪ .env 的 KEY；值只取 .env 的非空值
  const exampleFields = parseEnvFile(ENV_EXAMPLE_FILE) ?? [];
  const envFields = parseEnvFile(ENV_FILE) ?? [];
  const keys = new Set([...exampleFields.map(([k]) => k), ...envFields.map(([k]) => k)]);
  const sensitiveKeys = new Set([...keys].filter((k) => SENSITIVE_KEY_RE.test(k)));
  // 敏感字段即使值看起来“可跳过”（如短密码）也参与值匹配
  const valueFields = envFields.filter(
    ([key, value]) => !isSkippableValue(value) || sensitiveKeys.has(key),
  );

  if (keys.size === 0) process.exit(0);

  // 规则 1：.env 本身被暂存
  let stagedFiles = '';
  try {
    stagedFiles = git(['diff', '--cached', '--name-only']);
  } catch (err) {
    console.error('[pre-commit] 无法读取暂存区（git diff --cached 失败），跳过 .env 检查：', err.message);
    process.exit(0);
  }
  if (stagedFiles.split(/\r?\n/).includes('.env')) {
    console.error('');
    console.error('❌ 提交被拒绝：.env 已被暂存。');
    console.error('   .env 含密码与密钥，禁止入库（.gitignore 已忽略它）。');
    console.error('   执行: git restore --staged .env');
    console.error('');
    process.exit(1);
  }

  // 规则 2 / 3：扫描暂存新增行（模板文件除外）
  const diff = git(['diff', '--cached', '--unified=0']);
  const valueHits = [];
  const assignHits = [];
  let currentFile = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (EXCLUDED_FILES.has(currentFile)) continue; // .env.example / config.example.json 放行
    const added = line.slice(1);
    // 规则 2：包含 .env 中的字段值
    for (const [key, value] of valueFields) {
      if (added.includes(value)) {
        valueHits.push({ file: currentFile, key, value });
      }
    }
    // 规则 3：敏感字段的 `KEY=值` 硬编码赋值（值不必与 .env 相同）
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(added)) continue;
    for (const key of sensitiveKeys) {
      const re = new RegExp(`^\\s*${key}\\s*=\\s*\\S`);
      if (re.test(added)) {
        const v = added.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim();
        assignHits.push({ file: currentFile, key, value: v });
        break;
      }
    }
  }

  if (valueHits.length > 0 || assignHits.length > 0) {
    console.error('');
    console.error('❌ 提交被拒绝：暂存内容中疑似包含 .env 字段值或硬编码密钥');
    console.error('');
    const seen = new Set();
    for (const f of valueHits) {
      const tag = `[值泄露] ${f.file} ← ${f.key}=${mask(f.value)}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      console.error(`   ${tag}`);
    }
    for (const f of assignHits) {
      const tag = `[硬编码] ${f.file} ← ${f.key}=${mask(f.value)}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      console.error(`   ${tag}`);
    }
    console.error('');
    console.error('   请从提交中移除明文值（改用环境变量 / .env 引用），');
    console.error('   或运行 node scripts/check-commit-env.mjs 复查。');
    console.error('');
    process.exit(1);
  }

  process.exit(0);
}

main();
