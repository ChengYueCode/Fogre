// Shared on-disk coordination boundary for every public archive writer: the
// CLI (review/evidence/import/restore), `build`, and the HTTP save endpoint all
// run their read→apply→write cycle inside one archive lock, and the first
// upgraded write of a version-1 archive keeps a verbatim recoverable copy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { EmberError, CODES, isRecord } from './errors.mjs';
import { atomicWrite, fileExists, nowIso, parseJson, stableStringify } from './io.mjs';
import { normalizeState } from './state.mjs';

export const ARCHIVE_LOCK_NAME = '.ember-lock';
export const RECOVERY_GATE_NAME = '.ember-lock.recovery';
export const V1_BACKUP_NAME = 'state.v1.backup.json';

const LOCK_RETRY_MS = 50;
// The wait and staleness bounds can be tightened through environment variables
// so recovery and conflict paths are observable in tests without 10s waits.
const LOCK_TIMEOUT_MS = positiveIntEnv('EMBER_LOCK_TIMEOUT_MS', 10000);
// Only a verifiably dead local owner may be reclaimed. Age alone never
// establishes that a writer has crashed; unknown and live owners stay protected.
const LOCK_STALE_MS = positiveIntEnv('EMBER_LOCK_STALE_MS', 30000);
const LINK_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'EMLINK']);

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function staleMs() { return positiveIntEnv('EMBER_LOCK_STALE_MS', LOCK_STALE_MS); }

function readLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const text = fs.readFileSync(lockPath, 'utf8');
    return { stat, text, owner: JSON.parse(text) };
  } catch { return null; }
}

function sameLock(lockPath, snapshot) {
  const current = readLock(lockPath);
  return current && current.text === snapshot.text &&
    current.stat.dev === snapshot.stat.dev && current.stat.ino === snapshot.stat.ino &&
    current.stat.birthtimeMs === snapshot.stat.birthtimeMs;
}

function ownerIsDead(owner) {
  if (!isRecord(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (owner.host !== undefined && owner.host !== os.hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (err) { return err.code === 'ESRCH'; }
}

// Atomically publish `content` at `filePath`. The temp file is fully written
// first and the hard link either creates the final name or fails EEXIST, so a
// competing process never observes a half-written lock. Filesystems without
// hard links fall back to an exclusive create plus write.
function publishExclusiveFile(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, filePath);
    return;
  } catch (err) {
    if (err.code === 'EEXIST' || !LINK_FALLBACK_CODES.has(err.code)) throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already removed */ }
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx');
    fs.writeSync(fd, content);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    throw err;
  }
  try { fs.closeSync(fd); } catch { /* ignore */ }
}

