// Learning-round backend regressions (ticket 04).
//
// These exercise the public behavior of the round journey: the pure route
// library, the real CLI, the local HTTP save endpoint, and a rebuild/restart
// readback. They do not test the viewer UI (ticket 04's parent covers that) but
// they do run the real built page's inlined round library through the same
// `/*__EMBER_ROUND_LIBRARY__*/` injection the builder uses.
//
// Run: node --test tests/round.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyLearningRound,
  applyPractice,
  applySubmission,
  applyTutorEvidence,
  createState,
  learningRoundView,
  mergeImportedState,
  normalizeState,
  syncModel,
  validateLearningRoundBinding,
  validateLearningRounds,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts, injectRoundLibrary } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const ROUND_LIB_PATH = path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'round.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-round-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
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

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

// A model with a prerequisite chain a -> b -> c so route ordering, prerequisite
// inclusion, and budget deferral are all observable. `d` is an unrelated target
// used to check that two targets are both reachable.
function chainModel(overrides = {}) {
  return normalizeModel({
    schemaVersion: 1,
    id: 'round-model',
    title: '本轮测试主题',
    goal: '能解释并应用核心机制',
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: '根解释' },
      { id: 'a', title: '前置 A', parentId: 'root', difficulty: 1, explanation: 'A 解释' },
      { id: 'b', title: '中间 B', parentId: 'root', difficulty: 2, explanation: 'B 解释' },
      { id: 'c', title: '目标 C', parentId: 'b', difficulty: 3, explanation: 'C 解释' },
      { id: 'd', title: '旁支 D', parentId: 'root', difficulty: 1, explanation: 'D 解释' },
    ],
    relations: [
      { id: 'rel-a-b', from: 'a', to: 'b', type: 'prerequisite', label: '先 A 后 B' },
      { id: 'rel-b-c', from: 'b', to: 'c', type: 'prerequisite', label: '先 B 后 C' },
    ],
    prompts: [
      { id: 'pa', conceptId: 'a', kind: 'explain', question: 'a?', answer: '答案 a', criteria: ['要点 a'] },
      { id: 'pb', conceptId: 'b', kind: 'explain', question: 'b?', answer: '答案 b', criteria: ['要点 b'] },
      { id: 'pc', conceptId: 'c', kind: 'apply', question: 'c?', answer: '答案 c', criteria: ['要点 c'] },
      { id: 'pd', conceptId: 'd', kind: 'explain', question: 'd?', answer: '答案 d', criteria: ['要点 d'] },
    ],
    ...overrides,
  });
}

// A chain whose prerequisite is expensive and whose descendant is cheap, so a
// greedy budget would wrongly skip the prerequisite to schedule the descendant.
function heavyPrerequisiteModel(overrides = {}) {
  return normalizeModel({
    schemaVersion: 1,
    id: 'round-heavy',
    title: '重前置主题',
    goal: '掌握轻量目标',
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: '根解释' },
      { id: 'heavy', title: '昂贵前置', parentId: 'root', difficulty: 3, explanation: '重解释' },
      { id: 'light', title: '轻量目标', parentId: 'heavy', difficulty: 1, explanation: '轻解释' },
    ],
    relations: [{ id: 'rel-h-l', from: 'heavy', to: 'light', type: 'prerequisite', label: '先重后轻' }],
    prompts: [
      { id: 'ph', conceptId: 'heavy', kind: 'explain', question: 'heavy?', answer: '答 h', criteria: ['要点 h'] },
      { id: 'pl', conceptId: 'light', kind: 'explain', question: 'light?', answer: '答 l', criteria: ['要点 l'] },
    ],
    ...overrides,
  });
}

function roundArgs(dir, extra) {
  return ['round', '--out', dir, ...extra];
}

// ---------------------------------------------------------------------------
// Pure library surface
// ---------------------------------------------------------------------------

test('round library is portable: no imports and no Node-only globals', () => {
  const source = readFile(ROUND_LIB_PATH);
  assert.equal(/^\s*import\s/m.test(source), false, 'round.mjs must not import anything');
  for (const forbidden of ['require(', 'process.', 'fs.', 'path.', 'node:', 'Buffer', 'globalThis']) {
    assert.equal(source.includes(forbidden), false, `round.mjs must not use ${forbidden}`);
  }
  // Every imperative helper is namespaced so it can never shadow a viewer name.
  const functionNames = [...source.matchAll(/^function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  for (const name of functionNames) {
    assert.ok(name.startsWith('round'), `${name} must be round*-prefixed to avoid viewer collisions`);
  }
});

test('applyRound returns a new state, never mutating the input, and reports the round', () => {
  const model = chainModel();
  const base = createState(model, '2026-10-09T00:00:00Z');
  const frozen = JSON.stringify(base);
  const { state, round } = applyLearningRound(base, model, {
    action: 'create', roundId: 'round-1', entry: 'organize-existing-material',
    goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z');
  assert.equal(round.id, 'round-1');
  assert.equal(round.entry, 'organize-existing-material');
  assert.equal(round.status, 'active');
  assert.equal(JSON.stringify(base), frozen, 'input state is untouched');
  assert.notEqual(state, base);
  assert.equal(state.activeRoundId, 'round-1');
  assert.ok(state.revision > base.revision);
});

test('learn-new-topic opens diagnosing, defers the route, and gates submissions', () => {
  const model = chainModel();
  const base = createState(model, '2026-10-09T00:00:00Z');
  const { state, round } = applyLearningRound(base, model, {
    action: 'create', roundId: 'round-new', entry: 'learn-new-topic',
    goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z');
  assert.equal(round.status, 'diagnosing');
  const diagnostic = round.tasks.find((t) => t.diagnostic);
  assert.ok(diagnostic, 'a diagnostic task is prepared');
  assert.equal(round.currentTaskId, diagnostic.id, 'the diagnostic task is the current position');
  assert.ok(round.tasks.filter((t) => !t.diagnostic).every((t) => t.deferred), 'the route is deferred until confirmation');

  // A non-diagnostic submission can never bypass the new-topic diagnosis.
  assert.throws(
    () => validateLearningRoundBinding(state, model, { roundId: 'round-new', taskId: 'pb' }),
    (err) => err.code === 'E_CONFLICT',
  );
  // Confirming before a real answer is refused.
  assert.throws(
    () => applyLearningRound(state, model, { action: 'confirm-diagnosis', roundId: 'round-new' }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('diagnostic real submission then confirm-diagnosis opens the route', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  let round = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-new', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').round;
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-new', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const diagnostic = round.tasks.find((t) => t.diagnostic);

  let practiced = applyPractice(state, model, {
    promptId: diagnostic.promptId, sessionId: 'sess-diag', draft: '我的初步想法',
    roundId: 'round-new', taskId: diagnostic.id,
  }, '2026-10-09T00:30:00Z');
  assert.equal(practiced.session.roundId, 'round-new');
  assert.equal(practiced.session.taskId, diagnostic.id);
  const submitted = applySubmission(practiced.state, model, {
    promptId: diagnostic.promptId, sessionId: 'sess-diag', attemptId: 'att-diag',
    answer: '真实的诊断回答', roundId: 'round-new', taskId: diagnostic.id,
  }, '2026-10-09T01:00:00Z');
  assert.equal(submitted.attempt.roundId, 'round-new');
  assert.equal(submitted.attempt.taskId, diagnostic.id);
  assert.equal(submitted.attempt.rating, null, 'submission is saved without self-assessment');

  const view = learningRoundView(submitted.state, model, 'round-new');
  assert.equal(view.tasks.find((t) => t.diagnostic).submitted, true);

  const confirmed = applyLearningRound(submitted.state, model, {
    action: 'confirm-diagnosis', roundId: 'round-new',
  }, '2026-10-09T02:00:00Z');
  assert.equal(confirmed.round.status, 'active');
  const routeOpen = confirmed.round.tasks.filter((t) => !t.deferred && !t.diagnostic);
  assert.ok(routeOpen.length > 0, 'the route opens with at least one active task');
  // Confirmation moves the position past the completed diagnosis to the first
  // outstanding route task.
  assert.equal(confirmed.round.currentTaskId, routeOpen[0].id);
});

test('no budget keeps one focused unit plus prerequisites; a budget defers the rest', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  const noBudget = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-focus', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z');
  const firstTargetIndex = noBudget.round.tasks.findIndex((t) => t.conceptId === 'c');
  assert.ok(firstTargetIndex >= 2, 'prerequisites a and b precede the target c');
  const focused = noBudget.round.tasks.filter((t) => !t.deferred).map((t) => t.conceptId);
  assert.deepEqual(focused, ['a', 'b', 'c'], 'the focused unit is c plus its full prerequisite chain');
  assert.ok(noBudget.round.tasks.every((t) => !t.deferred), 'no other targets exist to defer');

  // A budget that only fits the prerequisites defers the target with a reason.
  const budgeted = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-budget', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 30,
  }, '2026-10-09T00:00:00Z');
  const deferred = budgeted.round.tasks.filter((t) => t.deferred);
  assert.ok(deferred.length >= 1, 'tasks beyond the budget are deferred');
  assert.ok(deferred.every((t) => typeof t.deferredReason === 'string' && t.deferredReason.includes('预算')));

  // Two targets: the unrelated d stays scheduled when a large budget allows it.
  const wide = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-wide', entry: 'organize-existing-material', goal: '掌握 C 与 D', conceptIds: ['c', 'd'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z');
  assert.ok(wide.round.tasks.some((t) => t.conceptId === 'd' && !t.deferred), 'd is scheduled within a sufficient budget');
});

test('adjusting goal and budget keeps the round identity, submitted work and history', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-adjust', entry: 'organize-existing-material',
    goal: '先学 C', conceptIds: ['c'], budgetMinutes: 30,
  }, '2026-10-09T00:00:00Z').state;
  const before = state.learningRounds['round-adjust'];
  const taskA = before.tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, {
    promptId: taskA.promptId, sessionId: 's-1', draft: 'draft', roundId: 'round-adjust', taskId: taskA.id,
  }, '2026-10-09T00:10:00Z');
  state = applySubmission(practiced.state, model, {
    promptId: taskA.promptId, sessionId: 's-1', attemptId: 'att-1', answer: '第一个作答',
    roundId: 'round-adjust', taskId: taskA.id,
  }, '2026-10-09T00:20:00Z').state;

  const updated = applyLearningRound(state, model, {
    action: 'update', roundId: 'round-adjust', goal: '学完 C 与 D', budgetMinutes: 120, conceptIds: ['c', 'd'],
  }, '2026-10-09T01:00:00Z');
  assert.equal(updated.round.id, 'round-adjust');
  assert.equal(updated.round.goal, '学完 C 与 D');
  assert.equal(updated.round.budgetMinutes, 120);
  assert.ok(updated.round.history.some((h) => h.action === 'create'));
  assert.ok(updated.round.history.some((h) => h.action === 'update'));
  // The earlier submission (and its identity) survives the adjustment.
  const attempt = updated.state.attempts[taskA.promptId].find((a) => a.id === 'att-1');
  assert.equal(attempt.roundId, 'round-adjust');
  assert.equal(attempt.taskId, taskA.id);
  const view = learningRoundView(updated.state, model, 'round-adjust');
  assert.ok(view.tasks.some((t) => t.submitted), 'the submitted task still reads as submitted');
});

