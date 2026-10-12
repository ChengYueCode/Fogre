// Ticket 01 acceptance: safe migration of version-1 archives, recoverable
// pre-upgrade backups, the shared write-coordination boundary between CLI,
// build and HTTP saves, and stale-content/orphan semantics after migration.
// Everything runs through public commands, on-disk state and real server
// restarts; all learner records live in isolated temporary directories.
//
// Run: node --test tests/migration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyAttempt,
  applyNote,
  applyOwnQuestion,
  applyTitleRevision,
  applyTutorEvidence,
  createState,
  promptFingerprint,
} from '../skill/forge/scripts/lib/state.mjs';
import { archiveLockDirs, withArchiveLock } from '../skill/forge/scripts/lib/archive.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const BACKUP_NAME = 'state.v1.backup.json';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-mig-'));
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'mig-model',
    title: '迁移主题',
    goal: '能解释并应用核心机制',
    concepts: [
      { id: 'root', title: '根概念', parentId: null, difficulty: 1, explanation: '根解释', example: '根例子' },
      { id: 'child', title: '子概念', parentId: 'root', difficulty: 2, explanation: '子解释' },
    ],
    relations: [
      { id: 'rel-root-child', from: 'root', to: 'child', type: 'prerequisite', label: '先根后子' },
    ],
    prompts: [
      { id: 'p-explain', conceptId: 'child', kind: 'explain', question: '请解释子概念', answer: '参考答案', criteria: ['说到要点'] },
      { id: 'p-apply', conceptId: 'child', kind: 'apply', question: '换一个情境应用', answer: '参考应用', criteria: ['步骤正确'] },
    ],
    ...overrides,
  };
}

/**
 * Build a faithful version-1 archive exactly as the previous forge version
 * wrote it: same fields, same shape, schemaVersion 1, no migration envelope.
 * The learner history is produced through the real core helpers so times,
 * fingerprints, evidence links and schedules are internally consistent.
 */
function v1Archive(model, options = {}) {
  let state = createState(model, '2026-09-01T08:00:00.000Z');
  state = applyAttempt(state, model, {
    promptId: 'p-explain', attemptId: 'att-old-1',
    answer: '旧档里的独立解释', rating: 'good', assisted: false, source: 'cli',
  }, '2026-09-02T08:00:00.000Z').state;
  state = applyTutorEvidence(state, model, {
    promptId: 'p-explain', status: 'explained',
    note: '用学习者原话核对，解释完整', attemptIds: ['att-old-1'],
  }, '2026-09-02T09:00:00.000Z').state;
  state = applyNote(state, model, { conceptId: 'child', kind: 'explanation', text: '旧档里的笔记', author: 'learner' }, '2026-09-02T10:00:00.000Z').state;
  state = applyOwnQuestion(state, model, { conceptId: 'child', text: '自创问题：什么时候失效？', id: 'q-own-1' }, '2026-09-02T11:00:00.000Z').state;
  state = applyTitleRevision(state, model, { conceptId: 'child', title: '子概念（学习者修订）' }, '2026-09-02T12:00:00.000Z').state;
  if (options.withApplyAttempt) {
    state = applyAttempt(state, model, {
      promptId: 'p-apply', attemptId: 'att-old-2',
      answer: '旧档里的应用作答', rating: 'hard', assisted: true, source: 'browser',
    }, '2026-09-03T08:00:00.000Z').state;
  }
  // Downgrade to the pre-upgrade format: the old tool wrote schemaVersion 1
  // and had no migration envelope.
  const legacy = { ...state, schemaVersion: 1 };
  delete legacy.migrations;
  return legacy;
}

function writeLegacyDir(dir, model, legacy) {
  atomicWrite(path.join(dir, 'model.json'), stableStringify(model));
  atomicWrite(path.join(dir, 'state.json'), stableStringify(legacy));
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [EMBER, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function withServer(dir, fn, options = {}) {
  const { startServer } = await import('../skill/forge/scripts/lib/server.mjs');
  const started = await startServer({ dir, port: 0, ...options });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

async function getJson(url) {
  const res = await fetch(url);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// CLI migration with recoverable backup
// ---------------------------------------------------------------------------

test('CLI review upgrades a version-1 archive, keeps a verbatim backup and preserves every learner record', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model, { withApplyAttempt: true });
  writeLegacyDir(dir, model, legacy);
  const legacyBytes = readFile(path.join(dir, 'state.json'));

  // Before migration the due list already reflects the old schedule.
  const dueBefore = runCli(['due', '--out', dir, '--at', '2026-09-10T08:00:00Z']);
  assert.equal(dueBefore.status, 0, dueBefore.stderr);
  const dueListBefore = JSON.parse(dueBefore.stdout);
  assert.ok(dueListBefore.due.some((item) => item.promptId === 'p-explain'), 'old schedule is due');

  const review = runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '升级后的新作答', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-new-1',
  ]);
  assert.equal(review.status, 0, review.stderr);

  const upgraded = readJson(path.join(dir, 'state.json'));
  assert.equal(upgraded.schemaVersion, 2, 'archive is explicitly upgraded');
  assert.equal(upgraded.migrations.length, 1);
  assert.equal(upgraded.migrations[0].from, 1);
  assert.equal(upgraded.migrations[0].to, 2);

  // Every learner record survives with its original semantics.
  const oldAttempt = upgraded.attempts['p-explain'][0];
  assert.equal(oldAttempt.id, 'att-old-1');
  assert.equal(oldAttempt.answer, '旧档里的独立解释');
  assert.equal(oldAttempt.at, '2026-09-02T08:00:00.000Z', 'original time is preserved');
  assert.equal(oldAttempt.rating, 'good');
  assert.equal(oldAttempt.assisted, false);
  assert.equal(oldAttempt.fingerprint, promptFingerprint(model, upgraded, 'p-explain'), 'content fingerprint preserved');
  const assistedAttempt = upgraded.attempts['p-apply'].find((a) => a.id === 'att-old-2');
  assert.equal(assistedAttempt.assisted, true, 'assisted attribute preserved');
  assert.deepEqual(upgraded.promptEvidence['p-explain'].attemptIds, ['att-old-1'], 'evidence links preserved');
  assert.equal(upgraded.promptEvidence['p-explain'].status, 'explained');
  assert.equal(upgraded.explanations.child.text, '旧档里的笔记');
  assert.equal(upgraded.ownQuestions['q-own-1'].text, '自创问题：什么时候失效？');
  assert.equal(upgraded.conceptRevisions.child.title, '子概念（学习者修订）');
  assert.equal(upgraded.schedules['p-explain'].dueAt, legacy.schedules['p-explain'].dueAt, 'review date preserved');
  assert.equal(upgraded.schedules['p-apply'].lastAt, '2026-09-10T09:00:00Z', 'new attempt schedules normally');

  // The recoverable pre-upgrade copy is byte-identical to the old archive.
  const backupPath = path.join(dir, BACKUP_NAME);
  assert.ok(fs.existsSync(backupPath), 'backup written before the first upgraded write');
  assert.equal(readFile(backupPath), legacyBytes, 'backup is a verbatim copy');

  // The due result of the migrated record itself is unchanged (the new attempt
  // legitimately adds its own schedule, so compare the migrated item only).
  const dueAfter = runCli(['due', '--out', dir, '--at', '2026-09-10T08:00:00Z']);
  assert.equal(dueAfter.status, 0, dueAfter.stderr);
  const dueListAfter = JSON.parse(dueAfter.stdout);
  assert.deepEqual(
    dueListAfter.due.filter((item) => item.promptId === 'p-explain'),
    dueListBefore.due.filter((item) => item.promptId === 'p-explain'),
    'migrated answer keeps its original due result',
  );
});

