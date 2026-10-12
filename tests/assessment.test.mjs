// Ticket 05 acceptance: self and tutor assessments are separate, immutable
// events tied to a real answer (or one of its corrections); the review
// arrangement is recomputed from assessed answers in real submission order; a
// later unassessed answer never steals the arrangement, and a tutor rating
// never upgrades mastery on its own.
//
// Everything runs through the public core helpers and the public CLI/HTTP
// surfaces on isolated temporary directories.
//
// Run: node --test tests/assessment.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyAssessment,
  applyCorrection,
  applySubmission,
  applyAttempt,
  applyTutorAssessment,
  createState,
  listDue,
  mergeImportedState,
  normalizeState,
  promptFingerprint,
  stateView,
} from '../skill/forge/scripts/lib/state.mjs';
import {
  scheduleEffectiveAssessment,
  scheduleReplay,
  scheduleSubmissionAnchor,
} from '../skill/forge/scripts/lib/schedule.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const CODES = { STATE: 'E_STATE', USAGE: 'E_USAGE', CONFLICT: 'E_CONFLICT' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-assess-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'assess-model',
    title: '评价与调度',
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

// Save a real (unassessed) answer through the public submission path so the
// attempt carries its actual submission time and assistance facts.
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

function runCli(args) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Replay ordering: current content, real submission time, stable id, one input
// per answer.
// ---------------------------------------------------------------------------

test('scheduleReplay only counts current-content answers and anchors on real submission time', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a-old', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'a-old', 'good', '2026-10-02T09:00:00Z');
  // An answer recorded against a different content version is not current evidence.
  state.attempts['p-explain'].push({
    id: 'a-stale', promptId: 'p-explain', conceptId: 'child', at: '2026-09-01T08:00:00Z',
    answer: '旧内容作答', rating: 'easy', assisted: false, source: 'cli', fingerprint: 'other-fingerprint',
    corrections: [], targetCorrectionId: null,
  });
  state.attempts['p-explain'].sort((a, b) => new Date(a.at) - new Date(b.at));

  const replay = scheduleReplay(state.attempts['p-explain'], 'p-explain', promptFingerprint(model, state, 'p-explain'));
  assert.equal(replay.attemptId, 'a-old', 'the stale answer never participates');
  assert.equal(replay.lastAttemptAt, '2026-10-02T08:00:00Z', 'anchor is the real submission time, not the rating time');
  assert.equal(replay.anchorSemantics, 'submission-at');
  assert.equal(replay.assessedAt, '2026-10-02T09:00:00Z', 'the evaluation time is stored separately');
  assert.equal(replay.dueAt, '2026-10-06T08:00:00.000Z', 'due is submission time + interval');
});

test('each answer contributes exactly one effective input: the latest tutor event wins over self', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'a1', 'hard', '2026-10-02T09:00:00Z', { assessmentId: 'self-1' });
  // Two tutor evaluations of the same answer: only the newest is effective.
  state = tutorAssess(state, model, 'p-explain', 'a1', 'hard', '第一次复核', '2026-10-02T10:00:00Z', { assessmentId: 'tutor-1' });
  state = tutorAssess(state, model, 'p-explain', 'a1', 'good', '第二次复核', '2026-10-02T11:00:00Z', { assessmentId: 'tutor-2' });

  const attempt = state.attempts['p-explain'][0];
  const effective = scheduleEffectiveAssessment(attempt);
  assert.equal(effective.id, 'tutor-2');
  assert.equal(effective.source, 'tutor');
  assert.equal(state.schedules['p-explain'].assessmentId, 'tutor-2');
  assert.equal(state.schedules['p-explain'].assessmentSource, 'tutor');
  assert.equal(state.schedules['p-explain'].lastRating, 'good');
  assert.equal(state.schedules['p-explain'].intervalDays, 4, 'one answer, one spacing step');
  assert.equal(state.schedules['p-explain'].streakCount, 1);
});

// ---------------------------------------------------------------------------
// The exact spec example and arrival-order permutation invariance.
// ---------------------------------------------------------------------------

function abScenario(order) {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'A', '2026-10-08T08:00:00Z', { answer: 'A 的作答' });
  state = submit(state, model, 'p-explain', 'B', '2026-10-09T08:00:00Z', { answer: 'B 的作答' });
  for (const step of order) {
    if (step === 'A-good') state = selfAssess(state, model, 'p-explain', 'A', 'good', '2026-10-08T09:00:00Z');
    if (step === 'B-good') state = tutorAssess(state, model, 'p-explain', 'B', 'good', 'B 复核', '2026-10-09T09:00:00Z');
    if (step === 'A-again') state = tutorAssess(state, model, 'p-explain', 'A', 'again', 'A 需要重来', '2026-10-10T08:00:00Z');
  }
  return { model, state };
}

