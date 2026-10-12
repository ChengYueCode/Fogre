// Ticket 06 acceptance: a concentrated, fixed-scope review of one round's real
// answers. These tests exercise the shared pure module, the public CLI, the
// local HTTP boundary and a rebuild/readback, and they assert the safety
// properties the ticket calls out: a frozen member set, per-item persistence,
// idempotent retry, the missing-basis and stale rules, the conservative
// independence guard, and the authority boundary (only the CLI may write review
// requests and tutor results).
//
// Run: node --test tests/tutor-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyCorrection,
  applyLearningRound,
  applyOwnQuestion,
  applyReviewItem,
  applySubmission,
  applyTutorAssessment,
  applyTutorEvidence,
  createState,
  isPromptEvidenceActive,
  normalizeState,
  promptFingerprint,
  startReviewRequest,
  tutorReviewSummary,
  validateStateShape,
} from '../skill/forge/scripts/lib/state.mjs';
import {
  tutorEvidenceHasBasis,
  validateReviewRequests,
} from '../skill/forge/scripts/lib/tutor-review.mjs';
import { buildArtifacts, injectTutorReviewLibrary } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const TUTOR_LIB_PATH = path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'tutor-review.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-tutor-review-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'review-model',
    title: '集中复核',
    goal: '解释条件范围并应用计数',
    concepts: [
      { id: 'root', title: '条件范围', parentId: null, difficulty: 1, explanation: '条件限定样本范围。', example: '红牌中红桃占 13/26。' },
      { id: 'count', title: '计数应用', parentId: 'root', difficulty: 2, explanation: '在限定集合中计数。', example: '52 张牌中 26 张红牌。' },
    ],
    relations: [{ id: 'rel-root-count', from: 'root', to: 'count', type: 'prerequisite', label: '先范围后计数' }],
    prompts: [
      { id: 'p-explain', conceptId: 'root', kind: 'explain', question: '为何条件概率需限定范围？', answer: '分母是满足条件的集合。', criteria: ['说明限定样本空间'] },
      { id: 'p-apply', conceptId: 'count', kind: 'apply', question: '已知抽到红牌，红桃概率是多少？', answer: '13/26=1/2。', criteria: ['分母 26', '结果 1/2'] },
    ],
    ...overrides,
  };
}

function baseModel() {
  return normalizeModel(rawModel());
}

// A pure round so round-scoped requests freeze against a real round, exactly as
// the CLI requires.
function createRound(state, model, roundId = 'round-1') {
  return applyLearningRound(state, model, {
    action: 'create', roundId, entry: 'organize-existing-material',
    goal: '解释条件范围并应用计数', conceptIds: ['root', 'count'], budgetMinutes: 60,
  }, '2026-10-09T00:00:00Z').state;
}

function taskForRound(state, roundId, promptId) {
  return state.learningRounds[roundId].tasks.find((t) => t.promptId === promptId);
}

// `round` names the round the answer is bound to (default round-1); `round: null`
// records a genuine unbound history answer, exactly like the public CLI when no
// round/task flags are given.
function submit(state, model, promptId, attemptId, at, { answer, assisted = false, round = 'round-1' } = {}) {
  const withRound = round !== null && !state.learningRounds?.[round] ? createRound(state, model, round) : state;
  const binding = round === null ? {} : { roundId: round, taskId: taskForRound(withRound, round, promptId).id };
  return applySubmission(withRound, model, {
    promptId, attemptId, answer: answer ?? `${attemptId} 的原始作答`, assisted, source: 'cli', ...binding,
  }, at).state;
}

function fingerprintsFor(model, state) {
  const promptFingerprints = { ...model.promptFingerprints };
  for (const question of Object.values(state.ownQuestions ?? {})) {
    const value = promptFingerprint(model, state, question.id);
    if (value) promptFingerprints[question.id] = value;
  }
  return {
    modelFingerprint: model.modelFingerprint,
    promptFingerprints,
    conceptFingerprints: { ...model.conceptFingerprints },
  };
}