test('pause stores the pause position and resume restores the same task', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-pause', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const position = state.learningRounds['round-pause'].currentTaskId;

  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-pause' }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-pause'].status, 'paused');
  assert.equal(state.learningRounds['round-pause'].currentTaskId, position, 'pause records the position, not a new one');

  state = applyLearningRound(state, model, { action: 'resume', roundId: 'round-pause' }, '2026-10-09T02:00:00Z').state;
  assert.equal(state.learningRounds['round-pause'].status, 'active');
  assert.equal(state.learningRounds['round-pause'].currentTaskId, position, 'resume continues at the same task');
});

test('cross-round drafts cannot be moved into a new round, but unbound legacy work stays valid', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-x', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const taskX = state.learningRounds['round-x'].tasks.find((t) => !t.deferred);
  state = applyPractice(state, model, {
    promptId: taskX.promptId, sessionId: 'sess-x', draft: 'x draft', roundId: 'round-x', taskId: taskX.id,
  }, '2026-10-09T00:10:00Z').state;

  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-y', entry: 'organize-existing-material', goal: '掌握 D', conceptIds: ['d'],
  }, '2026-10-09T01:00:00Z').state;
  const taskY = state.learningRounds['round-y'].tasks.find((t) => !t.deferred);
  // Reusing the session under the new round must fail instead of relocating a draft.
  assert.throws(
    () => applyPractice(state, model, {
      promptId: taskX.promptId, sessionId: 'sess-x', draft: 'relocated',
      roundId: 'round-y', taskId: taskY.id,
    }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
  // A submission whose session belongs to another round is likewise refused.
  assert.throws(
    () => applySubmission(state, model, {
      promptId: taskX.promptId, sessionId: 'sess-x', attemptId: 'att-x', answer: 'x',
      roundId: 'round-y', taskId: taskY.id,
    }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );

  // Unbound legacy work still records and stays valid.
  const legacy = applySubmission(state, model, {
    promptId: 'pd', sessionId: null, attemptId: 'att-legacy', answer: 'legacy answer',
  }, '2026-10-09T03:00:00Z');
  const attempt = legacy.state.attempts.pd.find((a) => a.id === 'att-legacy');
  assert.equal('roundId' in attempt, false, 'an unbound attempt records no roundId');
  assert.equal('taskId' in attempt, false);
  assert.deepEqual(validateLearningRoundBinding(legacy.state, model, {}), {});
});

test('validateRounds accepts legacy archives without rounds and rejects malformed ones', () => {
  const model = chainModel();
  assert.equal(validateLearningRounds({}, model), true);
  const legacy = createState(model);
  delete legacy.learningRounds;
  delete legacy.activeRoundId;
  assert.equal(validateLearningRounds(legacy, model), true);
  const normalized = normalizeState(legacy, model);
  assert.deepEqual(normalized.learningRounds, {}, 'legacy archive reads as no rounds');
  assert.equal(normalized.activeRoundId, null);

  assert.throws(() => validateLearningRounds({ learningRounds: { 'r-1': { id: 'r-2' } } }, model),
    (err) => err.code === 'E_STATE');
  assert.throws(() => validateLearningRounds({ learningRounds: {}, activeRoundId: 'missing' }, model),
    (err) => err.code === 'E_STATE');
});

// ---------------------------------------------------------------------------
// Public CLI
// ---------------------------------------------------------------------------

test('CLI round create and round-read expose the goal, order, budget and remaining tasks', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  const built = buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  assert.equal(built.state.activeRoundId, null, 'a fresh build has no active round');

  const created = runJson(roundArgs(dir, [
    '--action', 'create', '--round-id', 'round-cli',
    '--entry', 'organize-existing-material', '--goal', '掌握 C', '--concept', 'c', '--minutes', '30',
  ]));
  assert.equal(created.saved, true);
  assert.equal(created.round.id, 'round-cli');
  assert.equal(created.round.status, 'active');
  assert.ok(created.round.tasks.some((task) => task.deferred), 'budget defers later tasks');

  const read = runJson(['round-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.activeRoundId, 'round-cli');
  assert.equal(read.round.goal, '掌握 C');
  assert.equal(read.round.budgetMinutes, 30);
  const firstTask = read.round.tasks[0];
  assert.ok(firstTask.conceptTitle, 'the view names the concept');
  assert.ok(firstTask.reason, 'the view explains why the task is first');
  assert.ok(Array.isArray(firstTask.completionCriteria) && firstTask.completionCriteria.length > 0);
  assert.equal(typeof read.round.remainingTasks, 'number');

  // Restart-independent readback: a second invocation sees the same route.
  const again = runJson(['round-read', '--out', dir, '--round-id', 'round-cli']);
  assert.deepEqual(again.round.tasks.map((task) => task.id), read.round.tasks.map((task) => task.id));
});

test('CLI round update/pause/resume/focus/confirm-diagnosis drive the same round', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });

  runJson(roundArgs(dir, ['--action', 'create', '--round-id', 'round-cli', '--entry', 'learn-new-topic',
    '--goal', '掌握 C', '--concept', 'c']));
  const diag = runJson(['round-read', '--out', dir]).round.tasks.find((task) => task.diagnostic);
  assert.ok(diag, 'new-topic round exposes a diagnostic task');

  // Non-diagnostic submission is refused with a conflict.
  const blocked = runCli(['submit', '--out', dir, '--prompt', 'pb', '--answer', '绕过', '--attempt-id', 'att-blocked',
    '--round-id', 'round-cli', '--task-id', runJson(['round-read', '--out', dir]).round.tasks.find((task) => !task.diagnostic).id]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /E_CONFLICT/);

  // A real diagnostic draft + submission, then confirm-diagnosis.
  assert.equal(runCli(['practice', '--out', dir, '--prompt', diag.promptId, '--session-id', 'sess-diag',
    '--draft', '想法', '--round-id', 'round-cli', '--task-id', diag.id]).status, 0);
  assert.equal(runCli(['submit', '--out', dir, '--prompt', diag.promptId, '--session-id', 'sess-diag',
    '--answer', '真实诊断回答', '--attempt-id', 'att-diag',
    '--round-id', 'round-cli', '--task-id', diag.id]).status, 0);
  const confirmed = runJson(roundArgs(dir, ['--action', 'confirm-diagnosis', '--round-id', 'round-cli']));
  assert.equal(confirmed.round.status, 'active');

  const paused = runJson(roundArgs(dir, ['--action', 'pause', '--round-id', 'round-cli']));
  assert.equal(paused.round.status, 'paused');
  const resumed = runJson(roundArgs(dir, ['--action', 'resume', '--round-id', 'round-cli']));
  assert.equal(resumed.round.status, 'active');

  const updated = runJson(roundArgs(dir, ['--action', 'update', '--round-id', 'round-cli',
    '--goal', '掌握 C 与 D', '--concept', 'c', '--concept', 'd', '--minutes', 'none']));
  assert.equal(updated.round.budgetMinutes, null);
  assert.equal(updated.round.conceptIds.length, 2);
});

test('CLI reads a legacy archive with no rounds as history-unknown instead of erroring', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  // Record real work without any round (the legacy shape the ticket must honor).
  assert.equal(runCli(['submit', '--out', dir, '--prompt', 'pb', '--answer', '历史作答', '--attempt-id', 'att-legacy']).status, 0);

  const read = runJson(['round-read', '--out', dir]);
  assert.equal(read.present, false);
  assert.equal(read.activeRoundId, null);
  assert.deepEqual(read.rounds, []);
  // The durable archive keeps the unbound attempt.
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.attempts.pb[0].roundId, undefined);
});

// ---------------------------------------------------------------------------
// Public HTTP
// ---------------------------------------------------------------------------