test('repeated upgrades add no history and never rewrite the backup', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  const legacyBytes = readFile(path.join(dir, 'state.json'));

  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '第一次', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-1',
  ]).status, 0);
  const firstBackup = readFile(path.join(dir, BACKUP_NAME));
  assert.equal(firstBackup, legacyBytes);

  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '第二次', '--at', '2026-09-10T10:00:00Z', '--attempt-id', 'att-2',
  ]).status, 0);

  const upgraded = readJson(path.join(dir, 'state.json'));
  assert.equal(upgraded.migrations.length, 1, 'no second migration record');
  assert.equal(readFile(path.join(dir, BACKUP_NAME)), legacyBytes, 'backup is created once and never overwritten');
});

test('read-only due migrates in memory only: archive bytes and mtime unchanged, no backup', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  const statePath = path.join(dir, 'state.json');
  const before = readFile(statePath);
  const beforeStat = fs.statSync(statePath);

  const due = runCli(['due', '--out', dir, '--at', '2026-09-10T08:00:00Z']);
  assert.equal(due.status, 0, due.stderr);
  assert.ok(JSON.parse(due.stdout).due.length > 0);

  assert.equal(readFile(statePath), before, 'read-only command does not rewrite the archive');
  assert.equal(fs.statSync(statePath).mtimeMs, beforeStat.mtimeMs);
  assert.ok(!fs.existsSync(path.join(dir, BACKUP_NAME)), 'no backup until an upgraded write happens');
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore verifies and restores the pre-upgrade archive byte-for-byte, and the old workflow keeps working', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  const legacyBytes = readFile(path.join(dir, 'state.json'));

  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '升级后的作答', '--at', '2026-09-10T09:00:00Z',
  ]).status, 0);

  const restored = runCli(['restore', '--out', dir]);
  assert.equal(restored.status, 0, restored.stderr);
  const report = JSON.parse(restored.stdout);
  assert.equal(report.restored, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.modelId, model.id);
  assert.ok(report.attempts >= 1, 'restored archive summary is verifiable');
  assert.equal(readFile(path.join(dir, 'state.json')), legacyBytes, 'restored file is byte-identical to the old archive');

  // The old (now restored) archive keeps working with the current tool.
  const due = runCli(['due', '--out', dir, '--at', '2026-09-10T08:00:00Z']);
  assert.equal(due.status, 0, due.stderr);
  assert.ok(JSON.parse(due.stdout).due.some((item) => item.promptId === 'p-explain'));

  // Upgrading again keeps the original backup instead of destroying it.
  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '再次升级', '--at', '2026-09-11T09:00:00Z',
  ]).status, 0);
  assert.equal(readFile(path.join(dir, BACKUP_NAME)), legacyBytes, 'backup still holds the first pre-upgrade copy');
  assert.equal(readJson(path.join(dir, 'state.json')).migrations.length, 1, 'second upgrade records one migration');
});

test('restore refuses a missing, foreign or broken backup instead of replacing a working archive', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '升级', '--at', '2026-09-10T09:00:00Z',
  ]).status, 0);
  const upgradedBytes = readFile(path.join(dir, 'state.json'));

  const missing = runCli(['restore', '--out', dir, '--backup', path.join(dir, 'no-such-backup.json')]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes('没有找到可恢复的旧档副本'));

  atomicWrite(path.join(dir, 'foreign.json'), stableStringify({ ...legacy, modelId: 'another-model' }));
  const foreign = runCli(['restore', '--out', dir, '--backup', path.join(dir, 'foreign.json')]);
  assert.equal(foreign.status, 1);
  assert.ok(foreign.stderr.includes('拒绝恢复'));

  atomicWrite(path.join(dir, 'broken.json'), '{"schemaVersion":1,"modelId":"mig-model","attempts":"not-an-object"}');
  const broken = runCli(['restore', '--out', dir, '--backup', path.join(dir, 'broken.json')]);
  assert.equal(broken.status, 1);
  assert.ok(broken.stderr.includes('attempts'), 'broken backup fails validation with a useful path');

  assert.equal(readFile(path.join(dir, 'state.json')), upgradedBytes, 'failed restores leave the current archive intact');
});

