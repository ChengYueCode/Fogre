// Pure tutor-review logic shared by the Node backend and the browser viewer.
//
// This module MUST stay dependency-free and portable: it may not import any
// other file and may not touch Node-only APIs (fs/path/crypto/process). `build`
// strips the leading `export ` from every declaration and inlines the source
// into the viewer at the tutor-review marker, and the standalone viewer test
// harness does the same. `state.mjs` imports the helpers directly, so the page
// and the backend run one algorithm instead of two copies.
//
// A review request freezes, at request time, the exact set of the round's
// then-pending answers together with an immutable content snapshot (question,
// author reference, judgement criteria, prompt/concept fingerprints and the
// corrections that already existed). Later answers, other rounds and later
// corrections are never folded into an existing request. Everything below is a
// pure function over the learner archive: no file, no network, no model call.
//
// Internal helpers are all `tutor*`-prefixed so they can never shadow a viewer
// or core helper of the same purpose.

export var TUTOR_REVIEW_SCOPES = ['round', 'history'];
// `pending` is a frozen member that has not been resolved yet; `completed` is a
// legal tutor judgement; the three failure statuses stay pending review with an
// explicit reason instead of being treated as mastery.
export var TUTOR_MEMBER_STATUSES = ['pending', 'completed', 'stale', 'missing-basis', 'undetermined'];
export var TUTOR_FAILURE_STATUSES = ['stale', 'missing-basis', 'undetermined'];
export var TUTOR_RATINGS = ['again', 'hard', 'good', 'easy'];
// A legal completed judgement needs all five learner-facing feedback fields.
export var TUTOR_FEEDBACK_FIELDS = ['correct', 'misconceptions', 'basis', 'repair', 'nextTask'];
var TUTOR_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];
var TUTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function tutorIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tutorHasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function tutorNullMap() {
  return Object.create(null);
}

function tutorClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Structural equality that ignores key order, used to re-check a frozen
// snapshot against the immutable attempt it was taken from.
function tutorSameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) if (!tutorSameValue(a[i], b[i])) return false;
    return true;
  }
  if (tutorIsRecord(a) && tutorIsRecord(b)) {
    var keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (var j = 0; j < keysA.length; j += 1) {
      if (!tutorHasOwn(b, keysA[j]) || !tutorSameValue(a[keysA[j]], b[keysA[j]])) return false;
    }
    return true;
  }
  return false;
}

function tutorIsNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function tutorValidTime(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

// Errors stay plain and coded so this module needs no shared error class; the
// Node callers translate `code` into an EmberError/HTTP status.
function tutorFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

// Encode one identity segment as `length + 'x' + hex`, so a segment can never
// be confused with its neighbour and the result uses only [-0-9a-z]. A null
// target (the original answer) encodes as an empty segment, distinct from any
// real correction id.
function tutorEncodeSegment(value) {
  var text = value === null || value === undefined ? '' : String(value);
  var hex = '';
  for (var i = 0; i < text.length; i += 1) {
    hex += ('0' + text.charCodeAt(i).toString(16)).slice(-2);
  }
  return text.length + 'x' + hex;
}

// Deterministic, unambiguous assessment id for one frozen member's judgement.
// Length-prefixed hex of (requestId, promptId, attemptId, targetCorrectionId)
// cannot collide when either content or a neighbour differs, and it is accepted
// by the portable schedule event-id rule ([A-Za-z0-9_-], leading alnum).
function tutorAssessmentId(requestId, promptId, attemptId, targetCorrectionId) {
  return 'rev-' + [requestId, promptId, attemptId, targetCorrectionId ?? null].map(tutorEncodeSegment).join('-');
}

function tutorAssertId(value, label, path) {
  if (typeof value !== 'string' || !TUTOR_ID_RE.test(value) || TUTOR_FORBIDDEN_IDS.indexOf(value) !== -1) {
    throw tutorFail('E_USAGE', label + ' 不合法：' + JSON.stringify(value), path);
  }
  return value;
}

function tutorConcepts(model) {
  return model && Array.isArray(model.concepts) ? model.concepts : [];
}

function tutorPromptById(model, promptId) {
  var list = model && Array.isArray(model.prompts) ? model.prompts : [];
  for (var i = 0; i < list.length; i += 1) if (list[i].id === promptId) return list[i];
  return null;
}

function tutorOwnQuestion(state, promptId) {
  var own = (state && state.ownQuestions) || {};
  return tutorHasOwn(own, promptId) ? own[promptId] : null;
}

// Resolve a prompt exactly the way the durable core does: a model prompt wins,
// then a learner question whose concept still exists. A learner question whose
// concept was removed is history, not a playable prompt, and is never frozen.
function tutorResolvePrompt(model, state, promptId) {
  var modelPrompt = tutorPromptById(model, promptId);
  if (modelPrompt) {
    return {
      id: modelPrompt.id, conceptId: modelPrompt.conceptId, kind: modelPrompt.kind,
      question: modelPrompt.question, reference: modelPrompt.answer ?? '',
      criteria: Array.isArray(modelPrompt.criteria) ? modelPrompt.criteria.slice() : [],
      origin: 'model',
    };
  }
  var own = tutorOwnQuestion(state, promptId);
  if (!own) return null;
  var conceptIds = tutorNullMap();
  tutorConcepts(model).forEach(function (concept) { conceptIds[concept.id] = true; });
  if (own.conceptId && !conceptIds[own.conceptId]) return null;
  return {
    id: own.id, conceptId: own.conceptId, kind: 'recall',
    question: own.text, reference: '', criteria: [], origin: 'learner',
  };
}

function tutorCurrentPromptFingerprint(fingerprints, promptId) {
  var map = (fingerprints && fingerprints.promptFingerprints) || {};
  return tutorHasOwn(map, promptId) ? (map[promptId] || null) : null;
}

function tutorCurrentConceptFingerprint(fingerprints, conceptId) {
  var map = (fingerprints && fingerprints.conceptFingerprints) || {};
  return tutorHasOwn(map, conceptId) ? (map[conceptId] || null) : null;
}

// The learner answered for real: a non-empty submitted answer with a real
// submission time. An assisted answer is still a real answer.
function tutorIsRealAnswer(attempt) {
  return tutorIsRecord(attempt) && typeof attempt.answer === 'string' && attempt.answer.trim() !== '';
}

function tutorHasTutorAssessment(attempt) {
  return Array.isArray(attempt && attempt.tutorAssessments) && attempt.tutorAssessments.length > 0;
}

function tutorAttemptsOf(state) {
  var out = [];
  var attempts = (state && state.attempts) || {};
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) { if (tutorIsRecord(attempt)) out.push(attempt); });
  });
  return out;
}