test('POST /api/round creates and reads back a round, and bound submits record the identity', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });

  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    const created = await postJson(`${s.url}/api/round`, {
      revision: current.state.revision,
      modelFingerprint: current.modelFingerprint,
      action: 'create', roundId: 'round-http', entry: 'organize-existing-material',
      goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 45,
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    current = created.json;
    assert.equal(current.state.activeRoundId, 'round-http');
    // GET /api/state carries the durable rounds back.
    assert.ok(current.state.learningRounds['round-http']);

    const task = current.state.learningRounds['round-http'].tasks.find((t) => !t.deferred);
    const practice = await postJson(`${s.url}/api/practice`, {
      revision: current.state.revision, modelFingerprint: current.modelFingerprint,
      promptId: task.promptId, sessionId: 'http-session', draft: 'http draft',
      roundId: 'round-http', taskId: task.id,
    });
    assert.equal(practice.status, 200, JSON.stringify(practice.json));
    current = practice.json;

    const submitted = await postJson(`${s.url}/api/submit`, {
      revision: current.state.revision, modelFingerprint: current.modelFingerprint,
      promptId: task.promptId, sessionId: 'http-session', attemptId: 'att-http',
      answer: '通过 HTTP 提交的真实作答', roundId: 'round-http', taskId: task.id,
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
    const attempt = submitted.json.state.attempts[task.promptId].find((a) => a.id === 'att-http');
    assert.equal(attempt.roundId, 'round-http');
    assert.equal(attempt.taskId, task.id);

    // A binding to a task that does not exist is refused with a conflict.
    const bad = await postJson(`${s.url}/api/submit`, {
      revision: submitted.json.state.revision, modelFingerprint: submitted.json.modelFingerprint,
      promptId: task.promptId, sessionId: null, attemptId: 'att-bad',
      answer: 'bad', roundId: 'round-http', taskId: 'task-does-not-exist',
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.code, 'E_CONFLICT');
  });
});

test('POST /api/round rejects missing modelFingerprint and stale revision without writing', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  const before = readFile(path.join(dir, 'state.json'));

  await withServer(dir, async (s) => {
    const missing = await postJson(`${s.url}/api/round`, {
      revision: 0, action: 'create', roundId: 'round-x', goal: 'x', conceptIds: ['c'],
    });
    assert.equal(missing.status, 400);
    const current = await (await fetch(`${s.url}/api/state`)).json();
    const stale = await postJson(`${s.url}/api/round`, {
      revision: current.state.revision + 250, modelFingerprint: current.modelFingerprint,
      action: 'create', roundId: 'round-x', goal: 'x', conceptIds: ['c'],
    });
    assert.equal(stale.status, 409);
  });
  assert.equal(readFile(path.join(dir, 'state.json')), before, 'rejected requests never write');
});

// ---------------------------------------------------------------------------
// Independent-review fixes
// ---------------------------------------------------------------------------

test('fix 1: pausing a diagnosing round and resuming restores diagnosing, not active', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-d', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  assert.equal(state.learningRounds['round-d'].status, 'diagnosing');

  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-d' }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-d'].status, 'paused');
  assert.equal(state.learningRounds['round-d'].resumeStatus, 'diagnosing', 'the pre-pause status is recorded');

  state = applyLearningRound(state, model, { action: 'resume', roundId: 'round-d' }, '2026-10-09T02:00:00Z').state;
  assert.equal(state.learningRounds['round-d'].status, 'diagnosing', 'resume does not silently bypass diagnosis');
  // The route stays gated: a non-diagnostic submission is still refused.
  const nonDiag = state.learningRounds['round-d'].tasks.find((t) => !t.diagnostic);
  assert.throws(
    () => applySubmission(state, model, { promptId: nonDiag.promptId, attemptId: 'x', answer: 'a', roundId: 'round-d', taskId: nonDiag.id }, '2026-10-09T03:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('fix 1: pausing a completed round and resuming restores completed', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-cpl', entry: 'organize-existing-material', goal: '掌握 A', conceptIds: ['a'],
  }, '2026-10-09T00:00:00Z').state;
  const task = state.learningRounds['round-cpl'].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: task.promptId, sessionId: 's', draft: 'd', roundId: 'round-cpl', taskId: task.id }, '2026-10-09T00:10:00Z');
  state = applySubmission(practiced.state, model, { promptId: task.promptId, sessionId: 's', attemptId: 'att', answer: 'a', roundId: 'round-cpl', taskId: task.id }, '2026-10-09T00:20:00Z').state;
  assert.equal(state.learningRounds['round-cpl'].status, 'completed', 'all open work submitted closes the round');

  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-cpl' }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-cpl'].resumeStatus, 'completed');
  state = applyLearningRound(state, model, { action: 'resume', roundId: 'round-cpl' }, '2026-10-09T02:00:00Z').state;
  assert.equal(state.learningRounds['round-cpl'].status, 'completed', 'a finished round stays finished');
});

test('fix 2: a task binding must match the prompt, or the write is refused', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-id', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-id'].tasks.find((t) => t.conceptId === 'a');
  // Answering prompt `pc` (concept c) but claiming taskA (concept a, prompt pa).
  assert.throws(
    () => validateLearningRoundBinding(state, model, { roundId: 'round-id', taskId: taskA.id, promptId: 'pc' }),
    (err) => err.code === 'E_CONFLICT',
  );
  assert.throws(
    () => applySubmission(state, model, { promptId: 'pc', sessionId: null, attemptId: 'a1', answer: 'x', roundId: 'round-id', taskId: taskA.id }, '2026-10-09T00:30:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
  // The matching prompt still binds.
  assert.deepEqual(
    validateLearningRoundBinding(state, model, { roundId: 'round-id', taskId: taskA.id, promptId: 'pa' }),
    { roundId: 'round-id', taskId: taskA.id },
  );
});

test('fix 2: a stale-fingerprint task refuses new work but an idempotent retry still succeeds', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-stale', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-stale'].tasks.find((t) => t.conceptId === 'a');
  const practiced = applyPractice(state, model, { promptId: 'pa', sessionId: 's', draft: 'd', roundId: 'round-stale', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: 'pa', sessionId: 's', attemptId: 'att-a', answer: 'a 的作答', roundId: 'round-stale', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;

  // The concept changes, so taskA's stored fingerprint is now stale.
  const changed = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'a' ? { ...c, explanation: '完全改写的 A 解释' } : c)) });
  const synced = syncModel(state, changed, '2026-10-09T01:00:00Z').state;

  // Replaying the exact same submission is idempotent even though content moved.
  const replay = applySubmission(synced, changed, { promptId: 'pa', sessionId: 's', attemptId: 'att-a', answer: 'a 的作答', roundId: 'round-stale', taskId: taskA.id }, '2026-10-09T02:00:00Z');
  assert.equal(replay.attempt.id, 'att-a');
  // A *new* answer to the now-stale task is refused.
  assert.throws(
    () => applySubmission(synced, changed, { promptId: 'pa', sessionId: null, attemptId: 'att-new', answer: '新作答', roundId: 'round-stale', taskId: taskA.id }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('fix 3: a paused round rejects a new submission but acknowledges a replay', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-p', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-p'].tasks.find((t) => t.conceptId === 'a');
  const practiced = applyPractice(state, model, { promptId: 'pa', sessionId: 's', draft: 'd', roundId: 'round-p', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: 'pa', sessionId: 's', attemptId: 'att-p', answer: '已提交作答', roundId: 'round-p', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;
  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-p' }, '2026-10-09T01:00:00Z').state;

  const taskB = state.learningRounds['round-p'].tasks.find((t) => t.conceptId === 'b');
  assert.throws(
    () => applySubmission(state, model, { promptId: 'pb', sessionId: null, attemptId: 'att-new-b', answer: '暂停时新作答', roundId: 'round-p', taskId: taskB.id }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
  // The already-recorded attempt replays without a spurious conflict.
  const replay = applySubmission(state, model, { promptId: 'pa', sessionId: 's', attemptId: 'att-p', answer: '已提交作答', roundId: 'round-p', taskId: taskA.id }, '2026-10-09T02:00:00Z');
  assert.equal(replay.attempt.id, 'att-p');
});

test('fix 4: an expensive prerequisite is never skipped to schedule a cheaper descendant', () => {
  const model = heavyPrerequisiteModel();
  const state = createState(model, '2026-10-09T00:00:00Z');
  // Prerequisite "heavy" is difficulty 3 (20 min), descendant "light" is 8 min.
  // A 10-minute budget fits the descendant alone but not the prerequisite, so a
  // prefix budget must defer BOTH rather than hop to the cheaper descendant.
  const round = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-heavy', entry: 'organize-existing-material', goal: '掌握轻量目标', conceptIds: ['light'], budgetMinutes: 10,
  }, '2026-10-09T00:00:00Z').round;
  const heavy = round.tasks.find((t) => t.conceptId === 'heavy');
  const light = round.tasks.find((t) => t.conceptId === 'light');
  assert.ok(heavy.estimatedMinutes > 10, 'the prerequisite does not fit the budget');
  assert.equal(heavy.deferred, true, 'the prerequisite is deferred, not scheduled');
  assert.equal(light.deferred, true, 'the descendant is deferred behind its prerequisite');
  assert.equal(round.tasks.every((t) => t.deferred), true, 'nothing out of order is scheduled');
  // The route order still lists the prerequisite first.
  assert.ok(round.tasks.findIndex((t) => t.conceptId === 'heavy') < round.tasks.findIndex((t) => t.conceptId === 'light'));
});

test('fix 5: stale attempts do not count as submitted; a content update re-opens the task', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-count', entry: 'organize-existing-material', goal: '掌握 A', conceptIds: ['a'],
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-count'].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: taskA.promptId, sessionId: 's', draft: 'd', roundId: 'round-count', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: taskA.promptId, sessionId: 's', attemptId: 'att', answer: '回答', roundId: 'round-count', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;
  let view = learningRoundView(state, model, 'round-count');
  assert.equal(view.tasks[0].submitted, true);
  assert.equal(view.remainingTasks, 0);
  assert.equal(view.allSubmitted, true);

  // Change concept a -> the stored attempt fingerprint is now stale.
  const changed = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'a' ? { ...c, explanation: '新的 A 解释' } : c)) });
  const synced = syncModel(state, changed, '2026-10-09T01:00:00Z').state;
  view = learningRoundView(synced, changed, 'round-count');
  assert.equal(view.tasks[0].submitted, false, 'a stale submission is not counted as submitted');
  assert.equal(view.tasks[0].contentUpdated, true);
  assert.equal(view.tasks[0].staleSubmissions, 1, 'the historical work is reported');
  assert.equal(view.remainingTasks, 1, 'the task is pending again');
  assert.equal(view.allSubmitted, false);
});