test('the exact spec example ends on B: good streak 1, 4 days, due 2026-10-13T08:00Z', () => {
  const { model, state } = abScenario(['A-good', 'B-good', 'A-again']);
  const schedule = state.schedules['p-explain'];
  assert.equal(schedule.attemptId, 'B', 'the arrangement belongs to the last assessed answer');
  assert.equal(schedule.lastRating, 'good');
  assert.equal(schedule.streakKind, 'good');
  assert.equal(schedule.streakCount, 1, 'a late again on A restarts the streak at B');
  assert.equal(schedule.intervalDays, 4);
  assert.equal(schedule.dueAt, '2026-10-13T08:00:00.000Z');
  assert.equal(schedule.assessmentSource, 'tutor');
  // The learner still has both real answers and both evaluations.
  assert.deepEqual(state.attempts['p-explain'].map((a) => a.id), ['A', 'B']);
  assert.equal(state.attempts['p-explain'][0].tutorAssessments.length, 1);
  assert.equal(state.attempts['p-explain'][0].selfAssessments.length, 1, 'the original self rating is kept');
  void model;
});

test('assessment arrival order does not change the recomputed arrangement', () => {
  const forward = abScenario(['A-good', 'B-good', 'A-again']);
  const shuffled = abScenario(['B-good', 'A-again', 'A-good']);
  assert.deepEqual(forward.state.schedules, shuffled.state.schedules);
  assert.equal(forward.state.schedules['p-explain'].dueAt, '2026-10-13T08:00:00.000Z');
  // A late self rating for A while B is still good pushes the shared streak on.
  const lateSelf = abScenario(['B-good', 'A-good']);
  assert.equal(lateSelf.state.schedules['p-explain'].attemptId, 'B');
  assert.equal(lateSelf.state.schedules['p-explain'].streakCount, 2);
  assert.equal(lateSelf.state.schedules['p-explain'].intervalDays, 10);
  assert.equal(lateSelf.state.schedules['p-explain'].dueAt, '2026-10-19T08:00:00.000Z');
});

test('same-timestamp tutor assessments tie-break by stable ASCII event id', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  // A self rating and two tutor reviews all share one instant. The tutor class
  // wins over the self class, and inside the tutor class the ASCII-larger id
  // sorts last and is therefore the effective input.
  state = selfAssess(state, model, 'p-explain', 'a1', 'hard', '2026-10-02T09:00:00Z', { assessmentId: 'zzz-self' });
  state = tutorAssess(state, model, 'p-explain', 'a1', 'hard', '第一次复核', '2026-10-02T09:00:00Z', { assessmentId: 'aaa' });
  state = tutorAssess(state, model, 'p-explain', 'a1', 'good', '第二次复核', '2026-10-02T09:00:00Z', { assessmentId: 'bbb' });
  const schedule = state.schedules['p-explain'];
  assert.equal(schedule.assessmentId, 'bbb');
  assert.equal(schedule.assessmentSource, 'tutor');
  assert.equal(schedule.lastRating, 'good');
  // Replaying the same events reproduces the same result deterministically.
  const replay = scheduleReplay(state.attempts['p-explain'], 'p-explain', promptFingerprint(model, state, 'p-explain'));
  assert.deepEqual(replay, schedule);
  // The self rating at the same instant is preserved but not effective.
  assert.equal(state.attempts['p-explain'][0].selfAssessments.length, 1);
  assert.equal(state.attempts['p-explain'][0].rating, 'hard');
});

// ---------------------------------------------------------------------------
// Idempotency and conflicts.
// ---------------------------------------------------------------------------