function completedFeedback(overrides = {}) {
  return {
    status: 'completed',
    correct: '保留了限定范围',
    misconceptions: '需要说清分母集合',
    basis: '依照判定标准核对原答',
    repair: '把分母改为条件内集合',
    nextTask: '换为黑牌情境重新独立计算',
    rating: 'hard',
    targetCorrectionId: null,
    ...overrides,
  };
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function rejected(args) {
  const result = runCli(args);
  assert.equal(result.status, 1, `expected failure for ${args.join(' ')}\n${result.stdout}`);
  return result.stderr;
}

function writeModel(dir, overrides = {}) {
  const source = path.join(dir, 'source.json');
  atomicWrite(source, stableStringify(modelToJson(normalizeModel(rawModel(overrides)))));
  return source;
}

// Set up a built learning directory with one round whose first task has a real
// submission, using only the public CLI.
function roundArgs(dir, extra = []) {
  return ['round', '--out', dir, '--action', 'create', '--round-id', 'round-1',
    '--entry', 'organize-existing-material', '--goal', '解释条件范围并应用计数',
    '--concept', 'root', '--concept', 'count', '--minutes', '60', ...extra];
}

// ---------------------------------------------------------------------------
// Shared pure module
// ---------------------------------------------------------------------------

test('tutor-review library is portable: no imports and no Node-only globals', () => {
  const source = fs.readFileSync(TUTOR_LIB_PATH, 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, 'the portable module must not import');
  assert.equal(/require\(/.test(source), false, 'no CommonJS require');
  assert.equal(/\bprocess\./.test(source), false, 'no process access');
  assert.equal(/\b(?:fs|path|crypto)\b\./.test(source), false, 'no Node module access');
});

test('build inlines the tutor-review library and strips only the export keyword', () => {
  const dir = tmpDir();
  try {
    const source = writeModel(dir);
    buildArtifacts({ modelPath: source, outDir: dir, viewerPath: VIEWER });
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal(html.includes('__EMBER_TUTOR_REVIEW_LIBRARY__'), false, 'the marker is replaced');
    assert.match(html, /function tutorReviewSummary\s*\(/, 'tutorReviewSummary is inlined');
    assert.equal(/export\s+(?:function|var|const|let)\s/.test(html), false, 'no export keyword survives in the page');
    // A trailing `export { ... }` block would survive a `/^export /` strip and
    // leave illegal code in the IIFE; the inlined source must not contain one.
    assert.equal(/^\s*export\s*\{/m.test(fs.readFileSync(TUTOR_LIB_PATH, 'utf8')), false,
      'the library must not use a bottom export { } block');
    // A template without the marker is returned unchanged.
    assert.equal(injectTutorReviewLibrary('<html></html>'), '<html></html>');
    const injected = injectTutorReviewLibrary('a/*__EMBER_TUTOR_REVIEW_LIBRARY__*/b', 'export function x() {}');
    assert.equal(injected, 'afunction x() {}b');
  } finally {
    cleanup(dir);
  }
});

test('the inlined tutor-review summary is the same algorithm the backend runs', () => {
  const source = fs.readFileSync(TUTOR_LIB_PATH, 'utf8').replace(/^export /gm, '');
  const factory = new Function(`${source}\nreturn { tutorReviewSummary: tutorReviewSummary };`);
  const browser = factory();
  const model = normalizeModel(rawModel());
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  const fps = fingerprintsFor(model, state);
  const node = tutorReviewSummary(state, 'round-1', fps);
  const browserResult = browser.tutorReviewSummary(JSON.parse(JSON.stringify(state)), 'round-1', JSON.parse(JSON.stringify(fps)));
  assert.deepEqual(browserResult, node);
});

// ---------------------------------------------------------------------------
// Freeze: fixed scope, partial save, retry idempotency
// ---------------------------------------------------------------------------

test('a request freezes exactly the round\'s pending answers at request time', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = createRound(state, model, 'round-1');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-09T01:10:00Z');
  // Another round's answer and a genuinely unbound history answer stay in their
  // own sets and never join round-1's frozen request.
  state = submit(state, model, 'p-explain', 'att-other-round', '2026-10-09T01:15:00Z', { round: 'round-2' });
  state = submit(state, model, 'p-explain', 'att-history', '2026-10-09T01:20:00Z', { round: null });
  const started = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z');
  assert.deepEqual(started.request.members.map((m) => m.attemptId).sort(), ['att-a', 'att-b'],
    'only round-1 answers are frozen');
  // New submissions after the freeze do not join the frozen request.
  let next = submit(started.state, model, 'p-explain', 'att-c', '2026-10-09T03:00:00Z');
  const retried = startReviewRequest(next, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T03:30:00Z');
  assert.equal(retried.changed, false, 'a retry does not re-select members');
  assert.deepEqual(retried.request.members.map((m) => m.attemptId).sort(), ['att-a', 'att-b']);
  // The later round-1 answer is the next request's work; the round-2 answer
  // stays in round-2's own pending set.
  const roundOne = tutorReviewSummary(next, 'round-1', fingerprintsFor(model, next));
  assert.deepEqual(roundOne.pendingAttempts.map((a) => a.attemptId), ['att-c']);
  const roundTwo = tutorReviewSummary(next, 'round-2', fingerprintsFor(model, next));
  assert.deepEqual(roundTwo.pendingAttempts.map((a) => a.attemptId), ['att-other-round']);
});

test('a request requires a round or an explicit history scope', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-09T00:00:00Z');
  assert.throws(() => startReviewRequest(state, model, { requestId: 'req-x' }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_USAGE');
  assert.throws(() => startReviewRequest(state, model, { requestId: 'req-x', history: true }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_USAGE' && /attempt/.test(err.message));
});

test('explicit history selects only unbound answers and refuses round-bound ones', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-history', '2026-10-09T01:00:00Z', { round: null });
  const started = startReviewRequest(state, model,
    { requestId: 'req-h', history: true, attemptIds: ['att-history'] }, '2026-10-09T02:00:00Z');
  assert.equal(started.request.scope, 'history');
  assert.equal(started.request.roundId, null);
  assert.deepEqual(started.request.members.map((m) => m.attemptId), ['att-history']);
  // A round-bound answer keeps its own round's request and is refused as history.
  const bound = submit(state, model, 'p-explain', 'att-bound', '2026-10-09T02:00:00Z');
  assert.throws(() => startReviewRequest(bound, model,
    { requestId: 'req-h2', history: true, attemptIds: ['att-bound'] }, '2026-10-09T03:00:00Z'),
    (err) => err.code === 'E_CONFLICT' && /轮次|历史/.test(err.message));
});

test('partial success is saved and unfinished items remain pending', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-09T01:10:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  const model2 = model;
  const first = applyReviewItem(state, model2, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b', feedback: completedFeedback(),
  }, '2026-10-09T03:00:00Z');
  assert.equal(first.rated, true);
  const summary = tutorReviewSummary(first.state, 'round-1', fingerprintsFor(model2, first.state));
  const view = summary.requests.find((r) => r.id === 'req-1');
  assert.equal(view.completed, 1);
  assert.equal(view.remaining, 1);
  assert.equal(view.status, 'partial');
  const pendingMember = view.members.find((m) => m.attemptId === 'att-a');
  assert.equal(pendingMember.status, 'pending');
  assert.equal(pendingMember.reference, '分母是满足条件的集合。');
  assert.deepEqual(pendingMember.criteria, ['说明限定样本空间']);
  // A later retry with identical feedback is byte-idempotent.
  const before = stableStringify(first.state);
  const second = applyReviewItem(first.state, model2, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b', feedback: completedFeedback(),
  }, '2026-10-09T04:00:00Z');
  assert.equal(second.changed, false);
  assert.equal(stableStringify(second.state), before, 'an identical retry writes nothing');
});

test('a completed member is immutable; a different judgement is refused', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-09T01:10:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  state = applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b', feedback: completedFeedback(),
  }, '2026-10-09T03:00:00Z').state;
  assert.throws(() => applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b',
    feedback: completedFeedback({ rating: 'good', correct: '不同判断' }),
  }, '2026-10-09T04:00:00Z'), (err) => err.code === 'E_CONFLICT');
});

