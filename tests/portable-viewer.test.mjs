// Task-07 portable handoff viewer regressions.
//
// These load the real assets/viewer.html script under a minimal DOM shim with
// the same three library injections the builder performs (round, schedule and
// tutor-review), so the page runs the exact shared pure functions the Node
// backend imports. They cover the ticket-07 page contract: a lower-revision
// browser cache reconciles its legal learner deltas against the trusted payload
// instead of being discarded or overriding it, cached-only tutor authority is
// quarantined, the merged archive stays readable by the strengthened core
// validator, and the learner-facing handoff guide names real flags and steps.
//
// Run: node --test tests/portable-viewer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  createState,
  applyLearningRound,
  normalizeState,
  validateStateShape,
} from '../skill/forge/scripts/lib/state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerPath = path.join(here, '..', 'skill', 'forge', 'assets', 'viewer.html');
const stripExports = (source) => source.replace(/^export /gm, '');
const lib = (name) => stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', name), 'utf8'));
const viewerHtml = fs.readFileSync(viewerPath, 'utf8')
  .replace('/*__EMBER_ROUND_LIBRARY__*/', () => lib('round.mjs'))
  .replace('/*__EMBER_SCHEDULE_LIBRARY__*/', () => lib('schedule.mjs'))
  .replace('/*__EMBER_TUTOR_REVIEW_LIBRARY__*/', () => lib('tutor-review.mjs'))
  .replace('/*__EMBER_INTERACTIONS_LIBRARY__*/', () => lib('interactions.mjs'))
  .replace('/*__EMBER_INSIGHTS_LIBRARY__*/', () => lib('insights.mjs'))
  .replace('/*__EMBER_CORRECTIONS_LIBRARY__*/', () => lib('corrections.mjs'));
const scriptBody = (() => {
  const start = viewerHtml.lastIndexOf('<script>');
  assert.ok(start !== -1, 'viewer must contain a script block');
  const end = viewerHtml.indexOf('</script>', start);
  assert.ok(end !== -1, 'viewer script must be closed');
  return viewerHtml.slice(viewerHtml.indexOf('>', start) + 1, end);
})();

function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext() {
      return { font: '', fillStyle: '', setTransform() {}, clearRect() {}, fillRect() {}, measureText() { return { width: 0 }; } };
    },
  };
}

class ShimNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this._text = '';
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.classList = {
      add: (...names) => { this.className = [...new Set((this.className || '').split(' ').concat(names))].join(' '); },
      remove: (...names) => { this.className = (this.className || '').split(' ').filter((name) => !names.includes(name)).join(' '); },
      contains: (name) => (this.className || '').split(' ').includes(name),
    };
  }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(text) { this._text = String(text); this.children = []; }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') { for (const item of [...child.children]) this.appendChild(item); child.children = []; return child; }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child); return child;
  }
  removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    event.preventDefault ||= () => {}; event.stopPropagation ||= () => {};
    for (const fn of this.listeners.get(event.type) || []) fn.call(this, event);
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : (this.parentNode ? this.parentNode.closest(selector) : null); }
}

