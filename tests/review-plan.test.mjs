// Task-14 budgeted-review regressions.
//
// These cover the backend contract for ticket 14: the pure
// `roundReviewPlan` selection (prerequisite gaps -> repeated errors -> real due
// dates), the learner's explicit focus override, the placeholder reason that
// must never prefix a real reason, the latest-original-target tutor rule, the
// read-only preview/apply boundary, pause/resume, diagnosing rejection and the
// learner-question focus -> bound submit -> edit-invalidates journey. Every
// fixture is a synthetic TEMP directory; nothing here is real learner evidence.
//
// Run: node --test tests/review-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelToJson, normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import { roundReviewPlan } from '../skill/forge/scripts/lib/round.mjs';
import {
  applyCorrection,
  applyLearningRound,
  applyOwnQuestion,
  applySubmission,
  applyTutorAssessment,
  createState,
  learningRoundView,
  reviewPlan,
  validateLearningRounds,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { archivePathFor, writeArchiveState } from '../skill/forge/scripts/lib/archive.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');

// Deterministic synthetic times. `PLAN_AT` is the simulated review moment.
const T = (day, hour) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const PLAN_AT = '2026-10-10T00:00:00Z';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-review-plan-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function buildDir(model) {
  const dir = tmpDir();
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(model)));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  return dir;
}

function writeState(dir, state) {
  writeArchiveState(archivePathFor(path.join(dir, 'state.json')), state);
}

// ---------------------------------------------------------------------------
// Synthetic model
// ---------------------------------------------------------------------------

function promptFor(conceptId, id) {
  return {
    id, conceptId, kind: 'explain',
    question: `合成问题 ${id}：说清条件集合与分母。`,
    answer: `合成参考 ${id}：先确定条件群体，再计算群体内比例。`,
    criteria: ['说清条件集合', '说明分子与分母'],
  };
}

function rawModel() {
  return {
    schemaVersion: 1,
    id: 'budget-review-synthetic',
    title: '合成复习计划',
    goal: '区分条件集合与概率方向',
    concepts: [
      { id: 'root', title: '总览', parentId: null, difficulty: 1, explanation: '合成总览。' },
      { id: 'base', title: '条件集合', parentId: 'root', difficulty: 1, explanation: '先明确条件集合。' },
      { id: 'goal', title: '条件概率方向', parentId: 'root', difficulty: 1, explanation: '合成目标概念。' },
      { id: 'repeat', title: '阳性分母', parentId: 'root', difficulty: 1, explanation: '合成重复错误概念。' },
      { id: 'due-a', title: '计数关系', parentId: 'root', difficulty: 1, explanation: '合成到期概念 A。' },
      { id: 'due-b', title: '先验变化', parentId: 'root', difficulty: 1, explanation: '合成到期概念 B。' },
      { id: 'later', title: '后续迁移', parentId: 'root', difficulty: 1, explanation: '合成未来概念。' },
    ],
    prompts: [
      promptFor('base', 'p-base'),
      { ...promptFor('goal', 'p-goal'), kind: 'apply' },
      promptFor('repeat', 'p-repeat'),
      promptFor('due-a', 'p-due-a'),
      promptFor('due-b', 'p-due-b'),
      promptFor('later', 'p-later'),
    ],
    relations: [
      { id: 'prereq-base-goal', from: 'base', to: 'goal', type: 'prerequisite', label: '先明确条件集合' },
    ],
    sources: [{ id: 'synthetic', title: '合成教学材料', kind: 'synthetic-teaching-material' }],
  };
}

function fixtureModel() {
  return normalizeModel(rawModel());
}

function submit(state, model, promptId, attemptId, at) {
  return applySubmission(state, model, { promptId, attemptId, answer: `合成原答 ${attemptId}`, sessionId: null }, at).state;
}

function tutor(state, model, promptId, attemptId, rating, at, extra = {}) {
  return applyTutorAssessment(state, model, {
    promptId, attemptId, rating, note: '合成核对依据', assessmentId: `t-${attemptId}-${rating}`, ...extra,
  }, at).state;
}