test('restore recovers a valid v1 backup when the live archive is truncated or malformed', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  assert.equal(runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '触发备份', '--at', '2026-09-10T09:00:00Z']).status, 0);
  const backupBytes = readFile(path.join(dir, BACKUP_NAME));

  const cases = [
    ['truncated JSON', '{"schemaVersion":2,"modelId":"mig-model"'],
    ['malformed record', JSON.stringify({ schemaVersion: 2, modelId: 'mig-model', attempts: { 'p-apply': [{ id: 'broken' }] } })],
  ];
  for (const [label, damaged] of cases) {
    fs.writeFileSync(path.join(dir, 'state.json'), damaged);
    const restored = runCli(['restore', '--out', dir]);
    assert.equal(restored.status, 0, `${label}: ${restored.stderr}`);
    assert.equal(readFile(path.join(dir, 'state.json')), backupBytes, `${label}: the verified backup bytes are restored`);
    assert.equal(readFile(path.join(dir, BACKUP_NAME)), backupBytes, `${label}: the original backup is not overwritten`);
    const summary = JSON.parse(restored.stdout);
    assert.ok(summary.quarantined && fs.existsSync(summary.quarantined), `${label}: damaged current bytes are quarantined`);
    assert.equal(readFile(summary.quarantined), damaged);
    assert.notEqual(path.resolve(summary.quarantined), path.join(dir, BACKUP_NAME));
  }
});

test('restore refuses an unsupported readable current archive while a damaged current still recovers', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  assert.equal(runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '升级', '--at', '2026-09-10T09:00:00Z']).status, 0);
  const backupBytes = readFile(path.join(dir, BACKUP_NAME));
  const futureBytes = JSON.stringify({ schemaVersion: 3, modelId: 'mig-model', attempts: {} }, null, 2);
  fs.writeFileSync(path.join(dir, 'state.json'), futureBytes);

  const refused = runCli(['restore', '--out', dir]);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes('高于当前工具支持的版本') && refused.stderr.includes('拒绝恢复'), 'newer readable archive is refused');
  assert.equal(readFile(path.join(dir, 'state.json')), futureBytes, 'the newer archive is left untouched');
  assert.equal(readFile(path.join(dir, BACKUP_NAME)), backupBytes, 'the backup is left untouched');

  // A damaged (unreadable) current of the same model is exactly the recovery case.
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  const recovered = runCli(['restore', '--out', dir]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFile(path.join(dir, 'state.json')), backupBytes);
});

test('an invalid backup never restores and never quarantines a damaged current', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken current');
  const before = readFile(path.join(dir, 'state.json'));
  const brokenBackup = path.join(dir, 'broken-backup.json');
  atomicWrite(brokenBackup, '{"schemaVersion":1,"modelId":"mig-model","attempts":"nope"}');

  const result = runCli(['restore', '--out', dir, '--backup', brokenBackup]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('attempts'), 'the invalid backup is rejected before any write');
  assert.equal(readFile(path.join(dir, 'state.json')), before, 'a failed restore leaves the damaged current exactly as it was');
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('state.corrupt.')), false, 'no quarantine is created for an invalid backup');
});

// ---------------------------------------------------------------------------
// Build migration, stale content and orphans
// ---------------------------------------------------------------------------

test('build migrates a version-1 archive, marks stale history after content changes and reports orphans readably', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  legacy.explanations.ghost = { text: '被删除概念的笔记', updatedAt: '2026-09-02T10:00:00.000Z', author: 'learner' };
  writeLegacyDir(dir, model, legacy);
  const legacyBytes = readFile(path.join(dir, 'state.json'));

  // Rebuild with changed prompt content and a changed concept explanation.
  const changed = rawModel();
  changed.prompts[0].question = '请用自己的话解释子概念的适用边界';
  changed.concepts[1].explanation = '更新后的子概念解释';
  atomicWrite(path.join(dir, 'changed.json'), stableStringify(changed));
  const built = runCli(['build', path.join(dir, 'changed.json'), '--out', dir]);
  assert.equal(built.status, 0, built.stderr);

  const upgraded = readJson(path.join(dir, 'state.json'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.migrations.length, 1);
  assert.equal(readFile(path.join(dir, BACKUP_NAME)), legacyBytes, 'build keeps the pre-upgrade copy');
  assert.equal(upgraded.attempts['p-explain'][0].answer, '旧档里的独立解释', 'stale history is preserved');

  // Stale evidence and orphans are readable through the public state endpoint.
  await withServer(dir, async (s) => {
    const { json } = await getJson(`${s.url}/api/state`);
    assert.equal(json.state.schemaVersion, 2);
    assert.equal(json.view.prompts['p-explain'].stale, true, 'changed content marks the prompt stale');
    assert.equal(json.view.prompts['p-explain'].evidence, null, 'stale proof is not shown as active');
    assert.equal(json.view.prompts['p-explain'].staleEvidence.status, 'explained', 'history stays readable');
    // A stale attempt never counts as pending-review mastery either.
    assert.equal(json.view.conceptStatus.child.status, 'unknown');
    assert.ok(
      json.state.orphans.some((item) => item.kind === 'explanation' && item.id === 'ghost'),
      'deleted concept notes become readable orphans',
    );
    // The orphaned record is never silently reactivated as current mastery.
    assert.equal(json.view.conceptStatus.ghost, undefined);
  });

  const due = runCli(['due', '--out', dir, '--at', '2026-09-04T08:00:00Z']);
  assert.equal(due.status, 0, due.stderr);
  const dueList = JSON.parse(due.stdout);
  assert.ok(
    dueList.unscheduled.some((item) => item.promptId === 'p-explain' && item.reason === 'stale-evidence'),
    'stale evidence is unscheduled, not silently active',
  );
});

test('unchanged content keeps migrated evidence active after upgrade', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  atomicWrite(path.join(dir, 'same.json'), stableStringify(rawModel()));
  assert.equal(runCli(['build', path.join(dir, 'same.json'), '--out', dir]).status, 0);

  await withServer(dir, async (s) => {
    const { json } = await getJson(`${s.url}/api/state`);
    assert.equal(json.view.prompts['p-explain'].evidence?.status, 'explained', 'unchanged content keeps proof active');
    assert.equal(json.view.prompts['p-explain'].stale, false);
    assert.equal(json.view.conceptStatus.child.status, 'pending-review', 'active attempts stay readable pending concept review');
  });
});

// ---------------------------------------------------------------------------
// Missing information is marked, not invented
// ---------------------------------------------------------------------------