function baseModel(extra = {}) {
  return normalizeModel({
    schemaVersion: 1,
    id: 'portable-viewer-test',
    title: '条件概率',
    goal: '理解先验与 PPV',
    concepts: [
      { id: 'root', title: '条件概率', parentId: null, difficulty: 1, explanation: '基础定义' },
      { id: 'prior', title: '先验概率', parentId: 'root', difficulty: 1, explanation: '证据前的信念' },
      { id: 'ppv', title: '阳性预测值', parentId: 'root', difficulty: 3, explanation: '阳性中真患病比例' },
    ],
    prompts: [
      { id: 'p-prior-apply', conceptId: 'prior', kind: 'apply', question: '患病率 2% 时 PPV?', answer: '约 27%', criteria: ['先算真阳性'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
    relations: [],
    sources: [{ id: 'src-1', title: '合成教学材料' }],
    ...extra,
  });
}

function buildPayload(model, state) {
  return {
    model: modelToJson(model),
    state,
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: Object.assign({}, model.promptFingerprints),
    conceptFingerprints: Object.assign({}, model.conceptFingerprints),
  };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function loadViewer(payload, options = {}) {
  const dataEl = { textContent: JSON.stringify(payload) };
  const documentShim = {
    createElement(tag) { return tag === 'canvas' ? Object.assign(new ShimNode(tag), makeCanvas()) : new ShimNode(tag); },
    createElementNS() { return new ShimNode(); },
    createDocumentFragment() { return new ShimNode('#fragment'); },
    createTextNode(text) { return Object.assign(new ShimNode('#text'), { textContent: text }); },
    querySelector(sel) { return sel === '#ember-data' ? dataEl : options.elements?.[sel] || null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    activeElement: null,
    body: new ShimNode('body'),
  };
  const sandbox = {
    console, document: documentShim, location: { protocol: 'file:' },
    localStorage: options.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: options.fetch || (async () => ({ ok: false })),
    requestAnimationFrame(cb) { return cb(); },
    setTimeout, clearTimeout, TextEncoder, crypto: globalThis.crypto,
    URL: { createObjectURL() { return 'blob:portable-viewer'; }, revokeObjectURL() {} },
    Node: ShimNode, Blob, navigator: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__EMBER_TEST__ = true;
  vm.createContext(sandbox);
  vm.runInContext(scriptBody, sandbox, { filename: 'viewer.html' });
  const internals = sandbox.__emberInternals;
  assert.ok(internals, 'viewer test hook should be exposed under __EMBER_TEST__');
  return internals;
}

// An immutable durable submission with no evaluation yet, exactly as the page
// stores a submit-before-rating answer.
function durableAnswer(model, promptId, attemptId, answer, at) {
  return {
    id: attemptId, promptId, conceptId: guessConcept(promptId), at, submittedAt: at, answer,
    rating: null, assisted: false, assistance: [], submission: { assisted: false, assistance: [] },
    source: 'browser', fingerprint: model.promptFingerprints[promptId], corrections: [],
  };
}
function guessConcept(promptId) { return promptId === 'p-prior-apply' ? 'prior' : 'ppv'; }
function selfEvent(id, attemptId, rating, at) {
  return { id, attemptId, targetCorrectionId: null, rating, at, source: 'browser' };
}
function tutorEvent(id, attemptId, rating, at) {
  return { id, attemptId, targetCorrectionId: null, rating, at, source: 'tutor' };
}
function feedbackFor(assessmentId, attemptId, at, text = '合成复核') {
  return { id: 'feedback-' + assessmentId, assessmentId, attemptId, targetCorrectionId: null, at, text, source: 'tutor' };
}

// ---------------------------------------------------------------------------
// Lower-revision cache contributes legal learner deltas
// ---------------------------------------------------------------------------

test('portable reconcile merges a lower-revision cache learner delta against a trusted payload', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';

  // Trusted payload (the rebuilt product): the immutable answer plus the tutor
  // review the session published. Higher revision counter.
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.revision = 18;
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  payload.attempts[pid][0].tutorAssessments = [tutorEvent('tutor-a-good', 'att-a', 'good', '2026-10-08T09:00:00Z')];
  payload.attempts[pid][0].tutorFeedback = [feedbackFor('tutor-a-good', 'att-a', '2026-10-08T09:00:00Z', '可信复核')];
  payload.promptEvidence[pid] = {
    status: 'explained', note: '可信产物证据', promptId: pid, fingerprint: model.promptFingerprints[pid],
    conceptId: 'ppv', conceptFingerprint: model.conceptFingerprints.ppv, attemptIds: ['att-a'], at: '2026-10-08T09:30:00Z',
  };

  // The browser cache: lower whole-archive revision, but it holds the later
  // learner deltas — a correction, a note, a summary, a later self rating.
  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.revision = 6;
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  cache.attempts[pid][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-08T10:00:00Z')];
  cache.attempts[pid][0].rating = 'good';
  cache.attempts[pid][0].corrections = [{ id: 'corr-a', attemptId: 'att-a', text: '后来的修正', at: '2026-10-08T10:30:00Z', source: 'browser', assistance: [] }];
  cache.explanations.root = { text: '缓存的解释', updatedAt: '2026-10-08T11:00:00Z', author: 'learner' };
  cache.summaries.root = { text: '缓存的总结', updatedAt: '2026-10-08T11:00:00Z', author: 'learner' };
  cache.practiceSessions['practice-a'] = {
    id: 'practice-a', promptId: pid, conceptId: 'ppv', fingerprint: model.promptFingerprints[pid],
    modelFingerprint: model.modelFingerprint, modelRevision: 1, source: 'browser',
    createdAt: '2026-10-08T11:00:00Z', updatedAt: '2026-10-08T11:00:00Z', draft: '未提交草稿', assistance: [],
  };

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));

  // The trusted payload is the base; the cache's learner delta is added.
  assert.equal(merged.revision, 18, 'the newer whole-archive revision wins');
  assert.equal(merged.attempts[pid][0].tutorAssessments[0].id, 'tutor-a-good', 'trusted tutor assessment survives');
  assert.equal(merged.attempts[pid][0].tutorFeedback[0].text, '可信复核', 'trusted feedback survives');
  assert.equal(merged.attempts[pid][0].corrections[0].id, 'corr-a', 'the later cached correction is kept');
  assert.equal(merged.attempts[pid][0].selfAssessments[0].id, 'self-a-good', 'the later cached self assessment is kept');
  assert.equal(merged.attempts[pid][0].rating, 'good', 'the compatibility scalar matches the merged self event');
  assert.equal(merged.explanations.root.text, '缓存的解释', 'the cached note is retained');
  assert.equal(merged.summaries.root.text, '缓存的总结', 'the cached summary is retained');
  assert.equal(merged.practiceSessions['practice-a'].draft, '未提交草稿', 'the cached draft is retained');
  assert.equal(merged.promptEvidence[pid].note, '可信产物证据', 'the trusted evidence record is the base');
  // The replayed schedule must reflect the trusted tutor rating, not the cache.
  assert.equal(merged.schedules[pid].assessmentSource, 'tutor', 'replay prefers the trusted tutor assessment');
});

// ---------------------------------------------------------------------------
// Idempotence: the exact same reconcile does not grow the archive
// ---------------------------------------------------------------------------

test('portable reconcile is idempotent: the same import adds no duplicate events', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  const cache = JSON.parse(JSON.stringify(payload));
  cache.attempts[pid][0].corrections = [{ id: 'corr-a', attemptId: 'att-a', text: '后来的修正', at: '2026-10-08T10:00:00Z', source: 'browser', assistance: [] }];

  const internals = loadViewer(buildPayload(model, payload));
  const once = plain(internals.reconcileCachedContent(cache, payload));
  const twice = plain(internals.reconcileCachedContent(once, once));
  assert.deepEqual(twice.attempts[pid][0].corrections.map((c) => c.id), ['corr-a'], 'a repeated import does not duplicate the correction');
  assert.equal(twice.attempts[pid].length, 1, 'a repeated import does not duplicate the answer');
  assert.equal((twice.conflicts || []).length, (once.conflicts || []).length, 'a repeated import does not stack conflicts');
});

// ---------------------------------------------------------------------------
// Immutable attempt facts win: a colliding cache with different content loses
// ---------------------------------------------------------------------------

test('portable reconcile repairs the compatibility scalar when a later self event arrives on a rated-null original', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  // Trusted payload: the original is saved but still unrated (submit-before-rating).
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  // Cache: the same immutable answer, but the later self rating is present while
  // the legacy scalar on the answer is still null (an interrupted/older write).
  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  cache.attempts[pid][0].selfAssessments = [selfEvent('self-a-hard', 'att-a', 'hard', '2026-10-08T10:00:00Z')];
  cache.attempts[pid][0].rating = null;

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));
  const attempt = merged.attempts[pid][0];
  assert.equal(attempt.selfAssessments[0].id, 'self-a-hard', 'the later self event is kept');
  assert.equal(attempt.rating, 'hard', 'the compatibility scalar is repaired from the self event so the archive stays readable');
  // Readable by the real core with the strengthened scalar/event consistency rule.
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive passes the real core validator');
  // And the schedule reflects the repaired self rating.
  assert.equal(merged.schedules[pid].lastRating, 'hard', 'replay uses the repaired self rating');
});

