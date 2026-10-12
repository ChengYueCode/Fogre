import { randomUUID } from 'node:crypto';
import { EmberError, CODES, isRecord } from './errors.mjs';
import { addDaysIso, nowIso, shortHash, stableStringify } from './io.mjs';
import {
  applyRound as roundApplyRound,
  roundHintTexts,
  roundPracticeSelection,
  roundReviewPlan,
  roundResolveBinding,
  roundAssertSubmittable,
  roundWithProgress,
  roundView as roundViewOf,
  validateRoundBinding as roundValidateBinding,
  validateRounds as roundValidateRounds,
} from './round.mjs';
import {
  scheduleAddSelfAssessment,
  scheduleAddTutorAssessment,
  scheduleEffectiveAssessment,
  scheduleNextInterval,
  scheduleReplay,
  scheduleValidateAttempt,
} from './schedule.mjs';
import {
  interactionById as interactionLookupById,
  interactionMergePositions as interactionMergePositionsShared,
  interactionRecordPosition as interactionRecordPositionShared,
  interactionStepView as interactionStepViewOf,
  interactionValidatePosition as interactionValidatePositionShared,
  interactionValidatePositions as interactionValidatePositionsShared,
} from './interactions.mjs';
import {
  insightMergeNotes as insightMergeNotesShared,
  insightRecordNote as insightRecordNoteShared,
  insightValidateNotes as insightValidateNotesShared,
} from './insights.mjs';
import {
  correctionMergeTeaching as correctionMergeTeachingShared,
  correctionValidateBucket as correctionValidateBucketShared,
  teachingCorrectionsView as teachingCorrectionsViewShared,
} from './corrections.mjs';
import {
  applyReviewItem as tutorApplyReviewItem,
  startReviewRequest as tutorStartReviewRequest,
  tutorEvidenceHasBasis,
  tutorReviewSummary as tutorSummaryOf,
  validateReviewRequests as tutorValidateReviewRequests,
} from './tutor-review.mjs';

// Archive (state.json) format version. Version 1 is the format written by
// forge 1.0; version 2 adds the explicit `migrations` history so an upgraded
// archive records how it was migrated. Model schemaVersion stays 1 — only the
// learner archive is upgraded.
export const STATE_SCHEMA_VERSION = 2;
export const PREVIOUS_SCHEMA_VERSIONS = Object.freeze([1]);
export const RATINGS = Object.freeze(['again', 'hard', 'good', 'easy']);
export const EVIDENCE_STATUSES = Object.freeze(['unknown', 'needs-work', 'explained', 'applied', 'retained']);
export const MAX_INTERVAL_DAYS = 180;
// forge's own transparent spacing table (shared with the portable schedule
// module). Deliberately NOT FSRS and not an efficacy claim; the rules only make
// the next interval monotone in performance. Kept exported for compatibility.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Requirements for turning real attempts into reviewed mastery evidence. These
// are enforced in applyTutorEvidence so a note alone, an assisted attempt, or a
// stale-fingerprint attempt can never be promoted to independent mastery.
export const EVIDENCE_RULES = Object.freeze({
  // status -> { minIndependent, minTotal, kinds }
  'needs-work': { minIndependent: 0, minTotal: 1, kinds: null, minSeparatedIndependent: 0 },
  explained: { minIndependent: 1, minTotal: 1, kinds: ['explain', 'compare'], minSeparatedIndependent: 0 },
  applied: { minIndependent: 1, minTotal: 1, kinds: ['apply'], minSeparatedIndependent: 0 },
  retained: { minIndependent: 2, minTotal: 2, kinds: null, minSeparatedIndependent: 2 },
});
// A retained judgement must rest on independent attempts separated by at least
// this much wall-clock time (cross-session, not same-minute repetition).
export const RETAINED_MIN_GAP_MS = 20 * 60 * 60 * 1000;

function assertNoDangerousKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new EmberError(CODES.STATE, `状态字段名 ${key} 被拒绝，避免对象原型污染`, `${path}.${key}`);
    }
    assertNoDangerousKeys(value[key], `${path}.${key}`);
  }
}

function validTime(iso) {
  return typeof iso === 'string' && !Number.isNaN(new Date(iso).getTime());
}

// Author/learner IDs may legally be inherited Object.prototype names such as
// `toString` or `valueOf`. A keyed lookup into a plain dictionary must not fall
// through to an inherited member, so shared lookups use an own-property read.
function ownEntry(bucket, key) {
  if (bucket === null || bucket === undefined || key === null || key === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : undefined;
}

// Write an ID-keyed entry without ever invoking an inherited setter (only
// `__proto__` has one, and it is rejected upstream, but defineProperty keeps the
// invariant explicit and the dictionary shape unchanged).
function setOwn(bucket, key, value) {
  Object.defineProperty(bucket, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
  return bucket;
}

// The portable round module cannot import the shared error class, so it throws
// plain Errors tagged with a code. Translate them at the state boundary so
// every backend surface keeps the same EmberError contract.
function asEmberError(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof EmberError) throw err;
    if (err && typeof err.code === 'string') throw new EmberError(err.code, err.rawMessage ?? err.message, err.path ?? null);
    throw err;
  }
}

// Walkthrough-position rules live in the shared, portable interaction library so
// the browser viewer and this backend validate, record and merge ONE identical
// rule set instead of two copies. These wrappers only translate the library's
// coded errors into the shared EmberError contract; the `fail` hook below runs
// inside the library's `throw` so the thrown value is already an EmberError.
function interactionPositionContext() {
  return {
    fail: (code, message, path) => new EmberError(code, message, path),
  };
}

function assertInteractionPosition(id, position) {
  return interactionValidatePositionShared(id, position, interactionPositionContext());
}

function normalizeInteractionPositions(raw) {
  return interactionValidatePositionsShared(raw, interactionPositionContext()) ?? {};
}

// Note-history rules live in the shared, portable insight library so the
// browser viewer and this backend validate, merge and record ONE history rule
// set. These wrappers only translate the library's coded errors into the shared
// EmberError contract.
function insightNoteContext() {
  return {
    fail: (code, message, path) => new EmberError(code, message, path),
  };
}

function normalizeNotes(raw) {
  return insightValidateNotesShared(raw, insightNoteContext());
}

export function createState(model, at = nowIso()) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    modelId: model.id,
    modelFingerprint: model.modelFingerprint,
    modelRevision: 1,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    conceptRevisions: {},
    relationRevisions: {},
    explanations: {},
    summaries: {},
    ownQuestions: {},
    conceptEvidence: {},
    promptEvidence: {},
    schedules: {},
    attempts: {},
    practiceSessions: {},
    // Optional learning-journey focus. Old archives omit both fields; a default
    // archive records empty rounds and no active round so readers need no
    // null checks, while `normalizeState` keeps a legacy file's shape stable.
    learningRounds: {},
    activeRoundId: null,
    // Optional concentrated-review bucket. Old archives omit it; a default
    // archive records an empty dictionary so readers need no null checks.
    reviewRequests: {},
    // Optional teaching-correction records (task 05). Append-only agent-side
    // history: a mis-taught explanation, its re-read basis, the affected
    // scope and the follow-up attempts. Old archives omit the bucket; a
    // default archive records an empty dictionary so readers need no null
    // checks.
    teachingCorrections: {},
    // Optional teaching-interaction positions (ticket 11). Old archives omit it
    // and read as an empty map; a walkthrough position is a learner record.
    interactionPositions: {},
    conflicts: [],
    orphans: [],
    migrations: [],
  };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Collect honest notes about information an old archive never recorded. The
 * migration never invents values: a missing fingerprint keeps the attempt
 * inactive against current content, a missing assisted flag keeps the attempt
 * from counting as independent evidence, and each gap is listed here.
 */
function collectMigrationWarnings(raw) {
  const warnings = [];
  for (const [promptId, list] of Object.entries(raw.attempts ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const attempt of list) {
      if (!isRecord(attempt)) continue;
      const missing = [];
      if (typeof attempt.fingerprint !== 'string' || attempt.fingerprint === '') missing.push('fingerprint');
      if (typeof attempt.assisted !== 'boolean') missing.push('assisted');
      if (attempt.source !== 'browser' && attempt.source !== 'cli') missing.push('source');
      if (!Array.isArray(attempt.corrections)) missing.push('corrections');
      if (missing.length > 0) {
        warnings.push(`作答 ${attempt.id}（问题 ${promptId}）缺少 ${missing.join('、')}；已按保守语义保留原记录（缺指纹的作答不作为当前内容证据，缺协助标记的作答不作为独立证据）`);
      }
    }
  }
  for (const [id, evidence] of Object.entries(raw.promptEvidence ?? {})) {
    if (isRecord(evidence) && !Array.isArray(evidence.attemptIds)) {
      warnings.push(`问题复核记录 ${id} 缺少 attemptIds 关联；已保留原文并按待复核处理，不显示为当前掌握`);
    }
  }
  for (const [id, evidence] of Object.entries(raw.conceptEvidence ?? {})) {
    if (isRecord(evidence) && !Array.isArray(evidence.attemptIds)) {
      warnings.push(`概念复核记录 ${id} 缺少 attemptIds 关联；已保留原文并按待复核处理，不显示为当前掌握`);
    }
  }
  return warnings;
}

/**
 * Explicit archive migration. A version-1 archive is upgraded to the current
 * format in memory: every learner record (answers, ratings, original times,
 * assisted flags, fingerprints, evidence links, notes, own questions, user
 * revisions, schedules) is carried over untouched, one migration-history entry
 * is appended, and missing information is listed instead of guessed.
 * Idempotent: reading a current archive returns it unchanged and never appends
 * history. A newer format than this tool supports is rejected with a clear
 * upgrade hint and the file on disk is never touched.
 */
export function migrateArchiveState(raw, { at = nowIso() } = {}) {
  if (raw.schemaVersion === STATE_SCHEMA_VERSION) return { state: raw, migrated: false };
  if (PREVIOUS_SCHEMA_VERSIONS.includes(raw.schemaVersion)) {
    const migrated = {
      ...raw,
      schemaVersion: STATE_SCHEMA_VERSION,
      migrations: [
        ...(Array.isArray(raw.migrations) ? raw.migrations : []),
        { from: raw.schemaVersion, to: STATE_SCHEMA_VERSION, at, tool: 'ember', warnings: collectMigrationWarnings(raw) },
      ],
    };
    return { state: migrated, migrated: true };
  }
  if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new EmberError(CODES.STATE,
      `档案格式版本 ${raw.schemaVersion} 高于当前工具支持的版本 ${STATE_SCHEMA_VERSION}；` +
      `请升级 forge 工具后再使用。原档案未被修改`);
  }
  throw new EmberError(CODES.STATE,
    `状态 schemaVersion 必须是 ${STATE_SCHEMA_VERSION}（版本 1 的旧档会自动迁移），收到 ${JSON.stringify(raw.schemaVersion)}`);
}

/**
 * Drop an own `hintLevel` key whose value is `undefined`. JSON never produces
 * `undefined`, so this only touches in-memory records; normalizing it back to
 * "absent" keeps the invariant that a *present* `hintLevel` is always a valid
 * non-negative integer and never adds the optional field to a legacy session.
 * The map is copied only when a session actually needs cleaning, so an
 * untouched archive keeps its original object identity.
 */
function withoutUndefinedHintLevels(sessions) {
  if (!isRecord(sessions)) return {};
  let copy = null;
  for (const [id, session] of Object.entries(sessions)) {
    if (!isRecord(session) || !Object.hasOwn(session, 'hintLevel') || session.hintLevel !== undefined) continue;
    if (copy === null) copy = { ...sessions };
    const cleaned = { ...session };
    delete cleaned.hintLevel;
    copy[id] = cleaned;
  }
  return copy ?? sessions;
}

export function normalizeState(raw, model, migrateOptions = {}) {
  if (!isRecord(raw)) throw new EmberError(CODES.STATE, '状态必须是一个 JSON 对象');
  assertNoDangerousKeys(raw);
  const { state: migratedRaw } = migrateArchiveState(raw, migrateOptions);
  if (raw.modelId !== model.id) {
    throw new EmberError(CODES.IDENTITY, `状态属于模型 ${raw.modelId}，当前模型是 ${model.id}`);
  }
  // Optional round buckets are backwards compatible when absent, but a value
  // that is *present and malformed* must be rejected before the coercion below
  // silently replaces it with an empty bucket — otherwise a corrupted
  // learningRounds array or non-string activeRoundId would discard real round
  // history instead of failing the write. This mirrors the viewer's loader,
  // which validates the raw state before any defaulting.
  if (migratedRaw.learningRounds !== undefined && migratedRaw.learningRounds !== null &&
      !isRecord(migratedRaw.learningRounds)) {
    throw new EmberError(CODES.STATE, 'learningRounds 必须是对象（旧档可省略该字段）', 'learningRounds');
  }
  if (migratedRaw.activeRoundId !== undefined && migratedRaw.activeRoundId !== null && migratedRaw.activeRoundId !== '' &&
      typeof migratedRaw.activeRoundId !== 'string') {
    throw new EmberError(CODES.STATE, 'activeRoundId 必须是字符串或省略', 'activeRoundId');
  }
  // Same rule for the optional review bucket: an absent/null field is a legacy
  // archive, but a present-and-malformed value must fail loudly instead of being
  // coerced to an empty object and silently discarding real review history.
  if (migratedRaw.reviewRequests !== undefined && migratedRaw.reviewRequests !== null &&
      !isRecord(migratedRaw.reviewRequests)) {
    throw new EmberError(CODES.STATE, 'reviewRequests 必须是对象（旧档可省略该字段）', 'reviewRequests');
  }
  // Teaching corrections follow the same optional-bucket rule: absent reads as
  // none, a present-and-malformed value fails before any coercion could drop
  // real correction history.
  if (migratedRaw.teachingCorrections !== undefined && migratedRaw.teachingCorrections !== null &&
      !isRecord(migratedRaw.teachingCorrections)) {
    throw new EmberError(CODES.STATE, 'teachingCorrections 必须是对象（旧档可省略该字段）', 'teachingCorrections');
  }
  // The interaction-position map is optional too: an absent field keeps a legacy
  // archive readable, while a present value (an explicit `null` included) must be
  // a well-formed bucket and fails loudly instead of being coerced to an empty
  // object and losing real positions. The rules are the shared library's.
  const interactionPositions = normalizeInteractionPositions(migratedRaw.interactionPositions);
  // Note history is optional for old archives, but when present every version
  // is validated before the bucket is accepted. The returned canonical buckets
  // are the same records the browser validator sees.
  const notes = normalizeNotes(migratedRaw);
  const base = createState(model, raw.createdAt ?? nowIso());
  const state = {
    ...base,
    ...migratedRaw,
    conceptRevisions: isRecord(migratedRaw.conceptRevisions) ? migratedRaw.conceptRevisions : {},
    relationRevisions: isRecord(migratedRaw.relationRevisions) ? migratedRaw.relationRevisions : {},
    explanations: notes.explanations,
    summaries: notes.summaries,
    ownQuestions: isRecord(migratedRaw.ownQuestions) ? migratedRaw.ownQuestions : {},
    conceptEvidence: isRecord(migratedRaw.conceptEvidence) ? migratedRaw.conceptEvidence : {},
    promptEvidence: isRecord(migratedRaw.promptEvidence) ? migratedRaw.promptEvidence : {},
    schedules: isRecord(migratedRaw.schedules) ? migratedRaw.schedules : {},
    practiceSessions: withoutUndefinedHintLevels(migratedRaw.practiceSessions),
    attempts: isRecord(migratedRaw.attempts) ? migratedRaw.attempts : {},
    // Optional journey fields stay backwards compatible: a legacy archive with
    // neither key reads as no rounds and no active round, and is never given a
    // fabricated round for work it recorded before rounds existed.
    learningRounds: isRecord(migratedRaw.learningRounds) ? migratedRaw.learningRounds : {},
    activeRoundId: typeof migratedRaw.activeRoundId === 'string' && migratedRaw.activeRoundId !== ''
      ? migratedRaw.activeRoundId
      : null,
    // Optional review history follows the same rule: absent reads as none, a
    // malformed value was already rejected above.
    reviewRequests: isRecord(migratedRaw.reviewRequests) ? migratedRaw.reviewRequests : {},
    teachingCorrections: isRecord(migratedRaw.teachingCorrections) ? migratedRaw.teachingCorrections : {},
    interactionPositions,
    conflicts: Array.isArray(migratedRaw.conflicts) ? migratedRaw.conflicts : [],
    orphans: Array.isArray(migratedRaw.orphans) ? migratedRaw.orphans : [],
    migrations: Array.isArray(migratedRaw.migrations) ? migratedRaw.migrations : [],
  };
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.modelRevision = Number.isInteger(state.modelRevision) && state.modelRevision >= 1 ? state.modelRevision : 1;
  if (typeof state.modelFingerprint !== 'string') state.modelFingerprint = model.modelFingerprint;
  // Keep each attempt stream chronological so scheduling and reconciliation read
  // history in the order it actually happened.
  for (const [promptId, list] of Object.entries(state.attempts)) {
    if (Array.isArray(list)) state.attempts[promptId] = sortAttemptsChronologically(list);
  }
  validateStateShape(state, model);
  return state;
}