test('a success feedback requires five non-empty fields and a valid rating', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  for (const field of ['correct', 'misconceptions', 'basis', 'repair', 'nextTask']) {
    assert.throws(() => applyReviewItem(state, model, {
      requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback({ [field]: '' }),
    }, '2026-10-09T03:00:00Z'), (err) => err.code === 'E_USAGE', `${field} must be required`);
  }
  assert.throws(() => applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback({ rating: 'perfect' }),
  }, '2026-10-09T03:00:00Z'), (err) => err.code === 'E_USAGE');
});

test('a failure status needs a reason and keeps the item pending with no rating', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  assert.throws(() => applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: { status: 'undetermined' },
  }, '2026-10-09T03:00:00Z'), (err) => err.code === 'E_USAGE' && /reason/.test(err.message));
  const result = applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a',
    feedback: { status: 'undetermined', reason: '需要核对计算过程。', rating: 'good' },
  }, '2026-10-09T03:00:00Z');
  assert.equal(result.rated, false, 'a failure never writes a rating');
  assert.equal(result.member.status, 'undetermined');
  assert.equal((result.state.attempts['p-explain'][0].tutorAssessments ?? []).length, 0);
  const summary = tutorReviewSummary(result.state, 'round-1', fingerprintsFor(model, result.state));
  assert.equal(summary.requests[0].remaining, 1, 'a failure stays pending');
});

// ---------------------------------------------------------------------------
// Missing basis and stale snapshots
// ---------------------------------------------------------------------------

test('a self-authored question without reference or criteria cannot be rated', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // The real public path: a learner question is not on the model route, so its
  // answer is saved unbound and reviewed through an explicit history request.
  state = applyOwnQuestion(state, model, {
    id: 'q-own', conceptId: 'root', text: '这个规则适用于所有情境吗？',
  }, '2026-10-09T01:00:00Z').state;
  state = submit(state, model, 'q-own', 'att-own', '2026-10-09T01:30:00Z', { answer: '我还不知道边界。', round: null });
  const started = startReviewRequest(state, model,
    { requestId: 'req-own', history: true, attemptIds: ['att-own'] }, '2026-10-09T02:00:00Z');
  assert.equal(started.request.members[0].reference, '');
  assert.deepEqual(started.request.members[0].criteria, []);
  const result = applyReviewItem(started.state, model, {
    requestId: 'req-own', promptId: 'q-own', attemptId: 'att-own', feedback: completedFeedback(),
  }, '2026-10-09T03:00:00Z');
  assert.equal(result.rated, false, 'a missing basis is never rated');
  assert.equal(result.member.status, 'missing-basis');
  assert.match(result.member.reason, /没有作者参考|判定标准|缺口/);
  assert.equal((result.state.attempts['q-own'][0].tutorAssessments ?? []).length, 0);
});

test('a content update makes a frozen member stale and downgrades a success to pending', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  // Content changes: a new prompt/question fingerprint.
  const changed = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.map((p) => (p.id === 'p-explain' ? { ...p, question: `${p.question}（更新后）` } : p)),
  });
  const result = applyReviewItem(state, changed, {
    requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback(),
  }, '2026-10-09T03:00:00Z');
  assert.equal(result.rated, false, 'a stale snapshot is never rated');
  assert.equal(result.member.status, 'stale');
  assert.match(result.member.reason, /内容已更新|历史/);
  assert.equal((result.state.attempts['p-explain'][0].tutorAssessments ?? []).length, 0);
  // The frozen question text is preserved (the snapshot is not rewritten).
  assert.equal(result.member.question, '为何条件概率需限定范围？');
  const summary = tutorReviewSummary(result.state, 'round-1', fingerprintsFor(changed, result.state));
  assert.equal(summary.requests[0].members[0].current, false);
  assert.equal(summary.requests[0].members[0].question, '为何条件概率需限定范围？');
});