test('a retried assessment id is idempotent; a different payload for that id conflicts', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  const once = applyAssessment(state, model, {
    promptId: 'p-explain', attemptId: 'a1', rating: 'good', assessmentId: 'self-fixed',
  }, '2026-10-02T09:00:00Z');
  const twice = applyAssessment(once.state, model, {
    promptId: 'p-explain', attemptId: 'a1', rating: 'good', assessmentId: 'self-fixed',
  }, '2026-10-02T09:00:00Z');
  assert.equal(twice.state, once.state, 'the identical retry returns the unchanged archive');
  assert.equal(once.state.attempts['p-explain'][0].selfAssessments.length, 1);
  assert.throws(
    () => applyAssessment(once.state, model, {
      promptId: 'p-explain', attemptId: 'a1', rating: 'easy', assessmentId: 'self-fixed',
    }, '2026-10-02T09:30:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
  // The same event id may not be reused for a different answer: the global id
  // check refuses it even though that answer has no event with that id yet.
  let two = submit(once.state, model, 'p-apply', 'b1', '2026-10-02T10:00:00Z');
  assert.throws(
    () => applyAssessment(two, model, {
      promptId: 'p-apply', attemptId: 'b1', rating: 'good', assessmentId: 'self-fixed',
    }, '2026-10-02T11:00:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
  assert.equal(two.attempts['p-apply'][0].selfAssessments, undefined, 'the rejected cross-answer write changed nothing');
});

test('a hand-edited archive with a forged event source is refused instead of used', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'a1', 'good', '2026-10-02T09:00:00Z', { assessmentId: 's1' });
  // A learner-side event must never claim tutor provenance.
  const forged = JSON.parse(JSON.stringify(state));
  forged.attempts['p-explain'][0].selfAssessments[0].source = 'tutor';
  assert.throws(() => normalizeState(forged, model), (err) => err.code === CODES.STATE);
  // Tutor feedback must reference a real tutor assessment.
  const orphanFeedback = JSON.parse(JSON.stringify(state));
  orphanFeedback.attempts['p-explain'][0].tutorFeedback = [{
    id: 'feedback-ghost', assessmentId: 'ghost', attemptId: 'a1', targetCorrectionId: null,
    at: '2026-10-02T09:00:00Z', text: '凭空反馈', source: 'tutor',
  }];
  assert.throws(() => normalizeState(orphanFeedback, model), (err) => err.code === CODES.STATE);
});

test('re-assessing the original with a different rating keeps the first self rating', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'a1', 'good', '2026-10-02T09:00:00Z');
  assert.throws(
    () => applyAssessment(state, model, { promptId: 'p-explain', attemptId: 'a1', rating: 'again' }, '2026-10-02T10:00:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
  assert.equal(state.attempts['p-explain'][0].rating, 'good');
});

// ---------------------------------------------------------------------------
// Corrections: conservative, never a new independent success.
// ---------------------------------------------------------------------------

test('assessing a correction is conservative and leaves the original answer intact', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'a1', 'again', '2026-10-02T08:30:00Z');
  state = applyCorrection(state, model, {
    promptId: 'p-explain', attemptId: 'a1', correctionId: 'c1',
    text: '修正后的解释', assistance: ['reference'], source: 'cli',
  }, '2026-10-02T09:00:00Z').state;
  state = selfAssess(state, model, 'p-explain', 'a1', 'good', '2026-10-02T10:00:00Z', {
    assessmentId: 'self-correction', targetCorrectionId: 'c1',
  });

  const attempt = state.attempts['p-explain'][0];
  assert.equal(attempt.rating, 'again', 'the original self rating is preserved');
  assert.equal(attempt.selfAssessments.length, 2, 'the correction keeps its own evaluation event');
  assert.equal(attempt.selfAssessments[1].targetCorrectionId, 'c1');
  assert.equal(attempt.corrections.length, 1, 'assessing a correction creates no new answer');
  // The effective input is the correction's good rating, but it stays assisted:
  // reworking the same answer is not a fresh independent retrieval.
  const effective = scheduleEffectiveAssessment(attempt);
  assert.equal(effective.rating, 'good');
  assert.equal(effective.targetCorrectionId, 'c1');
  assert.equal(effective.assisted, true);
  assert.equal(state.schedules['p-explain'].assisted, true);
  assert.ok(state.schedules['p-explain'].intervalDays <= 2, 'assisted outcomes stay conservative');
});

test('a tutor rating of a correction cannot turn the original error into independent success', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z', { assisted: false });
  state = selfAssess(state, model, 'p-explain', 'a1', 'again', '2026-10-02T08:30:00Z');
  state = applyCorrection(state, model, {
    promptId: 'p-explain', attemptId: 'a1', correctionId: 'c1',
    text: '看过提示后改对', assistance: ['tutor-feedback'], source: 'cli',
  }, '2026-10-02T09:00:00Z').state;
  state = tutorAssess(state, model, 'p-explain', 'a1', 'easy', '修正达到要求', '2026-10-02T10:00:00Z', {
    assessmentId: 'tutor-c1', targetCorrectionId: 'c1',
  });
  const schedule = state.schedules['p-explain'];
  assert.equal(schedule.lastRating, 'easy');
  assert.equal(schedule.assisted, true, 'a corrected answer is never independent success');
  assert.equal(schedule.intervalDays, 2, 'conservative capped interval');
  assert.equal(schedule.targetCorrectionId, 'c1');
  assert.equal(state.attempts['p-explain'][0].rating, 'again', 'the original error stands');
  // The linked feedback states which correction it reviewed.
  const feedback = state.attempts['p-explain'][0].tutorFeedback[0];
  assert.equal(feedback.assessmentId, 'tutor-c1');
  assert.equal(feedback.targetCorrectionId, 'c1');
  assert.equal(feedback.id, 'feedback-tutor-c1');
});

// ---------------------------------------------------------------------------
// Feedback, mastery boundary, legacy anchors, invalid events.
// ---------------------------------------------------------------------------

