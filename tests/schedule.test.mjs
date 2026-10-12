import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleAddSelfAssessment as self, scheduleAddTutorAssessment as tutor,
  scheduleReplay as replay, scheduleValidateAttempt as validate } from '../skill/forge/scripts/lib/schedule.mjs';

function answer(id, at, extra = {}) {
  return { id, promptId: 'p', at, submittedAt: at, fingerprint: 'current', rating: null,
    assisted: false, corrections: [], ...extra };
}
test('replay uses stable ASCII identity for simultaneous submissions and ignores pending/stale work', () => {
  const at = '2026-10-08T08:00:00Z';
  const a = self(answer('att-a', at), { rating: 'good' }, at).attempt;
  const z = tutor(answer('att-z', at), { rating: 'again', note: '实际原答有误' }, at).attempt;
  const pending = answer('att-later', '2026-10-09T08:00:00Z');
  const stale = self(answer('att-stale', at, { fingerprint: 'old' }), { rating: 'easy' }, at).attempt;
  const result = replay([pending, z, stale, a], 'p', 'current');
  assert.equal(result.attemptId, 'att-z');
  assert.equal(result.streakCount, 0);
  assert.equal(result.dueAt, '2026-10-09T08:00:00.000Z');
  assert.deepEqual(replay([a, stale, z, pending], 'p', 'current'), result);
});
test('replay caps successful intervals while conservative corrected answers reset continuity', () => {
  let attempts = [];
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.UTC(2026, 8, i + 1, 8)).toISOString();
    attempts.push(self(answer('att-' + String(i).padStart(2, '0'), at), { rating: 'good' }, at).attempt);
  }
  assert.equal(replay(attempts, 'p', 'current').intervalDays, 180);
  const at = '2026-10-08T08:00:00Z';
  const fixed = answer('att-fixed', at, { corrections: [{ id: 'corr-fixed', at, assistance: [], text: '纠错', attemptId: 'att-fixed', source: 'cli' }] });
  const corrected = tutor(fixed, { rating: 'easy', targetCorrectionId: 'corr-fixed', note: '修正后成立' }, at).attempt;
  const final = replay([...attempts, corrected], 'p', 'current');
  assert.equal(final.intervalDays, 2);
  assert.equal(final.assisted, true);
  assert.equal(final.streakCount, 0);
  assert.equal(corrected.rating, null);
});
test('legacy combined time stays historical while task03 submission metadata anchors on the saved original', () => {
  const at = '2026-10-08T08:00:00Z';
  const legacy = answer('att-old', at, { submittedAt: undefined, rating: 'good' });
  const oldResult = replay([legacy], 'p', 'current');
  assert.equal(oldResult.anchorSemantics, 'legacy-combined');
  assert.equal(oldResult.dueAt, '2026-10-12T08:00:00.000Z');
  const submitted = self(answer('att-new', at, { submittedAt: undefined, submission: { source: 'cli' } }),
    { rating: 'good' }, '2026-10-10T08:00:00Z').attempt;
  const newResult = replay([submitted], 'p', 'current');
  assert.equal(newResult.anchorSemantics, 'submission-at');
  assert.equal(newResult.assessedAt, '2026-10-10T08:00:00Z');
  assert.equal(newResult.dueAt, '2026-10-12T08:00:00.000Z');
});
test('immutable event retry preserves its original timestamp and different payload conflicts', () => {
  const at = '2026-10-08T08:00:00Z';
  const original = answer('att-a', at);
  const input = { rating: 'good', assessmentId: 'tutor-a', note: '真实合成原答符合标准' };
  const first = tutor(original, input, at).attempt;
  const retry = tutor(first, input, '2026-10-09T08:00:00Z');
  assert.equal(retry.changed, false);
  assert.equal(retry.attempt, first);
  assert.throws(() => tutor(first, { ...input, note: '另一个反馈' }, at), { code: 'E_CONFLICT' });
  assert.throws(() => tutor(first, { ...input, rating: 'again' }, at), { code: 'E_CONFLICT' });
  assert.equal(original.tutorAssessments, undefined);
  assert.equal(first.tutorFeedback[0].assessmentId, first.tutorAssessments[0].id);
});
test('event validation rejects inconsistent ratings and evaluation before the correction exists', () => {
  const at = '2026-10-08T08:00:00Z';
  const rated = self(answer('att-a', at), { rating: 'good', source: 'browser' }, at).attempt;
  assert.equal(validate(rated), true);
  assert.throws(() => validate({ ...rated, rating: 'again' }), { code: 'E_STATE' });
  const corrected = answer('att-b', at, { corrections: [{ id: 'corr-b', at: '2026-10-09T08:00:00Z' }] });
  assert.throws(() => self(corrected, { rating: 'good', targetCorrectionId: 'corr-b' }, at), { code: 'E_USAGE' });
  assert.throws(() => self(corrected, { rating: 'good', targetCorrectionId: 'corr-foreign' }, at), { code: 'E_STATE' });
  assert.throws(() => tutor(corrected, { rating: 'good', note: '  ' }, at), { code: 'E_USAGE' });
});
