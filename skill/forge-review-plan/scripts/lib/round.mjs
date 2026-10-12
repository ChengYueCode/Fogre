// Pure learning-round logic shared by the Node backend and the browser viewer.
//
// This module MUST stay dependency-free and portable: it may not import any
// other file, and it may not touch Node-only APIs (fs/path/crypto/process).
// `build` strips the leading `export ` from every declaration and inlines the
// source into the viewer at the round-library marker, and the standalone viewer
// test harness does the same. `state.mjs` imports the helpers directly, so the
// browser and the backend run one algorithm instead of two copies.
//
// Internal helpers are all `round*`-prefixed so they can never shadow a viewer
// or core helper of the same purpose.

var ROUND_ENTRIES = ['learn-new-topic', 'organize-existing-material', 'resume'];
var ROUND_ENTRY_FOR_CREATE = ['learn-new-topic', 'organize-existing-material'];
var ROUND_STATUSES = ['diagnosing', 'active', 'paused', 'completed'];
var ROUND_ACTIONS = ['create', 'update', 'pause', 'resume', 'focus', 'confirm-diagnosis', 'review-plan', 'progress-start', 'progress-event', 'progress-time', 'close'];
var ROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Route tasks open with exposition/application; the new-topic diagnostic probe
// opens with a light recall so the learner can expose a baseline quickly.
var ROUND_ROUTE_PROMPT_ORDER = ['explain', 'apply', 'compare', 'recall'];
var ROUND_DIAGNOSTIC_PROMPT_ORDER = ['recall', 'explain', 'compare', 'apply'];
var ROUND_DIAGNOSTIC_MINUTES = 8;
// Progressive-practice teaching goals. A prompt may declare a purpose via
// optional teaching metadata; a legacy prompt derives one from its kind so the
// same selector works on old content. The movement is explanation -> variation
// -> transfer (解释 -> 变式 -> 新情境应用).
var ROUND_TEACHING_PURPOSES = ['explanation', 'variation', 'transfer'];
var ROUND_PURPOSE_BY_KIND = { recall: 'explanation', explain: 'explanation', compare: 'variation', apply: 'transfer' };
var ROUND_PURPOSE_RANK = { explanation: 1, variation: 2, transfer: 3 };
// The single fallback hint shown when a question has neither author hints nor a
// scoring rubric. Kept identical to the page so hints and their count agree.
var ROUND_GENERIC_HINT = '先用自己的话说明核心机制，再检查条件与边界。';
// A retained judgement must rest on independent answers separated by at least
// this much wall-clock time (cross-session, not same-minute repetition).
var ROUND_RETAINED_MIN_GAP_MS = 20 * 60 * 60 * 1000;
// Review-plan bands. The numbers are the public `priority` values: lower comes
// first. A learner's explicit focus is an override inside these bands, while a
// real prerequisite gap still has to come first.
var ROUND_REVIEW_PRIORITY = {
  prerequisite: 0,
  focus: 1,
  repeated: 2,
  due: 3,
  option: 9,
};
var ROUND_REVIEW_ASSESSMENT_SOURCES = ['tutor', 'self', 'legacy'];
// Author IDs may legally be names such as `constructor` or `toString`. Every
// internal ID->value dictionary therefore uses a null prototype, and every
// lookup into a literal table uses an own-property check, so an inherited name
// can never be mistaken for a real entry.
var ROUND_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];

function roundHasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function roundNullMap() {
  return Object.create(null);
}

function roundIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roundClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function roundValidTime(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

// Deterministic 32-bit FNV-1a. Stable across the browser and Node so a task id
// regenerated on a rebuild always matches the id an earlier attempt recorded.
function roundHash(text) {
  var source = String(text);
  var hash = 0x811c9dc5;
  for (var i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

// Round errors stay plain so the module needs no shared error class; the Node
// callers translate `code` into their EmberError/HTTP status.
function roundFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  // Keep the un-decorated text so a backend that re-wraps the error in its own
  // error class can rebuild the path suffix without doubling it.
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

function roundConcepts(model) {
  return model && Array.isArray(model.concepts) ? model.concepts : [];
}

function roundPrompts(model) {
  return model && Array.isArray(model.prompts) ? model.prompts : [];
}

function roundRelations(model) {
  return model && Array.isArray(model.relations) ? model.relations : [];
}

function roundConceptById(model, id) {
  var list = roundConcepts(model);
  for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  return null;
}

function roundPromptById(model, id) {
  var list = roundPrompts(model);
  for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  return null;
}

function roundConceptOrder(model) {
  var order = roundNullMap();
  roundConcepts(model).forEach(function (concept, index) { order[concept.id] = index; });
  return order;
}

function roundCurrentPromptFingerprint(model, promptId) {
  if (!promptId) return null;
  var fingerprints = (model && model.promptFingerprints) || {};
  return roundHasOwn(fingerprints, promptId) ? (fingerprints[promptId] || null) : null;
}

// prerequisite direction is from -> to: `from` is the prerequisite of `to`.
//
// Relations describe durable structural prerequisites. On top of them, a
// concept's *currently selected* practice prompt may declare teaching
// prerequisites (task 09). Those are merged so a route reaches them before the
// concept, but only for the prompt the shared selector actually picks right now:
// a future variation/transfer prompt's different prerequisites are never pulled
// in ahead of the step the learner has earned.
function roundPrerequisiteMap(model, state) {
  var map = roundNullMap();
  var add = function (toId, fromId) {
    if (typeof toId !== 'string' || typeof fromId !== 'string') return;
    if (toId === fromId) return;
    if (!roundConceptById(model, fromId)) return;
    if (!roundHasOwn(map, toId)) map[toId] = [];
    if (map[toId].indexOf(fromId) === -1) map[toId].push(fromId);
  };
  roundRelations(model).forEach(function (relation) {
    if (!relation || relation.type !== 'prerequisite') return;
    add(relation.to, relation.from);
  });
  // Without state there is no answered-work basis for a selection, so this
  // stays the legacy relation-only map (used by callers that only need the
  // structural skeleton).
  if (state) {
    roundConcepts(model).forEach(function (concept) {
      var selection;
      try {
        selection = roundPracticeSelection(state, model, concept.id);
      } catch (err) {
        return;
      }
      if (!selection || !selection.promptId) return;
      var prompt = roundPromptById(model, selection.promptId);
      var teaching = prompt && roundIsRecord(prompt.teaching) ? prompt.teaching : null;
      if (!teaching || !Array.isArray(teaching.prerequisites)) return;
      teaching.prerequisites.forEach(function (prerequisiteId) { add(concept.id, prerequisiteId); });
    });
  }
  return map;
}

// Index every recorded attempt by id so a piece of concept evidence can be
// checked against the attempts it actually names.
function roundAttemptsById(state) {
  var byId = roundNullMap();
  var attempts = (state && state.attempts) || {};
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) { if (attempt && typeof attempt.id === 'string') byId[attempt.id] = attempt; });
  });
  return byId;
}

// A needs-work gap only reorders the route while it is *current validated*
// evidence: the concept fingerprint matches the live model, the record names
// the attempts behind it, and each of those attempts is still current for its
// prompt. Anything else (missing metadata, stale content, dangling attempts)
// stays unknown instead of being treated as a confirmed gap.
function roundNeedsWorkSet(state, model) {
  var set = roundNullMap();
  var evidence = (state && state.conceptEvidence) || {};
  var conceptFingerprints = (model && model.conceptFingerprints) || {};
  var attemptsById = roundAttemptsById(state);
  Object.keys(evidence).forEach(function (conceptId) {
    var record = evidence[conceptId];
    if (!roundIsRecord(record) || record.status !== 'needs-work') return;
    if (!record.conceptFingerprint || record.conceptFingerprint !== conceptFingerprints[conceptId]) return;
    if (!Array.isArray(record.attemptIds) || record.attemptIds.length === 0) return;
    var everyCurrent = record.attemptIds.every(function (attemptId) {
      var attempt = roundHasOwn(attemptsById, attemptId) ? attemptsById[attemptId] : null;
      if (!attempt) return false;
      var current = roundCurrentPromptFingerprint(model, attempt.promptId);
      return Boolean(current) && attempt.fingerprint === current;
    });
    if (!everyCurrent) return;
    set[conceptId] = true;
  });
  return set;
}

function roundAssertEntry(entry, allowed) {
  var list = allowed || ROUND_ENTRIES;
  if (list.indexOf(entry) === -1) {
    throw roundFail('E_USAGE', '学习入口只能是 ' + list.join('/') + '，收到 ' + JSON.stringify(entry));
  }
  return entry;
}

function roundAssertGoal(goal) {
  if (typeof goal !== 'string' || goal.trim() === '') throw roundFail('E_USAGE', '本轮目标不能为空');
  return goal.trim();
}

function roundAssertRoundId(roundId) {
  // `__proto__`/`constructor`/`prototype` match the ID pattern but would be
  // rejected when the state is normalized and saved, so refuse them before a
  // round is created with an ID that can never be persisted.
  if (ROUND_FORBIDDEN_IDS.indexOf(roundId) !== -1) {
    throw roundFail('E_ID', '轮次 id 不能使用保留名：' + JSON.stringify(roundId));
  }
  if (typeof roundId !== 'string' || !ROUND_ID_RE.test(roundId)) {
    throw roundFail('E_USAGE', '轮次 id 只能是 [A-Za-z0-9_-] 且以字母或数字开头，收到 ' + JSON.stringify(roundId));
  }
  return roundId;
}

function roundAssertBudget(value) {
  if (value === undefined || value === null || value === 'none') return null;
  var number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw roundFail('E_USAGE', '时间预算需为正整数分钟或留空，收到 ' + JSON.stringify(value));
  }
  return number;
}