test('fix 6: changing the target archives a removed task and keeps its submission visible', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // Two independent targets (a and d) so retargeting to c removes d.
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-arc', entry: 'organize-existing-material', goal: '掌握 A 与 D', conceptIds: ['a', 'd'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').state;
  const taskD = state.learningRounds['round-arc'].tasks.find((t) => t.conceptId === 'd');
  assert.ok(taskD && !taskD.deferred, 'd is an active task in the wide round');
  const practiced = applyPractice(state, model, { promptId: taskD.promptId, sessionId: 's', draft: 'd', roundId: 'round-arc', taskId: taskD.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: taskD.promptId, sessionId: 's', attemptId: 'att-d', answer: 'D 的作答', roundId: 'round-arc', taskId: taskD.id }, '2026-10-09T00:10:00Z').state;
  assert.ok(state.learningRounds['round-arc'].tasks.some((t) => t.id === taskD.id));

  // Retarget the round to concept c: task d (and its submission) must not vanish.
  state = applyLearningRound(state, model, {
    action: 'update', roundId: 'round-arc', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T01:00:00Z').state;
  const round = state.learningRounds['round-arc'];
  assert.equal(round.tasks.some((t) => t.id === taskD.id), false, 'the removed task leaves the active route');
  assert.ok(round.archivedTasks.some((t) => t.id === taskD.id), 'the removed task is archived with its original id');
  const attempt = state.attempts[taskD.promptId].find((a) => a.id === 'att-d');
  assert.equal(attempt.taskId, taskD.id, 'the original submission still points at the original task id');

  const view = learningRoundView(state, model, 'round-arc');
  const archived = view.archivedTasks.find((t) => t.id === taskD.id);
  assert.ok(archived, 'the archived task is visible in the view');
  assert.equal(archived.excluded, true);
  assert.equal(archived.submitted, true, 'its earlier submission stays visible');
  assert.equal(view.tasks.some((t) => t.id === taskD.id), false, 'it is not an active task');
});

test('fix 7: metadata-less needs-work evidence does not reorder the route', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // Evidence on prerequisite `a` with no conceptFingerprint and no attemptIds:
  // it is unknown, so it must not mark `a` as a confirmed gap.
  state.conceptEvidence = { a: { status: 'needs-work', note: '手写但没有依据', at: '2026-10-09T00:00:00Z' } };
  const round = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-gap', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').round;
  const aTask = round.tasks.find((t) => t.conceptId === 'a');
  assert.ok(aTask, 'a is a prerequisite of the target and stays in the route');
  assert.equal(aTask.reason.includes('当前有效的需要补缺口'), false, 'metadata-less evidence is not a confirmed gap');
  // Now a proper validated needs-work record on a prerequisite should be honored.
  const model2 = chainModel();
  let state2 = createState(model2, '2026-10-09T00:00:00Z');
  state2 = applyPractice(state2, model2, { promptId: 'pa', sessionId: 's', draft: 'd' }, '2026-10-09T00:00:00Z').state;
  state2 = applySubmission(state2, model2, { promptId: 'pa', sessionId: 's', attemptId: 'att-a', answer: 'a 作' }, '2026-10-09T00:01:00Z').state;
  const evidenced = applyTutorEvidence(state2, model2, { conceptId: 'a', status: 'needs-work', note: '基础不足', attemptIds: ['att-a'] }, '2026-10-09T00:02:00Z').state;
  const reason = applyLearningRound(evidenced, model2, {
    action: 'create', roundId: 'round-gap2', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 60,
  }, '2026-10-09T00:03:00Z').round.tasks.find((t) => t.conceptId === 'a');
  assert.match(reason.reason, /当前有效的需要补缺口/);
});

test('fix 8: a learning round is never labeled artifact-only', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-art', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  assert.equal(learningRoundView(state, model, 'round-art').artifactOnly, false);
});

test('fix 9: creating a round with entry=resume is refused; resume only continues', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  assert.throws(
    () => applyLearningRound(state, model, { action: 'create', roundId: 'round-r', entry: 'resume', goal: 'g', conceptIds: ['c'] }, '2026-10-09T00:00:00Z'),
    (err) => err.code === 'E_USAGE',
  );
  // resume requires an existing round.
  assert.throws(
    () => applyLearningRound(state, model, { action: 'resume', roundId: 'round-missing' }, '2026-10-09T00:00:00Z'),
    (err) => err.code === 'E_STATE',
  );
});

test('completion criteria are observable kind goals and never leak the answer rubric', () => {
  // A prompt whose author rubric literally contains the answer, like the sample
  // "20和30" that leaked before the learner answered.
  const model = normalizeModel({
    schemaVersion: 1,
    id: 'round-leak',
    title: '泄漏检查',
    goal: '掌握泄漏检查目标',
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: '根解释' },
      { id: 'x', title: '目标 X', parentId: 'root', difficulty: 2, explanation: 'X 解释' },
    ],
    prompts: [
      { id: 'px', conceptId: 'x', kind: 'apply', question: '总量是多少？', answer: '20 和 30', criteria: ['20和30', '先算真阳性'] },
    ],
  });
  let state = createState(model, '2026-10-09T00:00:00Z');
  const round = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-leak', entry: 'organize-existing-material', goal: '掌握 X', conceptIds: ['x'],
  }, '2026-10-09T00:00:00Z').round;
  const task = round.tasks[0];
  const flat = JSON.stringify(task.completionCriteria);
  assert.equal(flat.includes('20和30'), false, 'the author rubric must not leak');
  assert.equal(flat.includes('20'), false, 'the answer text must not leak');
  assert.equal(flat.includes('先算真阳性'), false, 'author-only criteria must not be copied');
  assert.ok(task.completionCriteria.length > 0, 'observable goals are still present');

  // A new-topic diagnostic task must also avoid the rubric.
  const diagRound = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-leak-diag', entry: 'learn-new-topic', goal: '掌握 X', conceptIds: ['x'],
  }, '2026-10-09T00:00:00Z').round;
  const diagnostic = diagRound.tasks.find((t) => t.diagnostic);
  const diagText = JSON.stringify(diagnostic.completionCriteria);
  assert.equal(diagText.includes('20'), false);
  assert.equal(diagText.includes('先算真阳性'), false);
});

// Helper: build a one-target round over concept a and complete it.
function completedRoundState(model, roundId = 'round-done') {
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId, entry: 'organize-existing-material', goal: '掌握 A', conceptIds: ['a'],
  }, '2026-10-09T00:00:00Z').state;
  const task = state.learningRounds[roundId].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: task.promptId, sessionId: 's', draft: 'd', roundId, taskId: task.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: task.promptId, sessionId: 's', attemptId: 'att-done', answer: '完成作答', roundId, taskId: task.id }, '2026-10-09T00:10:00Z').state;
  return { state, task };
}

test('readback: a completed round whose content changed no longer claims completion', () => {
  const model = chainModel();
  const done = completedRoundState(model);
  assert.equal(done.state.learningRounds['round-done'].status, 'completed');
  assert.equal(learningRoundView(done.state, model, 'round-done').allSubmitted, true);

  // Concept a changes: the stored attempt fingerprint is now stale.
  const changed = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'a' ? { ...c, explanation: '改写后的 A 解释' } : c)) });
  const synced = syncModel(done.state, changed, '2026-10-09T01:00:00Z').state;
  const view = learningRoundView(synced, changed, 'round-done');
  assert.equal(view.status, 'active', 'effective status reflects the reappearing work');
  assert.equal(view.storedStatus, 'completed', 'the historical stored status is preserved');
  assert.equal(view.remainingTasks, 1);
  assert.equal(view.allSubmitted, false, 'completion is not falsely claimed');
});

test('readback: updating a stale-completed round reactivates the remaining current work', () => {
  const model = chainModel();
  const done = completedRoundState(model, 'round-upd');
  const changed = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'a' ? { ...c, explanation: '新的 A 解释' } : c)) });
  const synced = syncModel(done.state, changed, '2026-10-09T01:00:00Z').state;

  const updated = applyLearningRound(synced, changed, {
    action: 'update', roundId: 'round-upd', goal: '重新掌握 A',
  }, '2026-10-09T02:00:00Z').round;
  assert.equal(updated.status, 'active', 'the stale completion re-opens on update');
  const view = learningRoundView({ ...synced, learningRounds: { ...synced.learningRounds, 'round-upd': updated } }, changed, 'round-upd');
  assert.equal(view.remainingTasks >= 1, true);
  assert.equal(view.allSubmitted, false);
});

test('readback: pausing a completed round, expanding budget while paused, then resuming re-opens work', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // A budget of 8 fits only the 8-minute prerequisite `a`, leaving `b`/`c` deferred.
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-expand', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 8,
  }, '2026-10-09T00:00:00Z').state;
  const firstTask = state.learningRounds['round-expand'].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: firstTask.promptId, sessionId: 's', draft: 'd', roundId: 'round-expand', taskId: firstTask.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: firstTask.promptId, sessionId: 's', attemptId: 'att-1', answer: '第一个', roundId: 'round-expand', taskId: firstTask.id }, '2026-10-09T00:10:00Z').state;
  assert.equal(state.learningRounds['round-expand'].status, 'completed', 'only the open task needed submitting');

  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-expand' }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-expand'].resumeStatus, 'completed');
  // Expand the budget while paused so previously-deferred tasks become open.
  state = applyLearningRound(state, model, {
    action: 'update', roundId: 'round-expand', budgetMinutes: 120,
  }, '2026-10-09T01:30:00Z').state;
  // The learner only edited while paused: the round stays paused, but its
  // remembered status flips to active because real work is now open.
  assert.equal(state.learningRounds['round-expand'].status, 'paused', 'an update does not resume a paused round');
  assert.equal(state.learningRounds['round-expand'].resumeStatus, 'active', 'resume will reopen the expanded work');
  const open = state.learningRounds['round-expand'].tasks.filter((t) => !t.deferred);
  assert.ok(open.length > 1, 'the expansion added open tasks');

  const resume = applyLearningRound(state, model, { action: 'resume', roundId: 'round-expand' }, '2026-10-09T02:00:00Z').round;
  assert.equal(resume.status, 'active', 'resume does not restore a false completion');
  const view = learningRoundView({ ...state, learningRounds: { ...state.learningRounds, 'round-expand': resume } }, model, 'round-expand');
  assert.ok(view.remainingTasks >= 1, 'real work remains after resume');
  assert.equal(view.allSubmitted, false);
});