test('a correction that appears after the freeze is not a valid target', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-09T01:10:00Z');
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  state = applyCorrection(state, model, {
    promptId: 'p-apply', attemptId: 'att-b', correctionId: 'corr-later', text: '后来修正 1/2。', assistance: ['reference'],
  }, '2026-10-09T02:30:00Z').state;
  assert.throws(() => applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b',
    feedback: completedFeedback({ targetCorrectionId: 'corr-later' }),
  }, '2026-10-09T03:00:00Z'), (err) => err.code === 'E_CONFLICT' && /修正|范围/.test(err.message));
});

test('a correction frozen before the request is a valid, conservative target', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-09T01:10:00Z', { answer: '13/52=1/4。' });
  state = applyCorrection(state, model, {
    promptId: 'p-apply', attemptId: 'att-b', correctionId: 'corr-first', text: '13/26=1/2。', assistance: ['tutor-feedback'],
  }, '2026-10-09T01:30:00Z').state;
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  const result = applyReviewItem(state, model, {
    requestId: 'req-1', promptId: 'p-apply', attemptId: 'att-b',
    feedback: completedFeedback({ rating: 'good', targetCorrectionId: 'corr-first' }),
  }, '2026-10-09T03:00:00Z');
  assert.equal(result.rated, true);
  assert.equal(result.state.schedules['p-apply'].assisted, true, 'a corrected answer is never independent success');
  assert.equal(result.state.schedules['p-apply'].intervalDays, 2);
  assert.equal(result.state.schedules['p-apply'].targetCorrectionId, 'corr-first');
});

// ---------------------------------------------------------------------------
// Conservative independence guard (the parent's reproduction)
// ---------------------------------------------------------------------------

test('a tutor credit for an assisted correction cannot upgrade the original to independent evidence', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  // An independent original answer that the tutor judges wrong, then an
  // assisted correction the tutor judges good.
  state = submit(state, model, 'p-apply', 'att-error', '2026-10-09T01:00:00Z', { answer: '13/52=1/4。', assisted: false });
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', rating: 'again', note: '分母应为条件内 26 张红牌。', assessmentId: 'assess-original',
  }, '2026-10-09T01:10:00Z').state;
  state = applyCorrection(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', correctionId: 'corr-assisted', text: '13/26=1/2。', assistance: ['tutor-feedback'],
  }, '2026-10-09T01:20:00Z').state;
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', rating: 'good', note: '修正成功，但有导师协助。',
    assessmentId: 'assess-correction', targetCorrectionId: 'corr-assisted',
  }, '2026-10-09T01:30:00Z').state;
  assert.throws(() => applyTutorEvidence(state, model, {
    promptId: 'p-apply', status: 'applied', note: '试图用受协助修正提升原答。', attemptIds: ['att-error'],
  }, '2026-10-09T02:00:00Z'), (err) => err.code === 'E_STATE' && /独立|修正|again/.test(err.message));
});

test('an explicit again on the original is not hidden by a later correction success', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-error', '2026-10-09T01:00:00Z', { answer: '13/52=1/4。' });
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', rating: 'again', note: '原答错误。', assessmentId: 'a-orig',
  }, '2026-10-09T01:05:00Z').state;
  state = applyCorrection(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', correctionId: 'c1', text: '修正 1/2。', assistance: ['reference'],
  }, '2026-10-09T01:10:00Z').state;
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-error', rating: 'good', note: '修正好。', assessmentId: 'a-corr', targetCorrectionId: 'c1',
  }, '2026-10-09T01:20:00Z').state;
  assert.throws(() => applyTutorEvidence(state, model, {
    promptId: 'p-apply', status: 'applied', note: '原答被判 again，不能升级。', attemptIds: ['att-error'],
  }, '2026-10-09T02:00:00Z'), (err) => err.code === 'E_STATE');
});

test('a later explicit re-rating of the original as good restores its independence', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-a', '2026-10-09T01:00:00Z', { answer: '13/26=1/2。' });
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-a', rating: 'again', note: '先判错误。', assessmentId: 'a1',
  }, '2026-10-09T01:05:00Z').state;
  state = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-a', rating: 'good', note: '再次核对原答正确。', assessmentId: 'a2',
  }, '2026-10-09T01:10:00Z').state;
  const out = applyTutorEvidence(state, model, {
    promptId: 'p-apply', status: 'applied', note: '原答确实独立应用正确。', attemptIds: ['att-a'],
  }, '2026-10-09T02:00:00Z');
  assert.equal(out.state.promptEvidence['p-apply'].status, 'applied');
  assert.equal(out.state.promptEvidence['p-apply'].independent, true);
});

test('a hard rating (difficulty, not failure) does not strip independence', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  state = applyTutorAssessment(state, model, {
    promptId: 'p-explain', attemptId: 'att-a', rating: 'hard', note: '能解释，但过程吃力。', assessmentId: 'a1',
  }, '2026-10-09T01:10:00Z').state;
  const out = applyTutorEvidence(state, model, {
    promptId: 'p-explain', status: 'explained', note: '独立解释到位。', attemptIds: ['att-a'],
  }, '2026-10-09T02:00:00Z');
  assert.equal(out.state.promptEvidence['p-explain'].independent, true);
});

test('an unevaluated independent answer keeps its existing evidence compatibility', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z');
  const out = applyTutorEvidence(state, model, {
    promptId: 'p-explain', status: 'explained', note: '未评价原答仍按既有规则。', attemptIds: ['att-a'],
  }, '2026-10-09T02:00:00Z');
  assert.equal(out.state.promptEvidence['p-explain'].independent, true);
});