// Exclusive sidecar that serializes the main-lock check→unlink→reacquire
// boundary of crash recovery. It is strictly fail-closed: an existing gate is
// never auto-reclaimed, not even when its recorded owner looks dead, because
// ownership cannot be verified atomically before a pathname delete (a rename is
// not conditional on the observed identity). An orphaned gate therefore yields a
// bounded, actionable conflict that requires deliberate manual recovery rather
// than an unsafe takeover.
async function acquireRecoveryGate(dir, deadline) {
  const gatePath = path.join(dir, RECOVERY_GATE_NAME);
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: nowIso() });
  for (;;) {
    try {
      publishExclusiveFile(gatePath, content);
      return { gatePath, token };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new EmberError(CODES.IO, `无法创建档案恢复锁 ${gatePath}：${err.message}`);
      }
      if (Date.now() >= deadline) {
        const snapshot = readLock(gatePath);
        const owner = snapshot && snapshot.owner
          ? `（记录拥有者 pid ${snapshot.owner.pid}，主机 ${snapshot.owner.host ?? '未知'}）`
          : '（内容不可读）';
        throw new EmberError(CODES.CONFLICT,
          `学习档案的崩溃恢复锁 ${gatePath} 仍存在，无法安全自动接管${owner}。` +
          '请确认没有进程正在写入档案后，手动删除该恢复锁文件并重试；本次未对档案做任何修改');
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseRecoveryGate(gate) {
  if (!gate) return;
  const snapshot = readLock(gate.gatePath);
  if (snapshot && snapshot.owner && snapshot.owner.token === gate.token) {
    try { fs.unlinkSync(gate.gatePath); } catch { /* disappeared */ }
  }
}

/**
 * One lock protocol for CLI, build and HTTP. Callers include both the content
 * directory and the archive directory: external state files share their lock,
 * while multiple state files for the same generated content also serialize.
 * realpath and sorted acquisition coordinate directory aliases without deadlock.
 * Crash recovery is serialized by an exclusive fail-closed sidecar gate.
 */
export async function withArchiveLock(dirs, task) {
  const roots = [...new Map((Array.isArray(dirs) ? dirs : [dirs]).map((dir) => {
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    const canonical = fs.realpathSync(root);
    return [process.platform === 'win32' ? canonical.toLowerCase() : canonical, canonical];
  })).values()].sort();
  const deadline = Date.now() + positiveIntEnv('EMBER_LOCK_TIMEOUT_MS', LOCK_TIMEOUT_MS);
  async function acquire(index) {
    if (index === roots.length) return task();
    const dir = roots[index];
    const lockPath = path.join(dir, ARCHIVE_LOCK_NAME);
    const token = randomUUID();
    let fd = null;
    let owned = null;
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: nowIso() }));
        owned = readLock(lockPath);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          if (fd !== null) fs.closeSync(fd);
          throw new EmberError(CODES.IO, `无法创建档案写入锁 ${lockPath}：${err.message}`);
        }
        const snapshot = readLock(lockPath);
        if (snapshot && Date.now() - snapshot.stat.mtimeMs > staleMs() && ownerIsDead(snapshot.owner)) {
          // Serialize recovery under the fail-closed gate and keep it through the
          // removal and the attempt to acquire the main lock, so a second
          // recoverer can never unlink a successor's freshly created live lock.
          const gate = await acquireRecoveryGate(dir, deadline);
          let acquired = false;
          try {
            const current = readLock(lockPath);
            if (current && Date.now() - current.stat.mtimeMs > staleMs() && ownerIsDead(current.owner)) {
              try { fs.unlinkSync(lockPath); } catch { /* another removed it */ }
            }
            try {
              fd = fs.openSync(lockPath, 'wx');
              fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: nowIso() }));
              owned = readLock(lockPath);
              acquired = true;
            } catch (createErr) {
              if (createErr.code !== 'EEXIST') { if (fd !== null) fs.closeSync(fd); throw createErr; }
            }
          } finally {
            releaseRecoveryGate(gate);
          }
          if (acquired) break;
          continue;
        }
        if (Date.now() >= deadline) {
          throw new EmberError(CODES.CONFLICT,
            `学习档案正被其他进程写入（${lockPath} 被占用）。请稍后重试；本次未对档案做任何修改`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await acquire(index + 1);
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      // A replaced lock belongs to its successor, even if this task once owned
      // this pathname. Never clean up another writer's token or file identity.
      if (owned && owned.owner.token === token && sameLock(lockPath, owned)) {
        try { fs.unlinkSync(lockPath); } catch { /* disappeared */ }
      }
    }
  }
  return acquire(0);
}

export function archivePathFor(filePath) {
  const resolved = path.resolve(filePath);
  try { return fs.realpathSync(resolved); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); }
    catch { return resolved; }
  }
}

export function archiveLockDirs(outDir, statePath, modelPath) {
  const dirs = [outDir, path.dirname(statePath)];
  // Existing file symlinks may name an archive/model in another directory.
  for (const file of [statePath, modelPath]) {
    if (!file) continue;
    dirs.push(path.dirname(file));
    try { dirs.push(path.dirname(fs.realpathSync(file))); } catch { /* not created yet */ }
  }
  return dirs;
}

/**
 * Read the durable archive for a write cycle. Returns the migrated in-memory
 * state plus the exact bytes found on disk, so the write step can keep a
 * verbatim backup before the first upgraded write.
 */