function roundNormalizeConceptIds(model, list) {
  if (!Array.isArray(list) || list.length === 0) throw roundFail('E_USAGE', '本轮至少需要一个目标概念');
  var ids = [];
  list.forEach(function (id) {
    if (typeof id !== 'string' || id.trim() === '') throw roundFail('E_USAGE', '概念 id 不合法：' + JSON.stringify(id));
    if (!roundConceptById(model, id)) throw roundFail('E_STATE', '概念不存在：' + id);
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  if (ids.length === 0) throw roundFail('E_USAGE', '本轮至少需要一个目标概念');
  return ids;
}

function roundPickPrompt(model, conceptId, preference) {
  var list = roundPrompts(model).filter(function (prompt) { return prompt.conceptId === conceptId; });
  for (var i = 0; i < preference.length; i += 1) {
    var match = list.filter(function (prompt) { return prompt.kind === preference[i]; })[0];
    if (match) return match;
  }
  return list[0] || null;
}

function roundEstimate(concept) {
  var difficulty = concept && Number.isInteger(concept.difficulty) ? concept.difficulty : 1;
  return 8 + Math.max(0, difficulty - 1) * 6;
}

// Task completion criteria are *observable goals* the learner can aim at before
// answering, so they are derived from the prompt kind only. They must never
// copy `prompt.criteria` or `prompt.answer`: the author's scoring rubric is a
// hidden reference that would leak the answer if shown up front. The author's
// rubric stays on the prompt and is revealed only as assisted practice.
var ROUND_CRITERIA_BY_KIND = {
  recall: ['不看参考，用自己的话复述关键结论', '写出你会用来核对的依据或来源'],
  explain: ['用自己的话解释机制或因果，而不是复述标题', '说明关键步骤之间的关系，并给出一个例子'],
  apply: ['在新的情境中应用规则并写出步骤', '说明你如何核对结果是否合理'],
  compare: ['并列写出两者的关键差异', '指出在什么条件下应使用哪一个'],
};
var ROUND_CRITERIA_DEFAULT = ['提交自己的解释或应用，说明关键步骤'];

function roundCriteria(prompt) {
  var kind = prompt && typeof prompt.kind === 'string' ? prompt.kind : null;
  // Own-property lookup: a prompt kind such as `constructor` must not resolve to
  // an inherited Object.prototype member.
  var criteria = kind && roundHasOwn(ROUND_CRITERIA_BY_KIND, kind) ? ROUND_CRITERIA_BY_KIND[kind] : null;
  return (criteria || ROUND_CRITERIA_DEFAULT).slice();
}

// The task's pre-answer completion standard is always the kind-derived,
// observable goal — never the author's scoring rubric. Surfacing authored
// criteria before the learner answers would leak the exact rubric they are
// meant to reconstruct. The author's real criteria travel separately as
// `authorCriteria` and are shown only after a submission (the practice
// reference), where comparing the learner's own answer to the basis is the
// point.
function roundTaskCriteria(prompt) {
  return roundCriteria(prompt);
}

function roundAuthorCriteria(prompt) {
  return prompt && Array.isArray(prompt.criteria) ? prompt.criteria.slice() : [];
}

// The teaching purpose of one prompt: author metadata first, then a derivation
// from the prompt kind for legacy content. Never returns an inherited member.
function roundPromptPurpose(prompt) {
  var teaching = prompt && roundIsRecord(prompt.teaching) ? prompt.teaching : null;
  if (teaching && ROUND_TEACHING_PURPOSES.indexOf(teaching.purpose) !== -1) return teaching.purpose;
  var kind = prompt && typeof prompt.kind === 'string' ? prompt.kind : null;
  if (kind && roundHasOwn(ROUND_PURPOSE_BY_KIND, kind)) return ROUND_PURPOSE_BY_KIND[kind];
  return 'explanation';
}

function roundPurposeRank(purpose) {
  return purpose && roundHasOwn(ROUND_PURPOSE_RANK, purpose) ? ROUND_PURPOSE_RANK[purpose] : 0;
}

function roundPurposeLabel(purpose) {
  if (purpose === 'explanation') return '解释';
  if (purpose === 'variation') return '变式';
  if (purpose === 'transfer') return '迁移';
  return '练习';
}

/**
 * Hint texts for one prompt: author `teaching.hints` first, then the author
 * scoring rubric (`criteria`), then one generic prompt. Exported so the backend
 * and the page agree on both the available count and the text. Kept portable.
 */
export function roundHintTexts(model, promptId) {
  var prompt = roundPromptById(model, promptId);
  var teaching = prompt && roundIsRecord(prompt.teaching) ? prompt.teaching : null;
  if (teaching && Array.isArray(teaching.hints) && teaching.hints.length > 0) return teaching.hints.slice();
  if (prompt && Array.isArray(prompt.criteria) && prompt.criteria.length > 0) return prompt.criteria.slice();
  return [ROUND_GENERIC_HINT];
}

// The real submission time of an attempt: an explicit submittedAt when the
// record has one, else the legacy combined `at`. Progression is ordered by when
// the learner actually answered, never by when a tutor's judgement arrived.
function roundSubmissionAnchor(attempt) {
  if (attempt && roundValidTime(attempt.submittedAt)) return attempt.submittedAt;
  return attempt ? attempt.at : null;
}

// A positive judgement must have something to check it against: a non-empty
// author reference or at least one judgement criterion. Mirrors the shared
// `tutorEvidenceHasBasis` rule so a basis-less answer can never be promoted.
function roundPromptHasBasis(prompt) {
  if (!prompt) return false;
  if (typeof prompt.answer === 'string' && prompt.answer.trim() !== '') return true;
  if (Array.isArray(prompt.criteria) && prompt.criteria.some(function (line) {
    return typeof line === 'string' && line.trim() !== '';
  })) return true;
  return false;
}

// The tutor's currently effective evaluation of this attempt — the latest
// event whatever target it credits. A later evaluation of a correction replaces
// an earlier judgement of the original, exactly as the scheduler decides it.
function roundEffectiveTutorAssessment(attempt) {
  var events = Array.isArray(attempt.tutorAssessments) ? attempt.tutorAssessments.slice() : [];
  if (events.length === 0) return null;
  events.sort(function (a, b) {
    var delta = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return events[events.length - 1];
}

// The tutor's latest judgement of the *original* answer, ignoring every event
// that credits a correction. A later positive judgement aimed at a correction
// must never erase (or promote) the original answer's own verdict, and a later
// independent original-answer judgement is what can finally settle it.
function roundEffectiveOriginalTutorAssessment(attempt) {
  var events = Array.isArray(attempt.tutorAssessments) ? attempt.tutorAssessments.slice() : [];
  var originals = events.filter(function (event) {
    if (!event) return false;
    return event.targetCorrectionId === undefined || event.targetCorrectionId === null;
  });
  if (originals.length === 0) return null;
  originals.sort(function (a, b) {
    var delta = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return originals[originals.length - 1];
}

// The effective tutor event when this attempt's *own original* answer is an
// independent, checkable success; null otherwise. An assisted answer, a credit
// aimed at a correction, a hard/again rating, or a basis-less prompt all fail.
function roundPositiveCredit(model, attempt) {
  if (!attempt || attempt.assisted !== false) return null;
  var prompt = roundPromptById(model, attempt.promptId);
  if (!prompt || !roundPromptHasBasis(prompt)) return null;
  var effective = roundEffectiveTutorAssessment(attempt);
  if (!effective) return null;
  if (effective.targetCorrectionId !== null) return null;
  if (effective.rating !== 'good' && effective.rating !== 'easy') return null;
  return effective;
}

// Whether an attempt can stand as an independent original answer for a
// concept-level tutor evidence record. Mirrors the shared `independentEvidence
// Attempt` rule: no assistance, a checkable basis, and a current tutor credit
// that is neither aimed at a correction nor judged `again`. An untouched answer
// with no tutor evaluation stays independent (only `evidence` can then judge it).
function roundIndependentOriginal(model, attempt) {
  if (!attempt || attempt.assisted !== false) return false;
  var prompt = roundPromptById(model, attempt.promptId);
  if (!prompt || !roundPromptHasBasis(prompt)) return false;
  var effective = roundEffectiveTutorAssessment(attempt);
  if (!effective) return true;
  if (effective.targetCorrectionId !== null) return false;
  if (effective.rating === 'again') return false;
  return true;
}

// One attempt-level signal. Only a tutor evaluation (never a self-assessment)
// produces a signal; the verdict is decided against the live original answer.
function roundAttemptSignal(model, attempt) {
  var prompt = roundPromptById(model, attempt.promptId);
  if (!prompt) return null;
  var effective = roundEffectiveTutorAssessment(attempt);
  if (!effective) return null;
  var independent = attempt.assisted === false;
  var hasBasis = roundPromptHasBasis(prompt);
  var positive = Boolean(roundPositiveCredit(model, attempt));
  var anchor = roundSubmissionAnchor(attempt);
  if (!roundValidTime(anchor)) return null;
  return {
    kind: 'attempt',
    verdict: positive ? 'success' : 'difficulty',
    rating: effective.rating,
    purpose: roundPromptPurpose(prompt),
    promptId: prompt.id,
    attemptId: attempt.id,
    orderAt: anchor,
    orderId: attempt.id,
    assessmentAt: effective.at,
    independent: independent,
    hasBasis: hasBasis,
    correctionTarget: effective.targetCorrectionId === undefined ? null : effective.targetCorrectionId,
  };
}

// Whether the statuses that claim positive mastery are actually backed by the
// referenced independent answers. Mirrors the shared EVIDENCE_RULES: explained
// needs an explain/compare answer, applied an apply answer, retained two
// independent answers separated by at least 20 hours.
function roundEvidenceStatusBacked(status, independent) {
  if (status === 'explained') {
    return independent.some(function (entry) { return entry.prompt.kind === 'explain' || entry.prompt.kind === 'compare'; });
  }
  if (status === 'applied') {
    return independent.some(function (entry) { return entry.prompt.kind === 'apply'; });
  }
  if (status === 'retained') {
    if (independent.length < 2) return false;
    var times = independent
      .map(function (entry) { return new Date(roundSubmissionAnchor(entry.attempt)).getTime(); })
      .sort(function (a, b) { return a - b; });
    return times.length >= 2 && times[times.length - 1] - times[0] >= ROUND_RETAINED_MIN_GAP_MS;
  }
  return false;
}

// A concept-level tutor evidence record is only trusted when it names the tutor
// as its source, references real current attempts on this very concept, and (for
// a positive status) those attempts are independent, checkable original-answer
// successes. A record matching only the concept fingerprint, or resting on a
// missing/stale/assisted/forged answer, yields no signal.
function roundEvidenceSignal(model, conceptId, evidence, attemptsById) {
  if (!roundIsRecord(evidence) || evidence.reviewer !== 'tutor') return null;
  if (typeof evidence.status !== 'string' || evidence.status === 'unknown') return null;
  if (!Array.isArray(evidence.attemptIds) || evidence.attemptIds.length === 0) return null;
  var conceptFingerprints = (model && model.conceptFingerprints) || {};
  var liveConcept = roundHasOwn(conceptFingerprints, conceptId) ? conceptFingerprints[conceptId] : null;
  if (!liveConcept || evidence.conceptFingerprint !== liveConcept) return null;
  var checked = [];
  for (var i = 0; i < evidence.attemptIds.length; i += 1) {
    var attemptId = evidence.attemptIds[i];
    var attempt = roundHasOwn(attemptsById, attemptId) ? attemptsById[attemptId] : null;
    if (!attempt) return null;
    var prompt = roundPromptById(model, attempt.promptId);
    if (!prompt || prompt.conceptId !== conceptId) return null;
    var fingerprint = roundCurrentPromptFingerprint(model, prompt.id);
    if (!fingerprint || attempt.fingerprint !== fingerprint) return null;
    checked.push({ attempt: attempt, prompt: prompt });
  }
  if (evidence.status !== 'needs-work') {
    var independent = checked.filter(function (entry) { return roundIndependentOriginal(model, entry.attempt); });
    if (!roundEvidenceStatusBacked(evidence.status, independent)) return null;
  }
  // Order by the real submissions the evidence rests on, not the review time.
  var anchorEntry = checked[0];
  for (var j = 1; j < checked.length; j += 1) {
    var delta = new Date(roundSubmissionAnchor(checked[j].attempt)).getTime()
      - new Date(roundSubmissionAnchor(anchorEntry.attempt)).getTime();
    if (delta > 0 || (delta === 0 && String(checked[j].attempt.id) > String(anchorEntry.attempt.id))) anchorEntry = checked[j];
  }
  return {
    kind: 'evidence',
    verdict: evidence.status === 'needs-work' ? 'difficulty' : 'success',
    status: evidence.status,
    purpose: null,
    promptId: anchorEntry.prompt.id,
    attemptId: anchorEntry.attempt.id,
    orderAt: roundSubmissionAnchor(anchorEntry.attempt),
    orderId: 'evidence-' + conceptId,
    assessmentAt: evidence.at,
    independent: evidence.status !== 'needs-work',
  };
}

// Every current-content tutor signal for one concept, ordered later by the real
// submission each one rests on.
function roundConceptSignals(state, model, conceptId) {
  var signals = [];
  var current = (model && model.promptFingerprints) || {};
  roundPrompts(model).forEach(function (prompt) {
    if (prompt.conceptId !== conceptId) return;
    var fingerprint = roundHasOwn(current, prompt.id) ? current[prompt.id] : null;
    if (!fingerprint) return;
    var list = state && state.attempts && roundHasOwn(state.attempts, prompt.id) ? state.attempts[prompt.id] : null;
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) {
      if (!attempt || attempt.fingerprint !== fingerprint) return;
      var signal = roundAttemptSignal(model, attempt);
      if (signal) signals.push(signal);
    });
  });
  var evidence = state && state.conceptEvidence && roundHasOwn(state.conceptEvidence, conceptId)
    ? state.conceptEvidence[conceptId] : null;
  var evidenceSignal = roundEvidenceSignal(model, conceptId, evidence, roundAttemptsById(state));
  if (evidenceSignal) signals.push(evidenceSignal);
  return signals;
}

// The latest signal by the actual answer time, with a stable id tie-break so a
// late-arriving judgement can never outrank a newer validated answer.
function roundLatestSignal(signals) {
  var best = null;
  signals.forEach(function (signal) {
    if (!best) { best = signal; return; }
    var delta = new Date(signal.orderAt).getTime() - new Date(best.orderAt).getTime();
    if (delta > 0) best = signal;
    else if (delta === 0 && String(signal.orderId) > String(best.orderId)) best = signal;
  });
  return best;
}

// 'success' when the signal is a current independent original-answer success,
// 'difficulty' when it shows a gap, else null.
function roundSignalVerdict(signal) {
  return signal ? signal.verdict : null;
}

function roundSignalNote(signal) {
  if (!signal) return '当前内容还没有独立原答的导师评价';
  if (signal.kind === 'evidence') {
    return signal.verdict === 'difficulty'
      ? '当前有效导师证据标记该概念仍需补漏'
      : '当前有效导师证据为 ' + signal.status;
  }
  if (signal.verdict === 'success') return '最近一次当前内容的独立原答被导师评为 ' + signal.rating;
  if (!signal.independent) return '最近一次当前内容的评价来自有协助作答';
  if (signal.correctionTarget !== null) return '最近一次导师评价针对的是修正，而非独立原答';
  if (!signal.hasBasis) return '最近一次评价缺少作者参考或判定标准，无法作为独立成功';
  return '最近一次当前内容的独立原答被导师评为 ' + signal.rating;
}

// The next purpose after the strongest current independent success: explanation
// -> variation -> transfer, staying at transfer once reached.
function roundNextPurpose(signals) {
  var best = 0;
  signals.forEach(function (signal) {
    if (roundSignalVerdict(signal) !== 'success') return;
    var rank = roundPurposeRank(signal.purpose);
    if (signal.kind === 'evidence') {
      rank = Math.max(rank, signal.status === 'applied' || signal.status === 'retained'
        ? ROUND_PURPOSE_RANK.transfer : ROUND_PURPOSE_RANK.explanation);
    }
    if (rank > best) best = rank;
  });
  if (best >= ROUND_PURPOSE_RANK.transfer) return 'transfer';
  if (best === ROUND_PURPOSE_RANK.variation) return 'transfer';
  if (best === ROUND_PURPOSE_RANK.explanation) return 'variation';
  return 'explanation';
}

function roundAnsweredPrompts(state, model, prompts) {
  var answered = roundNullMap();
  prompts.forEach(function (prompt) {
    var fingerprint = roundCurrentPromptFingerprint(model, prompt.id);
    var list = state && state.attempts && roundHasOwn(state.attempts, prompt.id) ? state.attempts[prompt.id] : null;
    if (!fingerprint || !Array.isArray(list)) return;
    if (list.some(function (attempt) {
      return attempt && attempt.fingerprint === fingerprint && typeof attempt.answer === 'string' && attempt.answer.trim() !== '';
    })) answered[prompt.id] = true;
  });
  return answered;
}

function roundPickPromptForPurpose(prompts, purpose, answered) {
  var candidates = prompts.filter(function (prompt) { return roundPromptPurpose(prompt) === purpose; });
  if (candidates.length === 0) return null;
  var fresh = candidates.filter(function (prompt) { return !answered[prompt.id]; });
  return (fresh.length > 0 ? fresh : candidates)[0];
}

// When the requested purpose has no author question, fall back to the closest
// available purpose (unanswered first, then model order) instead of inventing a
// task that has no verified content behind it.
function roundPickFallbackPrompt(prompts, answered, targetPurpose) {
  var targetRank = roundPurposeRank(targetPurpose) || ROUND_PURPOSE_RANK.explanation;
  var index = roundNullMap();
  prompts.forEach(function (prompt, position) { index[prompt.id] = position; });
  var sorted = prompts.slice().sort(function (a, b) {
    var da = Math.abs(roundPurposeRank(roundPromptPurpose(a)) - targetRank);
    var db = Math.abs(roundPurposeRank(roundPromptPurpose(b)) - targetRank);
    if (da !== db) return da - db;
    var fa = answered[a.id] ? 1 : 0;
    var fb = answered[b.id] ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return index[a.id] - index[b.id];
  });
  return sorted[0] || null;
}

/**
 * Pure progressive-practice selection for one concept. Returns
 * `{promptId, purpose, reason, basisAttemptId}`.
 *
 * Only a *current-content, independent original-answer* tutor success (or a
 * current concept-level tutor evidence of explained/applied/retained) moves the
 * learner up to variation/transfer. A hard/again rating, needs-work evidence, or
 * an assisted success asks first for an explanation/prerequisite task.
 * Unevaluated, self-only, stale, or correction-only credit never counts as
 * independent success. The chosen task is always an existing author prompt; if
 * the requested purpose has none, the reason says so and a real prompt is used
 * instead of claiming a task that does not exist.
 */
export function roundPracticeSelection(state, model, conceptId) {
  if (!roundConceptById(model, conceptId)) {
    throw roundFail('E_STATE', '概念不存在：' + JSON.stringify(conceptId));
  }
  var prompts = roundPrompts(model).filter(function (prompt) { return prompt.conceptId === conceptId; });
  if (prompts.length === 0) {
    return {
      promptId: null,
      purpose: null,
      reason: '概念 ' + conceptId + ' 在当前内容中没有作者题，无法安排递进练习，也不虚构未核对任务',
      basisAttemptId: null,
    };
  }
  var signals = roundConceptSignals(state, model, conceptId);
  var latest = roundLatestSignal(signals);
  var verdict = roundSignalVerdict(latest);
  var targetPurpose;
  var reason;
  if (verdict === 'difficulty') {
    targetPurpose = 'explanation';
    reason = roundSignalNote(latest) + '，先补解释或必要前置';
  } else if (verdict === 'success') {
    targetPurpose = roundNextPurpose(signals);
    reason = roundSignalNote(latest) + '，用' + roundPurposeLabel(targetPurpose) + '题检验迁移';
  } else {
    targetPurpose = 'explanation';
    reason = '当前内容还没有独立原答的导师评价，先用解释题建立可核对基线';
  }
  var answered = roundAnsweredPrompts(state, model, prompts);
  var picked = roundPickPromptForPurpose(prompts, targetPurpose, answered);
  if (!picked) {
    picked = roundPickFallbackPrompt(prompts, answered, targetPurpose);
    if (picked) {
      reason += '；当前内容缺少' + roundPurposeLabel(targetPurpose) + '目的题，回退到'
        + roundPurposeLabel(roundPromptPurpose(picked)) + '题，不虚构未核对内容';
    }
  }
  if (!picked) {
    return {
      promptId: null,
      purpose: null,
      reason: reason + '；当前内容没有可用作者题，无法安排任务',
      basisAttemptId: latest ? latest.attemptId : null,
    };
  }
  return {
    promptId: picked.id,
    purpose: roundPromptPurpose(picked),
    reason: reason,
    basisAttemptId: latest ? latest.attemptId : null,
  };
}

// Resolve an author prompt or a learner-authored question to the small record
// the review planner needs. Own questions deliberately carry `hasBasis:false`:
// they may be focused or due, but they can never be promoted by this module to
// tutor-confirmed repeated errors or mastery.
function roundPromptRecord(model, state, promptId) {
  var prompt = roundPromptById(model, promptId);
  if (prompt) {
    return {
      id: prompt.id,
      conceptId: prompt.conceptId,
      kind: typeof prompt.kind === 'string' ? prompt.kind : 'explain',
      question: typeof prompt.question === 'string' ? prompt.question : '',
      answer: typeof prompt.answer === 'string' ? prompt.answer : '',
      criteria: Array.isArray(prompt.criteria) ? prompt.criteria : [],
      origin: 'model',
      currentFingerprint: roundCurrentPromptFingerprint(model, prompt.id),
      hasBasis: roundPromptHasBasis(prompt),
      prompt: prompt,
    };
  }
  var own = state && state.ownQuestions && roundHasOwn(state.ownQuestions, promptId) ? state.ownQuestions[promptId] : null;
  if (!own || typeof own.conceptId !== 'string' || !roundConceptById(model, own.conceptId)) return null;
  return {
    id: typeof own.id === 'string' ? own.id : promptId,
    conceptId: own.conceptId,
    kind: 'recall',
    question: typeof own.text === 'string' ? own.text : '',
    answer: '',
    criteria: [],
    origin: 'learner',
    // A learner question has no model fingerprint, but the caller (the state
    // wrapper or the page) supplies its recomputed fingerprint in
    // `model.promptFingerprints` exactly like an author prompt. Reading it here
    // lets binding, staleness and completion treat an own question as real
    // content without ever granting it tutor mastery.
    currentFingerprint: roundCurrentPromptFingerprint(model, promptId),
    hasBasis: false,
    prompt: null,
  };
}

function roundPromptIsCurrent(model, state, promptId) {
  var info = roundPromptRecord(model, state, promptId);
  if (!info) return false;
  if (info.origin === 'learner') return true;
  return Boolean(info.currentFingerprint);
}

function roundReviewStableId(candidate) {
  return candidate.promptId !== null && candidate.promptId !== undefined
    ? 'p:' + candidate.promptId
    : 'c:' + candidate.conceptId + ':' + (candidate.reasonKind || 'gap');
}

function roundReviewCandidateKey(candidate) {
  if (candidate.promptId !== null && candidate.promptId !== undefined) return 'prompt:' + candidate.promptId;
  return 'concept:' + candidate.conceptId;
}

function roundReviewMergeCandidate(map, candidate) {
  var key = roundReviewCandidateKey(candidate);
  var existing = roundHasOwn(map, key) ? map[key] : null;
  if (!existing) {
    map[key] = candidate;
    return candidate;
  }
  existing.considered = Boolean(existing.considered || candidate.considered);
  existing.focus = Boolean(existing.focus || candidate.focus);
  existing.focusRelated = Boolean(existing.focusRelated || candidate.focusRelated);
  existing.actionable = Boolean(existing.actionable && candidate.actionable);
  if (candidate.priority < existing.priority) {
    existing.priority = candidate.priority;
    existing.priorityKind = candidate.priorityKind;
    existing.source = candidate.source;
  }
  if (candidate.orderIndex !== undefined && (existing.orderIndex === undefined || candidate.orderIndex < existing.orderIndex)) {
    existing.orderIndex = candidate.orderIndex;
  }
  if (candidate.sortAt && (!existing.sortAt || candidate.sortAt > existing.sortAt)) existing.sortAt = candidate.sortAt;
  if (candidate.dueAt && (!existing.dueAt || candidate.dueAt < existing.dueAt)) existing.dueAt = candidate.dueAt;
  if (candidate.dueNow) existing.dueNow = true;
  if (candidate.latestNegativeAt && (!existing.latestNegativeAt || candidate.latestNegativeAt > existing.latestNegativeAt)) {
    existing.latestNegativeAt = candidate.latestNegativeAt;
  }
  if (!existing.assessmentSource && candidate.assessmentSource) existing.assessmentSource = candidate.assessmentSource;
  if (!existing.attemptId && candidate.attemptId) existing.attemptId = candidate.attemptId;
  if (!existing.pendingAssessmentAt && candidate.pendingAssessmentAt) existing.pendingAssessmentAt = candidate.pendingAssessmentAt;
  if (!existing.repeatedAttemptId && candidate.repeatedAttemptId) existing.repeatedAttemptId = candidate.repeatedAttemptId;
  // A real reason replaces the generic option blurb instead of being glued to a
  // false "not due" claim. Only when both sides carry a real reason are they
  // joined (for example a repeated item that is also genuinely due).
  var existingText = existing.optionPlaceholder ? '' : existing.reason;
  var candidateText = candidate.optionPlaceholder ? '' : candidate.reason;
  if (!candidate.optionPlaceholder) existing.optionPlaceholder = false;
  var reasons = [];
  [existingText, candidateText].forEach(function (text) {
    if (typeof text !== 'string') return;
    // Focus metadata adds a prefix to the same prerequisite explanation. Keep
    // each explanatory clause once while retaining distinct focus/due reasons.
    text.split('；').forEach(function (clause) {
      if (clause !== '' && reasons.indexOf(clause) === -1) reasons.push(clause);
    });
  });
  if (reasons.length > 0) existing.reason = reasons.join('；');
  if (candidate.sources) {
    candidate.sources.forEach(function (source) {
      if (existing.sources.indexOf(source) === -1) existing.sources.push(source);
    });
  }
  if (existing.sources.indexOf(candidate.source) === -1) existing.sources.push(candidate.source);
  return existing;
}

function roundReviewCandidateBase(state, model, promptId, conceptId, priorityKind, reason) {
  var info = roundPromptRecord(model, state, promptId);
  var resolvedConceptId = conceptId || (info ? info.conceptId : null);
  var concept = resolvedConceptId ? roundConceptById(model, resolvedConceptId) : null;
  return {
    promptId: promptId === null || promptId === undefined ? null : promptId,
    conceptId: resolvedConceptId,
    conceptTitle: concept ? concept.title : null,
    question: info ? info.question : null,
    origin: info ? info.origin : 'gap',
    reason: reason,
    priority: ROUND_REVIEW_PRIORITY[priorityKind] === undefined ? ROUND_REVIEW_PRIORITY.option : ROUND_REVIEW_PRIORITY[priorityKind],
    priorityKind: priorityKind,
    source: priorityKind,
    sources: [priorityKind],
    estimatedMinutes: roundEstimate(concept),
    dueAt: null,
    dueNow: false,
    assessmentSource: null,
    attemptId: null,
    pendingAssessmentAt: null,
    deferredReason: null,
    considered: false,
    focus: false,
    // `focusRelated` marks a candidate that the active focus list (or its own
    // necessary prerequisites) pulled forward. `optionPlaceholder` marks the
    // generic "default not due, may be chosen" blurb that must be replaced —
    // never concatenated — once a real due/repeated/focus reason applies.
    focusRelated: false,
    optionPlaceholder: false,
    actionable: promptId !== null && promptId !== undefined,
    target: false,
  };
}

function roundLatestAttempt(state, promptId) {
  var list = state && state.attempts && roundHasOwn(state.attempts, promptId) ? state.attempts[promptId] : null;
  if (!Array.isArray(list)) return null;
  var best = null;
  list.forEach(function (attempt) {
    if (!attempt || typeof attempt.id !== 'string') return;
    var anchor = roundSubmissionAnchor(attempt);
    if (!roundValidTime(anchor)) return;
    if (!best) {
      best = { attempt: attempt, anchor: anchor };
      return;
    }
    var delta = new Date(anchor).getTime() - new Date(best.anchor).getTime();
    if (delta > 0 || (delta === 0 && String(attempt.id) > String(best.attempt.id))) best = { attempt: attempt, anchor: anchor };
  });
  return best;
}

function roundAttemptHasAnyAssessment(attempt) {
  if (!attempt) return false;
  if (Array.isArray(attempt.tutorAssessments) && attempt.tutorAssessments.length > 0) return true;
  if (Array.isArray(attempt.selfAssessments) && attempt.selfAssessments.length > 0) return true;
  return ['again', 'hard', 'good', 'easy'].indexOf(attempt.rating) !== -1;
}

function roundReviewPendingAssessmentAt(state, promptId, schedule) {
  if (!schedule || typeof schedule.attemptId !== 'string') return null;
  var latest = roundLatestAttempt(state, promptId);
  if (!latest || latest.attempt.id === schedule.attemptId) return null;
  if (roundAttemptHasAnyAssessment(latest.attempt)) return null;
  return latest.anchor;
}

function roundReviewAttachSchedule(candidate, state, model, timeMs) {
  if (!candidate || !candidate.promptId) return candidate;
  var schedule = state && state.schedules && roundHasOwn(state.schedules, candidate.promptId)
    ? state.schedules[candidate.promptId] : null;
  if (!roundIsRecord(schedule) || !roundValidTime(schedule.dueAt)) return candidate;
  if (!candidate.dueAt) candidate.dueAt = schedule.dueAt;
  if (!candidate.assessmentSource && typeof schedule.assessmentSource === 'string') candidate.assessmentSource = schedule.assessmentSource;
  if (!candidate.attemptId && typeof schedule.attemptId === 'string') candidate.attemptId = schedule.attemptId;
  if (!candidate.pendingAssessmentAt) candidate.pendingAssessmentAt = roundReviewPendingAssessmentAt(state, candidate.promptId, schedule);
  if (new Date(schedule.dueAt).getTime() <= timeMs) candidate.dueNow = true;
  return candidate;
}

function roundReviewDueCandidates(state, model, timeMs) {
  var out = [];
  var schedules = (state && state.schedules) || {};
  Object.keys(schedules).forEach(function (promptId) {
    var schedule = schedules[promptId];
    if (!roundIsRecord(schedule) || !roundValidTime(schedule.dueAt)) return;
    var dueMs = new Date(schedule.dueAt).getTime();
    if (dueMs > timeMs) return;
    var info = roundPromptRecord(model, state, promptId);
    if (!info) return;
    var concept = roundConceptById(model, info.conceptId);
    var stale = info.origin === 'model' && !info.currentFingerprint;
    out.push({
      promptId: promptId,
      conceptId: info.conceptId,
      conceptTitle: concept ? concept.title : null,
      question: info.question,
      origin: info.origin,
      dueAt: schedule.dueAt,
      dueMs: dueMs,
      assessmentSource: typeof schedule.assessmentSource === 'string' ? schedule.assessmentSource : null,
      attemptId: typeof schedule.attemptId === 'string' ? schedule.attemptId : null,
      pendingAssessmentAt: roundReviewPendingAssessmentAt(state, promptId, schedule),
      stale: stale,
    });
  });
  out.sort(function (a, b) {
    if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
    return a.promptId < b.promptId ? -1 : a.promptId > b.promptId ? 1 : 0;
  });
  return out;
}

// The repeated-error rule counts only independent, current original answers
// with an effective tutor hard/again *after* the last independent tutor success
// for the same prompt. Submission time, not assessment arrival time, decides
// the order, so a late judgement can never jump an older answer over a newer
// one. An unassessed newer answer is pending and does not erase the earlier
// repeated error.
function roundReviewRepeatedError(state, model, promptId) {
  var info = roundPromptRecord(model, state, promptId);
  if (!info || info.origin !== 'model' || !info.hasBasis || !info.currentFingerprint) return null;
  var list = state && state.attempts && roundHasOwn(state.attempts, promptId) ? state.attempts[promptId] : null;
  if (!Array.isArray(list)) return null;
  var entries = [];
  list.forEach(function (attempt) {
    if (!attempt || attempt.fingerprint !== info.currentFingerprint || attempt.assisted !== false) return;
    var anchor = roundSubmissionAnchor(attempt);
    if (!roundValidTime(anchor)) return;
    // Only the latest judgement of this answer's own original target counts.
    // A later good aimed at a correction must not hide an earlier hard/again,
    // and the correction itself is never a new original answer.
    entries.push({ attempt: attempt, anchor: anchor, effective: roundEffectiveOriginalTutorAssessment(attempt) });
  });
  entries.sort(function (a, b) {
    var delta = new Date(a.anchor).getTime() - new Date(b.anchor).getTime();
    if (delta !== 0) return delta;
    return a.attempt.id < b.attempt.id ? -1 : a.attempt.id > b.attempt.id ? 1 : 0;
  });
  var lastSuccess = -1;
  entries.forEach(function (entry, index) {
    var effective = entry.effective;
    if (!effective) return;
    if (effective.targetCorrectionId !== null) return;
    if (effective.rating !== 'good' && effective.rating !== 'easy') return;
    lastSuccess = index;
  });
  var negatives = entries.slice(lastSuccess + 1).filter(function (entry) {
    var effective = entry.effective;
    if (!effective) return false;
    if (effective.targetCorrectionId !== null) return false;
    return effective.rating === 'hard' || effective.rating === 'again';
  });
  if (negatives.length < 2) return null;
  var latest = negatives[negatives.length - 1];
  return {
    count: negatives.length,
    attemptId: latest.attempt.id,
    latestNegativeAt: latest.anchor,
    attemptIds: negatives.map(function (entry) { return entry.attempt.id; }),
  };
}

function roundReviewConceptHasSuccess(state, model, conceptId) {
  var latest = roundLatestSignal(roundConceptSignals(state, model, conceptId));
  return Boolean(latest && latest.verdict === 'success');
}

function roundReviewPrerequisiteCandidates(state, model, targets, prefixReason, focusRelated) {
  var out = [];
  var targetSet = roundNullMap();
  targets.forEach(function (id) { targetSet[id] = true; });
  var ordered = roundOrderConcepts(state, model, targets);
  var orderIndex = roundNullMap();
  ordered.forEach(function (id, index) { orderIndex[id] = index; });
  var prerequisiteTo = roundPrerequisiteMap(model, state);
  ordered.forEach(function (conceptId) {
    if (targetSet[conceptId]) return;
    if (roundReviewConceptHasSuccess(state, model, conceptId)) return;
    var selection;
    try {
      selection = roundPracticeSelection(state, model, conceptId);
    } catch (err) {
      selection = { promptId: null, reason: err.message, purpose: null, basisAttemptId: null };
    }
    var concept = roundConceptById(model, conceptId);
    var targetTitles = roundTargetTitles(model, targets);
    var reason = (prefixReason ? prefixReason + '；' : '') + '目标概念 ' + targetTitles.join('、')
      + ' 的必要前置 ' + (concept ? concept.title : conceptId) + ' 还缺少当前内容的独立原答导师成功依据，先安排可核对补漏';
    if (selection.reason) reason += '；' + selection.reason;
    var candidate = roundReviewCandidateBase(
      state, model, selection.promptId || null, conceptId, 'prerequisite', reason,
    );
    candidate.orderIndex = orderIndex[conceptId];
    candidate.considered = true;
    candidate.target = false;
    candidate.focusRelated = Boolean(focusRelated);
    candidate.reasonKind = 'prerequisite';
    if (!selection.promptId) {
      candidate.actionable = false;
      candidate.reason += '；当前内容没有作者题，不能伪造失败、掌握或可执行补漏，需作者补题或改为可核对材料';
    }
    out.push(candidate);
  });
  return out;
}

function roundReviewNormalizeFocus(state, model, list) {
  if (list === undefined || list === null) throw roundFail('E_USAGE', 'focusPromptIds 必须是 prompt id 数组，[] 表示清除重点');
  if (!Array.isArray(list)) throw roundFail('E_USAGE', 'focusPromptIds 必须是数组');
  var ids = [];
  list.forEach(function (id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw roundFail('E_USAGE', '重点 prompt id 必须是非空字符串，收到 ' + JSON.stringify(id));
    }
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  ids.forEach(function (id) {
    var info = roundPromptRecord(model, state, id);
    if (!info) throw roundFail('E_USAGE', '重点问题不存在：' + id);
    if (!roundPromptIsCurrent(model, state, id)) throw roundFail('E_USAGE', '重点问题不在当前内容中：' + id);
  });
  return ids;
}

function roundReviewFocusCandidates(state, model, focusPromptIds) {
  var out = [];
  var concepts = [];
  focusPromptIds.forEach(function (promptId) {
    var info = roundPromptRecord(model, state, promptId);
    if (!info) return;
    if (concepts.indexOf(info.conceptId) === -1) concepts.push(info.conceptId);
  });
  roundReviewPrerequisiteCandidates(state, model, concepts, '主动重点 ' + focusPromptIds.join('、') + ' 的必要前置', true).forEach(function (candidate) {
    out.push(candidate);
  });
  focusPromptIds.forEach(function (promptId, index) {
    var info = roundPromptRecord(model, state, promptId);
    if (!info) return;
    var repeated = info.origin === 'model' ? roundReviewRepeatedError(state, model, promptId) : null;
    var reason = '学习者主动调整本轮重点：先做这道题。选择只改变本轮安排，不表示完成，也不改动复习日期';
    if (repeated) reason += '；该题在最近一次独立成功后仍有 ' + repeated.count + ' 条有效导师 hard/again 原答';
    var candidate = roundReviewCandidateBase(state, model, promptId, info.conceptId, 'focus', reason);
    candidate.orderIndex = index;
    candidate.considered = true;
    candidate.focus = true;
    candidate.focusRelated = true;
    candidate.reasonKind = 'focus';
    if (repeated) {
      candidate.latestNegativeAt = repeated.latestNegativeAt;
      candidate.repeatedAttemptId = repeated.attemptId;
      candidate.attemptId = repeated.attemptId;
      candidate.assessmentSource = 'tutor';
    }
    out.push(candidate);
  });
  return out;
}

function roundReviewMergeCandidates(state, model, round, timeMs, focusPromptIds) {
  var map = roundNullMap();
  // Every current prompt is a legal explicit focus choice. Only the items the
  // default or focus plan actually considers take part in selected/deferred.
  roundPrompts(model).forEach(function (prompt) {
    var info = roundPromptRecord(model, state, prompt.id);
    if (!info || !info.currentFingerprint) return;
    var option = roundReviewCandidateBase(
      state, model, prompt.id, prompt.conceptId, 'option',
      '当前内容中的可复习题；默认未到期，可主动选为本轮重点',
    );
    option.optionPlaceholder = true;
    roundReviewMergeCandidate(map, option);
  });
  Object.keys((state && state.ownQuestions) || {}).forEach(function (promptId) {
    var info = roundPromptRecord(model, state, promptId);
    if (!info) return;
    var option = roundReviewCandidateBase(
      state, model, promptId, info.conceptId, 'option',
      '自创问题：可主动选为重点；没有作者参考或判定标准时不会据此授予导师掌握',
    );
    option.optionPlaceholder = true;
    roundReviewMergeCandidate(map, option);
  });

  var considered = [];
  // The default plan is always present. A focus list is an overlay that raises
  // those prompt ids ahead of repeated errors and ordinary due items; it never
  // hides the other still-due items, which remain visible as deferred.
  roundReviewPrerequisiteCandidates(state, model, round.conceptIds.slice(), null)
    .forEach(function (candidate) { considered.push(candidate); });
  roundPrompts(model).forEach(function (prompt) {
    var repeated = roundReviewRepeatedError(state, model, prompt.id);
    if (!repeated) return;
    var info = roundPromptRecord(model, state, prompt.id);
    var candidate = roundReviewCandidateBase(
      state, model, prompt.id, info.conceptId, 'repeated',
      '该题在最近一次独立成功后仍有 ' + repeated.count + ' 条当前内容的独立原答被导师评为 hard/again；先处理反复错误，重复事件不另计次数',
    );
    candidate.latestNegativeAt = repeated.latestNegativeAt;
    candidate.repeatedAttemptId = repeated.attemptId;
    candidate.attemptId = repeated.attemptId;
    candidate.assessmentSource = 'tutor';
    candidate.considered = true;
    candidate.reasonKind = 'repeated';
    considered.push(candidate);
  });
  var dueEntries = roundReviewDueCandidates(state, model, timeMs);
  dueEntries.forEach(function (due) {
    var candidate = roundReviewCandidateBase(
      state, model, due.promptId, due.conceptId, 'due',
      due.stale
        ? '该复习日期来自旧内容，需先核对当前内容；暂缓或筛选都不表示完成或遗忘'
        : '真实到期安排，按到期程度安排本轮复习；暂缓不表示完成或遗忘',
    );
    candidate.dueAt = due.dueAt;
    candidate.dueNow = true;
    candidate.assessmentSource = due.assessmentSource;
    candidate.attemptId = due.attemptId;
    candidate.pendingAssessmentAt = due.pendingAssessmentAt;
    candidate.considered = true;
    candidate.reasonKind = 'due';
    candidate.stale = due.stale;
    considered.push(candidate);
  });
  if (focusPromptIds.length > 0) {
    roundReviewFocusCandidates(state, model, focusPromptIds).forEach(function (candidate) { considered.push(candidate); });
  }
  considered.forEach(function (candidate) { roundReviewMergeCandidate(map, candidate); });
  Object.keys(map).forEach(function (key) {
    roundReviewAttachSchedule(map[key], state, model, timeMs);
  });
  var candidates = Object.keys(map).map(function (key) { return map[key]; });
  candidates.forEach(function (candidate) {
    candidate.reason = candidate.reason || '';
    candidate.deferredReason = null;
    var concept = candidate.conceptId ? roundConceptById(model, candidate.conceptId) : null;
    candidate.target = Boolean(concept && round.conceptIds.indexOf(candidate.conceptId) !== -1);
  });
  candidates.sort(function (a, b) {
    if (a.considered !== b.considered) return a.considered ? -1 : 1;
    // A learner focus is a real override for this session: the focus prompt and
    // its own necessary prerequisites come first, and the default goal plan
    // (goal prerequisites, repeated errors, due items) stays deferred unless it
    // is also required by the focus. Budget still applies as a prefix, so the
    // focus can never be scheduled before a prerequisite it actually needs.
    if (focusPromptIds.length > 0) {
      var af = a.focusRelated ? 0 : 1;
      var bf = b.focusRelated ? 0 : 1;
      if (af !== bf) return af - bf;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.orderIndex !== undefined && b.orderIndex !== undefined && a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
    if (a.priorityKind === 'repeated' && b.priorityKind === 'repeated') {
      var ar = a.latestNegativeAt ? new Date(a.latestNegativeAt).getTime() : 0;
      var br = b.latestNegativeAt ? new Date(b.latestNegativeAt).getTime() : 0;
      if (ar !== br) return br - ar;
    }
    if (a.dueAt && b.dueAt) {
      var ad = new Date(a.dueAt).getTime();
      var bd = new Date(b.dueAt).getTime();
      if (ad !== bd) return ad - bd;
    } else if (a.dueAt && !b.dueAt) return -1;
    else if (!a.dueAt && b.dueAt) return 1;
    var aid = roundReviewStableId(a);
    var bid = roundReviewStableId(b);
    return aid < bid ? -1 : aid > bid ? 1 : 0;
  });
  return candidates;
}

function roundReviewSelect(candidates, budgetMinutes, focusActive) {
  var considered = candidates.filter(function (candidate) { return candidate.considered; });
  var selected = [];
  var deferred = [];
  var deferredReason = function (candidate) {
    if (candidate.actionable === false) {
      return '缺少可执行作者题：保留为待补题或材料补充，不占本轮预算，也不伪造任务';
    }
    if (focusActive && !candidate.focusRelated) {
      // Only a real, currently-past due date may be described as "still due".
      // A future arrangement is honestly kept as not-yet-due, and an item with
      // no arrangement stays a plain deferred follow-up.
      if (candidate.dueNow) return '主动重点外仍到期：本轮预算未安排，暂缓续接；原到期状态不变';
      if (candidate.dueAt) return '主动重点外尚未到期：保留原复习安排，本轮暂缓续接；未选不表示完成或遗忘';
      return '主动重点外的其他计划项：本轮未安排，留待后续续接；暂缓不表示完成或遗忘';
    }
    if (budgetMinutes === null || budgetMinutes === undefined) {
      return '未提供时间预算：先完成一个聚焦单元，其余暂缓续接；暂缓不表示完成或忘记';
    }
    return '超出本轮 ' + budgetMinutes + ' 分钟预算，暂缓续接；未选中的到期题仍保持真实到期状态';
  };
  if (budgetMinutes === null || budgetMinutes === undefined) {
    var stop = -1;
    for (var i = 0; i < considered.length; i += 1) {
      if (considered[i].actionable !== false && (considered[i].focus || considered[i].priorityKind === 'prerequisite')) {
        stop = i;
        break;
      }
    }
    if (stop < 0) stop = considered.length > 0 ? 0 : -1;
    considered.forEach(function (candidate, index) {
      if (candidate.actionable === false) {
        candidate.deferredReason = deferredReason(candidate);
        deferred.push(candidate);
      } else if (index <= stop) {
        candidate.deferredReason = null;
        selected.push(candidate);
      } else {
        candidate.deferredReason = deferredReason(candidate);
        deferred.push(candidate);
      }
    });
  } else {
    var used = 0;
    var closed = false;
    considered.forEach(function (candidate) {
      if (candidate.actionable === false) {
        candidate.deferredReason = deferredReason(candidate);
        deferred.push(candidate);
        return;
      }
      if (!closed && used + candidate.estimatedMinutes <= budgetMinutes) {
        used += candidate.estimatedMinutes;
        candidate.deferredReason = null;
        selected.push(candidate);
        return;
      }
      closed = true;
      candidate.deferredReason = deferredReason(candidate);
      deferred.push(candidate);
    });
  }
  return { selected: selected, deferred: deferred, estimatedMinutes: selected.reduce(function (sum, item) { return sum + item.estimatedMinutes; }, 0) };
}

function roundReviewCandidateRecord(candidate, deferred) {
  return {
    promptId: candidate.promptId,
    conceptId: candidate.conceptId,
    conceptTitle: candidate.conceptTitle || null,
    question: candidate.question || null,
    origin: candidate.origin || null,
    reason: candidate.reason,
    priority: candidate.priority,
    priorityKind: candidate.priorityKind,
    source: candidate.source,
    sources: Array.isArray(candidate.sources) ? candidate.sources.slice() : [candidate.source],
    estimatedMinutes: candidate.estimatedMinutes,
    dueAt: candidate.dueAt || null,
    dueNow: Boolean(candidate.dueNow),
    assessmentSource: candidate.assessmentSource || null,
    attemptId: candidate.attemptId || null,
    pendingAssessmentAt: candidate.pendingAssessmentAt || null,
    deferredReason: deferred ? candidate.deferredReason : null,
    considered: Boolean(candidate.considered),
    focus: Boolean(candidate.focus),
    actionable: candidate.actionable !== false,
    unresolved: candidate.actionable === false,
    target: Boolean(candidate.target),
  };
}

function roundReviewPlanRecord(plan) {
  return {
    at: plan.at,
    budgetMinutes: plan.budgetMinutes,
    focusPromptIds: plan.focusPromptIds.slice(),
    selected: plan.selected.map(function (candidate) { return roundReviewCandidateRecord(candidate, false); }),
    deferred: plan.deferred.map(function (candidate) { return roundReviewCandidateRecord(candidate, true); }),
    estimatedMinutes: plan.estimatedMinutes,
    dueCount: plan.dueCount,
    modelFingerprint: plan.modelFingerprint || null,
  };
}

/**
 * Pure review-plan selection. It reads current rounds, prerequisites, real
 * current answers, effective tutor judgements and persisted due dates, then
 * returns both the full due list and the budget-filtered selection. It never
 * writes an attempt, schedule, rating or completion flag.
 */
export function roundReviewPlan(state, model, options, at) {
  var opts = options === undefined || options === null ? {} : options;
  if (!roundIsRecord(opts)) throw roundFail('E_USAGE', '复习计划 options 必须是对象');
  var time = at || new Date().toISOString();
  if (!roundValidTime(time)) throw roundFail('E_USAGE', '时间格式不合法：' + time);
  var timeMs = new Date(time).getTime();
  var rounds = (state && state.learningRounds) || {};
  var roundId;
  if (opts.roundId !== undefined && opts.roundId !== null && opts.roundId !== '') {
    if (typeof opts.roundId !== 'string') throw roundFail('E_USAGE', 'roundId 必须是字符串');
    roundId = opts.roundId;
  } else {
    roundId = state && state.activeRoundId ? state.activeRoundId : null;
  }
  var round = roundId && roundHasOwn(rounds, roundId) ? rounds[roundId] : null;
  if (!round) {
    return {
      present: false,
      roundId: roundId || null,
      at: time,
      budgetMinutes: null,
      focusPromptIds: [],
      candidates: [],
      selected: [],
      deferred: [],
      estimatedMinutes: 0,
      allDue: [],
      dueCount: 0,
      modelFingerprint: model ? model.modelFingerprint || null : null,
    };
  }
  var stored = round.reviewPlan && roundIsRecord(round.reviewPlan) ? round.reviewPlan : null;
  var budgetMinutes;
  if (roundHasOwn(opts, 'budgetMinutes')) budgetMinutes = roundAssertBudget(opts.budgetMinutes);
  else if (stored && (stored.budgetMinutes === null || Number.isInteger(stored.budgetMinutes))) budgetMinutes = stored.budgetMinutes;
  else budgetMinutes = roundAssertBudget(round.budgetMinutes);
  var focusPromptIds;
  if (roundHasOwn(opts, 'focusPromptIds')) focusPromptIds = roundReviewNormalizeFocus(state, model, opts.focusPromptIds);
  else if (stored && Array.isArray(stored.focusPromptIds)) focusPromptIds = roundReviewNormalizeFocus(state, model, stored.focusPromptIds);
  else focusPromptIds = [];
  var candidates = roundReviewMergeCandidates(state, model, round, timeMs, focusPromptIds);
  var chosen = roundReviewSelect(candidates, budgetMinutes, focusPromptIds.length > 0);
  var allDue = roundReviewDueCandidates(state, model, timeMs).map(function (due) {
    var candidate = roundReviewCandidateBase(
      state, model, due.promptId, due.conceptId, 'due',
      due.stale
        ? '该复习日期来自旧内容，需先核对当前内容；暂缓或筛选都不表示完成或遗忘'
        : '真实到期安排；未选中不等于完成或忘记',
    );
    candidate.dueAt = due.dueAt;
    candidate.dueNow = true;
    candidate.assessmentSource = due.assessmentSource;
    candidate.attemptId = due.attemptId;
    candidate.pendingAssessmentAt = due.pendingAssessmentAt;
    candidate.considered = true;
    candidate.reasonKind = 'due';
    candidate.stale = due.stale;
    return roundReviewCandidateRecord(candidate, false);
  });
  return {
    present: true,
    roundId: round.id,
    at: time,
    budgetMinutes: budgetMinutes,
    focusPromptIds: focusPromptIds.slice(),
    candidates: candidates.map(function (candidate) { return roundReviewCandidateRecord(candidate, false); }),
    selected: chosen.selected.map(function (candidate) { return roundReviewCandidateRecord(candidate, false); }),
    deferred: chosen.deferred.map(function (candidate) { return roundReviewCandidateRecord(candidate, true); }),
    estimatedMinutes: chosen.estimatedMinutes,
    allDue: allDue,
    dueCount: allDue.length,
    modelFingerprint: model ? model.modelFingerprint || null : null,
  };
}

function roundTaskId(roundId, conceptId, promptId) {
  return 'task-' + roundHash(roundId + '|' + conceptId + '|' + (promptId || ''));
}

function roundTargetTitles(model, ids) {
  return ids.map(function (id) {
    var concept = roundConceptById(model, id);
    return concept ? concept.title : id;
  });
}

// Topological order over the target concepts plus every prerequisite they
// reach, stable by model order, with current needs-work concepts pulled ahead of
// equally-ready peers so gaps are repaired before new targets.
function roundOrderConcepts(state, model, targets) {
  var order = roundConceptOrder(model);
  var prerequisiteTo = roundPrerequisiteMap(model, state);
  var needed = roundNullMap();
  var stack = targets.slice();
  while (stack.length > 0) {
    var conceptId = stack.pop();
    if (needed[conceptId] || !roundHasOwn(order, conceptId)) continue;
    needed[conceptId] = true;
    var prerequisites = roundHasOwn(prerequisiteTo, conceptId) ? prerequisiteTo[conceptId] : [];
    for (var i = 0; i < prerequisites.length; i += 1) {
      if (roundHasOwn(order, prerequisites[i])) stack.push(prerequisites[i]);
    }
  }
  var needsWork = roundNeedsWorkSet(state, model);
  var remaining = Object.keys(needed);
  var done = roundNullMap();
  var out = [];
  while (remaining.length > 0) {
    var ready = remaining.filter(function (conceptId) {
      var list = roundHasOwn(prerequisiteTo, conceptId) ? prerequisiteTo[conceptId] : [];
      return list.every(function (prerequisite) {
        return !needed[prerequisite] || done[prerequisite];
      });
    });
    if (ready.length === 0) ready = remaining.slice();
    ready.sort(function (a, b) {
      var aGap = needsWork[a] ? 0 : 1;
      var bGap = needsWork[b] ? 0 : 1;
      if (aGap !== bGap) return aGap - bGap;
      return order[a] - order[b];
    });
    var pick = ready[0];
    out.push(pick);
    done[pick] = true;
    remaining = remaining.filter(function (conceptId) { return conceptId !== pick; });
  }
  return out;
}

function roundBuildRouteTasks(state, model, round) {
  var prerequisiteTo = roundPrerequisiteMap(model, state);
  var targets = roundNullMap();
  round.conceptIds.forEach(function (id) { targets[id] = true; });
  var needsWork = roundNeedsWorkSet(state, model);
  var targetTitles = roundTargetTitles(model, round.conceptIds);
  return roundOrderConcepts(state, model, round.conceptIds).map(function (conceptId) {
    var concept = roundConceptById(model, conceptId);
    // The task's question is chosen by the shared progressive selector: a gap
    // asks for explanation/prerequisite work, a current independent success
    // moves up to variation/transfer. It always names a real author prompt.
    var selection = roundPracticeSelection(state, model, conceptId);
    var prompt = selection.promptId ? roundPromptById(model, selection.promptId) : null;
    var promptId = prompt ? prompt.id : null;
    var prerequisites = (roundHasOwn(prerequisiteTo, conceptId) ? prerequisiteTo[conceptId] : [])
      .filter(function (id) { return Boolean(roundConceptById(model, id)); });
    var reasons = [];
    if (needsWork[conceptId]) reasons.push('已有当前有效的需要补缺口');
    if (targets[conceptId]) {
      reasons.push(prerequisites.length > 0 ? '本轮目标概念；先补齐必要前置' : '本轮目标概念');
    } else {
      reasons.push('目标概念 ' + targetTitles.join('、') + ' 的必要前置');
    }
    if (selection.reason) reasons.push(selection.reason);
    return {
      id: roundTaskId(round.id, conceptId, promptId),
      conceptId: conceptId,
      promptId: promptId,
      fingerprint: roundCurrentPromptFingerprint(model, promptId),
      reason: reasons.join('；'),
      teachingPurpose: selection.purpose,
      estimatedMinutes: roundEstimate(concept),
      completionCriteria: roundTaskCriteria(prompt),
      authorCriteria: roundAuthorCriteria(prompt),
      prerequisites: prerequisites,
      target: Boolean(targets[conceptId]),
      deferred: false,
      deferredReason: null,
      diagnostic: false,
    };
  });
}

function roundDiagnosticTask(state, model, round) {
  var conceptId = round.conceptIds[0];
  var concept = roundConceptById(model, conceptId);
  var prompt = roundPickPrompt(model, conceptId, ROUND_DIAGNOSTIC_PROMPT_ORDER);
  var promptId = prompt ? prompt.id : null;
  return {
    id: roundTaskId(round.id, conceptId, promptId) + '-diag',
    conceptId: conceptId,
    promptId: promptId,
    fingerprint: roundCurrentPromptFingerprint(model, promptId),
    reason: '学新主题：先用真实回答暴露基础与缺口',
    teachingPurpose: prompt ? roundPromptPurpose(prompt) : null,
    estimatedMinutes: ROUND_DIAGNOSTIC_MINUTES,
    completionCriteria: roundTaskCriteria(prompt),
    authorCriteria: roundAuthorCriteria(prompt),
    prerequisites: [],
    target: true,
    deferred: false,
    deferredReason: null,
    diagnostic: true,
  };
}

// Refresh a kept diagnostic task to the current content while preserving its
// stable id: the prompt it probes, fingerprint, criteria and estimate all come
// from the fresh task, but the id (and therefore the learner's earlier bound
// answers) stays. A content edit or a newly added prompt thus restores
// answerability — the old answer reads as stale history rather than a valid
// current submission, and is never rewritten.
function roundRefreshDiagnosticTask(previous, fresh) {
  if (!previous) return fresh;
  return Object.assign({}, fresh, {
    id: previous.id,
    // Keep any archival metadata shape consistent if a caller stored it.
    excluded: false,
    deferred: false,
    deferredReason: null,
  });
}

// Gating + budget in one pass.
// - diagnosing: every route task is deferred until confirmation.
// - no budget: the prefix through the first target (a focused unit plus its
//   necessary prerequisite chain) stays open; the rest defers.
// - a budget keeps tasks as a prefix: the moment one task does not fit, that
//   task and every later task defer. A budget can never skip an expensive
//   prerequisite to schedule a cheaper descendant out of order.
function roundApplyBudget(tasks, budgetMinutes, gated) {
  var out = tasks.map(function (task) { return Object.assign({}, task, { prerequisites: (task.prerequisites || []).slice() }); });
  if (gated) {
    out.forEach(function (task) {
      task.deferred = true;
      task.deferredReason = '等待诊断确认后继续正式路线';
    });
    return out;
  }
  if (budgetMinutes === null || budgetMinutes === undefined) {
    var firstTarget = -1;
    for (var i = 0; i < out.length; i += 1) {
      if (out[i].target) { firstTarget = i; break; }
    }
    if (firstTarget < 0) firstTarget = out.length - 1;
    out.forEach(function (task, index) {
      if (index <= firstTarget) { task.deferred = false; task.deferredReason = null; return; }
      task.deferred = true;
      task.deferredReason = '未提供时间预算：先完成一个聚焦单元及其必要前置，其余下次续接';
    });
    return out;
  }
  var used = 0;
  var closed = false;
  out.forEach(function (task) {
    if (!closed && used + task.estimatedMinutes <= budgetMinutes) {
      used += task.estimatedMinutes;
      task.deferred = false;
      task.deferredReason = null;
      return;
    }
    closed = true;
    task.deferred = true;
    task.deferredReason = '超出本轮 ' + budgetMinutes + ' 分钟预算，下次续接';
  });
  return out;
}

// The effective status for route composition: a paused round behaves as the
// status it will restore, so a paused diagnosing round keeps its diagnostic gate
// while the learner edits goal/budget instead of un-gating the formal route.
function roundEffectiveStatusOf(round) {
  if (!round) return null;
  return round.status === 'paused' ? (round.resumeStatus || 'active') : round.status;
}

// Compose the round's active route. The diagnostic probe always targets the
// current first concept: when the target changes before confirmation (or a
// confirmed diagnostic no longer matches the route), the old diagnostic is
// archived with its original id and submissions and a fresh probe is prepared.
function roundComposeTasks(state, model, round, time) {
  if (!Array.isArray(round.archivedTasks)) round.archivedTasks = [];
  var effectiveStatus = roundEffectiveStatusOf(round);
  var wantedConceptId = round.conceptIds[0];
  var previousDiagnostics = (round.tasks || []).filter(function (task) { return task && task.diagnostic; });
  var route = roundBuildRouteTasks(state, model, round);

  var archive = function (task, reason) {
    if (!task) return;
    if ((round.archivedTasks || []).some(function (item) { return item.id === task.id; })) return;
    round.archivedTasks.push(Object.assign({}, task, {
      excluded: true, deferred: false, deferredReason: null,
      archivedAt: time || round.updatedAt || null, archivedReason: reason,
    }));
  };

  if (effectiveStatus === 'diagnosing') {
    var fresh = roundDiagnosticTask(state, model, round);
    // Keep only a diagnostic that still probes the current target concept.
    var currentDiagnostic = previousDiagnostics.filter(function (task) { return task.conceptId === wantedConceptId; })[0] || null;
    previousDiagnostics.forEach(function (task) {
      if (task !== currentDiagnostic) archive(task, '目标概念已改变，原诊断问题不再对应当前目标，已保留其历史作答');
    });
    // Same prompt (edited content / new fingerprint): refresh the existing
    // task in place so the stable id and the learner's bound answers survive.
    // A *different* prompt (the old diagnostic question was removed, or a better
    // one was added) must NOT keep the old task id while repointing it at a new
    // promptId: that would break `roundResolveBinding` for the earlier answers,
    // whose task identity is checked against the prompt. Archive the old
    // diagnostic instead and use a fresh task id; the old answers stay resolvable
    // through the archive for idempotent replay.
    var samePrompt = currentDiagnostic && (currentDiagnostic.promptId || null) === (fresh.promptId || null);
    if (currentDiagnostic && !samePrompt) {
      archive(currentDiagnostic, '诊断问题已更换，原诊断任务与历史作答已保留为归档');
      currentDiagnostic = null;
    }
    var diagnostic = currentDiagnostic ? roundRefreshDiagnosticTask(currentDiagnostic, fresh) : fresh;
    return [diagnostic].concat(roundApplyBudget(route, round.budgetMinutes, true));
  }

  // Confirmed route: a diagnostic that no longer matches the route concept is
  // archived; otherwise it stays visible as the completed first step.
  var keptDiagnostic = null;
  previousDiagnostics.forEach(function (task) {
    if (task.conceptId === wantedConceptId && !keptDiagnostic) keptDiagnostic = task;
    else archive(task, '本轮目标已改变，原诊断问题不再对应当前目标，已保留其历史作答');
  });
  var composed = roundApplyBudget(route, round.budgetMinutes, false);
  return keptDiagnostic ? [keptDiagnostic].concat(composed) : composed;
}

// Attempts bound to one round task, across every prompt bucket.
function roundBoundAttempts(state, roundId, taskId) {
  var out = [];
  var attempts = (state && state.attempts) || {};
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) {
      if (attempt && attempt.roundId === roundId && attempt.taskId === taskId) out.push(attempt);
    });
  });
  return out;
}

// Real submissions that are still current for their task: the same prompt and
// concept, the live content fingerprint, and a non-empty answer. Stale work
// after a content update is reported, never counted as submitted.
function roundCurrentSubmissions(state, model, round, task) {
  if (!task || !task.promptId) return [];
  var info = roundPromptRecord(model, state, task.promptId);
  if (!info) return [];
  // Own questions carry a recomputed fingerprint in the supplied model (the
  // Node wrapper merges `collectPromptFingerprints`, the page sends the same
  // map). Identity plus that fingerprint proves the recorded answer still
  // matches the current question text; this is observation only and never
  // grants tutor mastery. When no fingerprint is supplied (portable caller
  // without own-question hashes) the older identity-only check is kept.
  if (info.origin === 'learner') {
    var ownCurrent = info.currentFingerprint;
    return roundBoundAttempts(state, round.id, task.id).filter(function (attempt) {
      return attempt.promptId === task.promptId &&
        attempt.conceptId === task.conceptId &&
        typeof attempt.answer === 'string' && attempt.answer.trim() !== '' &&
        (!ownCurrent || attempt.fingerprint === ownCurrent);
    });
  }
  var current = info.currentFingerprint;
  if (!current) return [];
  return roundBoundAttempts(state, round.id, task.id).filter(function (attempt) {
    return attempt.promptId === task.promptId &&
      attempt.conceptId === task.conceptId &&
      attempt.fingerprint === current &&
      typeof attempt.answer === 'string' && attempt.answer.trim() !== '';
  });
}

// Bound real submissions whose content fingerprint no longer matches the live
// model: they stay in history and mark the task as needing re-work.
function roundStaleSubmissions(state, model, round, task) {
  if (!task || !task.promptId) return [];
  var info = roundPromptRecord(model, state, task.promptId);
  // A learner question without a supplied fingerprint cannot be judged; the
  // older identity-only behavior is kept instead of claiming false staleness.
  if (info && info.origin === 'learner' && !info.currentFingerprint) return [];
  // A model prompt that left the live model reports its earlier answers as the
  // stale history they are (same as before this change).
  var current = info ? info.currentFingerprint : roundCurrentPromptFingerprint(model, task.promptId);
  return roundBoundAttempts(state, round.id, task.id).filter(function (attempt) {
    return typeof attempt.answer === 'string' && attempt.answer.trim() !== '' &&
      (attempt.promptId !== task.promptId || attempt.fingerprint !== current);
  });
}

function roundSubmittedSet(state, model, round, tasks) {
  var set = roundNullMap();
  tasks.forEach(function (task) {
    if (!task.excluded && roundCurrentSubmissions(state, model, round, task).length > 0) set[task.id] = true;
  });
  return set;
}

function roundSelectCurrent(tasks, round, preserve, submitted) {
  var active = tasks.filter(function (task) { return !task.excluded; });
  // While a new-topic round is diagnosing, the diagnostic probe is the current
  // step regardless of the (still-gated) formal route.
  if (round && roundEffectiveStatusOf(round) === 'diagnosing') {
    var diagnostic = active.filter(function (task) { return task.diagnostic && !task.deferred; })[0];
    if (diagnostic) return diagnostic.id;
  }
  // The formal route drives the current position once diagnosed: the diagnostic
  // task is a completed step, never a stand-in for the next real task.
  var open = active.filter(function (task) { return !task.diagnostic && !task.deferred; });
  if (preserve && round && round.currentTaskId) {
    var kept = open.filter(function (task) { return task.id === round.currentTaskId; })[0];
    if (kept) return kept.id;
  }
  // No open task means no current position — a budget that fits nothing must
  // not point the learner at a deferred task. `null` is honest and the page
  // shows the budget is insufficient; raising the budget opens a task again.
  if (open.length === 0) return null;
  var pending = open.filter(function (task) { return !submitted[task.id]; });
  if (pending.length > 0) return pending[0].id;
  return open[0].id;
}

// The formal route is the taught sequence (everything but the diagnostic probe).
// Completion and the current position are judged against it: a submitted
// diagnostic is a completed *step*, never a stand-in for the next real task.
function roundFormalOpenTasks(round) {
  return (round.tasks || []).filter(function (task) {
    return !task.excluded && !task.diagnostic && !task.deferred;
  });
}

// Mark an active round completed once every open formal task has a *current*
// real submission. Mutates the round inside the caller-owned state clone. A
// budget-insufficient plan (formal tasks all deferred) is not complete: it is
// waiting for more time, so `remaining`/`allSubmitted` stay honest.
function roundRefreshCompletion(state, model, round) {
  if (!round || round.status !== 'active') return false;
  var open = roundFormalOpenTasks(round);
  if (open.length === 0) return false;
  var submitted = roundSubmittedSet(state, model, round, open);
  if (!open.every(function (task) { return submitted[task.id]; })) return false;
  round.status = 'completed';
  return true;
}

// The persisted `status` can go stale without any round operation: a content
// update invalidates earlier fingerprints, so a round stored as `completed` may
// have real work remaining again. `roundEffectiveStatus` derives the honest
// status from the *current* open tasks so the public read never claims a false
// completion. The stored value stays on the round as its historical record.
function roundEffectiveStatus(state, model, round) {
  if (!round || round.status !== 'completed') return round ? round.status : null;
  var open = roundFormalOpenTasks(round);
  // No open tasks left: the completion is still truthful.
  if (open.length === 0) return 'completed';
  var submitted = roundSubmittedSet(state, model, round, open);
  return open.every(function (task) { return submitted[task.id]; }) ? 'completed' : 'active';
}

// Move tasks that left the active route into an append-only archive so their
// original ids and submissions stay visible instead of being destroyed.
function roundArchiveRemoved(round, previousTasks, time, reason) {
  var activeIds = {};
  (round.tasks || []).forEach(function (task) { activeIds[task.id] = true; });
  if (!Array.isArray(round.archivedTasks)) round.archivedTasks = [];
  var archivedIds = {};
  round.archivedTasks.forEach(function (task) { archivedIds[task.id] = true; });
  (previousTasks || []).forEach(function (task) {
    if (activeIds[task.id] || archivedIds[task.id]) return;
    round.archivedTasks.push(Object.assign({}, task, {
      excluded: true,
      deferred: false,
      deferredReason: null,
      archivedAt: time,
      archivedReason: reason,
    }));
    archivedIds[task.id] = true;
  });
}

function roundValidateTask(task, path) {
  if (!roundIsRecord(task)) throw roundFail('E_STATE', '轮次任务必须是对象', path);
  if (typeof task.id !== 'string' || task.id === '') throw roundFail('E_STATE', '轮次任务缺少 id', path + '.id');
  if (typeof task.conceptId !== 'string' || task.conceptId === '') throw roundFail('E_STATE', '轮次任务缺少 conceptId', path + '.conceptId');
  if (task.promptId !== null && task.promptId !== undefined && typeof task.promptId !== 'string') {
    throw roundFail('E_STATE', '轮次任务的 promptId 必须是字符串或 null', path + '.promptId');
  }
  if (typeof task.reason !== 'string') throw roundFail('E_STATE', '轮次任务缺少 reason', path + '.reason');
  if (!Number.isInteger(task.estimatedMinutes) || task.estimatedMinutes <= 0) {
    throw roundFail('E_STATE', '轮次任务 estimatedMinutes 必须是正整数', path + '.estimatedMinutes');
  }
  if (!Array.isArray(task.completionCriteria) || task.completionCriteria.some(function (line) { return typeof line !== 'string'; })) {
    throw roundFail('E_STATE', '轮次任务 completionCriteria 必须是字符串数组', path + '.completionCriteria');
  }
  if (task.authorCriteria !== undefined && task.authorCriteria !== null &&
      (!Array.isArray(task.authorCriteria) || task.authorCriteria.some(function (line) { return typeof line !== 'string'; }))) {
    throw roundFail('E_STATE', '轮次任务 authorCriteria 必须是字符串数组（可省略）', path + '.authorCriteria');
  }
  if (task.deferred !== undefined && typeof task.deferred !== 'boolean') throw roundFail('E_STATE', '轮次任务 deferred 必须是布尔值', path + '.deferred');
  if (task.target !== undefined && typeof task.target !== 'boolean') throw roundFail('E_STATE', '轮次任务 target 必须是布尔值', path + '.target');
  if (task.diagnostic !== undefined && typeof task.diagnostic !== 'boolean') throw roundFail('E_STATE', '轮次任务 diagnostic 必须是布尔值', path + '.diagnostic');
  if (task.excluded !== undefined && typeof task.excluded !== 'boolean') throw roundFail('E_STATE', '轮次任务 excluded 必须是布尔值', path + '.excluded');
  // Optional teaching goal (explanation/variation/transfer); a present value
  // must be one of the three so a corrupted import cannot claim an unknown one.
  if (task.teachingPurpose !== undefined && task.teachingPurpose !== null &&
      ROUND_TEACHING_PURPOSES.indexOf(task.teachingPurpose) === -1) {
    throw roundFail('E_STATE', '轮次任务 teachingPurpose 只能是 explanation/variation/transfer 或省略', path + '.teachingPurpose');
  }
  // `prerequisites` is optional (older archives may omit it), but when present
  // it must be a string-id array: `roundView` copies it, so a non-array value
  // would crash `round-read` instead of failing the import with a clear code.
  if (task.prerequisites !== undefined && task.prerequisites !== null) {
    if (!Array.isArray(task.prerequisites) ||
        task.prerequisites.some(function (id) { return typeof id !== 'string' || id === ''; })) {
      throw roundFail('E_STATE', '轮次任务 prerequisites 必须是字符串 id 数组（可省略）', path + '.prerequisites');
    }
  }
}

function roundValidateReviewCandidate(candidate, path) {
  if (!roundIsRecord(candidate)) throw roundFail('E_STATE', '复习计划候选必须是对象', path);
  if (candidate.promptId !== null && (typeof candidate.promptId !== 'string' || candidate.promptId === '')) {
    throw roundFail('E_STATE', '复习计划候选 promptId 必须是非空字符串或 null', path + '.promptId');
  }
  if (typeof candidate.conceptId !== 'string' || candidate.conceptId === '') {
    throw roundFail('E_STATE', '复习计划候选缺少 conceptId', path + '.conceptId');
  }
  if (typeof candidate.reason !== 'string') throw roundFail('E_STATE', '复习计划候选缺少 reason', path + '.reason');
  if (!Number.isInteger(candidate.priority) || candidate.priority < 0) {
    throw roundFail('E_STATE', '复习计划候选 priority 必须是非负整数', path + '.priority');
  }
  if (!Number.isInteger(candidate.estimatedMinutes) || candidate.estimatedMinutes <= 0) {
    throw roundFail('E_STATE', '复习计划候选 estimatedMinutes 必须是正整数', path + '.estimatedMinutes');
  }
  if (candidate.dueAt !== null && candidate.dueAt !== undefined && !roundValidTime(candidate.dueAt)) {
    throw roundFail('E_STATE', '复习计划候选 dueAt 必须是有效时间或 null', path + '.dueAt');
  }
  if (candidate.dueNow !== undefined && candidate.dueNow !== null && typeof candidate.dueNow !== 'boolean') {
    throw roundFail('E_STATE', '复习计划候选 dueNow 必须是布尔值', path + '.dueNow');
  }
  if (candidate.actionable !== undefined && candidate.actionable !== null && typeof candidate.actionable !== 'boolean') {
    throw roundFail('E_STATE', '复习计划候选 actionable 必须是布尔值', path + '.actionable');
  }
  if (candidate.unresolved !== undefined && candidate.unresolved !== null && typeof candidate.unresolved !== 'boolean') {
    throw roundFail('E_STATE', '复习计划候选 unresolved 必须是布尔值', path + '.unresolved');
  }
  if (candidate.assessmentSource !== null && candidate.assessmentSource !== undefined &&
      ROUND_REVIEW_ASSESSMENT_SOURCES.indexOf(candidate.assessmentSource) === -1) {
    throw roundFail('E_STATE', '复习计划候选 assessmentSource 不合法', path + '.assessmentSource');
  }
  if (candidate.attemptId !== null && candidate.attemptId !== undefined && typeof candidate.attemptId !== 'string') {
    throw roundFail('E_STATE', '复习计划候选 attemptId 必须是字符串或 null', path + '.attemptId');
  }
  if (candidate.pendingAssessmentAt !== null && candidate.pendingAssessmentAt !== undefined && !roundValidTime(candidate.pendingAssessmentAt)) {
    throw roundFail('E_STATE', '复习计划候选 pendingAssessmentAt 必须是有效时间或 null', path + '.pendingAssessmentAt');
  }
  if (candidate.deferredReason !== null && candidate.deferredReason !== undefined && typeof candidate.deferredReason !== 'string') {
    throw roundFail('E_STATE', '复习计划候选 deferredReason 必须是字符串或 null', path + '.deferredReason');
  }
  if (candidate.priorityKind !== undefined && candidate.priorityKind !== null && typeof candidate.priorityKind !== 'string') {
    throw roundFail('E_STATE', '复习计划候选 priorityKind 必须是字符串或 null', path + '.priorityKind');
  }
  if (candidate.source !== undefined && candidate.source !== null && typeof candidate.source !== 'string') {
    throw roundFail('E_STATE', '复习计划候选 source 必须是字符串或 null', path + '.source');
  }
  if (candidate.sources !== undefined && candidate.sources !== null &&
      (!Array.isArray(candidate.sources) || candidate.sources.some(function (item) { return typeof item !== 'string'; }))) {
    throw roundFail('E_STATE', '复习计划候选 sources 必须是字符串数组', path + '.sources');
  }
}

function roundValidateReviewPlan(plan, path) {
  if (!roundIsRecord(plan)) throw roundFail('E_STATE', 'reviewPlan 必须是对象（旧档可省略）', path);
  if (!roundValidTime(plan.at)) throw roundFail('E_STATE', 'reviewPlan.at 必须是有效时间', path + '.at');
  if (plan.budgetMinutes !== null && plan.budgetMinutes !== undefined &&
      (!Number.isInteger(plan.budgetMinutes) || plan.budgetMinutes <= 0)) {
    throw roundFail('E_STATE', 'reviewPlan.budgetMinutes 必须是正整数或 null', path + '.budgetMinutes');
  }
  if (!Array.isArray(plan.focusPromptIds) ||
      plan.focusPromptIds.some(function (id) { return typeof id !== 'string' || id === ''; })) {
    throw roundFail('E_STATE', 'reviewPlan.focusPromptIds 必须是字符串数组', path + '.focusPromptIds');
  }
  if (!Array.isArray(plan.selected)) throw roundFail('E_STATE', 'reviewPlan.selected 必须是数组', path + '.selected');
  if (!Array.isArray(plan.deferred)) throw roundFail('E_STATE', 'reviewPlan.deferred 必须是数组', path + '.deferred');
  plan.selected.forEach(function (candidate, index) { roundValidateReviewCandidate(candidate, path + '.selected[' + index + ']'); });
  plan.deferred.forEach(function (candidate, index) { roundValidateReviewCandidate(candidate, path + '.deferred[' + index + ']'); });
  if (!Number.isInteger(plan.estimatedMinutes) || plan.estimatedMinutes < 0) {
    throw roundFail('E_STATE', 'reviewPlan.estimatedMinutes 必须是非负整数', path + '.estimatedMinutes');
  }
  if (plan.dueCount !== undefined && (!Number.isInteger(plan.dueCount) || plan.dueCount < 0)) {
    throw roundFail('E_STATE', 'reviewPlan.dueCount 必须是非负整数', path + '.dueCount');
  }
  if (plan.modelFingerprint !== undefined && plan.modelFingerprint !== null && typeof plan.modelFingerprint !== 'string') {
    throw roundFail('E_STATE', 'reviewPlan.modelFingerprint 必须是字符串或 null', path + '.modelFingerprint');
  }
}

// Opening data lives within the existing round conflict/persistence boundary.
// It describes teaching context, never learner evidence or mastery.
function roundValidateOpeningText(value, path, nullable) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim()) throw roundFail('E_STATE', '需要非空文本' + (nullable ? '或 null' : ''), path);
}