function tutorRequestsOf(state) {
  var requests = (state && state.reviewRequests) || {};
  return tutorIsRecord(requests) ? requests : {};
}

// An attempt is "claimed" once any request froze it. A request owns its members
// forever, so a later request never re-selects the same answer.
function tutorClaimedAttemptIds(state) {
  var claimed = tutorNullMap();
  var requests = tutorRequestsOf(state);
  Object.keys(requests).forEach(function (requestId) {
    var request = requests[requestId];
    if (!tutorIsRecord(request) || !Array.isArray(request.members)) return;
    request.members.forEach(function (member) {
      if (tutorIsRecord(member) && typeof member.attemptId === 'string') claimed[member.attemptId] = true;
    });
  });
  return claimed;
}

// The current pending-review answers of one round: real submissions the tutor
// has not assessed and that no request has frozen yet. These are exactly the
// members a fresh `review-start` would select, so the page's pending count and
// the next request agree.
function tutorPendingAttempts(state, roundId) {
  var claimed = tutorClaimedAttemptIds(state);
  return tutorAttemptsOf(state).filter(function (attempt) {
    if (!tutorIsRealAnswer(attempt)) return false;
    if (tutorHasTutorAssessment(attempt)) return false;
    if (claimed[attempt.id]) return false;
    return (attempt.roundId ?? null) === (roundId ?? null);
  });
}

function tutorAttemptBrief(attempt, model, state) {
  var prompt = tutorResolvePrompt(model, state, attempt.promptId);
  return {
    attemptId: attempt.id,
    promptId: attempt.promptId,
    conceptId: attempt.conceptId ?? (prompt ? prompt.conceptId : null),
    question: prompt ? prompt.question : null,
    answer: attempt.answer,
    assisted: attempt.assisted === true,
    at: attempt.at ?? null,
    submittedAt: attempt.submittedAt ?? attempt.at ?? null,
  };
}

// --- Frozen snapshot ------------------------------------------------------

function tutorCorrectionId(correction) {
  return correction && typeof correction.id === 'string' ? correction.id : null;
}

// Freeze one attempt into a review member. The question, author reference,
// judgement criteria, fingerprints and existing corrections are captured
// verbatim so a later content edit or a later correction can never rewrite what
// the tutor was asked to judge.
function tutorFreezeMember(attempt, model, state, fingerprints) {
  var prompt = tutorResolvePrompt(model, state, attempt.promptId);
  // A prompt that disappeared from the live content is still worth showing as
  // history, but it has no current content to be judged against.
  var corrections = Array.isArray(attempt.corrections) ? attempt.corrections.map(function (correction) {
    return {
      id: tutorCorrectionId(correction),
      attemptId: attempt.id,
      text: correction.text ?? '',
      at: correction.at ?? null,
      source: correction.source ?? null,
      assistance: Array.isArray(correction.assistance) ? correction.assistance.slice() : [],
    };
  }) : [];
  return {
    attemptId: attempt.id,
    promptId: attempt.promptId,
    conceptId: prompt ? prompt.conceptId : (attempt.conceptId ?? null),
    kind: prompt ? prompt.kind : null,
    origin: prompt ? prompt.origin : 'model',
    question: prompt ? prompt.question : null,
    reference: prompt ? prompt.reference : '',
    criteria: prompt ? prompt.criteria.slice() : [],
    fingerprint: attempt.fingerprint ?? null,
    conceptFingerprint: attempt.conceptId ? tutorCurrentConceptFingerprint(fingerprints, attempt.conceptId) : null,
    answer: attempt.answer,
    assisted: attempt.assisted === true,
    assistance: Array.isArray(attempt.assistance) ? attempt.assistance.slice() : [],
    at: attempt.at ?? null,
    submittedAt: attempt.submittedAt ?? attempt.at ?? null,
    corrections: corrections,
    status: 'pending',
    reason: null,
    feedback: null,
    resolvedAt: null,
  };
}

