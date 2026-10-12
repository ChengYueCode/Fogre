// Task-13 insight-note regressions.
//
// These cover the public backend contract for ticket 13: optional note history,
// shared validation and merging, the pure per-concept read model, the read-only
// `insights` CLI, the build marker, and the public HTTP note write path. All
// fixtures are synthetic and temporary; nothing here is real learner evidence.
//
// Run: node --test tests/insights.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODES } from '../skill/forge/scripts/lib/errors.mjs';
import { modelToJson, normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import {
  createState,
  mergeImportedState,
  normalizeState,
  validateStateShape,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';
import {
  insightMergeNotes,
  insightRead,
  insightRecordNote,
  insightValidateNotes,
} from '../skill/forge/scripts/lib/insights.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const INSIGHTS_LIB = path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'insights.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-insights-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawModel() {
  return {
    schemaVersion: 1,
    id: 'insights-model',
    title: '洞见主题',
    goal: '能解释并应用',
    concepts: [
      {
        id: 'root',
        title: '根概念',
        parentId: null,
        difficulty: 1,
        explanation: '作者原理解',
        example: '作者例子',
        misconception: '常见误解',
      },
      {
        id: 'leaf',
        title: '叶子概念',
        parentId: 'root',
        difficulty: 2,
        explanation: '叶子原理解',
      },
    ],
    relations: [
      { id: 'rel-root-leaf', from: 'root', to: 'leaf', type: 'prerequisite', label: '先根后叶' },
    ],
    prompts: [
      {
        id: 'p-explain',
        conceptId: 'leaf',
        kind: 'explain',
        question: '请解释叶子概念',
        answer: '叶子参考答案',
        criteria: ['说出机制', '指出边界'],
      },
    ],
  };
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : JSON.parse(text) };
}

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

function writeLearningDir(dir, model, state) {
  atomicWrite(path.join(dir, 'model.json'), stableStringify(modelToJson(model)));
  atomicWrite(path.join(dir, 'state.json'), stableStringify(state));
}

function attempt(overrides) {
  return {
    id: 'att-1',
    promptId: 'p-explain',
    conceptId: 'leaf',
    at: '2026-10-01T00:00:00.000Z',
    submittedAt: '2026-10-01T00:00:00.000Z',
    answer: '真实原答',
    rating: null,
    assisted: false,
    assistance: [],
    submission: { assisted: false, assistance: [] },
    source: 'browser',
    sessionId: 'practice-1',
    fingerprint: 'current-fingerprint',
    modelFingerprint: 'model-fingerprint',
    modelRevision: 1,
    corrections: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Note history, strict validation and idempotency
// ---------------------------------------------------------------------------

test('legacy notes validate without history and a pure read never rewrites them', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  state.explanations.leaf = { text: '旧解释', updatedAt: '2026-01-01T00:00:00Z' };
  const before = stableStringify(state);

  const validated = insightValidateNotes(state);
  assert.equal(validated.explanations.leaf.text, '旧解释');
  assert.equal(Object.hasOwn(state.explanations.leaf, 'history'), false);

  const view = insightRead(state, model, 'leaf');
  assert.equal(view.concepts.length, 1);
  assert.equal(view.concepts[0].explanation.text, '旧解释');
  assert.equal(view.concepts[0].explanation.author, 'unknown', 'missing legacy author is reported as unknown');
  assert.equal(view.concepts[0].explanation.updatedAt, '2026-01-01T00:00:00Z');
  assert.equal(stableStringify(state), before, 'the read model leaves the archive untouched');
});

test('new notes require a real author role while legacy author variants stay truthful', () => {
  const model = normalizeModel(rawModel());
  const at1 = '2026-10-01T00:00:00.000Z';
  const at2 = '2026-10-02T00:00:00.000Z';
  assert.throws(() => insightRecordNote(createState(model), model, {
    conceptId: 'leaf', kind: 'explanation', text: '新文本', author: 'ai',
  }, at1), (err) => err.code === CODES.USAGE && err.path === 'author');

  const explicit = insightRecordNote(createState(model), model, {
    conceptId: 'leaf', kind: 'explanation', text: '导师文本', author: 'tutor',
  }, at1);
  assert.equal(explicit.note.author, 'tutor');
  const implicit = insightRecordNote(createState(model), model, {
    conceptId: 'leaf', kind: 'explanation', text: '学习者文本',
  }, at1);
  assert.equal(implicit.note.author, 'learner', 'the browser/legacy omitted-author path stays learner');

  const legacyVariant = createState(model);
  legacyVariant.explanations.leaf = { text: 'agent imported', updatedAt: at1, author: 'imported-agent' };
  const view = insightRead(legacyVariant, model, 'leaf');
  assert.equal(view.concepts[0].explanation.author, 'imported-agent', 'legacy variants are not rewritten');
  const overwritten = insightRecordNote(legacyVariant, model, {
    conceptId: 'leaf', kind: 'explanation', text: 'new learner text', author: 'learner',
  }, at2);
  assert.equal(overwritten.state.explanations.leaf.history[0].author, 'imported-agent');

  const missing = createState(model);
  missing.explanations.leaf = { text: 'missing author', updatedAt: at1 };
  const missingView = insightRead(missing, model, 'leaf');
  assert.equal(missingView.concepts[0].explanation.author, 'unknown');
  const missingOverwrite = insightRecordNote(missing, model, {
    conceptId: 'leaf', kind: 'explanation', text: 'new learner text',
  }, at2);
  assert.equal(missingOverwrite.state.explanations.leaf.history[0].author, 'unknown');
});

test('recording a changed note appends the previous version and repeated saves are idempotent', () => {
  const model = normalizeModel(rawModel());
  const at1 = '2026-10-01T00:00:00.000Z';
  const at2 = '2026-10-02T00:00:00.000Z';
  const at3 = '2026-10-03T00:00:00.000Z';
  const at4 = '2026-10-04T00:00:00.000Z';

  const first = insightRecordNote(createState(model), model, {
    conceptId: 'leaf', kind: 'explanation', text: 'v1', author: 'learner',
  }, at1);
  const repeated = insightRecordNote(first.state, model, {
    conceptId: 'leaf', kind: 'explanation', text: 'v1', author: 'learner',
  }, at2);
  assert.equal(repeated.state, first.state, 'same text and author is a no-op');
  assert.equal(repeated.note.updatedAt, at1, 'an idempotent save does not move updatedAt');
  assert.equal(Object.hasOwn(repeated.note, 'history'), false);

  const second = insightRecordNote(repeated.state, model, {
    conceptId: 'leaf', kind: 'explanation', text: 'v2', author: 'learner',
  }, at3);
  assert.equal(second.state.explanations.leaf.text, 'v2');
  assert.equal(second.state.explanations.leaf.history.length, 1);
  assert.equal(second.state.explanations.leaf.history[0].text, 'v1');
  assert.equal(second.state.explanations.leaf.history[0].author, 'learner');
  assert.equal(second.state.explanations.leaf.history[0].updatedAt, at1);
  assert.ok(second.state.explanations.leaf.history[0].id.includes('v1'), 'the stable id is the exact version tuple');
  assert.ok(second.state.explanations.leaf.history[0].id.length > 16, 'the id is not a short hash');

  const third = insightRecordNote(second.state, model, {
    conceptId: 'leaf', kind: 'summary', text: '总结 v1', author: 'learner',
  }, at4);
  const fourth = insightRecordNote(third.state, model, {
    conceptId: 'leaf', kind: 'summary', text: '总结 v2', author: 'tutor',
  }, '2026-10-05T00:00:00.000Z');
  assert.equal(fourth.state.summaries.leaf.history.length, 1);
  assert.equal(fourth.state.summaries.leaf.history[0].text, '总结 v1');
  assert.equal(fourth.state.summaries.leaf.history[0].author, 'learner');
  validateStateShape(fourth.state, model);
});

test('malformed history fails closed with a precise E_STATE path', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  state.explanations.leaf = {
    text: 'v2',
    updatedAt: '2026-10-02T00:00:00Z',
    author: 'learner',
    history: [
      { id: 'h1', text: 'v1', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' },
    ],
  };
  validateStateShape(state, model);

  const nullHistory = cloneJson(state);
  nullHistory.explanations.leaf.history = null;
  assert.throws(() => validateStateShape(nullHistory, model), (err) =>
    err.code === CODES.STATE && err.path === 'explanations.leaf.history');

  const missingAuthor = cloneJson(state);
  delete missingAuthor.explanations.leaf.history[0].author;
  assert.throws(() => validateStateShape(missingAuthor, model), (err) =>
    err.code === CODES.STATE && err.path === 'explanations.leaf.history[0].author');

  const duplicateId = cloneJson(state);
  duplicateId.explanations.leaf.history.push({
    id: 'h1', text: 'different', author: 'learner', updatedAt: '2026-10-03T00:00:00Z',
  });
  assert.throws(() => validateStateShape(duplicateId, model), (err) =>
    err.code === CODES.STATE && err.path === 'explanations.leaf.history[1].id');

  const badBucket = cloneJson(state);
  badBucket.explanations = [];
  assert.throws(() => validateStateShape(badBucket, model), (err) =>
    err.code === CODES.STATE && err.path === 'explanations');
});

// ---------------------------------------------------------------------------
// Shared merge: visible version, history union, conflict preservation
// ---------------------------------------------------------------------------

test('insightMergeNotes keeps the current visible note and unions both histories', () => {
  const current = {
    leaf: {
      text: 'current',
      updatedAt: '2026-10-02T00:00:00Z',
      author: 'learner',
      history: [{ id: 'h-current', text: 'older current', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' }],
    },
  };
  const incoming = {
    leaf: {
      text: 'incoming',
      updatedAt: '2026-10-03T00:00:00Z',
      author: 'learner',
      history: [{ id: 'h-incoming', text: 'older incoming', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' }],
    },
  };
  const conflicts = [];
  const merged = insightMergeNotes(current, incoming, conflicts, '2026-10-04T00:00:00Z', 'explanations');
  assert.equal(merged.leaf.text, 'current', 'the first argument remains visible');
  assert.deepEqual(merged.leaf.history.map((entry) => entry.text), ['older current', 'older incoming', 'incoming']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'explanations');
  assert.equal(conflicts[0].kept.text, 'current');
  assert.equal(conflicts[0].incoming.text, 'incoming');

  const repeated = insightMergeNotes(merged, incoming, [], '2026-10-05T00:00:00Z', 'explanations');
  assert.deepEqual(repeated.leaf.history.map((entry) => entry.text), ['older current', 'older incoming', 'incoming']);
  assert.equal(repeated.leaf.history.length, 3, 'repeating the same import does not duplicate history');
});

test('insightMergeNotes reports same-id/different-content history without dropping other versions', () => {
  const current = {
    leaf: {
      text: 'visible',
      updatedAt: '2026-10-02T00:00:00Z',
      author: 'learner',
      history: [
        { id: 'h-shared', text: 'current shared', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 'h-current-only', text: 'current only', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' },
      ],
    },
  };
  const incoming = {
    leaf: {
      text: 'visible',
      updatedAt: '2026-10-03T00:00:00Z',
      author: 'learner',
      history: [
        { id: 'h-shared', text: 'incoming shared', author: 'learner', updatedAt: '2026-10-03T00:00:00Z' },
        { id: 'h-incoming-only', text: 'incoming only', author: 'learner', updatedAt: '2026-10-03T00:00:00Z' },
      ],
    },
  };
  const conflicts = [];
  const merged = insightMergeNotes(current, incoming, conflicts, '2026-10-04T00:00:00Z', 'summary');
  assert.equal(merged.leaf.text, 'visible');
  const ids = merged.leaf.history.map((entry) => entry.id);
  assert.deepEqual(ids, ['h-shared', 'h-current-only', 'h-incoming-only']);
  assert.equal(merged.leaf.history[0].text, 'current shared');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'summary');
  assert.equal(conflicts[0].path, 'summary.leaf.history.h-shared');
  assert.equal(conflicts[0].kept.text, 'current shared');
  assert.equal(conflicts[0].incoming.text, 'incoming shared');
});

test('mergeImportedState and normalizeState preserve note history', () => {
  const model = normalizeModel(rawModel());
  const current = createState(model);
  current.explanations.leaf = {
    text: 'current',
    updatedAt: '2026-10-02T00:00:00Z',
    author: 'learner',
    history: [{ id: 'h1', text: 'current old', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' }],
  };
  const incoming = createState(model);
  incoming.revision = 3;
  incoming.explanations.leaf = {
    text: 'incoming',
    updatedAt: '2026-10-03T00:00:00Z',
    author: 'learner',
    history: [{ id: 'h2', text: 'incoming old', author: 'learner', updatedAt: '2026-10-01T00:00:00Z' }],
  };
  const merged = mergeImportedState(current, incoming, model, '2026-10-04T00:00:00Z');
  assert.equal(merged.explanations.leaf.text, 'current');
  assert.deepEqual(merged.explanations.leaf.history.map((entry) => entry.text), ['current old', 'incoming old', 'incoming']);
  assert.ok(merged.conflicts.some((conflict) => conflict.kind === 'explanations' && conflict.path === 'explanations.leaf'));

  const normalized = normalizeState(merged, model);
  assert.equal(normalized.explanations.leaf.text, 'current');
  assert.equal(normalized.explanations.leaf.history.length, 3);
});

// ---------------------------------------------------------------------------
// Read model: real answers, corrections, tutor feedback, stale/orphan state
// ---------------------------------------------------------------------------

test('insightRead aggregates real answer records, feedback, corrections and questions without granting mastery', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const currentFingerprint = model.promptFingerprints['p-explain'];
  state.attempts['p-explain'] = [
    attempt({
      id: 'att-old',
      at: '2026-10-01T00:00:00.000Z',
      submittedAt: '2026-10-01T00:00:00.000Z',
      answer: '旧内容答案',
      assisted: true,
      assistance: ['hint'],
      submission: { assisted: true, assistance: ['hint'] },
      fingerprint: 'old-fingerprint',
    }),
    attempt({
      id: 'att-current',
      at: '2026-10-02T00:00:00.000Z',
      submittedAt: '2026-10-02T00:00:00.000Z',
      answer: '当前内容答案',
      fingerprint: currentFingerprint,
      corrections: [
        { id: 'corr-1', attemptId: 'att-current', text: '后来补上的修正', at: '2026-10-02T01:00:00.000Z', source: 'browser', assistance: ['tutor-feedback'] },
      ],
      tutorFeedback: [
        { id: 'fb-1', assessmentId: 'assess-1', text: '普通导师反馈', at: '2026-10-02T02:00:00.000Z', source: 'tutor' },
      ],
    }),
  ];
  state.explanations.leaf = {
    text: '我的解释',
    updatedAt: '2026-10-02T00:00:00.000Z',
    author: 'learner',
  };
  state.summaries.leaf = {
    text: '我的总结 v2',
    updatedAt: '2026-10-03T00:00:00.000Z',
    author: 'learner',
    history: [{ id: 'sum-h1', text: '我的总结 v1', author: 'learner', updatedAt: '2026-10-01T00:00:00.000Z' }],
  };
  state.ownQuestions.leafQuestion = {
    id: 'leafQuestion',
    conceptId: 'leaf',
    text: '什么时候会失效？',
    author: 'learner',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  state.reviewRequests = {
    'req-1': {
      id: 'req-1',
      members: [
        {
          attemptId: 'att-current',
          promptId: 'p-explain',
          status: 'completed',
          feedback: {
            correct: '判断正确',
            misconceptions: '无',
            basis: '依据判定标准',
            repair: '无需修正',
            nextTask: '继续变式',
            rating: 'good',
          },
        },
        {
          attemptId: 'att-old',
          promptId: 'p-explain',
          status: 'pending',
          feedback: null,
        },
      ],
    },
  };
  state.explanations.removed = {
    text: '已移除概念的历史解释',
    updatedAt: '2026-10-01T00:00:00.000Z',
    author: 'learner',
  };
  const before = stableStringify(state);

  const view = insightRead(state, model, 'leaf');
  const concept = view.concepts[0];
  assert.equal(concept.conceptId, 'leaf');
  assert.equal(concept.historical, false);
  assert.equal(concept.authorExplanation, '叶子原理解');
  assert.equal(concept.explanation.text, '我的解释');
  assert.equal(concept.summary.history.length, 1);
  assert.equal(concept.questions.length, 1);
  assert.equal(concept.questions[0].text, '什么时候会失效？');
  assert.equal(concept.attempts.length, 2);
  const stale = concept.attempts.find((item) => item.id === 'att-old');
  const current = concept.attempts.find((item) => item.id === 'att-current');
  assert.equal(stale.stale, true);
  assert.equal(stale.assisted, true);
  assert.equal(current.stale, false);
  assert.equal(current.corrections[0].text, '后来补上的修正');
  assert.equal(current.tutorFeedback[0].text, '普通导师反馈');
  assert.equal(current.reviews[0].requestId, 'req-1');
  assert.equal(current.reviews[0].status, 'completed');
  assert.equal(current.reviews[0].feedback.correct, '判断正确');
  assert.equal(current.reviews[0].feedbackComplete, true);
  assert.equal(current.reviews[0].feedbackMissing, false);
  assert.equal(current.reviews[0].pending, false);
  assert.equal(current.reviews[0].source, 'tutor');
  assert.equal(stale.reviews[0].pending, true);
  assert.equal(stale.reviews[0].feedback, null);
  assert.equal(stale.reviews[0].feedbackComplete, false);
  assert.equal(stale.reviews[0].feedbackMissing, false, 'a not-yet-resolved member is pending, not missing feedback');
  assert.deepEqual(current.corrections[0].assistance, ['tutor-feedback']);
  assert.equal('answer' in current.corrections[0], false, 'a correction is text+assistance, not a second answer');
  assert.equal('assisted' in current.corrections[0], false);
  assert.equal('mastery' in concept, false, 'notes and feedback never create a mastery field');
  assert.equal('conceptEvidence' in concept, false);
  assert.equal(stableStringify(state), before, 'the read model is pure');

  const all = insightRead(state, model);
  const removed = all.concepts.find((item) => item.conceptId === 'removed');
  assert.ok(removed);
  assert.equal(removed.historical, true);
  assert.equal(removed.explanation.text, '已移除概念的历史解释');

  const rawModelObject = { concepts: model.concepts, prompts: model.prompts };
  const rawView = insightRead(state, rawModelObject, 'leaf');
  assert.equal(rawView.concepts[0].attempts.find((item) => item.id === 'att-current').stale, false,
    'raw browser model shape can reproduce the current fingerprint without byId');
});

// ---------------------------------------------------------------------------
// Public CLI, build marker and HTTP write path
// ---------------------------------------------------------------------------

test('public insights CLI is read-only, filters concepts, and rejects malformed history', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach(cleanup));
  const dir = tmpDir();
  dirs.push(dir);
  const model = normalizeModel(rawModel());
  const state = createState(model);
  state.explanations.leaf = { text: '可读解释', updatedAt: '2026-10-01T00:00:00Z', author: 'learner' };
  writeLearningDir(dir, model, state);
  const statePath = path.join(dir, 'state.json');
  const before = fs.readFileSync(statePath, 'utf8');

  const all = runJson(['insights', '--out', dir]);
  assert.equal(all.readOnly, true);
  assert.ok(all.concepts.some((item) => item.conceptId === 'leaf'));
  const one = runJson(['insights', '--out', dir, '--concept', 'leaf']);
  assert.equal(one.concepts.length, 1);
  assert.equal(one.concepts[0].explanation.text, '可读解释');
  assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'insights is a read-only command');

  const bad = cloneJson(state);
  bad.summaries.leaf = { text: 'x', updatedAt: '2026-10-01T00:00:00Z', author: 'learner', history: null };
  atomicWrite(statePath, stableStringify(bad));
  const failed = runCli(['insights', '--out', dir]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /E_STATE/);
  assert.match(failed.stderr, /summaries\.leaf\.history/);
});

test('build inlines the shared insight library at its marker', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const source = path.join(dir, 'source.json');
  atomicWrite(source, stableStringify(modelToJson(model)));
  const result = buildArtifacts({ modelPath: source, outDir: dir, viewerPath: VIEWER, at: '2026-10-01T00:00:00Z' });
  const html = fs.readFileSync(result.paths.html, 'utf8');
  assert.equal(html.includes('/*__EMBER_INSIGHTS_LIBRARY__*/'), false, 'the marker is replaced');
  assert.match(html, /function insightRead\s*\(/, 'the shared read model is inlined');
  assert.match(html, /function insightRecordNote\s*\(/, 'the shared note recorder is inlined');
  assert.match(html, /function insightMergeNotes\s*\(/, 'the shared note merge is inlined');
  assert.equal(INSIGHTS_LIB.includes('require('), false);
});

test('the shared insight library is portable and keeps all helpers namespaced', () => {
  const source = fs.readFileSync(INSIGHTS_LIB, 'utf8');
  for (const forbidden of ['require(', 'process.', 'fs.', 'path.', 'node:', 'Buffer', 'globalThis', 'innerHTML', 'eval(', 'new Function', 'document.write']) {
    assert.equal(source.includes(forbidden), false, `insights.mjs must not use ${forbidden}`);
  }
  assert.equal(/^import\s/m.test(source), false, 'insights.mjs has no static imports');
  const names = [...source.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map((match) => match[1]);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(name.startsWith('insight'), `${name} must stay namespaced`);
});

test('HTTP note saves preserve the prior note version and survive a normalized read-back', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const model = normalizeModel(rawModel());
  const initial = createState(model);
  writeLearningDir(dir, model, initial);

  await withServer(dir, async (server) => {
    const first = await postJson(`${server.url}/api/note`, {
      revision: 0,
      modelFingerprint: model.modelFingerprint,
      conceptId: 'leaf',
      kind: 'explanation',
      text: 'HTTP v1',
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.state.explanations.leaf.text, 'HTTP v1');

    const second = await postJson(`${server.url}/api/note`, {
      revision: first.json.state.revision,
      modelFingerprint: model.modelFingerprint,
      conceptId: 'leaf',
      kind: 'explanation',
      text: 'HTTP v2',
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.state.explanations.leaf.text, 'HTTP v2');
    assert.equal(second.json.state.explanations.leaf.history.length, 1);
    assert.equal(second.json.state.explanations.leaf.history[0].text, 'HTTP v1');

    const repeated = await postJson(`${server.url}/api/note`, {
      revision: second.json.state.revision,
      modelFingerprint: model.modelFingerprint,
      conceptId: 'leaf',
      kind: 'explanation',
      text: 'HTTP v2',
    });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.json));
    assert.equal(repeated.json.state.explanations.leaf.history.length, 1, 'same text+author is idempotent');
  });

  const stored = readJson(path.join(dir, 'state.json'));
  const normalized = normalizeState(stored, model);
  assert.equal(normalized.explanations.leaf.text, 'HTTP v2');
  assert.equal(normalized.explanations.leaf.history[0].text, 'HTTP v1');
});
