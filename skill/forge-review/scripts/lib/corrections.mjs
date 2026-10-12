// Pure teaching-correction logic shared by the Node backend and the browser
// viewer.
//
// This module MUST stay dependency-free and portable: it may not import any
// other file and may not touch host-only APIs (file system, path, crypto,
// process or network). `build` strips the leading `export ` from every
// declaration and inlines the source into the viewer at the
// corrections-library marker, and the standalone viewer harnesses do the same.
// `state.mjs` loads the helpers directly, so the page and the backend share
// ONE rule set for validating, merging and reading teaching-correction
// records.
//
// A teaching correction is an agent-side, append-only record that a previous
// explanation conflicted with the source material: what was inaccurate, the
// re-read basis, the affected scope (explanations, request examples,
// exercises, reference answers, criteria, learning records) with per-item
// handling, and follow-up attempts arranged after the correction. It never
// mutates an attempt, rating, schedule or evidence record, and it can never
// promote a historical answer to an independent success.
//
// Internal helpers are all `correction*`-prefixed so they can never shadow a
// viewer or core helper of the same purpose.

var CORRECTION_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];
// The six impact categories of acceptance criterion 2: teaching explanations,
// request examples, exercises, reference answers, judgement criteria and
// learning records. The first two resolve against model concepts, the next
// three against author prompts, and `record` against archived attempts.
var CORRECTION_KINDS = ['explanation', 'example', 'exercise', 'reference', 'criteria', 'record'];
// Only the agent-side CLI records teaching corrections today. The browser can
// never mint one (the HTTP import route drops the bucket), so the source
// enum has a single member — kept as a list so a future agent surface does
// not silently reuse 'browser'.
var CORRECTION_SOURCES = ['cli'];
var CORRECTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function correctionHasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function correctionIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function correctionClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function correctionFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

function correctionReject(context, code, message, path) {
  var fail = context && typeof context.fail === 'function' ? context.fail : correctionFail;
  throw fail(code, message, path);
}

function correctionText(value, context, message, path) {
  if (typeof value !== 'string' || value.trim() === '') correctionReject(context, 'E_STATE', message, path);
  return value.trim();
}