// A round whose target is `goal` (so `base` is its prerequisite), plus:
//  * `repeat` with two independent original hard answers and one newer
//    unassessed original,
//  * `due-a` / `due-b` with past real schedules,
//  * `later` with a future schedule.
function seededReview() {
  const model = fixtureModel();
  let state = createState(model, T(1, 0));
  state = submit(state, model, 'p-repeat', 'att-repeat-1', T(1, 1));
  state = tutor(state, model, 'p-repeat', 'att-repeat-1', 'hard', T(1, 2));
  state = submit(state, model, 'p-repeat', 'att-repeat-2', T(1, 3));
  state = tutor(state, model, 'p-repeat', 'att-repeat-2', 'hard', T(1, 4));
  state = submit(state, model, 'p-repeat', 'att-repeat-pending', T(1, 5));
  state = submit(state, model, 'p-due-a', 'att-due-a', T(2, 1));
  state = tutor(state, model, 'p-due-a', 'att-due-a', 'good', T(2, 2));
  state = submit(state, model, 'p-due-b', 'att-due-b', T(3, 1));
  state = tutor(state, model, 'p-due-b', 'att-due-b', 'good', T(3, 2));
  // Deterministic schedules: the due/repeat metadata the planner must read.
  state.schedules = {
    // A real but *future* arrangement for the goal prerequisite: past-due
    // wording must depend on the query time, never on the mere presence of a
    // dueAt. At 2026-10-10T00:00 it is not yet due; at 12:00 it is.
    'p-base': { dueAt: '2026-10-10T01:00:00Z', intervalDays: 3, assessmentSource: 'self', attemptId: null },
    'p-repeat': { dueAt: T(30, 0), intervalDays: 10, assessmentSource: 'tutor', attemptId: 'att-repeat-2' },
    'p-due-a': { dueAt: T(5, 0), intervalDays: 2, assessmentSource: 'self', attemptId: 'att-due-a' },
    'p-due-b': { dueAt: T(6, 0), intervalDays: 2, assessmentSource: 'tutor', attemptId: 'att-due-b' },
    'p-later': { dueAt: '2026-11-20T00:00:00Z', intervalDays: 20, assessmentSource: 'tutor', attemptId: 'att-due-b' },
  };
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'r-1', entry: 'organize-existing-material',
    goal: '复习条件概率方向', conceptIds: ['goal'], budgetMinutes: 16,
  }, T(9, 0)).state;
  return { model, state };
}

function planOf(state, model, options) {
  return reviewPlan(state, model, options, PLAN_AT);
}

// ---------------------------------------------------------------------------
// Selection order and focus override
// ---------------------------------------------------------------------------

test('default plan orders prerequisite, repeated error and real due dates, and is read-only', () => {
  const { model, state } = seededReview();
  const before = stableStringify(state);
  // A direct pure call must not mutate the archive either.
  const pure = roundReviewPlan(state, model, { roundId: 'r-1', budgetMinutes: 16 }, PLAN_AT);
  assert.equal(stableStringify(state), before, 'roundReviewPlan never writes state');
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: 16 });
  assert.deepEqual(plan.selected.map((c) => c.promptId), ['p-base', 'p-repeat']);
  assert.equal(plan.selected[0].priorityKind, 'prerequisite');
  assert.equal(plan.selected[1].priorityKind, 'repeated');
  assert.equal(plan.selected[1].attemptId, 'att-repeat-2');
  assert.ok(plan.selected[1].pendingAssessmentAt, 'a newer unassessed original stays pending');
  assert.ok(plan.deferred.some((c) => c.promptId === 'p-due-a'));
  assert.deepEqual(pure.selected.map((c) => c.promptId), plan.selected.map((c) => c.promptId));
  assert.equal(pure.dueCount, 2, 'only the past schedules are due');
  assert.deepEqual(pure.allDue.map((c) => c.promptId).sort(), ['p-due-a', 'p-due-b']);
  assert.ok(pure.allDue.every(c => c.dueNow === true), 'complete due entries report their actual due status');
});

test('a real reason replaces the generic option placeholder', () => {
  const { model, state } = seededReview();
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: 16 });
  for (const candidate of [...plan.selected, ...plan.deferred]) {
    assert.doesNotMatch(candidate.reason, /默认未到期/, `${candidate.promptId} must not keep the placeholder claim`);
  }
  const dueA = plan.deferred.find((c) => c.promptId === 'p-due-a');
  assert.match(dueA.reason, /真实到期/);
  const repeated = plan.selected.find((c) => c.promptId === 'p-repeat');
  assert.match(repeated.reason, /反复错误|hard\/again/);
  const base = plan.selected.find((c) => c.promptId === 'p-base');
  assert.match(base.reason, /必要前置/);
});

