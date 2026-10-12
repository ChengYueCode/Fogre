// Core regression tests for the forge model/state helpers.
// Run: node --test tests/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { EmberError, CODES } from '../skill/forge/scripts/lib/errors.mjs';
import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  createState,
  normalizeState,
  validateStateShape,
  stateView,
  applyAttempt,
  applyTutorEvidence,
  applyOwnQuestion,
  applyNote,
  applyTitleRevision,
  applyRelationRevision,
  syncModel,
  mergeImportedState,
  listDue,
  isPromptStale,
  isConceptEvidenceActive,
  isPromptEvidenceActive,
  resolvePrompt,
} from '../skill/forge/scripts/lib/state.mjs';

function baseModel(extra = {}) {
  return normalizeModel({
    schemaVersion: 1,
    id: 'probability',
    title: '条件概率',
    goal: '能解释先验与 PPV 的关系',
    concepts: [
      { id: 'root', title: '条件概率', parentId: null, difficulty: 1, explanation: '基础定义' },
      { id: 'prior', title: '先验概率', parentId: 'root', difficulty: 1, explanation: '证据前的信念' },
      { id: 'ppv', title: '阳性预测值', parentId: 'root', difficulty: 3, explanation: '阳性中真患病比例' },
    ],
    prompts: [
      { id: 'p-prior-apply', conceptId: 'prior', kind: 'apply', question: '患病率 2% 时 PPV?', answer: '约 27%', criteria: ['先算真阳性'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
    relations: [
      { id: 'rel-prior-to-ppv', from: 'prior', to: 'ppv', type: 'cause', label: '先验改变 PPV' },
    ],
    sources: [{ id: 'src-1', title: '合成教学材料' }],
    ...extra,
  });
}

function attempt(state, model, promptId, { at, answer, rating = 'good', assisted = false, attemptId } = {}) {
  return applyAttempt(state, model, { promptId, answer: answer ?? '我的作答', rating, assisted, attemptId }, at).state;
}

// ---------------------------------------------------------------------------
// Finding 1: normalized model round-trip incl. omitted/empty optionals and
// useful malformed-array errors.
// ---------------------------------------------------------------------------

test('model round-trips through modelToJson with omitted optional strings', () => {
  const raw = {
    schemaVersion: 1, id: 'm-omit', title: 'T', goal: 'G',
    concepts: [{ id: 'root', title: 'R', parentId: null, difficulty: 1 }],
    sources: [{ id: 's1', title: 'S' }],
  };
  const once = normalizeModel(raw);
  const json1 = modelToJson(once);
  const twice = normalizeModel(json1);
  const json2 = modelToJson(twice);
  assert.deepEqual(json2, json1, 'second normalization must be a fixed point');
  assert.equal(twice.concepts[0].example, '');
  assert.equal(twice.sources[0].url, '');
  assert.equal(twice.summary, '');
});

test('model round-trips with explicit empty optional strings and a source without url', () => {
  const raw = {
    schemaVersion: 1, id: 'm-empty', title: 'T', goal: 'G', summary: '',
    concepts: [{ id: 'root', title: 'R', parentId: null, difficulty: 1, example: '', misconception: '' }],
    prompts: [{ id: 'p1', conceptId: 'root', kind: 'recall', question: 'Q', answer: 'A' }],
    relations: [],
    sources: [{ id: 's1', title: 'S', url: '', note: '' }],
    limitations: [],
  };
  const once = normalizeModel(raw);
  const json1 = modelToJson(once);
  const twice = normalizeModel(json1);
  assert.deepEqual(modelToJson(twice), json1);
  // modelToJson omits empty optionals, and normalize accepts the omission back.
  assert.ok(!('example' in json1.concepts[0]));
  assert.ok(!('url' in json1.sources[0]));
  assert.ok(!('summary' in json1));
});

test('malformed array-typed fields fail with a useful path and code', () => {
  const cases = [
    ['relations', { relations: {} }, 'relations'],
    ['prompts', { prompts: 'nope' }, 'prompts'],
    ['sources', { sources: 42 }, 'sources'],
    ['limitations', { limitations: { a: 1 } }, 'limitations'],
  ];
  for (const [label, override, path] of cases) {
    const raw = {
      schemaVersion: 1, id: 'm-array', title: 'T', goal: 'G',
      concepts: [{ id: 'root', title: 'R', parentId: null, difficulty: 1 }],
      ...override,
    };
    assert.throws(
      () => normalizeModel(raw),
      (err) => err instanceof EmberError && err.code === CODES.SCHEMA && err.path === path,
      `${label} should fail on ${path}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Finding 2: explicit attempt-linked evidence with independence/type/time
// requirements.
// ---------------------------------------------------------------------------

test('assisted attempt cannot support independent/retained evidence', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', assisted: true });
  assert.throws(
    () => applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'explained', note: '看起来理解' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE && /独立/.test(err.message),
  );
});

test('explained requires an independent explain/compare attempt', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  // independent but wrong kind (apply) cannot satisfy explained
  state = attempt(state, model, 'p-prior-apply', { at: '2026-01-01T01:00:00Z', assisted: false });
  assert.throws(
    () => applyTutorEvidence(state, model, { promptId: 'p-prior-apply', status: 'explained', note: 'x' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE && /类型/.test(err.message),
  );
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T03:00:00Z', assisted: false });
  const out = applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'explained', note: '能解释分母变化' }, '2026-01-01T04:00:00Z');
  assert.equal(out.state.promptEvidence['p-ppv-explain'].status, 'explained');
  assert.equal(out.state.promptEvidence['p-ppv-explain'].attemptIds.length, 1);
  assert.equal(out.state.promptEvidence['p-ppv-explain'].independent, true);
});

test('applied requires an independent apply attempt', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', assisted: false });
  assert.throws(
    () => applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'applied', note: '新情境' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE,
  );
});

test('retained needs two independent attempts separated by time, not a same-minute replay', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-a' });
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:05:00Z', assisted: false, attemptId: 'att-b' });
  assert.throws(
    () => applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'retained', note: '记得' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE && /间隔/.test(err.message),
  );
  // A later, genuinely separated independent recall qualifies.
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-02T12:00:00Z', assisted: false, attemptId: 'att-c' });
  const out = applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'retained', note: '隔天仍能说明' }, '2026-01-02T13:00:00Z');
  assert.equal(out.state.promptEvidence['p-ppv-explain'].status, 'retained');
});

test('evidence with an arbitrary note and no attempt is rejected', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  assert.throws(
    () => applyTutorEvidence(state, model, { conceptId: 'ppv', status: 'applied', note: '凭空' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE,
  );
});

test('explicit attemptIds are validated and recorded', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-chosen' });
  const out = applyTutorEvidence(state, model, {
    promptId: 'p-ppv-explain', status: 'explained', note: '复核该次', attemptIds: ['att-chosen'],
  }, '2026-01-01T02:00:00Z');
  assert.deepEqual(out.state.promptEvidence['p-ppv-explain'].attemptIds, ['att-chosen']);
  assert.throws(
    () => applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'explained', note: 'x', attemptIds: ['att-missing'] }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE,
  );
  // attempt from a different prompt is rejected
  let state2 = attempt(state, model, 'p-prior-apply', { at: '2026-01-01T01:10:00Z', assisted: false, attemptId: 'att-other' });
  assert.throws(
    () => applyTutorEvidence(state2, model, { promptId: 'p-ppv-explain', status: 'explained', note: 'x', attemptIds: ['att-other'] }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.STATE,
  );
});

// ---------------------------------------------------------------------------
// Finding 3: model/prompt/concept fingerprints and inactive stale proof.
// ---------------------------------------------------------------------------

test('concept fingerprint changes when any concept content changes', () => {
  const a = baseModel();
  const b = normalizeModel({
    ...modelToJson(a),
    concepts: a.concepts.map((c, i) => (i === 2 ? { ...c, explanation: '更新后的解释' } : c)),
  });
  assert.notEqual(a.conceptFingerprints.ppv, b.conceptFingerprints.ppv);
});

test('prompt fingerprint includes concept context, not only prompt text', () => {
  const a = baseModel();
  const b = normalizeModel({
    ...modelToJson(a),
    concepts: a.concepts.map((c, i) => (i === 2 ? { ...c, explanation: '概念内容改了' } : c)),
  });
  assert.notEqual(a.promptFingerprints['p-ppv-explain'], b.promptFingerprints['p-ppv-explain']);
  assert.equal(a.promptFingerprints['p-prior-apply'], b.promptFingerprints['p-prior-apply']);
});

test('concept proof becomes inactive after the concept content changes, retaining history', () => {
  const model = baseModel({
    prompts: [
      { id: 'p-prior-apply', conceptId: 'prior', kind: 'apply', question: '患病率 2% 时 PPV?', answer: '约 27%', criteria: ['先算真阳性'] },
      { id: 'p-ppv-apply', conceptId: 'ppv', kind: 'apply', question: '换一组数值算 PPV', answer: '约 17%', criteria: ['换情境'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
  });
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-apply', { at: '2026-01-01T01:00:00Z', assisted: false });
  state = applyTutorEvidence(state, model, { conceptId: 'ppv', status: 'applied', note: '做对新情境' }, '2026-01-01T02:00:00Z').state;
  assert.equal(stateView(state, model).conceptStatus.ppv.status, 'applied');

  const updated = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.map((c) => (c.id === 'ppv' ? { ...c, explanation: '新的解释内容' } : c)),
  });
  const { state: synced } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  assert.equal(isConceptEvidenceActive(updated, synced, 'ppv'), false);
  const view = stateView(synced, updated);
  assert.equal(view.conceptStatus.ppv.status, 'unknown', 'stale proof must not remain active mastery');
  assert.equal(view.conceptStatus.ppv.staleEvidence.status, 'applied', 'historical proof is retained for review');
  // The stored evidence itself is not deleted.
  assert.equal(synced.conceptEvidence.ppv.status, 'applied');
  assert.equal(synced.conceptEvidence.ppv.conceptFingerprint, model.conceptFingerprints.ppv);
});

test('prompt proof with an outdated fingerprint is inactive and flagged stale in the view', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', assisted: false });
  state = applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'explained', note: '能解释' }, '2026-01-01T02:00:00Z').state;
  assert.equal(isPromptEvidenceActive(model, state, 'p-ppv-explain'), true);

  const updated = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.map((p) => (p.id === 'p-ppv-explain' ? { ...p, question: '改后的题干' } : p)),
  });
  assert.equal(isPromptStale(updated, state, 'p-ppv-explain'), true);
  assert.equal(isPromptEvidenceActive(updated, state, 'p-ppv-explain'), false);
  const view = stateView(state, updated).prompts['p-ppv-explain'];
  assert.equal(view.evidence, null, 'stale evidence is not shown as active');
  assert.ok(view.staleEvidence, 'stale evidence is surfaced separately');
});

// ---------------------------------------------------------------------------
// Finding 4: rebuild reconciliation preserves/reports all orphan categories
// without rejecting them.
// ---------------------------------------------------------------------------

test('normalizeState accepts historical overlays whose concept was removed', () => {
  const model = baseModel();
  const raw = {
    ...createState(model, '2026-01-01T00:00:00Z'),
    conceptRevisions: { 'removed-concept': { title: '我的改名', updatedAt: '2026-01-01T00:00:00Z', modelFingerprint: 'x' } },
    explanations: { 'removed-concept': { text: '我的解释', updatedAt: '2026-01-01T00:00:00Z' } },
    summaries: { 'removed-concept': { text: '我的总结', updatedAt: '2026-01-01T00:00:00Z' } },
    ownQuestions: { 'q-orphan': { id: 'q-orphan', conceptId: 'removed-concept', text: '我的问题', author: 'learner', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } },
    attempts: { 'p-removed': [{ id: 'att-1', promptId: 'p-removed', at: '2026-01-01T00:00:00Z', answer: 'a', rating: 'good', assisted: false, fingerprint: 'x', corrections: [] }] },
    schedules: { 'p-removed': { dueAt: '2026-01-02T00:00:00Z', intervalDays: 1, lastRating: 'good', lastAt: '2026-01-01T00:00:00Z' } },
    relationRevisions: { 'rel-removed': { label: '我的关系', updatedAt: '2026-01-01T00:00:00Z' } },
  };
  // Must not throw: this is the finding that previously produced E_STATE.
  const state = normalizeState(raw, model);
  assert.ok(state.conceptRevisions['removed-concept']);
  const { state: synced, orphans } = syncModel(state, model, '2026-01-02T00:00:00Z');
  assert.deepEqual(synced.conceptRevisions['removed-concept'].title, '我的改名', 'orphan overlay is preserved');
  assert.deepEqual(synced.explanations['removed-concept'].text, '我的解释');
  assert.deepEqual(synced.attempts['p-removed'].length, 1, 'orphan attempts preserved');
  const kinds = new Set(orphans.map((o) => o.kind));
  for (const kind of ['concept-revision', 'relation-revision', 'explanation', 'summary', 'own-question', 'attempt', 'schedule']) {
    assert.ok(kinds.has(kind), `orphan report should include ${kind}`);
  }
  assert.equal(synced.orphans.length, orphans.length);
});

test('syncModel reports removed prompts and avoids rendering dangling active references', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-apply', { at: '2026-01-01T01:00:00Z' });
  const updated = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.filter((p) => p.id !== 'p-prior-apply'),
  });
  const { state: synced, orphans } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  assert.ok(orphans.some((o) => o.kind === 'attempt' && o.id === 'p-prior-apply'));
  // The removed prompt is not actively playable or due.
  assert.equal(resolvePrompt(updated, synced, 'p-prior-apply'), null);
  const due = listDue(synced, updated, '2026-02-01T00:00:00Z');
  assert.ok(!due.due.some((d) => d.promptId === 'p-prior-apply'));
  assert.ok(!Object.prototype.hasOwnProperty.call(stateView(synced, updated).prompts, 'p-prior-apply'));
});

// ---------------------------------------------------------------------------
// Import: immutable history, divergent edits, no blind revision overwrite.
// ---------------------------------------------------------------------------

test('import preserves immutable existing attempt history', () => {
  const model = baseModel();
  let current = createState(model, '2026-01-01T00:00:00Z');
  current = attempt(current, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', attemptId: 'att-keep' });
  const incoming = createState(model, '2026-01-01T00:00:00Z'); // no attempts
  const merged = mergeImportedState(current, incoming, model, '2026-01-05T00:00:00Z');
  assert.deepEqual(merged.attempts['p-ppv-explain'].map((a) => a.id), ['att-keep']);
});

test('import retains divergent user edits and reports a conflict instead of replacing by revision', () => {
  const model = baseModel();
  let current = createState(model, '2026-01-01T00:00:00Z');
  current.revision = 5;
  current.explanations.root = { text: '我的解释 v1', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  // Incoming claims a much higher revision and a different explanation.
  const incoming = createState(model, '2026-01-01T00:00:00Z');
  incoming.revision = 99;
  incoming.explanations.root = { text: '别人的解释 v2', updatedAt: '2026-01-02T01:00:00Z', author: 'learner' };
  const merged = mergeImportedState(current, incoming, model, '2026-01-05T00:00:00Z');
  assert.equal(merged.explanations.root.text, '我的解释 v1', 'existing edit is kept');
  assert.ok(merged.conflicts.some((c) => c.kind === 'explanations' && c.incoming.text === '别人的解释 v2'));
});

test('importing a duplicate attempt id does not add a second event', () => {
  const model = baseModel();
  let current = createState(model, '2026-01-01T00:00:00Z');
  current = attempt(current, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', attemptId: 'att-same' });
  const incoming = JSON.parse(JSON.stringify(current));
  incoming.revision = current.revision + 3;
  const merged = mergeImportedState(current, incoming, model, '2026-01-05T00:00:00Z');
  assert.equal(merged.attempts['p-ppv-explain'].length, 1);
});

test('import rejects a state belonging to a different model identity', () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const other = normalizeModel({ ...modelToJson(model), id: 'other-model' });
  const incoming = createState(other, '2026-01-01T00:00:00Z');
  assert.throws(
    () => mergeImportedState(current, incoming, model, '2026-01-05T00:00:00Z'),
    (err) => err.code === CODES.IDENTITY,
  );
});

// ---------------------------------------------------------------------------
// Chronology, replay, spacing streak reset.
// ---------------------------------------------------------------------------

test('applyAttempt rejects a timestamp earlier than the latest attempt', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-05T00:00:00Z' });
  assert.throws(
    () => applyAttempt(state, model, { promptId: 'p-ppv-explain', answer: '旧时间', rating: 'good' }, '2026-01-02T00:00:00Z'),
    (err) => err.code === CODES.USAGE && /早于/.test(err.message),
  );
});

test('duplicate attempt id is rejected as a replayed event', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', attemptId: 'att-dup' });
  assert.throws(
    () => applyAttempt(state, model, { promptId: 'p-ppv-explain', answer: 'again', rating: 'good', attemptId: 'att-dup' }, '2026-01-01T02:00:00Z'),
    (err) => err.code === CODES.CONFLICT,
  );
});

test('changed question content resets the spacing streak instead of extending it', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-01T01:00:00Z', answer: 'a', attemptId: 'a1' });
  state = attempt(state, model, 'p-ppv-explain', { at: '2026-01-02T01:00:00Z', answer: 'b', attemptId: 'a2' });
  assert.equal(state.schedules['p-ppv-explain'].streakKind, 'good');
  assert.equal(state.schedules['p-ppv-explain'].streakCount, 2);

  const updated = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.map((p) => (p.id === 'p-ppv-explain' ? { ...p, question: '全新题干' } : p)),
  });
  const out = applyAttempt(state, updated, { promptId: 'p-ppv-explain', answer: 'c', rating: 'good', attemptId: 'a3' }, '2026-01-03T01:00:00Z');
  assert.equal(out.contentChanged, true);
  assert.equal(out.schedule.streakCount, 1, 'streak restarts at 1 for the new content');
  assert.equal(out.schedule.intervalDays, 4);
  // Old attempt events are untouched.
  assert.equal(out.state.attempts['p-ppv-explain'].length, 3);
});

test('normalizeState sorts out-of-order attempt lists chronologically', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  state.attempts['p-ppv-explain'] = [
    { id: 'later', promptId: 'p-ppv-explain', at: '2026-01-03T00:00:00Z', answer: 'b', rating: 'good', assisted: false, fingerprint: 'x', corrections: [] },
    { id: 'earlier', promptId: 'p-ppv-explain', at: '2026-01-02T00:00:00Z', answer: 'a', rating: 'good', assisted: false, fingerprint: 'x', corrections: [] },
  ];
  const normalized = normalizeState(state, model);
  assert.deepEqual(normalized.attempts['p-ppv-explain'].map((a) => a.id), ['earlier', 'later']);
});

// ---------------------------------------------------------------------------
// Own questions: safe IDs, reference validation, model-prompt collision.
// ---------------------------------------------------------------------------

test('own question ids are validated and cannot collide with model prompts', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  assert.throws(
    () => applyOwnQuestion(state, model, { conceptId: 'root', text: 'Q', id: 'Bad ID' }, '2026-01-01T00:00:00Z'),
    (err) => err.code === CODES.USAGE,
  );
  assert.throws(
    () => applyOwnQuestion(state, model, { conceptId: 'root', text: 'Q', id: '__proto__' }, '2026-01-01T00:00:00Z'),
    (err) => err.code === CODES.USAGE,
  );
  assert.throws(
    () => applyOwnQuestion(state, model, { conceptId: 'missing', text: 'Q' }, '2026-01-01T00:00:00Z'),
    (err) => err.code === CODES.STATE,
  );
  assert.throws(
    () => applyOwnQuestion(state, model, { conceptId: 'root', text: 'Q', id: 'p-ppv-explain' }, '2026-01-01T00:00:00Z'),
    (err) => err.code === CODES.DUP_ID,
  );
  const out = applyOwnQuestion(state, model, { conceptId: 'root', text: '我的问题', id: 'q-mine' }, '2026-01-01T00:00:00Z');
  assert.equal(out.question.conceptId, 'root');
  assert.equal(out.question.id, 'q-mine');
});

// ---------------------------------------------------------------------------
// Finding 3b: evidence requires its referenced proof to remain active,
// related, and sufficient. Fingerprint equality alone is not proof.
// ---------------------------------------------------------------------------

function conceptProofModel(extra = {}) {
  return baseModel({
    prompts: [
      { id: 'p-prior-effect', conceptId: 'prior', kind: 'explain', question: '先验如何影响后验?', answer: '乘以似然', criteria: ['写出贝叶斯更新'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
    ...extra,
  });
}

test('concept proof goes stale when only the supporting question criteria change', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-effect', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-prior' });
  state = applyTutorEvidence(state, model, {
    conceptId: 'prior', status: 'explained', note: '能解释先验作用', attemptIds: ['att-prior'],
  }, '2026-01-01T02:00:00Z').state;
  assert.equal(isConceptEvidenceActive(model, state, 'prior'), true);
  assert.equal(stateView(state, model).conceptStatus.prior.status, 'explained');

  // Only the prompt's criteria change; concept content and fingerprint are intact.
  const updated = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.map((p) => (p.id === 'p-prior-effect' ? { ...p, criteria: ['写出先验、似然与分母'] } : p)),
  });
  assert.equal(updated.conceptFingerprints.prior, model.conceptFingerprints.prior, 'concept content unchanged');
  assert.notEqual(updated.promptFingerprints['p-prior-effect'], model.promptFingerprints['p-prior-effect']);

  const { state: synced } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  assert.equal(isPromptStale(updated, synced, 'p-prior-effect'), true);
  assert.equal(isConceptEvidenceActive(updated, synced, 'prior'), false, 'obsolete question proof must not stay active');
  const view = stateView(synced, updated);
  assert.equal(view.conceptStatus.prior.status, 'unknown', 'changed supporting question must not display mastery');
  assert.equal(view.conceptStatus.prior.staleEvidence.status, 'explained', 'history is retained for review');
  // The stored evidence itself is preserved, not deleted.
  assert.equal(synced.conceptEvidence.prior.status, 'explained');
});

test('deleting the evidence question invalidates the concept proof but keeps history', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-effect', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-prior' });
  state = applyTutorEvidence(state, model, {
    conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'],
  }, '2026-01-01T02:00:00Z').state;

  const updated = normalizeModel({ ...modelToJson(model), prompts: model.prompts.filter((p) => p.id !== 'p-prior-effect') });
  const { state: synced } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  assert.equal(isConceptEvidenceActive(updated, synced, 'prior'), false);
  assert.equal(stateView(synced, updated).conceptStatus.prior.status, 'unknown');
  assert.equal(synced.conceptEvidence.prior.status, 'explained');
});

test('a forged evidence object with matching hashes but no real proof never shows mastery', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-effect', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-prior' });
  state = applyTutorEvidence(state, model, {
    conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'],
  }, '2026-01-01T02:00:00Z').state;

  // Forge: hashes still match, but the referenced attempt does not exist.
  state.conceptEvidence.prior = { ...state.conceptEvidence.prior, attemptIds: ['att-ghost'] };
  assert.equal(isConceptEvidenceActive(model, state, 'prior'), false);
  assert.equal(stateView(state, model).conceptStatus.prior.status, 'unknown');

  // Legacy/no-basis record: valid fingerprint but no attempt ids at all.
  state.conceptEvidence.prior = { ...state.conceptEvidence.prior, attemptIds: [] };
  assert.equal(isConceptEvidenceActive(model, state, 'prior'), false);
  assert.equal(stateView(state, model).conceptStatus.prior.status, 'unknown');
});

test('a forged prompt evidence object with a matching fingerprint needs real active attempts', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-effect', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-prior' });
  state = applyTutorEvidence(state, model, {
    promptId: 'p-prior-effect', status: 'explained', note: '能解释', attemptIds: ['att-prior'],
  }, '2026-01-01T02:00:00Z').state;
  assert.equal(isPromptEvidenceActive(model, state, 'p-prior-effect'), true);

  state.promptEvidence['p-prior-effect'] = { ...state.promptEvidence['p-prior-effect'], attemptIds: ['att-ghost'] };
  assert.equal(isPromptEvidenceActive(model, state, 'p-prior-effect'), false);
  assert.equal(stateView(state, model).prompts['p-prior-effect'].evidence, null);

  // A supporting attempt that later loses activity (stale fingerprint) also fails.
  state = applyTutorEvidence(state, model, {
    promptId: 'p-prior-effect', status: 'explained', note: '再次复核', attemptIds: ['att-prior'],
  }, '2026-01-01T03:00:00Z').state;
  const updated = normalizeModel({ ...modelToJson(model), prompts: model.prompts.map((p) => (p.id === 'p-prior-effect' ? { ...p, question: '改后的题干' } : p)) });
  assert.equal(isPromptEvidenceActive(updated, state, 'p-prior-effect'), false);
});

test('unchanged valid concept and prompt proof stays active after syncModel', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = attempt(state, model, 'p-prior-effect', { at: '2026-01-01T01:00:00Z', assisted: false, attemptId: 'att-prior' });
  state = applyTutorEvidence(state, model, {
    conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'],
  }, '2026-01-01T02:00:00Z').state;
  state = applyTutorEvidence(state, model, {
    promptId: 'p-prior-effect', status: 'explained', note: '能解释', attemptIds: ['att-prior'],
  }, '2026-01-01T02:30:00Z').state;

  const { state: synced } = syncModel(state, model, '2026-01-02T00:00:00Z');
  assert.equal(isConceptEvidenceActive(model, synced, 'prior'), true);
  assert.equal(isPromptEvidenceActive(model, synced, 'p-prior-effect'), true);
  const view = stateView(synced, model);
  assert.equal(view.conceptStatus.prior.status, 'explained');
  assert.ok(view.prompts['p-prior-effect'].evidence);
});

// ---------------------------------------------------------------------------
// Preserved public exports / signatures.
// ---------------------------------------------------------------------------

test('preserved public helpers keep working (notes, titles, relations, due)', () => {
  const model = baseModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyNote(state, model, { conceptId: 'root', text: '我的解释', kind: 'explanation' }, '2026-01-01T00:01:00Z').state;
  state = applyTitleRevision(state, model, { conceptId: 'root', title: '改名' }, '2026-01-01T00:02:00Z').state;
  state = applyRelationRevision(state, model, { relationId: 'rel-prior-to-ppv', label: '新关系名' }, '2026-01-01T00:03:00Z').state;
  const due = listDue(state, model, '2026-01-01T00:03:00Z');
  assert.ok(Array.isArray(due.due) && Array.isArray(due.unscheduled));
  assert.ok(validateStateShape(state, model));
  const merged = mergeImportedState(state, state, model, '2026-01-01T00:04:00Z');
  assert.equal(merged.explanations.root.text, '我的解释');
});
