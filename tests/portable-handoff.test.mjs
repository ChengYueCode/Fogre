// Ticket 07 backend acceptance: the standalone-file review handoff. These
// tests exercise the public core helpers, the public CLI and the local HTTP
// boundary on isolated temporary directories and assert the properties the
// ticket calls out for the backend half of the round-trip:
//   - a same-identity import merges later self-assessments, corrections,
//     notes and feedback instead of discarding them; the immutable original
//     (answer, submittedAt, assistance, prompt, content version) is kept;
//   - repeated identical imports are idempotent (no event, conflict, orphan or
//     revision growth) and a merged archive always reopens through the public
//     reader, even when an event id collides across prompts / attempts;
//   - legal late events re-participate in the existing schedule replay;
//   - a browser import strips incoming tutor privilege and keeps the current
//     trusted tutor result.
//
// Run: node --test tests/portable-handoff.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyAssessment,
  applyCorrection,
  applyReviewItem,
  applySubmission,
  applyTutorAssessment,
  createState,
  mergeImportedState,
  normalizeState,
  startReviewRequest,
  validateStateShape,
} from '../skill/forge/scripts/lib/state.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-handoff-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'handoff-model',
    title: '独立文件续接',
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

function baseModel() {
  return normalizeModel(rawModel());
}

function submit(state, model, promptId, attemptId, at, { answer, assisted = false } = {}) {
  return applySubmission(state, model, {
    promptId, attemptId, answer: answer ?? `${attemptId} 的原始作答`, assisted, source: 'cli',
  }, at).state;
}

function selfAssess(state, model, promptId, attemptId, rating, at, extra = {}) {
  return applyAssessment(state, model, { promptId, attemptId, rating, ...extra }, at).state;
}

function tutorAssess(state, model, promptId, attemptId, rating, note, at, extra = {}) {
  return applyTutorAssessment(state, model, { promptId, attemptId, rating, note, ...extra }, at).state;
}

function correct(state, model, promptId, attemptId, correctionId, text, at, extra = {}) {
  return applyCorrection(state, model, { promptId, attemptId, correctionId, text, ...extra }, at).state;
}