test('migration marks missing attempt and evidence fields instead of inventing them', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  // Hand-shaped records the old tool always wrote completely; an archive
  // missing them must be upgraded honestly.
  legacy.attempts['p-explain'][0] = { id: 'att-old-1', promptId: 'p-explain', at: '2026-09-02T08:00:00.000Z', answer: '旧档里的解释', rating: 'good' };
  delete legacy.promptEvidence['p-explain'].attemptIds;
  writeLegacyDir(dir, model, legacy);

  assert.equal(runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '触发迁移', '--at', '2026-09-10T09:00:00Z',
  ]).status, 0);

  const upgraded = readJson(path.join(dir, 'state.json'));
  const record = upgraded.migrations[0];
  const warnings = record.warnings.join('\n');
  assert.ok(warnings.includes('att-old-1'), 'missing attempt fields are listed');
  assert.ok(warnings.includes('fingerprint'), 'missing fingerprint is named');
  assert.ok(warnings.includes('assisted'), 'missing assisted flag is named');
  assert.ok(warnings.includes('p-explain'), 'evidence missing attemptIds is listed');
  assert.equal(upgraded.attempts['p-explain'][0].fingerprint, undefined, 'no fingerprint is invented');

  // Conservative semantics: a fingerprint-less attempt is not current evidence.
  await withServer(dir, async (s) => {
    const { json } = await getJson(`${s.url}/api/state`);
    assert.equal(json.view.prompts['p-explain'].evidence, null, 'proof without links never shows as active');
    assert.equal(json.view.prompts['p-explain'].staleEvidence.status, 'explained');
  });
  const due = runCli(['due', '--out', dir, '--at', '2026-09-04T08:00:00Z']);
  const dueList = JSON.parse(due.stdout);
  assert.ok(
    dueList.unscheduled.some((item) => item.promptId === 'p-explain' && item.reason === 'stale-evidence'),
    'fingerprint-less attempt is treated as stale, not active',
  );
});

// ---------------------------------------------------------------------------
// Shared write-coordination boundary: CLI, build and HTTP saves
// ---------------------------------------------------------------------------

test('HTTP save upgrades a version-1 archive with backup; reads never rewrite the archive', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);
  writeLegacyDir(dir, model, legacy);
  const legacyBytes = readFile(path.join(dir, 'state.json'));
  const statePath = path.join(dir, 'state.json');

  await withServer(dir, async (s) => {
    const before = await getJson(`${s.url}/api/state`);
    assert.equal(before.json.state.schemaVersion, 2, 'reads serve the migrated archive');
    assert.equal(readFile(statePath), legacyBytes, 'a read does not write the archive');

    const note = await postJson(`${s.url}/api/note`, {
      revision: before.json.state.revision,
      modelFingerprint: before.json.modelFingerprint,
      conceptId: 'root',
      kind: 'summary',
      text: '页面里写的总结',
    });
    assert.equal(note.status, 200, JSON.stringify(note.json));
    assert.equal(note.json.state.schemaVersion, 2);
  });

  const upgraded = readJson(statePath);
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.summaries.root.text, '页面里写的总结');
  assert.equal(readFile(path.join(dir, BACKUP_NAME)), legacyBytes, 'HTTP save keeps the pre-upgrade copy');
});

test('interleaved page and session-side saves preserve both sides; conflicts return the current state and survive a restart', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(rawModel()));
  assert.equal(runCli(['build', path.join(dir, 'source.json'), '--out', dir]).status, 0);

  let captured;
  await withServer(dir, async (s) => {
    const base = await getJson(`${s.url}/api/state`);
    const revision = base.json.state.revision;
    const fingerprint = base.json.modelFingerprint;

    // Page writes a note, then the session side (CLI) records an attempt.
    const note = await postJson(`${s.url}/api/note`, {
      revision, modelFingerprint: fingerprint, conceptId: 'root', kind: 'explanation', text: '页面笔记',
    });
    assert.equal(note.status, 200);
    const cli = runCli([
      'review', '--out', dir, '--prompt', 'p-explain', '--rating', 'hard',
      '--answer', '会话侧作答', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-cli-1',
    ]);
    assert.equal(cli.status, 0, cli.stderr);

    // The open page still holds the pre-CLI revision: a conflict with a
    // processable reason and the current durable state is returned.
    const stale = await postJson(`${s.url}/api/attempt`, {
      revision, modelFingerprint: fingerprint, promptId: 'p-apply',
      attemptId: 'att-page-1', answer: '页面作答', rating: 'good', assisted: false,
    });
    assert.equal(stale.status, 409);
    assert.ok(stale.json.error.includes('revision'), 'conflict names the reason');
    assert.ok(
      (stale.json.state.attempts['p-explain'] ?? []).some((a) => a.id === 'att-cli-1'),
      'conflict response carries the CLI addition',
    );

    // The page replays on the fresh state: both sides' additions persist.
    const retry = await postJson(`${s.url}/api/attempt`, {
      revision: stale.json.state.revision, modelFingerprint: fingerprint, promptId: 'p-apply',
      attemptId: 'att-page-1', answer: '页面作答', rating: 'good', assisted: false,
    });
    assert.equal(retry.status, 200);
    captured = retry.json.state;
  });

  assert.equal(captured.explanations.root.text, '页面笔记');
  assert.ok(captured.attempts['p-explain'].some((a) => a.id === 'att-cli-1'));
  assert.ok(captured.attempts['p-apply'].some((a) => a.id === 'att-page-1'));

  // Durable across a server restart.
  await withServer(dir, async (s) => {
    const { json } = await getJson(`${s.url}/api/state`);
    assert.equal(json.state.explanations.root.text, '页面笔记');
    assert.ok(json.state.attempts['p-explain'].some((a) => a.id === 'att-cli-1'));
    assert.ok(json.state.attempts['p-apply'].some((a) => a.id === 'att-page-1'));
  });
});

test('two concurrent CLI reviews both land in the archive (cross-process lock)', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));

  const children = ['a', 'b'].map((tag) => spawn(process.execPath, [
    EMBER, 'review', '--out', dir, '--prompt', `p-${tag === 'a' ? 'explain' : 'apply'}`,
    '--rating', 'good', '--answer', `并发作答${tag}`, '--at', '2026-09-10T09:00:00Z',
    '--attempt-id', `att-par-${tag}`,
  ], { cwd: ROOT, env: { ...process.env, EMBER_LOCK_TIMEOUT_MS: '15000' } }));
  const codes = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.on('error', reject);
  })));
  for (const result of codes) assert.equal(result.code, 0, result.stderr);

  const state = readJson(path.join(dir, 'state.json'));
  assert.ok(state.attempts['p-explain'].some((a) => a.id === 'att-par-a'));
  assert.ok(state.attempts['p-apply'].some((a) => a.id === 'att-par-b'), 'no lost update between processes');
  assert.equal(state.schemaVersion, 2);
});