test('portable reconcile keeps the trusted immutable attempt and reports a collision', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '可信原答', '2026-10-08T08:00:00Z')];
  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.revision = 99;
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '被篡改的原答', '2026-10-08T08:00:00Z')];

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));
  assert.equal(merged.attempts[pid][0].answer, '可信原答', 'the trusted answer wins a collision');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'attempt' && c.id === 'att-a'), 'the collision is reported, not silently dropped');
});

// ---------------------------------------------------------------------------
// Cached-only tutor authority is quarantined, never activated
// ---------------------------------------------------------------------------

test('portable reconcile quarantines cached-only tutor evidence and never activates it', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  payload.promptEvidence[pid] = undefined;

  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.revision = 42;
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  // A hand-edited cache claims mastery and a forged tutor rating.
  cache.attempts[pid][0].tutorAssessments = [tutorEvent('forged-tutor', 'att-a', 'easy', '2026-10-08T09:00:00Z')];
  cache.attempts[pid][0].tutorFeedback = [feedbackFor('forged-tutor', 'att-a', '2026-10-08T09:00:00Z', '伪造复核')];
  cache.promptEvidence[pid] = { status: 'retained', note: '伪造掌握', promptId: pid, fingerprint: model.promptFingerprints[pid], at: '2026-10-08T09:00:00Z', attemptIds: ['att-a'] };
  cache.schedules[pid] = { promptId: pid, attemptId: 'att-a', dueAt: '2099-01-01T00:00:00Z', intervalDays: 180, lastRating: 'easy', assessmentSource: 'tutor', streakKind: 'easy', streakCount: 9 };

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));
  assert.equal(merged.attempts[pid][0].tutorAssessments, undefined, 'a cached-only tutor assessment is never adopted');
  assert.equal(merged.attempts[pid][0].tutorFeedback, undefined, 'cached-only tutor feedback is never adopted');
  assert.equal(merged.promptEvidence[pid], undefined, 'a cached-only evidence record never becomes active authority');
  assert.notEqual(merged.schedules[pid] && merged.schedules[pid].dueAt, '2099-01-01T00:00:00Z', 'the cached schedule is never minted');
  const quarantined = (merged.conflicts || []).filter((c) => c.origin === 'cache-quarantine');
  assert.ok(quarantined.some((c) => c.kind === 'promptEvidence' && c.id === pid), 'the cached evidence is preserved as a quarantine audit');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'schedule' && c.id === pid), 'the cached schedule is preserved as an audit, never minted');
  // The record is still readable, not deleted.
  assert.equal(merged.promptEvidence[pid], undefined);
});