function completedFeedback(overrides = {}) {
  return {
    status: 'completed',
    correct: '正确部分',
    misconceptions: '常见误解',
    basis: '依据判定标准复核',
    repair: '修补说明',
    nextTask: '后续任务',
    rating: 'good',
    ...overrides,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
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

function build(dir) {
  const source = path.join(dir, 'source.json');
  atomicWrite(source, stableStringify(rawModel()));
  return runCli(['build', source, '--out', dir]);
}

// ---------------------------------------------------------------------------
// Merge: immutable original + late additions, event-identity dedup.
// ---------------------------------------------------------------------------

test('a same-identity import merges later self-assessment, correction and note without touching the original', () => {
  const model = baseModel();
  const originalAt = '2026-10-02T08:00:00Z';
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', originalAt, { answer: '原始答案', assisted: false });
  const original = current.attempts['p-explain'][0];

  // The other branch holds the same answer plus a later self-assessment and a
  // correction; its revision is far ahead but it must add events, not win.
  let incoming = structuredClone(current);
  incoming = selfAssess(incoming, model, 'p-explain', 'att-a', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-1' });
  incoming = correct(incoming, model, 'p-explain', 'att-a', 'corr-1', '补上分母说明', '2026-10-02T10:00:00Z', { assistance: ['tutor-feedback'] });
  incoming.revision = current.revision + 40;

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');
  const attempt = merged.attempts['p-explain'][0];
  assert.equal(attempt.answer, original.answer, 'the immutable original answer is kept');
  assert.equal(attempt.at, original.at, 'the original time is kept');
  assert.equal(attempt.submittedAt, original.submittedAt, 'the submission time is kept');
  assert.equal(attempt.assisted, false, 'the original independence is kept');
  assert.equal(attempt.fingerprint, original.fingerprint, 'the original content version is kept');
  assert.deepEqual(attempt.selfAssessments.map((e) => e.id), ['self-1'], 'the later self-assessment is added');
  assert.deepEqual(attempt.corrections.map((c) => c.id), ['corr-1'], 'the later correction is added');
  assert.equal(attempt.rating, 'good', 'the compatibility rating follows the merged self-assessment');
});

test('a legal late self-assessment re-participates in the existing schedule replay', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  assert.equal(current.schedules['p-explain'], undefined, 'a pending answer has no arrangement yet');

  let incoming = structuredClone(current);
  incoming = selfAssess(incoming, model, 'p-explain', 'att-a', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-1' });
  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');

  // The arrangement is recomputed from the merged history: a single good at the
  // real submission time is a 4-day interval, not a copied incoming date.
  assert.equal(merged.schedules['p-explain'].attemptId, 'att-a');
  assert.equal(merged.schedules['p-explain'].intervalDays, 4);
  assert.equal(merged.schedules['p-explain'].dueAt, '2026-10-06T08:00:00.000Z');
  assert.equal(merged.schedules['p-explain'].lastAt, '2026-10-02T08:00:00Z');
});

test('a divergent reuse of one event id is reported and the local event is kept', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = selfAssess(current, model, 'p-explain', 'att-a', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-shared' });

  const incoming = structuredClone(current);
  // Same event identity, divergent provenance: the local event must win.
  incoming.attempts['p-explain'][0].selfAssessments[0].source = 'browser';
  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged.attempts['p-explain'][0].selfAssessments[0].source, 'cli', 'the local event is kept');
  assert.ok(merged.conflicts.some((c) => c.kind === 'assessment' && c.path === 'selfAssessments.self-shared'));
});

// ---------------------------------------------------------------------------
// Idempotence: repeated identical import changes nothing durable.
// ---------------------------------------------------------------------------

test('a completely identical import is a no-op: revision, conflicts and orphans stay put', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = selfAssess(current, model, 'p-explain', 'att-a', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-1' });
  const incoming = structuredClone(current);
  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged, current, 'the current archive object is returned unchanged');
  assert.equal(merged.revision, current.revision, 'no revision is burned');
});

test('repeated import of the same divergent branch does not stack conflicts or orphans', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current.explanations.root = { text: '我的版本', updatedAt: '2026-10-02T08:00:00Z', author: 'learner' };

  const incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming.explanations.root = { text: '别人的版本', updatedAt: '2026-10-03T08:00:00Z', author: 'learner' };
  incoming.orphans = [{ kind: 'attempt', id: 'p-removed', message: '孤立', at: '2026-10-03T08:00:00Z' }];

  const once = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const twice = mergeImportedState(once, incoming, model, '2026-10-05T01:00:00Z');
  assert.equal(once.conflicts.length, 1);
  assert.equal(twice.conflicts.length, 1, 'the identical conflict is not stacked');
  assert.equal(once.orphans.length, 1);
  assert.equal(twice.orphans.length, 1, 'the identical orphan is not stacked');
  assert.equal(twice.updatedAt, once.updatedAt, 'the no-op propagation leaves the timestamp alone');
});

// ---------------------------------------------------------------------------
// Whole-archive identity collisions across prompts / attempts / events.
// ---------------------------------------------------------------------------

test('an attempt id reused across two prompts is reported once and the merged archive stays readable', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-shared', '2026-10-02T08:00:00Z', { answer: '解释作答' });
  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-apply', 'att-shared', '2026-10-02T09:00:00Z', { answer: '应用作答' });

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged.attempts['p-explain'].length, 1);
  assert.equal(merged.attempts['p-apply']?.length ?? 0, 0, 'the colliding attempt is not materialised twice');
  assert.ok(merged.conflicts.some((c) => c.kind === 'attempt' && c.incoming.answer === '应用作答'));
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');
});