function roundValidateLearner(learner, path) {
  if (!roundIsRecord(learner)) throw roundFail('E_STATE', '画像必须是对象', path);
  ['role', 'task', 'background', 'preference', 'temporaryApproach'].forEach(function (key) {
    roundValidateOpeningText(learner[key], path + '.' + key, true);
  });
  roundValidateOpeningText(learner.sourceNote, path + '.sourceNote', false);
  if (typeof learner.skipped !== 'boolean') throw roundFail('E_STATE', 'skipped 必须是布尔值', path + '.skipped');
  if ((learner.skipped || ['role', 'task', 'background', 'preference'].some(function (key) { return learner[key] === null; })) && !learner.temporaryApproach) {
    throw roundFail('E_STATE', '跳过或画像不全时需说明临时教学方式', path + '.temporaryApproach');
  }
}

function roundValidateOpeningScope(scope, path) {
  if (!roundIsRecord(scope)) throw roundFail('E_STATE', '路线范围必须是对象', path);
  ['goal', 'modelFingerprint', 'estimateBasis'].forEach(function (key) { roundValidateOpeningText(scope[key], path + '.' + key, false); });
  if (!roundValidTime(scope.at)) throw roundFail('E_STATE', '范围时间不合法', path + '.at');
  ['estimatedMinutes', 'diagnosticMinutes'].forEach(function (key) {
    if (!Number.isInteger(scope[key]) || scope[key] < 0) throw roundFail('E_STATE', '预计分钟需为非负整数', path + '.' + key);
  });
  if (!Array.isArray(scope.units)) throw roundFail('E_STATE', 'units 必须是数组', path + '.units');
  scope.units.forEach(function (unit, index) {
    var p = path + '.units[' + index + ']';
    if (!roundIsRecord(unit)) throw roundFail('E_STATE', '单元必须是对象', p);
    ['taskId', 'conceptId', 'outcome'].forEach(function (key) { roundValidateOpeningText(unit[key], p + '.' + key, false); });
    ['prerequisites', 'completionCriteria'].forEach(function (key) {
      if (!Array.isArray(unit[key]) || unit[key].some(function (line) { return typeof line !== 'string' || !line.trim(); })) throw roundFail('E_STATE', '需要文本数组', p + '.' + key);
    });
    if (!unit.completionCriteria.length) throw roundFail('E_STATE', '单元需有转段标准', p + '.completionCriteria');
    if (typeof unit.deferred !== 'boolean') throw roundFail('E_STATE', 'deferred 必须是布尔值', p + '.deferred');
    if (!Number.isInteger(unit.estimatedMinutes) || unit.estimatedMinutes <= 0) throw roundFail('E_STATE', '单元预计分钟需为正整数', p + '.estimatedMinutes');
    roundValidateOpeningText(unit.deferredReason, p + '.deferredReason', true);
  });
}