test('tutor feedback is stored once, linked to its assessment, and requires a real note', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  const once = applyTutorAssessment(state, model, {
    promptId: 'p-explain', attemptId: 'a1', rating: 'good', note: '  解释到分母变化  ', assessmentId: 't1',
  }, '2026-10-02T09:00:00Z');
  const attempt = once.state.attempts['p-explain'][0];
  assert.equal(attempt.tutorAssessments.length, 1);
  assert.equal(attempt.tutorFeedback.length, 1);
  assert.equal(attempt.tutorFeedback[0].text, '解释到分母变化', 'the note is trimmed and kept verbatim');
  assert.equal(attempt.tutorFeedback[0].id, 'feedback-t1');
  const twice = applyTutorAssessment(once.state, model, {
    promptId: 'p-explain', attemptId: 'a1', rating: 'good', note: '解释到分母变化', assessmentId: 't1',
  }, '2026-10-02T09:00:00Z');
  assert.equal(twice.state, once.state, 'the identical retry changes nothing');
  assert.throws(
    () => applyTutorAssessment(once.state, model, {
      promptId: 'p-explain', attemptId: 'a1', rating: 'good', note: '不同的依据', assessmentId: 't1',
    }, '2026-10-02T09:05:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
  assert.throws(
    () => applyTutorAssessment(state, model, {
      promptId: 'p-explain', attemptId: 'a1', rating: 'good', note: '   ', assessmentId: 't2',
    }, '2026-10-02T09:00:00Z'),
    (err) => err.code === CODES.USAGE,
  );
});

test('a tutor rating never creates prompt or concept mastery by itself', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  state = tutorAssess(state, model, 'p-explain', 'a1', 'easy', '看起来很好', '2026-10-02T09:00:00Z');
  assert.deepEqual(state.promptEvidence, {}, 'no prompt mastery is minted');
  assert.deepEqual(state.conceptEvidence, {}, 'no concept mastery is minted');
  const view = stateView(state, model);
  assert.equal(view.conceptStatus.child.status, 'pending-review', 'an answer still awaits real review evidence');
  assert.equal(view.prompts['p-explain'].evidence, null);
  // A scheduling rating is not independent mastery evidence either.
  assert.equal(state.schedules['p-explain'].assessmentSource, 'tutor');
  assert.equal(state.schedules['p-explain'].lastRating, 'easy');
});

test('legacy combined attempts keep their historical anchor semantics', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = applyAttempt(state, model, {
    promptId: 'p-explain', attemptId: 'legacy-1', answer: '旧式作答', rating: 'good', assisted: false,
  }, '2026-10-02T08:00:00Z').state;
  const attempt = state.attempts['p-explain'][0];
  assert.equal(attempt.submittedAt, undefined, 'no submission time is fabricated for a combined record');
  assert.deepEqual(scheduleSubmissionAnchor(attempt), { at: '2026-10-02T08:00:00Z', semantics: 'legacy-combined' });
  assert.equal(state.schedules['p-explain'].anchorSemantics, 'legacy-combined');
  assert.equal(state.schedules['p-explain'].lastAttemptAt, '2026-10-02T08:00:00Z');
  assert.equal(state.schedules['p-explain'].dueAt, '2026-10-06T08:00:00.000Z');
  // A new-format answer next to the legacy one mixes cleanly.
  state = submit(state, model, 'p-explain', 'new-1', '2026-10-04T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'new-1', 'good', '2026-10-04T09:00:00Z');
  assert.equal(state.schedules['p-explain'].attemptId, 'new-1');
  assert.equal(state.schedules['p-explain'].anchorSemantics, 'submission-at');
  assert.equal(state.schedules['p-explain'].streakCount, 2, 'the legacy good still counts as the earlier step');
  assert.equal(state.schedules['p-explain'].dueAt, '2026-10-14T08:00:00.000Z');
});

test('modern import keeps only the existing historical date when no current answer is evaluated', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'A', '2026-10-02T08:00:00Z');
  current = selfAssess(current, model, 'p-explain', 'A', 'good', '2026-10-02T09:00:00Z');
  const revised = normalizeModel({ ...rawModel(), prompts: rawModel().prompts.map(p =>
    p.id === 'p-explain' ? { ...p, question: '新版问题' } : p) });
  current = submit(current, revised, 'p-explain', 'B', '2026-10-03T08:00:00Z');
  const incoming = structuredClone(current);
  incoming.schedules['p-explain'].dueAt = '2099-01-01T00:00:00Z';
  const merged = mergeImportedState(current, incoming, revised);
  assert.deepEqual(merged.schedules['p-explain'], current.schedules['p-explain']);

  const empty = createState(revised);
  const pending = submit(empty, revised, 'p-explain', 'C', '2026-10-04T08:00:00Z');
  pending.schedules['p-explain'] = incoming.schedules['p-explain'];
  assert.equal(mergeImportedState(empty, pending, revised).schedules['p-explain'], undefined);
  pending.attempts = {};
  assert.equal(mergeImportedState(empty, pending, revised).schedules['p-explain'], undefined,
    'an imported date without any real answer is discarded too');
  const legacyPending = submit(empty, revised, 'p-explain', 'legacy-pending', '2026-10-04T08:00:00Z');
  delete legacyPending.attempts['p-explain'][0].submittedAt;
  delete legacyPending.attempts['p-explain'][0].submission;
  legacyPending.schedules['p-explain'] = { ...incoming.schedules['p-explain'], assessmentSource: 'tutor' };
  assert.equal(mergeImportedState(empty, legacyPending, revised).schedules['p-explain'], undefined,
    'unevaluated legacy-shaped answers cannot introduce a tutor-labelled date');
  legacyPending.attempts['p-explain'][0].rating = 'good';
  delete legacyPending.attempts['p-explain'][0].fingerprint;
  assert.equal(mergeImportedState(empty, legacyPending, revised).schedules['p-explain'], undefined,
    'a historical self rating cannot authenticate an imported tutor-labelled date');
});