test('paused diagnosing round: editing goal/budget keeps the diagnostic gate', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-pd', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-pd' }, '2026-10-09T01:00:00Z').state;
  // Editing while paused must not un-gate the formal route.
  state = applyLearningRound(state, model, { action: 'update', roundId: 'round-pd', budgetMinutes: 120 }, '2026-10-09T01:30:00Z').state;
  assert.equal(state.learningRounds['round-pd'].status, 'paused');
  assert.equal(state.learningRounds['round-pd'].resumeStatus, 'diagnosing', 'still diagnosing underneath the pause');
  const route = state.learningRounds['round-pd'].tasks.filter((t) => !t.diagnostic);
  assert.ok(route.every((t) => t.deferred), 'the formal route stays gated while paused-diagnosing');

  const resumed = applyLearningRound(state, model, { action: 'resume', roundId: 'round-pd' }, '2026-10-09T02:00:00Z').round;
  assert.equal(resumed.status, 'diagnosing');
  const nonDiag = resumed.tasks.find((t) => !t.diagnostic);
  assert.throws(
    () => applySubmission({ ...state, learningRounds: { ...state.learningRounds, 'round-pd': resumed } }, model,
      { promptId: nonDiag.promptId, attemptId: 'x', answer: 'a', roundId: 'round-pd', taskId: nonDiag.id }, '2026-10-09T03:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('changing the target before confirmation rebuilds the diagnostic and archives the old one', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-move', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const original = state.learningRounds['round-move'].tasks.find((t) => t.diagnostic);
  assert.equal(original.conceptId, 'c');
  // Submit a real diagnostic answer to the old target.
  const practiced = applyPractice(state, model, { promptId: original.promptId, sessionId: 's', draft: 'd', roundId: 'round-move', taskId: original.id }, '2026-10-09T00:10:00Z');
  state = applySubmission(practiced.state, model, { promptId: original.promptId, sessionId: 's', attemptId: 'att-old-diag', answer: '旧诊断回答', roundId: 'round-move', taskId: original.id }, '2026-10-09T00:20:00Z').state;
  // Retarget to a different concept before confirming.
  state = applyLearningRound(state, model, {
    action: 'update', roundId: 'round-move', goal: '掌握 D', conceptIds: ['d'],
  }, '2026-10-09T01:00:00Z').state;
  const round = state.learningRounds['round-move'];
  const rebuilt = round.tasks.find((t) => t.diagnostic);
  assert.equal(rebuilt.conceptId, 'd', 'the diagnostic now probes the new target');
  assert.notEqual(rebuilt.id, original.id, 'a fresh diagnostic task replaces the mismatched one');
  assert.ok(round.archivedTasks.some((t) => t.id === original.id), 'the old diagnostic is archived');
  const attempt = state.attempts[original.promptId].find((a) => a.id === 'att-old-diag');
  assert.equal(attempt.taskId, original.id, 'the original diagnostic submission keeps its identity');
  // The route stays gated for the new target too.
  assert.ok(round.tasks.filter((t) => !t.diagnostic).every((t) => t.deferred));
});

// ---------------------------------------------------------------------------
// Build injection & rebuild
// ---------------------------------------------------------------------------

// Attempt and session ids may legally be inherited Object.prototype names (the
// repo has a viewer regression for exactly this). The round library keys internal
// dictionaries by attempt id, so an id like `toString` must resolve to the real
// attempt instead of the inherited member.
test('prototype-named attempt ids resolve correctly in round reads and gap ordering', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-proto', entry: 'organize-existing-material',
    goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-proto'].tasks.find((t) => t.conceptId === 'a');

  // A submission whose attempt id is `toString`, a legal prototype name.
  const practiced = applyPractice(state, model, { promptId: 'pa', sessionId: 'toString', draft: 'd', roundId: 'round-proto', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: 'pa', sessionId: 'toString', attemptId: 'toString', answer: 'a 作答', roundId: 'round-proto', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;
  const view = learningRoundView(state, model, 'round-proto');
  assert.equal(view.tasks.find((t) => t.id === taskA.id).submitted, true, 'a toString attempt id counts as a real submission');
  assert.equal(view.tasks.find((t) => t.id === taskA.id).activeSubmissions, 1);

  // needs-work evidence that names the `toString` attempt must be honored: the
  // attempt lookup must find it rather than fall through to Object.prototype.
  const evidenced = applyTutorEvidence(state, model, { conceptId: 'a', status: 'needs-work', note: '缺基础', attemptIds: ['toString'] }, '2026-10-09T00:20:00Z').state;
  const reason = applyLearningRound(evidenced, model, {
    action: 'create', roundId: 'round-proto-gap', entry: 'organize-existing-material',
    goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 120,
  }, '2026-10-09T00:30:00Z').round.tasks.find((t) => t.conceptId === 'a');
  assert.match(reason.reason, /当前有效的需要补缺口/, 'prototype-named attempt evidence is honored');
});

test('valueOf-named attempt and session ids work as immutable idempotent events', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-vo', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-vo'].tasks.find((t) => t.conceptId === 'a');
  const practiced = applyPractice(state, model, { promptId: 'pa', sessionId: 'valueOf', draft: 'd', roundId: 'round-vo', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: 'pa', sessionId: 'valueOf', attemptId: 'valueOf', answer: 'a 作答', roundId: 'round-vo', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;
  // Replay is idempotent (no duplicate under a prototype-named id).
  const replay = applySubmission(state, model, { promptId: 'pa', sessionId: 'valueOf', attemptId: 'valueOf', answer: 'a 作答', roundId: 'round-vo', taskId: taskA.id }, '2026-10-09T00:20:00Z');
  assert.equal(replay.attempt.id, 'valueOf');
  assert.equal(state.attempts.pa.filter((a) => a.id === 'valueOf').length, 1);
});

test('archive safety: a malformed supplied learningRounds/activeRoundId is rejected, not silently erased', () => {
  const model = chainModel();
  const good = createState(model);

  // Missing buckets stay backwards compatible.
  const legacyRaw = JSON.parse(JSON.stringify(good));
  delete legacyRaw.learningRounds;
  delete legacyRaw.activeRoundId;
  assert.doesNotThrow(() => normalizeState(legacyRaw, model));

  // A supplied malformed learningRounds must be rejected before coercion.
  for (const bad of [[], 'x', 5, true]) {
    const raw = JSON.parse(JSON.stringify(good));
    raw.learningRounds = bad;
    assert.throws(() => normalizeState(raw, model), (err) => err.code === 'E_STATE', `learningRounds=${JSON.stringify(bad)} must be rejected`);
  }
  for (const bad of [5, {}, true, []]) {
    const raw = JSON.parse(JSON.stringify(good));
    raw.activeRoundId = bad;
    assert.throws(() => normalizeState(raw, model), (err) => err.code === 'E_STATE', `activeRoundId=${JSON.stringify(bad)} must be rejected`);
  }
  // Empty string activeRoundId reads as no active round.
  const emptyActive = JSON.parse(JSON.stringify(good));
  emptyActive.activeRoundId = '';
  assert.equal(normalizeState(emptyActive, model).activeRoundId, null);
});

test('archive safety: a rejected forbidden round id never writes a corrupt archive', () => {
  const dir = tmpDir();
  try {
    atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
    buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
    const before = readFile(path.join(dir, 'state.json'));
    const rejected = runCli(['round', '--out', dir, '--action', 'create', '--round-id', 'constructor',
      '--entry', 'organize-existing-material', '--goal', 'g', '--concept', 'c']);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /E_ID/);
    assert.equal(readFile(path.join(dir, 'state.json')), before, 'the archive is untouched');
    const state = readJson(path.join(dir, 'state.json'));
    assert.doesNotThrow(() => normalizeState(state, chainModel()));
  } finally {
    cleanup(dir);
  }
});

test('a prototype-named round id is rejected up front instead of creating an unsaveable round', () => {
  const model = chainModel();
  const state = createState(model, '2026-10-09T00:00:00Z');
  for (const bad of ['constructor', '__proto__', 'prototype']) {
    assert.throws(
      () => applyLearningRound(state, model, { action: 'create', roundId: bad, entry: 'organize-existing-material', goal: 'g', conceptIds: ['c'] }, '2026-10-09T00:00:00Z'),
      (err) => err.code === 'E_ID',
      `round id ${bad} must be rejected before it is created`,
    );
  }
  // A normal id is still accepted, and the resulting state normalizes cleanly.
  const created = applyLearningRound(state, model, { action: 'create', roundId: 'round-ok', entry: 'organize-existing-material', goal: 'g', conceptIds: ['c'] }, '2026-10-09T00:00:00Z').state;
  assert.equal(normalizeState(JSON.parse(JSON.stringify(created)), model).learningRounds['round-ok'].id, 'round-ok');
});

test('merge immutability: attempts and sessions with different round bindings do not merge', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-m1', entry: 'organize-existing-material', goal: '掌握 A', conceptIds: ['a'],
  }, '2026-10-09T00:00:00Z').state;
  const taskA = state.learningRounds['round-m1'].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: taskA.promptId, sessionId: 'shared-session', draft: '草稿', roundId: 'round-m1', taskId: taskA.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: taskA.promptId, sessionId: 'shared-session', attemptId: 'att-m', answer: '作答', roundId: 'round-m1', taskId: taskA.id }, '2026-10-09T00:10:00Z').state;
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-m2', entry: 'organize-existing-material', goal: '掌握 D', conceptIds: ['d'],
  }, '2026-10-09T01:00:00Z').state;
  const taskD = state.learningRounds['round-m2'].tasks.find((t) => !t.deferred);

  // An imported copy binds the SAME attempt/session id to a different task.
  const incoming = JSON.parse(JSON.stringify(state));
  incoming.attempts[taskA.promptId].find((a) => a.id === 'att-m').roundId = 'round-m2';
  incoming.attempts[taskA.promptId].find((a) => a.id === 'att-m').taskId = taskD.id;
  incoming.practiceSessions['shared-session'].roundId = 'round-m2';
  incoming.practiceSessions['shared-session'].taskId = taskD.id;

  const merged = mergeImportedState(state, incoming, model, '2026-10-09T02:00:00Z');
  assert.equal(merged.conflicts.some((c) => c.kind === 'attempt' && c.path.includes('att-m')), true, 'differently-bound attempt is a conflict');
  assert.equal(merged.attempts[taskA.promptId].find((a) => a.id === 'att-m').roundId, 'round-m1', 'the existing binding is kept');
  assert.equal(merged.conflicts.some((c) => c.kind === 'practice' && c.path.includes('shared-session')), true, 'differently-bound session is a conflict');
  assert.equal(merged.practiceSessions['shared-session'].taskId, taskA.id, 'the existing session binding is kept');
});