test('an assessment or correction id reused across attempts is reported and its dependents drop with it', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = correct(current, model, 'p-explain', 'att-a', 'corr-shared', 'A 的修正', '2026-10-02T10:00:00Z');

  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-apply', 'att-b', '2026-10-02T08:30:00Z');
  incoming = correct(incoming, model, 'p-apply', 'att-b', 'corr-shared', 'B 的修正', '2026-10-02T09:00:00Z');
  incoming = selfAssess(incoming, model, 'p-apply', 'att-b', 'good', '2026-10-02T09:10:00Z', {
    targetCorrectionId: 'corr-shared', assessmentId: 'self-on-corr',
  });

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const b = merged.attempts['p-apply'][0];
  assert.deepEqual(b.corrections.map((c) => c.id), [], 'the colliding correction is dropped from the new attempt');
  assert.deepEqual(b.selfAssessments.map((e) => e.id), [], 'its dependent assessment drops with it');
  assert.ok(merged.conflicts.some((c) => c.kind === 'correction' && c.path === 'corrections.corr-shared'));
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');
});

test('a cross-attempt self-assessment id collision cannot leak its rating through the legacy scalar', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = submit(current, model, 'p-apply', 'att-b', '2026-10-02T08:30:00Z');
  // A different attempt of the same archive already owns the self-event id.
  current = selfAssess(current, model, 'p-apply', 'att-b', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-shared' });

  // The other branch self-assessed the same answer under the colliding id.
  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  incoming = selfAssess(incoming, model, 'p-explain', 'att-a', 'good', '2026-10-02T09:30:00Z', { assessmentId: 'self-shared' });
  assert.equal(incoming.attempts['p-explain'][0].rating, 'good');
  assert.equal(incoming.schedules['p-explain'].intervalDays, 4);

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const attempt = merged.attempts['p-explain'][0];
  assert.deepEqual(attempt.selfAssessments ?? [], [], 'the colliding self event is dropped');
  assert.equal(attempt.rating, null, 'the rejected event cannot leak its rating through the scalar');
  assert.equal(merged.schedules['p-explain'], undefined, 'no arrangement is built from the rejected event');
  assert.ok(merged.conflicts.some((c) => c.kind === 'assessment' && c.path === 'selfAssessments.self-shared'));
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');
});

test('validateStateShape rejects a pre-fix archive whose attempt id collides across prompts', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'att-dup', '2026-10-02T08:00:00Z');
  state = submit(state, model, 'p-apply', 'att-b', '2026-10-02T09:00:00Z');
  // Forge the collision directly, as a hand-edited pre-fix archive would carry.
  state.attempts['p-apply'][0].id = 'att-dup';
  assert.throws(() => validateStateShape(state, model), (err) => err.code === 'E_STATE' && /全档唯一/.test(err.message));
  assert.throws(() => normalizeState(state, model), (err) => err.code === 'E_STATE');
});

// ---------------------------------------------------------------------------
// Ticket 07 backend fixes: merge cannot produce an unreadable archive, legal
// completions are adopted, and conflicting correction text isolates dependents.
// ---------------------------------------------------------------------------

test('a new review request naming an answer dropped by the merge is reported and left out', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-shared', '2026-10-02T08:00:00Z', { answer: '解释作答' });

  // The other branch reused the same attempt id on a different prompt and froze
  // a review request over that answer. Merging drops the colliding attempt, so
  // the request can no longer resolve and must not be written.
  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-apply', 'att-shared', '2026-10-02T09:00:00Z', { answer: '应用作答' });
  incoming = startReviewRequest(incoming, model,
    { requestId: 'req-collide', history: true, attemptIds: ['att-shared'] }, '2026-10-02T10:00:00Z').state;

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged.reviewRequests['req-collide'], undefined, 'the unresolvable request is not adopted');
  assert.equal(merged.attempts['p-explain'][0].id, 'att-shared', 'the local answer is kept');
  assert.ok(merged.conflicts.some((c) => c.kind === 'review-request' && c.path === 'reviewRequests.req-collide'));
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens through the public reader');

  // Re-importing the same branch adds neither the request nor a second conflict.
  const twice = mergeImportedState(merged, incoming, model, '2026-10-05T01:00:00Z');
  assert.equal(twice, merged, 'the repeated conflicting import is a no-op');
  assert.equal(twice.conflicts.filter((c) => c.kind === 'review-request').length, 1);
});