test('content changes cannot be assessed into the old streak', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  const revised = normalizeModel({
    ...rawModel(),
    prompts: rawModel().prompts.map((p) => (p.id === 'p-explain' ? { ...p, question: '重新表述的子概念问题' } : p)),
  });
  assert.throws(
    () => applyAssessment(state, revised, { promptId: 'p-explain', attemptId: 'a1', rating: 'good' }, '2026-10-03T08:00:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
  // A fresh answer on the new content starts a first, independent step.
  state = submit(state, revised, 'p-explain', 'b1', '2026-10-03T08:00:00Z');
  state = selfAssess(state, revised, 'p-explain', 'b1', 'good', '2026-10-03T09:00:00Z');
  assert.equal(state.schedules['p-explain'].attemptId, 'b1');
  assert.equal(state.schedules['p-explain'].streakCount, 1, 'the old answer does not extend the new streak');
  assert.deepEqual(state.attempts['p-explain'].map((a) => a.id), ['a1', 'b1'], 'history is preserved');
});

test('invalid assessment events are rejected before any write', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'a1', '2026-10-02T08:00:00Z');
  const before = JSON.parse(JSON.stringify(state));
  const cases = [
    [{ promptId: 'p-explain', attemptId: 'missing', rating: 'good' }, '2026-10-02T09:00:00Z', CODES.STATE],
    [{ promptId: 'p-explain', attemptId: 'a1', rating: 'none' }, '2026-10-02T09:00:00Z', CODES.USAGE],
    [{ promptId: 'p-explain', attemptId: 'a1', rating: 'good' }, 'not-a-time', CODES.USAGE],
    [{ promptId: 'p-explain', attemptId: 'a1', rating: 'good' }, '2026-10-01T00:00:00Z', CODES.USAGE],
    [{ promptId: 'p-explain', attemptId: 'a1', rating: 'good', targetCorrectionId: 'nope' }, '2026-10-02T09:00:00Z', CODES.STATE],
    [{ promptId: 'p-explain', attemptId: 'a1', rating: 'good', assessmentId: 'bad id' }, '2026-10-02T09:00:00Z', CODES.USAGE],
  ];
  for (const [input, at, code] of cases) {
    assert.throws(() => applyAssessment(state, model, input, at), (err) => err.code === code, JSON.stringify(input));
    assert.throws(() => applyTutorAssessment(state, model, { ...input, note: '依据' }, at), (err) => err.code === code, JSON.stringify(input));
  }
  assert.deepEqual(state, before, 'a rejected event never mutates the archive');
  // A malformed persisted event is refused by normalization, not silently used.
  const corrupted = JSON.parse(JSON.stringify(state));
  corrupted.attempts['p-explain'][0].selfAssessments = [{ id: 'x', attemptId: 'a1', rating: 'good', at: '2026-10-02T09:00:00Z', source: 'cli' }];
  assert.throws(() => normalizeState(corrupted, model), (err) => err.code === CODES.STATE);
});

// ---------------------------------------------------------------------------
// Import merges assessment events and recomputes; it never trusts a schedule.
// ---------------------------------------------------------------------------

test('import preserves one self assessment per target across independently evaluated branches', () => {
  const model = baseModel();
  const saved = submit(createState(model), model, 'p-explain', 'A', '2026-10-08T08:00:00Z');
  const current = selfAssess(saved, model, 'p-explain', 'A', 'good', '2026-10-08T09:00:00Z', { assessmentId: 'local-self' });
  const incoming = selfAssess(saved, model, 'p-explain', 'A', 'hard', '2026-10-08T10:00:00Z', { assessmentId: 'other-self' });
  const merged = mergeImportedState(current, incoming, model);
  assert.doesNotThrow(() => normalizeState(merged, model), 'saved merged archive must reopen');
  assert.deepEqual(merged.attempts['p-explain'][0].selfAssessments, current.attempts['p-explain'][0].selfAssessments);
  assert.equal(merged.schedules['p-explain'].lastRating, 'good');
  assert.ok(merged.conflicts.some(c => c.kind === 'assessment'));
});