function tutorCorrectionIds(member) {
  var ids = tutorNullMap();
  (member.corrections || []).forEach(function (correction) {
    if (tutorCorrectionId(correction)) ids[tutorCorrectionId(correction)] = true;
  });
  return ids;
}

// A frozen member is still current only while the exact content it was frozen
// against is the live content. Any question, criteria, or concept change makes
// the snapshot stale: the old answer stays visible but can never be scored as
// current mastery.
function tutorMemberIsCurrent(member, fingerprints) {
  if (!member.fingerprint) return false;
  if (tutorCurrentPromptFingerprint(fingerprints, member.promptId) !== member.fingerprint) return false;
  if (member.conceptId) {
    if (tutorCurrentConceptFingerprint(fingerprints, member.conceptId) !== member.conceptFingerprint) return false;
  }
  return true;
}

function tutorMemberEffectiveStatus(member, fingerprints) {
  if (member.status === 'pending' && !tutorMemberIsCurrent(member, fingerprints)) return 'stale';
  return member.status;
}

function tutorStaleReason(member) {
  return '题目或概念内容已更新，冻结的原答不再对应当前内容；原答与快照保留为历史，需要新的真实作答后才能重新复核';
}

// A learner-authored question has no author reference and no judgement rubric.
// A tutor cannot verify a performance against nothing, so a "completed" attempt
// on such a member is downgraded to `missing-basis` and stays pending instead of
// minting an evaluation. Model prompts always carry a non-empty author answer,
// so they keep a checkable basis.
function tutorMemberLacksBasis(member) {
  var hasReference = tutorIsNonEmptyString(member.reference);
  var hasCriteria = Array.isArray(member.criteria) && member.criteria.length > 0;
  return !hasReference && !hasCriteria;
}

function tutorMissingBasisReason(member) {
  return member.origin === 'learner'
    ? '自创问题没有作者参考或判定标准，无法核对；已保留讨论与缺口，需补充可核对材料后再复核'
    : '该题目缺少作者参考与判定标准，无法核对；已保留为待处理，需补充可核对材料后再复核';
}

/**
 * Whether a prompt has anything a tutor could actually check a positive
 * judgement against: a non-empty author reference or at least one judgement
 * criterion. A learner-authored question has neither by construction, so a
 * positive evidence status (explained/applied/retained) can never be granted on
 * it — only discussion-level statuses (unknown/needs-work) remain available.
 *
 * Resolving the prompt reuses the same rules the member freeze uses, so a model
 * prompt with an author answer and a learner question cannot drift apart. This
 * is exported so the page and the backend share one basis rule.
 */
export function tutorEvidenceHasBasis(model, state, promptId) {
  var prompt = tutorResolvePrompt(model, state, promptId);
  if (!prompt) return false;
  return !tutorMemberLacksBasis({ reference: prompt.reference, criteria: prompt.criteria });
}

// --- Feedback validation --------------------------------------------------

function tutorNormalizeFeedback(raw, member) {
  if (!tutorIsRecord(raw)) throw tutorFail('E_USAGE', 'review-item 需要 {status, ...} 形式的反馈对象');
  var status = raw.status;
  if (TUTOR_MEMBER_STATUSES.indexOf(status) === -1 || status === 'pending') {
    throw tutorFail('E_USAGE', '反馈 status 只能是 completed/stale/missing-basis/undetermined，收到 ' + JSON.stringify(status));
  }
  if (TUTOR_FAILURE_STATUSES.indexOf(status) !== -1) {
    if (!tutorIsNonEmptyString(raw.reason)) {
      throw tutorFail('E_USAGE', '失败反馈（' + status + '）需要写明非空 reason');
    }
    // A failure status never carries a rating: it stays pending review. Any
    // rating supplied by the caller is deliberately ignored, not written.
    return { status: status, reason: raw.reason.trim(), feedback: null, rating: null, targetCorrectionId: null };
  }
  var fields = tutorNullMap();
  TUTOR_FEEDBACK_FIELDS.forEach(function (field) {
    if (!tutorIsNonEmptyString(raw[field])) {
      throw tutorFail('E_USAGE', '成功反馈缺少非空 ' + field + '（正确部分/误解/依据/修补/后续任务）');
    }
    fields[field] = raw[field].trim();
  });
  if (TUTOR_RATINGS.indexOf(raw.rating) === -1) {
    throw tutorFail('E_USAGE', '成功反馈 rating 只能是 ' + TUTOR_RATINGS.join('/') + '，收到 ' + JSON.stringify(raw.rating));
  }
  var target = raw.targetCorrectionId === undefined ? null : raw.targetCorrectionId;
  if (target !== null) {
    if (typeof target !== 'string' || !tutorHasOwn(tutorCorrectionIds(member), target)) {
      throw tutorFail('E_CONFLICT', '评价目标修正不属于该请求的冻结快照：' + JSON.stringify(target));
    }
  }
  return {
    status: 'completed',
    reason: null,
    feedback: {
      correct: fields.correct,
      misconceptions: fields.misconceptions,
      basis: fields.basis,
      repair: fields.repair,
      nextTask: fields.nextTask,
      rating: raw.rating,
      targetCorrectionId: target,
    },
    rating: raw.rating,
    targetCorrectionId: target,
  };
}

function tutorSameFeedback(a, b) {
  if (a === null || b === null) return a === b;
  return TUTOR_FEEDBACK_FIELDS.every(function (field) { return a[field] === b[field]; }) &&
    a.rating === b.rating && a.targetCorrectionId === b.targetCorrectionId;
}