test('focus override selects an unrelated focused due item with its real schedule metadata', () => {
  const { model, state } = seededReview();
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'] });
  assert.deepEqual(plan.selected.map((c) => c.promptId), ['p-due-b']);
  const picked = plan.selected[0];
  assert.equal(picked.focus, true);
  assert.equal(picked.assessmentSource, 'tutor');
  assert.equal(picked.attemptId, 'att-due-b');
  assert.equal(picked.dueAt, T(6, 0));
  assert.equal(picked.dueNow, true);
  // The old goal prerequisite is not mandatory; it stays honestly deferred.
  const base = plan.deferred.find((c) => c.promptId === 'p-base');
  assert.ok(base, 'the old goal prerequisite remains visible as deferred');
  assert.match(base.deferredReason, /主动重点|预算/);
  assert.ok(plan.deferred.some((c) => c.promptId === 'p-due-a'));
});

test('a focus whose own prerequisite is required schedules that prerequisite first', () => {
  const { model, state } = seededReview();
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-goal'] });
  assert.deepEqual(plan.selected.map((c) => c.promptId), ['p-base']);
  assert.equal(plan.selected[0].priorityKind, 'prerequisite', 'the prerequisite itself is scheduled');
  assert.match(plan.selected[0].reason, /主动重点/);
  assert.equal((plan.selected[0].reason.match(/先安排可核对补漏/g) || []).length, 1, 'the shared prerequisite explanation appears once');
  assert.ok(plan.deferred.some((c) => c.promptId === 'p-goal'));
  const tiny = planOf(state, model, { roundId: 'r-1', budgetMinutes: 1, focusPromptIds: ['p-goal'] });
  assert.match(tiny.deferred.find(c => c.promptId === 'p-base').deferredReason, /超出本轮 1 分钟预算/);
  assert.doesNotMatch(tiny.deferred.find(c => c.promptId === 'p-base').deferredReason, /主动重点外/);
});

test('a focused future item keeps its real date and is honestly not due', () => {
  const { model, state } = seededReview();
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-later'] });
  assert.deepEqual(plan.selected.map((c) => c.promptId), ['p-later']);
  assert.equal(plan.selected[0].dueNow, false);
  assert.equal(plan.selected[0].dueAt, '2026-11-20T00:00:00Z');
  assert.ok(plan.deferred.some((c) => c.promptId === 'p-due-a'));
  assert.ok(plan.deferred.some((c) => c.promptId === 'p-due-b'));
});

test('a deferred focus-outside item is called "still due" only when its date has actually passed', () => {
  const { model, state } = seededReview();
  // Query before the goal prerequisite's own arrangement matures.
  const early = reviewPlan(state, model, {
    roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'],
  }, '2026-10-10T00:00:00Z');
  const baseEarly = early.deferred.find((c) => c.promptId === 'p-base');
  assert.ok(baseEarly);
  assert.equal(baseEarly.dueNow, false);
  assert.equal(baseEarly.dueAt, '2026-10-10T01:00:00Z');
  assert.doesNotMatch(baseEarly.deferredReason, /仍到期/, 'a future arrangement is not "still due"');
  assert.match(baseEarly.deferredReason, /尚未到期|未到期|保留/);
  // Query after it matures: the same item is now honestly still due.
  const late = reviewPlan(state, model, {
    roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'],
  }, '2026-10-10T12:00:00Z');
  const baseLate = late.deferred.find((c) => c.promptId === 'p-base');
  assert.ok(baseLate);
  assert.equal(baseLate.dueNow, true);
  assert.match(baseLate.deferredReason, /仍到期/);
  // An item with no arrangement at all is a plain deferred follow-up, never a
  // fake due date.
  const withoutDates = cloneJson(state);
  withoutDates.schedules = { 'p-due-b': state.schedules['p-due-b'] };
  const noDate = reviewPlan(withoutDates, model, {
    roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'],
  }, '2026-10-10T00:00:00Z').deferred.find((c) => c.promptId === 'p-base');
  assert.ok(noDate);
  assert.equal(noDate.dueAt, null);
  assert.equal(noDate.dueNow, false);
  assert.match(noDate.deferredReason, /待后续|其他计划项/);
  assert.doesNotMatch(noDate.deferredReason, /仍到期/);
});

test('a focused prompt with no budget still selects exactly one unit', () => {
  const { model, state } = seededReview();
  const plan = planOf(state, model, { roundId: 'r-1', budgetMinutes: null, focusPromptIds: ['p-later'] });
  assert.deepEqual(plan.selected.map((c) => c.promptId), ['p-later']);
  assert.ok(plan.deferred.length > 0);
});