export function validateStateShape(state, model) {
  if (!isRecord(state)) throw new EmberError(CODES.STATE, '状态必须是对象');
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new EmberError(CODES.STATE, `状态 schemaVersion 必须是 ${STATE_SCHEMA_VERSION}`);
  }
  if (state.modelId !== model.id) {
    throw new EmberError(CODES.IDENTITY, `状态模型标识不匹配：${state.modelId} ≠ ${model.id}`);
  }
  // NOTE: overlays/attempts that point at concepts or prompts which are no
  // longer in the model are intentionally NOT rejected here. They are historical
  // learner data; syncModel preserves and reports them as orphans instead of
  // blocking reconciliation.
  for (const [conceptId, revision] of Object.entries(state.conceptRevisions)) {
    if (!isRecord(revision) || typeof revision.title !== 'string') {
      throw new EmberError(CODES.STATE, '概念修订缺少 title', `conceptRevisions.${conceptId}`);
    }
  }
  // Note history is optional per note for legacy archives, but a present
  // history is checked strictly by the same portable rules the viewer runs.
  insightValidateNotesShared(state, insightNoteContext());
  // Event identities are unique across the whole archive, not only within one
  // prompt or attempt: the same attempt id, correction id, assessment id or
  // tutor-feedback id may not name two different events. Tracking them here
  // rejects a hand-edited or pre-fix archive whose ids collide across prompts,
  // so a merged-but-unreadable state can never be persisted.
  const globalAttemptIds = new Map();
  const globalCorrectionIds = new Map();
  const globalAssessmentIds = new Map();
  const globalFeedbackIds = new Map();
  for (const [promptId, list] of Object.entries(state.attempts)) {
    if (!Array.isArray(list)) throw new EmberError(CODES.STATE, 'attempts 每一项必须是数组', `attempts.${promptId}`);
    const seen = new Set();
    for (const [index, attempt] of list.entries()) {
      if (!isRecord(attempt)) throw new EmberError(CODES.STATE, 'attempt 必须是对象', `attempts.${promptId}[${index}]`);
      if (typeof attempt.id !== 'string' || attempt.id === '') {
        throw new EmberError(CODES.STATE, 'attempt 缺少 id', `attempts.${promptId}[${index}].id`);
      }
      if (seen.has(attempt.id)) {
        throw new EmberError(CODES.STATE, `同一问题的 attempt id 重复：${attempt.id}`, `attempts.${promptId}[${index}].id`);
      }
      const priorAttempt = globalAttemptIds.get(attempt.id);
      if (priorAttempt !== undefined) {
        throw new EmberError(CODES.STATE,
          `attempt id ${attempt.id} 在问题 ${priorAttempt} 与 ${promptId} 之间重复，事件身份必须全档唯一`,
          `attempts.${promptId}[${index}].id`);
      }
      globalAttemptIds.set(attempt.id, promptId);
      seen.add(attempt.id);
      if (attempt.rating !== null && !RATINGS.includes(attempt.rating)) {
        throw new EmberError(CODES.STATE, `attempt 评分不合法：${JSON.stringify(attempt.rating)}`, `attempts.${promptId}[${index}].rating`);
      }
      if (attempt.rating === null && (typeof attempt.answer !== 'string' || !attempt.answer.trim() || typeof attempt.fingerprint !== 'string' ||
          typeof attempt.conceptId !== 'string' || !Array.isArray(attempt.corrections) || typeof attempt.assisted !== 'boolean')) {
        throw new EmberError(CODES.STATE, '未自评作答缺少原文、概念或来源信息');
      }
      if (attempt.assistance !== undefined) assistanceSources(attempt.assistance);
      const correctionIds = new Set();
      for (const correction of attempt.corrections ?? []) {
        if (correction.id === undefined) continue; // Legacy corrections remain readable.
        if (typeof correction.id !== 'string' || !correction.id || correctionIds.has(correction.id) || correction.attemptId !== attempt.id ||
            typeof correction.text !== 'string' || !correction.text.trim() || !validTime(correction.at) || !['cli', 'browser'].includes(correction.source)) {
          throw new EmberError(CODES.STATE, '修正缺少事件身份、原答关联、内容或来源');
        }
        const priorCorrection = globalCorrectionIds.get(correction.id);
        if (priorCorrection !== undefined) {
          throw new EmberError(CODES.STATE,
            `修正 id ${correction.id} 在作答 ${priorCorrection} 与 ${attempt.id} 之间重复，事件身份必须全档唯一`,
            `attempts.${promptId}[${index}].corrections.${correction.id}`);
        }
        globalCorrectionIds.set(correction.id, attempt.id);
        correctionIds.add(correction.id);
        assistanceSources(correction.assistance);
      }
      if (!validTime(attempt.at)) {
        throw new EmberError(CODES.STATE, `attempt 时间不合法：${JSON.stringify(attempt.at)}`, `attempts.${promptId}[${index}].at`);
      }
      if (index > 0 && new Date(attempt.at).getTime() < new Date(list[index - 1].at).getTime()) {
        throw new EmberError(CODES.STATE, `attempt 时间顺序错误：${attempt.at} 早于前一条`, `attempts.${promptId}[${index}].at`);
      }
      // Separate self/tutor evaluations and their feedback are validated by the
      // same portable rules the browser recorder runs, so a malformed imported
      // event fails here instead of silently producing a wrong arrangement.
      asEmberError(() => scheduleValidateAttempt(attempt));
      // Assessment and feedback ids are also archive-wide identities.
      for (const bucket of ['selfAssessments', 'tutorAssessments']) {
        for (const event of attempt[bucket] ?? []) {
          if (!isRecord(event) || typeof event.id !== 'string') continue;
          const prior = globalAssessmentIds.get(event.id);
          if (prior !== undefined) {
            throw new EmberError(CODES.STATE,
              `评价 id ${event.id} 在作答 ${prior} 与 ${attempt.id} 之间重复，事件身份必须全档唯一`,
              `attempts.${promptId}[${index}].${bucket}.${event.id}`);
          }
          globalAssessmentIds.set(event.id, attempt.id);
        }
      }
      for (const feedback of attempt.tutorFeedback ?? []) {
        if (!isRecord(feedback) || typeof feedback.id !== 'string') continue;
        const prior = globalFeedbackIds.get(feedback.id);
        if (prior !== undefined) {
          throw new EmberError(CODES.STATE,
            `导师反馈 id ${feedback.id} 在作答 ${prior} 与 ${attempt.id} 之间重复，事件身份必须全档唯一`,
            `attempts.${promptId}[${index}].tutorFeedback.${feedback.id}`);
        }
        globalFeedbackIds.set(feedback.id, attempt.id);
      }
    }
  }
  for (const [id, session] of Object.entries(state.practiceSessions ?? {})) {
    if (!isRecord(session) || session.id !== id || typeof session.promptId !== 'string' || typeof session.draft !== 'string' ||
        typeof session.fingerprint !== 'string' || !validTime(session.createdAt) || !validTime(session.updatedAt)) {
      throw new EmberError(CODES.STATE, '练习会话缺少身份、草稿、版本或时间', `practiceSessions.${id}`);
    }
    // assistance is a required, typed fact: an imported session that omits it
    // or carries a wrong type must fail here with a precise path instead of
    // crashing a later merge. Legacy archives that predate practice sessions
    // simply have none to validate.
    if (!Array.isArray(session.assistance) ||
        session.assistance.some((source) => !['hint', 'reference', 'tutor-feedback', 'starter', 'demonstration'].includes(source))) {
      throw new EmberError(CODES.STATE, '练习会话 assistance 必须是 hint/reference/tutor-feedback/starter/demonstration 数组',
        `practiceSessions.${id}.assistance`);
    }
    // Optional step-hint level. When present it must be a real non-negative
    // integer: a null, string or fractional value is malformed typed optional
    // data and fails closed. The available *range* is not checked here — it
    // depends on the current question and may shrink after a content update, so
    // a historically valid level is preserved. `applyPractice` enforces the
    // live range for new writes. This keeps a malformed import out of the
    // archive with a structured E_STATE instead of a later 500.
    if (session.hintLevel !== undefined &&
        (typeof session.hintLevel !== 'number' || !Number.isInteger(session.hintLevel) || session.hintLevel < 0)) {
      throw new EmberError(CODES.STATE, '练习会话 hintLevel 必须是非负整数（可省略）',
        `practiceSessions.${id}.hintLevel`);
    }
    // A session that claims a revealed hint must carry the matching assistance
    // fact, exactly as the page's recorder requires. Otherwise the archive would
    // read back as assisted on one surface and unassisted on another.
    if (session.hintLevel > 0 && !session.assistance.includes('hint')) {
      throw new EmberError(CODES.STATE, '练习会话 hintLevel 大于 0 时必须记录 hint 协助来源',
        `practiceSessions.${id}.hintLevel`);
    }
  }
  for (const [promptId, schedule] of Object.entries(state.schedules)) {
    if (!isRecord(schedule) || typeof schedule.dueAt !== 'string' || !Number.isFinite(schedule.intervalDays)) {
      throw new EmberError(CODES.STATE, '复习安排缺少 dueAt/intervalDays', `schedules.${promptId}`);
    }
  }
  // Walkthrough positions are optional learner records: a legacy archive with
  // none validates, and each present record is checked strictly.
  for (const [interactionId, position] of Object.entries(state.interactionPositions ?? {})) {
    assertInteractionPosition(interactionId, position);
  }
  for (const bucket of ['conceptEvidence', 'promptEvidence']) {
    for (const [id, evidence] of Object.entries(state[bucket] ?? {})) {
      if (!isRecord(evidence) || !EVIDENCE_STATUSES.includes(evidence.status)) {
        throw new EmberError(CODES.STATE, `证据状态不合法：${JSON.stringify(evidence?.status)}`, `${bucket}.${id}.status`);
      }
    }
  }
  // Learning rounds are optional: a legacy archive without them validates. A
  // present bucket is checked with the same portable rules the viewer runs.
  asEmberError(() => roundValidateRounds(state, model));
  // Teaching corrections are checked with the same portable rules the viewer
  // runs: a present bucket must be well-formed (ids, texts, times, impact
  // kinds, recheck lists). Whether a referenced concept/prompt/attempt still
  // exists is deliberately NOT a read rule — content may change after the
  // correction was written, and the view reports unresolved references.
  asEmberError(() => correctionValidateBucketShared(state.teachingCorrections, {
    fail: (code, message, path) => new EmberError(code, message, path),
  }));
  // Review requests are optional too. The portable rules confirm each frozen
  // request carries a self-describing snapshot and references only real,
  // existing attempts, so a corrupted snapshot cannot later rate a different
  // answer that merely reuses an id.
  asEmberError(() => tutorValidateReviewRequests(state, { state }));
  return true;
}

export function resolvePrompt(model, state, promptId) {
  const modelPrompt = model.prompts.find((item) => item.id === promptId);
  if (modelPrompt) return { ...modelPrompt, origin: 'model' };
  const own = ownEntry(state.ownQuestions, promptId);
  if (own) {
    // A learner question whose concept was removed from the model stays in the
    // durable state (reported as an orphan) but is not an active playable prompt.
    if (own.conceptId && model.byId && !model.byId.has(own.conceptId)) return null;
    return {
      id: own.id,
      conceptId: own.conceptId,
      kind: 'recall',
      question: own.text,
      answer: '',
      criteria: [],
      origin: 'learner',
      createdAt: own.createdAt,
    };
  }
  return null;
}

export function promptFingerprint(model, state, promptId) {
  if (model.promptFingerprints[promptId]) return model.promptFingerprints[promptId];
  const own = ownEntry(state.ownQuestions, promptId);
  if (own) {
    return shortHash(`learner|${own.conceptId}|${own.text}|${model.conceptFingerprints?.[own.conceptId] ?? ''}`, 32);
  }
  return null;
}

// The portable round library reads every content fingerprint from
// `model.promptFingerprints`. A normalized model only carries author prompts, so
// each round entry point enriches a shallow copy with the recomputed learner
// question fingerprints before calling the shared logic. This is the same map
// `collectPromptFingerprints` publishes to the page, so a learner question and
// an author prompt cannot drift between the browser and the backend.
export function roundModelWithOwnFingerprints(model, state) {
  const own = state?.ownQuestions;
  if (!isRecord(own) || Object.keys(own).length === 0) return model;
  const base = model?.promptFingerprints ?? {};
  const fingerprints = Object.create(null);
  for (const [id, value] of Object.entries(base)) fingerprints[id] = value;
  let changed = false;
  for (const question of Object.values(own)) {
    if (!isRecord(question) || typeof question.id !== 'string' || !question.id) continue;
    const value = promptFingerprint(model, state, question.id);
    if (value && fingerprints[question.id] !== value) {
      fingerprints[question.id] = value;
      changed = true;
    }
  }
  return changed ? { ...model, promptFingerprints: fingerprints } : model;
}

export function isPromptStale(model, state, promptId) {
  const current = promptFingerprint(model, state, promptId);
  if (!current) return false;
  const attempts = state.attempts[promptId] ?? [];
  if (attempts.length === 0) return false;
  const latest = attempts[attempts.length - 1];
  return latest.fingerprint !== current;
}

// An attempt is "active" only while the question content it was recorded
// against still matches the current model/own-question fingerprint.
export function isAttemptActive(model, state, attempt) {
  if (!isRecord(attempt)) return false;
  const current = promptFingerprint(model, state, attempt.promptId);
  if (!current) return false;
  return attempt.fingerprint === current;
}

export function activeAttemptsFor(model, state, promptId) {
  return (state.attempts[promptId] ?? []).filter((attempt) => isAttemptActive(model, state, attempt));
}

// Non-throwing evaluation of whether a set of real attempts actually satisfies
// the rules for a status. Read-only display code uses this so a forged or stale
// evidence record can never be rendered as active mastery; applyTutorEvidence
// uses the same rules and adds a specific diagnostic message when they fail.
//
// Independence is more than "answered without help": a tutor credit that came
// from a *correction* of this answer, or the tutor's current judgement that the
// original answer failed (`again`), means the original answer is not itself an
// independent success. Reworking the same answer after feedback is never a
// fresh independent retrieval, even when the correction succeeds.
//
// Only the *currently effective* tutor evaluation decides this (the same
// precedence task 05 uses), so a later explicit re-rating of the original as
// good restores independence, and `hard` — difficulty, not failure — does not
// strip it. An answer with no tutor evaluation stays independent exactly as it
// did before, keeping untouched archives compatible.
//
// A positive judgement must also have something to check against: an answer to
// a prompt with no author reference and no judgement criteria (a learner's own
// question) can never be a checkable independent success, no matter how many
// times it was answered or how far apart. That keeps discussion records from
// being promoted to unsupported mastery.
function independentEvidenceAttempt(model, state, attempt) {
  if (!isRecord(attempt) || attempt.assisted !== false) return false;
  if (!tutorEvidenceHasBasis(model, state, attempt.promptId)) return false;
  if ((attempt.tutorAssessments ?? []).length === 0) return true;
  const effective = asEmberError(() => scheduleEffectiveAssessment(attempt));
  if (!effective || effective.source !== 'tutor') return true;
  // The credited work is a correction of this answer, not the original.
  if (effective.targetCorrectionId !== null && effective.targetCorrectionId !== undefined) return false;
  // The tutor's current judgement of the original answer is that it failed.
  if (effective.rating === 'again') return false;
  return true;
}