// Whether a member's stored resolution already equals the resolution this call
// would write. Compared after the automatic stale/missing-basis downgrade, so
// retrying an identical failure (or an automatic downgrade) is a true no-op and
// never bumps the revision. A changed reason, or a legal success on an
// unfinished member, still differs and is written.
function tutorSameResolution(member, resolution) {
  return member.status === resolution.status
    && (member.reason ?? null) === (resolution.reason ?? null)
    && tutorSameFeedback(member.feedback ?? null, resolution.feedback ?? null);
}

function tutorFindMember(request, promptId, attemptId) {
  var members = Array.isArray(request.members) ? request.members : [];
  for (var i = 0; i < members.length; i += 1) {
    if (members[i].promptId === promptId && members[i].attemptId === attemptId) return i;
  }
  return -1;
}

/**
 * Freeze a review request. `input` is `{requestId, roundId}` for a round scope
 * or `{requestId, history:true, attemptIds:[...]}` for an explicit history
 * scope. Returns `{state, request, changed}`. Idempotent: retrying the same
 * request id returns the existing frozen request untouched and never re-selects
 * members, so a retry cannot absorb answers submitted after the first call.
 */
export function startReviewRequest(state, model, input, at, fingerprints) {
  if (!tutorIsRecord(input)) throw tutorFail('E_USAGE', 'review-start 需要一个对象');
  var requestId = tutorAssertId(input.requestId, '请求 id', 'requestId');
  var time = at || new Date().toISOString();
  if (!tutorValidTime(time)) throw tutorFail('E_USAGE', '时间格式不合法：' + time);
  var next = tutorClone(state);
  if (!tutorIsRecord(next.reviewRequests)) next.reviewRequests = {};
  var requests = next.reviewRequests;
  if (tutorHasOwn(requests, requestId)) {
    // The frozen request is immutable: a retry returns it exactly as it was.
    return { state: state, request: requests[requestId], changed: false };
  }
  var history = input.history === true;
  if (history && (input.roundId !== undefined && input.roundId !== null && input.roundId !== '')) {
    throw tutorFail('E_USAGE', 'history 请求不接受 --round-id；历史范围必须由学习者显式指定作答');
  }
  if (!history && (input.roundId === undefined || input.roundId === null || input.roundId === '')) {
    throw tutorFail('E_USAGE', '轮次复核需要 --round-id；无轮次历史请用 --history --attempt 指定范围');
  }

  var selected;
  if (history) {
    var attemptIds = Array.isArray(input.attemptIds) ? input.attemptIds.slice() : [];
    if (attemptIds.length === 0) throw tutorFail('E_USAGE', '历史复核需要至少一个 --attempt 指定作答范围');
    // Duplicate ids would freeze the same answer twice and leave a request whose
    // member keys are not unique — an unreadable archive. Reject before any write.
    var seenIds = tutorNullMap();
    attemptIds.forEach(function (attemptId) {
      tutorAssertId(attemptId, '作答 id', 'attemptIds');
      if (seenIds[attemptId]) {
        throw tutorFail('E_USAGE', '历史复核的 --attempt 不能重复：' + attemptId);
      }
      seenIds[attemptId] = true;
    });
    // A fixed request owns its members forever, so an answer already claimed by
    // another request may not be pulled into a second one, and an answer the
    // tutor already assessed is no longer pending. Both mirror the round rule.
    var claimed = tutorClaimedAttemptIds(state);
    var byId = tutorNullMap();
    tutorAttemptsOf(state).forEach(function (attempt) { byId[attempt.id] = attempt; });
    selected = attemptIds.map(function (attemptId) {
      var attempt = tutorHasOwn(byId, attemptId) ? byId[attemptId] : null;
      if (!attempt) throw tutorFail('E_STATE', '找不到要复核的作答：' + attemptId);
      if (!tutorIsRealAnswer(attempt)) throw tutorFail('E_STATE', '作答没有保存的真实原答，不能复核：' + attemptId);
      if (claimed[attemptId]) {
        throw tutorFail('E_CONFLICT', '该作答已被其他复核请求固定，不能并入新的历史范围：' + attemptId);
      }
      if (tutorHasTutorAssessment(attempt)) {
        throw tutorFail('E_CONFLICT', '该作答已经获得导师评价，不再是待复核作答：' + attemptId);
      }
      // History means answers outside any learning round. A round-bound answer
      // keeps its own round's request and must not be pulled into a history one.
      if (attempt.roundId !== undefined && attempt.roundId !== null && attempt.roundId !== '') {
        throw tutorFail('E_CONFLICT', '该作答属于学习轮次 ' + attempt.roundId + '，不属于无轮次历史范围：' + attemptId);
      }
      return attempt;
    });
  } else {
    var roundId = tutorAssertId(String(input.roundId), '轮次 id', 'roundId');
    if (!tutorIsRecord(state.learningRounds) || !tutorHasOwn(state.learningRounds, roundId)) {
      throw tutorFail('E_STATE', '轮次不存在：' + roundId);
    }
    selected = tutorPendingAttempts(state, roundId);
    if (selected.length === 0) {
      throw tutorFail('E_CONFLICT', '该轮次当前没有待复核的真实作答；新作答会在提交后进入下一次复核');
    }
  }

  var request = {
    id: requestId,
    scope: history ? 'history' : 'round',
    roundId: history ? null : String(input.roundId),
    status: 'open',
    createdAt: time,
    updatedAt: time,
    modelFingerprint: (fingerprints && fingerprints.modelFingerprint) || (model && model.modelFingerprint) || null,
    // The whole content snapshot is stored so a read can be re-derived without
    // consulting a possibly-updated model, and so a stale request is detectable
    // from the archive alone.
    snapshot: {
      modelFingerprint: (fingerprints && fingerprints.modelFingerprint) || (model && model.modelFingerprint) || null,
      promptFingerprints: tutorClone((fingerprints && fingerprints.promptFingerprints) || {}),
      conceptFingerprints: tutorClone((fingerprints && fingerprints.conceptFingerprints) || {}),
    },
    members: selected.map(function (attempt) { return tutorFreezeMember(attempt, model, state, fingerprints); }),
  };
  requests[requestId] = request;
  next.revision = (Number.isInteger(next.revision) ? next.revision : 0) + 1;
  next.updatedAt = time;
  return { state: next, request: request, changed: true };
}