// ---------------------------------------------------------------------------
// Unsupported mastery: own questions cannot back a positive evidence status
// ---------------------------------------------------------------------------

test('tutorEvidenceHasBasis mirrors the frozen prompt reference/criteria rule', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-09T00:00:00Z');
  // A model prompt carries an author reference and criteria.
  assert.equal(tutorEvidenceHasBasis(model, state, 'p-explain'), true);
  // A learner question carries neither and can never back a positive judgement.
  const withOwn = applyOwnQuestion(state, model, { id: 'q-own', conceptId: 'root', text: '这个规则适用于所有情境吗？' }, '2026-10-09T01:00:00Z').state;
  assert.equal(tutorEvidenceHasBasis(model, withOwn, 'q-own'), false);
  assert.equal(tutorEvidenceHasBasis(model, withOwn, 'does-not-exist'), false);
});

test('two separated answers to an own question cannot be granted retained mastery', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-08T00:00:00Z');
  state = applyOwnQuestion(state, model, { id: 'q-own', conceptId: 'root', text: '自创问题：如何理解条件范围？' }, '2026-10-08T00:10:00Z').state;
  state = submit(state, model, 'q-own', 'att-own-a', '2026-10-08T08:00:00Z', { answer: '合成第一次：限定分母。', round: null });
  state = submit(state, model, 'q-own', 'att-own-b', '2026-10-09T09:00:00Z', { answer: '合成第二次：限定分母。', round: null });
  // The exact parent reproduction: 24h apart, independent, but no checkable basis.
  assert.throws(() => applyTutorEvidence(state, model, {
    promptId: 'q-own', status: 'retained', note: '两条相隔 24h 的独立作答。', attemptIds: ['att-own-a', 'att-own-b'],
  }, '2026-10-09T09:30:00Z'), (err) => err.code === 'E_STATE' && /可核对|判定标准|参考/.test(err.message));
  // The same for the other positive statuses, on both the prompt and concept paths.
  for (const status of ['explained', 'applied']) {
    assert.throws(() => applyTutorEvidence(state, model, {
      promptId: 'q-own', status, note: 'x', attemptIds: ['att-own-a'],
    }, '2026-10-09T10:00:00Z'), (err) => err.code === 'E_STATE', `${status} must be refused on a basis-less prompt`);
  }
  assert.throws(() => applyTutorEvidence(state, model, {
    conceptId: 'root', status: 'applied', note: 'x', attemptIds: ['att-own-a'],
  }, '2026-10-09T10:00:00Z'), (err) => err.code === 'E_STATE', 'the concept path must also refuse an unsupported basis');
  // Discussion statuses stay available.
  for (const status of ['unknown', 'needs-work']) {
    const out = applyTutorEvidence(state, model, {
      promptId: 'q-own', status, note: '讨论与缺口。',
    }, '2026-10-09T10:00:00Z');
    assert.equal(out.state.promptEvidence['q-own'].status, status, `${status} must stay allowed`);
  }
});

test('a mixed concept review with two unsupported answers cannot satisfy retained', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-08T00:00:00Z');
  state = applyOwnQuestion(state, model, { id: 'q-own', conceptId: 'root', text: '自创问题' }, '2026-10-08T00:10:00Z').state;
  state = submit(state, model, 'q-own', 'att-own-a', '2026-10-08T08:00:00Z', { round: null });
  state = submit(state, model, 'q-own', 'att-own-b', '2026-10-09T09:00:00Z', { round: null });
  // Concept evidence naming only unsupported own-question answers is refused.
  assert.throws(() => applyTutorEvidence(state, model, {
    conceptId: 'root', status: 'retained', note: '两条自创独立作答。', attemptIds: ['att-own-a', 'att-own-b'],
  }, '2026-10-09T09:30:00Z'), (err) => err.code === 'E_STATE');
});

test('a supported model answer still grants a positive evidence status', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-08T00:00:00Z');
  state = createState(model, '2026-10-08T00:00:00Z');
  state = submit(state, model, 'p-apply', 'att-a', '2026-10-08T08:00:00Z', { answer: '13/26=1/2。' });
  const out = applyTutorEvidence(state, model, {
    promptId: 'p-apply', status: 'applied', note: '应用正确且独立。', attemptIds: ['att-a'],
  }, '2026-10-08T09:00:00Z');
  assert.equal(out.state.promptEvidence['p-apply'].status, 'applied');
  assert.equal(out.state.promptEvidence['p-apply'].independent, true);
});

test('a pre-existing unsupported evidence record stays historical and inactive', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-08T00:00:00Z');
  state = applyOwnQuestion(state, model, { id: 'q-own', conceptId: 'root', text: '自创问题' }, '2026-10-08T00:10:00Z').state;
  state = submit(state, model, 'q-own', 'att-own-a', '2026-10-08T08:00:00Z', { round: null });
  state = submit(state, model, 'q-own', 'att-own-b', '2026-10-09T09:00:00Z', { round: null });
  // Simulate a record the old baseline would have accepted.
  state.promptEvidence['q-own'] = {
    status: 'retained', note: '旧档错误记录', reviewer: 'tutor', at: '2026-10-09T09:30:00Z',
    promptId: 'q-own', fingerprint: promptFingerprint(model, state, 'q-own'), conceptId: 'root',
    conceptFingerprint: model.conceptFingerprints.root, attemptIds: ['att-own-a', 'att-own-b'], independent: true,
  };
  // The archive still validates (history is never destroyed) ...
  assert.doesNotThrow(() => validateStateShape(JSON.parse(JSON.stringify(state)), model));
  // ... but the read model never shows it as active mastery.
  assert.equal(isPromptEvidenceActive(model, state, 'q-own'), false);
});