function correctionOptionalText(value, context, message, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') correctionReject(context, 'E_STATE', message, path);
  var trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function correctionValidTime(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(new Date(value).getTime());
}

function correctionNullMap() {
  return Object.create(null);
}

function correctionSetOwn(bucket, key, value) {
  Object.defineProperty(bucket, key, {
    value: value, enumerable: true, writable: true, configurable: true,
  });
  return bucket;
}

// Key order is sorted at every level so independently serialized values have a
// single canonical text form (same contract as the archive's stable
// serialization).
function correctionStableSortValue(value) {
  if (Array.isArray(value)) return value.map(correctionStableSortValue);
  if (correctionIsRecord(value)) {
    var out = {};
    Object.keys(value).sort().forEach(function (key) {
      if (value[key] !== undefined) out[key] = correctionStableSortValue(value[key]);
    });
    return out;
  }
  return value;
}

function correctionStableStringify(value) {
  return JSON.stringify(correctionStableSortValue(value), null, 2) + '\n';
}

function correctionValidId(value, context, message, path) {
  var id = correctionText(value, context, message, path);
  if (!CORRECTION_ID_RE.test(id) || id.endsWith('-') || CORRECTION_FORBIDDEN_IDS.indexOf(id) !== -1) {
    correctionReject(context, 'E_STATE', message + '（只能是小写字母/数字/连字符，不以连字符结尾）', path);
  }
  return id;
}

// Validate one impact item. Shape and text presence are strict; whether the
// referenced concept/prompt/attempt still exists is a *write-time* rule (the
// apply function checks it against the live model/archive). Reads stay
// lenient so a later content removal keeps the correction history readable —
// the view reports the unresolved reference instead.
function correctionNormalizeImpact(entry, context, path) {
  if (!correctionIsRecord(entry)) correctionReject(context, 'E_STATE', '影响项必须是对象', path);
  var kind = entry.kind;
  if (CORRECTION_KINDS.indexOf(kind) === -1) {
    correctionReject(context, 'E_STATE', `影响项 kind 只能是 ${CORRECTION_KINDS.join('/')}`, path + '.kind');
  }
  return {
    kind: kind,
    id: correctionText(entry.id, context, '影响项 id 必须是非空字符串', path + '.id'),
    note: correctionText(entry.note, context, '影响项必须写明处理说明（note）', path + '.note'),
  };
}

function correctionNormalizeRecheck(entry, context, path) {
  if (!correctionIsRecord(entry)) correctionReject(context, 'E_STATE', '复核关联必须是对象', path);
  var out = {
    id: correctionValidId(entry.id, context, '复核关联 id 必须是非空字符串', path + '.id'),
    attemptId: correctionText(entry.attemptId, context, '复核关联必须指定 attemptId', path + '.attemptId'),
    note: correctionText(entry.note, context, '复核关联必须写明说明（note）', path + '.note'),
  };
  if (!correctionValidTime(entry.at)) {
    correctionReject(context, 'E_STATE', '复核关联时间不合法', path + '.at');
  }
  out.at = entry.at;
  return out;
}

// Validate and normalize one correction record. Returns a canonical clone.
function correctionNormalizeRecord(record, context, path) {
  if (!correctionIsRecord(record)) correctionReject(context, 'E_STATE', '教学纠错记录必须是对象', path);
  var out = {
    id: correctionValidId(record.id, context, '教学纠错记录 id 必须是非空字符串', path + '.id'),
    claim: correctionText(record.claim, context, '教学纠错必须写明先前不准确的讲解（claim）', path + '.claim'),
    correction: correctionText(record.correction, context, '教学纠错必须写明正确解释（correction）', path + '.correction'),
    // The re-read basis is what separates a correction from an apology: it
    // names the source range that was actually re-checked.
    basis: correctionText(record.basis, context, '教学纠错必须写明回读来源依据（basis）', path + '.basis'),
    sourceId: correctionOptionalText(record.sourceId, context, 'sourceId 需要是字符串', path + '.sourceId'),
    feedback: correctionOptionalText(record.feedback, context, 'feedback 需要是字符串', path + '.feedback'),
    noImpactReason: correctionOptionalText(record.noImpactReason, context, 'noImpactReason 需要是字符串', path + '.noImpactReason'),
  };
  if (!correctionValidTime(record.at)) {
    correctionReject(context, 'E_STATE', '教学纠错时间不合法', path + '.at');
  }
  out.at = record.at;
  if (record.source !== undefined && CORRECTION_SOURCES.indexOf(record.source) === -1) {
    correctionReject(context, 'E_STATE', `教学纠错来源只能是 ${CORRECTION_SOURCES.join('/')}`, path + '.source');
  }
  out.source = record.source === undefined ? 'cli' : record.source;
  if (!Array.isArray(record.impacts)) correctionReject(context, 'E_STATE', '影响范围 impacts 必须是数组', path + '.impacts');
  var seenImpacts = correctionNullMap();
  out.impacts = record.impacts.map(function (entry, index) {
    var impact = correctionNormalizeImpact(entry, context, path + '.impacts[' + index + ']');
    var key = impact.kind + '\u0000' + impact.id;
    if (correctionHasOwn(seenImpacts, key)) {
      correctionReject(context, 'E_STATE', `同一影响范围重复声明：${impact.kind}/${impact.id}`, path + '.impacts[' + index + ']');
    }
    seenImpacts[key] = true;
    return impact;
  });
  if (out.impacts.length === 0 && out.noImpactReason === null) {
    correctionReject(context, 'E_STATE',
      '没有声明任何影响范围时必须写明 noImpactReason 依据；说清“没有其他受影响内容”本身就是验收要求',
      path + '.noImpactReason');
  }
  // Recheck links are appended by the separate `recheck` action after real
  // follow-up attempts exist, so a fresh record omits them. An absent list
  // normalizes to [] so an idempotent replay of the original record file
  // compares equal to the stored record.
  var rechecks = record.rechecks === undefined || record.rechecks === null ? [] : record.rechecks;
  if (!Array.isArray(rechecks)) correctionReject(context, 'E_STATE', '复核关联 rechecks 必须是数组', path + '.rechecks');
  var seenRechecks = correctionNullMap();
  out.rechecks = rechecks.map(function (entry, index) {
    var recheck = correctionNormalizeRecheck(entry, context, path + '.rechecks[' + index + ']');
    if (correctionHasOwn(seenRechecks, recheck.id)) {
      correctionReject(context, 'E_STATE', `同一纠错记录内复核关联 id 重复：${recheck.id}`, path + '.rechecks[' + index + '].id');
    }
    seenRechecks[recheck.id] = true;
    return recheck;
  });
  return out;
}

/**
 * Validate the optional teaching-corrections bucket. An absent or null bucket
 * is a legacy archive and stays legal; a present bucket must be a well-formed
 * object whose every record passes the strict shape rules. Returns a
 * canonical clone.
 */
export function correctionValidateBucket(raw, context) {
  var ctx = context || {};
  if (raw === undefined || raw === null) return {};
  if (!correctionIsRecord(raw)) {
    correctionReject(ctx, 'E_STATE', 'teachingCorrections 必须是对象（旧档可省略该字段）', 'teachingCorrections');
  }
  var out = correctionNullMap();
  var seen = correctionNullMap();
  Object.keys(raw).forEach(function (id) {
    var record = correctionNormalizeRecord(raw[id], ctx, 'teachingCorrections.' + id);
    if (record.id !== id) {
      correctionReject(ctx, 'E_STATE', `教学纠错记录键 ${id} 与记录 id ${record.id} 不一致`, 'teachingCorrections.' + id + '.id');
    }
    if (correctionHasOwn(seen, id)) {
      correctionReject(ctx, 'E_STATE', `教学纠错记录 id 重复：${id}`, 'teachingCorrections.' + id);
    }
    seen[id] = true;
    correctionSetOwn(out, id, record);
  });
  return out;
}

/**
 * Merge two teaching-correction buckets. Records are agent-side authority:
 * `trustedIncoming` marks an agent-side CLI import (new records are adopted);
 * an untrusted browser import or cache reconcile never adopts a record it did
 * not already have and reports it instead. A same-id divergence keeps the
 * current record — a correction is immutable history — and reports the
 * incoming version.
 */
export function correctionMergeTeaching(currentBucket, incomingBucket, conflicts, at, trustedIncoming) {
  var ctx = { fail: correctionFail };
  var current = correctionValidateBucket(currentBucket, ctx);
  var incoming = correctionValidateBucket(incomingBucket, ctx);
  var out = {};
  Object.keys(current).forEach(function (id) {
    correctionSetOwn(out, id, correctionClone(current[id]));
  });
  Object.keys(incoming).forEach(function (id) {
    var incomingRecord = incoming[id];
    var existing = correctionHasOwn(out, id) ? out[id] : undefined;
    if (existing === undefined) {
      if (!trustedIncoming) {
        conflicts.push({
          kind: 'teaching-correction', id: id, path: 'teachingCorrections.' + id,
          kept: null, incoming: incomingRecord, at,
          message: '导入的教学纠错记录（' + id + '）未采信；教学纠错只能由会话侧公开操作写入',
        });
        return;
      }
      correctionSetOwn(out, id, incomingRecord);
      return;
    }
    if (correctionStableStringify(existing) !== correctionStableStringify(incomingRecord)) {
      conflicts.push({
        kind: 'teaching-correction', id: id, path: 'teachingCorrections.' + id,
        kept: existing, incoming: incomingRecord, at,
        message: '教学纠错记录（' + id + '）存在分歧，保留当前记录并报告另一版；纠错历史不可改写',
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

function correctionModelConcept(model, conceptId) {
  var list = model && Array.isArray(model.concepts) ? model.concepts : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === conceptId) return list[i];
  }
  return null;
}

function correctionModelPrompt(model, promptId) {
  var list = model && Array.isArray(model.prompts) ? model.prompts : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === promptId) return list[i];
  }
  return null;
}

function correctionModelSource(model, sourceId) {
  var list = model && Array.isArray(model.sources) ? model.sources : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === sourceId) return list[i];
  }
  return null;
}

function correctionAttemptsById(state) {
  var byId = correctionNullMap();
  var attempts = state && state.attempts;
  if (!correctionIsRecord(attempts)) return byId;
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) {
      if (correctionIsRecord(attempt) && typeof attempt.id === 'string') byId[attempt.id] = attempt;
    });
  });
  return byId;
}