/**
 * Resolve one frozen member with a tutor feedback object. `hooks.assess` is the
 * injected tutor-assessment recorder (`(state, {promptId, attemptId, rating,
 * note, assessmentId, targetCorrectionId}, at) => {state}`), so this module can
 * reuse the exact task-05 assessment path without importing it. Returns
 * `{state, request, member, changed, rated}`.
 */
export function applyReviewItem(state, input, at, fingerprints, hooks) {
  if (!tutorIsRecord(input)) throw tutorFail('E_USAGE', 'review-item 需要一个对象');
  return tutorApplyReviewItem(state, input, at, fingerprints, hooks);
}

function tutorApplyReviewItem(state, input, at, fingerprints, hooks) {
  var requestId = tutorAssertId(input.requestId, '请求 id', 'requestId');
  var promptId = typeof input.promptId === 'string' && input.promptId !== '' ? input.promptId : null;
  var attemptId = typeof input.attemptId === 'string' && input.attemptId !== '' ? input.attemptId : null;
  if (!promptId) throw tutorFail('E_USAGE', 'review-item 需要 --prompt <题目 id>');
  if (!attemptId) throw tutorFail('E_USAGE', 'review-item 需要 --attempt-id <作答 id>');
  var time = at || new Date().toISOString();
  if (!tutorValidTime(time)) throw tutorFail('E_USAGE', '时间格式不合法：' + time);
  var requests = tutorRequestsOf(state);
  if (!tutorHasOwn(requests, requestId)) throw tutorFail('E_STATE', '复核请求不存在：' + requestId);
  var request = requests[requestId];
  var index = tutorFindMember(request, promptId, attemptId);
  if (index === -1) {
    throw tutorFail('E_CONFLICT',
      '该题目/作答不在请求 ' + requestId + ' 的冻结范围内；请用同一请求的成员或新建请求');
  }
  var member = request.members[index];
  var normalized = tutorNormalizeFeedback(input.feedback, member);

  // A completed member is immutable: an identical retry is a no-op and a
  // different judgement is refused, so a retry can never rewrite finished work.
  if (member.status === 'completed') {
    if (normalized.status === 'completed' && tutorSameFeedback(member.feedback, normalized.feedback)) {
      return { state: state, request: request, member: member, changed: false, rated: false };
    }
    throw tutorFail('E_CONFLICT', '该成员已完成复核，不能改写；请对新的原答或修正重新复核');
  }

  // Content changed under the frozen snapshot: a completed judgement is
  // downgraded to `stale` and kept pending. Nothing is rated and no mastery is
  // implied; the frozen question/reference/corrections stay readable.
  var stale = !tutorMemberIsCurrent(member, fingerprints);
  var lacksBasis = tutorMemberLacksBasis(member);
  var resolution;
  if (stale && normalized.status === 'completed') {
    resolution = { status: 'stale', reason: tutorStaleReason(member), feedback: null };
  } else if (lacksBasis && normalized.status === 'completed') {
    resolution = { status: 'missing-basis', reason: tutorMissingBasisReason(member), feedback: null };
  } else {
    resolution = { status: normalized.status, reason: normalized.reason, feedback: normalized.feedback };
  }

  // An identical retry — including an identical failure, or the same automatic
  // stale/missing-basis downgrade — writes nothing and does not bump revision.
  if (tutorSameResolution(member, resolution)) {
    return { state: state, request: request, member: member, changed: false, rated: false };
  }

  var next = tutorClone(state);
  var nextRequest = next.reviewRequests[requestId];
  var nextMember = nextRequest.members[index];
  var rated = false;
  if (resolution.status === 'completed') {
    if (typeof hooks !== 'function') throw tutorFail('E_STATE', '缺少导师评价记录器（脚本内部错误）');
    // The rating is filed against the exact answer — or the frozen correction —
    // through the existing task-05 path, which recomputes the arrangement and
    // never upgrades mastery on its own.
    var assessmentId = tutorAssessmentId(requestId, promptId, attemptId, resolution.feedback.targetCorrectionId);
    var assessed = hooks(next, {
      promptId: promptId,
      attemptId: attemptId,
      rating: resolution.feedback.rating,
      note: resolution.feedback.basis,
      source: 'cli',
      assessmentId: assessmentId,
      targetCorrectionId: resolution.feedback.targetCorrectionId,
    }, time);
    if (!assessed || !assessed.state) throw tutorFail('E_STATE', '导师评价记录器没有返回状态');
    next = assessed.state;
    nextRequest = next.reviewRequests[requestId];
    nextMember = nextRequest.members[index];
    rated = true;
  }
  nextMember.status = resolution.status;
  nextMember.reason = resolution.reason;
  nextMember.feedback = resolution.feedback;
  nextMember.resolvedAt = time;
  nextRequest.status = tutorRequestStatus(nextRequest);
  nextRequest.updatedAt = time;
  next.revision = (Number.isInteger(next.revision) ? next.revision : 0) + 1;
  next.updatedAt = time;
  return { state: next, request: nextRequest, member: nextMember, changed: true, rated: rated };
}