test('import merges separate assessments and recomputes instead of trusting an incoming schedule', () => {
  const model = baseModel();
  let current = createState(model, '2026-10-01T00:00:00Z');
  current = submit(current, model, 'p-explain', 'A', '2026-10-08T08:00:00Z');
  current = selfAssess(current, model, 'p-explain', 'A', 'good', '2026-10-08T09:00:00Z', { assessmentId: 'self-A' });

  const incoming = JSON.parse(JSON.stringify(current));
  // The other branch holds the same answer plus a tutor rating of B and a
  // forged far-future arrangement that must be ignored.
  incoming.attempts['p-explain'] = incoming.attempts['p-explain'].concat([{
    id: 'B', promptId: 'p-explain', conceptId: 'child', at: '2026-10-09T08:00:00Z', answer: 'B 的作答',
    rating: null, assisted: false, source: 'cli', fingerprint: promptFingerprint(model, current, 'p-explain'),
    submittedAt: '2026-10-09T08:00:00Z', corrections: [],
    tutorAssessments: [{ id: 'tutor-B', attemptId: 'B', targetCorrectionId: null, rating: 'good', at: '2026-10-09T09:00:00Z', source: 'tutor' }],
    tutorFeedback: [{ id: 'feedback-tutor-B', assessmentId: 'tutor-B', attemptId: 'B', targetCorrectionId: null, at: '2026-10-09T09:00:00Z', text: 'B 复核', source: 'tutor' }],
  }]);
  incoming.schedules['p-explain'] = { promptId: 'p-explain', attemptId: 'B', lastAttemptAt: '2026-10-09T08:00:00Z',
    lastAt: '2026-10-09T08:00:00Z', dueAt: '2099-01-01T00:00:00.000Z', intervalDays: 9999, lastRating: 'easy',
    assisted: false, streakKind: 'easy', streakCount: 9 };
  incoming.revision = current.revision + 25;

  const merged = mergeImportedState(current, incoming, model, '2026-10-10T00:00:00Z');
  assert.deepEqual(merged.attempts['p-explain'].map((a) => a.id), ['A', 'B']);
  // A(good) then B(good) is a two-step good streak, measured from B's real
  // submission: 10 days, not the forged 9999-day date.
  assert.equal(merged.schedules['p-explain'].dueAt, '2026-10-19T08:00:00.000Z', 'the forged date is recomputed away');
  assert.equal(merged.schedules['p-explain'].streakCount, 2);
  assert.equal(merged.schedules['p-explain'].intervalDays, 10);
  assert.equal(merged.schedules['p-explain'].assessmentSource, 'tutor');
  assert.equal(merged.schedules['p-explain'].assessmentId, 'tutor-B');
  // The A-side evaluation is still present, untouched.
  assert.equal(merged.attempts['p-explain'][0].selfAssessments.length, 1);
  // Re-importing the same branch adds no duplicate events.
  const again = mergeImportedState(merged, incoming, model, '2026-10-10T01:00:00Z');
  assert.equal(again.attempts['p-explain'].length, 2);
  assert.equal(again.attempts['p-explain'][1].tutorAssessments.length, 1);
  assert.equal(again.attempts['p-explain'][1].tutorFeedback.length, 1);
});

// ---------------------------------------------------------------------------
// Due list: pending newer answer + overdue older arrangement, tutor-only.
// ---------------------------------------------------------------------------

test('listDue shows an overdue arrangement and a newer pending answer at the same time', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'A', '2026-10-02T08:00:00Z');
  state = selfAssess(state, model, 'p-explain', 'A', 'good', '2026-10-02T09:00:00Z');
  state = submit(state, model, 'p-explain', 'B-unassessed', '2026-10-03T08:00:00Z');
  const due = listDue(state, model, '2026-10-10T00:00:00Z');
  const dueItem = due.due.find((item) => item.promptId === 'p-explain');
  const pending = due.unscheduled.find((item) => item.promptId === 'p-explain' && item.reason === 'pending-assessment');
  assert.ok(dueItem, 'the older assessed arrangement is due');
  assert.equal(dueItem.attemptId, 'A', 'the overdue arrangement still belongs to the last assessed answer');
  assert.equal(dueItem.lastAttemptAt, '2026-10-02T08:00:00Z');
  assert.equal(dueItem.assessmentSource, 'self');
  assert.equal(dueItem.pendingAssessmentAt, '2026-10-03T08:00:00Z', 'the due item names the newer unassessed answer');
  assert.ok(pending, 'the newer unassessed answer is still pending review');
  assert.equal(pending.lastSeenAt, '2026-10-03T08:00:00Z');
  assert.equal(pending.schedule.dueAt, '2026-10-06T08:00:00.000Z', 'the existing date is labelled as the last valid assessment');
});