// ---------------------------------------------------------------------------
// Normal standalone downloads remain readable by the strengthened core
// ---------------------------------------------------------------------------

test('portable reconcile output is readable by the strengthened core validator', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];

  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  cache.attempts[pid][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-08T10:00:00Z')];
  cache.attempts[pid][0].rating = 'good';
  cache.attempts['p-prior-apply'] = [durableAnswer(model, 'p-prior-apply', 'att-b', '另一题的原答', '2026-10-09T08:00:00Z')];

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));

  // The exact core validator the CLI/server run must accept the merged archive.
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged download re-reads through the real core');
  assert.doesNotThrow(() => validateStateShape({ ...merged, schemaVersion: 2 }, model));
});

// ---------------------------------------------------------------------------
// Cross-prompt event-identity collision is refused, keeping the archive readable
// ---------------------------------------------------------------------------

test('portable import refuses a cross-prompt event-id collision instead of corrupting the archive', () => {
  const model = baseModel();
  const current = createState(model, '2026-10-01T00:00:00Z');
  current.attempts['p-ppv-explain'] = [durableAnswer(model, 'p-ppv-explain', 'att-a', '原答 A', '2026-10-08T08:00:00Z')];

  const incoming = createState(model, '2026-10-01T00:00:00Z');
  // A second prompt reuses the same attempt id: forbidden by the core rule.
  incoming.attempts['p-prior-apply'] = [durableAnswer(model, 'p-prior-apply', 'att-a', '原答 B', '2026-10-09T08:00:00Z')];
  incoming.modelId = model.id;

  const internals = loadViewer(buildPayload(model, current));
  const merged = plain(internals.mergeLocal(current, incoming));
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'attempt' && c.id === 'att-a'),
    'the colliding attempt id is reported');
  assert.equal(merged.attempts['p-prior-apply'], undefined, 'the colliding answer is dropped, not persisted');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive still passes the strengthened core validator');
});