// ---------------------------------------------------------------------------
// Repeated-error tutor rule
// ---------------------------------------------------------------------------

function repeatedOnly(model) {
  let state = createState(model, T(1, 0));
  state = submit(state, model, 'p-repeat', 'att-repeat-1', T(1, 1));
  state = tutor(state, model, 'p-repeat', 'att-repeat-1', 'hard', T(1, 2));
  state = submit(state, model, 'p-repeat', 'att-repeat-2', T(1, 3));
  state = tutor(state, model, 'p-repeat', 'att-repeat-2', 'hard', T(1, 4));
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'r-repeat', entry: 'organize-existing-material',
    goal: '复习重复错误', conceptIds: ['repeat'], budgetMinutes: 16,
  }, T(9, 0)).state;
  return state;
}

function repeatedCandidate(state, model) {
  const plan = planOf(state, model, { roundId: 'r-repeat', budgetMinutes: 16 });
  return [...plan.selected, ...plan.deferred].find((c) => c.promptId === 'p-repeat' && c.priorityKind === 'repeated') || null;
}

test('a later good aimed at an assisted correction never erases the original negatives', () => {
  const model = fixtureModel();
  let state = repeatedOnly(model);
  assert.ok(repeatedCandidate(state, model), 'two independent hard originals make a repeated error');
  // Correct the *first* original and judge that correction good. The original's
  // own verdict is still hard, so the repeated error must survive.
  state = applyCorrection(state, model, {
    promptId: 'p-repeat', attemptId: 'att-repeat-1', correctionId: 'c-1', text: '合成修正。',
  }, T(1, 5)).state;
  state = tutor(state, model, 'p-repeat', 'att-repeat-1', 'good', T(1, 6), { targetCorrectionId: 'c-1' });
  const stillRepeated = repeatedCandidate(state, model);
  assert.ok(stillRepeated, 'a correction-only good does not settle the original answer');
  assert.match(stillRepeated.reason, /2 条/);
});

test('a later independent original good resets the older repeated errors', () => {
  const model = fixtureModel();
  let state = repeatedOnly(model);
  state = submit(state, model, 'p-repeat', 'att-repeat-3', T(2, 1));
  assert.ok(repeatedCandidate(state, model), 'an unassessed newer answer does not erase the gap');
  state = tutor(state, model, 'p-repeat', 'att-repeat-3', 'good', T(2, 2));
  assert.equal(repeatedCandidate(state, model), null, 'a current independent original good settles the prompt');
});

// ---------------------------------------------------------------------------
// Apply boundary, focus persistence and validation
// ---------------------------------------------------------------------------

test('review-plan never writes an attempt, schedule or completion flag', () => {
  const { model, state } = seededReview();
  const attemptsBefore = stableStringify(state.attempts);
  const schedulesBefore = stableStringify(state.schedules);
  const applied = applyLearningRound(state, model, {
    action: 'review-plan', roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'],
  }, T(9, 5)).state;
  assert.equal(stableStringify(applied.attempts), attemptsBefore, 'no attempt is written');
  assert.equal(stableStringify(applied.schedules), schedulesBefore, 'no schedule/dueAt is written');
  const round = applied.learningRounds['r-1'];
  assert.equal(round.status, 'active', 'applying a plan does not mark the round complete');
  assert.equal(round.reviewPlan.selected[0].promptId, 'p-due-b');
  // The selected task is not submitted just because it was planned.
  const view = learningRoundView(applied, model, 'r-1');
  const selectedTask = view.tasks.find((t) => t.promptId === 'p-due-b' && !t.deferred);
  assert.ok(selectedTask);
  assert.equal(selectedTask.submitted, false);
});

