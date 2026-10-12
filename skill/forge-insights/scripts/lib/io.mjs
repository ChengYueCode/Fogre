import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EmberError, CODES } from './errors.mjs';
import { assertLearningOutput } from './output-paths.mjs';

export function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new EmberError(CODES.IO, `无法读取文件 ${filePath}：${err.message}`);
  }
  return parseJson(raw, filePath);
}

export function parseJson(raw, label = 'JSON') {
  // Editors on Windows frequently prepend a UTF-8 BOM; JSON.parse rejects it,
  // so strip it (and only it) before parsing.
  const text = typeof raw === 'string' && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new EmberError(CODES.IO, `${label} 不是合法 JSON：${err.message}`);
  }
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2) + '\n';
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortHash(text, length = 12) {
  return sha256(text).slice(0, length);
}

// Write via a temp file + atomic rename so readers never see partial JSON.
export function atomicWrite(filePath, content) {
  assertLearningOutput(filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new EmberError(CODES.IO, `写入 ${filePath} 失败：${err.message}`);
  }
}

// Returns true when the file was actually rewritten.
export function writeIfChanged(filePath, content) {
  try {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === content) return false;
  } catch { /* missing file: write below */ }
  atomicWrite(filePath, content);
  return true;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function addDaysIso(iso, days) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new EmberError(CODES.USAGE, `时间格式不合法：${iso}`);
  return new Date(date.getTime() + days * 86400000).toISOString();
}