test('a frozen request completed on another branch adopts the member completion and its feedback', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = startReviewRequest(current, model,
    { requestId: 'req-A', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  assert.equal(current.reviewRequests['req-A'].members[0].status, 'pending');

  let incoming = structuredClone(current);
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-A', promptId: 'p-explain', attemptId: 'att-a',
    feedback: completedFeedback({ basis: '依据判定标准复核' }),
  }, '2026-10-02T11:00:00Z').state;
  assert.equal(incoming.reviewRequests['req-A'].members[0].status, 'completed');
  assert.equal(incoming.attempts['p-explain'][0].tutorAssessments.length, 1, 'the branch recorded a real tutor assessment');

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const request = merged.reviewRequests['req-A'];
  assert.equal(request.status, 'completed', 'the legal late completion advances the request');
  assert.equal(request.members[0].status, 'completed');
  assert.equal(request.members[0].feedback.basis, '依据判定标准复核');
  assert.equal(merged.attempts['p-explain'][0].tutorAssessments.length, 1, 'the accepted assessment is merged');
  assert.equal(merged.schedules['p-explain'].assessmentSource, 'tutor');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');

  const twice = mergeImportedState(merged, incoming, model, '2026-10-05T01:00:00Z');
  assert.equal(twice, merged, 're-importing the completed branch is a no-op');

  // A divergent rewrite of the finished result is reported, never applied.
  const divergent = structuredClone(incoming);
  divergent.reviewRequests['req-A'].members[0].feedback.basis = '改写的依据';
  const kept = mergeImportedState(merged, divergent, model, '2026-10-05T02:00:00Z');
  assert.equal(kept.reviewRequests['req-A'].members[0].feedback.basis, '依据判定标准复核', 'the completed result is protected');
  assert.ok(kept.conflicts.some((c) => c.path === 'reviewRequests.req-A.members[0]'));
});