test('a held lock reports current CLI metadata, protects live aged owners and recovers a dead owner', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  const lockPath = path.join(dir, '.ember-lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: '2026-09-10T09:00:00.000Z' }));
  const before = readFile(path.join(dir, 'state.json'));

  const blocked = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '不该写入', '--at', '2026-09-10T09:00:00Z'], { env: { EMBER_LOCK_TIMEOUT_MS: '200' } });
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stderr.includes('正被其他进程写入'), 'conflict names the coordination boundary');
  assert.ok(blocked.stderr.includes('E_CONFLICT'));
  const metadata = JSON.parse(blocked.stderr.slice(blocked.stderr.indexOf('{')));
  assert.equal(metadata.statePath, path.join(dir, 'state.json'));
  assert.equal(metadata.modelFingerprint, model.modelFingerprint);
  assert.equal(metadata.state.revision, v1Archive(model).revision);
  assert.ok(metadata.view && metadata.promptFingerprints['p-apply']);
  assert.equal(readFile(path.join(dir, 'state.json')), before, 'a blocked writer changes nothing');

  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, longAgo, longAgo);
  const liveOwnerBytes = readFile(lockPath);
  const live = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good', '--answer', '仍不该写入'],
    { env: { EMBER_LOCK_TIMEOUT_MS: '150', EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(live.status, 1, 'age must never defeat owner liveness');
  assert.equal(readFile(lockPath), liveOwnerBytes, 'live aged owner retains its lock');
  assert.equal(readFile(path.join(dir, 'state.json')), before);

  // Use a child that actually exited, rather than inventing an unused PID.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  const deadPid = Number(dead.stdout);
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'crashed-owner' }));
  fs.utimesSync(lockPath, longAgo, longAgo);
  const recovered = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '坏锁恢复后写入', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-after-stale'],
    { env: { EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.ok(!fs.existsSync(lockPath), 'lock released after the write');
  assert.ok(readJson(path.join(dir, 'state.json')).attempts['p-apply'].some((a) => a.id === 'att-after-stale'));
});

// Observe real subprocesses at filesystem boundaries without changing the CLI.
// The build pauses only after it owns the public lock and starts reading input;
// waiters announce EEXIST so content changes are deterministic, not timing guesses.
function observedCli(args, observer, env = {}) {
  const child = spawn(process.execPath, ['--require', observer, EMBER, ...args], {
    cwd: ROOT, env: { ...process.env, EMBER_LOCK_TIMEOUT_MS: '12000', ...env },
  });
  let stdout = '', stderr = '';
  const listeners = new Set();
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    for (const notify of listeners) notify();
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  function waitFor(marker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(notify); reject(new Error(`missing ${marker}: ${stderr}`)); }, 6000);
      function notify() {
        if (!stderr.includes(marker)) return;
        clearTimeout(timer);
        listeners.delete(notify);
        resolve();
      }
      listeners.add(notify);
      notify();
    });
  }
  return { child, finished, waitFor };
}

test('public CLI writers waiting behind a rebuild reject removed or changed content with current state', async (t) => {
  const root = tmpDir();
  t.after(() => cleanup(root));
  const observer = path.join(root, 'observe.cjs');
  fs.writeFileSync(observer, `
    const fs = require('node:fs');
    const open = fs.openSync, read = fs.readFileSync;
    let waiting = false, paused = false;
    fs.openSync = function (...args) {
      try { return open.apply(this, args); }
      catch (err) {
        if (err.code === 'EEXIST' && !waiting && String(args[0]).endsWith('.ember-lock')) {
          waiting = true; process.stderr.write('lock-waiting\\n');
        }
        throw err;
      }
    };
    fs.readFileSync = function (...args) {
      if (!paused && String(args[0]) === process.env.EMBER_TEST_BUILD_SOURCE) {
        paused = true; process.stderr.write('build-read-locked\\n');
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(process.env.EMBER_TEST_BUILD_GATE)) {
          if (Date.now() > deadline) throw new Error('test build gate timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return read.apply(this, args);
    };
  `);
  for (const variant of ['removed', 'changed']) {
    const dir = path.join(root, variant);
    fs.mkdirSync(dir);
    const original = normalizeModel(rawModel());
    writeLegacyDir(dir, original, v1Archive(original));
    assert.equal(runCli(['build', path.join(dir, 'model.json'), '--out', dir]).status, 0);
    const incoming = path.join(dir, 'incoming.json');
    atomicWrite(incoming, readFile(path.join(dir, 'state.json')));
    const source = path.join(dir, 'changed-source.json');
    const updated = rawModel({ prompts: variant === 'removed'
      ? rawModel().prompts.filter((p) => p.id !== 'p-apply')
      : rawModel().prompts.map((p) => p.id === 'p-apply' ? { ...p, question: '更新后的问题，旧答案不能自动成为新内容证据' } : p) });
    atomicWrite(source, stableStringify(updated));
    const gate = path.join(dir, 'release-build');
    const builder = observedCli(['build', source, '--out', dir], observer, {
      EMBER_TEST_BUILD_SOURCE: source, EMBER_TEST_BUILD_GATE: gate,
    });
    t.after(() => { if (builder.child.exitCode === null) builder.child.kill(); });
    await builder.waitFor('build-read-locked');
    assert.ok(fs.existsSync(path.join(dir, '.ember-lock')), 'public build owns the lock before content changes');
    const commands = [
      ['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good', '--answer', '对旧题的作答', '--attempt-id', 'obsolete-answer'],
      ['evidence', '--out', dir, '--prompt', 'p-explain', '--status', 'explained', '--note', '对旧内容的复核', '--attempt', 'att-old-1'],
      ['import', '--out', dir, '--state', incoming],
      ['restore', '--out', dir],
    ];
    const writers = commands.map((args) => observedCli(args, observer));
    t.after(() => { for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill(); });
    await Promise.all(writers.map((writer) => writer.waitFor('lock-waiting')));
    fs.writeFileSync(gate, 'release');
    const built = await builder.finished;
    assert.equal(built.code, 0, built.stderr);
    const rebuiltBytes = readFile(path.join(dir, 'state.json'));
    const fingerprint = normalizeModel(updated).modelFingerprint;
    for (const [index, writer] of writers.entries()) {
      const result = await writer.finished;
      assert.equal(result.code, 1, `${commands[index][0]} must not report obsolete success: ${result.stdout} ${result.stderr}`);
      assert.match(result.stderr, /E_CONFLICT/);
      const metadata = JSON.parse(result.stderr.slice(result.stderr.indexOf('{')));
      assert.equal(metadata.modelFingerprint, fingerprint);
      assert.equal(metadata.state.modelFingerprint, fingerprint);
      assert.ok(metadata.view && metadata.conceptFingerprints);
      assert.doesNotMatch(result.stdout, /"saved": true|"imported": true|"restored": true/);
    }
    assert.equal(readFile(path.join(dir, 'state.json')), rebuiltBytes, 'rejected obsolete writers do not mutate rebuilt archive');
    assert.equal(readJson(path.join(dir, 'state.json')).attempts['p-apply'], undefined);
  }
});