test('listDue treats a tutor-only evaluated answer as arranged, not pending', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = submit(state, model, 'p-explain', 'A', '2026-10-02T08:00:00Z');
  state = tutorAssess(state, model, 'p-explain', 'A', 'good', '仅导师复核', '2026-10-02T09:00:00Z');
  const early = listDue(state, model, '2026-10-03T00:00:00Z');
  assert.ok(!early.unscheduled.some((item) => item.promptId === 'p-explain' && item.reason === 'pending-assessment'));
  assert.equal(early.due.length, 0, 'not due yet');
  const late = listDue(state, model, '2026-11-01T00:00:00Z');
  const item = late.due.find((entry) => entry.promptId === 'p-explain');
  assert.ok(item, 'a tutor-only evaluation schedules the review');
  assert.equal(item.assessmentSource, 'tutor');
  assert.equal(item.dueAt, '2026-10-06T08:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Public CLI: agent-side assess.
// ---------------------------------------------------------------------------

test('CLI assess writes a tutor assessment with feedback, recomputes due, and retries byte-stably', () => {
  const dir = tmpDir();
  try {
    const source = path.join(dir, 'source.json');
    fs.writeFileSync(source, stableStringify(rawModel()), 'utf8');
    assert.equal(runCli(['build', source, '--out', dir]).status, 0);
    const submitted = runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '我的解释', '--attempt-id', 'A', '--at', '2026-10-08T08:00:00Z']);
    assert.equal(submitted.status, 0, submitted.stderr);
    const assessed = runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'good', '--note', '用自己的话解释到分母', '--assessment-id', 't1', '--at', '2026-10-08T09:00:00Z']);
    assert.equal(assessed.status, 0, assessed.stderr);
    const parsed = JSON.parse(assessed.stdout);
    assert.equal(parsed.schedule.attemptId, 'A');
    assert.equal(parsed.schedule.assessmentSource, 'tutor');
    assert.equal(parsed.schedule.dueAt, '2026-10-12T08:00:00.000Z');
    assert.equal(parsed.attempt.tutorFeedback[0].id, 'feedback-t1');
    const statePath = path.join(dir, 'state.json');
    const bytes = fs.readFileSync(statePath, 'utf8');
    const retry = runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'good', '--note', '用自己的话解释到分母', '--assessment-id', 't1', '--at', '2026-10-08T09:00:00Z']);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fs.readFileSync(statePath, 'utf8'), bytes, 'the identical retry is byte-stable');
    const conflicting = runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'easy', '--note', '改口', '--assessment-id', 't1', '--at', '2026-10-08T10:00:00Z']);
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /E_CONFLICT/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), bytes, 'a conflicting retry leaves the archive byte-identical');
    const missingNote = runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A', '--rating', 'good']);
    assert.equal(missingNote.status, 1);
    const due = runCli(['due', '--out', dir, '--at', '2026-10-13T00:00:00Z']);
    assert.equal(due.status, 0, due.stderr);
    const dueItem = JSON.parse(due.stdout).due.find((entry) => entry.promptId === 'p-explain');
    assert.equal(dueItem.assessmentSource, 'tutor');
    assert.equal(dueItem.lastRating, 'good');
    // The archive still holds one answer and no fabricated mastery.
    const persisted = readJson(statePath);
    assert.equal(persisted.attempts['p-explain'].length, 1);
    assert.deepEqual(persisted.promptEvidence, {});
    assert.deepEqual(persisted.conceptEvidence, {});
  } finally {
    cleanup(dir);
  }
});