test('portable import drops a colliding correction and its dependent assessment, keeping the archive readable', () => {
  const model = baseModel();
  const current = createState(model, '2026-10-01T00:00:00Z');
  current.attempts['p-ppv-explain'] = [durableAnswer(model, 'p-ppv-explain', 'att-a', '原答 A', '2026-10-08T08:00:00Z')];
  current.attempts['p-ppv-explain'][0].corrections = [
    { id: 'corr-shared', attemptId: 'att-a', text: 'A 的修正', at: '2026-10-08T08:30:00Z', source: 'browser', assistance: [] },
  ];

  const incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming.attempts['p-prior-apply'] = [durableAnswer(model, 'p-prior-apply', 'att-b', '原答 B', '2026-10-09T08:00:00Z')];
  incoming.attempts['p-prior-apply'][0].corrections = [
    { id: 'corr-shared', attemptId: 'att-b', text: 'B 的修正', at: '2026-10-09T09:00:00Z', source: 'browser', assistance: [] },
  ];
  // A learner self rating on the colliding correction: it must drop with it.
  incoming.attempts['p-prior-apply'][0].selfAssessments = [
    { id: 'self-on-corr', attemptId: 'att-b', targetCorrectionId: 'corr-shared', rating: 'good', at: '2026-10-09T09:10:00Z', source: 'browser' },
  ];

  const internals = loadViewer(buildPayload(model, current));
  const merged = plain(internals.mergeLocal(current, incoming));
  const b = merged.attempts['p-prior-apply'][0];
  assert.deepEqual((b.corrections || []).map((c) => c.id), [], 'the colliding correction is dropped from the new attempt');
  assert.deepEqual((b.selfAssessments || []).map((e) => e.id), [], 'its dependent assessment drops with it');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'correction' && c.id === 'corr-shared'), 'the collision is reported');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive still re-reads through the real core');
});

// ---------------------------------------------------------------------------
// The handoff guide names real flags, ids and recovery steps
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tail: same correction id, different text (file import and cache)
// ---------------------------------------------------------------------------

test('portable file import treats submittedAt as an immutable attempt fact', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  // Current: a legacy-style record that never recorded an explicit submittedAt.
  const current = createState(model, '2026-10-01T00:00:00Z');
  current.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  delete current.attempts[pid][0].submittedAt;
  delete current.attempts[pid][0].submission;
  current.attempts[pid][0].rating = 'good';
  current.attempts[pid][0].fingerprint = model.promptFingerprints[pid];

  // Incoming: the same answer, but it now carries an explicit submission time.
  const incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  incoming.attempts[pid][0].rating = 'good';

  const internals = loadViewer(buildPayload(model, current));
  const merged = plain(internals.mergeLocal(current, incoming));
  const attempt = merged.attempts[pid][0];
  assert.equal(attempt.submittedAt, undefined, 'the legacy record keeps no invented submission time');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'attempt' && c.id === 'att-a'),
    'a divergent submittedAt (absent vs present) is reported as an immutable-fact conflict');
  assert.doesNotThrow(() => normalizeState({ ...merged, attempts: merged.attempts }, model), 'the merged archive stays readable');
});