// A request is complete only when every frozen member has a legal completed
// judgement. Failure statuses keep real remaining work, so the request stays
// partial/open and never claims a full round review.
function tutorRequestStatus(request) {
  var members = Array.isArray(request.members) ? request.members : [];
  if (members.length === 0) return 'open';
  var completed = members.filter(function (member) { return member.status === 'completed'; }).length;
  if (completed === members.length) return 'completed';
  return completed > 0 ? 'partial' : 'open';
}

// --- Read model -----------------------------------------------------------

function tutorMemberView(member, fingerprints) {
  var effective = tutorMemberEffectiveStatus(member, fingerprints);
  var reason = member.reason;
  if (effective === 'stale' && !reason) reason = tutorStaleReason(member);
  return {
    promptId: member.promptId,
    attemptId: member.attemptId,
    conceptId: member.conceptId ?? null,
    kind: member.kind ?? null,
    origin: member.origin ?? 'model',
    question: member.question ?? null,
    reference: member.reference ?? '',
    criteria: Array.isArray(member.criteria) ? member.criteria.slice() : [],
    answer: member.answer,
    assisted: member.assisted === true,
    assistance: Array.isArray(member.assistance) ? member.assistance.slice() : [],
    at: member.at ?? null,
    submittedAt: member.submittedAt ?? member.at ?? null,
    corrections: (member.corrections || []).map(function (correction) { return tutorClone(correction); }),
    fingerprint: member.fingerprint ?? null,
    // Whether the frozen content still matches the live content, so the page
    // can show a stale item without re-deriving the rule itself.
    current: tutorMemberIsCurrent(member, fingerprints),
    status: effective,
    storedStatus: member.status,
    reason: reason ?? null,
    feedback: member.feedback ? tutorClone(member.feedback) : null,
    targetCorrectionId: member.feedback ? (member.feedback.targetCorrectionId ?? null) : null,
    rating: member.feedback ? (member.feedback.rating ?? null) : null,
    resolvedAt: member.resolvedAt ?? null,
  };
}

function tutorRequestView(request, fingerprints) {
  var members = (request.members || []).map(function (member) { return tutorMemberView(member, fingerprints); });
  var completed = members.filter(function (member) { return member.status === 'completed'; }).length;
  return {
    id: request.id,
    scope: request.scope,
    roundId: request.roundId ?? null,
    status: tutorRequestStatus({ members: members }),
    createdAt: request.createdAt ?? null,
    updatedAt: request.updatedAt ?? null,
    total: members.length,
    completed: completed,
    remaining: members.length - completed,
    members: members,
  };
}

/**
 * Pure read model shared by the CLI, the HTTP `/api/state` payload and the
 * generated page. `roundId` selects the round whose pending answers and
 * requests are summarised; pass an options object `{roundId, requestId}` to
 * filter by request id instead (a documented extension of the two-argument
 * form). `fingerprints` is `{modelFingerprint, promptFingerprints,
 * conceptFingerprints}` — the same shape `stateResponse` already publishes.
 *
 * Returns `{roundId, pendingCount, pendingAttempts, historyPendingCount,
 * requests}` plus clearly-named extras (`requestId`, `openPendingCount`) that
 * pages may render but must not re-derive.
 */
