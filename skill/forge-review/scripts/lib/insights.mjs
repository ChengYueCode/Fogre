// Pure insight-note logic shared by the Node backend and the browser viewer.
//
// This module MUST stay dependency-free and portable: it may not load any
// other file and may not touch host-only APIs (file system, path, crypto,
// process or network). `build` strips the leading `export ` from every
// declaration and inlines the source into the viewer at the insights-library
// marker, and the standalone viewer harnesses do the same. `state.mjs` loads
// the helpers directly, so the page and the backend share one rule set for
// note history, archive merging and the read model.
//
// Internal helpers are all `insight*`-prefixed so they can never shadow a
// viewer or core helper of the same purpose.

var INSIGHT_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];

function insightHasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function insightIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function insightClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function insightFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

function insightReject(context, code, message, path) {
  var fail = context && typeof context.fail === 'function' ? context.fail : insightFail;
  throw fail(code, message, path);
}

function insightText(value, context, message, path) {
  if (typeof value !== 'string' || value.trim() === '') insightReject(context, 'E_STATE', message, path);
  return value.trim();
}

function insightValidTime(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(new Date(value).getTime());
}

function insightNullMap() {
  return Object.create(null);
}

function insightSetOwn(bucket, key, value) {
  Object.defineProperty(bucket, key, {
    value: value, enumerable: true, writable: true, configurable: true,
  });
  return bucket;
}

// Key order is sorted at every level so independently serialized values have a
// single canonical text form. This matches the archive's stable serialization
// for the JSON-shaped records used by notes and fingerprints.
function insightStableSortValue(value) {
  if (Array.isArray(value)) return value.map(insightStableSortValue);
  if (insightIsRecord(value)) {
    var out = {};
    Object.keys(value).sort().forEach(function (key) {
      if (value[key] !== undefined) out[key] = insightStableSortValue(value[key]);
    });
    return out;
  }
  return value;
}

function insightStableStringify(value) {
  return JSON.stringify(insightStableSortValue(value), null, 2) + '\n';
}