// ---------------------------------------------------------------------------
// Snapshot validation: a corrupt frozen record cannot rate a different answer
// ---------------------------------------------------------------------------

test('a frozen member must still match the immutable answer it names', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z', { answer: '真正的原答' });
  state = startReviewRequest(state, model, { requestId: 'req-1', roundId: 'round-1' }, '2026-10-09T02:00:00Z').state;
  // The frozen snapshot is self-describing: fingerprints, targets and the exact
  // attempt it names.
  assert.equal(validateReviewRequests(state, { state }), true);
  const tampered = JSON.parse(JSON.stringify(state));
  tampered.reviewRequests['req-1'].members[0].answer = '被篡改的原文';
  assert.throws(() => validateReviewRequests(tampered, { state: tampered }), (err) => err.code === 'E_STATE');
  const wrongPrompt = JSON.parse(JSON.stringify(state));
  wrongPrompt.reviewRequests['req-1'].members[0].promptId = 'p-apply';
  assert.throws(() => validateReviewRequests(wrongPrompt, { state: wrongPrompt }), (err) => err.code === 'E_STATE');
  const missingAttempt = JSON.parse(JSON.stringify(state));
  missingAttempt.reviewRequests['req-1'].members[0].attemptId = 'att-does-not-exist';
  assert.throws(() => validateReviewRequests(missingAttempt, { state: missingAttempt }), (err) => err.code === 'E_STATE');
  // A request without a content snapshot is refused.
  const noSnapshot = JSON.parse(JSON.stringify(state));
  delete noSnapshot.reviewRequests['req-1'].snapshot;
  assert.throws(() => validateReviewRequests(noSnapshot, { state: noSnapshot }), (err) => err.code === 'E_STATE');
});

test('a legacy answer without a fingerprint stays readable but can never be completed', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-legacy', '2026-10-09T01:00:00Z');
  // Simulate an old archive record that never recorded a fingerprint.
  state.attempts['p-explain'][0].fingerprint = null;
  const started = startReviewRequest(state, model, { requestId: 'req-legacy', roundId: 'round-1' }, '2026-10-09T02:00:00Z');
  assert.equal(started.request.members[0].fingerprint, null);
  // The member is structurally valid (a real legacy record) ...
  assert.equal(validateReviewRequests(started.state, { state: started.state }), true);
  // ... but a completed result on it is refused, and a live write downgrades to
  // stale instead of rating a fingerprint-less answer as current.
  const result = applyReviewItem(started.state, model, {
    requestId: 'req-legacy', promptId: 'p-explain', attemptId: 'att-legacy', feedback: completedFeedback(),
  }, '2026-10-09T03:00:00Z');
  assert.equal(result.rated, false);
  assert.equal(result.member.status, 'stale');
  assert.equal((result.state.attempts['p-explain'][0].tutorAssessments ?? []).length, 0);
  // A manually promoted completion is rejected on read.
  const promoted = JSON.parse(JSON.stringify(started.state));
  promoted.reviewRequests['req-legacy'].members[0].status = 'completed';
  promoted.reviewRequests['req-legacy'].members[0].feedback = completedFeedback();
  assert.throws(() => validateReviewRequests(promoted, { state: promoted }), (err) => err.code === 'E_STATE');
});

// ---------------------------------------------------------------------------
// Public CLI and HTTP boundary
// ---------------------------------------------------------------------------

test('CLI review-start/read/item persist a frozen scope and per-item feedback', () => {
  const dir = tmpDir();
  try {
    writeModel(dir);
    runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    runJson(roundArgs(dir));
    const explainTask = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-explain');
    const applyTask = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-apply');
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-a', '--answer', '合成原答 A', '--round-id', 'round-1', '--task-id', explainTask.id]);
    runJson(['submit', '--out', dir, '--prompt', 'p-apply', '--attempt-id', 'att-b', '--answer', '合成原答 B', '--round-id', 'round-1', '--task-id', applyTask.id]);
    const started = runJson(['review-start', '--out', dir, '--request-id', 'req-cli', '--round-id', 'round-1']);
    assert.equal(started.scope, 'round');
    assert.deepEqual(started.members.map((m) => m.attemptId).sort(), ['att-a', 'att-b']);
    // A new answer after the freeze is the next request's work, not this one's.
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-c', '--answer', '合成后来原答', '--round-id', 'round-1', '--task-id', explainTask.id]);
    const fbFile = path.join(dir, 'fb-a.json');
    atomicWrite(fbFile, stableStringify(completedFeedback({ rating: 'again' })));
    const item = runJson(['review-item', '--out', dir, '--request-id', 'req-cli', '--prompt', 'p-explain', '--attempt-id', 'att-a', '--feedback', fbFile]);
    assert.equal(item.changed, true);
    assert.equal(item.rated, true);
    assert.equal(item.status, 'completed');
    const read = runJson(['review-read', '--out', dir, '--request-id', 'req-cli']);
    const view = read.requests.find((r) => r.id === 'req-cli');
    assert.equal(view.completed, 1);
    assert.equal(view.remaining, 1);
    assert.ok(view.members.find((m) => m.attemptId === 'att-b').reference, 'the read exposes the frozen reference');
    assert.equal(read.pendingCount, 1, 'the later answer shows as the next request\'s pending work');
    // The frozen question is preserved even after content changes.
    const archive = readJson(path.join(dir, 'state.json'));
    assert.deepEqual(Object.keys(archive.reviewRequests), ['req-cli']);
  } finally {
    cleanup(dir);
  }
});