test('excluded task is read-only: a new submit is refused but an idempotent replay still succeeds', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // Wide round so task d is active, gets a real submission, then is removed.
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-ex', entry: 'organize-existing-material', goal: '掌握 A 与 D', conceptIds: ['a', 'd'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z').state;
  const taskD = state.learningRounds['round-ex'].tasks.find((t) => t.conceptId === 'd');
  const practiced = applyPractice(state, model, { promptId: taskD.promptId, sessionId: 's', draft: 'd', roundId: 'round-ex', taskId: taskD.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: taskD.promptId, sessionId: 's', attemptId: 'att-ex', answer: 'D 作答', roundId: 'round-ex', taskId: taskD.id }, '2026-10-09T00:10:00Z').state;
  state = applyLearningRound(state, model, {
    action: 'update', roundId: 'round-ex', goal: '只掌握 A', conceptIds: ['a'],
  }, '2026-10-09T01:00:00Z').state;
  // task d is now archived (excluded).
  assert.equal(state.learningRounds['round-ex'].tasks.some((t) => t.id === taskD.id), false);
  assert.equal(state.learningRounds['round-ex'].archivedTasks.some((t) => t.id === taskD.id), true);

  // Run the check twice: once with the `excluded` metadata, and once after
  // stripping it, because a legal older archive may omit that optional flag.
  // Membership in `round.tasks` is what makes a task active; the flag is not
  // trusted for the reject decision.
  for (const stripFlag of [false, true]) {
    const candidate = JSON.parse(JSON.stringify(state));
    if (stripFlag) {
      delete candidate.learningRounds['round-ex'].archivedTasks.find((t) => t.id === taskD.id).excluded;
    }
    // A new answer to the removed task must be refused.
    assert.throws(
      () => applySubmission(candidate, model, { promptId: taskD.promptId, sessionId: null, attemptId: 'att-new-ex', answer: '新作答', roundId: 'round-ex', taskId: taskD.id }, '2026-10-09T02:00:00Z'),
      (err) => err.code === 'E_CONFLICT',
      `archivedStripped=${stripFlag}: a new answer to a removed task must be refused`,
    );
    // The already-recorded attempt replays idempotently (identity path still
    // finds the archived task for the retry, but it is not a new write).
    const replay = applySubmission(candidate, model, { promptId: taskD.promptId, sessionId: 's', attemptId: 'att-ex', answer: 'D 作答', roundId: 'round-ex', taskId: taskD.id }, '2026-10-09T02:00:00Z');
    assert.equal(replay.attempt.id, 'att-ex');
    // The normalized archive row still validates even without the flag.
    assert.doesNotThrow(() => normalizeState(JSON.parse(JSON.stringify(candidate)), model));
  }
});

test('roundView never lists the same task id as both active and archived after a retarget round-trip', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // Start with a and d active, then remove d (archiving it), then add d back:
  // the stable task id is active again while its archive row remains on disk.
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-rt', entry: 'organize-existing-material', goal: '掌握 A 与 D', conceptIds: ['a', 'd'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z').state;
  const taskDId = state.learningRounds['round-rt'].tasks.find((t) => t.conceptId === 'd').id;
  state = applyLearningRound(state, model, { action: 'update', roundId: 'round-rt', conceptIds: ['a'] }, '2026-10-09T01:00:00Z').state;
  assert.ok(state.learningRounds['round-rt'].archivedTasks.some((t) => t.id === taskDId), 'd is archived after removal');
  state = applyLearningRound(state, model, { action: 'update', roundId: 'round-rt', conceptIds: ['a', 'd'] }, '2026-10-09T02:00:00Z').state;
  assert.ok(state.learningRounds['round-rt'].tasks.some((t) => t.id === taskDId), 'd returns to the active route');
  // The archive data is retained on disk...
  assert.ok(state.learningRounds['round-rt'].archivedTasks.some((t) => t.id === taskDId), 'archive history is preserved on disk');
  // ...but the read model must not present the same id as active AND excluded.
  const view = learningRoundView(state, model, 'round-rt');
  assert.equal(view.tasks.some((t) => t.id === taskDId), true, 'the id is active in the view');
  assert.equal(view.archivedTasks.some((t) => t.id === taskDId), false, 'the read view filters the stale archive row for an active id');
  assert.equal(view.excludedCount, view.archivedTasks.length);
});