// Synchronous UTF-8 conversion with the same lone-surrogate replacement as a
// standard UTF-8 encoder. The shared fingerprints are plain text hashes, so a
// portable browser implementation must be able to reproduce them exactly.
function insightUtf8Bytes(text) {
  var bytes = [];
  var value = String(text);
  for (var i = 0; i < value.length; i += 1) {
    var code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      var next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function insightRor32(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function insightSha256Hex(text) {
  var bytes = insightUtf8Bytes(text);
  var bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var high = Math.floor(bitLength / 0x100000000);
  var low = bitLength >>> 0;
  bytes.push(
    (high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff,
    (low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff,
  );
  var constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  var state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (var offset = 0; offset < bytes.length; offset += 64) {
    var words = new Array(64);
    for (var i = 0; i < 16; i += 1) {
      var at = offset + i * 4;
      words[i] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (var j = 16; j < 64; j += 1) {
      var s0 = (insightRor32(words[j - 15], 7) ^ insightRor32(words[j - 15], 18) ^ (words[j - 15] >>> 3)) >>> 0;
      var s1 = (insightRor32(words[j - 2], 17) ^ insightRor32(words[j - 2], 19) ^ (words[j - 2] >>> 10)) >>> 0;
      words[j] = (words[j - 16] + s0 + words[j - 7] + s1) >>> 0;
    }
    var a = state[0]; var b = state[1]; var c = state[2]; var d = state[3];
    var e = state[4]; var f = state[5]; var g = state[6]; var h = state[7];
    for (var k = 0; k < 64; k += 1) {
      var sum1 = (insightRor32(e, 6) ^ insightRor32(e, 11) ^ insightRor32(e, 25)) >>> 0;
      var choice = ((e & f) ^ (~e & g)) >>> 0;
      var temp1 = (h + sum1 + choice + constants[k] + words[k]) >>> 0;
      var sum0 = (insightRor32(a, 2) ^ insightRor32(a, 13) ^ insightRor32(a, 22)) >>> 0;
      var majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map(function (word) {
    return ('00000000' + word.toString(16)).slice(-8);
  }).join('');
}

function insightShortHash(text, length) {
  return insightSha256Hex(text).slice(0, length);
}

function insightModelConcept(model, conceptId) {
  if (!model || typeof conceptId !== 'string') return null;
  if (model.byId && typeof model.byId.get === 'function') {
    var viaMap = model.byId.get(conceptId);
    if (viaMap) return viaMap;
  }
  var list = Array.isArray(model.concepts) ? model.concepts : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === conceptId) return list[i];
  }
  return null;
}

function insightModelPrompt(model, promptId) {
  var list = model && Array.isArray(model.prompts) ? model.prompts : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === promptId) return list[i];
  }
  return null;
}

function insightConceptFingerprint(model, concept) {
  if (!concept) return '';
  if (model && model.conceptFingerprints && insightHasOwn(model.conceptFingerprints, concept.id)) {
    return model.conceptFingerprints[concept.id];
  }
  return insightSha256Hex(insightStableStringify({
    id: concept.id,
    title: concept.title,
    explanation: concept.explanation ?? '',
    example: concept.example ?? '',
    misconception: concept.misconception ?? '',
  }));
}

function insightPromptFingerprint(model, state, promptId) {
  if (model && model.promptFingerprints && insightHasOwn(model.promptFingerprints, promptId)) {
    return model.promptFingerprints[promptId];
  }
  if (state && state.promptFingerprints && insightHasOwn(state.promptFingerprints, promptId)) {
    return state.promptFingerprints[promptId];
  }
  var prompt = insightModelPrompt(model, promptId);
  if (prompt) {
    var payload = {
      conceptId: prompt.conceptId,
      kind: prompt.kind,
      question: prompt.question,
      answer: prompt.answer ?? '',
      criteria: prompt.criteria ?? [],
      concept: insightConceptFingerprint(model, insightModelConcept(model, prompt.conceptId)),
    };
    if (prompt.teaching !== undefined && prompt.teaching !== null && Object.keys(prompt.teaching).length > 0) {
      payload.teaching = prompt.teaching;
    }
    return insightSha256Hex(insightStableStringify(payload));
  }
  var own = state && state.ownQuestions ? state.ownQuestions[promptId] : null;
  if (!insightIsRecord(own)) return null;
  var concept = insightModelConcept(model, own.conceptId);
  if (!concept) return null;
  return insightShortHash(
    'learner|' + own.conceptId + '|' + own.text + '|' + insightConceptFingerprint(model, concept),
    32,
  );
}

function insightAttemptStale(model, state, attempt) {
  if (!insightIsRecord(attempt) || typeof attempt.fingerprint !== 'string' || attempt.fingerprint === '') return true;
  var current = insightPromptFingerprint(model, state, attempt.promptId);
  return current === null || current === undefined || current !== attempt.fingerprint;
}

function insightAuthor(value) {
  if (typeof value !== 'string') return 'unknown';
  var text = value.trim();
  return text === '' ? 'unknown' : text;
}

function insightVersionId(text, author, updatedAt) {
  return JSON.stringify([text, insightAuthor(author), updatedAt === undefined ? null : updatedAt]);
}

function insightVersionFromNote(note) {
  var text = typeof note.text === 'string' ? note.text : '';
  var author = insightAuthor(note.author);
  var updatedAt = insightValidTime(note.updatedAt) ? note.updatedAt : null;
  return {
    id: insightVersionId(text, author, updatedAt),
    text: text,
    author: author,
    updatedAt: updatedAt,
  };
}

function insightNormalizeHistoryEntry(entry, context, path) {
  if (!insightIsRecord(entry)) insightReject(context, 'E_STATE', '历史版本必须是对象', path);
  var id = insightText(entry.id, context, '历史版本 id 必须是非空字符串', path + '.id');
  var text = insightText(entry.text, context, '历史版本 text 必须是非空字符串', path + '.text');
  var author = insightText(entry.author, context, '历史版本 author 必须是非空字符串', path + '.author');
  var updatedAt = entry.updatedAt;
  if (updatedAt !== undefined && updatedAt !== null && !insightValidTime(updatedAt)) {
    insightReject(context, 'E_STATE', '历史版本 updatedAt 必须是合法时间或 null', path + '.updatedAt');
  }
  var out = insightClone(entry);
  out.id = id;
  out.text = text;
  out.author = author;
  out.updatedAt = updatedAt === undefined ? null : updatedAt;
  return out;
}

function insightValidateNoteRecord(note, context, path) {
  if (!insightIsRecord(note)) insightReject(context, 'E_STATE', '笔记必须是对象', path);
  if (typeof note.text !== 'string' || note.text.trim() === '') {
    insightReject(context, 'E_STATE', '笔记 text 必须是非空字符串', path + '.text');
  }
  if (insightHasOwn(note, 'author') && note.author !== undefined && note.author !== null) {
    if (typeof note.author !== 'string' || note.author.trim() === '') {
      insightReject(context, 'E_STATE', '笔记 author 必须是非空字符串', path + '.author');
    }
  }
  if (insightHasOwn(note, 'updatedAt') && note.updatedAt !== undefined && note.updatedAt !== null) {
    if (!insightValidTime(note.updatedAt)) {
      insightReject(context, 'E_STATE', '笔记 updatedAt 必须是合法时间', path + '.updatedAt');
    }
  }
  var out = insightClone(note);
  if (insightHasOwn(note, 'history')) {
    if (!Array.isArray(note.history)) {
      insightReject(context, 'E_STATE', '笔记 history 必须是数组', path + '.history');
    }
    var seen = insightNullMap();
    out.history = note.history.map(function (entry, index) {
      var normalized = insightNormalizeHistoryEntry(entry, context, path + '.history[' + index + ']');
      if (insightHasOwn(seen, normalized.id)) {
        if (insightStableStringify(seen[normalized.id]) !== insightStableStringify(normalized)) {
          insightReject(context, 'E_STATE',
            '同一历史版本 id 对应不同内容：' + normalized.id,
            path + '.history[' + index + '].id');
        }
      } else {
        seen[normalized.id] = normalized;
      }
      return normalized;
    });
  }
  return out;
}

function insightValidateBucket(bucket, context, path) {
  if (!insightIsRecord(bucket)) insightReject(context, 'E_STATE', path + ' 必须是对象（旧档可省略该字段）', path);
  var out = {};
  Object.keys(bucket).forEach(function (id) {
    insightSetOwn(out, id, insightValidateNoteRecord(bucket[id], context, path + '.' + id));
  });
  return out;
}

/**
 * Validate the optional note history buckets. `raw` may be either the full
 * archive (the viewer calls it with the whole state) or one bucket when the
 * caller passes a `kind` in `context`. An absent bucket stays legacy-compatible;
 * a present bucket and every present history entry are checked strictly.
 */
export function insightValidateNotes(raw, context) {
  var ctx = context || {};
  var explanations = {};
  var summaries = {};
  if (raw === undefined || raw === null) return { explanations: explanations, summaries: summaries };
  if (!insightIsRecord(raw)) insightReject(ctx, 'E_STATE', '笔记必须是对象（旧档可省略该字段）', 'notes');
  var fullState = insightHasOwn(raw, 'schemaVersion') || insightHasOwn(raw, 'explanations') || insightHasOwn(raw, 'summaries');
  if (fullState) {
    if (insightHasOwn(raw, 'explanations')) {
      if (raw.explanations === undefined) {
        explanations = {};
      } else if (raw.explanations === null || !insightIsRecord(raw.explanations)) {
        insightReject(ctx, 'E_STATE', 'explanations 必须是对象（旧档可省略该字段）', 'explanations');
      } else {
        explanations = insightValidateBucket(raw.explanations, ctx, 'explanations');
      }
    }
    if (insightHasOwn(raw, 'summaries')) {
      if (raw.summaries === undefined) {
        summaries = {};
      } else if (raw.summaries === null || !insightIsRecord(raw.summaries)) {
        insightReject(ctx, 'E_STATE', 'summaries 必须是对象（旧档可省略该字段）', 'summaries');
      } else {
        summaries = insightValidateBucket(raw.summaries, ctx, 'summaries');
      }
    }
    return { explanations: explanations, summaries: summaries };
  }
  var kind = ctx.kind;
  if (kind === 'summaries' || kind === 'summary') summaries = insightValidateBucket(raw, ctx, 'summaries');
  else explanations = insightValidateBucket(raw, ctx, 'explanations');
  return { explanations: explanations, summaries: summaries };
}

function insightHistoryContains(history, id) {
  for (var i = 0; i < history.length; i += 1) {
    if (history[i] && history[i].id === id) return true;
  }
  return false;
}

function insightSameHistoryEntry(a, b) {
  return insightStableStringify(a) === insightStableStringify(b);
}

function insightPushConflict(conflicts, conflict) {
  for (var i = 0; i < conflicts.length; i += 1) {
    var existing = conflicts[i];
    if (existing && existing.path === conflict.path &&
        insightStableStringify(existing.kept ?? null) === insightStableStringify(conflict.kept ?? null) &&
        insightStableStringify(existing.incoming ?? null) === insightStableStringify(conflict.incoming ?? null)) {
      return;
    }
  }
  conflicts.push(conflict);
}

function insightConflictId(kind, conceptId, id) {
  // Conflict identity only names a reported pair for display/dedupe; the exact
  // version identity lives in the history entry's own non-hashed `id`.
  return 'cf-note-' + insightShortHash(JSON.stringify([kind || 'notes', conceptId, id]), 10);
}

function insightAddHistoryVersion(history, version, context, path, conflicts, at, kind) {
  if (insightHistoryContains(history, version.id)) {
    for (var i = 0; i < history.length; i += 1) {
      if (history[i] && history[i].id === version.id && !insightSameHistoryEntry(history[i], version)) {
        insightPushConflict(conflicts, {
          id: insightConflictId(kind, path, version.id),
          kind: kind || 'notes',
          path: path + '.history.' + version.id,
          kept: history[i],
          incoming: version,
          at: at,
          message: '同一历史版本 id 对应不同内容，保留现有版本并报告传入版本',
        });
      }
    }
    return history;
  }
  history.push(version);
  return history;
}

/**
 * Merge two note buckets. The first argument is the visible branch: its text,
 * author and updatedAt stay current. A different incoming version is kept in
 * the merged history instead of overwriting the visible note, and all distinct
 * history versions from both sides are unioned. A same-id/different-content
 * history entry is reported as a conflict while the existing entry is kept.
 */
export function insightMergeNotes(currentBucket, incomingBucket, conflicts, at, kind) {
  var ctx = { fail: insightFail };
  var current = currentBucket === undefined || currentBucket === null
    ? {}
    : insightValidateBucket(currentBucket, ctx, kind || 'notes');
  var incoming = incomingBucket === undefined || incomingBucket === null
    ? {}
    : insightValidateBucket(incomingBucket, ctx, kind || 'notes');
  var conflictList = Array.isArray(conflicts) ? conflicts : [];
  var out = {};
  Object.keys(current).forEach(function (id) {
    insightSetOwn(out, id, insightClone(current[id]));
  });
  Object.keys(incoming).forEach(function (id) {
    var next = insightClone(incoming[id]);
    var existing = insightHasOwn(out, id) ? out[id] : undefined;
    if (existing === undefined) {
      insightSetOwn(out, id, next);
      return;
    }
    var merged = insightClone(existing);
    var history = Array.isArray(existing.history) ? insightClone(existing.history) : [];
    var incomingHistory = Array.isArray(next.history) ? next.history : [];
    var path = (kind || 'notes') + '.' + id;
    incomingHistory.forEach(function (entry) {
      insightAddHistoryVersion(history, entry, ctx, path, conflictList, at, kind);
    });
    var incomingVersion = insightVersionFromNote(next);
    var sameVisibleVersion = existing.text === next.text && insightAuthor(existing.author) === insightAuthor(next.author);
    if (!sameVisibleVersion) {
      var alreadyPreserved = insightHistoryContains(history, incomingVersion.id);
      insightAddHistoryVersion(history, incomingVersion, ctx, path, conflictList, at, kind);
      if (!alreadyPreserved) {
        insightPushConflict(conflictList, {
          id: insightConflictId(kind, id, incomingVersion.id),
          kind: kind || 'notes',
          path: path,
          kept: insightClone(existing),
          incoming: insightClone(next),
          at: at,
          message: '两端笔记不同，保留当前可见版本并把传入版本并入历史',
        });
      }
    }
    // Current history already describes the visible current version only when
    // the bucket itself carried it; do not synthesize noise for an unchanged
    // note. If a conflicting incoming top-level version was added above, the
    // resulting history is a real union.
    if (history.length > 0) merged.history = history;
    else if (insightHasOwn(merged, 'history')) delete merged.history;
    insightSetOwn(out, id, merged);
  });
  return out;
}

/**
 * Record one learner/tutor note. Rewriting a different version appends the
 * previous version to `history`; saving the same text+author again is an
 * idempotent no-op. The optional `model` may be a normalized model or a raw
 * browser model with a plain `concepts` array.
 */
export function insightRecordNote(state, model, input, at) {
  var ctx = { fail: insightFail };
  if (!insightIsRecord(state)) insightReject(ctx, 'E_STATE', '状态必须是对象', 'state');
  var conceptId = input && input.conceptId;
  if (!insightModelConcept(model, conceptId)) {
    insightReject(ctx, 'E_STATE', '概念不存在：' + JSON.stringify(conceptId), 'conceptId');
  }
  var kind = input && input.kind;
  if (kind !== 'explanation' && kind !== 'summary') {
    insightReject(ctx, 'E_USAGE', 'kind 只能是 explanation 或 summary', 'kind');
  }
  if (!input || typeof input.text !== 'string' || input.text.trim() === '') {
    insightReject(ctx, 'E_USAGE', '笔记内容不能为空', 'text');
  }
  var text = input.text.trim();
  var author;
  if (input.author === undefined || input.author === null) {
    // The browser and the legacy note route omit the author for a learner's
    // own note. An explicitly supplied value must name a real author role.
    author = 'learner';
  } else if (input.author === 'learner' || input.author === 'tutor') {
    author = input.author;
  } else {
    insightReject(ctx, 'E_USAGE', '笔记 author 只能是 learner 或 tutor', 'author');
  }
  var bucketKey = kind === 'explanation' ? 'explanations' : 'summaries';
  var bucketPath = bucketKey + '.' + conceptId;
  var existingBucket = state && insightIsRecord(state[bucketKey]) ? state[bucketKey] : {};
  var existing = insightHasOwn(existingBucket, conceptId) ? existingBucket[conceptId] : undefined;
  if (existing !== undefined) {
    existing = insightValidateNoteRecord(existing, ctx, bucketPath);
  }
  if (existing !== undefined && existing.text === text && insightAuthor(existing.author) === author) {
    return { state: state, note: existing };
  }
  var nextState = insightClone(state || {});
  if (!insightIsRecord(nextState[bucketKey])) nextState[bucketKey] = {};
  var history = existing && Array.isArray(existing.history) ? insightClone(existing.history) : [];
  if (existing !== undefined) {
    insightAddHistoryVersion(history, insightVersionFromNote(existing), ctx, bucketPath, [], at, bucketKey);
  }
  var note = { text: text, updatedAt: at, author: author };
  if (history.length > 0) note.history = history;
  insightSetOwn(nextState[bucketKey], conceptId, note);
  nextState.revision = (Number.isInteger(nextState.revision) ? nextState.revision : 0) + 1;
  nextState.updatedAt = at;
  return { state: nextState, note: note };
}

function insightOwnQuestionView(question) {
  if (!insightIsRecord(question)) return null;
  var out = insightClone(question);
  out.author = insightAuthor(question.author);
  return out;
}

function insightNoteView(note) {
  if (!insightIsRecord(note)) return null;
  var out = insightClone(note);
  out.text = typeof note.text === 'string' ? note.text : '';
  out.author = insightAuthor(note.author);
  out.updatedAt = insightValidTime(note.updatedAt) ? note.updatedAt : null;
  out.history = Array.isArray(note.history) ? note.history.map(function (entry) {
    var version = insightClone(entry);
    version.author = insightAuthor(entry.author);
    version.updatedAt = insightValidTime(entry.updatedAt) ? entry.updatedAt : null;
    return version;
  }) : [];
  return out;
}

function insightReviewsForAttempt(state, attempt) {
  var requests = state && insightIsRecord(state.reviewRequests) ? state.reviewRequests : {};
  var reviews = [];
  Object.keys(requests).forEach(function (key) {
    var request = requests[key];
    if (!insightIsRecord(request) || !Array.isArray(request.members)) return;
    request.members.forEach(function (member) {
      if (!insightIsRecord(member) || member.attemptId !== attempt.id) return;
      if (typeof member.promptId === 'string' && member.promptId !== attempt.promptId) return;
      var hasFeedback = insightIsRecord(member.feedback);
      reviews.push({
        requestId: typeof request.id === 'string' && request.id !== '' ? request.id : key,
        status: typeof member.status === 'string' ? member.status : null,
        feedback: hasFeedback ? insightClone(member.feedback) : null,
        feedbackComplete: hasFeedback,
        feedbackMissing: member.status === 'completed' && !hasFeedback,
        pending: member.status !== 'completed',
        source: 'tutor',
        at: member.resolvedAt ?? member.at ?? null,
      });
    });
  });
  return reviews;
}

function insightAttemptView(state, model, attempt) {
  var out = insightClone(attempt);
  out.id = attempt.id;
  out.promptId = attempt.promptId;
  out.answer = attempt.answer;
  out.at = attempt.at;
  out.assisted = attempt.assisted === undefined ? null : attempt.assisted;
  out.tutorFeedback = Array.isArray(attempt.tutorFeedback) ? insightClone(attempt.tutorFeedback) : [];
  out.corrections = Array.isArray(attempt.corrections) ? insightClone(attempt.corrections) : [];
  out.stale = insightAttemptStale(model, state, attempt);
  out.reviews = insightReviewsForAttempt(state, attempt);
  return out;
}

function insightAttemptConceptId(state, model, attempt) {
  if (typeof attempt.conceptId === 'string' && attempt.conceptId !== '') return attempt.conceptId;
  var prompt = insightModelPrompt(model, attempt.promptId);
  if (prompt) return prompt.conceptId;
  var own = state && state.ownQuestions ? state.ownQuestions[attempt.promptId] : null;
  return insightIsRecord(own) && typeof own.conceptId === 'string' ? own.conceptId : null;
}

function insightAttemptsForConcept(state, model, conceptId) {
  var attempts = state && insightIsRecord(state.attempts) ? state.attempts : {};
  var out = [];
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) {
      if (!insightIsRecord(attempt)) return;
      if (insightAttemptConceptId(state, model, attempt) !== conceptId) return;
      out.push(insightAttemptView(state, model, attempt));
    });
  });
  out.sort(function (a, b) {
    var left = insightValidTime(a.at) ? new Date(a.at).getTime() : 0;
    var right = insightValidTime(b.at) ? new Date(b.at).getTime() : 0;
    if (left !== right) return left - right;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function insightQuestionsForConcept(state, conceptId) {
  var questions = state && insightIsRecord(state.ownQuestions) ? state.ownQuestions : {};
  var out = [];
  Object.keys(questions).forEach(function (id) {
    var question = questions[id];
    if (!insightIsRecord(question) || question.conceptId !== conceptId) return;
    var view = insightOwnQuestionView(question);
    if (view) out.push(view);
  });
  out.sort(function (a, b) {
    var left = insightValidTime(a.createdAt) ? new Date(a.createdAt).getTime() : 0;
    var right = insightValidTime(b.createdAt) ? new Date(b.createdAt).getTime() : 0;
    if (left !== right) return left - right;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function insightStateConceptIds(state) {
  var ids = insightNullMap();
  ['explanations', 'summaries'].forEach(function (bucketName) {
    var bucket = state && state[bucketName];
    if (!insightIsRecord(bucket)) return;
    Object.keys(bucket).forEach(function (id) { ids[id] = true; });
  });
  var questions = state && insightIsRecord(state.ownQuestions) ? state.ownQuestions : {};
  Object.keys(questions).forEach(function (id) {
    var question = questions[id];
    if (insightIsRecord(question) && typeof question.conceptId === 'string' && question.conceptId !== '') ids[question.conceptId] = true;
  });
  var attempts = state && insightIsRecord(state.attempts) ? state.attempts : {};
  Object.keys(attempts).forEach(function (promptId) {
    var list = attempts[promptId];
    if (!Array.isArray(list)) return;
    list.forEach(function (attempt) {
      if (!insightIsRecord(attempt)) return;
      var fromAttempt = typeof attempt.conceptId === 'string' ? attempt.conceptId : '';
      if (fromAttempt !== '') ids[fromAttempt] = true;
    });
  });
  var revisions = state && insightIsRecord(state.conceptRevisions) ? state.conceptRevisions : {};
  Object.keys(revisions).forEach(function (id) { ids[id] = true; });
  return Object.keys(ids).sort();
}

function insightConceptView(state, model, conceptId) {
  var concept = insightModelConcept(model, conceptId);
  var revision = state && state.conceptRevisions ? state.conceptRevisions[conceptId] : null;
  var questionList = insightQuestionsForConcept(state, conceptId);
  return {
    conceptId: conceptId,
    title: concept ? concept.title : (insightIsRecord(revision) && typeof revision.title === 'string' ? revision.title : conceptId),
    historical: !concept,
    modelPresent: Boolean(concept),
    authorExplanation: concept && typeof concept.explanation === 'string' ? concept.explanation : null,
    authorExample: concept && typeof concept.example === 'string' ? concept.example : null,
    authorMisconception: concept && typeof concept.misconception === 'string' ? concept.misconception : null,
    attempts: insightAttemptsForConcept(state, model, conceptId),
    explanation: insightNoteView(state && state.explanations ? state.explanations[conceptId] : null),
    summary: insightNoteView(state && state.summaries ? state.summaries[conceptId] : null),
    questions: questionList,
  };
}

/**
 * Read one concept's insight records, or every current/historical concept when
 * `conceptId` is omitted. This is a pure projection: it never writes the
 * archive and never turns notes or tutor text into mastery evidence.
 */
export function insightRead(state, model, conceptId) {
  var requested = typeof conceptId === 'string' && conceptId.trim() !== '' ? conceptId.trim() : null;
  var conceptIds = [];
  if (requested !== null) {
    conceptIds = [requested];
  } else {
    var modelConcepts = model && Array.isArray(model.concepts) ? model.concepts : [];
    var seen = insightNullMap();
    modelConcepts.forEach(function (concept) {
      if (!insightIsRecord(concept) || typeof concept.id !== 'string' || concept.id === '' || seen[concept.id]) return;
      seen[concept.id] = true;
      conceptIds.push(concept.id);
    });
    insightStateConceptIds(state).forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      conceptIds.push(id);
    });
  }
  return { concepts: conceptIds.map(function (id) { return insightConceptView(state, model, id); }) };
}