function evidenceRuleSatisfied(status, model, state, attempts) {
  const rule = EVIDENCE_RULES[status];
  if (!rule) return false;
  const active = attempts.filter((attempt) => isAttemptActive(model, state, attempt));
  if (active.length < rule.minTotal) return false;
  const independent = active.filter((attempt) => independentEvidenceAttempt(model, state, attempt));
  if (independent.length < rule.minIndependent) return false;
  if (rule.kinds) {
    const qualified = independent.filter((attempt) => rule.kinds.includes(promptKindFor(model, state, attempt.promptId)));
    if (qualified.length === 0) return false;
  }
  if (rule.minSeparatedIndependent > 0) {
    const times = independent.map((attempt) => new Date(attempt.at).getTime()).sort((a, b) => a - b);
    const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    if (times.length < rule.minSeparatedIndependent || span < RETAINED_MIN_GAP_MS) return false;
  }
  return true;
}

// Look up the attempts referenced by an evidence record without throwing: a
// read-only view must treat a missing id as invalid proof, not crash.
function referencedAttempts(state, attemptIds) {
  if (!Array.isArray(attemptIds) || attemptIds.length === 0) return null;
  const byId = new Map();
  for (const list of Object.values(state.attempts ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const attempt of list) byId.set(attempt.id, attempt);
  }
  const out = [];
  for (const id of attemptIds) {
    const attempt = byId.get(id);
    if (!attempt) return null;
    out.push(attempt);
  }
  return out;
}

function attemptConceptId(model, state, attempt) {
  const prompt = resolvePrompt(model, state, attempt.promptId);
  return prompt ? prompt.conceptId : null;
}

export function isPromptEvidenceActive(model, state, promptId, evidence = state.promptEvidence?.[promptId]) {
  if (!isRecord(evidence) || evidence.status === 'unknown') return false;
  const current = promptFingerprint(model, state, promptId);
  if (!current || !evidence.fingerprint) return false;
  if (evidence.fingerprint !== current) return false;
  // A matching fingerprint is not enough: the recorded proof must still exist
  // as referenced, current attempts for this very prompt. Legacy records with
  // no attempt ids are treated conservatively as awaiting review.
  const attempts = referencedAttempts(state, evidence.attemptIds);
  if (!attempts) return false;
  if (attempts.some((attempt) => attempt.promptId !== promptId)) return false;
  return evidenceRuleSatisfied(evidence.status, model, state, attempts);
}

export function isConceptEvidenceActive(model, state, conceptId, evidence = state.conceptEvidence?.[conceptId]) {
  if (!isRecord(evidence) || evidence.status === 'unknown') return false;
  const current = model.conceptFingerprints?.[conceptId];
  if (!current || !evidence.conceptFingerprint) return false;
  if (evidence.conceptFingerprint !== current) return false;
  // The supporting attempts must still be present, active, related to this
  // concept, and sufficient for the claimed status. Otherwise obsolete question
  // proof would keep promoting mastery even though the question changed.
  const attempts = referencedAttempts(state, evidence.attemptIds);
  if (!attempts) return false;
  if (attempts.some((attempt) => attemptConceptId(model, state, attempt) !== conceptId)) return false;
  return evidenceRuleSatisfied(evidence.status, model, state, attempts);
}

// Clear spacing streak continuity when the question content changed under the
// learner. The historical schedule/attempts are kept, but the next rating starts
// a fresh streak instead of extending an interval that no longer describes the
// same question.
function resetStreakIfContentChanged(schedule, latestAttempt, currentFingerprint) {
  if (!schedule) return schedule;
  if (!latestAttempt || !currentFingerprint) return schedule;
  if (latestAttempt.fingerprint === currentFingerprint) return schedule;
  return { ...schedule, streakKind: null, streakCount: 0 };
}

// The spacing table itself lives in the portable schedule module so the page
// and the backend cannot drift apart. This alias keeps the existing public
// export working for callers that already import it from state.
export const nextInterval = scheduleNextInterval;

// Recompute one prompt's review arrangement from its real, assessed answer
// history. The portable schedule module owns the ordering and spacing rules;
// this wrapper only re-resolves the current content fingerprint and stores the
// result. A newer attempt without an effective assessment never contributes,
// so it can never steal the arrangement from the last assessed answer.
function recomputePromptSchedule(state, model, promptId) {
  const prompt = resolvePrompt(model, state, promptId);
  if (!prompt) return state.schedules[promptId] ?? null;
  const fingerprint = promptFingerprint(model, state, promptId);
  const replay = asEmberError(() =>
    scheduleReplay(state.attempts[promptId] ?? [], promptId, fingerprint));
  if (replay) {
    state.schedules[promptId] = replay;
    return replay;
  }
  // No current-content assessed answer is left. Historical arrangements are
  // preserved and reported as stale by listDue instead of being erased.
  return state.schedules[promptId] ?? null;
}

// Assessment event ids are immutable across the whole archive, not only inside
// one attempt: the same id may not describe two different evaluations.
function findAssessmentEvent(state, id) {
  if (id === undefined || id === null) return null;
  for (const [promptId, list] of Object.entries(state.attempts ?? {})) {
    for (const attempt of list) {
      for (const bucket of ['selfAssessments', 'tutorAssessments']) {
        for (const event of attempt[bucket] ?? []) {
          if (event.id === id) return { promptId, attemptId: attempt.id, bucket, event };
        }
      }
    }
  }
  return null;
}

function requireAssessableAnswer(state, model, input) {
  const list = state.attempts[input.promptId] ?? [];
  const index = list.findIndex((a) => a.id === input.attemptId);
  if (index < 0) throw new EmberError(CODES.STATE, '请指定已保存原答的 attemptId');
  const original = list[index];
  if (input.answer !== undefined && input.answer !== original.answer) {
    throw new EmberError(CODES.CONFLICT, '评价不能修改原答案');
  }
  return { list, index, original };
}

export function applyAttempt(state, model, input, at = nowIso()) {
  const promptId = input.promptId;
  const prompt = resolvePrompt(model, state, promptId);
  if (!prompt) throw new EmberError(CODES.STATE, `问题不存在：${JSON.stringify(promptId)}`, 'promptId');
  if (!validTime(at)) throw new EmberError(CODES.USAGE, `时间格式不合法：${at}`);
  if (!RATINGS.includes(input.rating)) {
    throw new EmberError(CODES.USAGE, `rating 只能是 ${RATINGS.join('/')}`);
  }
  if (typeof input.answer !== 'string' || input.answer.trim() === '') {
    throw new EmberError(CODES.USAGE, '必须记录学习者实际提交的非空作答，不能伪造答案');
  }
  const attemptId = input.attemptId ?? `att-${shortHash(`${promptId}|${at}|${input.answer}`, 16)}`;
  if (typeof attemptId !== 'string' || attemptId.trim() === '') {
    throw new EmberError(CODES.USAGE, 'attemptId 不合法');
  }
  for (const list of Object.values(state.attempts)) {
    if (list.some((entry) => entry.id === attemptId)) {
      throw new EmberError(CODES.CONFLICT, `attempt 已存在，拒绝重复提交：${attemptId}`);
    }
  }
  const assisted = Boolean(input.assisted);
  const fingerprint = promptFingerprint(model, state, promptId);
  const attempt = {
    id: attemptId,
    promptId,
    at,
    answer: input.answer,
    rating: input.rating,
    assisted,
    source: input.source === 'browser' ? 'browser' : 'cli',
    fingerprint,
    corrections: [],
  };
  const latest = (state.attempts[promptId] ?? []).at(-1) ?? null;
  if (latest && new Date(at).getTime() < new Date(latest.at).getTime()) {
    throw new EmberError(CODES.USAGE,
      `作答时间 ${at} 早于该问题已有作答 ${latest.at}；事件必须按时间顺序记录，拒绝回放旧时间`);
  }
  // This legacy combined answer/rating path keeps its historical semantics:
  // `at` is simultaneously the submission and the evaluation time. It records
  // no separate submittedAt, so the replay anchor stays its at and is labelled
  // legacy-combined rather than fabricated as a real submission time.
  const contentChanged = Boolean(state.schedules[promptId] && latest && latest.fingerprint !== fingerprint);
  const nextState = cloneState(state);
  nextState.attempts[promptId] = [...(nextState.attempts[promptId] ?? []), attempt];
  const schedule = recomputePromptSchedule(nextState, model, promptId);
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, attempt, schedule, contentChanged };
}

export function assistanceSources(input = []) {
  if (!Array.isArray(input) || input.some((s) => !['hint', 'reference', 'tutor-feedback', 'starter', 'demonstration'].includes(s))) {
    throw new EmberError(CODES.USAGE, 'assistance 必须是 hint/reference/tutor-feedback/starter/demonstration 数组');
  }
  return [...new Set(input)].sort();
}

function eventId(value, prefix) {
  const id = value ?? `${prefix}-${randomUUID()}`;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || FORBIDDEN_KEYS.has(id)) {
    throw new EmberError(CODES.USAGE, `${prefix} id 不合法`);
  }
  return id;
}

export function applyPractice(state, model, input, at = nowIso()) {
  const prompt = resolvePrompt(model, state, input.promptId);
  if (!prompt) throw new EmberError(CODES.STATE, '问题不存在');
  if (!validTime(at)) throw new EmberError(CODES.USAGE, '时间格式不合法');
  const id = eventId(input.sessionId, 'practice');
  // A round binding is validated before anything is written; the returned
  // object keeps the exact task so the session can never be filed under a
  // different task of the same round.
  // Saving a draft is not evidence, so a deferred/not-yet-confirmed task may
  // be drafted; only a real submission is gated by the diagnosis.
  const binding = asEmberError(() => roundValidateBinding(state, model, { ...input, type: 'practice' }));
  const current = ownEntry(state.practiceSessions, id);
  const fingerprint = promptFingerprint(model, state, prompt.id);
  if (current && (current.promptId !== prompt.id || current.fingerprint !== fingerprint)) {
    throw new EmberError(CODES.CONFLICT, '练习身份或内容版本冲突');
  }
  if (current && ((current.roundId ?? undefined) !== binding.roundId || (current.taskId ?? undefined) !== binding.taskId)) {
    throw new EmberError(CODES.CONFLICT, '练习所属轮次或任务冲突，不能把旧草稿挪入其他轮次或任务');
  }
  if (current?.attemptId && input.draft !== undefined && input.draft !== current.draft) {
    throw new EmberError(CODES.CONFLICT, '已提交练习的原答案不可修改');
  }
  if (input.draft !== undefined && typeof input.draft !== 'string') throw new EmberError(CODES.USAGE, 'draft 必须是文本');
  if (current && input.draft !== undefined && input.draft !== current.draft && input.baseDraft !== current.draft) {
    throw new EmberError(CODES.CONFLICT, '草稿已被其他入口修改，请读取后重试');
  }
  // Optional step-hint level. It is monotone (a learner only ever reveals more
  // hints), it records the `hint` assistance source when it advances, and its
  // available range is enforced only for a *new* write against current content.
  // An absent field keeps a legacy session's shape unchanged; a level kept from
  // an earlier, larger question is preserved even after the content shrinks.
  const storedLevel = Number.isInteger(current?.hintLevel) && current.hintLevel > 0 ? current.hintLevel : 0;
  let requestedLevel;
  if (input.hintLevel !== undefined) {
    // A present level must be a real non-negative integer: a null, string or
    // fractional value is malformed optional data and is refused, matching the
    // page's recorder. (An absent key simply means "no hint step".)
    if (typeof input.hintLevel !== 'number' || !Number.isInteger(input.hintLevel) || input.hintLevel < 0) {
      throw new EmberError(CODES.USAGE, `hintLevel 必须是非负整数，收到 ${JSON.stringify(input.hintLevel)}`);
    }
    requestedLevel = input.hintLevel;
  }
  let nextLevel = storedLevel;
  if (requestedLevel !== undefined) {
    const available = roundHintTexts(model, prompt.id).length;
    if (requestedLevel > available && requestedLevel > storedLevel) {
      throw new EmberError(CODES.USAGE, `提示等级 ${requestedLevel} 超出当前问题可用提示数量 ${available}`);
    }
    nextLevel = Math.max(storedLevel, requestedLevel);
  }
  const hintAdvanced = nextLevel > storedLevel;
  // The binding fields are only present when a round is named; unbound legacy
  // work keeps them undefined so a later comparison cannot confuse null/absent.
  const bindingFields = binding.roundId ? { roundId: binding.roundId, taskId: binding.taskId } : {};
  const session = {
    ...(current ?? { id, promptId: prompt.id, conceptId: prompt.conceptId, fingerprint,
      modelFingerprint: model.modelFingerprint, modelRevision: state.modelRevision, createdAt: at,
      source: input.source === 'browser' ? 'browser' : 'cli', draft: '', assistance: [] }),
    draft: input.draft ?? current?.draft ?? '',
    assistance: assistanceSources([
      ...(current?.assistance ?? []),
      ...(hintAdvanced ? ['hint'] : []),
      ...assistanceSources(input.assistance),
    ]),
  };
  // Keep the field absent at level 0 so untouched legacy sessions stay the same.
  if (nextLevel > 0) session.hintLevel = nextLevel;
  else delete session.hintLevel;
  for (const [key, value] of Object.entries(bindingFields)) session[key] = value;
  if (current && stableStringify(current) === stableStringify(session)) return { state, session };
  session.updatedAt = at;
  const nextState = cloneState(state);
  nextState.practiceSessions ??= {};
  nextState.practiceSessions[id] = session;
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, session };
}

export function applySubmission(state, model, input, at = nowIso()) {
  const prompt = resolvePrompt(model, state, input.promptId);
  if (!prompt) throw new EmberError(CODES.STATE, '问题不存在');
  if (!validTime(at)) throw new EmberError(CODES.USAGE, '时间格式不合法');
  if (typeof input.answer !== 'string' || !input.answer.trim()) throw new EmberError(CODES.USAGE, '作答不能为空');
  const id = eventId(input.attemptId, 'att');
  // Learner questions carry their fingerprint in this enriched copy, so round
  // binding, the write gate and completion all see the same current content.
  const roundModel = roundModelWithOwnFingerprints(model, state);
  // Identity first: resolve the round/task and confirm it really is about this
  // prompt/concept. This runs for every write (new or replay) so an answer to
  // an unrelated prompt can never be filed under a real task, and a replay of
  // an already-recorded attempt stays resolvable even after the round was
  // paused or its content changed. See below for why the retry check precedes
  // the restrictive new-write guard.
  const resolved = asEmberError(() => roundResolveBinding(state, roundModel, input));
  const binding = resolved ? { roundId: resolved.round.id, taskId: resolved.task.id } : {};
  const session = input.sessionId ? (ownEntry(state.practiceSessions, input.sessionId) ?? null) : null;
  const currentFingerprint = promptFingerprint(model, state, prompt.id);
  const submittedAssistance = assistanceSources(input.assistance);
  const source = input.source === 'browser' ? 'browser' : 'cli';
  const existing = Object.values(state.attempts).flat().find((a) => a.id === id);
  if (existing) {
    // An idempotent replay returns the immutable original. It is checked before
    // the session-freshness check and the new-write guard below, so a paused
    // round, a content update, or a stale practice session cannot turn a safe
    // retry of already-recorded work into a spurious conflict.
    if (existing.promptId !== prompt.id || existing.answer !== input.answer || existing.source !== source ||
        (existing.sessionId ?? null) !== (input.sessionId ?? null) ||
        (existing.roundId ?? undefined) !== binding.roundId || (existing.taskId ?? undefined) !== binding.taskId ||
        stableStringify(existing.submission ?? { assisted: existing.assisted, assistance: existing.assistance ?? [] }) !==
        stableStringify({ assisted: Boolean(input.assisted), assistance: submittedAssistance })) {
      throw new EmberError(CODES.CONFLICT, '相同作答身份的原文或来源不同');
    }
    return { state, attempt: existing, schedule: state.schedules[prompt.id] ?? null };
  }
  if (input.sessionId && (!session || session.promptId !== prompt.id || session.fingerprint !== currentFingerprint)) {
    throw new EmberError(CODES.CONFLICT, '请先保存当前练习及协助事实');
  }
  if (session && ((session.roundId ?? undefined) !== binding.roundId || (session.taskId ?? undefined) !== binding.taskId)) {
    throw new EmberError(CODES.CONFLICT, '原练习不能移入其他轮次或任务');
  }
  const assistance = assistanceSources([...(session?.assistance ?? []), ...submittedAssistance]);
  const assisted = Boolean(input.assisted || assistance.length);
  // New work must still pass the restrictive guard: current content, not paused,
  // and a confirmed route for a new-topic round.
  if (resolved) asEmberError(() => roundAssertSubmittable(state, roundModel, { ...input, promptId: prompt.id, attemptId: id }));
  if (session?.attemptId) throw new EmberError(CODES.CONFLICT, '本次练习已经提交，请开始新的练习');
  const latest = state.attempts[prompt.id]?.at(-1);
  if (latest && new Date(at) < new Date(latest.at)) throw new EmberError(CODES.USAGE, '作答时间早于已有作答');
  const attempt = { id, promptId: prompt.id, conceptId: prompt.conceptId, at, answer: input.answer,
    rating: null, assisted, assistance, submission: { assisted: Boolean(input.assisted), assistance: submittedAssistance }, source, sessionId: input.sessionId ?? null,
    fingerprint: currentFingerprint, modelFingerprint: model.modelFingerprint,
    modelRevision: state.modelRevision, submittedAt: at, corrections: [] };
  // Only record the binding when a round is named; unbound legacy work keeps
  // the fields absent so a later comparison stays undefined-to-undefined.
  if (binding.roundId) { attempt.roundId = binding.roundId; attempt.taskId = binding.taskId; }
  const nextState = cloneState(state);
  nextState.attempts[prompt.id] = [...(nextState.attempts[prompt.id] ?? []), attempt];
  if (session) nextState.practiceSessions[session.id] = { ...session, draft: input.answer, attemptId: id, updatedAt: at };
  // A bound real submission may have closed the last open task of the round.
  if (binding.roundId) roundWithProgress(nextState, roundModel, binding.roundId, at);
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, attempt, schedule: null };
}