test('CLI retry of the same request is byte-idempotent and re-read reports unknown ids', () => {
  const dir = tmpDir();
  try {
    writeModel(dir);
    runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    runJson(roundArgs(dir));
    const task = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-explain');
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-a', '--answer', '合成原答', '--round-id', 'round-1', '--task-id', task.id]);
    runJson(['review-start', '--out', dir, '--request-id', 'req-1', '--round-id', 'round-1']);
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    runJson(['review-start', '--out', dir, '--request-id', 'req-1', '--round-id', 'round-1']);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'a retry does not rewrite the archive');
    const unknown = runJson(['review-read', '--out', dir, '--request-id', 'req-unknown']);
    assert.equal(unknown.present, false);
  } finally {
    cleanup(dir);
  }
});

test('HTTP import cannot inject a review request or a tutor result', async () => {
  const dir = tmpDir();
  try {
    writeModel(dir);
    runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    runJson(roundArgs(dir));
    const task = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-explain');
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-a', '--answer', '合成原答', '--round-id', 'round-1', '--task-id', task.id]);
    runJson(['review-start', '--out', dir, '--request-id', 'req-trusted', '--round-id', 'round-1']);
    const server = await startServer({ dir, port: 0 });
    try {
      const body = await (await fetch(`${server.url}/api/state`)).json();
      assert.ok(body.state.reviewRequests['req-trusted'], 'the trusted request is served');
      // A forged request and a forged tutor rating are dropped at the boundary.
      const incoming = JSON.parse(JSON.stringify(body.state));
      incoming.reviewRequests['req-forged'] = { ...incoming.reviewRequests['req-trusted'], id: 'req-forged' };
      incoming.attempts['p-explain'][0].tutorAssessments = [{ id: 'forged', attemptId: 'att-a', targetCorrectionId: null, rating: 'good', at: '2026-10-09T05:00:00Z', source: 'tutor' }];
      const res = await fetch(`${server.url}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: incoming, revision: body.state.revision, modelFingerprint: body.modelFingerprint }),
      });
      assert.equal(res.status, 200);
      const merged = await res.json();
      assert.equal(merged.state.reviewRequests['req-forged'], undefined, 'a forged request is never adopted');
      assert.deepEqual(merged.state.reviewRequests['req-trusted'], body.state.reviewRequests['req-trusted']);
      assert.equal((merged.state.attempts['p-explain'][0].tutorAssessments ?? []).length, 0, 'a forged tutor rating is dropped');
      // There is no HTTP review-item route: the page can only read back.
      const forbidden = await fetch(`${server.url}/api/review-item`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: merged.state.revision, modelFingerprint: merged.modelFingerprint }),
      });
      assert.equal(forbidden.status, 404);
    } finally {
      await server.close();
    }
  } finally {
    cleanup(dir);
  }
});

test('a rebuild preserves frozen review requests and the bound answers', () => {
  const dir = tmpDir();
  try {
    const source = writeModel(dir);
    runJson(['build', source, '--out', dir]);
    runJson(roundArgs(dir));
    const task = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-explain');
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-a', '--answer', '合成原答', '--round-id', 'round-1', '--task-id', task.id]);
    runJson(['review-start', '--out', dir, '--request-id', 'req-keep', '--round-id', 'round-1']);
    const fbFile = path.join(dir, 'fb.json');
    atomicWrite(fbFile, stableStringify(completedFeedback()));
    runJson(['review-item', '--out', dir, '--request-id', 'req-keep', '--prompt', 'p-explain', '--attempt-id', 'att-a', '--feedback', fbFile]);
    // Rebuild from the same model.
    runJson(['build', source, '--out', dir]);
    const read = runJson(['review-read', '--out', dir, '--request-id', 'req-keep']);
    assert.equal(read.requests[0].completed, 1);
    assert.equal(read.state, undefined);
    const archive = readJson(path.join(dir, 'state.json'));
    assert.equal(archive.reviewRequests['req-keep'].members[0].status, 'completed');
    assert.equal(archive.attempts['p-explain'][0].answer, '合成原答');
  } finally {
    cleanup(dir);
  }
});

test('history rejects duplicate ids, claimed answers and already-assessed answers', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-h1', '2026-10-09T01:00:00Z', { round: null });
  state = submit(state, model, 'p-apply', 'att-h2', '2026-10-09T01:10:00Z', { round: null });
  const before = stableStringify(state);
  // A duplicate --attempt would freeze the same answer twice: rejected, no write.
  assert.throws(() => startReviewRequest(state, model,
    { requestId: 'req-dup', history: true, attemptIds: ['att-h1', 'att-h1'] }, '2026-10-09T02:00:00Z'),
    (err) => err.code === 'E_USAGE' && /重复/.test(err.message));
  assert.equal(stableStringify(state), before, 'a rejected duplicate writes nothing');
  // A fixed request owns its members: another request cannot re-claim them.
  const claimedState = startReviewRequest(state, model,
    { requestId: 'req-first', history: true, attemptIds: ['att-h1'] }, '2026-10-09T02:00:00Z').state;
  assert.throws(() => startReviewRequest(claimedState, model,
    { requestId: 'req-second', history: true, attemptIds: ['att-h1'] }, '2026-10-09T03:00:00Z'),
    (err) => err.code === 'E_CONFLICT' && /固定/.test(err.message));
  // An answer already tutor-assessed is no longer pending.
  const assessed = applyTutorAssessment(state, model, {
    promptId: 'p-apply', attemptId: 'att-h2', rating: 'good', note: '已复核。', assessmentId: 'a-1',
  }, '2026-10-09T02:00:00Z').state;
  assert.throws(() => startReviewRequest(assessed, model,
    { requestId: 'req-assessed', history: true, attemptIds: ['att-h2'] }, '2026-10-09T03:00:00Z'),
    (err) => err.code === 'E_CONFLICT' && /导师评价|待复核/.test(err.message));
});

test('an identical failure retry writes nothing and does not bump the revision', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-09T00:00:00Z');
  state = startReviewRequest(submit(state, model, 'p-explain', 'att-a', '2026-10-09T01:00:00Z', { round: null }),
    model, { requestId: 'req-1', history: true, attemptIds: ['att-a'] }, '2026-10-09T02:00:00Z').state;
  for (const feedback of [
    { status: 'undetermined', reason: '需要核对计算过程。' },
    { status: 'missing-basis', reason: '缺少可核对材料。' },
    { status: 'stale', reason: '内容已更新。' },
  ]) {
    const first = applyReviewItem(state, model, { requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback }, '2026-10-09T03:00:00Z');
    assert.equal(first.changed, true);
    const snapshot = stableStringify(first.state);
    const retry = applyReviewItem(first.state, model, { requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback }, '2026-10-09T04:00:00Z');
    assert.equal(retry.changed, false, `${feedback.status} retry must be a no-op`);
    assert.equal(stableStringify(retry.state), snapshot);
    // A changed reason is a real edit and is written.
    const changedReason = applyReviewItem(first.state, model, { requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: { ...feedback, reason: '换一个说明理由。' } }, '2026-10-09T05:00:00Z');
    assert.equal(changedReason.changed, true);
    assert.equal(changedReason.member.reason, '换一个说明理由。');
    // A legal success on the still-unfinished member is written.
    const success = applyReviewItem(first.state, model, { requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback() }, '2026-10-09T05:00:00Z');
    assert.equal(success.changed, true);
    assert.equal(success.rated, true);
    // Reset for the next failure status.
    state = applyReviewItem(first.state, model, { requestId: 'req-1', promptId: 'p-explain', attemptId: 'att-a', feedback }, '2026-10-09T04:00:00Z').state;
  }
});

test('a request-scoped read reports its own round\'s new answers and lists history ids', () => {
  const dir = tmpDir();
  try {
    writeModel(dir);
    runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    runJson(roundArgs(dir));
    const task = runJson(['round-read', '--out', dir]).round.tasks.find((t) => t.promptId === 'p-explain');
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-a', '--answer', '合成原答', '--round-id', 'round-1', '--task-id', task.id]);
    runJson(['review-start', '--out', dir, '--request-id', 'req-1', '--round-id', 'round-1']);
    // One later round-1 answer and one genuinely unbound history answer.
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-c', '--answer', '合成后来原答', '--round-id', 'round-1', '--task-id', task.id]);
    runJson(['submit', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-history', '--answer', '合成无轮次历史']);
    const read = runJson(['review-read', '--out', dir, '--request-id', 'req-1']);
    assert.equal(read.roundId, 'round-1', 'the request derives its own round');
    assert.deepEqual(read.pendingAttempts.map((a) => a.attemptId), ['att-c'],
      'the request read counts the round\'s later answers, not history');
    assert.equal(read.historyPendingCount, 1, 'history is reported separately by count');
    // The dedicated history read lists the concrete ids a learner can choose.
    const history = runJson(['review-read', '--out', dir, '--history']);
    assert.deepEqual(history.historyPendingAttempts.map((a) => a.attemptId), ['att-history']);
    assert.equal(history.pendingCount, history.historyPendingCount, 'a history read scopes pending to the unbound answers');
    assert.equal(history.requests.length, 0, 'history read excludes the unfinished round request');
    assert.equal(history.openPendingCount, 0, 'round members never inflate historical remaining work');
    runJson(['review-start', '--out', dir, '--request-id', 'req-history', '--history', '--attempt', 'att-history']);
    const claimedHistory = runJson(['review-read', '--out', dir, '--history']);
    assert.deepEqual(claimedHistory.requests.map((r) => r.id), ['req-history']);
    assert.equal(claimedHistory.openPendingCount, 1);
    assert.equal(claimedHistory.pendingCount, 0);
  } finally {
    cleanup(dir);
  }
});

test('a malformed reviewRequests bucket is rejected, not silently erased', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-09T00:00:00Z');
  for (const bad of [[], 'nope', 42]) {
    const raw = { ...state, reviewRequests: bad };
    assert.throws(() => normalizeState(raw, model), (err) => err.code === 'E_STATE', `reviewRequests=${JSON.stringify(bad)} must be rejected`);
  }
  // Absent and null are legacy-compatible.
  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.reviewRequests;
  assert.doesNotThrow(() => normalizeState(legacy, model));
  const nulled = JSON.parse(JSON.stringify(state));
  nulled.reviewRequests = null;
  assert.doesNotThrow(() => normalizeState(nulled, model));
  assert.doesNotThrow(() => validateStateShape(normalizeState(state, model), model));
});