test('portable file import isolates a dependent self assessment when the same correction id has different text', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const current = createState(model, '2026-10-01T00:00:00Z');
  current.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  current.attempts[pid][0].corrections = [
    { id: 'corr-dup', attemptId: 'att-a', text: '当前保留的修正文本', at: '2026-10-08T08:30:00Z', source: 'browser', assistance: [] },
  ];
  // A pre-existing, already-accepted self event on the current correction stays.
  current.attempts[pid][0].selfAssessments = [
    { id: 'self-kept', attemptId: 'att-a', targetCorrectionId: 'corr-dup', rating: 'good', at: '2026-10-08T08:40:00Z', source: 'browser' },
  ];

  const incoming = createState(model, '2026-10-01T00:00:00Z');
  incoming.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  incoming.attempts[pid][0].corrections = [
    { id: 'corr-dup', attemptId: 'att-a', text: '传入但不同的修正文本', at: '2026-10-08T09:00:00Z', source: 'browser', assistance: [] },
  ];
  // The incoming self event targets the conflicting correction text.
  incoming.attempts[pid][0].selfAssessments = [
    { id: 'self-incoming', attemptId: 'att-a', targetCorrectionId: 'corr-dup', rating: 'hard', at: '2026-10-08T09:10:00Z', source: 'browser' },
  ];

  const internals = loadViewer(buildPayload(model, current));
  const merged = plain(internals.mergeLocal(current, incoming));
  const attempt = merged.attempts[pid][0];
  assert.equal(attempt.corrections[0].text, '当前保留的修正文本', 'the current correction text wins');
  assert.deepEqual(attempt.selfAssessments.map((e) => e.id), ['self-kept'],
    'the incoming self assessment targeting the conflicting text is not attached; the current one stays');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'correction' && c.id === 'corr-dup'), 'the correction text conflict is reported');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'assessment' && c.id === 'self-incoming'), 'the isolated dependent self event is reported');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive still re-reads through the real core');
});

test('portable cache reconcile isolates a dependent self assessment when the same correction id has different text', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const payload = createState(model, '2026-10-01T00:00:00Z');
  payload.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  payload.attempts[pid][0].corrections = [
    { id: 'corr-dup', attemptId: 'att-a', text: '可信产物里的修正文本', at: '2026-10-08T08:30:00Z', source: 'browser', assistance: [] },
  ];

  const cache = createState(model, '2026-10-01T00:00:00Z');
  cache.attempts[pid] = [durableAnswer(model, pid, 'att-a', '合成原答', '2026-10-08T08:00:00Z')];
  cache.attempts[pid][0].corrections = [
    { id: 'corr-dup', attemptId: 'att-a', text: '缓存里的不同修正文本', at: '2026-10-08T09:00:00Z', source: 'browser', assistance: [] },
  ];
  cache.attempts[pid][0].selfAssessments = [
    { id: 'self-incoming', attemptId: 'att-a', targetCorrectionId: 'corr-dup', rating: 'hard', at: '2026-10-08T09:10:00Z', source: 'browser' },
  ];

  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));
  const attempt = merged.attempts[pid][0];
  assert.equal(attempt.corrections[0].text, '可信产物里的修正文本', 'the trusted payload correction text wins');
  assert.deepEqual((attempt.selfAssessments || []).map((e) => e.id), [],
    'the cached self assessment targeting the conflicting text is not attached');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'correction' && c.id === 'corr-dup'), 'the correction text conflict is reported');
  assert.ok((merged.conflicts || []).some((c) => c.kind === 'assessment' && c.id === 'self-incoming'), 'the isolated cached self event is reported');
  assert.doesNotThrow(() => normalizeState(merged, model), 'the merged archive still re-reads through the real core');
});