export function readArchive(statePath, model) {
  if (!fileExists(statePath)) {
    return { exists: false, wasV1: false, rawText: null, state: null };
  }
  const rawText = fs.readFileSync(statePath, 'utf8');
  const raw = parseJson(rawText, `状态文件 ${statePath}`);
  const state = normalizeState(raw, model);
  return { exists: true, wasV1: raw.schemaVersion === 1, rawText, state };
}

/**
 * Persist the archive. When the file on disk was a version-1 archive, a
 * verbatim copy is kept next to it (only ever created, never overwritten) so
 * the pre-upgrade archive stays recoverable. The write itself is atomic: a
 * failure leaves the previous archive untouched.
 */
export function writeArchiveState(statePath, state, { wasV1 = false, rawText = null } = {}) {
  if (wasV1 && typeof rawText === 'string') {
    const backupPath = path.join(path.dirname(statePath), V1_BACKUP_NAME);
    if (!fileExists(backupPath)) atomicWrite(backupPath, rawText);
  }
  atomicWrite(statePath, stableStringify(state));
}

/**
 * Restore the recoverable pre-upgrade copy over the current archive, after
 * verifying it really is a readable old archive of the same model. The restored
 * file is byte-identical to the backup, so the verification result and the
 * on-disk archive can be compared by any auditor.
 */
export function restoreArchiveBackup({ statePath, model, backupPath }) {
  const resolved = backupPath ?? path.join(path.dirname(statePath), V1_BACKUP_NAME);
  if (!fileExists(resolved)) {
    throw new EmberError(CODES.IO, `没有找到可恢复的旧档副本 ${resolved}；只有升级前才会创建该副本`);
  }
  const rawText = fs.readFileSync(resolved, 'utf8');
  const raw = parseJson(rawText, `旧档副本 ${resolved}`);
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new EmberError(CODES.STATE, `副本 ${resolved} 不是版本 1 的旧档，拒绝恢复`);
  }
  // The old tool always wrote these buckets; a backup missing them was never a
  // readable archive and must not replace a working one.
  if (!isRecord(raw.attempts) || !isRecord(raw.schedules)) {
    throw new EmberError(CODES.STATE, `副本 ${resolved} 缺少旧档必备的 attempts/schedules 记录，拒绝恢复`, 'attempts');
  }
  if (raw.modelId !== model.id) {
    throw new EmberError(CODES.IDENTITY, `副本属于模型 ${raw.modelId}，当前模型是 ${model.id}，拒绝恢复`);
  }
  // Full shape validation through the same path every reader uses; a broken
  // backup must fail here instead of replacing a working archive.
  const verified = normalizeState(raw, model);
  // Keep the damaged current bytes before they are replaced: recovery must be
  // possible when the live archive is truncated or otherwise unreadable, and
  // the quarantined copy must never collide with the original v1 backup.
  let quarantined = null;
  if (fileExists(statePath)) {
    const currentText = fs.readFileSync(statePath, 'utf8');
    if (currentText !== rawText && !isReadableArchiveText(currentText, model)) {
      const stamp = nowIso().replace(/[:.]/g, '-');
      const quarantinePath = path.join(path.dirname(statePath), `state.corrupt.${stamp}.json`);
      atomicWrite(quarantinePath, currentText);
      quarantined = quarantinePath;
    }
  }
  atomicWrite(statePath, rawText);
  const attempts = Object.values(verified.attempts ?? {}).reduce((sum, list) => sum + list.length, 0);
  return {
    restored: true,
    backup: resolved,
    statePath,
    quarantined,
    schemaVersion: raw.schemaVersion,
    modelId: raw.modelId,
    revision: verified.revision,
    attempts,
    schedules: Object.keys(verified.schedules ?? {}).length,
    restoredAt: nowIso(),
  };
}

function isReadableArchiveText(text, model) {
  try {
    normalizeState(parseJson(text, '状态文件'), model);
    return true;
  } catch { return false; }
}