export function tutorReviewSummary(state, roundId, fingerprints) {
  var options = tutorIsRecord(roundId) ? roundId : { roundId: roundId };
  var wantedRoundId = options.roundId === undefined ? null : options.roundId;
  var wantedRequestId = options.requestId === undefined ? null : options.requestId;
  var model = options.model || null;
  var fps = fingerprints || {};

  var requests = tutorRequestsOf(state);
  // A request-scoped read derives its round from the request itself so the
  // pending count describes the same round the request was frozen against. A
  // history request keeps roundId null and only reports history pending work.
  if (wantedRequestId !== null && options.roundId === undefined) {
    var scoped = tutorHasOwn(requests, wantedRequestId) ? requests[wantedRequestId] : null;
    if (tutorIsRecord(scoped) && typeof scoped.roundId === 'string' && scoped.roundId !== '') {
      wantedRoundId = scoped.roundId;
    }
  }
  var requestViews = Object.keys(requests)
    .filter(function (id) {
      var request = requests[id];
      if (!tutorIsRecord(request)) return false;
      if (wantedRequestId !== null) return id === wantedRequestId;
      if (options.scope === 'history') return request.scope === 'history';
      if (wantedRoundId === null) return true;
      return request.roundId === wantedRoundId;
    })
    .map(function (id) { return tutorRequestView(requests[id], fps); })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id); });

  var pending = tutorPendingAttempts(state, wantedRoundId);
  var historyPending = tutorPendingAttempts(state, null);
  var brief = function (attempt) {
    return model ? tutorAttemptBrief(attempt, model, state) : {
      attemptId: attempt.id, promptId: attempt.promptId, conceptId: attempt.conceptId ?? null,
      answer: attempt.answer, assisted: attempt.assisted === true,
      at: attempt.at ?? null, submittedAt: attempt.submittedAt ?? attempt.at ?? null,
    };
  };
  var openPendingCount = requestViews.reduce(function (sum, view) {
    return sum + view.members.filter(function (member) { return member.status !== 'completed'; }).length;
  }, 0);
  // New unclaimed answers plus members still unfinished in existing requests.
  // Shown together so a completed request never hides later pending work.
  var totalPendingCount = pending.length + openPendingCount;

  return {
    roundId: wantedRoundId ?? null,
    requestId: wantedRequestId,
    pendingCount: pending.length,
    pendingAttempts: pending.map(brief),
    historyPendingCount: historyPending.length,
    // The concrete history answers (unbound to any round) so a learner can pick
    // an explicit range for a `--history --attempt ...` request. A bare count
    // would leave the documented range-selection step unusable.
    historyPendingAttempts: historyPending.map(brief),
    openPendingCount: openPendingCount,
    totalPendingCount: totalPendingCount,
    callbackText: tutorCallbackText(wantedRoundId),
    requests: requestViews,
  };
}

// The exact text the learner can paste back into the AI session to request a
// review of this round. Kept here (not in the page) so the wording matches the
// documented CLI operations.
function tutorCallbackText(roundId) {
  if (!roundId) {
    return '把导出的档案交给 AI 会话，并说明要复核哪些无轮次历史作答（用 review-start --history --attempt <作答ID> 建立范围）。';
  }
  return '请复核本轮（' + roundId + '）的真实作答：'
    + 'forge review-read --out <学习目录> --round-id ' + roundId + '，'
    + '再对每个待复核成员执行 review-item。';
}

/**
 * Structural validation for the optional `reviewRequests` bucket. A legacy
 * archive that omits the field is valid; a present-but-malformed bucket is
 * rejected with a precise path instead of being silently discarded, the same
 * contract `learningRounds` follows.
 *
 * A frozen request must be self-describing: it carries its own content snapshot
 * (model/prompt/concept fingerprints) and every member names a real attempt id
 * plus the frozen question, answer and target corrections it was judged
 * against. A member whose attempt no longer exists is rejected — a corrupted
 * snapshot must never let a later write attach a judgement to a different
 * answer that merely reuses an id.
 */