test('a same-id correction with different text keeps the current text and isolates conflicting incoming events', () => {
  const model = baseModel();
  const submittedAt = '2026-10-02T08:00:00Z';
  const correctionAt = '2026-10-02T09:00:00Z';
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', submittedAt);
  current = correct(current, model, 'p-explain', 'att-a', 'corr-1', '第一版', correctionAt);
  current = startReviewRequest(current, model,
    { requestId: 'req-C', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;

  // The other branch edited the same correction id to different text, graded
  // that text through the same frozen request (same id, same freeze time), and
  // exported the branch.
  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-explain', 'att-a', submittedAt);
  incoming = correct(incoming, model, 'p-explain', 'att-a', 'corr-1', '第二版', correctionAt);
  incoming = startReviewRequest(incoming, model,
    { requestId: 'req-C', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-C', promptId: 'p-explain', attemptId: 'att-a',
    feedback: completedFeedback({ basis: '针对第二版', targetCorrectionId: 'corr-1' }),
  }, '2026-10-02T12:00:00Z').state;
  assert.equal(incoming.reviewRequests['req-C'].members[0].status, 'completed');

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const attempt = merged.attempts['p-explain'][0];
  assert.equal(attempt.corrections[0].text, '第一版', 'the current correction text is kept');
  assert.deepEqual(attempt.tutorAssessments ?? [], [], 'the assessment of the other text is isolated');
  assert.deepEqual(attempt.tutorFeedback ?? [], [], 'its feedback is dropped with the assessment');
  assert.notEqual(merged.schedules['p-explain']?.assessmentSource, 'tutor', 'the other text never drives the arrangement');
  const request = merged.reviewRequests['req-C'];
  assert.equal(request.members[0].status, 'pending', 'the dependent completion is not adopted');
  assert.equal(request.status, 'open');
  assert.ok(merged.conflicts.some((c) => c.kind === 'correction' && c.path === 'corrections.corr-1'));
  assert.ok(merged.conflicts.some((c) => c.kind === 'review-request' && c.path === 'reviewRequests.req-C.members[0]'));
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive reopens');

  const twice = mergeImportedState(merged, incoming, model, '2026-10-05T01:00:00Z');
  assert.equal(twice, merged, 'the repeated conflicting import is a no-op');
});

test('a new request is refused when its completed member rests on a same-id assessment the merge replaced', () => {
  const model = baseModel();
  // The local branch already holds tutor assessment id `tut-shared`.
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = tutorAssess(current, model, 'p-explain', 'att-a', 'again', '当前依据', '2026-10-02T09:00:00Z',
    { assessmentId: 'tut-shared' });

  // The other branch finished a brand-new request, but its tutor event reuses
  // the same id with a different rating and basis.
  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  incoming = startReviewRequest(incoming, model,
    { requestId: 'req-N', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-N', promptId: 'p-explain', attemptId: 'att-a',
    feedback: completedFeedback({ rating: 'good', basis: '传入依据' }),
  }, '2026-10-02T11:00:00Z').state;
  const incAttempt = incoming.attempts['p-explain'][0];
  incAttempt.tutorAssessments[0].id = 'tut-shared';
  incAttempt.tutorFeedback[0].id = 'feedback-tut-shared';
  incAttempt.tutorFeedback[0].assessmentId = 'tut-shared';

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const events = merged.attempts['p-explain'][0].tutorAssessments;
  assert.equal(events.length, 1);
  assert.equal(events[0].rating, 'again', 'the local accepted assessment is kept');
  assert.equal(merged.reviewRequests['req-N'], undefined, 'the unsupported new completion is not adopted');
  assert.ok(merged.conflicts.some((c) => c.kind === 'review-request' && c.path === 'reviewRequests.req-N'));
  assert.doesNotThrow(() => normalizeState(merged, model));

  const twice = mergeImportedState(merged, incoming, model, '2026-10-05T01:00:00Z');
  assert.equal(twice, merged, 'the repeated conflicting import is a no-op');
});

test('a new request completed against a conflicting correction is refused with its dropped assessment', () => {
  const model = baseModel();
  const submittedAt = '2026-10-02T08:00:00Z';
  const correctionAt = '2026-10-02T09:00:00Z';
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', submittedAt);
  current = correct(current, model, 'p-explain', 'att-a', 'corr-1', '第一版', correctionAt);

  let incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming = submit(incoming, model, 'p-explain', 'att-a', submittedAt);
  incoming = correct(incoming, model, 'p-explain', 'att-a', 'corr-1', '第二版', correctionAt);
  incoming = startReviewRequest(incoming, model,
    { requestId: 'req-N', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-N', promptId: 'p-explain', attemptId: 'att-a',
    feedback: completedFeedback({ basis: '针对第二版', targetCorrectionId: 'corr-1' }),
  }, '2026-10-02T11:00:00Z').state;

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged.attempts['p-explain'][0].corrections[0].text, '第一版');
  assert.equal(merged.reviewRequests['req-N'], undefined, 'the unsupported completion is not adopted');
  assert.ok(merged.conflicts.some((c) => c.kind === 'review-request' && c.path === 'reviewRequests.req-N'));
  assert.doesNotThrow(() => normalizeState(merged, model));
});

test('a divergent request snapshot blocks the conflicting completion and keeps the frozen identity', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = startReviewRequest(current, model,
    { requestId: 'req-A', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;

  let incoming = structuredClone(current);
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-A', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback(),
  }, '2026-10-02T11:00:00Z').state;
  assert.equal(incoming.reviewRequests['req-A'].members[0].status, 'completed');
  // The incoming request was frozen against a different content snapshot.
  incoming.reviewRequests['req-A'].snapshot.promptFingerprints['p-explain'] = 'different-fingerprint';

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged.reviewRequests['req-A'].members[0].status, 'pending', 'the divergent snapshot result is not adopted');
  assert.equal(merged.reviewRequests['req-A'].status, 'open');
  assert.ok(merged.conflicts.some((c) => c.path === 'reviewRequests.req-A.snapshot'));
  assert.doesNotThrow(() => normalizeState(merged, model));
});