// An attempt is current only while the fingerprint it was recorded against
// still matches the current content — the same rule `isAttemptActive` applies
// in the backend and `isAttemptActive` mirrors in the page. The fingerprint
// lookup is host-provided (`hooks.currentFingerprint`) so this dependency-free
// module never re-implements the learner-question hashing both hosts already
// share; a missing hook degrades conservatively to "stale", never to "current".
function correctionAttemptStatus(attempt, hooks) {
  if (!correctionIsRecord(attempt)) return 'missing';
  if (!hooks || typeof hooks.currentFingerprint !== 'function') return 'stale';
  var current = hooks.currentFingerprint(attempt.promptId);
  if (!current) return 'stale';
  return attempt.fingerprint === current ? 'current' : 'stale';
}

// Every evidence record that cites one attempt, with whether it is still
// valid under the host's own activity rules. `hooks.evidenceActive` is
// injected by the host (backend: isPromptEvidenceActive/isConceptEvidenceActive;
// viewer: the page's local mirrors); without hooks the citation list stays
// empty rather than guessing.
function correctionEvidenceCitations(state, model, attemptId, hooks) {
  var citations = [];
  if (!hooks || typeof hooks.evidenceActive !== 'function') return citations;
  var evidenceActive = hooks.evidenceActive;
  ['promptEvidence', 'conceptEvidence'].forEach(function (bucket) {
    var records = state && correctionIsRecord(state[bucket]) ? state[bucket] : {};
    Object.keys(records).forEach(function (id) {
      var record = records[id];
      if (!correctionIsRecord(record) || !Array.isArray(record.attemptIds)) return;
      if (record.attemptIds.indexOf(attemptId) === -1) return;
      citations.push({
        bucket: bucket,
        id: id,
        status: record.status,
        current: Boolean(evidenceActive(bucket, id, record)),
      });
    });
  });
  return citations;
}