test('update keeps the saved focus, clear-focus drops it, and pause/resume preserves the plan', () => {
  const { model, state } = seededReview();
  let next = applyLearningRound(state, model, {
    action: 'review-plan', roundId: 'r-1', budgetMinutes: 8, focusPromptIds: ['p-due-b'],
  }, T(9, 5)).state;
  next = applyLearningRound(next, model, { action: 'pause', roundId: 'r-1' }, T(9, 6)).state;
  next = applyLearningRound(next, model, { action: 'resume', roundId: 'r-1' }, T(9, 7)).state;
  assert.deepEqual(next.learningRounds['r-1'].reviewPlan.focusPromptIds, ['p-due-b']);
  assert.equal(next.learningRounds['r-1'].reviewPlan.selected[0].promptId, 'p-due-b');
  // An explicit budget edit re-plans with the same focus.
  next = applyLearningRound(next, model, { action: 'update', roundId: 'r-1', budgetMinutes: 16 }, T(9, 8)).state;
  assert.deepEqual(next.learningRounds['r-1'].reviewPlan.focusPromptIds, ['p-due-b']);
  // `--clear-focus` empties the list and re-plans the default.
  next = applyLearningRound(next, model, { action: 'review-plan', roundId: 'r-1', clearFocus: true }, T(9, 9)).state;
  assert.deepEqual(next.learningRounds['r-1'].reviewPlan.focusPromptIds, []);
  assert.deepEqual(next.learningRounds['r-1'].reviewPlan.selected.map((c) => c.promptId), ['p-base', 'p-repeat']);
});

test('a diagnosing round rejects review-plan and legacy rounds still validate', () => {
  const model = fixtureModel();
  let state = createState(model, T(1, 0));
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'r-diag', entry: 'learn-new-topic',
    goal: '学新主题', conceptIds: ['goal'], budgetMinutes: 8,
  }, T(9, 0)).state;
  assert.throws(
    () => applyLearningRound(state, model, { action: 'review-plan', roundId: 'r-diag', budgetMinutes: 8 }, T(9, 1)),
    (err) => err.code === 'E_CONFLICT',
  );
  // A round without a reviewPlan is still a valid legacy archive.
  assert.equal(validateLearningRounds(state, model), true);
  assert.equal('reviewPlan' in state.learningRounds['r-diag'], false);
  assert.throws(
    () => roundReviewPlan(state, model, { roundId: 'r-diag', budgetMinutes: 0 }, T(9, 1)),
    (err) => err.code === 'E_USAGE',
  );
  assert.throws(
    () => roundReviewPlan(state, model, { roundId: 'r-diag', focusPromptIds: ['ghost'] }, T(9, 1)),
    (err) => err.code === 'E_USAGE',
  );
});

test('a non-actionable missing-author prerequisite is deferred, never selected and never billed', () => {
  // Remove the only author prompt behind the goal prerequisite so the gap has
  // no executable task; the plan must say so instead of inventing one.
  const gutted = normalizeModel({
    ...rawModel(),
    prompts: rawModel().prompts.filter((p) => p.id !== 'p-base'),
  });
  let state = createState(gutted, T(1, 0));
  state = applyLearningRound(state, gutted, {
    action: 'create', roundId: 'r-gap', entry: 'organize-existing-material',
    goal: '目标缺前置题', conceptIds: ['goal'], budgetMinutes: 16,
  }, T(9, 0)).state;
  const plan = roundReviewPlan(state, gutted, { roundId: 'r-gap', budgetMinutes: 16 }, PLAN_AT);
  const gap = plan.deferred.find((c) => c.conceptId === 'base' && c.unresolved);
  assert.ok(gap, 'the missing-author prerequisite is reported as unresolved');
  assert.equal(gap.actionable, false);
  assert.match(gap.reason, /没有作者题|补题|材料/);
  assert.equal(plan.selected.some((c) => c.conceptId === 'base'), false, 'it never consumes the budget');
});

// ---------------------------------------------------------------------------
// Public CLI: focus override, metadata and preview/apply boundary
// ---------------------------------------------------------------------------