test('a divergent frozen member fact is reported and never overwrites the current snapshot', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = startReviewRequest(current, model,
    { requestId: 'req-A', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  const frozenQuestion = current.reviewRequests['req-A'].members[0].question;

  let incoming = structuredClone(current);
  incoming = applyReviewItem(incoming, model, {
    requestId: 'req-A', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback(),
  }, '2026-10-02T11:00:00Z').state;
  incoming.reviewRequests['req-A'].members[0].question = '被改写的题目';

  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  const member = merged.reviewRequests['req-A'].members[0];
  assert.equal(member.status, 'pending', 'the divergent completion is not adopted');
  assert.equal(member.question, frozenQuestion, 'the current frozen question is preserved');
  assert.ok(merged.conflicts.some((c) => c.path === 'reviewRequests.req-A.members[0]'));
  assert.doesNotThrow(() => normalizeState(merged, model));
});

test('a repeated non-completed resolution import is byte-stable and burns no revision', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = startReviewRequest(current, model,
    { requestId: 'req-U', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  current = applyReviewItem(current, model, {
    requestId: 'req-U', promptId: 'p-explain', attemptId: 'att-a',
    feedback: { status: 'undetermined', reason: '需要学习者补充依据' },
  }, '2026-10-02T11:00:00Z').state;
  assert.equal(current.reviewRequests['req-U'].members[0].status, 'undetermined');

  const incoming = structuredClone(current);
  const merged = mergeImportedState(current, incoming, model, '2026-10-05T00:00:00Z');
  assert.equal(merged, current, 'the repeated resolution import returns the current archive unchanged');
  assert.equal(merged.revision, current.revision, 'no revision is burned');
  assert.equal(merged.updatedAt, current.updatedAt);
  assert.equal(merged.reviewRequests['req-U'].updatedAt, current.reviewRequests['req-U'].updatedAt,
    'the request timestamp is untouched');
});

test('an older failure resolution cannot overwrite a newer resolution or a completed member', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  current = startReviewRequest(current, model,
    { requestId: 'req-U', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  current = applyReviewItem(current, model, {
    requestId: 'req-U', promptId: 'p-explain', attemptId: 'att-a',
    feedback: { status: 'undetermined', reason: '较新的决议' },
  }, '2026-10-03T12:00:00Z').state;

  // An older branch carries a different failure resolution for the same member.
  const older = structuredClone(current);
  older.reviewRequests['req-U'].members[0].reason = '较旧的决议';
  older.reviewRequests['req-U'].members[0].resolvedAt = '2026-10-03T09:00:00Z';
  const mergedOlder = mergeImportedState(current, older, model, '2026-10-05T00:00:00Z');
  assert.equal(mergedOlder.reviewRequests['req-U'].members[0].reason, '较新的决议', 'the newer resolution is kept');
  assert.ok(mergedOlder.conflicts.some((c) => c.path === 'reviewRequests.req-U.members[0]'));

  // A completed branch records the finished result; a later failure must not
  // downgrade it back to a failure status.
  let completed = createState(model, '2026-10-01T00:00:00Z');
  completed = submit(completed, model, 'p-explain', 'att-a', '2026-10-02T08:00:00Z');
  completed = startReviewRequest(completed, model,
    { requestId: 'req-D', history: true, attemptIds: ['att-a'] }, '2026-10-02T10:00:00Z').state;
  completed = applyReviewItem(completed, model, {
    requestId: 'req-D', promptId: 'p-explain', attemptId: 'att-a', feedback: completedFeedback(),
  }, '2026-10-02T11:00:00Z').state;
  const downgrade = structuredClone(completed);
  downgrade.reviewRequests['req-D'].members[0].status = 'undetermined';
  downgrade.reviewRequests['req-D'].members[0].reason = '后被标为待定';
  downgrade.reviewRequests['req-D'].members[0].feedback = null;
  downgrade.reviewRequests['req-D'].members[0].resolvedAt = '2026-10-04T11:00:00Z';
  const mergedDowngrade = mergeImportedState(completed, downgrade, model, '2026-10-05T00:00:00Z');
  assert.equal(mergedDowngrade.reviewRequests['req-D'].members[0].status, 'completed', 'the completion is protected');
  assert.notEqual(mergedDowngrade.reviewRequests['req-D'].members[0].feedback, null);
});

// ---------------------------------------------------------------------------
// Late additions survive an older-snapshot re-import (new feedback wins).
// ---------------------------------------------------------------------------

test('importing an older snapshot on top of a newer branch never loses late legal events', () => {
  const model = baseModel();
  let branch = createState(model, '2026-10-01T00:00:00Z');
  branch = submit(branch, model, 'p-explain', 'att-late', '2026-10-02T08:00:00Z');
  const oldSnapshot = structuredClone(branch); // no events yet

  let advanced = structuredClone(branch);
  advanced = selfAssess(advanced, model, 'p-explain', 'att-late', 'good', '2026-10-02T09:00:00Z', { assessmentId: 'self-late' });
  advanced = correct(advanced, model, 'p-explain', 'att-late', 'corr-late', '后补修正', '2026-10-02T10:00:00Z');
  advanced = tutorAssess(advanced, model, 'p-explain', 'att-late', 'good', '复核依据', '2026-10-02T11:00:00Z', { assessmentId: 'tutor-late' });

  const merged = mergeImportedState(advanced, oldSnapshot, model, '2026-10-05T00:00:00Z');
  const attempt = merged.attempts['p-explain'][0];
  assert.deepEqual(attempt.selfAssessments.map((e) => e.id), ['self-late']);
  assert.deepEqual(attempt.tutorAssessments.map((e) => e.id), ['tutor-late']);
  assert.deepEqual(attempt.corrections.map((c) => c.id), ['corr-late']);
  assert.equal(merged.schedules['p-explain'].assessmentSource, 'tutor', 'the tutor evaluation still drives the arrangement');
  assert.doesNotThrow(() => normalizeState(merged, model));
});

// ---------------------------------------------------------------------------
// Public CLI: export -> import -> readable readback.
// ---------------------------------------------------------------------------

test('CLI export/import merges late events from a handoff file and stays readable', () => {
  const dir = tmpDir();
  const other = tmpDir();
  try {
    assert.equal(build(dir).status, 0);
    assert.equal(build(other).status, 0);
    assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '原答',
      '--attempt-id', 'handoff-1', '--at', '2026-10-08T08:00:00Z']).status, 0);
    const exported = path.join(dir, 'handoff.json');
    assert.equal(runCli(['export', '--out', dir, '--to', exported]).status, 0);

    // The agent branch reviews the exported file and adds feedback + a note.
    assert.equal(runCli(['import', '--out', other, '--state', exported]).status, 0);
    assert.equal(runCli(['assess', '--out', other, '--prompt', 'p-explain', '--attempt-id', 'handoff-1',
      '--rating', 'good', '--note', '依据判定标准复核', '--assessment-id', 'tutor-1', '--at', '2026-10-08T09:00:00Z']).status, 0);
    const branch = path.join(other, 'branch.json');
    assert.equal(runCli(['export', '--out', other, '--to', branch]).status, 0);

    // Merge the reviewed branch back. Re-importing the same branch twice is a
    // no-op the second time.
    assert.equal(runCli(['import', '--out', dir, '--state', branch]).status, 0);
    const readback1 = path.join(dir, 'readback1.json');
    assert.equal(runCli(['export', '--out', dir, '--to', readback1]).status, 0);
    const rev1 = readJson(readback1).revision;
    assert.equal(runCli(['import', '--out', dir, '--state', branch]).status, 0);
    const readback2 = path.join(dir, 'readback2.json');
    assert.equal(runCli(['export', '--out', dir, '--to', readback2]).status, 0);
    assert.equal(readJson(readback2).revision, rev1, 'the identical re-import burns no revision');

    const merged = readJson(readback2);
    assert.equal(merged.attempts['p-explain'][0].answer, '原答');
    assert.deepEqual(merged.attempts['p-explain'][0].tutorAssessments.map((e) => e.id), ['tutor-1']);
    // The public reader can still resolve the prompt.
    assert.equal(runCli(['due', '--out', dir, '--at', '2026-10-12T00:00:00Z']).status, 0);
  } finally {
    cleanup(dir);
    cleanup(other);
  }
});