test('HTTP and CLI honor external state locks through directory aliases and return current conflict state', async (t) => {
  const root = tmpDir();
  t.after(() => cleanup(root));
  const dir = path.join(root, 'page');
  const shared = path.join(root, 'shared');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(dir);
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const model = normalizeModel(rawModel());
  atomicWrite(path.join(dir, 'model.json'), stableStringify(rawModel()));
  const statePath = path.join(shared, 'custom-state.json');
  atomicWrite(statePath, stableStringify(v1Archive(model)));
  const before = readFile(statePath);
  const lockPath = path.join(shared, '.ember-lock');
  const held = JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'external-live-owner', at: new Date().toISOString() });
  fs.writeFileSync(lockPath, held);
  const cli = runCli(['review', '--out', dir, '--state', path.join(alias, 'custom-state.json'),
    '--prompt', 'p-apply', '--rating', 'good', '--answer', '不能绕过外部档案锁'], { env: { EMBER_LOCK_TIMEOUT_MS: '150' } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /E_CONFLICT/);
  assert.equal(readFile(statePath), before);
  const oldTimeout = process.env.EMBER_LOCK_TIMEOUT_MS;
  process.env.EMBER_LOCK_TIMEOUT_MS = '150';
  try {
    await withServer(dir, async (server) => {
      const { json: base } = await getJson(`${server.url}/api/state`);
      const body = { revision: base.state.revision, modelFingerprint: base.modelFingerprint,
        conceptId: 'child', kind: 'summary', text: '外部档案笔记' };
      const blocked = await postJson(`${server.url}/api/note`, body);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.code, 'E_CONFLICT');
      assert.equal(blocked.json.modelFingerprint, model.modelFingerprint);
      // A read-only v1 migration has a fresh observation time; learner records,
      // revision, view and content metadata must still describe the same archive.
      assert.deepEqual({ ...blocked.json.state, migrations: [] }, { ...base.state, migrations: [] });
      assert.deepEqual(blocked.json.state.migrations.map(({ at, ...entry }) => entry), base.state.migrations.map(({ at, ...entry }) => entry));
      assert.deepEqual(blocked.json.view, base.view);
      assert.deepEqual(blocked.json.promptFingerprints, base.promptFingerprints);
      assert.deepEqual(blocked.json.conceptFingerprints, base.conceptFingerprints);
      assert.equal(readFile(lockPath), held, 'blocked HTTP save leaves live owner intact');
      assert.equal(readFile(statePath), before, 'blocked HTTP save does not migrate or partially write');
      assert.ok(!fs.existsSync(path.join(shared, BACKUP_NAME)));
      fs.unlinkSync(lockPath);
      const saved = await postJson(`${server.url}/api/note`, body);
      assert.equal(saved.status, 200, saved.json.error);
      assert.equal(readJson(statePath).summaries.child.text, '外部档案笔记');
      assert.equal(readFile(path.join(shared, BACKUP_NAME)), before);
      // A different state filename still shares the content directory boundary.
      const pageLock = path.join(dir, '.ember-lock');
      fs.writeFileSync(pageLock, held);
      const second = path.join(shared, 'second-state.json');
      atomicWrite(second, stableStringify(createState(model)));
      const another = runCli(['review', '--out', dir, '--state', second, '--prompt', 'p-apply',
        '--rating', 'good', '--answer', '第二档也共享内容锁'], { env: { EMBER_LOCK_TIMEOUT_MS: '150' } });
      assert.equal(another.status, 1);
      assert.match(another.stderr, /E_CONFLICT/);
      fs.unlinkSync(pageLock);
    }, { statePath: path.join(alias, 'custom-state.json') });
  } finally {
    if (oldTimeout === undefined) delete process.env.EMBER_LOCK_TIMEOUT_MS;
    else process.env.EMBER_LOCK_TIMEOUT_MS = oldTimeout;
  }
});

test('lock cleanup cannot delete a successor and unknown owners remain protected', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const lockPath = path.join(dir, '.ember-lock');
  const successor = JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'successor' });
  await withArchiveLock(dir, async () => {
    const owner = readJson(lockPath);
    assert.ok(owner.token && owner.token !== 'successor');
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, successor);
  });
  assert.equal(readFile(lockPath), successor, 'former owner does not remove successor token/file');
  assert.deepEqual([...new Set(archiveLockDirs(dir, path.join(dir, 'state.json')))], [dir]);
  const oldTimeout = process.env.EMBER_LOCK_TIMEOUT_MS;
  process.env.EMBER_LOCK_TIMEOUT_MS = '100';
  try {
    for (const unknown of ['not JSON', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: 123, host: 'unknown-remote-host' })]) {
      fs.writeFileSync(lockPath, unknown);
      const longAgo = new Date(Date.now() - 60000);
      fs.utimesSync(lockPath, longAgo, longAgo);
      await assert.rejects(withArchiveLock(dir, () => assert.fail('unknown owner must not be stolen')), { code: 'E_CONFLICT' });
      assert.equal(readFile(lockPath), unknown);
    }
  } finally {
    if (oldTimeout === undefined) delete process.env.EMBER_LOCK_TIMEOUT_MS;
    else process.env.EMBER_LOCK_TIMEOUT_MS = oldTimeout;
  }
});

