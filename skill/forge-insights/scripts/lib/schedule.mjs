// Pure evaluation and spacing rules, shared by Node and the portable page.
// Assessments describe an existing answer; they never create another recall.
const SCHEDULE_RATINGS = ['again', 'hard', 'good', 'easy'];
const SCHEDULE_BASE = { again: 1, hard: 2, good: 4, easy: 7 };

function scheduleError(code, message) {
  const error = new Error(message); error.code = code; throw error;
}
function scheduleTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function scheduleCompare(a, b) {
  const delta = Date.parse(a.at) - Date.parse(b.at);
  return delta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function scheduleTarget(attempt, input) {
  const target = input.targetCorrectionId ?? input.correctionId ?? null;
  if (target !== null && (typeof target !== 'string' || !(attempt.corrections || []).some(c => c.id === target))) {
    scheduleError('E_STATE', '评价目标修正不属于该作答');
  }
  return target;
}
function scheduleEventId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    scheduleError('E_USAGE', '评价事件身份不合法');
  }
  return id;
}

export function scheduleSubmissionAnchor(attempt) {
  if (scheduleTime(attempt.submittedAt)) return { at: attempt.submittedAt, semantics: 'submission-at' };
  // Task03 already saved at as actual submission time and explicitly marked
  // the submission provenance. Older combined answer/rating records did not.
  return { at: attempt.at, semantics: attempt.submission ? 'submission-at' : 'legacy-combined' };
}

export function scheduleNextInterval(previous, rating, assisted) {
  const base = SCHEDULE_BASE[rating];
  if (assisted || rating === 'again' || rating === 'hard') return { days: assisted ? Math.min(base, 2) : base, kind: null, count: 0 };
  const count = previous?.streakKind === rating ? previous.streakCount + 1 : 1;
  const table = rating === 'good' ? [4, 10, 18] : [7, 20, 40];
  const days = count <= 3 ? table[count - 1] : Math.round(previous.intervalDays * (rating === 'good' ? 1.5 : 1.8));
  return { days: Math.min(days, 180), kind: rating, count };
}

function scheduleSelfEvents(attempt) {
  const events = (attempt.selfAssessments || []).slice();
  if (SCHEDULE_RATINGS.includes(attempt.rating) && !events.some(e => e.targetCorrectionId === null)) {
    const old = attempt.assessment || {};
    events.push({ id: old.id || 'legacy-self-' + attempt.id, attemptId: attempt.id, targetCorrectionId: null,
      rating: attempt.rating, at: old.at || attempt.at, source: old.source || attempt.source || 'cli' });
  }
  return events;
}

export function scheduleEffectiveAssessment(attempt) {
  if (!attempt) return null;
  const tutor = attempt.tutorAssessments || [];
  const events = tutor.length ? tutor : scheduleSelfEvents(attempt);
  if (!events.length) return null;
  const selected = events.slice().sort(scheduleCompare).at(-1);
  return { ...selected, source: tutor.length ? 'tutor' : 'self',
    // Reworking the same answer is not a new independent retrieval, even when
    // the learner labels a correction as having no assistance.
    assisted: attempt.assisted !== false || selected.targetCorrectionId !== null };
}