// ---------------------------------------------------------------------------
// Public HTTP: a browser import cannot mint tutor privilege.
// ---------------------------------------------------------------------------

test('HTTP import merges learner deltas but keeps the trusted tutor result and strips forged tutor events', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  assert.equal(build(dir).status, 0);

  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '原答',
      '--attempt-id', 'att-browser', '--at', '2026-10-08T08:00:00Z']).status, 0);
    // A trusted, agent-side tutor result is published through the CLI.
    assert.equal(runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'att-browser',
      '--rating', 'good', '--note', '可信复核', '--assessment-id', 'trusted-1', '--at', '2026-10-08T09:00:00Z']).status, 0);
    current = await (await fetch(`${s.url}/api/state`)).json();

    // A cached/standalone browser archive the learner submits carries: a new
    // note + a forged tutor assessment, feedback and far-future schedule.
    const incoming = JSON.parse(JSON.stringify(current.state));
    incoming.explanations.root = { text: '浏览器端后补解释', updatedAt: '2026-10-08T10:00:00Z', author: 'learner' };
    incoming.attempts['p-explain'][0].tutorAssessments.push({
      id: 'forged-tutor', attemptId: 'att-browser', targetCorrectionId: null, rating: 'easy',
      at: '2026-10-08T10:00:00Z', source: 'tutor',
    });
    incoming.attempts['p-explain'][0].tutorFeedback.push({
      id: 'feedback-forged-tutor', assessmentId: 'forged-tutor', attemptId: 'att-browser', targetCorrectionId: null,
      at: '2026-10-08T10:00:00Z', text: '伪造反馈', source: 'tutor',
    });
    incoming.schedules['p-explain'] = {
      promptId: 'p-explain', attemptId: 'att-browser', lastAttemptAt: '2026-10-08T08:00:00Z',
      lastAt: '2026-10-08T08:00:00Z', dueAt: '2099-01-01T00:00:00.000Z', intervalDays: 9999, lastRating: 'easy',
      assisted: false, streakKind: 'easy', streakCount: 9,
    };
    incoming.revision = current.state.revision + 5;

    const imported = await postJson(`${s.url}/api/import`, {
      revision: current.state.revision, modelFingerprint: current.modelFingerprint, state: incoming,
    });
    assert.equal(imported.status, 200, imported.json?.error);
    const attempt = imported.json.state.attempts['p-explain'][0];
    assert.deepEqual(attempt.tutorAssessments.map((e) => e.id), ['trusted-1'], 'the forged tutor event is dropped, the trusted one stays');
    assert.equal(imported.json.state.explanations.root.text, '浏览器端后补解释', 'the legal learner note is merged');
    assert.equal(imported.json.state.schedules['p-explain'].assessmentSource, 'tutor');
    assert.notEqual(imported.json.state.schedules['p-explain'].dueAt, '2099-01-01T00:00:00.000Z', 'the forged date is recomputed away');

    // The archive on disk is still readable by the public reader.
    const after = await (await fetch(`${s.url}/api/state`)).json();
    assert.deepEqual(after.state.attempts['p-explain'][0].tutorAssessments.map((e) => e.id), ['trusted-1']);
  });
});