export function applyAssessment(state, model, input, at = nowIso()) {
  const { index, original } = requireAssessableAnswer(state, model, input);
  const targetCorrectionId = input.targetCorrectionId ?? input.correctionId ?? null;
  // The portable recorder validates identity, rating, correction target and
  // time, and enforces idempotency for a retried event. It never mutates its
  // input, so a rejected write leaves the archive untouched.
  const recorded = asEmberError(() =>
    scheduleAddSelfAssessment(original, { ...input, targetCorrectionId }, at));
  if (!recorded.changed) {
    return { state, attempt: original, schedule: state.schedules[input.promptId] ?? null };
  }
  if (!isAttemptActive(model, state, original)) throw new EmberError(CODES.CONFLICT, '原答对应的内容已经更新');
  const savedEvent = recorded.attempt.selfAssessments.at(-1);
  const clash = findAssessmentEvent(state, savedEvent.id);
  if (clash) throw new EmberError(CODES.CONFLICT, `评价事件身份 ${savedEvent.id} 已用于其他作答，不能复用`);
  const nextState = cloneState(state);
  nextState.attempts[input.promptId][index] = recorded.attempt;
  const schedule = recomputePromptSchedule(nextState, model, input.promptId);
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, attempt: recorded.attempt, schedule };
}

/**
 * Agent-side tutor assessment. It records the rating and its associated
 * feedback as separate immutable events tied to the exact answer — or to one
 * of its corrections — and then recomputes the review arrangement in
 * submission order. It never creates an attempt and never upgrades mastery.
 */
export function applyTutorAssessment(state, model, input, at = nowIso()) {
  const { index, original } = requireAssessableAnswer(state, model, input);
  if (typeof input.note !== 'string' || !input.note.trim()) {
    throw new EmberError(CODES.USAGE, '导师评价必须写明真实复核依据（note）');
  }
  const targetCorrectionId = input.targetCorrectionId ?? input.correctionId ?? null;
  const recorded = asEmberError(() =>
    scheduleAddTutorAssessment(original, { ...input, note: input.note.trim(), targetCorrectionId }, at));
  if (!recorded.changed) {
    return { state, attempt: original, schedule: state.schedules[input.promptId] ?? null };
  }
  if (!isAttemptActive(model, state, original)) throw new EmberError(CODES.CONFLICT, '原答对应的内容已经更新');
  const savedEvent = recorded.attempt.tutorAssessments.at(-1);
  const clash = findAssessmentEvent(state, savedEvent.id);
  if (clash) throw new EmberError(CODES.CONFLICT, `导师评价身份 ${savedEvent.id} 已用于其他作答，不能复用`);
  const nextState = cloneState(state);
  nextState.attempts[input.promptId][index] = recorded.attempt;
  const schedule = recomputePromptSchedule(nextState, model, input.promptId);
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, attempt: recorded.attempt, schedule };
}

export function applyCorrection(state, model, input, at = nowIso()) {
  const { promptId, attemptId } = input;
  const text = input.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new EmberError(CODES.USAGE, '修正内容不能为空');
  }
  if (!validTime(at)) throw new EmberError(CODES.USAGE, `时间格式不合法：${at}`);
  if (typeof promptId !== 'string' || typeof attemptId !== 'string') throw new EmberError(CODES.USAGE, '修正必须指定问题与原答身份');
  const list = state.attempts[promptId];
  if (!list) throw new EmberError(CODES.STATE, `没有找到该问题的作答：${promptId}`);
  const index = list.findIndex((entry) => entry.id === attemptId);
  if (index === -1) throw new EmberError(CODES.STATE, `没有找到 attempt：${attemptId}`);
  const id = eventId(input.correctionId, 'corr');
  const assistance = assistanceSources(input.assistance);
  const source = input.source === 'browser' ? 'browser' : 'cli';
  const existing = Object.values(state.attempts).flat().flatMap((a) => a.corrections ?? []).find((c) => c.id === id);
  if (existing) {
    if (existing.attemptId !== attemptId || existing.text !== text.trim() || existing.source !== source || stableStringify(existing.assistance) !== stableStringify(assistance)) {
      throw new EmberError(CODES.CONFLICT, '相同修正身份的原文或来源不同');
    }
    return { state, attempt: list[index] };
  }
  const nextState = cloneState(state);
  const attempt = { ...nextState.attempts[promptId][index] };
  attempt.corrections = [...(attempt.corrections ?? []), { id, attemptId, text: text.trim(), at, source, assistance }];
  nextState.attempts[promptId][index] = attempt;
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, attempt };
}

// Validate one impact reference against the live model/archive. Write-time
// only: reads stay lenient so a later content removal keeps the correction
// history readable (the view reports the unresolved reference instead).
function validateCorrectionImpact(impact, model, state) {
  if (impact.kind === 'explanation' || impact.kind === 'example') {
    if (!model.byId.has(impact.id)) {
      throw new EmberError(CODES.STATE, `影响范围引用的概念不存在：${JSON.stringify(impact.id)}`, 'impacts');
    }
    return;
  }
  if (impact.kind === 'exercise' || impact.kind === 'reference' || impact.kind === 'criteria') {
    // Exercises, reference answers and criteria are author content: a learner
    // question is nobody's corrected exercise, so only model prompts resolve.
    if (!model.prompts.some((prompt) => prompt.id === impact.id)) {
      throw new EmberError(CODES.STATE, `影响范围引用的问题不存在：${JSON.stringify(impact.id)}`, 'impacts');
    }
    return;
  }
  // kind === 'record': the attempt must already be in the archive. A
  // correction may only name learning records that actually exist.
  if (!findAttemptById(state, impact.id)) {
    throw new EmberError(CODES.STATE, `影响范围引用的原答不存在：${JSON.stringify(impact.id)}`, 'impacts');
  }
}

// Locate one archived attempt by its archive-wide id, or null. Shared by the
// write-time reference validation and the recheck link so both name attempts
// through one lookup.
function findAttemptById(state, attemptId) {
  for (const list of Object.values(state.attempts ?? {})) {
    if (!Array.isArray(list)) continue;
    const found = list.find((attempt) => attempt.id === attemptId);
    if (found) return found;
  }
  return null;
}

// One shared id rule for correction/recheck entity ids written by this module.
function validCorrectionEntityId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value) || value.endsWith('-') || FORBIDDEN_KEYS.has(value)) {
    throw new EmberError(CODES.USAGE, `${label} id 不合法：${value}`);
  }
  return value;
}

/**
 * Agent-side teaching correction (task 05). Two append-only actions:
 *
 * - `record`: write a new correction — the inaccurate claim, the re-read
 *   basis, the affected scope (impacts) or an explicit no-impact reason, and
 *   optional learner feedback. An existing id replays idempotently only when
 *   the whole record is identical; a same-id different-content write is a
 *   conflict, because correction history is never rewritten.
 * - `recheck`: append a follow-up attempt link to an existing correction.
 *   The attempt must already exist and must postdate the correction — a
 *   re-check arranged *after* the fix, never the misled answer itself. A
 *   same-id identical recheck replays idempotently.
 *
 * The correction itself never creates an attempt, rating, schedule or
 * evidence record, so it cannot promote anything to independent success.
 */
export function applyTeachingCorrection(state, model, input, at = nowIso()) {
  if (!validTime(at)) throw new EmberError(CODES.USAGE, `时间格式不合法：${at}`);
  const action = input.action === undefined ? 'record' : input.action;
  if (action !== 'record' && action !== 'recheck') {
    throw new EmberError(CODES.USAGE, 'action 只能是 record 或 recheck');
  }
  if (action === 'record') {
    const record = isRecord(input.record) ? input.record : null;
    if (!record) throw new EmberError(CODES.USAGE, '教学纠错需要 --record JSON（claim/correction/basis/impacts）');
    // The auto id derives from the record content alone, never from the write
    // time: a literal retry of the same command without --at must land on the
    // same identity and replay as a no-op instead of minting a duplicate.
    const id = typeof input.correctionId === 'string' && input.correctionId !== '' ? input.correctionId
      : `tcorr-${shortHash(`${record.claim ?? ''}|${record.correction ?? ''}`, 8)}`;
    validCorrectionEntityId(id, '教学纠错');
    const normalized = asEmberError(() => correctionValidateBucketShared(
      { [id]: { ...record, id, at, source: 'cli' } },
      { fail: (code, message, path) => new EmberError(code, message, path) },
    ));
    const next = normalized[id];
    // Replay compares content only, excluding the write time: the stored `at`
    // stays at the first write, so a literal retry (the same command without
    // --at, hence a fresh timestamp) is a byte-stable no-op. An identical
    // replay stays a no-op even when the world has moved on (a referenced
    // concept was removed): replaying history must never require the live
    // model to still match it. A recheck appended since the first write IS
    // part of the stored history, so replaying the original record still
    // conflicts — correction history is never rewritten.
    const existing = ownEntry(state.teachingCorrections ?? {}, id);
    if (existing) {
      const fingerprint = (entry) => stableStringify({ ...entry, at: undefined });
      if (fingerprint(existing) !== fingerprint(next)) {
        throw new EmberError(CODES.CONFLICT, '相同纠错身份的内容不同；纠错历史不可改写，请使用新的纠错 id');
      }
      return { state, correction: existing };
    }
    for (const impact of next.impacts) validateCorrectionImpact(impact, model, state);
    if (next.sourceId && !model.sources.some((source) => source.id === next.sourceId)) {
      throw new EmberError(CODES.STATE, `教学纠错引用的来源不存在：${JSON.stringify(next.sourceId)}`, 'sourceId');
    }
    if (Array.isArray(next.rechecks) && next.rechecks.length > 0) {
      throw new EmberError(CODES.USAGE, '新纠错记录不能自带复核关联；先保存纠错，再按 recheck 动作追加');
    }
    const nextState = cloneState(state);
    if (!isRecord(nextState.teachingCorrections)) nextState.teachingCorrections = {};
    setOwn(nextState.teachingCorrections, id, next);
    nextState.revision += 1;
    nextState.updatedAt = at;
    return { state: nextState, correction: next };
  }
  // action === 'recheck'
  const correctionId = typeof input.correctionId === 'string' && input.correctionId !== '' ? input.correctionId : null;
  if (!correctionId) throw new EmberError(CODES.USAGE, '追加复核关联需要 --correction-id 指向已有教学纠错');
  const attemptId = typeof input.attemptId === 'string' && input.attemptId !== '' ? input.attemptId : null;
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!attemptId) throw new EmberError(CODES.USAGE, '复核关联需要 --recheck-attempt 指定纠错后的新原答');
  if (!note) throw new EmberError(CODES.USAGE, '复核关联必须写明说明（--recheck-note）');
  const existing = ownEntry(state.teachingCorrections ?? {}, correctionId);
  if (!existing) throw new EmberError(CODES.STATE, `没有找到教学纠错记录：${correctionId}`);
  const target = findAttemptById(state, attemptId);
  if (!target) throw new EmberError(CODES.STATE, `复核关联引用的原答不存在：${attemptId}`);
  if (new Date(target.at).getTime() < new Date(existing.at).getTime()) {
    throw new EmberError(CODES.USAGE, '复核关联的原答应晚于纠错记录；受误导的旧原答保存在影响范围里，不是复核');
  }
  // The recheck id derives from the correction and attempt identities alone,
  // never from the write time: a literal retry without --at must land on the
  // same identity instead of silently appending a second link for the same
  // attempt. A genuinely different follow-up for the same attempt passes an
  // explicit --recheck-id.
  const recheckId = typeof input.recheckId === 'string' && input.recheckId !== '' ? input.recheckId
    : `recheck-${shortHash(`${correctionId}|${attemptId}`, 8)}`;
  validCorrectionEntityId(recheckId, '复核关联');
  const duplicate = (existing.rechecks ?? []).find((entry) => entry.id === recheckId);
  if (duplicate) {
    // Content-only comparison: the link time stays at the first write, so a
    // literal retry without --at replays as a byte-stable no-op.
    if (duplicate.attemptId !== attemptId || duplicate.note !== note) {
      throw new EmberError(CODES.CONFLICT, '相同复核身份的内容不同；请使用新的复核 id');
    }
    return { state, correction: existing };
  }
  const nextState = cloneState(state);
  const correction = { ...nextState.teachingCorrections[correctionId] };
  correction.rechecks = [...(correction.rechecks ?? []), { id: recheckId, attemptId, at, note }];
  setOwn(nextState.teachingCorrections, correctionId, correction);
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, correction };
}

// Read-only view with the backend's authoritative activity rules injected, so
// the CLI readback and the page (which injects its own mirrors) cannot drift
// on which evidence still counts.
export function teachingCorrectionsView(state, model) {
  return teachingCorrectionsViewShared(state, model, {
    currentFingerprint: (promptId) => promptFingerprint(model, state, promptId),
    evidenceActive: (bucket, id, record) => bucket === 'promptEvidence'
      ? isPromptEvidenceActive(model, state, id, record)
      : isConceptEvidenceActive(model, state, id, record),
  });
}

export function applyNote(state, model, input, at = nowIso()) {
  return asEmberError(() => insightRecordNoteShared(state, model, input, at));
}