export function scheduleReplay(attempts, promptId, currentFingerprint) {
  if (!currentFingerprint) return null;
  const eligible = (attempts || []).filter(a => a.fingerprint === currentFingerprint && scheduleEffectiveAssessment(a));
  eligible.sort((a, b) => {
    const delta = Date.parse(scheduleSubmissionAnchor(a).at) - Date.parse(scheduleSubmissionAnchor(b).at);
    return delta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  let schedule = null;
  for (const attempt of eligible) {
    const effective = scheduleEffectiveAssessment(attempt);
    const anchor = scheduleSubmissionAnchor(attempt);
    const interval = scheduleNextInterval(schedule, effective.rating, effective.assisted);
    schedule = { promptId, attemptId: attempt.id, lastAttemptAt: anchor.at, lastAt: anchor.at,
      dueAt: new Date(Date.parse(anchor.at) + interval.days * 86400000).toISOString(),
      intervalDays: interval.days, lastRating: effective.rating, assisted: effective.assisted,
      streakKind: interval.kind, streakCount: interval.count, assessmentSource: effective.source,
      assessmentId: effective.id, targetCorrectionId: effective.targetCorrectionId, assessedAt: effective.at,
      anchorSemantics: anchor.semantics };
  }
  return schedule;
}

function schedulePrepareEvent(attempt, input, at, tutor) {
  if (!SCHEDULE_RATINGS.includes(input.rating) || !scheduleTime(at)) scheduleError('E_USAGE', '评价或时间不合法');
  const targetCorrectionId = scheduleTarget(attempt, input);
  const id = scheduleEventId(input.assessmentId ?? input.id ??
    (tutor ? 'tutor-' : 'self-') + attempt.id + '-' + (targetCorrectionId || 'original'));
  const event = { id, attemptId: attempt.id, targetCorrectionId, rating: input.rating, at,
    source: tutor ? 'tutor' : input.source === 'browser' ? 'browser' : 'cli' };
  return event;
}
function scheduleCheckNewTime(attempt, event) {
  const target = event.targetCorrectionId === null ? null : (attempt.corrections || []).find(c => c.id === event.targetCorrectionId);
  if (Date.parse(event.at) < Date.parse(target?.at || scheduleSubmissionAnchor(attempt).at)) {
    scheduleError('E_USAGE', '评价时间不能早于所评价的作答或修正');
  }
}
function scheduleSameEvent(old, next) {
  return ['id', 'attemptId', 'targetCorrectionId', 'rating', 'source'].every(key => old[key] === next[key]);
}

export function scheduleAddSelfAssessment(attempt, input, at) {
  const event = schedulePrepareEvent(attempt, input, at, false);
  const events = scheduleSelfEvents(attempt);
  const sameId = events.find(e => e.id === event.id);
  if (sameId) {
    if (!scheduleSameEvent(sameId, event)) scheduleError('E_CONFLICT', '相同评价身份的内容或来源冲突');
    return { attempt, changed: false };
  }
  const sameTarget = events.find(e => e.targetCorrectionId === event.targetCorrectionId);
  if (sameTarget) {
    if (sameTarget.rating !== event.rating) scheduleError('E_CONFLICT', '该评价目标已经保存不同自评');
    return { attempt, changed: false };
  }
  scheduleCheckNewTime(attempt, event);
  const next = { ...attempt, selfAssessments: [...(attempt.selfAssessments || []), event] };
  if (event.targetCorrectionId === null) {
    next.rating = event.rating;
    next.assessment = { rating: event.rating, at, source: event.source, id: event.id, targetCorrectionId: null };
  }
  return { attempt: next, changed: true };
}

export function scheduleAddTutorAssessment(attempt, input, at) {
  const event = schedulePrepareEvent(attempt, input, at, true);
  const text = typeof input.note === 'string' ? input.note.trim() : '';
  if (!text) scheduleError('E_USAGE', '导师评价必须写明真实复核依据（note）');
  const existing = (attempt.tutorAssessments || []).find(e => e.id === event.id);
  const feedback = (attempt.tutorFeedback || []).find(f => f.assessmentId === event.id);
  if (existing) {
    if (!scheduleSameEvent(existing, event) || !feedback || feedback.text !== text) scheduleError('E_CONFLICT', '相同导师评价身份的评价或反馈冲突');
    return { attempt, changed: false };
  }
  scheduleCheckNewTime(attempt, event);
  const entry = { id: 'feedback-' + event.id, assessmentId: event.id, attemptId: attempt.id,
    targetCorrectionId: event.targetCorrectionId, at, text, source: 'tutor' };
  return { attempt: { ...attempt, tutorAssessments: [...(attempt.tutorAssessments || []), event],
    tutorFeedback: [...(attempt.tutorFeedback || []), entry] }, changed: true };
}

export function scheduleValidateAttempt(attempt) {
  if (attempt.submittedAt !== undefined && (!scheduleTime(attempt.submittedAt) || Date.parse(attempt.submittedAt) !== Date.parse(attempt.at))) {
    scheduleError('E_STATE', '作答提交时间与原记录不一致');
  }
  const ids = new Set();
  const selfTargets = new Set();
  for (const bucket of ['selfAssessments', 'tutorAssessments']) {
    if (attempt[bucket] === undefined) continue;
    if (!Array.isArray(attempt[bucket])) scheduleError('E_STATE', bucket + ' 必须是数组');
    for (const event of attempt[bucket]) {
      if (!event || typeof event !== 'object' || !SCHEDULE_RATINGS.includes(event.rating) || !scheduleTime(event.at) ||
          event.attemptId !== attempt.id || ids.has(event.id) ||
          (bucket === 'tutorAssessments' ? event.source !== 'tutor' : !['browser', 'cli'].includes(event.source))) {
        scheduleError('E_STATE', '评价事件缺少身份、目标、来源或有效时间');
      }
      scheduleEventId(event.id); ids.add(event.id);
      if (!Object.prototype.hasOwnProperty.call(event, 'targetCorrectionId')) scheduleError('E_STATE', '评价事件缺少原答/修正目标');
      scheduleTarget(attempt, event); scheduleCheckNewTime(attempt, event);
      if (bucket === 'selfAssessments') {
        if (selfTargets.has(event.targetCorrectionId)) scheduleError('E_STATE', '同一作答目标的自评重复');
        selfTargets.add(event.targetCorrectionId);
        if (event.targetCorrectionId === null && attempt.rating !== event.rating) scheduleError('E_STATE', '原答自评与兼容评分不一致');
      }
    }
  }
  if (attempt.tutorFeedback !== undefined) {
    if (!Array.isArray(attempt.tutorFeedback)) scheduleError('E_STATE', 'tutorFeedback 必须是数组');
    const feedbackIds = new Set();
    for (const f of attempt.tutorFeedback) {
      const assessment = (attempt.tutorAssessments || []).find(e => e.id === f?.assessmentId);
      if (!f || typeof f.id !== 'string' || feedbackIds.has(f.id) || f.attemptId !== attempt.id || !assessment ||
          f.targetCorrectionId !== assessment.targetCorrectionId || f.source !== 'tutor' || !scheduleTime(f.at) ||
          typeof f.text !== 'string' || !f.text.trim()) scheduleError('E_STATE', '导师反馈缺少评价或作答关联');
      feedbackIds.add(f.id);
    }
  }
  return true;
}