test('public review-plan CLI previews read-only and the round action applies the focus override', () => {
  const { model, state } = seededReview();
  const dir = buildDir(model);
  try {
    writeState(dir, state);
    const beforePreview = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const preview = runJson(['review-plan', '--out', dir, '--round-id', 'r-1', '--minutes', '16', '--at', PLAN_AT]);
    assert.equal(preview.readOnly, true);
    assert.equal(preview.timeSource, 'explicit-test-time');
    assert.deepEqual(preview.selected.map((c) => c.promptId), ['p-base', 'p-repeat']);
    assert.ok(preview.deferred.some((c) => c.promptId === 'p-due-a'));
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), beforePreview, 'preview is byte-stable');

    const beforeApply = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const applied = runJson([
      'round', '--out', dir, '--action', 'review-plan', '--round-id', 'r-1',
      '--minutes', '8', '--focus-prompt', 'p-due-b', '--at', PLAN_AT,
    ]);
    const picked = applied.round.reviewPlan.selected[0];
    assert.equal(picked.promptId, 'p-due-b');
    assert.equal(picked.assessmentSource, 'tutor');
    assert.equal(picked.attemptId, 'att-due-b');
    assert.equal(picked.dueAt, T(6, 0));
    assert.ok(picked.reason && !/默认未到期/.test(picked.reason));
    const afterApply = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(stableStringify(afterApply.attempts), stableStringify(beforeApply.attempts), 'apply writes no attempt');
    assert.equal(stableStringify(afterApply.schedules), stableStringify(beforeApply.schedules), 'apply writes no schedule');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Public HTTP: own question focus -> bound submit -> edit invalidates
// ---------------------------------------------------------------------------

test('public HTTP own question can be focused, submitted and invalidated by an edit', async () => {
  const model = fixtureModel();
  let state = createState(model, T(1, 0));
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'r-own', entry: 'organize-existing-material',
    goal: '复习我的问题', conceptIds: ['due-b'], budgetMinutes: 8,
  }, T(9, 0)).state;
  state = submit(state, model, 'p-due-b', 'att-due-b', T(3, 1));
  state = tutor(state, model, 'p-due-b', 'att-due-b', 'good', T(3, 2));
  // A deterministic real due item exists so the focus override has something
  // to defer; written after the tutor recompute so it is not overwritten.
  state.schedules = { 'p-due-b': { dueAt: T(6, 0), intervalDays: 2, assessmentSource: 'tutor', attemptId: 'att-due-b' } };
  const dir = buildDir(model);
  try {
    writeState(dir, state);
    await withServer(dir, async (server) => {
      let payload = await (await fetch(`${server.url}/api/state`)).json();
      const question = await postJson(`${server.url}/api/question`, {
        conceptId: 'due-b', text: '我的问题：先验如何影响阳性者比例？', id: 'q-own',
        revision: payload.state.revision, modelFingerprint: payload.modelFingerprint,
      });
      assert.equal(question.status, 200, JSON.stringify(question.json));

      payload = await (await fetch(`${server.url}/api/state`)).json();
      const planned = await postJson(`${server.url}/api/round`, {
        action: 'review-plan', roundId: 'r-own', budgetMinutes: 8, focusPromptIds: ['q-own'],
        revision: payload.state.revision, modelFingerprint: payload.modelFingerprint,
      });
      assert.equal(planned.status, 200, JSON.stringify(planned.json));
      const savedRound = planned.json.state.learningRounds['r-own'];
      assert.equal(savedRound.reviewPlan.selected[0].promptId, 'q-own');
      assert.equal(savedRound.reviewPlan.selected[0].origin, 'learner');
      const task = savedRound.tasks.find((t) => t.promptId === 'q-own' && !t.deferred);
      assert.ok(task && task.fingerprint, 'the own-question task carries a real content fingerprint');

      const submitted = await postJson(`${server.url}/api/submit`, {
        promptId: 'q-own', attemptId: 'att-own', answer: '我的合成作答：先确定条件群体。',
        roundId: 'r-own', taskId: task.id,
        revision: planned.json.state.revision, modelFingerprint: planned.json.modelFingerprint,
      });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
      assert.equal(submitted.json.state.learningRounds['r-own'].status, 'completed',
        'the bound own-question submission completes the only selected task');

      // Editing the question text changes its fingerprint: the old bound task is
      // now stale and a new answer is refused instead of silently matching.
      const edited = await postJson(`${server.url}/api/question`, {
        conceptId: 'due-b', text: '我的问题：先验变化后，阳性者中的比例怎样变化？', id: 'q-own',
        revision: submitted.json.state.revision, modelFingerprint: submitted.json.modelFingerprint,
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.json));
      const stale = await postJson(`${server.url}/api/submit`, {
        promptId: 'q-own', attemptId: 'att-own-2', answer: '编辑后的新作答。',
        roundId: 'r-own', taskId: task.id,
        revision: edited.json.state.revision, modelFingerprint: edited.json.modelFingerprint,
      });
      assert.equal(stale.status, 409, 'a new answer to the stale own-question task is refused');
    });

    const view = runJson(['round-read', '--out', dir, '--round-id', 'r-own']);
    const ownTask = view.round.tasks.find((t) => t.promptId === 'q-own');
    assert.equal(ownTask.contentUpdated, true);
    assert.equal(ownTask.submitted, false);
    assert.ok(ownTask.staleSubmissions >= 1, 'the earlier answer is reported as stale history');
  } finally {
    cleanup(dir);
  }
});