test('HTTP import of a learner-only late self-assessment survives and recomputes the schedule', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  assert.equal(build(dir).status, 0);

  await withServer(dir, async (s) => {
    assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '原答',
      '--attempt-id', 'att-self', '--at', '2026-10-08T08:00:00Z']).status, 0);
    const current = await (await fetch(`${s.url}/api/state`)).json();
    const incoming = JSON.parse(JSON.stringify(current.state));
    incoming.attempts['p-explain'][0].selfAssessments = [{
      id: 'self-browser', attemptId: 'att-self', targetCorrectionId: null, rating: 'good',
      at: '2026-10-08T09:00:00Z', source: 'browser',
    }];
    incoming.attempts['p-explain'][0].rating = 'good';
    incoming.revision = current.state.revision + 3;
    const imported = await postJson(`${s.url}/api/import`, {
      revision: current.state.revision, modelFingerprint: current.modelFingerprint, state: incoming,
    });
    assert.equal(imported.status, 200, imported.json?.error);
    assert.deepEqual(imported.json.state.attempts['p-explain'][0].selfAssessments.map((e) => e.id), ['self-browser']);
    assert.equal(imported.json.state.schedules['p-explain'].intervalDays, 4);
    assert.equal(imported.json.state.schedules['p-explain'].dueAt, '2026-10-12T08:00:00.000Z');
  });
});