export function validateReviewRequests(raw, options) {
  var opts = tutorIsRecord(options) ? options : {};
  var attemptById = null;
  if (opts.state) {
    attemptById = tutorNullMap();
    var attempts = (opts.state.attempts) || {};
    Object.keys(attempts).forEach(function (promptId) {
      var list = attempts[promptId];
      if (!Array.isArray(list)) return;
      list.forEach(function (attempt) {
        if (tutorIsRecord(attempt) && typeof attempt.id === 'string') attemptById[attempt.id] = attempt;
      });
    });
  }
  if (raw === undefined || raw === null) return true;
  if (!tutorIsRecord(raw)) throw tutorFail('E_STATE', '状态必须是对象');
  var requests = raw.reviewRequests;
  if (requests === undefined || requests === null) return true;
  if (!tutorIsRecord(requests)) throw tutorFail('E_STATE', 'reviewRequests 必须是对象（旧档可省略该字段）', 'reviewRequests');
  Object.keys(requests).forEach(function (key) {
    var request = requests[key];
    var path = 'reviewRequests.' + key;
    if (!tutorIsRecord(request)) throw tutorFail('E_STATE', '复核请求必须是对象', path);
    if (request.id !== key) throw tutorFail('E_STATE', '复核请求 id 与键不一致：' + JSON.stringify(request.id) + ' ≠ ' + JSON.stringify(key), path + '.id');
    if (TUTOR_REVIEW_SCOPES.indexOf(request.scope) === -1) throw tutorFail('E_STATE', '复核请求 scope 不合法：' + JSON.stringify(request.scope), path + '.scope');
    if (request.scope === 'round') {
      if (typeof request.roundId !== 'string' || request.roundId === '') throw tutorFail('E_STATE', '轮次复核请求需要 roundId', path + '.roundId');
    } else if (request.roundId !== null && request.roundId !== undefined) {
      throw tutorFail('E_STATE', '历史复核请求的 roundId 必须是 null', path + '.roundId');
    }
    if (typeof request.createdAt !== 'string' || !tutorValidTime(request.createdAt)) {
      throw tutorFail('E_STATE', '复核请求缺少有效创建时间', path + '.createdAt');
    }
    // A request without a usable content snapshot cannot detect staleness and is
    // refused instead of being treated as current mastery.
    if (!tutorIsRecord(request.snapshot)) throw tutorFail('E_STATE', '复核请求缺少内容快照', path + '.snapshot');
    if (!tutorIsRecord(request.snapshot.promptFingerprints)) {
      throw tutorFail('E_STATE', '复核请求快照缺少 promptFingerprints', path + '.snapshot.promptFingerprints');
    }
    if (!tutorIsRecord(request.snapshot.conceptFingerprints)) {
      throw tutorFail('E_STATE', '复核请求快照缺少 conceptFingerprints', path + '.snapshot.conceptFingerprints');
    }
    if (!Array.isArray(request.members)) throw tutorFail('E_STATE', '复核请求 members 必须是数组', path + '.members');
    var seen = tutorNullMap();
    request.members.forEach(function (member, index) {
      var memberPath = path + '.members[' + index + ']';
      if (!tutorIsRecord(member)) throw tutorFail('E_STATE', '复核成员必须是对象', memberPath);
      if (typeof member.promptId !== 'string' || member.promptId === '') throw tutorFail('E_STATE', '复核成员缺少 promptId', memberPath + '.promptId');
      if (typeof member.attemptId !== 'string' || member.attemptId === '') throw tutorFail('E_STATE', '复核成员缺少 attemptId', memberPath + '.attemptId');
      var source = attemptById !== null && tutorHasOwn(attemptById, member.attemptId) ? attemptById[member.attemptId] : null;
      if (attemptById !== null && !source) {
        throw tutorFail('E_STATE', '复核成员引用的作答不存在于档案中，损坏的快照不可恢复：' + member.attemptId, memberPath + '.attemptId');
      }
      // The frozen member must still describe the *same* immutable answer it was
      // taken from: same prompt, original text, submission time and assistance
      // facts. Otherwise a corrupted snapshot could rate a different answer that
      // merely reuses the id.
      if (source) {
        if (source.promptId !== member.promptId) {
          throw tutorFail('E_STATE', '复核成员的问题与原答不一致：' + member.attemptId, memberPath + '.promptId');
        }
        if (source.answer !== member.answer) {
          throw tutorFail('E_STATE', '复核成员的原文与原答不一致：' + member.attemptId, memberPath + '.answer');
        }
        if ((source.at ?? null) !== (member.at ?? null)) {
          throw tutorFail('E_STATE', '复核成员的作答时间与原答不一致：' + member.attemptId, memberPath + '.at');
        }
        if ((source.assisted === true) !== (member.assisted === true)) {
          throw tutorFail('E_STATE', '复核成员的协助事实与原答不一致：' + member.attemptId, memberPath + '.assisted');
        }
        var sourceAssistance = Array.isArray(source.assistance) ? source.assistance.slice().sort() : [];
        var memberAssistance = Array.isArray(member.assistance) ? member.assistance.slice().sort() : [];
        if (!tutorSameValue(sourceAssistance, memberAssistance)) {
          throw tutorFail('E_STATE', '复核成员的协助来源与原答不一致：' + member.attemptId, memberPath + '.assistance');
        }
      }
      var key2 = member.promptId + '|' + member.attemptId;
      if (seen[key2]) throw tutorFail('E_STATE', '复核成员的题目/作答重复：' + key2, memberPath);
      seen[key2] = true;
      if (typeof member.answer !== 'string') throw tutorFail('E_STATE', '复核成员缺少原答快照', memberPath + '.answer');
      // A fingerprint may be absent on a legacy answer frozen from an old
      // archive. Such a member is readable history but can never be current, so
      // it must stay unresolved — a completed status on it is rejected below.
      var hasFingerprint = typeof member.fingerprint === 'string' && member.fingerprint !== '';
      if (TUTOR_MEMBER_STATUSES.indexOf(member.status) === -1) throw tutorFail('E_STATE', '复核成员 status 不合法：' + JSON.stringify(member.status), memberPath + '.status');
      if (member.corrections !== undefined && !Array.isArray(member.corrections)) {
        throw tutorFail('E_STATE', '复核成员 corrections 必须是数组', memberPath + '.corrections');
      }
      var correctionIds = tutorCorrectionIds(member);
      if (member.status === 'completed') {
        if (!hasFingerprint) {
          throw tutorFail('E_STATE', '缺少内容指纹的历史复核成员不能标记为已完成，必须保留待处理', memberPath + '.status');
        }
        if (!tutorIsRecord(member.feedback)) throw tutorFail('E_STATE', '已完成的复核成员缺少反馈', memberPath + '.feedback');
        TUTOR_FEEDBACK_FIELDS.forEach(function (field) {
          if (!tutorIsNonEmptyString(member.feedback[field])) throw tutorFail('E_STATE', '复核反馈缺少 ' + field, memberPath + '.feedback.' + field);
        });
        if (TUTOR_RATINGS.indexOf(member.feedback.rating) === -1) throw tutorFail('E_STATE', '复核反馈 rating 不合法', memberPath + '.feedback.rating');
        var target = member.feedback.targetCorrectionId;
        if (target !== null && target !== undefined && !tutorHasOwn(correctionIds, target)) {
          throw tutorFail('E_STATE', '复核反馈的修正目标不在冻结快照内：' + JSON.stringify(target), memberPath + '.feedback.targetCorrectionId');
        }
      }
      if (member.status !== 'pending' && member.status !== 'completed' && !tutorIsNonEmptyString(member.reason)) {
        throw tutorFail('E_STATE', '待处理复核成员缺少原因', memberPath + '.reason');
      }
    });
  });
  return true;
}

// Exported for callers that build a request display from a raw record.
export function tutorReviewRequestView(request, fingerprints) {
  if (!tutorIsRecord(request)) return null;
  return tutorRequestView(request, fingerprints || {});
}