test('a held recovery gate protects a dead lock from deletion until it is released', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  const lockPath = path.join(dir, '.ember-lock');
  const gatePath = path.join(dir, '.ember-lock.recovery');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'crashed-owner' }));
  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, longAgo, longAgo);
  const deadLockBytes = readFile(lockPath);
  fs.writeFileSync(gatePath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'live-recoverer' }));

  const blocked = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good', '--answer', 'gate blocked'],
    { env: { EMBER_LOCK_TIMEOUT_MS: '250', EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /E_CONFLICT/);
  assert.match(blocked.stderr, /无法安全自动接管/);
  assert.equal(readFile(lockPath), deadLockBytes, 'the dead lock is not removed while the recovery gate is held');
  assert.ok(readFile(gatePath).includes('live-recoverer'), 'the live recovery gate is preserved');

  fs.unlinkSync(gatePath);
  const recovered = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '释放后恢复', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-after-gate'],
    { env: { EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.ok(readJson(path.join(dir, 'state.json')).attempts['p-apply'].some((a) => a.id === 'att-after-gate'));
  assert.ok(!fs.existsSync(gatePath), 'the recovery gate is released');
  assert.ok(!fs.existsSync(lockPath), 'the archive lock is released');
});

test('an orphaned recovery gate is never auto-reclaimed, even with a dead recorded owner', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  const lockPath = path.join(dir, '.ember-lock');
  const gatePath = path.join(dir, '.ember-lock.recovery');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'crashed-main' }));
  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, longAgo, longAgo);
  const deadLockBytes = readFile(lockPath);
  fs.writeFileSync(gatePath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'crashed-recoverer' }));
  fs.utimesSync(gatePath, longAgo, longAgo);
  const gateBytes = readFile(gatePath);

  const result = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good', '--answer', '不应绕过恢复锁'],
    { env: { EMBER_LOCK_TIMEOUT_MS: '250', EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_CONFLICT/);
  assert.match(result.stderr, /无法安全自动接管/);
  assert.ok(result.stderr.includes(`pid ${deadPid}`), 'the conflict names the recorded gate owner');
  assert.equal(readFile(gatePath), gateBytes, 'a dead-owner recovery gate is never auto-reclaimed');
  assert.equal(readFile(lockPath), deadLockBytes, 'the dead main lock is left for deliberate recovery');
  assert.equal(readFile(path.join(dir, 'state.json')).includes('不应绕过恢复锁'), false);

  // Deliberate external recovery (an operator removes the orphaned gate) then proceeds.
  fs.unlinkSync(gatePath);
  const recovered = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '手动恢复后写入', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'att-manual-recovery'],
    { env: { EMBER_LOCK_STALE_MS: '1' } });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.ok(readJson(path.join(dir, 'state.json')).attempts['p-apply'].some((a) => a.id === 'att-manual-recovery'));
});

test('two dead-lock recoverers are serialized so both legitimate writes survive', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  const lockPath = path.join(dir, '.ember-lock');
  const gatePath = path.join(dir, '.ember-lock.recovery');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'crashed-owner' }));
  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, longAgo, longAgo);

  const observer = path.join(dir, 'observe.cjs');
  fs.writeFileSync(observer, `
    const fs = require('node:fs');
    const read = fs.readFileSync, open = fs.openSync, unlink = fs.unlinkSync;
    let paused = false;
    fs.readFileSync = function (...args) {
      if (!paused && String(args[0]).endsWith('.ember-lock')) {
        paused = true; process.stderr.write('lock-read\\n');
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(process.env.EMBER_TEST_RELEASE)) {
          if (Date.now() > deadline) throw new Error('recovery barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return read.apply(this, args);
    };
    fs.openSync = function (file, ...rest) {
      const fd = open.call(this, file, ...rest);
      if (rest[0] === 'wx' && String(file).endsWith('.ember-lock')) {
        fs.writeFileSync(process.env.EMBER_TEST_HELD + process.pid, '1');
      }
      return fd;
    };
    fs.unlinkSync = function (file) {
      const target = String(file);
      if (target.endsWith('.ember-lock') && target.indexOf('.recovery') === -1) {
        try {
          const owner = JSON.parse(read.call(fs, target, 'utf8'));
          if (owner && Number.isInteger(owner.pid) && owner.pid !== process.pid) {
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
            if (alive) fs.appendFileSync(process.env.EMBER_TEST_UNSAFE, 'deleted live lock pid ' + owner.pid + '\\n');
          }
        } catch (e) { /* no lock or unreadable; production unlink still runs below */ }
      }
      const result = unlink.call(this, file);
      if (target.endsWith('.ember-lock') && target.indexOf('.recovery') === -1) {
        try { unlink.call(this, process.env.EMBER_TEST_HELD + process.pid); } catch (e) { /* already gone */ }
      }
      return result;
    };
  `);
  const release = path.join(dir, 'release-recovery');
  const heldPrefix = path.join(dir, '.held-');
  const unsafePath = path.join(dir, 'unsafe-delete.txt');
  const writers = ['a', 'b'].map((tag) => observedCli(
    ['review', '--out', dir, '--prompt', `p-${tag === 'a' ? 'explain' : 'apply'}`, '--rating', 'good',
      '--answer', `恢复并发${tag}`, '--at', '2026-09-10T09:00:00Z', '--attempt-id', `att-recover-${tag}`],
    observer, { EMBER_TEST_RELEASE: release, EMBER_TEST_HELD: heldPrefix, EMBER_TEST_UNSAFE: unsafePath,
      EMBER_LOCK_TIMEOUT_MS: '12000', EMBER_LOCK_STALE_MS: '1' }));
  t.after(() => { for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill(); });
  await Promise.all(writers.map((writer) => writer.waitFor('lock-read')));

  let maxHeld = 0;
  const poll = setInterval(() => {
    const held = fs.readdirSync(dir).filter((name) => name.startsWith('.held-')).length;
    if (held > maxHeld) maxHeld = held;
  }, 2);
  fs.writeFileSync(release, 'go');
  const results = await Promise.all(writers.map((writer) => writer.finished));
  clearInterval(poll);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.ok(maxHeld <= 1, `at most one recoverer may hold the archive lock at a time (saw ${maxHeld})`);
  assert.equal(fs.existsSync(unsafePath), false, 'no recoverer deleted another live owner\'s lock');
  const state = readJson(path.join(dir, 'state.json'));
  assert.ok(state.attempts['p-explain'].some((a) => a.id === 'att-recover-a'));
  assert.ok(state.attempts['p-apply'].some((a) => a.id === 'att-recover-b'), 'both recoverers keep their write');
  assert.ok(!fs.existsSync(lockPath), 'the archive lock is released');
  assert.ok(!fs.existsSync(gatePath), 'the recovery gate is released');
});