test('update cannot change the entry; repeating the same entry is allowed', () => {
  const model = chainModel();
  // Active materials round cannot be flipped to a new-topic route without diagnosis.
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-e1', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  assert.throws(
    () => applyLearningRound(state, model, { action: 'update', roundId: 'round-e1', entry: 'learn-new-topic', goal: '掌握 C' }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
  // Repeating the same entry is accepted and does not alter the route.
  const same = applyLearningRound(state, model, { action: 'update', roundId: 'round-e1', entry: 'organize-existing-material', goal: '掌握 C' }, '2026-10-09T01:00:00Z').round;
  assert.equal(same.entry, 'organize-existing-material');

  // A diagnosing round cannot be flipped to materials to bypass the gate.
  let diagState = createState(model, '2026-10-09T00:00:00Z');
  diagState = applyLearningRound(diagState, model, {
    action: 'create', roundId: 'round-e2', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  assert.throws(
    () => applyLearningRound(diagState, model, { action: 'update', roundId: 'round-e2', entry: 'organize-existing-material' }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
  // `resume` is never a round's stored entry, so attempting it is refused too.
  assert.throws(
    () => applyLearningRound(diagState, model, { action: 'update', roundId: 'round-e2', entry: 'resume' }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('build inlines the round library at the marker and strips only export keywords', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  const html = readFile(path.join(dir, 'index.html'));
  assert.equal(html.includes('__EMBER_ROUND_LIBRARY__'), false, 'the marker is replaced');
  assert.match(html, /function applyRound\s*\(/, 'applyRound is inlined');
  assert.match(html, /function roundView\s*\(/, 'roundView is inlined');
  assert.equal(/export function applyRound/.test(html), false, 'the export keyword is stripped');

  // A template with no marker is returned unchanged so older minima still build.
  assert.equal(injectRoundLibrary('<html></html>'), '<html></html>');
  const injected = injectRoundLibrary('a/*__EMBER_ROUND_LIBRARY__*/b', 'export function x() {}');
  assert.equal(injected, 'afunction x() {}b');
});

test('the inlined library is the same algorithm the backend runs', async () => {
  const source = readFile(ROUND_LIB_PATH).replace(/^export /gm, '');
  // Evaluate the inlined source in isolation and compare a create against Node.
  const factory = new Function(`${source}\nreturn { applyRound: applyRound, roundView: roundView, validateRoundBinding: validateRoundBinding };`);
  const browser = factory();
  const model = chainModel();
  const base = createState(model, '2026-10-09T00:00:00Z');
  const input = { action: 'create', roundId: 'round-parity', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'] };
  const node = applyLearningRound(base, model, input, '2026-10-09T00:00:00Z');
  const browserResult = browser.applyRound(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(modelToJson(model))), input, '2026-10-09T00:00:00Z');
  assert.deepEqual(browserResult.round.tasks.map((t) => [t.id, t.conceptId, t.deferred]), node.round.tasks.map((t) => [t.id, t.conceptId, t.deferred]));
});

test('a rebuild after building a round preserves the route and bound submissions', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  runJson(roundArgs(dir, ['--action', 'create', '--round-id', 'round-rebuild', '--entry', 'organize-existing-material', '--goal', '掌握 C', '--concept', 'c']));
  const task = runJson(['round-read', '--out', dir]).round.tasks.find((t) => !t.deferred);
  assert.equal(runCli(['practice', '--out', dir, '--prompt', task.promptId, '--session-id', 'sess-r',
    '--draft', '重建草稿', '--round-id', 'round-rebuild', '--task-id', task.id]).status, 0);
  assert.equal(runCli(['submit', '--out', dir, '--prompt', task.promptId, '--session-id', 'sess-r',
    '--answer', '重建后仍应保留', '--attempt-id', 'att-rebuild',
    '--round-id', 'round-rebuild', '--task-id', task.id]).status, 0);

  // Rebuild from the generated model: the route and the bound attempt survive.
  const rebuilt = buildArtifacts({ modelPath: path.join(dir, 'model.json'), outDir: dir, viewerPath: VIEWER });
  assert.ok(rebuilt.state.learningRounds['round-rebuild'], 'the round survives a rebuild');
  const attempt = rebuilt.state.attempts[task.promptId].find((a) => a.id === 'att-rebuild');
  assert.equal(attempt.roundId, 'round-rebuild');
  assert.equal(attempt.taskId, task.id);
});

test('importing an archive merges new rounds and keeps the current route with a reported conflict', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  runJson(roundArgs(dir, ['--action', 'create', '--round-id', 'round-current', '--entry', 'organize-existing-material', '--goal', '当前路线', '--concept', 'c']));
  const exported = path.join(dir, 'exported.json');
  runJson(['export', '--out', dir, '--to', exported]);
  const incoming = readJson(exported);
  // The imported copy adds a second round and diverges on the current one.
  incoming.learningRounds['round-extra'] = {
    ...incoming.learningRounds['round-current'],
    id: 'round-extra', goal: '另一个轮次',
  };
  incoming.learningRounds['round-current'] = { ...incoming.learningRounds['round-current'], goal: '被修改的当前路线' };
  const incomingPath = path.join(dir, 'incoming.json');
  atomicWrite(incomingPath, stableStringify(incoming));

  const merged = runJson(['import', '--out', dir, '--state', incomingPath]);
  assert.equal(merged.imported, true);
  assert.ok(merged.conflicts >= 1, 'the divergent round is reported');
  const state = readJson(path.join(dir, 'state.json'));
  assert.equal(state.learningRounds['round-current'].goal, '当前路线', 'the current route is preserved');
  assert.ok(state.learningRounds['round-extra'], 'the new round is merged in');
  assert.equal(state.activeRoundId, 'round-current');
});

// ---------------------------------------------------------------------------
// review-v2 fixes (F3, F4, R4, R5)
// ---------------------------------------------------------------------------

test('F3: a content edit during a diagnosing round is recoverable via update', () => {
  const model1 = chainModel();
  let state = createState(model1, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model1, {
    action: 'create', roundId: 'round-f3', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const diagBefore = state.learningRounds['round-f3'].tasks.find((t) => t.diagnostic);

  // The author rebuilds the model with a changed explanation for concept c.
  const model2 = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'c' ? { ...c, explanation: '改写的 C 解释' } : c)) });
  assert.notEqual(model1.promptFingerprints[diagBefore.promptId], model2.promptFingerprints[diagBefore.promptId], 'the prompt fingerprint changed');
  const synced = syncModel(state, model2, '2026-10-09T01:00:00Z').state;

  // update must refresh the diagnostic task's metadata/fingerprint in place.
  const updated = applyLearningRound(synced, model2, {
    action: 'update', roundId: 'round-f3',
  }, '2026-10-09T01:00:00Z').round;
  const diagAfter = updated.tasks.find((t) => t.diagnostic);
  assert.equal(diagAfter.id, diagBefore.id, 'the diagnostic keeps its stable id');
  assert.equal(diagAfter.fingerprint, model2.promptFingerprints[diagAfter.promptId], 'the fingerprint is refreshed to current content');

  // The learner can now submit a real diagnostic answer...
  const practiced = applyPractice({ ...synced, learningRounds: { ...synced.learningRounds, 'round-f3': updated } }, model2,
    { promptId: diagAfter.promptId, sessionId: 's-f3', draft: 'd', roundId: 'round-f3', taskId: diagAfter.id }, '2026-10-09T02:00:00Z');
  const submitted = applySubmission(practiced.state, model2,
    { promptId: diagAfter.promptId, sessionId: 's-f3', attemptId: 'att-f3', answer: '新内容的诊断回答', roundId: 'round-f3', taskId: diagAfter.id }, '2026-10-09T02:10:00Z');
  assert.equal(submitted.attempt.taskId, diagAfter.id);
  // ...and confirmation is no longer stuck.
  const confirmed = applyLearningRound(submitted.state, model2, { action: 'confirm-diagnosis', roundId: 'round-f3' }, '2026-10-09T02:20:00Z').round;
  assert.equal(confirmed.status, 'active');
});

test('F3: an old diagnostic answer is marked stale after content changes, and is not rewritten', () => {
  const model1 = chainModel();
  let state = createState(model1, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model1, {
    action: 'create', roundId: 'round-f3b', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const diag = state.learningRounds['round-f3b'].tasks.find((t) => t.diagnostic);
  // Submit an answer against the original content, then change the content.
  const practiced = applyPractice(state, model1, { promptId: diag.promptId, sessionId: 's', draft: 'd', roundId: 'round-f3b', taskId: diag.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model1, { promptId: diag.promptId, sessionId: 's', attemptId: 'att-old', answer: '旧诊断回答', roundId: 'round-f3b', taskId: diag.id }, '2026-10-09T00:10:00Z').state;
  const originalAnswer = state.attempts[diag.promptId].find((a) => a.id === 'att-old').answer;

  const model2 = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'c' ? { ...c, explanation: '改写解释' } : c)) });
  const synced = syncModel(state, model2, '2026-10-09T01:00:00Z').state;
  const updated = applyLearningRound(synced, model2, { action: 'update', roundId: 'round-f3b' }, '2026-10-09T01:00:00Z').state;
  const view = learningRoundView(updated, model2, 'round-f3b');
  const diagView = view.tasks.find((t) => t.diagnostic);
  assert.equal(diagView.submitted, false, 'the old answer is not a current diagnostic submission');
  assert.equal(diagView.staleSubmissions, 1, 'the old answer is reported as stale history');
  // The old attempt is untouched.
  assert.equal(updated.attempts[diag.promptId].find((a) => a.id === 'att-old').answer, originalAnswer);
  // Confirmation is still correctly refused until a fresh answer arrives.
  assert.throws(
    () => applyLearningRound(updated, model2, { action: 'confirm-diagnosis', roundId: 'round-f3b' }, '2026-10-09T01:30:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('F3: pausing a diagnosing round, changing content, then resuming and updating recovers', () => {
  const model1 = chainModel();
  let state = createState(model1, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model1, {
    action: 'create', roundId: 'round-f3c', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  state = applyLearningRound(state, model1, { action: 'pause', roundId: 'round-f3c' }, '2026-10-09T00:30:00Z').state;
  const model2 = chainModel({ concepts: chainModel().concepts.map((c) => (c.id === 'c' ? { ...c, explanation: '暂停后改写' } : c)) });
  const synced = syncModel(state, model2, '2026-10-09T01:00:00Z').state;
  // Update while paused refreshes the diagnostic; resume restores diagnosing.
  state = applyLearningRound(synced, model2, { action: 'update', roundId: 'round-f3c' }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-f3c'].status, 'paused');
  state = applyLearningRound(state, model2, { action: 'resume', roundId: 'round-f3c' }, '2026-10-09T01:10:00Z').state;
  assert.equal(state.learningRounds['round-f3c'].status, 'diagnosing');
  const diag = state.learningRounds['round-f3c'].tasks.find((t) => t.diagnostic);
  assert.equal(diag.fingerprint, model2.promptFingerprints[diag.promptId], 'the resumed diagnostic is current');
  // The learner can submit the fresh diagnostic and confirm.
  const practiced = applyPractice(state, model2, { promptId: diag.promptId, sessionId: 's', draft: 'd', roundId: 'round-f3c', taskId: diag.id }, '2026-10-09T01:20:00Z');
  const submitted = applySubmission(practiced.state, model2, { promptId: diag.promptId, sessionId: 's', attemptId: 'att-f3c', answer: '恢复后的诊断', roundId: 'round-f3c', taskId: diag.id }, '2026-10-09T01:30:00Z');
  assert.equal(applyLearningRound(submitted.state, model2, { action: 'confirm-diagnosis', roundId: 'round-f3c' }, '2026-10-09T01:40:00Z').round.status, 'active');
});

test('F4: a budget below the first task leaves no current task, blocks new work, and recovers by raising the budget', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // Concept a estimates 14 minutes; a 5-minute budget fits nothing.
  const created = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-f4', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 5,
  }, '2026-10-09T00:00:00Z');
  const round = created.round;
  assert.equal(round.tasks.every((t) => t.deferred), true, 'prefix keeps nothing open when the first task cannot fit');
  assert.equal(round.currentTaskId, null, 'no current task when nothing is open');
  const view = learningRoundView(created.state, model, 'round-f4');
  assert.equal(view.currentTaskId, null);
  assert.equal(view.budgetInsufficient, true);
  assert.equal(view.requiredMinutes, round.tasks[0].estimatedMinutes, 'the first formal task minutes are reported');
  assert.ok(view.requiredMinutes > 5, 'the first formal task does not fit the 5-minute budget');
  assert.equal(view.allSubmitted, false, 'a budget-insufficient plan is not falsely complete');

  // A new submit is refused; the deferred task is not this session's work.
  const first = round.tasks[0];
  assert.throws(
    () => applySubmission(created.state, model, { promptId: first.promptId, sessionId: null, attemptId: 'att-f4', answer: '越预算作答', roundId: 'round-f4', taskId: first.id }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );

  // Raising the budget opens the first task and clears the flag.
  const raised = applyLearningRound(created.state, model, { action: 'update', roundId: 'round-f4', budgetMinutes: 120 }, '2026-10-09T02:00:00Z').state;
  const view2 = learningRoundView(raised, model, 'round-f4');
  assert.equal(view2.budgetInsufficient, false);
  assert.equal(view2.requiredMinutes, null);
  assert.ok(view2.currentTaskId, 'a current task is available again');
  const open = raised.learningRounds['round-f4'].tasks.find((t) => t.id === view2.currentTaskId);
  assert.equal(open.deferred, false, 'the recovered current task is open');
});

test('F4: an idempotent replay of an already-recorded work still succeeds under a tight budget', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // First create with enough budget so the first task is worked and recorded.
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-f4r', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 120,
  }, '2026-10-09T00:00:00Z').state;
  const first = state.learningRounds['round-f4r'].tasks.find((t) => !t.deferred);
  const practiced = applyPractice(state, model, { promptId: first.promptId, sessionId: 's', draft: 'd', roundId: 'round-f4r', taskId: first.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model, { promptId: first.promptId, sessionId: 's', attemptId: 'att-f4r', answer: '已记录', roundId: 'round-f4r', taskId: first.id }, '2026-10-09T00:10:00Z').state;
  // Now shrink the budget so the first task becomes deferred.
  state = applyLearningRound(state, model, { action: 'update', roundId: 'round-f4r', budgetMinutes: 5 }, '2026-10-09T01:00:00Z').state;
  assert.equal(state.learningRounds['round-f4r'].tasks.every((t) => t.deferred), true);
  // Replaying the exact recorded attempt still succeeds (identity path precedes
  // the deferred/current guard), and no new answer is written.
  const replay = applySubmission(state, model, { promptId: first.promptId, sessionId: 's', attemptId: 'att-f4r', answer: '已记录', roundId: 'round-f4r', taskId: first.id }, '2026-10-09T02:00:00Z');
  assert.equal(replay.attempt.id, 'att-f4r');
  assert.equal(state.attempts[first.promptId].filter((a) => a.id === 'att-f4r').length, 1);
});

test('focus refuses a deferred task', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  const created = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-focus-d', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 5,
  }, '2026-10-09T00:00:00Z');
  state = created.state;
  const deferred = created.round.tasks[0];
  assert.equal(deferred.deferred, true);
  assert.throws(
    () => applyLearningRound(state, model, { action: 'focus', roundId: 'round-focus-d', taskId: deferred.id }, '2026-10-09T01:00:00Z'),
    (err) => err.code === 'E_CONFLICT',
  );
});

test('F4 new-topic: after a real diagnostic and confirm, a tight budget waits with no current task', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // A 1-minute budget cannot fit any formal task, but the 8-minute diagnostic
  // task must still be answerable so the gate can be cleared.
  const created = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-f4n', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 1,
  }, '2026-10-09T00:00:00Z');
  state = created.state;
  const diag = created.round.tasks.find((t) => t.diagnostic);
  assert.equal(diag.deferred, false, 'the diagnostic task is the current step despite the budget');
  assert.equal(created.round.currentTaskId, diag.id);

  const practiced = applyPractice(state, model, { promptId: diag.promptId, sessionId: 's', draft: 'd', roundId: 'round-f4n', taskId: diag.id }, '2026-10-09T00:05:00Z');
  const submitted = applySubmission(practiced.state, model, { promptId: diag.promptId, sessionId: 's', attemptId: 'att-f4n', answer: '真实诊断回答', roundId: 'round-f4n', taskId: diag.id }, '2026-10-09T00:10:00Z');
  // Only the diagnostic was submitted; that must not read as round completion.
  const midView = learningRoundView(submitted.state, model, 'round-f4n');
  assert.equal(midView.allSubmitted, false, 'a submitted diagnostic alone is not completion');
  assert.equal(midView.remainingTasks, 0, 'no formal task is open under the tight budget');

  state = applyLearningRound(submitted.state, model, { action: 'confirm-diagnosis', roundId: 'round-f4n' }, '2026-10-09T00:20:00Z').state;
  const view = learningRoundView(state, model, 'round-f4n');
  assert.equal(view.status, 'active', 'the confirmed round is active, not completed');
  assert.equal(view.storedStatus, 'active');
  assert.equal(view.currentTaskId, null, 'no current task while the budget fits nothing');
  assert.equal(view.budgetInsufficient, true);
  assert.equal(view.requiredMinutes, view.tasks.find((t) => !t.diagnostic).estimatedMinutes);
  assert.equal(view.allSubmitted, false, 'waiting on budget is not completion');
  // Raising the budget opens the formal route and gives a real current task.
  const raised = applyLearningRound(state, model, { action: 'update', roundId: 'round-f4n', budgetMinutes: 120 }, '2026-10-09T01:00:00Z').state;
  const view2 = learningRoundView(raised, model, 'round-f4n');
  assert.ok(view2.currentTaskId, 'a formal task is current again');
  assert.equal(view2.budgetInsufficient, false);
});