function correctionImpactView(impact, model, state, attemptsById, hooks) {
  var view = {
    kind: impact.kind,
    id: impact.id,
    note: impact.note,
    status: 'removed',
    title: null,
    evidence: [],
  };
  if (impact.kind === 'explanation' || impact.kind === 'example') {
    var concept = correctionModelConcept(model, impact.id);
    if (concept) {
      view.status = 'current';
      view.title = concept.title;
      if (hooks && typeof hooks.evidenceActive === 'function' && correctionIsRecord(state.conceptEvidence) &&
          correctionIsRecord(state.conceptEvidence[impact.id])) {
        var record = state.conceptEvidence[impact.id];
        view.evidence.push({
          bucket: 'conceptEvidence', id: impact.id, status: record.status,
          current: Boolean(hooks.evidenceActive('conceptEvidence', impact.id, record)),
        });
      }
    }
    return view;
  }
  if (impact.kind === 'exercise' || impact.kind === 'reference' || impact.kind === 'criteria') {
    var prompt = correctionModelPrompt(model, impact.id);
    if (prompt) {
      view.status = 'current';
      view.title = prompt.question;
      if (hooks && typeof hooks.evidenceActive === 'function' && correctionIsRecord(state.promptEvidence) &&
          correctionIsRecord(state.promptEvidence[impact.id])) {
        var promptRecord = state.promptEvidence[impact.id];
        view.evidence.push({
          bucket: 'promptEvidence', id: impact.id, status: promptRecord.status,
          current: Boolean(hooks.evidenceActive('promptEvidence', impact.id, promptRecord)),
        });
      }
    }
    return view;
  }
  // kind === 'record': a learning record (an attempt) affected by the
  // mis-teaching. Its wrongness stays visible as history; a still-valid
  // evidence record citing it is exactly what the next review must re-check.
  var attempt = correctionHasOwn(attemptsById, impact.id) ? attemptsById[impact.id] : null;
  if (attempt) {
    view.status = correctionAttemptStatus(attempt, hooks);
    view.title = typeof attempt.answer === 'string' && attempt.answer.length > 60
      ? attempt.answer.slice(0, 60) + '…'
      : (attempt.answer ?? null);
    view.attemptId = attempt.id;
    view.promptId = attempt.promptId ?? null;
    view.assisted = attempt.assisted === undefined ? null : attempt.assisted;
    view.evidence = correctionEvidenceCitations(state, model, impact.id, hooks);
  }
  return view;
}