export function applyOwnQuestion(state, model, input, at = nowIso()) {
  if (!model.byId.has(input.conceptId)) {
    throw new EmberError(CODES.STATE, `概念不存在：${JSON.stringify(input.conceptId)}`);
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') throw new EmberError(CODES.USAGE, '问题内容不能为空');
  const id = input.id ?? `q-${shortHash(`${input.conceptId}|${text}|${at}`, 8)}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.endsWith('-') || FORBIDDEN_KEYS.has(id)) {
    throw new EmberError(CODES.USAGE, `自创问题 id 不合法：${id}`);
  }
  // A learner question must never shadow a model prompt id: doing so would make
  // the same id resolve to two different questions and corrupt evidence.
  if (model.prompts.some((prompt) => prompt.id === id)) {
    throw new EmberError(CODES.DUP_ID, `自创问题 id 与模型问题冲突：${id}`, 'id');
  }
  const nextState = cloneState(state);
  const existing = nextState.ownQuestions[id];
  nextState.ownQuestions[id] = {
    id,
    conceptId: input.conceptId,
    text,
    author: 'learner',
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, question: nextState.ownQuestions[id] };
}

export function applyTitleRevision(state, model, input, at = nowIso()) {
  if (!model.byId.has(input.conceptId)) {
    throw new EmberError(CODES.STATE, `概念不存在：${JSON.stringify(input.conceptId)}`);
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '') throw new EmberError(CODES.USAGE, '节点标题不能为空');
  const nextState = cloneState(state);
  nextState.conceptRevisions[input.conceptId] = {
    title,
    updatedAt: at,
    modelFingerprint: model.conceptFingerprints[input.conceptId],
  };
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, revision: nextState.conceptRevisions[input.conceptId] };
}

export function applyRelationRevision(state, model, input, at = nowIso()) {
  const relation = model.relations.find((item) => item.id === input.relationId);
  if (!relation) throw new EmberError(CODES.STATE, `关系不存在：${JSON.stringify(input.relationId)}`);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label === '') throw new EmberError(CODES.USAGE, '关系含义不能为空');
  const nextState = cloneState(state);
  nextState.relationRevisions[input.relationId] = { label, updatedAt: at, modelLabel: relation.label };
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState, revision: nextState.relationRevisions[input.relationId] };
}

function promptKindFor(model, state, promptId) {
  const prompt = resolvePrompt(model, state, promptId);
  return prompt ? prompt.kind : null;
}

function collectAttemptsById(state, attemptIds) {
  const byId = new Map();
  for (const list of Object.values(state.attempts ?? {})) {
    for (const attempt of list) byId.set(attempt.id, attempt);
  }
  return attemptIds.map((id) => {
    const attempt = byId.get(id);
    if (!attempt) throw new EmberError(CODES.STATE, `没有找到要复核的 attempt：${id}`, 'attemptIds');
    return attempt;
  });
}

function evaluateEvidence(status, model, state, attempts) {
  const rule = EVIDENCE_RULES[status];
  if (!rule) return;
  // Rules are shared with the read-only validity checks above; if they pass,
  // there is nothing to reject. The detailed checks below only exist to produce
  // a specific diagnostic message on failure.
  if (evidenceRuleSatisfied(status, model, state, attempts)) return;
  const active = attempts.filter((attempt) => isAttemptActive(model, state, attempt));
  if (active.length < rule.minTotal) {
    throw new EmberError(CODES.STATE,
      `状态 ${status} 需要至少 ${rule.minTotal} 条当前内容的真实作答；现有 ${active.length} 条。旧内容或缺少指纹的作答已失效`);
  }
  const independent = active.filter((attempt) => independentEvidenceAttempt(model, state, attempt));
  if (independent.length < rule.minIndependent) {
    // The most specific honest reason first: a prompt with no author reference
    // and no judgement criteria has nothing to check a positive judgement
    // against, so no amount of repeated or separated answering can support it.
    const basisless = active.some((attempt) => !tutorEvidenceHasBasis(model, state, attempt.promptId));
    if (basisless && independent.length === 0) {
      throw new EmberError(CODES.STATE,
        `状态 ${status} 需要可核对的作者参考或判定标准；该问题（多为自创问题）没有可核对依据，` +
        '不能授予解释/应用/保持；可继续讨论或先补充可核对材料');
    }
    // Distinguish "no independent answer at all" from "an answer that only
    // looks independent but whose tutor credit actually came from a correction,
    // or which the tutor rated again/hard". Both are honest reasons, and neither
    // can be promoted to independent success by a later correction.
    const creditedElsewhere = active.some((attempt) =>
      attempt.assisted === false && !independentEvidenceAttempt(model, state, attempt));
    if (creditedElsewhere && independent.length === 0) {
      throw new EmberError(CODES.STATE,
        `状态 ${status} 需要至少 ${rule.minIndependent} 条独立（未看参考）作答；` +
        '现有独立来源的导师评价针对的是受协助修正，或导师当前判定原答为 again，' +
        '不能把原答升为独立掌握。需要新的真实独立作答');
    }
    throw new EmberError(CODES.STATE,
      `状态 ${status} 需要至少 ${rule.minIndependent} 条独立（未看参考）作答；现有 ${independent.length} 条。有协助作答不能升级为独立掌握`);
  }
  if (rule.kinds) {
    const qualified = independent.filter((attempt) => rule.kinds.includes(promptKindFor(model, state, attempt.promptId)));
    if (qualified.length === 0) {
      throw new EmberError(CODES.STATE,
        `状态 ${status} 需要类型为 ${rule.kinds.join('/')} 的独立作答，当前不满足`);
    }
  }
  if (rule.minSeparatedIndependent > 0) {
    const times = independent.map((attempt) => new Date(attempt.at).getTime()).sort((a, b) => a - b);
    const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    if (times.length < rule.minSeparatedIndependent || span < RETAINED_MIN_GAP_MS) {
      throw new EmberError(CODES.STATE,
        `状态 ${status} 需要至少 ${rule.minSeparatedIndependent} 次有间隔（≥20 小时）的独立作答；同一次或同一分钟的重复不构成保持`);
    }
  }
}

export function applyTutorEvidence(state, model, input, at = nowIso()) {
  if (!EVIDENCE_STATUSES.includes(input.status)) {
    throw new EmberError(CODES.USAGE, `status 只能是 ${EVIDENCE_STATUSES.join('/')}`);
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note === '') throw new EmberError(CODES.USAGE, '导师证据必须写明依据（note）');
  if (input.attemptIds !== undefined && !Array.isArray(input.attemptIds)) {
    throw new EmberError(CODES.USAGE, 'attemptIds 必须是 attempt id 的数组');
  }
  const nextState = cloneState(state);
  const reviewer = input.reviewer ?? 'tutor';
  if (input.promptId) {
    const prompt = resolvePrompt(model, state, input.promptId);
    if (!prompt) throw new EmberError(CODES.STATE, `问题不存在：${input.promptId}`);
    const candidates = input.attemptIds
      ? collectAttemptsById(state, input.attemptIds).filter((attempt) => attempt.promptId === input.promptId)
      : (state.attempts[input.promptId] ?? []);
    if (input.attemptIds && candidates.length !== input.attemptIds.length) {
      throw new EmberError(CODES.STATE, 'attemptIds 中有作答不属于指定问题');
    }
    if (candidates.length === 0) {
      throw new EmberError(CODES.STATE, '该问题没有实际作答记录，不能凭空虚设掌握证据');
    }
    const status = input.status;
    if (status !== 'unknown') evaluateEvidence(status, model, state, candidates);
    const active = candidates.filter((attempt) => isAttemptActive(model, state, attempt));
    nextState.promptEvidence[input.promptId] = {
      status,
      note,
      reviewer,
      at,
      promptId: input.promptId,
      fingerprint: promptFingerprint(model, state, input.promptId),
      conceptId: prompt.conceptId,
      conceptFingerprint: model.conceptFingerprints?.[prompt.conceptId] ?? null,
      attemptIds: (input.attemptIds ?? active.map((attempt) => attempt.id)),
      // Independence is judged by the same guard the validity check uses: an
      // assisted answer, an answer whose tutor credit came from a correction,
      // or an answer the tutor rated again is not an independent success.
      independent: active.some((attempt) => independentEvidenceAttempt(model, state, attempt)),
    };
  } else if (input.conceptId) {
    if (!model.byId.has(input.conceptId)) {
      throw new EmberError(CODES.STATE, `概念不存在：${input.conceptId}`);
    }
    const promptIds = model.prompts.filter((p) => p.conceptId === input.conceptId).map((p) => p.id)
      .concat(Object.values(state.ownQuestions).filter((q) => q.conceptId === input.conceptId).map((q) => q.id));
    const candidates = input.attemptIds
      ? collectAttemptsById(state, input.attemptIds)
      : promptIds.flatMap((id) => state.attempts[id] ?? []);
    if (input.attemptIds) {
      const allowed = new Set(promptIds);
      if (candidates.some((attempt) => !allowed.has(attempt.promptId))) {
        throw new EmberError(CODES.STATE, 'attemptIds 中有作答不属于指定概念');
      }
    }
    if (candidates.length === 0) {
      throw new EmberError(CODES.STATE, '该概念下没有实际作答记录，不能凭空虚设掌握证据');
    }
    const status = input.status;
    if (status !== 'unknown') evaluateEvidence(status, model, state, candidates);
    const active = candidates.filter((attempt) => isAttemptActive(model, state, attempt));
    nextState.conceptEvidence[input.conceptId] = {
      status,
      note,
      reviewer,
      at,
      conceptId: input.conceptId,
      conceptFingerprint: model.conceptFingerprints[input.conceptId],
      attemptIds: (input.attemptIds ?? active.map((attempt) => attempt.id)),
      promptIds: [...new Set(candidates.map((attempt) => attempt.promptId))],
      independent: active.some((attempt) => independentEvidenceAttempt(model, state, attempt)),
    };
  } else {
    throw new EmberError(CODES.USAGE, 'evidence 需要 --prompt 或 --concept');
  }
  nextState.revision += 1;
  nextState.updatedAt = at;
  return { state: nextState };
}

export function listDue(state, model, at = nowIso()) {
  const atMs = new Date(at).getTime();
  if (Number.isNaN(atMs)) throw new EmberError(CODES.USAGE, `时间格式不合法：${at}`);
  const promptIds = [...model.prompts.map((p) => p.id), ...Object.keys(state.ownQuestions)];
  const due = [];
  const unscheduled = [];
  for (const promptId of promptIds) {
    const prompt = resolvePrompt(model, state, promptId);
    if (!prompt) continue;
    const schedule = state.schedules[promptId] ?? null;
    const attempts = state.attempts[promptId] ?? [];
    // The latest real answer may still be unanswered for review even while an
    // older, already-assessed arrangement is due: both facts stay visible.
    const latest = attempts.at(-1) ?? null;
    const latestAssessment = latest ? asEmberError(() => scheduleEffectiveAssessment(latest)) : null;
    if (schedule && new Date(schedule.dueAt).getTime() <= atMs) {
      due.push({
        promptId,
        conceptId: prompt.conceptId,
        origin: prompt.origin,
        intervalDays: schedule.intervalDays,
        attemptId: schedule.attemptId ?? null,
        lastRating: schedule.lastRating,
        lastAt: schedule.lastAt,
        dueAt: schedule.dueAt,
        assisted: Boolean(schedule.assisted),
        assessmentSource: schedule.assessmentSource ?? null,
        lastAttemptAt: schedule.lastAttemptAt ?? schedule.lastAt,
        anchorSemantics: schedule.anchorSemantics ?? null,
        pendingAssessmentAt: latestAssessment ? null : latest?.at ?? null,
      });
    } else if (attempts.length === 0) {
      unscheduled.push({ promptId, conceptId: prompt.conceptId, reason: 'never-attempted', lastSeenAt: null });
      continue;
    }
    // A tutor-only evaluation is still an evaluation: it is not pending.
    if (latest && !latestAssessment) {
      unscheduled.push({
        promptId,
        conceptId: prompt.conceptId,
        reason: 'pending-assessment',
        lastSeenAt: latest.at ?? null,
        schedule: schedule
          ? { attemptId: schedule.attemptId ?? null, dueAt: schedule.dueAt, lastRating: schedule.lastRating, assessedAt: schedule.assessedAt ?? null }
          : null,
      });
    }
    if (isPromptStale(model, state, promptId) && (!schedule || new Date(schedule.dueAt).getTime() > atMs)) {
      unscheduled.push({
        promptId,
        conceptId: prompt.conceptId,
        reason: 'stale-evidence',
        lastSeenAt: attempts[attempts.length - 1].at,
      });
    }
  }
  due.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.promptId.localeCompare(b.promptId)));
  unscheduled.sort((a, b) => a.promptId.localeCompare(b.promptId));
  return { at, due, unscheduled };
}

/**
 * Reconcile persisted state with a (possibly updated) model.
 * - bumps modelRevision when content changed
 * - detects conflicts where the learner edited a node/relation that also changed
 * - preserves historical overlays/attempts even when their concept/prompt is
 *   gone, reporting every orphan category instead of rejecting the state first
 * Returns { state, changed, conflicts, orphans }.
 */
export function syncModel(state, model, at = nowIso()) {
  const nextState = cloneState(state);
  const conflicts = [];
  const modelChanged = nextState.modelFingerprint !== model.modelFingerprint;
  if (modelChanged) {
    nextState.modelRevision += 1;
    nextState.modelFingerprint = model.modelFingerprint;
    nextState.updatedAt = at;
  }
  const addOrphan = (kind, id, message) => {
    if (!nextState.orphans.some((item) => item.kind === kind && item.id === id)) {
      nextState.orphans.push({ kind, id, message, at });
    }
  };

  for (const [conceptId, revision] of Object.entries(nextState.conceptRevisions)) {
    if (!model.byId.has(conceptId)) {
      addOrphan('concept-revision', conceptId, `学习者修订的概念 ${conceptId} 已不在模型中，已保留并标记为孤立`);
      continue;
    }
    const modelTitle = model.byId.get(conceptId).title;
    const learnerChanged = revision.title !== modelTitle;
    const modelAlsoChanged = modelChanged && revision.modelFingerprint !== model.conceptFingerprints[conceptId];
    if (learnerChanged && modelAlsoChanged) {
      conflicts.push({
        kind: 'concept-title',
        path: `concepts.${conceptId}.title`,
        kept: revision.title,
        incoming: modelTitle,
        message: `概念 ${conceptId} 的标题在模型和学习者修订中都被改动，保留学习者版本`,
      });
    }
  }
  for (const [relationId, revision] of Object.entries(nextState.relationRevisions)) {
    const relation = model.relations.find((item) => item.id === relationId);
    if (!relation) {
      addOrphan('relation-revision', relationId, `学习者修订的关系 ${relationId} 已不在模型中，已保留并标记为孤立`);
      continue;
    }
    if (revision.label !== relation.label && modelChanged) {
      conflicts.push({
        kind: 'relation-label',
        path: `relations.${relationId}.label`,
        kept: revision.label,
        incoming: relation.label,
        message: `关系 ${relationId} 的含义在模型和学习者修订中都被改动，保留学习者版本`,
      });
    }
  }
  for (const [conceptId] of Object.entries(nextState.explanations)) {
    if (!model.byId.has(conceptId)) {
      addOrphan('explanation', conceptId, `学习者对概念 ${conceptId} 的解释已不在模型中，已保留并标记为孤立`);
    }
  }
  for (const [conceptId] of Object.entries(nextState.summaries)) {
    if (!model.byId.has(conceptId)) {
      addOrphan('summary', conceptId, `学习者对概念 ${conceptId} 的总结已不在模型中，已保留并标记为孤立`);
    }
  }
  const modelPromptIds = new Set(model.prompts.map((prompt) => prompt.id));
  for (const [questionId, question] of Object.entries(nextState.ownQuestions)) {
    if (!model.byId.has(question.conceptId)) {
      addOrphan('own-question', questionId, `自创问题 ${questionId} 所属概念 ${question.conceptId} 已不在模型中，已保留并标记为孤立`);
    } else if (modelPromptIds.has(questionId)) {
      addOrphan('own-question', questionId, `自创问题 ${questionId} 与模型问题 id 冲突，已保留但不会作为活动问题渲染`);
    }
  }
  for (const [promptId] of Object.entries(nextState.attempts)) {
    const isModel = modelPromptIds.has(promptId);
    const isOwn = Boolean(nextState.ownQuestions[promptId]);
    if (!isModel && !isOwn) {
      addOrphan('attempt', promptId, `问题 ${promptId} 已从模型和自创问题中移除，其作答历史已保留并标记为孤立`);
    }
  }
  for (const [sessionId, session] of Object.entries(nextState.practiceSessions ?? {})) {
    if (!resolvePrompt(model, nextState, session.promptId)) {
      addOrphan('practice', sessionId, `练习 ${sessionId} 的问题已移除，草稿与协助事实保留为历史`);
    }
  }
  for (const [interactionId] of Object.entries(nextState.interactionPositions ?? {})) {
    if (!interactionLookupById(model, interactionId)) {
      addOrphan('interaction-position', interactionId,
        `互动组件 ${interactionId} 已移除，其推演位置保留为历史，不会静默删除或复活`);
    }
  }
  for (const [promptId] of Object.entries(nextState.schedules)) {
    const isModel = modelPromptIds.has(promptId);
    const isOwn = Boolean(nextState.ownQuestions[promptId]);
    if (!isModel && !isOwn) {
      addOrphan('schedule', promptId, `问题 ${promptId} 已移除，其复习安排已保留并标记为孤立`);
    }
  }
  for (const conflict of conflicts) {
    if (!nextState.conflicts.some((item) => item.path === conflict.path && item.kept === conflict.kept && item.incoming === conflict.incoming)) {
      nextState.conflicts.push({ id: `cf-${shortHash(`${conflict.path}|${conflict.kept}|${conflict.incoming}`, 10)}`, at, ...conflict });
    }
  }
  if (modelChanged || conflicts.length > 0) nextState.revision += 1;
  return { state: nextState, changed: modelChanged, conflicts, orphans: nextState.orphans };
}

function sortAttemptsChronologically(list) {
  return [...list].sort((a, b) => {
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function mergeEvidence(currentBucket, incomingBucket, kind, conflicts, at) {
  const out = { ...currentBucket };
  for (const [id, incoming] of Object.entries(incomingBucket)) {
    const current = out[id];
    if (current === undefined) {
      out[id] = incoming;
      continue;
    }
    if (stableStringify(current) !== stableStringify(incoming)) {
      conflicts.push({
        id: `cf-${shortHash(`${kind}|${id}|${stableStringify(current)}`, 10)}`,
        kind,
        path: `${kind}.${id}`,
        kept: current,
        incoming,
        message: `导入状态与现有状态的 ${kind}（${id}）不同，保留现有复核结论并报告冲突`,
        at,
      });
    }
  }
  return out;
}

// Canonical identity of a reported conflict, independent of the import time.
// Use it to keep a repeated import from stacking an identical conflict: the
// first record (with its original time) is preserved.
function conflictIdentity(conflict) {
  if (!isRecord(conflict)) return null;
  const kind = conflict.kind ?? null;
  const path = conflict.path ?? (kind !== null && conflict.id !== undefined ? `${kind}.${conflict.id}` : null);
  const incoming = conflict.incoming !== undefined ? conflict.incoming : conflict.other;
  return JSON.stringify([kind, path, stableStringify(conflict.kept ?? null), stableStringify(incoming ?? null)]);
}

function dedupeConflicts(list) {
  const out = [];
  const seen = new Set();
  for (const conflict of list) {
    const key = conflictIdentity(conflict);
    if (key !== null && seen.has(key)) continue;
    if (key !== null) seen.add(key);
    out.push(conflict);
  }
  return out;
}

// Orphans are keyed by kind/id exactly as syncModel records them, so a repeated
// import cannot pile up identical orphan notices.
function dedupeOrphans(list) {
  const out = [];
  const seen = new Set();
  for (const orphan of list) {
    const key = `${orphan?.kind ?? ''}\u0000${orphan?.id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(orphan);
  }
  return out;
}

// Immutable identities are globally unique across an archive: an attempt id, an
// assessment event id, a tutor-feedback id and a correction id each name exactly
// one event (see applyCorrection/findAssessmentEvent). Merging tracks these
// registries so an import that reuses an id under a different prompt or attempt
// is reported as a collision instead of silently materialising two events that
// share one identity.
function createMergeRegistries() {
  return { attempt: new Map(), assessment: new Map(), feedback: new Map(), correction: new Map() };
}

function registerMergeAttempt(registries, promptId, attempt) {
  if (!registries.attempt.has(attempt.id)) {
    registries.attempt.set(attempt.id, { promptId, attemptId: attempt.id, attempt });
  }
}

function registerMergeEvent(registries, bucket, promptId, attemptId, event) {
  const registry = bucket === 'tutorFeedback' ? registries.feedback : registries.assessment;
  if (!registry.has(event.id)) registry.set(event.id, { promptId, attemptId, event });
}

function registerMergeCorrection(registries, promptId, attemptId, correction) {
  if (correction.id === undefined || correction.id === null) return;
  if (!registries.correction.has(correction.id)) {
    registries.correction.set(correction.id, { promptId, attemptId, correction });
  }
}

function mergeAttemptHistory(currentAttempts, incomingAttempts, conflicts, at) {
  const merged = {};
  const promptIds = new Set([...Object.keys(currentAttempts), ...Object.keys(incomingAttempts)]);
  const registries = createMergeRegistries();
  // The local branch is authoritative, so seed every identity from it first.
  for (const promptId of promptIds) {
    for (const attempt of currentAttempts[promptId] ?? []) {
      registerMergeAttempt(registries, promptId, attempt);
      for (const bucket of ['selfAssessments', 'tutorAssessments', 'tutorFeedback']) {
        for (const event of attempt[bucket] ?? []) registerMergeEvent(registries, bucket, promptId, attempt.id, event);
      }
      for (const correction of attempt.corrections ?? []) registerMergeCorrection(registries, promptId, attempt.id, correction);
    }
  }
  for (const promptId of promptIds) {
    const currentList = currentAttempts[promptId] ?? [];
    const incomingList = incomingAttempts[promptId] ?? [];
    const byId = new Map();
    // Existing attempts are immutable event history: never drop or rewrite them.
    for (const attempt of currentList) byId.set(attempt.id, attempt);
    for (const attempt of incomingList) {
      const existing = byId.get(attempt.id);
      if (existing) {
        const originalFields = ['id', 'promptId', 'at', 'submittedAt', 'answer', 'assisted', 'source', 'fingerprint', 'conceptId', 'sessionId', 'assistance', 'submission', 'modelFingerprint', 'modelRevision', 'roundId', 'taskId'];
        if (originalFields.some((key) => stableStringify(existing[key]) !== stableStringify(attempt[key]))) {
          conflicts.push({ kind: 'attempt', path: `attempts.${promptId}.${attempt.id}`, kept: existing, incoming: attempt, at, message: '同一作答身份的原文或来源冲突，保留现有原答' });
          continue;
        }
        const combined = { ...existing, corrections: [...(existing.corrections ?? [])] };
        const droppedCorrectionIds = new Set();
        for (const correction of attempt.corrections ?? []) {
          const found = combined.corrections.find((c) => correction.id ? c.id === correction.id : stableStringify(c) === stableStringify(correction));
          if (found) {
            // Same correction id, different content: the current text wins.
            // The incoming assessments and feedback were written against the
            // other text, so they are isolated with the dropped correction
            // (their target id names a correction this archive never kept)
            // instead of being re-pointed at the retained text.
            if (stableStringify(found) !== stableStringify(correction)) {
              conflicts.push({
                kind: 'correction', path: `corrections.${correction.id}`, kept: found, incoming: correction, at,
                message: '修正事件同 id 但内容不同，保留当前修正文本并隔离针对传入文本的评价与反馈',
              });
              if (correction.id !== undefined && correction.id !== null) droppedCorrectionIds.add(correction.id);
            }
            continue;
          }
          const owner = correction.id === undefined || correction.id === null ? undefined : registries.correction.get(correction.id);
          if (owner && (owner.promptId !== promptId || owner.attemptId !== existing.id)) {
            conflicts.push({ kind: 'correction', path: `corrections.${correction.id}`, kept: owner.correction, incoming: correction, at, message: '修正事件身份已用于其他作答，保留原记录并报告传入版本' });
            if (correction.id !== undefined && correction.id !== null) droppedCorrectionIds.add(correction.id);
            continue;
          }
          combined.corrections.push(correction);
          registerMergeCorrection(registries, promptId, combined.id, correction);
        }
        mergeAssessmentEvents(combined, existing, attempt, promptId, conflicts, at, registries, droppedCorrectionIds);
        byId.set(attempt.id, combined);
        continue;
      }
      // A new attempt id under this prompt. If the same id already names an
      // attempt of another prompt, that is one identity pointing at two answers.
      const owner = registries.attempt.get(attempt.id);
      if (owner && owner.promptId !== promptId) {
        conflicts.push({
          kind: 'attempt', path: `attempts.${promptId}.${attempt.id}`, kept: owner.attempt, incoming: attempt, at,
          message: `同一作答身份 ${attempt.id} 已用于问题 ${owner.promptId}，保留现有原答并报告传入版本`,
        });
        continue;
      }
      const adopted = adoptImportedAttempt(attempt, promptId, registries, conflicts, at);
      byId.set(attempt.id, adopted);
      registerMergeAttempt(registries, promptId, adopted);
      for (const bucket of ['selfAssessments', 'tutorAssessments', 'tutorFeedback']) {
        for (const event of adopted[bucket] ?? []) registerMergeEvent(registries, bucket, promptId, adopted.id, event);
      }
      for (const correction of adopted.corrections ?? []) registerMergeCorrection(registries, promptId, adopted.id, correction);
    }
    merged[promptId] = sortAttemptsChronologically([...byId.values()]);
  }
  return merged;
}

// Carry a not-yet-known attempt across, dropping only the sub-events whose
// immutable ids already name an event of another attempt (the existing event is
// kept and the collision is reported). A dropped original self-assessment takes
// its compatibility scalar rating with it so the record stays internally valid.
function adoptImportedAttempt(attempt, promptId, registries, conflicts, at) {
  const adopted = { ...attempt };
  let droppedOriginalSelf = false;
  // Corrections whose id already names another attempt's event are dropped;
  // assesments targeting them, and feedback targeting a dropped assessment, are
  // dropped with them so the adopted record stays internally consistent.
  const droppedCorrectionIds = new Set();
  const droppedAssessmentIds = new Set();
  const self = [];
  const tutor = [];
  for (const bucket of ['selfAssessments', 'tutorAssessments', 'tutorFeedback']) {
    if (attempt[bucket] === undefined) continue;
    if (bucket === 'tutorFeedback') continue;
    const registry = bucket === 'tutorFeedback' ? registries.feedback : registries.assessment;
    const kept = [];
    for (const event of attempt[bucket]) {
      const owner = registry.get(event.id);
      if (owner && (owner.promptId !== promptId || owner.attemptId !== attempt.id)) {
        conflicts.push({
          kind: bucket === 'tutorFeedback' ? 'tutor-feedback' : 'assessment', path: `${bucket}.${event.id}`,
          kept: owner.event, incoming: event, at, message: '评价事件身份已用于其他作答，保留原记录并报告传入版本',
        });
        droppedAssessmentIds.add(event.id);
        if (bucket === 'selfAssessments' && event.targetCorrectionId === null) droppedOriginalSelf = true;
        continue;
      }
      kept.push(event);
    }
    if (bucket === 'selfAssessments') self.push(...kept);
    else tutor.push(...kept);
  }
  const keptCorrections = [];
  for (const correction of attempt.corrections ?? []) {
    const owner = correction.id === undefined || correction.id === null ? undefined : registries.correction.get(correction.id);
    if (owner && (owner.promptId !== promptId || owner.attemptId !== attempt.id)) {
      conflicts.push({ kind: 'correction', path: `corrections.${correction.id}`, kept: owner.correction, incoming: correction, at, message: '修正事件身份已用于其他作答，保留原记录并报告传入版本' });
      if (correction.id !== undefined && correction.id !== null) droppedCorrectionIds.add(correction.id);
      continue;
    }
    keptCorrections.push(correction);
  }
  // An assessment that targets a dropped correction cannot be kept.
  const filterAssessments = (events) => events.filter((event) => {
    if (event.targetCorrectionId !== null && event.targetCorrectionId !== undefined && droppedCorrectionIds.has(event.targetCorrectionId)) {
      conflicts.push({
        kind: 'assessment', path: `assessments.${event.id}`, kept: null, incoming: event, at,
        message: '评价目标修正的身份已冲突未保留，评价一并保留待核对而不写入',
      });
      droppedAssessmentIds.add(event.id);
      return false;
    }
    return true;
  });
  if (attempt.selfAssessments !== undefined) adopted.selfAssessments = filterAssessments(self);
  if (attempt.tutorAssessments !== undefined) adopted.tutorAssessments = filterAssessments(tutor);
  if (attempt.tutorFeedback !== undefined) {
    const keptFeedback = [];
    for (const feedback of attempt.tutorFeedback) {
      const owner = registries.feedback.get(feedback.id);
      if (owner && (owner.promptId !== promptId || owner.attemptId !== attempt.id)) {
        conflicts.push({ kind: 'tutor-feedback', path: `tutorFeedback.${feedback.id}`, kept: owner.event, incoming: feedback, at, message: '导师反馈事件身份已用于其他作答，保留原记录并报告传入版本' });
        continue;
      }
      if (droppedAssessmentIds.has(feedback.assessmentId)) {
        conflicts.push({ kind: 'tutor-feedback', path: `tutorFeedback.${feedback.id}`, kept: null, incoming: feedback, at, message: '对应评价未保留，反馈一并保留待核对而不写入' });
        continue;
      }
      keptFeedback.push(feedback);
    }
    adopted.tutorFeedback = keptFeedback;
  }
  adopted.corrections = keptCorrections;
  if (droppedOriginalSelf && RATINGS.includes(adopted.rating)) {
    adopted.rating = null;
    delete adopted.assessment;
  }
  return adopted;
}

// Assessment events are immutable, so an import can only ever add the events
// this branch has not seen yet. A divergent reuse of the same event id is
// reported and the local event is kept. The compatibility scalar rating stays
// the original's first self assessment.
function mergeAssessmentEvents(combined, existing, incoming, promptId, conflicts, at, registries, droppedCorrectionIds = new Set()) {
  // Ids of incoming tutor assessments that could not be kept (id collision);
  // their feedback must be dropped with them to stay internally consistent.
  const droppedAssessmentIds = new Set();
  for (const bucket of ['selfAssessments', 'tutorAssessments', 'tutorFeedback']) {
    const seen = new Map((combined[bucket] ?? []).map((event) => [event.id, event]));
    const registry = bucket === 'tutorFeedback' ? registries.feedback : registries.assessment;
    for (const event of incoming[bucket] ?? []) {
      if (bucket === 'tutorFeedback' && droppedAssessmentIds.has(event.assessmentId)) {
        conflicts.push({
          kind: 'tutor-feedback', path: `tutorFeedback.${event.id}`, kept: null, incoming: event, at,
          message: '对应评价未保留，反馈一并保留待核对而不写入',
        });
        continue;
      }
      // A dropped colliding correction takes its assessments with it: an
      // assessment targeting a correction this attempt never kept cannot be
      // written without breaking the attempt's internal consistency.
      if (bucket !== 'tutorFeedback' && event.targetCorrectionId !== null && event.targetCorrectionId !== undefined &&
          droppedCorrectionIds.has(event.targetCorrectionId)) {
        conflicts.push({
          kind: 'assessment', path: `${bucket}.${event.id}`, kept: null, incoming: event, at,
          message: '评价目标修正的身份已冲突未保留，评价一并保留待核对而不写入',
        });
        if (bucket === 'tutorAssessments') droppedAssessmentIds.add(event.id);
        continue;
      }
      const kept = seen.get(event.id);
      if (kept === undefined) {
        // The same event id under a different attempt names a different
        // evaluation; keep the existing one and report the incoming version.
        const owner = registry.get(event.id);
        if (owner && (owner.promptId !== promptId || owner.attemptId !== combined.id)) {
          conflicts.push({
            kind: bucket === 'tutorFeedback' ? 'tutor-feedback' : 'assessment', path: `${bucket}.${event.id}`,
            kept: owner.event, incoming: event, at, message: '评价事件身份已用于其他作答，保留原记录并报告传入版本',
          });
          if (bucket === 'tutorAssessments') droppedAssessmentIds.add(event.id);
          continue;
        }
        const targetKept = bucket === 'selfAssessments' && [...seen.values()].find(e => e.targetCorrectionId === event.targetCorrectionId);
        const legacyKept = bucket === 'selfAssessments' && event.targetCorrectionId === null && RATINGS.includes(existing.rating);
        if (targetKept || legacyKept) {
          conflicts.push({ kind: 'assessment', path: `${bucket}.${existing.id}`, kept: targetKept || existing.assessment || existing.rating,
            incoming: event, at, message: '同一作答目标已有自评，保留当前评价并报告传入版本' });
          continue;
        }
        seen.set(event.id, event);
        registerMergeEvent(registries, bucket, promptId, combined.id, event);
        continue;
      }
      if (stableStringify(kept) !== stableStringify(event)) {
        conflicts.push({
          kind: bucket === 'tutorFeedback' ? 'tutor-feedback' : 'assessment',
          path: `${bucket}.${event.id}`, kept, incoming: event, at,
          message: '同一评价事件身份的内容或来源冲突，保留现有事件',
        });
      }
    }
    if (seen.size > 0 || combined[bucket] !== undefined || incoming[bucket] !== undefined) {
      combined[bucket] = [...seen.values()];
    }
  }
  const originalSelf = (combined.selfAssessments ?? [])
    .filter((event) => event.targetCorrectionId === null)
    .sort((a, b) => new Date(a.at) - new Date(b.at) || (a.id < b.id ? -1 : 1))[0];
  // A separate self assessment is the real evidence; the compatibility scalar
  // is only a derived copy of it. If the incoming branch carried such an event
  // but the merge dropped it (identity collision), its scalar rating must not
  // sneak the rejected event back in. The scalar fallback therefore applies
  // only to a genuinely legacy incoming record with no separate self event.
  const incomingHasOriginalSelf = (incoming.selfAssessments ?? []).some((event) => event.targetCorrectionId === null);
  if (originalSelf) {
    if (existing.rating === null || existing.rating === originalSelf.rating) {
      combined.rating = originalSelf.rating;
      combined.assessment = {
        rating: originalSelf.rating, at: originalSelf.at, source: originalSelf.source,
        id: originalSelf.id, targetCorrectionId: null,
      };
    } else {
      conflicts.push({ kind: 'assessment', path: `assessments.${existing.id}`, kept: existing.rating, incoming: originalSelf.rating, at, message: '自评冲突，保留现有自评' });
    }
  } else if (existing.rating === null && RATINGS.includes(incoming.rating) && !incomingHasOriginalSelf) {
    combined.rating = incoming.rating;
    if (incoming.assessment) combined.assessment = incoming.assessment;
  } else if (!incomingHasOriginalSelf && existing.rating !== incoming.rating && incoming.rating !== null) {
    conflicts.push({ kind: 'assessment', path: `assessments.${existing.id}`, kept: existing.rating, incoming: incoming.rating, at, message: '自评冲突，保留现有自评' });
  }
  void promptId;
}

function mergeKeyedOverlays(currentBucket, incomingBucket, kind, conflicts, at) {
  const out = { ...currentBucket };
  for (const [id, incoming] of Object.entries(incomingBucket)) {
    const current = out[id];
    if (current === undefined) {
      out[id] = incoming;
      continue;
    }
    if (stableStringify(current) !== stableStringify(incoming)) {
      // Both branches edited the same overlay. Keep the current durable edit and
      // surface the divergence rather than silently overwriting by revision.
      conflicts.push({
        id: `cf-${shortHash(`${kind}|${id}|${stableStringify(current)}`, 10)}`,
        kind,
        path: `${kind}.${id}`,
        kept: current,
        incoming,
        message: `导入状态与现有状态的 ${kind}（${id}）不同，保留现有版本并报告冲突`,
        at,
      });
      continue;
    }
    out[id] = current;
  }
  return out;
}

function mergeSchedules(currentSchedules, incomingSchedules, model, state, conflicts, at) {
  const out = { ...currentSchedules };
  for (const [promptId, incoming] of Object.entries(incomingSchedules)) {
    // An arrangement with no real answer behind it has no historical meaning
    // to preserve. Match the standalone import boundary for schedule-only data.
    if (incoming.assessmentSource === 'tutor' || !(state.attempts[promptId] ?? []).some(scheduleEffectiveAssessment)) continue;
    const current = out[promptId];
    let chosen = incoming;
    if (current) {
      const curAt = new Date(current.lastAt ?? 0).getTime();
      const incAt = new Date(incoming.lastAt ?? 0).getTime();
      chosen = incAt >= curAt ? incoming : current;
      if (stableStringify(current) !== stableStringify(incoming)) {
        conflicts.push({
          id: `cf-${shortHash(`schedule|${promptId}|${stableStringify(chosen)}`, 10)}`,
          kind: 'schedule', id: promptId, path: `schedules.${promptId}`,
          kept: chosen, other: chosen === incoming ? current : incoming,
          message: `问题 ${promptId} 的复习安排存在分歧，保留较新一次作答的安排并报告`,
          at,
        });
      }
    }
    const latestAttempt = (state.attempts[promptId] ?? []).at(-1) ?? null;
    out[promptId] = resetStreakIfContentChanged(chosen, latestAttempt, promptFingerprint(model, state, promptId));
  }
  return out;
}

// A "modern" answer records its own submission metadata or separate evaluation
// events, so its arrangement is always derivable from the events themselves.
// Only the pre-separation combined answer/rating records still rely on the
// historical schedule merge.
function isModernAttemptStream(attempts) {
  return (attempts ?? []).some((attempt) =>
    attempt.submittedAt !== undefined ||
    attempt.submission !== undefined ||
    (attempt.selfAssessments?.length ?? 0) > 0 ||
    (attempt.tutorAssessments?.length ?? 0) > 0);
}

function recomputeImportedSchedules(state, model, priorSchedules) {
  for (const [promptId, attempts] of Object.entries(state.attempts ?? {})) {
    if (!isModernAttemptStream(attempts)) continue;
    if (!resolvePrompt(model, state, promptId)) continue;
    const replay = asEmberError(() =>
      scheduleReplay(attempts, promptId, promptFingerprint(model, state, promptId)));
    if (replay) state.schedules[promptId] = replay;
    else if (priorSchedules[promptId]) state.schedules[promptId] = cloneState(priorSchedules[promptId]);
    else delete state.schedules[promptId];
  }
}

export function mergePracticeSessions(current, incoming, conflicts, at) {
  const out = cloneState(current);
  for (const [id, session] of Object.entries(incoming)) {
    const existing = ownEntry(out, id);
    if (existing === undefined) { setOwn(out, id, session); continue; }
    if (existing.promptId !== session.promptId || existing.fingerprint !== session.fingerprint ||
        (existing.roundId ?? undefined) !== (session.roundId ?? undefined) ||
        (existing.taskId ?? undefined) !== (session.taskId ?? undefined) ||
        existing.attemptId && session.attemptId && existing.attemptId !== session.attemptId) {
      conflicts.push({ kind: 'practice', path: `practiceSessions.${id}`, kept: existing, incoming: session, at, message: '练习身份冲突，保留两版供核对' });
      continue;
    }
    const combined = { ...existing, assistance: assistanceSources([...existing.assistance, ...session.assistance]) };
    // Step hints merge to the higher (more revealed) level. The field stays
    // absent when no branch recorded one, so an idempotent import of an
    // unchanged legacy session does not rewrite the record.
    const existingLevel = Number.isInteger(existing.hintLevel) ? existing.hintLevel : 0;
    const sessionLevel = Number.isInteger(session.hintLevel) ? session.hintLevel : 0;
    const level = Math.max(existingLevel, sessionLevel);
    if (level > 0) combined.hintLevel = level;
    else delete combined.hintLevel;
    if (existing.draft !== session.draft && !existing.attemptId) {
      conflicts.push({ kind: 'practice-draft', path: `practiceSessions.${id}.draft`, kept: existing.draft, incoming: session.draft, at, message: '练习草稿不同，保留当前草稿与传入版本' });
    }
    if (!existing.attemptId && session.attemptId) { combined.attemptId = session.attemptId; combined.draft = session.draft; }
    setOwn(out, id, combined);
  }
  return out;
}

/**
 * Merge two interaction-position maps. A position is a single learner fact per
 * interaction, so a same-id divergence keeps the newer `updatedAt` (a tie keeps
 * the current branch) and records the other branch's record in `conflicts`.
 * Both versions stay readable in the archive; nothing is silently overwritten
 * and no other interaction's position is affected.
 */
export function mergeInteractionPositions(current, incoming, conflicts, at) {
  return interactionMergePositionsShared(current, incoming, conflicts, at);
}

export function mergeImportedState(current, incoming, model, at = nowIso()) {
  // Identity/schema are validated, but orphaned overlays are NOT rejected here:
  // import preserves immutable attempts and reports divergences instead of
  // silently replacing a newer branch by revision count.
  const normalized = normalizeState(incoming, model);
  const merged = cloneState(current);
  const conflicts = [...(current.conflicts ?? [])];

  merged.attempts = mergeAttemptHistory(current.attempts ?? {}, normalized.attempts ?? {}, conflicts, at);
  merged.practiceSessions = mergePracticeSessions(current.practiceSessions ?? {}, normalized.practiceSessions ?? {}, conflicts, at);
  // Walkthrough positions are learner records like notes and drafts: a new
  // position is adopted and a divergent same-id position keeps the newer one
  // while the other branch's record is reported (never silently dropped).
  merged.interactionPositions = mergeInteractionPositions(current.interactionPositions ?? {}, normalized.interactionPositions ?? {}, conflicts, at);
  merged.learningRounds = mergeRounds(current.learningRounds ?? {}, normalized.learningRounds ?? {}, conflicts, at);
  // Review requests are agent-side records. A CLI import (an agent-side path)
  // may carry them across archives, so new requests are adopted and a divergent
  // same-id request keeps the current one and is reported — never silently
  // replaced. The HTTP import route drops the whole bucket before this point.
  // They are merged against the answers that actually survived the merge, so a
  // request naming a dropped answer is reported instead of producing an archive
  // the public reader refuses.
  merged.reviewRequests = mergeReviewRequests(current.reviewRequests ?? {}, normalized.reviewRequests ?? {}, conflicts, at, merged.attempts, normalized.attempts ?? {});
  // Teaching corrections are agent-side records exactly like review requests:
  // a CLI import (an agent-side path) adopts new corrections across archives,
  // and a divergent same-id record keeps the current one and is reported —
  // correction history is never rewritten. The HTTP import route drops the
  // whole bucket before this point, so a browser session can never mint one.
  merged.teachingCorrections = correctionMergeTeachingShared(
    current.teachingCorrections ?? {}, normalized.teachingCorrections ?? {}, conflicts, at, true);
  // A round already active on this branch stays active: importing another
  // archive must not silently switch the learner's current route.
  merged.activeRoundId = current.activeRoundId ?? normalized.activeRoundId ?? null;
  merged.conceptRevisions = mergeKeyedOverlays(current.conceptRevisions ?? {}, normalized.conceptRevisions ?? {}, 'conceptRevisions', conflicts, at);
  merged.relationRevisions = mergeKeyedOverlays(current.relationRevisions ?? {}, normalized.relationRevisions ?? {}, 'relationRevisions', conflicts, at);
  // Notes keep the current visible version and union version histories, so a
  // browser cache or independent archive cannot silently replace learner text.
  merged.explanations = insightMergeNotesShared(current.explanations ?? {}, normalized.explanations ?? {}, conflicts, at, 'explanations');
  merged.summaries = insightMergeNotesShared(current.summaries ?? {}, normalized.summaries ?? {}, conflicts, at, 'summaries');
  merged.ownQuestions = mergeKeyedOverlays(current.ownQuestions ?? {}, normalized.ownQuestions ?? {}, 'ownQuestions', conflicts, at);
  merged.schedules = mergeSchedules(current.schedules ?? {}, normalized.schedules ?? {}, model, merged, conflicts, at);
  // An import may not smuggle in a review date: for any stream that records
  // real submissions or separate evaluations, the arrangement is recomputed
  // from the merged, validated answer history instead of trusted as data.
  // Legacy-only prompts keep the historical merge above.
  recomputeImportedSchedules(merged, model, current.schedules ?? {});
  merged.conceptEvidence = mergeEvidence(current.conceptEvidence ?? {}, normalized.conceptEvidence ?? {}, 'conceptEvidence', conflicts, at);
  merged.promptEvidence = mergeEvidence(current.promptEvidence ?? {}, normalized.promptEvidence ?? {}, 'promptEvidence', conflicts, at);
  // Orphans are identity notices (kind+id); a repeated import must not stack a
  // second copy of an orphan it already reported.
  merged.orphans = dedupeOrphans([...(current.orphans ?? []), ...(normalized.orphans ?? [])]);
  merged.modelRevision = Math.max(current.modelRevision ?? 1, normalized.modelRevision ?? 1);
  merged.modelFingerprint = model.modelFingerprint;
  merged.conflicts = dedupeConflicts(conflicts);
  // Fail closed: never persist a merge the public reader cannot reopen. Every
  // request retained above resolves against the merged answers, so this is a
  // safety net that turns a future merge bug into a refused write instead of an
  // unreadable archive silently replacing the learner's history.
  validateStateShape(merged, model);
  // A completely identical import changes no effective state: keep the current
  // archive (revision and updatedAt included) instead of bumping a new revision.
  if (sameEffectiveState(merged, current)) return current;
  merged.revision = Math.max(current.revision ?? 0, normalized.revision ?? 0) + 1;
  merged.updatedAt = at;
  return merged;
}

// Compare two archives ignoring the bookkeeping fields that advance on every
// write. Used to decide whether an import actually changed durable content.
function sameEffectiveState(a, b) {
  const strip = (state) => {
    const copy = cloneState(state);
    delete copy.revision;
    delete copy.updatedAt;
    return copy;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

// Rounds are stable learner-facing records: an import adds new rounds and keeps
// the branch's existing round, reporting any divergence instead of silently
// replacing the current route.
function mergeRounds(current, incoming, conflicts, at) {
  const out = { ...current };
  for (const [id, round] of Object.entries(incoming)) {
    const existing = ownEntry(out, id);
    if (existing === undefined) { setOwn(out, id, round); continue; }
    if (stableStringify(existing) !== stableStringify(round)) {
      conflicts.push({
        id: `cf-${shortHash(`learning-round|${id}|${stableStringify(existing)}`, 10)}`,
        kind: 'learning-round', id, path: `learningRounds.${id}`,
        kept: existing, incoming: round, at,
        message: `轮次设置（${id}）存在分歧，保留当前路线并报告另一版；请查看后调整`,
      });
    }
  }
  return out;
}

// Index every attempt in an `attempts` bucket by its archive-wide id. A review
// member only ever names one immutable answer, so the first owner wins exactly
// like the merge registries above.
function attemptIndexById(attempts) {
  const index = new Map();
  for (const list of Object.values(attempts ?? {})) {
    for (const attempt of list ?? []) {
      if (isRecord(attempt) && typeof attempt.id === 'string' && !index.has(attempt.id)) index.set(attempt.id, attempt);
    }
  }
  return index;
}

function sameAssistanceFacts(a, b) {
  const left = Array.isArray(a) ? [...a].sort() : [];
  const right = Array.isArray(b) ? [...b].sort() : [];
  return stableStringify(left) === stableStringify(right);
}

// The portable validator's frozen-answer rule: a member must resolve to the
// exact answer (prompt, text, time, independence, assistance) it was taken
// from, or the archive is unreadable. Merging reuses the same rule so an
// unresolvable request is caught before it is ever written.
function reviewMemberMatchesAttempt(member, attempt) {
  if (!isRecord(member) || !isRecord(attempt)) return false;
  if (attempt.promptId !== member.promptId) return false;
  if (attempt.answer !== member.answer) return false;
  if ((attempt.at ?? null) !== (member.at ?? null)) return false;
  if ((attempt.assisted === true) !== (member.assisted === true)) return false;
  return sameAssistanceFacts(attempt.assistance, member.assistance);
}

function reviewRequestMembersResolve(request, attemptById) {
  if (!isRecord(request) || !Array.isArray(request.members)) return false;
  const seen = new Set();
  for (const member of request.members) {
    if (!isRecord(member) || typeof member.attemptId !== 'string' || typeof member.promptId !== 'string') return false;
    const key = `${member.promptId}|${member.attemptId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const attempt = attemptById.get(member.attemptId);
    if (!attempt || !reviewMemberMatchesAttempt(member, attempt)) return false;
  }
  return true;
}

// The fields a member records once it is resolved. Everything else is frozen
// snapshot: question, reference, criteria, concept/kind/origin, answer,
// submission time, assistance, corrections and fingerprints. Two branches may
// only merge a member whose full frozen snapshot still matches, so a divergent
// completion can never overwrite what the tutor was asked to judge.
const REVIEW_MEMBER_RESOLUTION_FIELDS = ['status', 'reason', 'feedback', 'resolvedAt'];

function reviewMemberFrozenFacts(member) {
  const facts = { ...member };
  for (const field of REVIEW_MEMBER_RESOLUTION_FIELDS) delete facts[field];
  return facts;
}

function reviewMemberFrozenFactsMatch(a, b) {
  if (!isRecord(a) || !isRecord(b)) return false;
  return stableStringify(reviewMemberFrozenFacts(a)) === stableStringify(reviewMemberFrozenFacts(b));
}

// Adopt only the resolution the other branch recorded; the current member's
// frozen facts are authoritative and are never replaced.
function resolveReviewMember(currentMember, incomingMember) {
  return {
    ...currentMember,
    status: incomingMember.status,
    reason: incomingMember.reason ?? null,
    feedback: incomingMember.feedback ?? null,
    resolvedAt: incomingMember.resolvedAt ?? null,
  };
}

// The merged archive must carry the *exact* tutor assessment and feedback the
// incoming branch recorded for this completion, not merely an event that reuses
// the same id. Deep equality is required: a same-id divergence keeps the current
// event, so the incoming rating/basis it disagrees with can never be adopted.
function mergedEventEquals(events, expected) {
  return (Array.isArray(events) ? events : []).some((event) =>
    isRecord(event) && event.id === expected.id && stableStringify(event) === stableStringify(expected));
}

function tutorCompletionHasAcceptedBasis(mergedAttempt, incomingAttempt, member) {
  if (!isRecord(mergedAttempt) || !isRecord(incomingAttempt) || !isRecord(member.feedback)) return false;
  const target = member.feedback.targetCorrectionId ?? null;
  const rating = member.feedback.rating ?? null;
  const basis = member.feedback.basis ?? null;
  const sourceAssessments = Array.isArray(incomingAttempt.tutorAssessments) ? incomingAttempt.tutorAssessments : [];
  const sourceFeedback = Array.isArray(incomingAttempt.tutorFeedback) ? incomingAttempt.tutorFeedback : [];
  return sourceAssessments.some((assessment) => {
    if (!isRecord(assessment) || assessment.source !== 'tutor') return false;
    if ((assessment.targetCorrectionId ?? null) !== target) return false;
    if (assessment.rating !== rating) return false;
    const feedback = sourceFeedback.find((entry) => isRecord(entry) && entry.assessmentId === assessment.id);
    if (!feedback || (feedback.text ?? null) !== basis) return false;
    return mergedEventEquals(mergedAttempt.tutorAssessments, assessment) &&
      mergedEventEquals(mergedAttempt.tutorFeedback, feedback);
  });
}

// Even a brand-new request may not materialise a completed member unless the
// merged answers still carry the accepted tutor assessment and feedback behind
// it. A conflicting correction that drops the assessment therefore keeps the new
// request out instead of importing an unsupported completion.
function reviewRequestCompletionsHaveBasis(request, mergedById, incomingById) {
  if (!isRecord(request) || !Array.isArray(request.members)) return false;
  return request.members.every((member) => member.status !== 'completed' ||
    tutorCompletionHasAcceptedBasis(mergedById.get(member.attemptId), incomingById.get(member.attemptId), member));
}

function reviewRequestStatus(members) {
  if (!Array.isArray(members) || members.length === 0) return 'open';
  const completed = members.filter((member) => member.status === 'completed').length;
  if (completed === members.length) return 'completed';
  return completed > 0 ? 'partial' : 'open';
}

// The time a member was resolved, used to refuse an older failure resolution.
// An absent or unparsable stamp sorts oldest so it can never beat a real one.
function reviewResolutionTime(member) {
  const value = member?.resolvedAt ?? member?.at ?? null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

// Merge one reused request id. The current request's frozen scope, snapshot and
// member order are authoritative; a member the incoming branch finished is
// adopted only when its frozen facts match and a real accepted tutor assessment
// backs the completion. An already-completed result is never rewritten, and
// every divergence is reported instead of applied.
function mergeReviewRequest(existing, incoming, mergedById, incomingById, conflicts, at, requestId) {
  const merged = cloneState(existing);
  const keep = (path, kept, inc, message) => conflicts.push({
    id: `cf-${shortHash(`review-request|${requestId}|${path}|${stableStringify(inc ?? null)}`, 10)}`,
    kind: 'review-request', id: requestId, path, kept, incoming: inc ?? null, at, message,
  });
  // The request-level frozen identity (scope, round, creation time, content
  // snapshot) is one indivisible fact. If the incoming branch froze a different
  // snapshot, none of its resolutions were judged against this request's frozen
  // facts, so the whole incoming version is reported and none of it is adopted.
  let scopeDiverged = false;
  for (const field of ['scope', 'roundId', 'createdAt', 'snapshot']) {
    if (stableStringify(existing[field]) !== stableStringify(incoming[field])) {
      scopeDiverged = true;
      keep(`reviewRequests.${requestId}.${field}`, existing[field] ?? null, incoming[field] ?? null,
        `复核请求（${requestId}）的冻结范围或内容快照不同，保留当前冻结范围并报告另一版`);
    }
  }
  if (scopeDiverged) return merged;
  const incomingByKey = new Map();
  for (const member of Array.isArray(incoming.members) ? incoming.members : []) {
    if (isRecord(member) && typeof member.attemptId === 'string') {
      incomingByKey.set(`${member.promptId}|${member.attemptId}`, member);
    }
  }
  const members = Array.isArray(merged.members) ? merged.members : [];
  let changed = false;
  for (let index = 0; index < members.length; index += 1) {
    const currentMember = members[index];
    const inc = incomingByKey.get(`${currentMember.promptId}|${currentMember.attemptId}`);
    if (!inc) continue;
    incomingByKey.delete(`${currentMember.promptId}|${currentMember.attemptId}`);
    if (currentMember.status === 'completed') {
      // A finished member is immutable: a different completion, or any attempt
      // to downgrade it back to a failure, is reported and never applied.
      if (inc.status !== 'pending' && stableStringify(resolveReviewMember(currentMember, inc)) !== stableStringify(currentMember)) {
        keep(`reviewRequests.${requestId}.members[${index}]`, currentMember, inc,
          '已完成的复核结果不可改写，保留当前结果并报告另一版');
      }
      continue;
    }
    if (!reviewMemberFrozenFactsMatch(currentMember, inc)) {
      keep(`reviewRequests.${requestId}.members[${index}]`, currentMember, inc,
        '复核成员的冻结原答或修正快照不同，保留当前快照并报告另一版');
      continue;
    }
    if (inc.status === 'pending') continue;
    const candidate = resolveReviewMember(currentMember, inc);
    // An identical resolution is a true no-op: adopting it would set a fresh
    // updatedAt on every repeated import and burn a revision for no change.
    if (stableStringify(candidate) === stableStringify(currentMember)) continue;
    if (inc.status === 'completed') {
      if (!tutorCompletionHasAcceptedBasis(mergedById.get(currentMember.attemptId), incomingById.get(currentMember.attemptId), inc)) {
        keep(`reviewRequests.${requestId}.members[${index}]`, currentMember, inc,
          '传入的完成结果缺少合并后仍存在的真实导师评价与反馈，保留待处理并报告');
        continue;
      }
    } else if (currentMember.status !== 'pending' &&
        reviewResolutionTime(inc) <= reviewResolutionTime(currentMember)) {
      // A failure resolution is never allowed to overwrite a newer existing
      // resolution (and an older completion is protected by the branch above).
      keep(`reviewRequests.${requestId}.members[${index}]`, currentMember, inc,
        '传入的失败决议不早于当前决议，保留当前决议并报告另一版');
      continue;
    }
    members[index] = candidate;
    changed = true;
  }
  for (const [key, inc] of incomingByKey) {
    keep(`reviewRequests.${requestId}.members.${key}`, null, inc,
      `复核请求（${requestId}）的传入成员不在当前冻结范围内，保留当前范围并报告另一版`);
  }
  if (changed) {
    merged.status = reviewRequestStatus(members);
    merged.updatedAt = at;
  }
  return merged;
}

// Review requests are stable learner-facing records with a fixed member set. An
// import adds unseen requests — but only when every member still resolves
// against the merged answers, otherwise the request is reported and left out so
// the archive stays readable. For a reused id the current frozen scope and
// completed results are authoritative while legal late member completions the
// other branch recorded are adopted.
function mergeReviewRequests(current, incoming, conflicts, at, mergedAttempts, incomingAttempts) {
  const out = { ...current };
  const mergedById = attemptIndexById(mergedAttempts);
  const incomingById = attemptIndexById(incomingAttempts);
  for (const [id, request] of Object.entries(incoming)) {
    const existing = ownEntry(out, id);
    if (existing === undefined) {
      const resolvable = reviewRequestMembersResolve(request, mergedById);
      const completionsBacked = resolvable && reviewRequestCompletionsHaveBasis(request, mergedById, incomingById);
      if (!resolvable || !completionsBacked) {
        conflicts.push({
          id: `cf-${shortHash(`review-request|${id}|${stableStringify(request)}`, 10)}`,
          kind: 'review-request', id, path: `reviewRequests.${id}`,
          kept: null, incoming: request, at,
          message: resolvable
            ? `复核请求（${id}）的完成成员缺少合并后仍存在的真实导师评价与反馈，不写入并保留待核对`
            : `复核请求（${id}）引用的作答在合并后不存在或与原答不一致，不写入并保留待核对`,
        });
        continue;
      }
      setOwn(out, id, request);
      continue;
    }
    setOwn(out, id, mergeReviewRequest(existing, request, mergedById, incomingById, conflicts, at, id));
  }
  return out;
}

export function conceptDisplayTitle(model, state, conceptId) {
  return state.conceptRevisions?.[conceptId]?.title ?? model.byId.get(conceptId)?.title ?? conceptId;
}

// Public round entry points. The algorithms live in the portable round module;
// these wrappers only translate its plain coded errors into EmberError so the
// CLI and HTTP surfaces keep one error contract.
export function applyLearningRound(state, model, input, at = nowIso()) {
  return asEmberError(() => roundApplyRound(state, roundModelWithOwnFingerprints(model, state), input, at));
}

export function learningRoundView(state, model, roundId) {
  return asEmberError(() => roundViewOf(state, roundModelWithOwnFingerprints(model, state), roundId));
}

export function validateLearningRoundBinding(state, model, input) {
  return asEmberError(() => roundValidateBinding(state, roundModelWithOwnFingerprints(model, state), input));
}

export function validateLearningRounds(state, model) {
  return asEmberError(() => roundValidateRounds(state, model));
}

// Public progressive-practice selection. The algorithm lives in the portable
// round module (shared with the page); this wrapper only translates its plain
// coded errors into EmberError so the CLI keeps one error contract.
export function practiceSelection(state, model, conceptId) {
  return asEmberError(() => roundPracticeSelection(state, roundModelWithOwnFingerprints(model, state), conceptId));
}

// Public read-only review-plan selection. The algorithm lives in the portable
// round module so the CLI and the page preview the same schedule budget.
export function reviewPlan(state, model, options, at = nowIso()) {
  return asEmberError(() => roundReviewPlan(state, roundModelWithOwnFingerprints(model, state), options, at));
}

/**
 * Record the learner's current walkthrough position. This is observation only:
 * it never writes an attempt, rating, hint, note or mastery evidence, and it
 * never touches another interaction's position (the map is keyed by
 * interactionId). The stored `contentSignature` is the exact normalized
 * interaction string, so a later reader restores the position only while the
 * authored content is unchanged. An unknown interaction or step is refused with
 * a readable usage error instead of writing a position that cannot be reopened.
 */
export function applyInteractionPosition(state, model, input, at = nowIso()) {
  // The rules live in the shared library; this wrapper only translates its coded
  // usage errors into the backend's EmberError contract.
  return asEmberError(() => interactionRecordPositionShared(state, model, input, at));
}

/**
 * Read-only resolution of the stored position for one interaction: the saved
 * record plus the shared step read model (restored / stale / initial step).
 * Returns `present:false` when the archive has no position for it yet.
 */
export function interactionPositionView(state, model, interactionId) {
  const interaction = interactionLookupById(model, interactionId);
  const saved = ownEntry(state.interactionPositions ?? {}, interactionId) ?? null;
  return {
    interactionId,
    interactionPresent: Boolean(interaction),
    present: saved !== null,
    saved,
    view: interaction ? interactionStepViewOf(interaction, saved) : null,
  };
}

/**
 * Build the fingerprint bundle the pure tutor-review module needs. It mirrors
 * the payload the page and server already publish, so the backend and the page
 * judge staleness against exactly the same content version.
 */
function reviewFingerprints(model, state) {
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

// Public concentrated-review entry points. The algorithms live in the portable
// tutor-review module; these wrappers translate its plain coded errors into
// EmberError and inject the trusted tutor-assessment recorder so review-item
// reuses the exact task-05 evaluation path.
export function startReviewRequest(state, model, input, at = nowIso()) {
  const fingerprints = reviewFingerprints(model, state);
  return asEmberError(() => tutorStartReviewRequest(state, model, input, at, fingerprints));
}

export function applyReviewItem(state, model, input, at = nowIso()) {
  const fingerprints = reviewFingerprints(model, state);
  const hooks = (nextState, assessment, assessedAt) =>
    applyTutorAssessment(nextState, model, assessment, assessedAt);
  return asEmberError(() => tutorApplyReviewItem(state, input, at, fingerprints, hooks));
}

export function tutorReviewSummary(state, roundId, fingerprints) {
  return asEmberError(() => tutorSummaryOf(state, roundId, fingerprints));
}

export function relationDisplayLabel(model, state, relationId) {
  const relation = model.relations.find((item) => item.id === relationId);
  return state.relationRevisions?.[relationId]?.label ?? relation?.label ?? '';
}

/**
 * Read-only view used by the generated page: mastery labels stay conservative.
 * - Concept mastery only comes from active (current-fingerprint) tutor evidence.
 * - Stale evidence is retained historically but never shown as active mastery.
 * - Unreviewed attempts show as "pending review" instead of inflating mastery.
 */
export function stateView(state, model) {
  const conceptStatus = {};
  for (const concept of model.concepts) {
    const evidence = state.conceptEvidence?.[concept.id];
    const active = isConceptEvidenceActive(model, state, concept.id, evidence);
    const hasStatus = isRecord(evidence) && evidence.status && evidence.status !== 'unknown';
    const promptIds = model.prompts.filter((p) => p.conceptId === concept.id).map((p) => p.id);
    const ownIds = Object.values(state.ownQuestions ?? {})
      .filter((q) => q.conceptId === concept.id && !model.prompts.some((p) => p.id === q.id))
      .map((q) => q.id);
    const activeAttempts = [...promptIds, ...ownIds].flatMap((id) => activeAttemptsFor(model, state, id));
    if (hasStatus && active) {
      conceptStatus[concept.id] = {
        status: evidence.status, source: 'tutor', note: evidence.note, at: evidence.at,
        attemptIds: evidence.attemptIds ?? [],
      };
    } else if (hasStatus) {
      conceptStatus[concept.id] = {
        status: 'unknown', source: null,
        note: '概念内容已更新，原有导师证据失效，需要重新作答后再复核',
        at: evidence.at, staleEvidence: { status: evidence.status, note: evidence.note, at: evidence.at },
      };
    } else if (activeAttempts.length > 0) {
      conceptStatus[concept.id] = {
        status: 'pending-review', source: 'learner', note: '有作答记录，等待复核',
        at: activeAttempts[activeAttempts.length - 1].at, attempts: activeAttempts.length,
      };
    } else {
      conceptStatus[concept.id] = { status: 'unknown', source: null, note: '尚无证据', at: null };
    }
  }
  const prompts = {};
  const allPrompts = [
    ...model.prompts,
    ...Object.values(state.ownQuestions ?? {})
      .filter((q) => model.byId.has(q.conceptId) && !model.prompts.some((p) => p.id === q.id))
      .map((q) => ({
        id: q.id, conceptId: q.conceptId, kind: 'recall', question: q.text, answer: '', criteria: [], origin: 'learner',
      })),
  ];
  for (const prompt of allPrompts) {
    const attempts = state.attempts[prompt.id] ?? [];
    const rawEvidence = state.promptEvidence?.[prompt.id] ?? null;
    const hasStatus = isRecord(rawEvidence) && rawEvidence.status && rawEvidence.status !== 'unknown';
    const evidenceActive = hasStatus && isPromptEvidenceActive(model, state, prompt.id, rawEvidence);
    prompts[prompt.id] = {
      id: prompt.id,
      conceptId: prompt.conceptId,
      origin: prompt.origin ?? 'model',
      attempts: attempts.length,
      lastAttempt: attempts.length > 0 ? attempts[attempts.length - 1] : null,
      schedule: state.schedules[prompt.id] ?? null,
      evidence: evidenceActive ? rawEvidence : null,
      staleEvidence: hasStatus && !evidenceActive ? rawEvidence : null,
      stale: isPromptStale(model, state, prompt.id),
    };
  }
  return { conceptStatus, prompts };
}