function roundValidateOpening(opening, path) {
  if (!roundIsRecord(opening) || opening.version !== 1) throw roundFail('E_STATE', 'opening 必须是 version 1 对象', path);
  roundValidateLearner(opening.learner, path + '.learner');
  if (opening.interactionLimit !== null && (!Number.isInteger(opening.interactionLimit) || opening.interactionLimit <= 0)) throw roundFail('E_STATE', '互动上限需为正整数或 null', path + '.interactionLimit');
  if (opening.preliminary !== null) roundValidateOpeningScope(opening.preliminary, path + '.preliminary');
  if (opening.calibrated !== null) roundValidateOpeningScope(opening.calibrated, path + '.calibrated');
  if (!Array.isArray(opening.history)) throw roundFail('E_STATE', '开场历史需为数组', path + '.history');
  opening.history.forEach(function (entry, index) {
    var p = path + '.history[' + index + ']';
    if (!roundIsRecord(entry) || !roundValidTime(entry.at)) throw roundFail('E_STATE', '开场历史时间不合法', p);
    roundValidateLearner(entry.learner, p + '.learner');
  });
}

function roundBuildOpeningScope(round, model, at) {
  // Before diagnosis the formal tasks are gated. Plan the same task prefix
  // without that gate so the opening estimate describes the intended scope.
  var routeTasks = (round.tasks || []).filter(function (task) { return !task.diagnostic && !task.excluded; });
  var budgetTasks = roundApplyBudget(routeTasks, round.budgetMinutes, false);
  var units = budgetTasks.map(function (task) {
    var concept = roundConceptById(model, task.conceptId);
    return { taskId: task.id, conceptId: task.conceptId,
      outcome: '能完成「' + (concept ? concept.title : task.conceptId) + '」的解释或应用，并依据标准检查产物',
      prerequisites: (task.prerequisites || []).slice(), completionCriteria: (task.authorCriteria && task.authorCriteria.length ? task.authorCriteria : task.completionCriteria).slice(),
      estimatedMinutes: task.estimatedMinutes, deferred: Boolean(task.deferred), deferredReason: task.deferredReason || null };
  });
  var included = budgetTasks.filter(function (task) { return !task.deferred; });
  return { at: at, goal: round.goal, modelFingerprint: model.modelFingerprint,
    units: units, estimatedMinutes: included.reduce(function (sum, task) { return sum + task.estimatedMinutes; }, 0),
    diagnosticMinutes: (round.tasks || []).filter(function (task) { return task.diagnostic; }).reduce(function (sum, task) { return sum + task.estimatedMinutes; }, 0),
    estimateBasis: included.length === 0 && budgetTasks.length > 0
      ? '预算不足，当前没有可安排单元；首个必要单元预计 ' + budgetTasks[0].estimatedMinutes + ' 分钟，需增加时间或缩小目标'
      : round.budgetMinutes == null ? '首个目标及必要前置的小单元；逐任务时间相加，诊断另列；其余暂缓，不是硬上限' : '预算内任务时间相加，诊断另列；预计用时不是用户上限' };
}