function correctionRecheckView(recheck, model, state, attemptsById, hooks) {
  var attempt = correctionHasOwn(attemptsById, recheck.attemptId) ? attemptsById[recheck.attemptId] : null;
  return {
    id: recheck.id,
    attemptId: recheck.attemptId,
    at: recheck.at,
    note: recheck.note,
    attemptStatus: attempt ? correctionAttemptStatus(attempt, hooks) : 'missing',
    assisted: attempt ? (attempt.assisted === undefined ? null : attempt.assisted) : null,
  };
}

/**
 * Read-only view of every teaching correction with its impact scope resolved
 * against the current model and archive. This is a projection: it never
 * writes and never turns a correction into mastery, a schedule or evidence.
 *
 * `hooks.currentFingerprint(promptId)` resolves the current content
 * fingerprint for attempt staleness, and
 * `hooks.evidenceActive(bucket, id, record)` decides whether an evidence
 * record still counts as active under the host's rules; both hosts mirror
 * the same core EVIDENCE_RULES, so the citation statuses cannot drift from
 * what each surface already displays.
 */
export function teachingCorrectionsView(state, model, hooks) {
  var bucket = state && correctionIsRecord(state.teachingCorrections) ? state.teachingCorrections : {};
  var attemptsById = correctionAttemptsById(state);
  var ids = Object.keys(bucket).sort(function (a, b) {
    var left = bucket[a] && correctionValidTime(bucket[a].at) ? new Date(bucket[a].at).getTime() : 0;
    var right = bucket[b] && correctionValidTime(bucket[b].at) ? new Date(bucket[b].at).getTime() : 0;
    if (left !== right) return left - right;
    return String(a).localeCompare(String(b));
  });
  var corrections = ids.map(function (id) {
    var record = bucket[id];
    var source = correctionModelSource(model, record.sourceId);
    return {
      id: record.id,
      at: record.at,
      source: record.source ?? 'cli',
      claim: record.claim,
      feedback: record.feedback ?? null,
      correction: record.correction,
      basis: record.basis,
      sourceId: record.sourceId ?? null,
      sourceTitle: source ? (source.title ?? source.id) : (record.sourceId ?? null),
      sourceMissing: record.sourceId ? !source : false,
      impacts: record.impacts.map(function (impact) {
        return correctionImpactView(impact, model, state, attemptsById, hooks);
      }),
      noImpactReason: record.noImpactReason ?? null,
      rechecks: record.rechecks.map(function (recheck) {
        return correctionRecheckView(recheck, model, state, attemptsById, hooks);
      }),
    };
  });
  return {
    present: corrections.length > 0,
    total: corrections.length,
    corrections: corrections,
  };
}