// ---------------------------------------------------------------------------
// Future formats are rejected clearly
// ---------------------------------------------------------------------------

test('an archive from a newer forge version is rejected clearly and left untouched', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  const future = stableStringify({ ...readJson(path.join(dir, 'state.json')), schemaVersion: 3 });
  atomicWrite(path.join(dir, 'state.json'), future);
  const before = readFile(path.join(dir, 'state.json'));

  const due = runCli(['due', '--out', dir, '--at', '2026-09-10T08:00:00Z']);
  assert.equal(due.status, 1);
  assert.ok(due.stderr.includes('高于当前工具支持的版本'), 'names the version gap');
  assert.ok(due.stderr.includes('升级'), 'asks for a tool upgrade');
  assert.equal(readFile(path.join(dir, 'state.json')), before, 'the future archive is not modified');

  const review = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '不应写入', '--at', '2026-09-10T09:00:00Z']);
  assert.equal(review.status, 1);
  assert.equal(readFile(path.join(dir, 'state.json')), before);

  await withServer(dir, async (s) => {
    const { status, json } = await getJson(`${s.url}/api/state`);
    assert.equal(status, 400);
    assert.equal(json.code, 'E_STATE');
    assert.ok(json.error.includes('升级'));
  });
});

// Old tools (the previous forge version) reject the upgraded archive because
// its schemaVersion is newer than what they support. Point EMBER_OLD_TOOL at
// the previous release's forge.mjs to run this gate, e.g.:
//   EMBER_OLD_TOOL=<baseline>/skill/forge/scripts/forge.mjs node --test tests/migration.test.mjs
test('an old version-1 tool clearly rejects the upgraded archive', { skip: !process.env.EMBER_OLD_TOOL }, async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  assert.equal(runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '触发升级', '--at', '2026-09-10T09:00:00Z']).status, 0);

  const { spawnSync } = await import('node:child_process');
  const old = spawnSync(process.execPath, [process.env.EMBER_OLD_TOOL, 'due', '--out', dir], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(old.status, 1, 'the old tool refuses the new archive');
  assert.ok(old.stderr.includes('schemaVersion'), 'the old tool names the version mismatch');
  assert.equal(readJson(path.join(dir, 'state.json')).schemaVersion, 2, 'the old tool does not corrupt the archive');
});

// ---------------------------------------------------------------------------
// Import/export across archive versions
// ---------------------------------------------------------------------------

test('importing a version-1 export migrates it and importing twice adds no duplicate history', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const legacy = v1Archive(model);

  // Fresh archive built by the current tool, then merge the old export in.
  atomicWrite(path.join(dir, 'model.json'), stableStringify(rawModel()));
  assert.equal(runCli(['build', path.join(dir, 'model.json'), '--out', dir]).status, 0);
  const exportPath = path.join(dir, 'old-export.json');
  atomicWrite(exportPath, stableStringify(legacy));

  assert.equal(runCli(['import', '--out', dir, '--state', exportPath]).status, 0);
  const first = readJson(path.join(dir, 'state.json'));
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.migrations.length, 0, 'merging a foreign archive does not fabricate this archive’s history');
  assert.ok(first.attempts['p-explain'].some((a) => a.id === 'att-old-1'));
  assert.ok(first.ownQuestions['q-own-1']);

  assert.equal(runCli(['import', '--out', dir, '--state', exportPath]).status, 0);
  const second = readJson(path.join(dir, 'state.json'));
  assert.equal(second.migrations.length, 0, 'repeated import adds no migration history');
  assert.equal(second.attempts['p-explain'].length, first.attempts['p-explain'].length, 'replay adds no attempt');
});

test('export writes the current archive format and the result imports cleanly elsewhere', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const otherDir = tmpDir();
  t.after(() => cleanup(otherDir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));
  assert.equal(runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '导出前作答', '--at', '2026-09-10T09:00:00Z']).status, 0);

  const exported = path.join(dir, 'export.json');
  assert.equal(runCli(['export', '--out', dir, '--to', exported]).status, 0);
  assert.equal(readJson(exported).schemaVersion, 2);

  atomicWrite(path.join(otherDir, 'model.json'), stableStringify(rawModel()));
  assert.equal(runCli(['build', path.join(otherDir, 'model.json'), '--out', otherDir]).status, 0);
  assert.equal(runCli(['import', '--out', otherDir, '--state', exported]).status, 0);
  const merged = readJson(path.join(otherDir, 'state.json'));
  assert.ok(merged.attempts['p-apply'].some((a) => a.answer === '导出前作答'));
  assert.ok(merged.attempts['p-explain'].some((a) => a.id === 'att-old-1'));
});

test('CLI and build accept legal attempt ids that collide with object prototype names', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  writeLegacyDir(dir, model, v1Archive(model));

  const review = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '合法继承名 id 的作答', '--at', '2026-09-10T09:00:00Z', '--attempt-id', 'toString']);
  assert.equal(review.status, 0, review.stderr);
  assert.ok(readJson(path.join(dir, 'state.json')).attempts['p-apply'].some((a) => a.id === 'toString'),
    'a legal toString attempt id is stored, not mistaken for a duplicate or inherited property');

  const rebuilt = runCli(['build', path.join(dir, 'model.json'), '--out', dir]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const after = readJson(path.join(dir, 'state.json'));
  assert.ok(after.attempts['p-apply'].some((a) => a.id === 'toString'), 'rebuild keeps the record');
  assert.equal(after.attempts['p-apply'].filter((a) => a.id === 'toString').length, 1);
});