test('F4 paused: a budget-insufficient plan still reads the flag through resumeStatus', () => {
  const model = chainModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-f4p', entry: 'organize-existing-material', goal: '掌握 C', conceptIds: ['c'], budgetMinutes: 5,
  }, '2026-10-09T00:00:00Z').state;
  state = applyLearningRound(state, model, { action: 'pause', roundId: 'round-f4p' }, '2026-10-09T00:30:00Z').state;
  const view = learningRoundView(state, model, 'round-f4p');
  assert.equal(view.status, 'paused');
  assert.equal(view.resumeStatus, 'active');
  assert.equal(view.budgetInsufficient, true, 'the paused plan still surfaces the budget shortfall');
  assert.equal(view.currentTaskId, null);
});

test('F3 identity: a different diagnostic prompt archives the old task instead of repointing its id', () => {
  const model1 = chainModel();
  let state = createState(model1, '2026-10-09T00:00:00Z');
  state = applyLearningRound(state, model1, {
    action: 'create', roundId: 'round-f3d', entry: 'learn-new-topic', goal: '掌握 C', conceptIds: ['c'],
  }, '2026-10-09T00:00:00Z').state;
  const oldDiag = state.learningRounds['round-f3d'].tasks.find((t) => t.diagnostic);
  const practiced = applyPractice(state, model1, { promptId: oldDiag.promptId, sessionId: 's', draft: 'd', roundId: 'round-f3d', taskId: oldDiag.id }, '2026-10-09T00:05:00Z');
  state = applySubmission(practiced.state, model1, { promptId: oldDiag.promptId, sessionId: 's', attemptId: 'att-old-diag', answer: '旧题作答', roundId: 'round-f3d', taskId: oldDiag.id }, '2026-10-09T00:10:00Z').state;

  // A rebuilt model adds a better diagnostic prompt for c (recall has the
  // highest diagnostic preference) while the original apply prompt still
  // exists, so the learner's earlier answer stays resolvable for replay.
  const model2 = chainModel({
    prompts: [
      ...chainModel().prompts,
      { id: 'pc-new', conceptId: 'c', kind: 'recall', question: '新的诊断问题？', answer: '新答案', criteria: ['新要点'] },
    ],
  });
  const synced = syncModel(state, model2, '2026-10-09T01:00:00Z').state;
  const updated = applyLearningRound(synced, model2, { action: 'update', roundId: 'round-f3d' }, '2026-10-09T01:00:00Z').state;
  const round = updated.learningRounds['round-f3d'];
  const newDiag = round.tasks.find((t) => t.diagnostic);
  assert.equal(newDiag.promptId, 'pc-new');
  assert.notEqual(newDiag.id, oldDiag.id, 'a different prompt gets a fresh task id');
  assert.ok(round.archivedTasks.some((t) => t.id === oldDiag.id), 'the old diagnostic task is archived');
  // The old answer still resolves through the archive for an idempotent replay.
  const replay = applySubmission(updated, model2, { promptId: oldDiag.promptId, sessionId: 's', attemptId: 'att-old-diag', answer: '旧题作答', roundId: 'round-f3d', taskId: oldDiag.id }, '2026-10-09T02:00:00Z');
  assert.equal(replay.attempt.id, 'att-old-diag');
  assert.equal(replay.attempt.taskId, oldDiag.id);
});

test('R4: a toString-named round and session survive CLI export/import without loss', () => {
  const dir = tmpDir();
  try {
    atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
    buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
    // A round id and a session id that collide with Object.prototype members.
    runJson(roundArgs(dir, ['--action', 'create', '--round-id', 'toString', '--entry', 'organize-existing-material', '--goal', '掌握 C', '--concept', 'c', '--minutes', '60']));
    const task = runJson(['round-read', '--out', dir, '--round-id', 'toString']).round.tasks.find((t) => !t.deferred);
    assert.equal(runCli(['practice', '--out', dir, '--prompt', task.promptId, '--session-id', 'toString',
      '--draft', '草稿', '--round-id', 'toString', '--task-id', task.id]).status, 0);

    const exported = path.join(dir, 'exported.json');
    runJson(['export', '--out', dir, '--to', exported]);
    // Re-import the exported archive: the round and session must survive.
    const imported = runJson(['import', '--out', dir, '--state', exported]);
    assert.equal(imported.imported, true);
    const state = readJson(path.join(dir, 'state.json'));
    assert.ok(state.learningRounds.toString, 'the toString round survives import');
    assert.equal(state.learningRounds.toString.id, 'toString');
    assert.ok(state.practiceSessions.toString, 'the toString session survives import');
    assert.equal(state.practiceSessions.toString.taskId, task.id);
    assert.equal(state.activeRoundId, 'toString', 'activeRoundId still resolves to the round');
    // A fresh process still reads the route.
    const read = runJson(['round-read', '--out', dir, '--round-id', 'toString']);
    assert.equal(read.present, true);
    assert.equal(read.round.roundId, 'toString');
  } finally {
    cleanup(dir);
  }
});

test('R4: forbidden prototype round ids stay rejected after export/import paths', () => {
  const dir = tmpDir();
  try {
    atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
    buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
    for (const bad of ['constructor', '__proto__', 'prototype']) {
      const rejected = runCli(roundArgs(dir, ['--action', 'create', '--round-id', bad, '--entry', 'organize-existing-material', '--goal', 'g', '--concept', 'c']));
      assert.equal(rejected.status, 1, `${bad} must be rejected`);
      assert.match(rejected.stderr, /E_ID/);
    }
  } finally {
    cleanup(dir);
  }
});

test('R5: a task with malformed prerequisites is rejected on import and the archive is untouched', () => {
  const dir = tmpDir();
  try {
    atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(chainModel())));
    buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
    runJson(roundArgs(dir, ['--action', 'create', '--round-id', 'round-r5', '--entry', 'organize-existing-material', '--goal', '掌握 C', '--concept', 'c']));
    const before = readFile(path.join(dir, 'state.json'));
    const exported = path.join(dir, 'exported.json');
    runJson(['export', '--out', dir, '--to', exported]);

    for (const bad of ['not-an-array', 5, [1], [''], [null]]) {
      const incoming = readJson(exported);
      incoming.learningRounds['round-r5'].tasks[0].prerequisites = bad;
      const incomingPath = path.join(dir, 'incoming.json');
      atomicWrite(incomingPath, stableStringify(incoming));
      const rejected = runCli(['import', '--out', dir, '--state', incomingPath]);
      assert.equal(rejected.status, 1, `prerequisites=${JSON.stringify(bad)} must be rejected`);
      assert.match(rejected.stderr, /E_STATE/);
      assert.ok(rejected.stderr.includes('prerequisites'));
      assert.doesNotMatch(rejected.stderr, /TypeError|未预期|\n\s+at /);
      assert.equal(readFile(path.join(dir, 'state.json')), before, 'the archive is byte-for-byte unchanged');
    }
    // A present valid array and an omitted field both import cleanly.
    const okArray = readJson(exported);
    okArray.learningRounds['round-r5'].tasks[0].prerequisites = [];
    atomicWrite(path.join(dir, 'ok.json'), stableStringify(okArray));
    assert.equal(runCli(['import', '--out', dir, '--state', path.join(dir, 'ok.json')]).status, 0);
  } finally {
    cleanup(dir);
  }
});