test('CLI review can still self-assess a specific correction without touching the original', () => {
  const dir = tmpDir();
  try {
    const source = path.join(dir, 'source.json');
    fs.writeFileSync(source, stableStringify(rawModel()), 'utf8');
    assert.equal(runCli(['build', source, '--out', dir]).status, 0);
    assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '第一次没答好',
      '--attempt-id', 'A', '--at', '2026-10-08T08:00:00Z']).status, 0);
    assert.equal(runCli(['review', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'again', '--assessment-id', 'self-A', '--at', '2026-10-08T08:30:00Z']).status, 0);
    assert.equal(runCli(['correction', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--correction-id', 'c1', '--text', '看过参考后改对', '--assistance', 'reference', '--at', '2026-10-08T09:00:00Z']).status, 0);
    const review = runCli(['review', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'good', '--assessment-id', 'self-c1', '--correction-id', 'c1', '--at', '2026-10-08T10:00:00Z']);
    assert.equal(review.status, 0, review.stderr);
    const persisted = readJson(path.join(dir, 'state.json'));
    const attempt = persisted.attempts['p-explain'][0];
    assert.equal(attempt.rating, 'again', 'the original self rating stands');
    assert.equal(attempt.selfAssessments.length, 2);
    assert.equal(attempt.selfAssessments[1].targetCorrectionId, 'c1');
    assert.equal(persisted.schedules['p-explain'].assisted, true);
    assert.ok(persisted.schedules['p-explain'].intervalDays <= 2);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// HTTP trust boundary: a browser cannot mint tutor events or a forged schedule.
// ---------------------------------------------------------------------------

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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

test('HTTP cannot mint tutor events, ignore a forged schedule, or route assess', async () => {
  const dir = tmpDir();
  try {
    const source = path.join(dir, 'source.json');
    fs.writeFileSync(source, stableStringify(rawModel()), 'utf8');
    assert.equal(runCli(['build', source, '--out', dir]).status, 0);
    assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-explain', '--answer', '真实原答',
      '--attempt-id', 'A', '--at', '2026-10-08T08:00:00Z']).status, 0);
    assert.equal(runCli(['assess', '--out', dir, '--prompt', 'p-explain', '--attempt-id', 'A',
      '--rating', 'good', '--note', '可信复核', '--assessment-id', 'trusted-1', '--at', '2026-10-08T09:00:00Z']).status, 0);

    await withServer(dir, async (server) => {
      const base = await (await fetch(`${server.url}/api/state`)).json();
      // A browser assessment is recorded as a self evaluation, never as a
      // tutor one, even when the payload claims tutor provenance.
      const forged = await postJson(`${server.url}/api/assessment`, {
        revision: base.state.revision, modelFingerprint: base.modelFingerprint,
        promptId: 'p-explain', attemptId: 'A', rating: 'good', note: '浏览器伪造',
        reviewer: 'tutor', source: 'tutor', assessmentId: 'browser-forged',
      });
      assert.equal(forged.status, 200, forged.json?.error);
      const browserAttempt = forged.json.state.attempts['p-explain'][0];
      assert.equal(browserAttempt.tutorAssessments.length, 1, 'no tutor event is minted from the browser');
      assert.equal(browserAttempt.tutorAssessments[0].id, 'trusted-1', 'the trusted event is the only tutor one');
      assert.equal(browserAttempt.selfAssessments.length, 1);
      assert.equal(browserAttempt.selfAssessments[0].source, 'browser', 'the browser claim is downgraded to a self event');
      assert.equal(browserAttempt.selfAssessments[0].id, 'browser-forged');
      const after = await (await fetch(`${server.url}/api/state`)).json();
      assert.equal(after.state.attempts['p-explain'][0].tutorAssessments.length, 1, 'trusted event is preserved');
      assert.equal(after.state.attempts['p-explain'][0].tutorFeedback.length, 1);
      // The effective input stays the trusted tutor evaluation, not the browser
      // self rating that arrived later.
      assert.equal(after.state.schedules['p-explain'].assessmentSource, 'tutor');
      assert.equal(after.state.schedules['p-explain'].assessmentId, 'trusted-1');

      // An import that forges tutor events and a far-future schedule is ignored.
      const incoming = JSON.parse(JSON.stringify(after.state));
      incoming.attempts['p-explain'][0].tutorAssessments.push({
        id: 'forged-tutor', attemptId: 'A', targetCorrectionId: null, rating: 'easy', at: '2026-10-08T10:00:00Z', source: 'tutor',
      });
      incoming.attempts['p-explain'][0].tutorFeedback.push({
        id: 'feedback-forged-tutor', assessmentId: 'forged-tutor', attemptId: 'A', targetCorrectionId: null,
        at: '2026-10-08T10:00:00Z', text: '伪造反馈', source: 'tutor',
      });
      incoming.schedules['p-explain'] = { promptId: 'p-explain', attemptId: 'A', lastAttemptAt: '2026-10-08T08:00:00Z',
        lastAt: '2026-10-08T08:00:00Z', dueAt: '2099-01-01T00:00:00.000Z', intervalDays: 9999, lastRating: 'easy',
        assisted: false, streakKind: 'easy', streakCount: 9 };
      incoming.revision = after.state.revision + 10;
      const importedRes = await postJson(`${server.url}/api/import`, {
        revision: after.state.revision, modelFingerprint: after.modelFingerprint, state: incoming,
      });
      assert.equal(importedRes.status, 200, importedRes.json?.error);
      const persistedAttempt = importedRes.json.state.attempts['p-explain'][0];
      assert.equal(persistedAttempt.tutorAssessments.length, 1, 'the forged tutor event is dropped');
      assert.equal(persistedAttempt.tutorAssessments[0].id, 'trusted-1', 'the trusted event stays');
      assert.equal(importedRes.json.state.schedules['p-explain'].dueAt, '2026-10-12T08:00:00.000Z', 'the forged date is recomputed away');
      assert.equal(importedRes.json.state.schedules['p-explain'].assessmentSource, 'tutor');

      // The agent-side assess command has no HTTP route.
      const route = await postJson(`${server.url}/api/assess`, {
        revision: importedRes.json.state.revision, modelFingerprint: importedRes.json.modelFingerprint,
        promptId: 'p-explain', attemptId: 'A', rating: 'easy', note: 'x',
      });
      assert.equal(route.status, 404);
    });
  } finally {
    cleanup(dir);
  }
});