function roundRefreshOpening(round, model, input, at) {
  if (input === undefined && !round.opening) return;
  if (input !== undefined) {
    if (!roundIsRecord(input) || Object.keys(input).some(function (key) { return ['learner', 'interactionLimit'].indexOf(key) === -1; })) throw roundFail('E_USAGE', '开场输入只接受 learner 和 interactionLimit');
    if (!round.opening && input.learner === undefined) throw roundFail('E_USAGE', '首次开场需显式画像；未知信息用 null');
    var learner = input.learner !== undefined ? roundClone(input.learner) : round.opening.learner;
    roundValidateLearner(learner, 'opening.learner');
    var limit = input.interactionLimit !== undefined ? input.interactionLimit : (round.opening ? round.opening.interactionLimit : null);
    if (!round.opening) round.opening = { version: 1, learner: learner, interactionLimit: limit,
      preliminary: round.entry === 'learn-new-topic' && roundEffectiveStatusOf(round) !== 'diagnosing' ? null : roundBuildOpeningScope(round, model, at),
      calibrated: null, history: [] };
    if (JSON.stringify(round.opening.learner) !== JSON.stringify(learner)) round.opening.history.push({ at: at, learner: roundClone(round.opening.learner) });
    round.opening.learner = learner;
    round.opening.interactionLimit = limit;
  }
  if (roundEffectiveStatusOf(round) !== 'diagnosing') round.opening.calibrated = roundBuildOpeningScope(round, model, at);
  roundValidateOpening(round.opening, 'opening');
}