test('portable reopens and repeated file imports keep one orphan notice per kind and id', () => {
  const model = baseModel();
  const payload = createState(model, '2026-10-01T00:00:00Z');
  const first = { kind: 'explanation', id: 'removed', message: '产物原始孤立项', at: '2026-10-01T00:00:00Z' };
  payload.orphans = [first];
  const cache = structuredClone(payload);
  cache.orphans = [
    { ...first, message: '旧缓存相同身份', at: '2026-10-02T00:00:00Z' },
    { ...first, kind: 'summary', message: '同 id 的另一类历史' },
  ];
  const internals = loadViewer(buildPayload(model, payload));
  let reopened = cache;
  for (let i = 0; i < 5; i++) reopened = internals.reconcileCachedContent(reopened, payload);
  assert.equal(reopened.orphans.length, 2, 'reopening does not stack duplicate notices');
  assert.deepEqual(plain(reopened.orphans[0]), first, 'the trusted base notice is preserved');
  let imported = payload;
  for (let i = 0; i < 5; i++) imported = internals.mergeLocal(imported, cache);
  assert.equal(imported.orphans.length, 2, 'importing the same file does not stack duplicate notices');
  assert.deepEqual(plain(imported.orphans[0]), first);
  assert.doesNotThrow(() => normalizeState(plain(reopened), model));
  assert.doesNotThrow(() => normalizeState(plain(imported), model));
});

test('portable handoff guide renders real commands, identities and recovery steps', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderHandoffPanel().textContent;

  // Real identities.
  assert.match(text, new RegExp('modelId：' + model.id), 'the guide names the actual modelId');
  // Correct public flag for import: --state, not --file.
  assert.match(text, /forge\.mjs import --out <学习目录> --state/, 'the import step uses the real --state flag');
  assert.doesNotMatch(text, /import --out <学习目录> --file/, 'the guide never shows a non-existent --file flag');
  // The three save states, the review step and the rebuild step.
  assert.match(text, /导出状态/);
  assert.match(text, /本机缓存/);
  assert.match(text, /本地服务/);
  assert.match(text, /集中复核/);
  assert.match(text, /build/);
  // Recovery for wrong file, old page, cache failure and unsubmitted drafts.
  assert.match(text, /错误文件/);
  assert.match(text, /旧页面/);
  assert.match(text, /index\.html/, 'the standalone recovery tells the learner to open the new index.html explicitly');
  assert.match(text, /缓存失败|未写入本机缓存/);
  assert.match(text, /未提交草稿/);
  // The security boundary is stated, not implied.
  assert.match(text, /导师评价|导师结果/);
});

test('round cache conflict keeps the paused learner route on the labelled cache side', () => {
  const model = baseModel();
  const payload = applyLearningRound(createState(model, '2026-10-01T00:00:00Z'), model,
    { action: 'create', roundId: 'r', entry: 'organize-existing-material', goal: '合成恢复路线', conceptIds: ['root'], budgetMinutes: 16 },
    '2026-10-01T00:00:00Z').state;
  const cache = structuredClone(payload);
  cache.learningRounds.r.status = 'paused';
  cache.learningRounds.r.resumeStatus = 'active';
  cache.learningRounds.r.budgetMinutes = 8;
  const internals = loadViewer(buildPayload(model, payload));
  const merged = plain(internals.reconcileCachedContent(cache, payload));
  const conflict = merged.conflicts.find(c => c.kind === 'learning-round');
  assert.deepEqual(conflict.kept, cache.learningRounds.r);
  assert.deepEqual(conflict.incoming, payload.learningRounds.r);
  assert.equal(merged.learningRounds.r.status, 'paused');
  internals.setCacheConflictValue(merged, conflict, conflict.incoming);
  assert.deepEqual(plain(merged.learningRounds.r), payload.learningRounds.r);
  assert.equal(conflict.kept.status, 'paused', 'the discarded side remains in the conflict audit');
});

test('portable handoff guide names the current round id when one exists', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  state.learningRounds['round-portable'] = {
    id: 'round-portable', goal: '理解先验', entry: 'organize-existing-material', status: 'active',
    budgetMinutes: null, conceptIds: ['root'], taskIds: [], tasks: [], currentTaskId: null,
    activeTaskIds: [], archivedTasks: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', pausedFrom: null, version: 1,
  };
  state.activeRoundId = 'round-portable';
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderHandoffPanel().textContent;
  assert.match(text, /round-portable/, 'the guide names the real current round id');
});