function roundOpeningView(round, model) {
  if (!round.opening) return null;
  var view = roundClone(round.opening);
  ['preliminary', 'calibrated'].forEach(function (key) {
    var scope = view[key];
    if (scope) scope.stale = scope.goal !== round.goal || scope.modelFingerprint !== model.modelFingerprint;
  });
  return view;
}

var ROUND_RESPONSE_KINDS = ['answer', 'clarification', 'correction', 'navigation', 'goal-change', 'confirmation', 'off-topic', 'excluded'];

function roundStartProgress(at, historyKnown) {
  return { version: 1, startedAt: at, historyKnown: historyKnown, events: [], intervals: [],
    adjustments: [], skippedTaskIds: [], extraMinutes: 0, interactionEstimate: null, closure: null, closureHistory: [] };
}

function roundProgressMeasure(round) {
  var p = round.progress;
  var count = p.events.filter(function (e) { return e.kind !== 'excluded'; }).length;
  var minutes = p.intervals.length ? p.intervals.reduce(function (sum, e) {
    return sum + (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000;
  }, 0) : null;
  var limit = round.opening ? round.opening.interactionLimit : null;
  var exhausted = (limit != null && count >= limit) || (minutes != null && round.budgetMinutes != null && minutes >= round.budgetMinutes);
  var near = (limit != null && count >= limit - 1) || (minutes != null && round.budgetMinutes != null && minutes >= round.budgetMinutes * 0.8);
  return { countedInteractions: count, totalInteractions: p.historyKnown ? count : null,
    interactionLimit: limit, actualMinutes: minutes, budgetSignal: exhausted ? 'exhausted' : near ? 'near-limit' : 'within-limit' };
}

function roundProgressClosure(round, model, reason, record, at) {
  return { at: at, reason: reason, goal: round.goal, modelFingerprint: model.modelFingerprint,
    conceptIds: round.conceptIds.slice(), taskIds: round.tasks.map(function (t) { return t.id; }),
    gaps: record.gaps || ['尚未解决的路线任务与未复核作答，见公开读回'],
    continuation: record.continuation || '从保存的当前位置及未解决任务续接；先核对目标和预算',
    saveNote: record.saveNote || '服务/CLI 保存到 state.json；独立页缓存需导出后交接',
    evidenceApplicability: record.evidenceApplicability || '收尾不改变任务提交、待复核或掌握判断' };
}

function roundGoalEvidenceSufficient(state, model, round) {
  var byId = roundAttemptsById(state);
  return round.conceptIds.length > 0 && round.conceptIds.every(function (id) {
    var signal = roundEvidenceSignal(model, id, (state.conceptEvidence || {})[id], byId);
    return signal && signal.verdict === 'success';
  });
}

function roundClosureCurrent(state, model, round) {
  var c = round.progress && round.progress.closure;
  if (!c || c.goal !== round.goal || c.modelFingerprint !== model.modelFingerprint) return false;
  if (JSON.stringify(c.conceptIds) !== JSON.stringify(round.conceptIds) || JSON.stringify(c.taskIds) !== JSON.stringify(round.tasks.map(function (t) { return t.id; }))) return false;
  if (c.reason === 'goal-achieved') return roundGoalEvidenceSufficient(state, model, round);
  if (c.reason === 'budget-exhausted') return roundProgressMeasure(round).budgetSignal === 'exhausted';
  return true;
}

function roundProgressView(state, model, round, tasks, currentTaskId) {
  if (!round.progress) return null;
  var p = roundClone(round.progress), measure = roundProgressMeasure(round);
  var remaining = tasks.filter(function (t) { return !t.submitted && !t.diagnostic; });
  var plannedTasks = roundEffectiveStatusOf(round) === 'diagnosing'
    ? roundApplyBudget((round.tasks || []).filter(function (t) { return !t.diagnostic; }), round.budgetMinutes, false)
    : tasks.filter(function (t) { return !t.diagnostic; });
  var estimatedMinutes = plannedTasks.filter(function (t) {
    return !t.deferred && remaining.some(function (r) { return r.id === t.id; });
  }).reduce(function (sum, t) { return sum + t.estimatedMinutes; }, p.extraMinutes);
  estimatedMinutes += tasks.filter(function (t) { return t.diagnostic && !t.submitted; })
    .reduce(function (sum, t) { return sum + t.estimatedMinutes; }, 0);
  var current = tasks.filter(function (t) { return t.id === currentTaskId; })[0] || null;
  var upcoming = tasks.filter(function (t) { return !t.deferred && !t.submitted && t.id !== currentTaskId && !t.diagnostic; });
  var attemptsById = roundAttemptsById(state);
  var attempts = Object.keys(attemptsById).map(function (id) { return attemptsById[id]; }).filter(function (a) { return a.roundId === round.id; });
  if (p.closure) p.closure.stale = !roundClosureCurrent(state, model, round);
  var ended = p.closure && !p.closure.stale;
  return Object.assign(p, measure, { ended: Boolean(ended), currentTask: current,
    nextTask: ended ? null : (upcoming[0] || null),
    remainingTaskIds: remaining.map(function (t) { return t.id; }),
    deferredTaskIds: remaining.filter(function (t) { return t.deferred; }).map(function (t) { return t.id; }),
    estimatedRemainingMinutes: estimatedMinutes,
    independentAttemptIds: attempts.filter(function (a) { return !a.assisted; }).map(function (a) { return a.id; }),
    assistedAttemptIds: attempts.filter(function (a) { return a.assisted; }).map(function (a) { return a.id; }),
    pendingReviewAttemptIds: attempts.filter(function (a) { return !(a.tutorAssessments && a.tutorAssessments.length); }).map(function (a) { return a.id; }),
    mastery: (round.conceptIds || []).map(function (id) {
      var signal = roundEvidenceSignal(model, id, (state.conceptEvidence || {})[id], attemptsById);
      return { conceptId: id, status: signal ? signal.status : 'unknown' };
    }) });
}

function roundValidateProgress(p, path) {
  if (!roundIsRecord(p) || p.version !== 1 || !roundValidTime(p.startedAt) || typeof p.historyKnown !== 'boolean') throw roundFail('E_STATE', '进度需为 version 1 对象及合法起点', path);
  ['events', 'intervals', 'adjustments', 'skippedTaskIds', 'closureHistory'].forEach(function (key) {
    if (!Array.isArray(p[key])) throw roundFail('E_STATE', '进度列表必须是数组', path + '.' + key);
  });
  var ids = roundNullMap();
  p.events.forEach(function (e, i) {
    var key = path + '.events[' + i + ']';
    if (!roundIsRecord(e) || !roundValidTime(e.at) || new Date(e.at) < new Date(p.startedAt) || ROUND_RESPONSE_KINDS.indexOf(e.kind) === -1) throw roundFail('E_STATE', '用户回应事件不合法或早于起算点', key);
    ['id', 'text', 'sourceNote'].forEach(function (field) { roundValidateOpeningText(e[field], key + '.' + field, false); });
    if (ids[e.id]) throw roundFail('E_STATE', '互动事件 ID 重复', key + '.id');
    ids[e.id] = true;
  });
  var intervalIds = roundNullMap();
  p.intervals.forEach(function (e, i) {
    var key = path + '.intervals[' + i + ']';
    if (!roundIsRecord(e) || !roundValidTime(e.start) || !roundValidTime(e.end) || new Date(e.end) <= new Date(e.start) || new Date(e.start) < new Date(p.startedAt)) throw roundFail('E_STATE', '学习时间区间不合法', key);
    ['id', 'sourceNote'].forEach(function (field) { roundValidateOpeningText(e[field], key + '.' + field, false); });
    if (intervalIds[e.id] || p.intervals.slice(0, i).some(function (other) { return new Date(e.start) < new Date(other.end) && new Date(e.end) > new Date(other.start); })) throw roundFail('E_STATE', '学习区间重复或重叠', key);
    intervalIds[e.id] = true;
  });
  if (typeof p.extraMinutes !== 'number' || !Number.isFinite(p.extraMinutes) || p.extraMinutes < 0) throw roundFail('E_STATE', '补讲预计分钟必须非负', path + '.extraMinutes');
  if (p.skippedTaskIds.some(function (id) { return typeof id !== 'string' || !id.trim(); }) || new Set(p.skippedTaskIds).size !== p.skippedTaskIds.length) throw roundFail('E_STATE', '跳过任务身份不合法', path + '.skippedTaskIds');
  roundValidateInteractionEstimate(p.interactionEstimate, path + '.interactionEstimate');
  p.adjustments.forEach(function (a, i) {
    var key = path + '.adjustments[' + i + ']';
    if (!roundIsRecord(a) || !roundValidTime(a.at) || !Array.isArray(a.previousTasks)) throw roundFail('E_STATE', '路线调整快照不合法', key);
    ['reason', 'evidenceApplicability', 'previousGoal', 'goal', 'modelFingerprint'].forEach(function (field) { roundValidateOpeningText(a[field], key + '.' + field, false); });
    a.previousTasks.forEach(function (task, n) { roundValidateTask(task, key + '.previousTasks[' + n + ']'); });
    if (a.interactionEstimate !== undefined) roundValidateInteractionEstimate(a.interactionEstimate, key + '.interactionEstimate');
    if (a.extraMinutes !== undefined && (typeof a.extraMinutes !== 'number' || !Number.isFinite(a.extraMinutes) || a.extraMinutes < 0)) throw roundFail('E_STATE', '历史补讲估计不合法', key + '.extraMinutes');
    if (a.skippedTaskIds !== undefined && (!Array.isArray(a.skippedTaskIds) || a.skippedTaskIds.some(function (id) { return typeof id !== 'string' || !id.trim(); }))) throw roundFail('E_STATE', '历史跳过身份不合法', key + '.skippedTaskIds');
  });
  if (p.closure !== null) roundValidateClosure(p.closure, path + '.closure');
  p.closureHistory.forEach(function (c, i) { roundValidateClosure(c, path + '.closureHistory[' + i + ']'); });
}

function roundValidateClosure(c, path) {
  if (!roundIsRecord(c) || !roundValidTime(c.at) || ['budget-exhausted', 'goal-achieved', 'learner-stop'].indexOf(c.reason) === -1) throw roundFail('E_STATE', '收尾记录不合法', path);
  ['goal', 'modelFingerprint', 'continuation', 'saveNote', 'evidenceApplicability'].forEach(function (key) { roundValidateOpeningText(c[key], path + '.' + key, false); });
  if (!Array.isArray(c.gaps) || c.gaps.some(function (x) { return typeof x !== 'string' || !x.trim(); })) throw roundFail('E_STATE', '缺口需为文本数组', path + '.gaps');
  ['conceptIds', 'taskIds'].forEach(function (key) {
    if (!Array.isArray(c[key]) || c[key].some(function (id) { return typeof id !== 'string' || !id.trim(); })) throw roundFail('E_STATE', '收尾范围身份需为文本数组', path + '.' + key);
  });
}

function roundValidateInteractionEstimate(value, path) {
  if (value === null) return;
  if (!roundIsRecord(value) || !Number.isInteger(value.min) || !Number.isInteger(value.max) || value.min < 0 || value.max < value.min) throw roundFail('E_STATE', '预计互动范围需要非负 min/max', path);
  roundValidateOpeningText(value.basis, path + '.basis', false);
}

function roundApplyTeachingSkips(round, time) {
  if (!round.progress) return;
  var previous = round.tasks.slice();
  round.tasks = round.tasks.filter(function (t) { return round.progress.skippedTaskIds.indexOf(t.id) === -1; });
  roundArchiveRemoved(round, previous, time, '教学路线显式跳过，历史作答保留；跳过不表示完成');
}

function roundAdjustProgress(target, model, input, previousGoal, previousTasks, time) {
  if (!target.progress) {
    if (input.adjustment !== undefined) throw roundFail('E_CONFLICT', '记录调整前需 progress-start');
    return;
  }
  var p = target.progress, a = input.adjustment;
  if (a !== undefined) {
    if (!roundIsRecord(a) || Object.keys(a).some(function (key) { return ['reason', 'evidenceApplicability', 'extraMinutes', 'interactionEstimate', 'skipTaskIds'].indexOf(key) === -1; })) throw roundFail('E_USAGE', '路线调整字段不合法');
    ['reason', 'evidenceApplicability'].forEach(function (key) { roundValidateOpeningText(a[key], 'adjustment.' + key, false); });
    if (a.extraMinutes !== undefined) p.extraMinutes = a.extraMinutes;
    if (a.interactionEstimate !== undefined) p.interactionEstimate = roundClone(a.interactionEstimate);
    if (a.skipTaskIds !== undefined) {
      if (!Array.isArray(a.skipTaskIds)) throw roundFail('E_USAGE', 'skipTaskIds 必须是任务数组');
      a.skipTaskIds.forEach(function (id) {
        var task = previousTasks.concat(target.tasks).filter(function (t) { return t.id === id && !t.diagnostic; })[0];
        if (!task) throw roundFail('E_USAGE', '只能跳过存在的正式任务：' + id);
        if (p.skippedTaskIds.indexOf(id) === -1) p.skippedTaskIds.push(id);
      });
    }
  }
  roundApplyTeachingSkips(target, time);
  // Every changed plan carries its old scope. Even UI edits with no explanatory
  // record retain an honest unknown applicability rather than re-crediting work.
  if (a || previousGoal !== target.goal || JSON.stringify(previousTasks) !== JSON.stringify(target.tasks)) {
    p.adjustments.push({ at: time, reason: a ? a.reason : '公开路线调整；需导师核对新范围',
      evidenceApplicability: a ? a.evidenceApplicability : '原答保留；对新目标的适用范围尚需核对',
      extraMinutes: p.extraMinutes, interactionEstimate: roundClone(p.interactionEstimate), skippedTaskIds: p.skippedTaskIds.slice(),
      previousGoal: previousGoal, goal: target.goal, previousTasks: roundClone(previousTasks), modelFingerprint: model.modelFingerprint });
    if (a === undefined) p.interactionEstimate = null;
  }
  roundValidateProgress(p, 'progress');
}

function roundApplyProgress(next, model, target, input, time) {
  if (input.action === 'progress-start') {
    if (target.progress) throw roundFail('E_CONFLICT', '本轮已经有计数起点');
    target.progress = roundStartProgress(time, false);
  } else {
    if (!target.progress) throw roundFail('E_CONFLICT', '请先明确计数起点 progress-start');
    var p = target.progress, record = input.record;
    if (!roundIsRecord(record)) throw roundFail('E_USAGE', '需要 --record JSON 对象');
    if (input.action === 'progress-event') {
      if (Object.keys(record).some(function (key) { return ['id', 'kind', 'text', 'sourceNote'].indexOf(key) === -1; })) throw roundFail('E_USAGE', '用户回应只接受 id/kind/text/sourceNote');
      if (ROUND_RESPONSE_KINDS.indexOf(record.kind) === -1) throw roundFail('E_USAGE', '只能记录实际用户回应，导师和工具不计数');
      ['id', 'text', 'sourceNote'].forEach(function (key) { roundValidateOpeningText(record[key], 'record.' + key, false); });
      var existing = p.events.filter(function (e) { return e.id === record.id; })[0];
      if (existing) {
        if (['kind', 'text', 'sourceNote'].some(function (key) { return existing[key] !== record[key]; })) throw roundFail('E_CONFLICT', '同一互动 ID 的内容冲突');
        return { state: next, round: target };
      }
      if (target.status === 'paused') throw roundFail('E_CONFLICT', '本轮已暂停，先恢复再计教学回应');
      if (roundProgressMeasure(target).budgetSignal === 'exhausted') throw roundFail('E_CONFLICT', '已达到预算上限，请先调整预算');
      if (roundClosureCurrent(next, model, target)) throw roundFail('E_CONFLICT', '本轮教学已收尾，请先调整路线与预算');
      p.events.push({ id: record.id, kind: record.kind, text: record.text, sourceNote: record.sourceNote, at: time });
      if (roundProgressMeasure(target).budgetSignal === 'exhausted') p.closure = roundProgressClosure(target, model, 'budget-exhausted', {}, time);
    } else if (input.action === 'progress-time') {
      if (Object.keys(record).some(function (key) { return ['id', 'start', 'end', 'sourceNote'].indexOf(key) === -1; })) throw roundFail('E_USAGE', '时间记录只接受 id/start/end/sourceNote');
      var savedInterval = p.intervals.filter(function (e) { return e.id === record.id; })[0];
      if (savedInterval) {
        if (['start', 'end', 'sourceNote'].some(function (key) { return savedInterval[key] !== record[key]; })) throw roundFail('E_CONFLICT', '同一时间记录 ID 内容冲突');
        return { state: next, round: target };
      }
      if (new Date(record.end) > new Date(time)) throw roundFail('E_USAGE', '不能记录未来时间消耗');
      if (roundClosureCurrent(next, model, target)) throw roundFail('E_CONFLICT', '本轮教学已收尾');
      p.intervals.push(roundClone(record));
      roundValidateProgress(p, 'progress');
      if (roundProgressMeasure(target).budgetSignal === 'exhausted') p.closure = roundProgressClosure(target, model, 'budget-exhausted', {}, time);
    } else if (input.action === 'close') {
      if (Object.keys(record).some(function (key) { return ['reason', 'gaps', 'continuation', 'saveNote', 'evidenceApplicability'].indexOf(key) === -1; })) throw roundFail('E_USAGE', '收尾输入字段不合法');
      if (['budget-exhausted', 'goal-achieved', 'learner-stop'].indexOf(record.reason) === -1) throw roundFail('E_USAGE', '收尾原因不合法');
      ['continuation', 'saveNote', 'evidenceApplicability'].forEach(function (key) { roundValidateOpeningText(record[key], 'record.' + key, false); });
      if (!Array.isArray(record.gaps)) throw roundFail('E_USAGE', '收尾必须明确缺口数组');
      if (record.reason === 'budget-exhausted' && roundProgressMeasure(target).budgetSignal !== 'exhausted') throw roundFail('E_CONFLICT', '记录量尚未达到预算，不能宣称耗尽');
      if (record.reason === 'goal-achieved') {
        if (!roundGoalEvidenceSufficient(next, model, target)) throw roundFail('E_CONFLICT', '目标缺少当前独立导师证据，不能提前宣布达成');
      }
      if (p.closure) p.closureHistory.push(roundClone(p.closure));
      p.closure = roundProgressClosure(target, model, record.reason, record, time);
    } else throw roundFail('E_USAGE', '进度操作不合法');
  }
  roundValidateProgress(target.progress, 'progress');
  target.updatedAt = time;
  next.updatedAt = time;
  next.revision += 1;
  return { state: next, round: target };
}

function roundValidateRecord(round, key) {
  var path = 'learningRounds.' + key;
  if (!roundIsRecord(round)) throw roundFail('E_STATE', '轮次必须是对象', path);
  if (round.id !== key) throw roundFail('E_STATE', '轮次 id 与键不一致：' + JSON.stringify(round.id) + ' ≠ ' + JSON.stringify(key), path + '.id');
  if (ROUND_ENTRIES.indexOf(round.entry) === -1) throw roundFail('E_STATE', '轮次 entry 不合法：' + JSON.stringify(round.entry), path + '.entry');
  if (typeof round.goal !== 'string' || round.goal.trim() === '') throw roundFail('E_STATE', '轮次 goal 必填且非空', path + '.goal');
  if (!Array.isArray(round.conceptIds) || round.conceptIds.some(function (id) { return typeof id !== 'string' || id === ''; })) {
    throw roundFail('E_STATE', '轮次 conceptIds 必须是字符串数组', path + '.conceptIds');
  }
  if (round.budgetMinutes !== null && round.budgetMinutes !== undefined &&
      (!Number.isInteger(round.budgetMinutes) || round.budgetMinutes <= 0)) {
    throw roundFail('E_STATE', '轮次 budgetMinutes 必须是正整数或 null', path + '.budgetMinutes');
  }
  if (ROUND_STATUSES.indexOf(round.status) === -1) throw roundFail('E_STATE', '轮次 status 不合法：' + JSON.stringify(round.status), path + '.status');
  if (round.resumeStatus !== undefined && round.resumeStatus !== null &&
      round.resumeStatus !== 'diagnosing' && round.resumeStatus !== 'active' && round.resumeStatus !== 'completed') {
    throw roundFail('E_STATE', '轮次 resumeStatus 只能是 diagnosing/active/completed 或省略', path + '.resumeStatus');
  }
  if (round.currentTaskId !== null && round.currentTaskId !== undefined && typeof round.currentTaskId !== 'string') {
    throw roundFail('E_STATE', '轮次 currentTaskId 必须是字符串或 null', path + '.currentTaskId');
  }
  if (!Array.isArray(round.tasks)) throw roundFail('E_STATE', '轮次 tasks 必须是数组', path + '.tasks');
  for (var i = 0; i < round.tasks.length; i += 1) roundValidateTask(round.tasks[i], path + '.tasks[' + i + ']');
  if (round.archivedTasks !== undefined) {
    if (!Array.isArray(round.archivedTasks)) throw roundFail('E_STATE', '轮次 archivedTasks 必须是数组', path + '.archivedTasks');
    for (var j = 0; j < round.archivedTasks.length; j += 1) roundValidateTask(round.archivedTasks[j], path + '.archivedTasks[' + j + ']');
  }
  if (round.history !== undefined && !Array.isArray(round.history)) throw roundFail('E_STATE', '轮次 history 必须是数组', path + '.history');
  if (round.reviewPlan !== undefined) roundValidateReviewPlan(round.reviewPlan, path + '.reviewPlan');
  if (round.opening !== undefined) roundValidateOpening(round.opening, path + '.opening');
  if (round.progress !== undefined) roundValidateProgress(round.progress, path + '.progress');
}

/**
 * Validate the optional `learningRounds` bucket and `activeRoundId` pointer of
 * a raw or normalized archive. Legacy archives without either field are valid.
 * Used by the backend archive validation and the standalone viewer's loader.
 */
export function validateRounds(raw, model) {
  if (raw === undefined || raw === null) return true;
  if (!roundIsRecord(raw)) throw roundFail('E_STATE', '状态必须是对象');
  var rounds = raw.learningRounds;
  if (rounds === undefined || rounds === null) rounds = {};
  if (!roundIsRecord(rounds)) throw roundFail('E_STATE', 'learningRounds 必须是对象');
  Object.keys(rounds).forEach(function (key) { roundValidateRecord(rounds[key], key); });
  var active = raw.activeRoundId;
  if (active !== undefined && active !== null && active !== '') {
    if (typeof active !== 'string') throw roundFail('E_STATE', 'activeRoundId 必须是字符串或空');
    if (!Object.prototype.hasOwnProperty.call(rounds, active)) throw roundFail('E_STATE', 'activeRoundId 指向不存在的轮次：' + active);
  }
  return true;
}

// Resolve a round + task and confirm the task really belongs to the prompt and
// concept being written. This is the *identity* layer: it must hold for a new
// write and for an idempotent retry of an already-recorded answer, so it never
// consults content freshness or round status. It also finds a task that was
// archived when the route changed, so a replay stays resolvable.
export function roundResolveBinding(state, model, input) {
  var roundId = input ? input.roundId : undefined;
  var taskId = input ? input.taskId : undefined;
  var hasRound = roundId !== undefined && roundId !== null && roundId !== '';
  var hasTask = taskId !== undefined && taskId !== null && taskId !== '';
  if (!hasRound && !hasTask) return null;
  if (!hasRound) throw roundFail('E_USAGE', '任务 id 必须与轮次 id 一起提供');
  if (typeof roundId !== 'string' || !ROUND_ID_RE.test(roundId)) throw roundFail('E_USAGE', '轮次 id 不合法：' + JSON.stringify(roundId));
  var rounds = (state && state.learningRounds) || {};
  var round = Object.prototype.hasOwnProperty.call(rounds, roundId) ? rounds[roundId] : null;
  if (!round) throw roundFail('E_CONFLICT', '轮次不存在：' + roundId);
  var wanted = hasTask ? String(taskId) : round.currentTaskId;
  if (!wanted) throw roundFail('E_CONFLICT', '本轮没有可定位的任务');
  var task = (round.tasks || []).filter(function (item) { return item.id === wanted; })[0] ||
    (round.archivedTasks || []).filter(function (item) { return item.id === wanted; })[0];
  if (!task) throw roundFail('E_CONFLICT', '任务不存在：' + wanted);
  // The task must be about the very prompt/concept in this write; otherwise an
  // answer to an unrelated prompt could be filed under a real task.
  if (input && input.promptId !== undefined && input.promptId !== null && input.promptId !== '') {
    if (!task.promptId || task.promptId !== input.promptId) {
      throw roundFail('E_CONFLICT', '任务与作答问题不一致：任务 ' + task.id + ' 对应 ' + JSON.stringify(task.promptId || null));
    }
    // `roundPromptRecord` resolves author prompts *and* learner questions, so an
    // own-question answer is checked against the concept the question really
    // belongs to instead of skipping the check because it is not in the model.
    var info = roundPromptRecord(model, state, input.promptId);
    var promptConceptId = info ? info.conceptId : (input.conceptId !== undefined ? input.conceptId : undefined);
    if (promptConceptId !== undefined && promptConceptId !== null && promptConceptId !== task.conceptId) {
      throw roundFail('E_CONFLICT', '任务与作答概念不一致：任务 ' + task.id + ' 属于概念 ' + task.conceptId);
    }
  }
  return { round: round, task: task };
}

/**
 * Structural binding check that is safe for any write (including draft saves
 * and idempotent retries). Returns `{}` for unbound work, `{roundId, taskId}`
 * once a real round + task is named, and throws when the binding is invalid or
 * the task is for a different prompt/concept.
 */
export function validateRoundBinding(state, model, input) {
  // Draft saves may be prepared while paused and may lag a content update; they
  // are not evidence, so only the structural identity is enforced here.
  if (input && input.type === 'practice') {
    var draftBound = roundResolveBinding(state, model, input);
    return draftBound ? { roundId: draftBound.round.id, taskId: draftBound.task.id } : {};
  }
  var resolved = roundResolveBinding(state, model, input);
  if (!resolved) return {};
  roundAssertTaskCurrent(state, resolved.round, resolved.task, model);
  return { roundId: resolved.round.id, taskId: resolved.task.id };
}

// Reject a new (non-retry) write to a task whose content changed, a paused
// round, a diagnosing route that has not been confirmed yet, or a task that was
// moved out of the active route. An archived task stays resolvable for an
// idempotent replay, but it is read-only history for any new work. Membership
// in `round.tasks` is authoritative: an older archive row may legitimately lack
// the optional `excluded` flag, so the check never relies on that metadata.
function roundAssertTaskCurrent(state, round, task, model) {
  if (round.progress && (roundClosureCurrent(state, model, round) || roundProgressMeasure(round).budgetSignal === 'exhausted')) {
    throw roundFail('E_CONFLICT', '本轮教学已收尾或达到预算上限，请先重新安排目标与预算');
  }
  var activeMember = (round.tasks || []).some(function (item) { return item.id === task.id; });
  if (!activeMember) {
    throw roundFail('E_CONFLICT', '任务已移出本轮活动路线，只能查看历史作答：' + task.id);
  }
  // A deferred task is planned for a later session, not this one: new work on it
  // is refused (its draft and any earlier recorded answer stay valid). Raising
  // the budget is what opens it again.
  if (task.deferred) {
    throw roundFail('E_CONFLICT', '该任务已暂缓（预算不足或留待下次续接），请先调整预算再作答：' + task.id);
  }
  // Resolve through the shared prompt record: author prompts must still exist
  // and match their live fingerprint, while a learner question must still exist
  // on a live concept and match its recomputed question fingerprint. Neither
  // path grants tutor mastery; this is only the current-content write gate.
  var info = roundPromptRecord(model, state, task.promptId);
  if (!info) throw roundFail('E_CONFLICT', '任务对应的问题已不在当前内容中：' + task.id);
  var current = info.currentFingerprint;
  if (!current) throw roundFail('E_CONFLICT', '任务对应的问题已不在当前内容中：' + task.id);
  if (task.fingerprint && task.fingerprint !== current) {
    throw roundFail('E_CONFLICT', '任务内容已更新，请先调整本轮路线再作答：' + task.id);
  }
  if (round.status === 'paused') throw roundFail('E_CONFLICT', '本轮已暂停，请先继续本轮再提交新的作答');
  if (round.status === 'diagnosing' && task.diagnostic !== true) {
    throw roundFail('E_CONFLICT', '诊断未确认前只能先提交诊断任务');
  }
}

/**
 * A binding that may accept new real work. Kept as an explicit name for the
 * non-retry write path; it enforces content freshness, rejects a paused round,
 * and gates unconfirmed diagnostics. Legacy (unbound) work is allowed.
 */
export function roundAssertSubmittable(state, model, input) {
  var binding = validateRoundBinding(state, model, input);
  return binding;
}

/**
 * Recompute a round's completion status after a durable submission lands.
 * Mutates the round inside the caller-owned state clone; returns true when the
 * status changed so the caller can record it.
 */
export function roundWithProgress(state, model, roundId, at) {
  var rounds = (state && state.learningRounds) || {};
  var round = rounds[roundId];
  if (!round) return false;
  var changed = roundRefreshCompletion(state, model, round);
  if (changed) round.updatedAt = at || round.updatedAt;
  return changed;
}

/**
 * Pure read model for the page and the `round-read` command. Returns null when
 * no round matches (no active round either). Each task reports the live content
 * status, whether a *current* submission exists, and archived (excluded) tasks
 * stay visible with their original ids instead of disappearing.
 */
export function roundView(state, model, roundId) {
  var rounds = (state && state.learningRounds) || {};
  var id = roundId !== undefined && roundId !== null ? roundId : (state && state.activeRoundId);
  var round = id ? rounds[id] : null;
  if (!round) return null;

  function describe(task, excluded) {
    var concept = roundConceptById(model, task.conceptId);
    // Resolve through the shared record so a learner question is recognized as
    // current content instead of being reported as a deleted model prompt.
    var info = task.promptId ? roundPromptRecord(model, state, task.promptId) : null;
    var prompt = info && info.origin === 'model' ? info.prompt : null;
    var currentFingerprint = info ? info.currentFingerprint : null;
    var currentSubmissions = roundCurrentSubmissions(state, model, round, task);
    var staleSubmissions = roundStaleSubmissions(state, model, round, task);
    return {
      id: task.id,
      conceptId: task.conceptId,
      conceptTitle: concept ? concept.title : null,
      promptId: task.promptId || null,
      promptKind: info ? info.kind : null,
      fingerprint: task.fingerprint || null,
      currentFingerprint: currentFingerprint,
      reason: task.reason,
      teachingPurpose: task.teachingPurpose || null,
      estimatedMinutes: task.estimatedMinutes,
      completionCriteria: Array.isArray(task.completionCriteria) ? task.completionCriteria.slice() : [],
      authorCriteria: Array.isArray(task.authorCriteria) ? task.authorCriteria.slice() : [],
      reviewPlanned: Boolean(task.reviewPlanned),
      reviewSource: task.reviewSource || null,
      dueAt: task.dueAt || null,
      assessmentSource: task.assessmentSource || null,
      reviewAttemptId: task.attemptId || null,
      pendingAssessmentAt: task.pendingAssessmentAt || null,
      origin: task.origin || (info ? info.origin : 'model'),
      deferred: Boolean(task.deferred),
      deferredReason: task.deferredReason || null,
      diagnostic: Boolean(task.diagnostic),
      prerequisites: Array.isArray(task.prerequisites) ? task.prerequisites.slice() : [],
      conceptDeleted: !concept,
      promptDeleted: Boolean(task.promptId && !info),
      contentUpdated: Boolean(task.fingerprint && currentFingerprint && task.fingerprint !== currentFingerprint),
      submitted: currentSubmissions.length > 0,
      activeSubmissions: currentSubmissions.length,
      staleSubmissions: staleSubmissions.length,
      submissions: roundBoundAttempts(state, round.id, task.id).length,
      excluded: Boolean(excluded),
      active: !excluded,
      archivedReason: excluded ? (task.archivedReason || null) : null,
    };
  }

  // `tasks` is the active route only: the page loops it as scheduled work.
  // Removed tasks are retained in `archivedTasks` (aliased `excludedTasks`) with
  // their original ids and submissions, flagged `excluded: true`, so early work
  // stays visible without being counted or rendered as an active step.
  var routeTasks = (round.tasks || []).map(function (task) { return describe(task, false); });
  // A stable task id can be archived and later return to the active route (for
  // example, retarget away and back). The archive keeps that history on disk,
  // but the read model must not present the same id as both active and excluded:
  // an active id wins and its stale archive row is filtered out of the view.
  var activeIds = roundNullMap();
  routeTasks.forEach(function (task) { activeIds[task.id] = true; });
  var excludedTasks = (round.archivedTasks || [])
    .filter(function (task) { return !activeIds[task.id]; })
    .map(function (task) { return describe(task, true); });
  var tasks = routeTasks;
  // Status is derived for reads: a stored `completed` round whose content moved
  // reads as `active` again because its work is no longer current. `storedStatus`
  // preserves the persisted value so history is never rewritten.
  var effectiveStatus = roundEffectiveStatus(state, model, round);
  // The formal route — everything but the diagnostic probe — is the taught
  // sequence that drives remaining work and completion. A submitted diagnostic
  // is a finished step and can never make the round read as complete on its own.
  var formalTasks = routeTasks.filter(function (task) { return !task.diagnostic; });
  var formalOpenTasks = formalTasks.filter(function (task) { return !task.deferred; });
  // A paused round reads with the status it will restore, so a paused
  // budget-insufficient plan still surfaces the honest "waiting for time" signal.
  var displayStatus = effectiveStatus === 'paused' ? (round.resumeStatus || 'active') : effectiveStatus;
  // A set budget with no open formal task is a budget-insufficient plan: nothing
  // can be worked this session until the budget grows. The first formal task is
  // the one that must fit.
  var budgetInsufficient = displayStatus === 'active' &&
    round.budgetMinutes !== null && round.budgetMinutes !== undefined &&
    formalTasks.length > 0 && formalTasks.every(function (task) { return task.deferred; });
  var requiredMinutes = budgetInsufficient ? formalTasks[0].estimatedMinutes : null;
  // The current position is derived from the same effective route selection so
  // the view never points at a deferred task or a completed diagnostic step.
  var submitted = roundSubmittedSet(state, model, round, formalOpenTasks);
  var currentTaskId = roundSelectCurrent(round.tasks || [], round, true, submitted);
  return {
    roundId: round.id,
    id: round.id,
    entry: round.entry,
    goal: round.goal,
    conceptIds: (round.conceptIds || []).slice(),
    budgetMinutes: round.budgetMinutes === undefined ? null : round.budgetMinutes,
    opening: roundOpeningView(round, model),
    progress: roundProgressView(state, model, round, tasks, currentTaskId),
    status: effectiveStatus,
    storedStatus: round.status,
    resumeStatus: round.resumeStatus || null,
    currentTaskId: currentTaskId,
    tasks: tasks,
    archivedTasks: excludedTasks,
    excludedTasks: excludedTasks,
    remainingTasks: formalOpenTasks.filter(function (task) { return !task.submitted; }).length,
    deferredTasks: routeTasks.filter(function (task) { return task.deferred; }).length,
    submittedTasks: formalTasks.filter(function (task) { return task.submitted; }).length,
    excludedCount: excludedTasks.length,
    allSubmitted: formalOpenTasks.length > 0 && formalOpenTasks.every(function (task) { return task.submitted; }),
    diagnosticSubmitted: routeTasks.some(function (task) { return task.diagnostic && task.submitted; }),
    budgetInsufficient: budgetInsufficient,
    requiredMinutes: requiredMinutes,
    // A learning round is a routed sequence for a real goal; it is never the
    // artifact-only path (that path leaves no round at all).
    artifactOnly: false,
    createdAt: round.createdAt || null,
    updatedAt: round.updatedAt || null,
    reviewPlan: round.reviewPlan && roundIsRecord(round.reviewPlan) ? roundClone(round.reviewPlan) : null,
    history: Array.isArray(round.history) ? round.history.slice() : [],
  };
}

function roundReviewTaskFromCandidate(state, model, round, prerequisiteTo, candidate, deferred) {
  var info = candidate.promptId ? roundPromptRecord(model, state, candidate.promptId) : null;
  var prompt = info ? info.prompt : null;
  var prerequisites = (roundHasOwn(prerequisiteTo, candidate.conceptId) ? prerequisiteTo[candidate.conceptId] : [])
    .filter(function (id) { return Boolean(roundConceptById(model, id)); });
  var task = {
    id: roundTaskId(round.id, candidate.conceptId, candidate.promptId || null),
    conceptId: candidate.conceptId,
    promptId: candidate.promptId || null,
    // Own questions carry their recomputed fingerprint too, so a later edit of
    // the question text makes this task and its earlier answers stale instead
    // of pretending they still match the current content.
    fingerprint: info ? info.currentFingerprint : null,
    reason: candidate.reason,
    teachingPurpose: prompt ? roundPromptPurpose(prompt) : null,
    estimatedMinutes: candidate.estimatedMinutes,
    completionCriteria: roundTaskCriteria(prompt),
    authorCriteria: roundAuthorCriteria(prompt),
    prerequisites: prerequisites,
    target: Boolean(round.conceptIds && round.conceptIds.indexOf(candidate.conceptId) !== -1),
    deferred: Boolean(deferred),
    deferredReason: deferred ? (candidate.deferredReason || '暂缓续接；暂缓不表示完成或忘记') : null,
    diagnostic: false,
    reviewPlanned: true,
    reviewSource: candidate.priorityKind || candidate.source || null,
    dueAt: candidate.dueAt || null,
    dueNow: Boolean(candidate.dueNow),
    assessmentSource: candidate.assessmentSource || null,
    attemptId: candidate.attemptId || null,
    pendingAssessmentAt: candidate.pendingAssessmentAt || null,
    origin: candidate.origin || 'model',
    actionable: candidate.actionable !== false,
    unresolved: candidate.actionable === false,
  };
  return task;
}

// Apply a pure plan to the persisted round route. This is the only path that
// replaces the route from a review plan; it writes tasks and plan metadata but
// never an attempt, rating, schedule or completion flag.
function roundApplyReviewPlanTasks(state, model, round, plan, time, previousTasks) {
  var prerequisiteTo = roundPrerequisiteMap(model, state);
  var keptDiagnostics = (round.tasks || []).filter(function (task) { return task && task.diagnostic; });
  var selectedTasks = plan.selected.map(function (candidate) {
    return roundReviewTaskFromCandidate(state, model, round, prerequisiteTo, candidate, false);
  });
  var deferredTasks = plan.deferred.map(function (candidate) {
    return roundReviewTaskFromCandidate(state, model, round, prerequisiteTo, candidate, true);
  });
  round.tasks = keptDiagnostics.concat(selectedTasks, deferredTasks);
  roundApplyTeachingSkips(round, time);
  roundArchiveRemoved(round, previousTasks || [], time, '复习计划调整后不再处于活动路线，历史作答已保留');
  round.reviewPlan = roundReviewPlanRecord(plan);
  if (round.status === 'completed') round.status = 'active';
  else if (round.status === 'paused' && round.resumeStatus === 'completed' && plan.selected.length > 0) round.resumeStatus = 'active';
  var submitted = roundSubmittedSet(state, model, round, round.tasks);
  round.currentTaskId = roundSelectCurrent(round.tasks, round, true, submitted);
}

/**
 * Apply one public round operation. Returns a new state plus the resulting
 * round; the caller owns validation, persistence and locking. create/update
 * persist the goal, budget, ordered tasks, reasons, criteria, pause position
 * and an append-only revision history. Entries: learn-new-topic starts in
 * `diagnosing` and gates the route behind a real diagnostic answer plus an
 * explicit confirm-diagnosis; organize-existing-material opens the route
 * directly. `resume` continues an existing round rather than creating one.
 */
export function applyRound(state, model, input, at) {
  if (!roundIsRecord(input)) throw roundFail('E_USAGE', '轮次操作必须是对象');
  var action = input.action;
  if (input.opening !== undefined && action !== 'create' && action !== 'update') {
    throw roundFail('E_USAGE', '开场记录只可随 create/update 保存');
  }
  if (input.trackProgress !== undefined && (action !== 'create' || input.trackProgress !== true)) throw roundFail('E_USAGE', 'trackProgress 只接受 create 的 true');
  if (input.adjustment !== undefined && action !== 'update') throw roundFail('E_USAGE', 'adjustment 只接受 update');
  if (input.record !== undefined && ['progress-start', 'progress-event', 'progress-time', 'close'].indexOf(action) === -1) throw roundFail('E_USAGE', 'record 只接受进度与收尾操作');
  if (ROUND_ACTIONS.indexOf(action) === -1) throw roundFail('E_USAGE', '轮次操作只能是 ' + ROUND_ACTIONS.join('/') + '，收到 ' + JSON.stringify(action));
  var time = at || new Date().toISOString();
  if (!roundValidTime(time)) throw roundFail('E_USAGE', '时间格式不合法：' + time);
  var next = roundClone(state);
  if (!roundIsRecord(next.learningRounds)) next.learningRounds = {};
  if (next.activeRoundId === undefined) next.activeRoundId = null;
  if (!Number.isInteger(next.revision) || next.revision < 0) next.revision = 0;
  var rounds = next.learningRounds;

  function resolveRoundId() {
    if (input.roundId !== undefined && input.roundId !== null && input.roundId !== '') return roundAssertRoundId(String(input.roundId));
    if (next.activeRoundId) return next.activeRoundId;
    throw roundFail('E_USAGE', '该操作需要 --round-id 或一个当前轮次');
  }

  if (action === 'create') {
    var goal = roundAssertGoal(input.goal);
    // `resume` is not a fresh entry: it continues an existing round. Creating a
    // new round with it would hand out an unconfirmed route, so it is refused.
    var entry = roundAssertEntry(input.entry || 'organize-existing-material', ROUND_ENTRY_FOR_CREATE);
    var roundId = input.roundId !== undefined && input.roundId !== null && input.roundId !== ''
      ? roundAssertRoundId(String(input.roundId))
      : 'round-' + roundHash(time + '|' + goal);
    if (Object.prototype.hasOwnProperty.call(rounds, roundId)) {
      throw roundFail('E_CONFLICT', '已存在同名轮次：' + roundId + '；请换一个 id 或改用 update');
    }
    var conceptIds = roundNormalizeConceptIds(model, input.conceptIds !== undefined ? input.conceptIds : (input.conceptId ? [input.conceptId] : []));
    var budgetMinutes = roundAssertBudget(input.budgetMinutes !== undefined ? input.budgetMinutes : input.minutes);
    var created = {
      id: roundId,
      entry: entry,
      goal: goal,
      conceptIds: conceptIds,
      budgetMinutes: budgetMinutes,
      status: entry === 'learn-new-topic' ? 'diagnosing' : 'active',
      resumeStatus: null,
      currentTaskId: null,
      tasks: [],
      archivedTasks: [],
      history: [],
      createdAt: time,
      updatedAt: time,
    };
    created.tasks = roundComposeTasks(next, model, created, time);
    var submitted = roundSubmittedSet(next, model, created, created.tasks);
    created.currentTaskId = roundSelectCurrent(created.tasks, created, false, submitted);
    created.history.push({
      at: time, action: 'create', entry: entry, goal: goal, budgetMinutes: budgetMinutes,
      conceptIds: conceptIds.slice(), status: created.status, taskCount: created.tasks.length,
    });
    rounds[roundId] = created;
    next.activeRoundId = roundId;
    next.revision += 1;
    next.updatedAt = time;
    roundRefreshOpening(created, model, input.opening, time);
    if (input.trackProgress === true) created.progress = roundStartProgress(time, true);
    return { state: next, round: created };
  }

  var targetId = resolveRoundId();
  var target = Object.prototype.hasOwnProperty.call(rounds, targetId) ? rounds[targetId] : null;
  if (!target) throw roundFail('E_STATE', '轮次不存在：' + targetId);
  if (['progress-start', 'progress-event', 'progress-time', 'close'].indexOf(action) !== -1) return roundApplyProgress(next, model, target, input, time);
  if (!Array.isArray(target.archivedTasks)) target.archivedTasks = [];
  roundRefreshCompletion(next, model, target);

  if (action === 'review-plan') {
    if (roundEffectiveStatusOf(target) === 'diagnosing') {
      throw roundFail('E_CONFLICT', '诊断未确认前不能应用复习计划，请先提交真实诊断并确认');
    }
    if (input.clearFocus === true && input.focusPromptIds !== undefined) {
      throw roundFail('E_USAGE', '--clear-focus 不能与 --focus-prompt 同时使用');
    }
    var previousReviewTasks = (target.tasks || []).slice();
    var focusPromptIds;
    if (input.clearFocus === true) focusPromptIds = [];
    else if (input.focusPromptIds !== undefined) focusPromptIds = input.focusPromptIds;
    else focusPromptIds = target.reviewPlan && Array.isArray(target.reviewPlan.focusPromptIds)
      ? target.reviewPlan.focusPromptIds.slice()
      : [];
    if (input.budgetMinutes !== undefined || input.minutes !== undefined) {
      target.budgetMinutes = roundAssertBudget(input.budgetMinutes !== undefined ? input.budgetMinutes : input.minutes);
    }
    var reviewPlan = roundReviewPlan(next, model, {
      roundId: target.id,
      budgetMinutes: target.budgetMinutes,
      focusPromptIds: focusPromptIds,
    }, time);
    roundApplyReviewPlanTasks(next, model, target, reviewPlan, time, previousReviewTasks);
    target.updatedAt = time;
    target.history.push({
      at: time,
      action: 'review-plan',
      budgetMinutes: target.budgetMinutes,
      focusPromptIds: reviewPlan.focusPromptIds.slice(),
      selectedPromptIds: reviewPlan.selected.map(function (candidate) { return candidate.promptId; }),
      deferredPromptIds: reviewPlan.deferred.map(function (candidate) { return candidate.promptId; }),
      estimatedMinutes: reviewPlan.estimatedMinutes,
      dueCount: reviewPlan.dueCount,
    });
    next.activeRoundId = target.id;
    next.revision += 1;
    next.updatedAt = time;
    roundRefreshOpening(target, model, undefined, time);
    return { state: next, round: target };
  }

  if (action === 'update') {
    var previousGoal = target.goal;
    var previousTasks = (target.tasks || []).slice();
    var budgetChanged = input.budgetMinutes !== undefined || input.minutes !== undefined;
    var conceptsChanged = input.conceptIds !== undefined || input.conceptId !== undefined;
    if (input.goal !== undefined) target.goal = roundAssertGoal(input.goal);
    // The entry is the round's origin, not an editable goal/budget field. An
    // update may repeat the existing entry but may never switch it: changing an
    // active route into a new topic without a diagnostic, or flipping a
    // diagnosing round to materials to bypass the gate, must be refused.
    if (input.entry !== undefined) {
      var requestedEntry = roundAssertEntry(input.entry);
      if (requestedEntry !== target.entry) {
        throw roundFail('E_CONFLICT', '学习入口在创建后不可更改（当前 ' + target.entry + '，请求 ' + requestedEntry + '）；如需更换入口请另开一轮');
      }
    }
    if (conceptsChanged) {
      target.conceptIds = roundNormalizeConceptIds(model, input.conceptIds !== undefined ? input.conceptIds : [input.conceptId]);
    }
    if (budgetChanged) {
      target.budgetMinutes = roundAssertBudget(input.budgetMinutes !== undefined ? input.budgetMinutes : input.minutes);
    }
    if (target.reviewPlan) {
      // A saved review route only changes through an explicit review-plan
      // action or an explicit budget/concept edit. A goal-only edit preserves
      // the current planned tasks instead of silently replanning from new
      // evidence.
      if (budgetChanged || conceptsChanged) {
        var savedFocus = Array.isArray(target.reviewPlan.focusPromptIds) ? target.reviewPlan.focusPromptIds.slice() : [];
        var updatedPlan = roundReviewPlan(next, model, {
          roundId: target.id,
          budgetMinutes: target.budgetMinutes,
          focusPromptIds: savedFocus,
        }, time);
        roundApplyReviewPlanTasks(next, model, target, updatedPlan, time, previousTasks);
      }
    } else {
      target.tasks = roundComposeTasks(next, model, target, time);
      // Any task that left the route is archived, keeping its original id and
      // submissions readable instead of deleting the learner's work.
      roundArchiveRemoved(target, previousTasks, time, '本轮调整后不再处于活动路线，历史作答已保留');
      var updateSubmitted = roundSubmittedSet(next, model, target, target.tasks);
      var openRemaining = target.tasks.filter(function (task) { return !task.deferred && !updateSubmitted[task.id]; });
      if (target.status === 'completed') {
        // A stale completion with new remaining work returns to active.
        if (openRemaining.length > 0) target.status = 'active';
      } else if (target.status === 'paused' && target.resumeStatus === 'completed' && openRemaining.length > 0) {
        // The learner only edited the paused round; keep it paused, but remember
        // that resuming must reopen real work instead of restoring a false
        // completion.
        target.resumeStatus = 'active';
      }
    }
    target.updatedAt = time;
    target.history.push({
      at: time, action: 'update', goal: target.goal, budgetMinutes: target.budgetMinutes,
      conceptIds: target.conceptIds.slice(), status: target.status, taskCount: target.tasks.length,
    });
    next.activeRoundId = target.id;
    next.revision += 1;
    next.updatedAt = time;
    roundAdjustProgress(target, model, input, previousGoal, previousTasks, time);
    target.currentTaskId = roundSelectCurrent(target.tasks, target, true, roundSubmittedSet(next, model, target, target.tasks));
    roundRefreshOpening(target, model, input.opening, time);
    if (target.progress) {
      var measure = roundProgressMeasure(target);
      if (target.progress.closure && target.progress.closure.reason === 'budget-exhausted' && measure.budgetSignal !== 'exhausted') {
        target.progress.closureHistory.push(roundClone(target.progress.closure));
        target.progress.closure = null;
      }
      if (measure.budgetSignal === 'exhausted' && !target.progress.closure) target.progress.closure = roundProgressClosure(target, model, 'budget-exhausted', {}, time);
    }
    return { state: next, round: target };
  }

  if (action === 'pause') {
    // Remember what to restore: pausing a diagnosing or completed round must not
    // silently promote it to an active route on resume.
    if (target.status !== 'paused') {
      target.resumeStatus = target.status;
      target.status = 'paused';
    }
    target.updatedAt = time;
    target.history.push({ at: time, action: 'pause', resumeStatus: target.resumeStatus, currentTaskId: target.currentTaskId });
    next.activeRoundId = target.id;
    next.revision += 1;
    next.updatedAt = time;
    return { state: next, round: target };
  }

  if (action === 'resume') {
    next.activeRoundId = target.id;
    if (target.status === 'paused') {
      // Restore the pre-pause status: a paused-and-resumed diagnosing round goes
      // back to diagnosing (still gated), and a completed round stays completed.
      var restored = target.resumeStatus || 'active';
      // A completed round must re-open if a content update (or a budget change
      // applied while paused) left real remaining work, instead of resuming into
      // a false completion.
      if (restored === 'completed') {
        var remaining = target.tasks.filter(function (task) { return !task.deferred; });
        var stillSubmitted = roundSubmittedSet(next, model, target, remaining);
        if (!remaining.every(function (task) { return stillSubmitted[task.id]; })) restored = 'active';
      }
      target.status = restored;
      target.resumeStatus = null;
    }
    target.updatedAt = time;
    target.history.push({ at: time, action: 'resume', status: target.status, currentTaskId: target.currentTaskId });
    next.revision += 1;
    next.updatedAt = time;
    return { state: next, round: target };
  }

  if (action === 'focus') {
    var taskId = input.taskId;
    if (typeof taskId !== 'string' || taskId === '') throw roundFail('E_USAGE', 'focus 需要 --task-id');
    var task = (target.tasks || []).filter(function (item) { return item.id === taskId; })[0];
    if (!task) throw roundFail('E_STATE', '任务不存在：' + taskId);
    // A deferred task is not this session's work (budget/next-session), so it is
    // never a valid current position. Browsing a paused round's open task stays
    // allowed.
    if (task.deferred) throw roundFail('E_CONFLICT', '该任务已暂缓（预算不足或留待下次续接），不能作为当前位置：' + task.id);
    target.currentTaskId = task.id;
    target.updatedAt = time;
    target.history.push({ at: time, action: 'focus', taskId: task.id });
    next.activeRoundId = target.id;
    next.revision += 1;
    next.updatedAt = time;
    return { state: next, round: target };
  }

  // confirm-diagnosis
  if (target.status !== 'diagnosing') throw roundFail('E_CONFLICT', '本轮不在诊断等待状态，无需确认');
  var diagnostic = (target.tasks || []).filter(function (item) { return item.diagnostic; })[0];
  if (!diagnostic) throw roundFail('E_STATE', '本轮缺少诊断任务');
  // Only a *current* real diagnostic submission opens the route.
  var realSubmissions = roundCurrentSubmissions(next, model, target, diagnostic);
  if (realSubmissions.length === 0) throw roundFail('E_CONFLICT', '请先提交诊断任务的真实作答，再确认诊断');
  target.status = 'active';
  target.tasks = roundComposeTasks(next, model, target, time);
  roundApplyTeachingSkips(target, time);
  var confirmedSubmitted = roundSubmittedSet(next, model, target, target.tasks);
  target.currentTaskId = roundSelectCurrent(target.tasks, target, false, confirmedSubmitted);
  target.updatedAt = time;
  target.history.push({
    at: time, action: 'confirm-diagnosis', status: target.status,
    submittedAttemptIds: realSubmissions.map(function (attempt) { return attempt.id; }),
  });
  roundRefreshOpening(target, model, undefined, time);
  next.activeRoundId = target.id;
  next.revision += 1;
  next.updatedAt = time;
  return { state: next, round: target };
}
