// Standalone-viewer regressions. These load the real script from
// assets/viewer.html in a minimal DOM shim with the test hook, then compare its
// standalone helpers against the authoritative core state helpers. They do not
// exercise a real browser or the HTTP server.
//
// Run: node --test tests/viewer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  createState,
  applyAttempt,
  applyLearningRound,
  applyOwnQuestion,
  applyTutorEvidence,
  stateView,
  promptFingerprint,
  syncModel,
  normalizeState,
} from '../skill/forge/scripts/lib/state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerPath = path.join(here, '..', 'skill', 'forge', 'assets', 'viewer.html');
// The standalone page inlines two portable libraries. The shim injects both so
// the page runs the exact same schedule/assessment algorithm as the backend.
const stripExports = (source) => source.replace(/^export /gm, '');
const viewerHtml = fs.readFileSync(viewerPath, 'utf8')
  .replace('/*__EMBER_ROUND_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'round.mjs'), 'utf8')))
  .replace('/*__EMBER_SCHEDULE_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'schedule.mjs'), 'utf8')))
  .replace('/*__EMBER_TUTOR_REVIEW_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'tutor-review.mjs'), 'utf8')))
  .replace('/*__EMBER_INTERACTIONS_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'interactions.mjs'), 'utf8')))
  .replace('/*__EMBER_INSIGHTS_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'insights.mjs'), 'utf8')))
  .replace('/*__EMBER_CORRECTIONS_LIBRARY__*/', () =>
    stripExports(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'scripts', 'lib', 'corrections.mjs'), 'utf8')));
const scriptBody = (() => {
  const start = viewerHtml.lastIndexOf('<script>');
  assert.ok(start !== -1, 'viewer must contain a script block');
  const end = viewerHtml.indexOf('</script>', start);
  assert.ok(end !== -1, 'viewer script must be closed');
  return viewerHtml.slice(viewerHtml.indexOf('>', start) + 1, end);
})();

function baseModel(extra = {}) {
  return normalizeModel({
    schemaVersion: 1,
    id: 'probability-viewer-test',
    title: '条件概率',
    goal: '理解先验与 PPV',
    activity: 'bayes-frequency',
    concepts: [
      { id: 'root', title: '条件概率', parentId: null, difficulty: 1, explanation: '基础定义' },
      { id: 'prior', title: '先验概率', parentId: 'root', difficulty: 1, explanation: '证据前的信念' },
      { id: 'ppv', title: '阳性预测值', parentId: 'root', difficulty: 3, explanation: '阳性中真患病比例' },
    ],
    prompts: [
      { id: 'p-prior-apply', conceptId: 'prior', kind: 'apply', question: '患病率 2% 时 PPV?', answer: '约 27%', criteria: ['先算真阳性'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
    relations: [{ id: 'rel-prior-to-ppv', from: 'prior', to: 'ppv', type: 'cause', label: '先验改变 PPV' }],
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

// Values created inside the vm sandbox have the sandbox realm's prototypes, so
// normalize them to plain host objects before strict comparison.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext() {
      return {
        font: '',
        fillStyle: '',
        setTransform() {},
        clearRect() {},
        fillRect() {},
        measureText() { return { width: 0 }; },
      };
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
    if (child.tagName === '#FRAGMENT') {
      for (const item of [...child.children]) this.appendChild(item);
      child.children = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    event.preventDefault ||= () => {};
    event.stopPropagation ||= () => {};
    for (const fn of this.listeners.get(event.type) || []) fn.call(this, event);
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() {}
  setSelectionRange() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : (this.parentNode ? this.parentNode.closest(selector) : null); }
}
function makeElement(tag) { return new ShimNode(tag); }

// Load the real viewer script under a tiny DOM shim. __EMBER_TEST__ makes the
// IIFE expose its standalone helpers instead of booting the UI.
function loadViewer(payload, options = {}) {
  const dataEl = { textContent: JSON.stringify(payload) };
  const documentShim = {
    createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeElement(); },
    createElementNS() { return makeElement(); },
    createDocumentFragment() { return makeElement(); },
    createTextNode(text) { return Object.assign(new ShimNode(), { textContent: text }); },
    querySelector(sel) { return sel === '#ember-data' ? dataEl : options.elements?.[sel] || null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    activeElement: null,
    body: makeElement(),
  };
  const sandbox = {
    console,
    document: documentShim,
    location: { protocol: 'file:' },
    localStorage: options.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false }),
    requestAnimationFrame(cb) { return cb(); },
    setTimeout,
    clearTimeout,
    TextEncoder,
    crypto: globalThis.crypto,
    URL: { createObjectURL(blob) { options.exports?.push(blob); return 'blob:viewer-test'; }, revokeObjectURL() {} },
    Node: ShimNode,
    Blob,
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

// ---------------------------------------------------------------------------
// Syntax / load
// ---------------------------------------------------------------------------

test('viewer script parses and exposes standalone helpers', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')));
  for (const name of ['localAction', 'mergeLocal', 'computeView', 'computeActivityResults', 'listDueLocal']) {
    assert.equal(typeof internals[name], 'function', `${name} should be exposed`);
  }
  // Parsing the same source as a standalone script must not throw.
  assert.doesNotThrow(() => new vm.Script(scriptBody, { filename: 'viewer-script.js' }));
});

// ---------------------------------------------------------------------------
// Own-question fingerprint (includes concept context, like the core helper)
// ---------------------------------------------------------------------------

test('viewer own-question fingerprint matches core and tracks concept content', async () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  const withQ = applyOwnQuestion(state, model, { conceptId: 'ppv', text: '为什么分母是阳性者？', id: 'q-mine' }, '2026-01-01T00:00:00Z').state;

  const internals = loadViewer(buildPayload(model, withQ));
  await internals.refreshOwnFingerprints();
  const viewerFp = internals.currentPromptFingerprint('q-mine');
  assert.equal(viewerFp, promptFingerprint(model, withQ, 'q-mine'));

  const updated = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.map((c) => (c.id === 'ppv' ? { ...c, explanation: '改过的解释' } : c)),
  });
  internals.App.conceptFingerprints = Object.assign({}, updated.conceptFingerprints);
  await internals.refreshOwnFingerprints();
  const viewerFp2 = internals.currentPromptFingerprint('q-mine');
  assert.equal(viewerFp2, promptFingerprint(updated, withQ, 'q-mine'));
  assert.notEqual(viewerFp2, viewerFp, 'rebuilt concept must change the own-question fingerprint');
});

// ---------------------------------------------------------------------------
// View: active vs stale proof, orphaned own questions
// ---------------------------------------------------------------------------

function stateWithConceptsAndEvidence(model) {
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-ppv-explain', answer: '因为分母变大', rating: 'good', attemptId: 'att-ppv' }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { promptId: 'p-ppv-explain', status: 'explained', note: '能解释' }, '2026-01-01T02:00:00Z').state;
  state = applyAttempt(state, model, { promptId: 'p-prior-apply', answer: '约 27%', rating: 'good', attemptId: 'att-prior' }, '2026-01-01T03:00:00Z').state;
  state = applyTutorEvidence(state, model, { conceptId: 'prior', status: 'applied', note: '会算新情境' }, '2026-01-01T04:00:00Z').state;
  state = applyAttempt(state, model, { promptId: 'p-ppv-explain', answer: '再来一次', rating: 'good', attemptId: 'att-ppv2' }, '2026-01-01T05:00:00Z').state;
  state = applyOwnQuestion(state, model, { conceptId: 'root', text: '条件概率是什么？', id: 'q-live' }, '2026-01-01T06:00:00Z').state;
  state.ownQuestions['q-orphan'] = {
    id: 'q-orphan', conceptId: 'missing', text: '孤立问题', author: 'learner',
    createdAt: '2026-01-01T06:00:00Z', updatedAt: '2026-01-01T06:00:00Z',
  };
  state.attempts['q-live'] = [{
    id: 'att-live', promptId: 'q-live', at: '2026-01-01T07:00:00Z', answer: '缩小样本空间',
    rating: 'good', assisted: false, fingerprint: promptFingerprint(model, state, 'q-live'), corrections: [],
  }];
  return state;
}

test('viewer computeView mirrors core stateView (active proof, pending, orphan question)', async () => {
  const model = baseModel();
  const state = stateWithConceptsAndEvidence(model);

  const internals = loadViewer(buildPayload(model, state));
  await internals.refreshOwnFingerprints();
  const view = plain(internals.computeView());
  assert.deepEqual(view, stateView(state, model));
  assert.equal(internals.resolvePrompt('q-orphan'), null, 'removed-concept own question is not playable');
  assert.equal(view.conceptStatus.root.status, 'pending-review');
  assert.equal(view.conceptStatus.prior.status, 'applied');
  assert.equal(view.prompts['p-ppv-explain'].evidence.status, 'explained');
});

test('viewer computeView mirrors core stateView for stale proof and fresh fingerprints', async () => {
  const model = baseModel();
  const state = stateWithConceptsAndEvidence(model);
  const updated = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.map((c) => (c.id === 'ppv' || c.id === 'prior' ? { ...c, explanation: '改过的解释 ' + c.id } : c)),
  });
  const synced = syncModel(state, updated, '2026-01-02T00:00:00Z').state;

  const internals = loadViewer(buildPayload(updated, synced));
  await internals.refreshOwnFingerprints();
  const view = plain(internals.computeView());
  assert.deepEqual(view, stateView(synced, updated));
  assert.equal(view.conceptStatus.prior.status, 'unknown', 'stale concept proof must not stay active');
  assert.equal(view.conceptStatus.prior.staleEvidence.status, 'applied');
  assert.equal(view.prompts['p-ppv-explain'].evidence, null);
  assert.ok(view.prompts['p-ppv-explain'].staleEvidence);
});

// ---------------------------------------------------------------------------
// Content-change streak reset
// ---------------------------------------------------------------------------

test('viewer standalone attempt resets the spacing streak after content change', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')));
  const fp = model.promptFingerprints['p-ppv-explain'];
  internals.localAction({ type: 'attempt', promptId: 'p-ppv-explain', attemptId: 'a1', answer: 'a', rating: 'good', assisted: false, fingerprint: fp });
  internals.localAction({ type: 'attempt', promptId: 'p-ppv-explain', attemptId: 'a2', answer: 'b', rating: 'good', assisted: false, fingerprint: fp });
  assert.equal(internals.App.state.schedules['p-ppv-explain'].streakCount, 2);

  // Simulate a rebuilt question: the current fingerprint now differs.
  internals.App.promptFingerprints['p-ppv-explain'] = 'changed-fingerprint';
  internals.localAction({ type: 'attempt', promptId: 'p-ppv-explain', attemptId: 'a3', answer: 'c', rating: 'good', assisted: false, fingerprint: 'changed-fingerprint' });
  const schedule = internals.App.state.schedules['p-ppv-explain'];
  assert.equal(schedule.streakCount, 1, 'streak restarts at 1 for new content');
  assert.equal(schedule.intervalDays, 4);
  assert.equal(internals.App.state.attempts['p-ppv-explain'].length, 3, 'history is preserved');
});

// ---------------------------------------------------------------------------
// Offline import
// ---------------------------------------------------------------------------

test('offline import merges an older archive immutably and never adopts imported mastery', () => {
  const model = baseModel();
  let current = createState(model, '2026-01-01T00:00:00Z');
  current = applyAttempt(current, model, { promptId: 'p-ppv-explain', answer: 'keep me', rating: 'good', attemptId: 'att-keep' }, '2026-01-01T01:00:00Z').state;
  current.revision = 10;
  current.explanations.root = { text: '我的解释', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  current.conceptEvidence.ppv = {
    status: 'applied', note: '现有复核', conceptFingerprint: model.conceptFingerprints.ppv, at: '2026-01-01T01:00:00Z',
  };

  const incoming = JSON.parse(JSON.stringify(createState(model, '2026-01-01T00:00:00Z')));
  incoming.revision = 1; // useful but older: must not be rejected by revision
  incoming.explanations.root = { text: '别人的解释', updatedAt: '2026-01-02T00:00:00Z', author: 'learner' };
  incoming.conceptEvidence.ppv = {
    status: 'retained', note: '导入声称', conceptFingerprint: model.conceptFingerprints.ppv, at: '2026-01-02T00:00:00Z',
  };
  incoming.conceptEvidence.root = {
    status: 'applied', note: '导入的新概念证据', conceptFingerprint: model.conceptFingerprints.root, at: '2026-01-02T00:00:00Z',
  };

  const internals = loadViewer(buildPayload(model, current));
  const merged = internals.mergeLocal(current, incoming);
  assert.deepEqual(plain(merged.attempts['p-ppv-explain']).map((a) => a.id), ['att-keep'], 'existing attempts stay immutable');
  assert.equal(merged.explanations.root.text, '我的解释', 'current overlay wins with a report');
  assert.equal(merged.conceptEvidence.ppv.status, 'applied', 'current tutor evidence is preserved');
  assert.equal(merged.conceptEvidence.root, undefined, 'imported tutor claim must not grant mastery');
  assert.ok(merged.conflicts.some((c) => c.kind === 'conceptEvidence' && c.id === 'ppv'));
  assert.ok(merged.conflicts.some((c) => c.kind === 'conceptEvidence' && c.id === 'root'));
  assert.ok(merged.conflicts.some((c) => c.kind === 'explanations'));
  assert.ok(merged.revision > 10);
});

test('offline import rejects malformed archives and dangerous keys', () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, current));
  const base = { schemaVersion: 1, modelId: model.id, attempts: {} };

  assert.throws(() => internals.mergeLocal(current, { ...base, attempts: [] }), /attempts 对象/);
  assert.throws(() => internals.mergeLocal(current, { ...base, attempts: { p1: {} } }), /必须是数组/);
  assert.throws(() => internals.mergeLocal(current, { ...base, conceptEvidence: { root: { status: 'mastered' } } }), /status 不合法/);
  assert.throws(() => internals.mergeLocal(current, { ...base, schedules: { p1: { dueAt: '2026-01-02T00:00:00Z' } } }), /dueAt\/intervalDays/);
  assert.throws(() => internals.mergeLocal(current, { ...base, ownQuestions: { q1: { id: 'q1' } } }), /id\/conceptId\/text/);
  assert.throws(() => internals.mergeLocal(current, { ...base, modelId: 'other-model' }), /不一致/);

  const dangerous = JSON.parse(`{"schemaVersion":1,"modelId":"${model.id}","attempts":{},"__proto__":{}}`);
  assert.throws(() => internals.mergeLocal(current, dangerous), /原型污染/);
});

function cacheStorage(key, text) {
  const entries = new Map([[key, text]]);
  return {
    getItem(name) { return entries.get(name) ?? null; },
    setItem(name, value) { entries.set(name, value); },
    removeItem(name) { entries.delete(name); },
  };
}

function makeCanvasElement() {
  return Object.assign(makeElement('canvas'), makeCanvas());
}

// Run the unmodified production startup. No __EMBER_TEST__ flag and no private
// helpers: assertions go through the rendered DOM, localStorage and blobs.
async function openPage(payload, options = {}) {
  const body = makeElement('body');
  const dataEl = makeElement('script');
  dataEl.setAttribute('id', 'ember-data');
  dataEl.textContent = JSON.stringify(payload);
  body.appendChild(dataEl);
  const app = makeElement('div');
  app.setAttribute('id', 'app');
  app.hidden = true;
  body.appendChild(app);
  const childIds = ['bootError', 'docTitle', 'docGoal', 'modeBadge', 'saveStatus', 'reloadBanner',
    'storageBanner', 'conflictBanner', 'importBanner', 'legend', 'tabs', 'panel', 'graph', 'graphStage',
    'graphCanvas', 'edgeSvg', 'nodeLayer', 'relLabelLayer', 'graphEmpty', 'footerNote', 'exportBtn',
    'importBtn', 'importFile', 'relLabels'];
  for (const id of childIds) {
    const tag = id === 'edgeSvg' ? 'svg' : (id === 'importFile' || id === 'relLabels' ? 'input' : 'div');
    const element = makeElement(tag);
    element.setAttribute('id', id);
    if (['bootError', 'reloadBanner', 'storageBanner', 'conflictBanner', 'importBanner', 'graphEmpty'].includes(id)) element.hidden = true;
    app.appendChild(element);
  }
  const exports = [];
  const documentShim = {
    body, activeElement: null,
    createElement(tag) { return tag === 'canvas' ? makeCanvasElement() : makeElement(tag); },
    createElementNS(namespace, tag) { return makeElement(tag); },
    createDocumentFragment() { return makeElement('#fragment'); },
    createTextNode(text) { const node = makeElement('#text'); node.textContent = text; return node; },
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    getElementById: (id) => body.querySelector('#' + id),
  };
  const storage = options.localStorage || cacheStorage('', '');
  const sandbox = {
    console, document: documentShim, localStorage: storage, location: { protocol: options.protocol || 'file:' },
    Date: options.now ? class extends Date {
      constructor(...args) { super(...(args.length ? args : [options.now])); }
      static now() { return new Date(options.now).getTime(); }
    } : Date,
    fetch: options.fetch || (async () => ({ ok: false })), Node: ShimNode, TextEncoder, crypto: globalThis.crypto, Blob,
    URL: { createObjectURL(blob) { exports.push(blob); return 'blob:normal-boot'; }, revokeObjectURL() {} },
    FileReader: class {
      readAsText(file) { file.text().then((text) => { this.result = text; this.onload(); }); }
    },
    setTimeout, clearTimeout, requestAnimationFrame(fn) { fn(); }, addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptBody, sandbox, { filename: 'viewer-boot.js' });
  await until(() => !documentShim.querySelector('#bootError').hidden || !documentShim.querySelector('#app').hidden);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentShim.querySelector('#bootError').hidden, true, documentShim.querySelector('#bootError').textContent);
  assert.equal(sandbox.__emberInternals, undefined, 'normal boot must not expose private test hooks');
  return { document: documentShim, exports, storage };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for an observable page result');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function buttonByText(page, text) {
  const found = page.document.querySelectorAll('button').find((node) => node.textContent === text);
  assert.ok(found, `rendered button ${text}`);
  return found;
}
async function saveNote(page, kind, text) {
  const area = page.document.querySelector('#note-root-' + kind);
  assert.ok(area, `note editor for ${kind}`);
  area.value = text;
  area.dispatchEvent({ type: 'input' });
  buttonByText(page, kind === 'summary' ? '保存总结' : '保存自己的解释').click();
  await until(() => page.document.querySelector('#saveStatus').textContent !== '笔记排队保存…');
  await new Promise((resolve) => setImmediate(resolve));
}
async function rateThroughUi(page, promptId, question, answer, ratingLabel, storage, key, expectedAttempts) {
  buttonByText(page, '练习').click();
  const open = page.document.querySelectorAll('button').find((node) => node.textContent.includes(question));
  assert.ok(open, 'practice picker offers the prompt');
  open.click();
  const area = page.document.querySelector('#answer-' + promptId);
  assert.ok(area, 'practice answer box');
  area.value = answer;
  area.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelectorAll('button').some((node) => node.textContent === ratingLabel));
  const rating = page.document.querySelectorAll('button').find((node) => node.textContent === ratingLabel);
  assert.ok(rating, `rating button ${ratingLabel}`);
  rating.click();
  await until(() => {
    const state = JSON.parse(storage.getItem(key));
    return (state.attempts[promptId] || []).length === expectedAttempts;
  });
  await until(() => JSON.parse(storage.getItem(key)).attempts[promptId].slice(-1)[0].rating !== null);
  await new Promise((resolve) => setImmediate(resolve));
}

test('viewer boots from a v1 cache, saves via the real UI, exports and reopens', async () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const original = applyAttempt(current, model, {
    promptId: 'p-ppv-explain', attemptId: 'old-attempt', answer: '原作答', rating: 'good', assisted: true,
  }, '2026-01-01T01:00:00Z').state;
  original.schemaVersion = 1;
  original.revision = 3;
  original.explanations.root = { text: '旧缓存笔记', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  original.migrations = [{ from: 0, to: 1, at: '2025-01-01T00:00:00Z', tool: 'legacy', warnings: [] }];
  original.attempts['p-prior-apply'] = [{ id: 'incomplete', rating: 'hard', at: '2026-01-01T02:00:00Z', answer: '缺少旧信息' }];
  original.promptEvidence['p-prior-apply'] = { status: 'applied', note: '旧复核' };
  const key = 'ember:v1:state:' + model.id;
  const storage = cacheStorage(key, JSON.stringify(original));

  const page = await openPage(buildPayload(model, current), { localStorage: storage });
  assert.equal(page.document.querySelector('#note-root-explanation').value, '旧缓存笔记', 'boot adopts the cache through the real startup path');
  assert.equal(page.document.querySelector('#reloadBanner').hidden, true);
  await saveNote(page, 'summary', '升级后的笔记');

  const persisted = JSON.parse(storage.getItem(key));
  assert.equal(persisted.schemaVersion, 2, 'the registered save button persists the upgraded cache');
  assert.deepEqual(persisted.attempts, original.attempts, 'original answer/time/assistance/fingerprint survive');
  assert.equal(persisted.migrations.length, 2, 'legacy history plus exactly one upgrade entry');
  assert.deepEqual(persisted.migrations[1].warnings, normalizeState(original, model).migrations[1].warnings);
  assert.equal(persisted.migrations[1].warnings.length, 2, 'missing information is explicit');

  page.document.querySelector('#exportBtn').click();
  assert.equal(page.exports.length, 1, 'the registered export button emits a downloadable blob');
  const exported = JSON.parse(await page.exports[0].text());
  assert.equal(exported.summaries.root.text, '升级后的笔记');

  const reopened = await openPage(buildPayload(model, current), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#note-root-summary').value, '升级后的笔记', 'reopen keeps the saved work');
  reopened.document.querySelector('#exportBtn').click();
  assert.deepEqual(JSON.parse(await reopened.exports[0].text()).migrations, exported.migrations, 'normal reopen adds no migration entry');
});

test('rebuilt standalone page reconciles an old-content cache and keeps saving without a false reload', async () => {
  const model = baseModel();
  const oldModel = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.map((c) => (c.id === 'root' ? { ...c, explanation: '旧内容' } : c)),
  });
  const cached = createState(oldModel, '2026-01-01T00:00:00Z');
  cached.revision = 5;
  cached.summaries.root = { text: '缓存里的旧笔记', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  cached.attempts['p-removed'] = [{
    id: 'att-old', promptId: 'p-removed', at: '2026-01-01T02:00:00Z', answer: '对已移除问题的作答',
    rating: 'good', assisted: false, source: 'browser', fingerprint: 'old-fp', corrections: [],
  }];
  cached.promptEvidence['p-ppv-explain'] = {
    status: 'explained', note: '缓存里的旧复核', fingerprint: 'old-fp',
    at: '2026-01-01T03:00:00Z', attemptIds: ['att-old'],
  };
  const key = 'ember:v1:state:' + model.id;
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')), { localStorage: storage });
  assert.equal(page.document.querySelector('#reloadBanner').hidden, true, 'no false standalone reload banner');
  assert.equal(page.document.querySelector('#note-root-summary').value, '缓存里的旧笔记', 'cache work is adopted');
  await saveNote(page, 'summary', '重建后的第一条');
  assert.equal(page.document.querySelector('#reloadBanner').hidden, true, 'a standalone save is not a server content change');
  assert.equal(page.document.querySelector('#saveStatus').textContent, '已缓存到本机');
  await saveNote(page, 'explanation', '重建后的第二条');
  assert.equal(page.document.querySelector('#reloadBanner').hidden, true);
  assert.equal(page.document.querySelector('#saveStatus').textContent, '已缓存到本机');

  const persisted = JSON.parse(storage.getItem(key));
  assert.equal(persisted.modelFingerprint, model.modelFingerprint, 'cache adopts the current content identity');
  assert.equal(persisted.summaries.root.text, '重建后的第一条');
  assert.equal(persisted.explanations.root.text, '重建后的第二条');
  assert.equal(persisted.attempts['p-removed'][0].fingerprint, 'old-fp', 'immutable attempt fingerprint is preserved');
  // The cache can never mint tutor authority: a cached-only evidence record is
  // not adopted into active state.
  assert.equal(persisted.promptEvidence['p-ppv-explain'], undefined,
    'a cached-only tutor evidence record is never adopted as active authority');
  // It is not silently dropped either: the untrusted version is retained as a
  // readable, already-resolved quarantine audit, distinct from an active record.
  const quarantine = (persisted.conflicts || []).filter((c) => c.origin === 'cache-quarantine' && c.id === 'p-ppv-explain');
  assert.equal(quarantine.length, 1, 'the untrusted tutor evidence is preserved as a quarantine audit');
  assert.equal(quarantine[0].kept, null, 'the quarantine keeps no active authority');
  assert.equal(quarantine[0].incoming.note, '缓存里的旧复核', 'the historical cached record is kept readable');
  assert.ok(persisted.orphans.some((o) => o.kind === 'attempt' && o.id === 'p-removed'), 'removed prompt stays orphaned');

  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports[0].text());
  assert.equal(exported.summaries.root.text, '重建后的第一条');
  assert.equal(exported.explanations.root.text, '重建后的第二条');

  const reopened = await openPage(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#note-root-summary').value, '重建后的第一条');
  assert.equal(reopened.document.querySelector('#note-root-explanation').value, '重建后的第二条');
});

test('viewer shows both versions of a rebuilt-vs-cached edit and adopts the chosen one through the UI', async () => {
  const model = baseModel();
  const key = 'ember:v1:state:' + model.id;
  const cached = createState(model, '2026-01-01T00:00:00Z');
  cached.revision = 7;
  cached.summaries.root = { text: '本机的总结', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  cached.explanations.prior = { text: '不相关的解释', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  cached.attempts['p-ppv-explain'] = [{
    id: 'att-keep', promptId: 'p-ppv-explain', at: '2026-01-01T02:00:00Z', answer: '保留的作答',
    rating: 'good', assisted: false, source: 'browser', fingerprint: model.promptFingerprints['p-ppv-explain'], corrections: [],
  }];
  const payloadState = createState(model, '2026-01-01T00:00:00Z');
  payloadState.summaries.root = { text: '重建档案的总结', updatedAt: '2026-02-01T00:00:00Z', author: 'learner' };
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  const bannerText = page.document.querySelector('#conflictBanner').textContent;
  assert.equal(page.document.querySelector('#conflictBanner').hidden, false, 'a divergent same-id edit is shown, not silently decided');
  assert.match(bannerText, /本机缓存版本：本机的总结/);
  assert.match(bannerText, /重建页面版本：重建档案的总结/);
  assert.equal(page.document.querySelector('#note-root-summary').value, '本机的总结', 'cached value stays until the learner chooses');

  buttonByText(page, '采用重建版本').click();
  assert.equal(page.document.querySelector('#conflictBanner').hidden, true, 'the resolved conflict is no longer shown');
  const persisted = JSON.parse(storage.getItem(key));
  assert.equal(persisted.summaries.root.text, '重建档案的总结', 'the chosen version persists');
  assert.equal(persisted.explanations.prior.text, '不相关的解释', 'unrelated learner edits survive the choice');
  assert.equal(persisted.attempts['p-ppv-explain'][0].id, 'att-keep', 'immutable attempt history survives the choice');
  assert.equal(persisted.conflicts.length, 1);
  assert.equal(persisted.conflicts[0].resolved, true);
  assert.equal(persisted.conflicts[0].kept.text, '本机的总结', 'the discarded side is preserved durably');
  assert.equal(persisted.conflicts[0].incoming.text, '重建档案的总结');

  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports[0].text());
  assert.equal(exported.conflicts.length, 1);
  assert.equal(exported.conflicts[0].kept.text, '本机的总结');
  assert.equal(exported.conflicts[0].incoming.text, '重建档案的总结');

  const reopened = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#conflictBanner').hidden, true, 'reopen does not recreate a resolved conflict');
  assert.equal(reopened.document.querySelector('#note-root-summary').value, '重建档案的总结');
  assert.equal(JSON.parse(storage.getItem(key)).conflicts.length, 1, 'reopen does not grow the conflict history');
});

test('viewer keeps the local version on learner choice without regrowing the resolved conflict', async () => {
  const model = baseModel();
  const key = 'ember:v1:state:' + model.id;
  const cached = createState(model, '2026-01-01T00:00:00Z');
  cached.revision = 7;
  cached.explanations.root = { text: '本机解释', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  const payloadState = createState(model, '2026-01-01T00:00:00Z');
  payloadState.explanations.root = { text: '重建档案解释', updatedAt: '2026-02-01T00:00:00Z', author: 'learner' };
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(page.document.querySelector('#conflictBanner').hidden, false);
  buttonByText(page, '保留缓存版本').click();
  const persisted = JSON.parse(storage.getItem(key));
  assert.equal(persisted.explanations.root.text, '本机解释', 'the local version is kept');
  assert.equal(persisted.conflicts.filter((c) => c.resolved).length, 1);
  assert.equal(persisted.conflicts.find((c) => c.resolved).resolvedChoice, 'kept', 'the learner choice is recorded durably');

  // A rebuild that only changes the record timestamp must not reopen a
  // resolved conflict: the identity is the learner-visible value pair.
  const rebuilt = createState(model, '2026-01-01T00:00:00Z');
  rebuilt.explanations.root = { text: '重建档案解释', updatedAt: '2026-03-01T00:00:00Z', author: 'learner' };
  const reopened = await openPage(buildPayload(model, rebuilt), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#conflictBanner').hidden, true, 'a timestamp-only rebuild does not reopen the resolved conflict');
  assert.equal(reopened.document.querySelector('#note-root-explanation').value, '本机解释');
  assert.equal(JSON.parse(storage.getItem(key)).conflicts.length, 1, 'the already-resolved conflict is not duplicated');
});

test('viewer marks removed-concept notes, revisions and questions as orphaned and shows them read-only', async () => {
  const model = baseModel();
  const oldModel = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.concat([{ id: 'legacy', title: '旧概念', parentId: 'root', difficulty: 1, explanation: '旧解释' }]),
    relations: model.relations.concat([{ id: 'rel-legacy', from: 'legacy', to: 'root', type: 'cause', label: '旧关系' }]),
  });
  const cached = createState(oldModel, '2026-01-01T00:00:00Z');
  cached.revision = 9;
  cached.explanations.legacy = { text: '旧概念的笔记', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  cached.summaries.legacy = { text: '旧概念的总结', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  cached.conceptRevisions.legacy = { title: '旧概念标题', updatedAt: '2026-01-01T01:00:00Z', modelFingerprint: oldModel.conceptFingerprints.legacy };
  cached.relationRevisions['rel-legacy'] = { label: '旧关系含义', updatedAt: '2026-01-01T01:00:00Z' };
  cached.ownQuestions['q-legacy'] = { id: 'q-legacy', conceptId: 'legacy', text: '旧自创问题', author: 'learner', createdAt: '2026-01-01T01:00:00Z', updatedAt: '2026-01-01T01:00:00Z' };
  const key = 'ember:v1:state:' + model.id;
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')), { localStorage: storage });
  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports[0].text());
  const orphanId = (kind) => (kind === 'relation-revision' ? 'rel-legacy' : (kind === 'own-question' ? 'q-legacy' : 'legacy'));
  for (const kind of ['explanation', 'summary', 'concept-revision', 'relation-revision', 'own-question']) {
    assert.ok(exported.orphans.some((o) => o.kind === kind && o.id === orphanId(kind)), `removed ${kind} is marked orphaned`);
  }
  assert.equal(exported.explanations.legacy.text, '旧概念的笔记', 'orphaned text is preserved');
  assert.equal(exported.ownQuestions['q-legacy'].text, '旧自创问题');

  buttonByText(page, '笔记').click();
  const panel = page.document.querySelector('#panel').textContent;
  assert.match(panel, /已移除概念\/关系的历史记录/);
  for (const text of ['旧概念的笔记', '旧概念的总结', '旧概念标题', '旧关系含义', '旧自创问题']) {
    assert.ok(panel.includes(text), `retained history shows ${text}`);
  }

  await saveNote(page, 'summary', '当前概念的新总结');
  buttonByText(page, '练习').click();
  assert.equal(page.document.querySelector('#panel').textContent.includes('旧自创问题'), false, 'a removed-concept question is not playable');

  const after = JSON.parse(storage.getItem(key));
  assert.equal(after.summaries.root.text, '当前概念的新总结', 'current live work still saves');
  assert.ok(after.orphans.some((o) => o.kind === 'explanation' && o.id === 'legacy'), 'orphan history is durable after a save');
  const reopened = await openPage(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')), { localStorage: storage });
  buttonByText(reopened, '概念').click();
  assert.equal(reopened.document.querySelector('#note-root-summary').value, '当前概念的新总结');
});

test('viewer keeps disjoint cache and rebuilt edits and continues saving after adoption', async () => {
  const model = baseModel();
  const key = 'ember:v1:state:' + model.id;
  const cached = createState(model, '2026-01-01T00:00:00Z');
  cached.revision = 6;
  cached.summaries.root = { text: '本机总结', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  const payloadState = createState(model, '2026-01-01T00:00:00Z');
  payloadState.explanations.root = { text: '档案解释', updatedAt: '2026-02-01T00:00:00Z', author: 'learner' };
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(page.document.querySelector('#conflictBanner').hidden, true, 'edits on different ids do not conflict');
  assert.equal(page.document.querySelector('#note-root-summary').value, '本机总结');
  assert.equal(page.document.querySelector('#note-root-explanation').value, '档案解释');
  await saveNote(page, 'summary', '本机总结（续写）');
  const persisted = JSON.parse(storage.getItem(key));
  assert.equal(persisted.summaries.root.text, '本机总结（续写）');
  assert.equal(persisted.explanations.root.text, '档案解释', 'the disjoint rebuilt edit is not destroyed');
  assert.equal(persisted.conflicts.length, 0, 'disjoint edits create no conflict');

  const reopened = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#note-root-summary').value, '本机总结（续写）');
  assert.equal(reopened.document.querySelector('#note-root-explanation').value, '档案解释');
});

test('viewer keeps delimiter-bearing conflict pairs distinct and never suppresses a new choice', async () => {
  const model = baseModel();
  const key = 'ember:v1:state:' + model.id;
  const cached = createState(model, '2026-01-01T00:00:00Z');
  cached.revision = 8;
  cached.summaries.root = { text: '先验|似然', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  const payloadState = createState(model, '2026-01-01T00:00:00Z');
  payloadState.summaries.root = { text: '后验', updatedAt: '2026-02-01T00:00:00Z', author: 'learner' };
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(page.document.querySelector('#conflictBanner').hidden, false);
  buttonByText(page, '保留缓存版本').click();
  await saveNote(page, 'summary', '先验');
  const mid = JSON.parse(storage.getItem(key));
  assert.equal(mid.summaries.root.text, '先验');
  assert.equal(mid.conflicts.filter((c) => c.origin === 'cache-reconcile').length, 1);

  // A different value pair whose old-style '|'-join would have collided must
  // still prompt a fresh choice and retain both complete alternatives.
  const rebuilt = createState(model, '2026-01-01T00:00:00Z');
  rebuilt.summaries.root = { text: '似然|后验', updatedAt: '2026-03-01T00:00:00Z', author: 'learner' };
  const reopened = await openPage(buildPayload(model, rebuilt), { localStorage: storage });
  assert.equal(reopened.document.querySelector('#conflictBanner').hidden, false, 'a genuinely different pair prompts a new choice');
  const bannerText = reopened.document.querySelector('#conflictBanner').textContent;
  assert.match(bannerText, /本机缓存版本：先验/);
  assert.match(bannerText, /重建页面版本：似然\|后验/);
  reopened.document.querySelector('#exportBtn').click();
  const reopenedState = JSON.parse(await reopened.exports[0].text());
  const cacheConflicts = reopenedState.conflicts.filter((c) => c.origin === 'cache-reconcile');
  assert.equal(cacheConflicts.length, 2, 'the resolved old pair and the new pair are both retained');
  assert.ok(cacheConflicts.some((c) => c.resolved && c.kept.text === '先验|似然' && c.incoming.text === '后验'));
  assert.ok(cacheConflicts.some((c) => !c.resolved && c.kept.text === '先验' && c.incoming.text === '似然|后验'));

  buttonByText(reopened, '采用重建版本').click();
  const afterChoose = JSON.parse(storage.getItem(key));
  assert.equal(afterChoose.summaries.root.text, '似然|后验');
  assert.equal(afterChoose.conflicts.filter((c) => c.origin === 'cache-reconcile').length, 2, 'both alternatives survive the choice');
});

test('viewer recognizes a previously resolved legacy delimiter pair for the same values', async () => {
  const model = baseModel();
  const key = 'ember:v1:state:' + model.id;
  const kept = { text: '先验|似然', updatedAt: '2026-01-01T01:00:00Z', author: 'learner' };
  const incoming = { text: '后验', updatedAt: '2026-02-01T00:00:00Z', author: 'learner' };
  const cached = createState(model, '2026-01-01T00:00:00Z');
  cached.revision = 8;
  cached.summaries.root = kept;
  cached.conflicts = [{
    kind: 'summaries', id: 'root', path: 'summaries.root',
    kept: kept, incoming: incoming, keptValue: kept.text, incomingValue: incoming.text,
    conflictKey: 'summaries|summaries.root|先验|似然|后验',
    origin: 'cache-reconcile', resolved: true, resolvedChoice: 'kept', at: '2026-01-01T02:00:00Z',
  }];
  const payloadState = createState(model, '2026-01-01T00:00:00Z');
  payloadState.summaries.root = incoming;
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage });
  assert.equal(page.document.querySelector('#conflictBanner').hidden, true, 'the same resolved pair is not reopened');
  const conflicts = JSON.parse(storage.getItem(key)).conflicts.filter((c) => c.origin === 'cache-reconcile');
  assert.equal(conflicts.length, 1, 'the derived identity matches the persisted legacy-key record');
});

test('rebuilt page adopts the newer attempt schedule and advances the legacy interval on the next rating', async () => {
  const model = baseModel();
  const oldModel = normalizeModel({
    ...modelToJson(model),
    concepts: model.concepts.map((c) => (c.id === 'ppv' ? { ...c, explanation: '改过的解释' } : c)),
  });
  // Higher whole-archive revision with an older, stale-hash attempt and schedule.
  let cached = applyAttempt(createState(oldModel, '2026-01-01T00:00:00Z'), oldModel, {
    promptId: 'p-ppv-explain', attemptId: 'att-cache-old', answer: '旧作答', rating: 'hard',
  }, '2026-10-08T00:00:00Z').state;
  cached.revision = 12;
  const oldAttemptBefore = JSON.parse(JSON.stringify(cached.attempts['p-ppv-explain'][0]));
  // Rebuilt payload has the newer attempt with the current content hash.
  const payloadState = applyAttempt(createState(model, '2026-01-01T00:00:00Z'), model, {
    promptId: 'p-ppv-explain', attemptId: 'att-payload-new', answer: '新作答', rating: 'good',
  }, '2026-10-11T00:00:00Z').state;
  const key = 'ember:v1:state:' + model.id;
  const storage = cacheStorage(key, JSON.stringify(cached));

  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage, now: '2026-10-12T00:00:00Z' });
  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports[0].text());
  const schedule = exported.schedules['p-ppv-explain'];
  assert.equal(schedule.lastAt, '2026-10-11T00:00:00Z', 'the newer attempt arrangement wins');
  assert.equal(schedule.intervalDays, 4);
  assert.equal(schedule.dueAt, '2026-10-15T00:00:00.000Z');
  assert.equal(schedule.streakKind, 'good');
  assert.equal(schedule.streakCount, 1, 'the valid payload streak is not reset by an older stale attempt');
  assert.deepEqual(exported.attempts['p-ppv-explain'].map((a) => a.id), ['att-cache-old', 'att-payload-new']);
  assert.deepEqual(exported.attempts['p-ppv-explain'][0], oldAttemptBefore, 'original old attempt fields are unchanged');
  assert.equal(page.document.querySelector('#conflictBanner').hidden, true, 'computed schedule divergence is never a note-style choice');
  assert.ok(exported.conflicts.some((c) => c.origin === 'cache-schedule-audit' && c.audit), 'genuine divergence is retained as an audit record');

  await rateThroughUi(page, 'p-ppv-explain', '为什么低患病率降低 PPV?', '新的独立作答', '顺利', storage, key, 3);
  const next = JSON.parse(storage.getItem(key)).schedules['p-ppv-explain'];
  assert.equal(next.streakKind, 'good');
  assert.equal(next.streakCount, 2, 'the next good rating continues the merged streak');
  assert.equal(next.intervalDays, 10, 'the legacy interval advanced from the merged schedule, not the stale cache');
});

test('viewer accepts legal attempt ids that collide with object prototype names', () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, current));
  const fingerprint = model.promptFingerprints['p-ppv-explain'];
  const incoming = {
    schemaVersion: 1, modelId: model.id,
    attempts: {
      'p-ppv-explain': [
        { id: 'toString', promptId: 'p-ppv-explain', at: '2026-01-01T01:00:00Z', answer: 'a', rating: 'good', assisted: false, fingerprint, corrections: [] },
        { id: 'valueOf', promptId: 'p-ppv-explain', at: '2026-01-01T02:00:00Z', answer: 'b', rating: 'good', assisted: false, fingerprint, corrections: [] },
      ],
    },
  };
  const merged = internals.mergeLocal(current, incoming);
  assert.deepEqual(plain(merged.attempts['p-ppv-explain']).map((a) => a.id), ['toString', 'valueOf']);
});

test('viewer refuses future and malformed caches and protects original bytes through save, retry and reopen', async () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id;
  for (const bad of [
    { ...current, schemaVersion: 3, revision: 20 },
    { ...current, attempts: [] },
    { ...current, attempts: { p: {} } },
    { ...current, attempts: { p: [{ id: 'x', rating: 'wrong', at: 'invalid' }] } },
    { ...current, schedules: { p: {} } },
    { ...current, conceptEvidence: { root: { status: 'mastered' } } },
    { ...current, conceptRevisions: { root: {} } },
    { ...current, migrations: {} },
    { ...current, explanations: [] },
    [],
    null,
    'broken JSON',
  ]) {
    const bytes = bad === 'broken JSON' ? '{broken' : JSON.stringify(bad, null, 2);
    const storage = cacheStorage(key, bytes);
    const exports = [];
    const banner = makeElement();
    const internals = loadViewer(buildPayload(model, current), { localStorage: storage, exports, elements: { '#storageBanner': banner } });
    internals.afterStandaloneLoad();
    assert.ok(internals.App.cacheRejected, 'rejection carries a useful reason');
    if (bad?.schemaVersion === 3) assert.match(internals.App.cacheRejected, /版本 3.*升级/);
    assert.equal(internals.App.state.revision, current.revision, 'bad cache never becomes active state');
    internals.localAction({ type: 'note', conceptId: 'root', kind: 'summary', text: '当前页面新修改' });
    assert.equal(internals.persistStandalone(), false);
    internals.retryCache();
    assert.equal(banner.hidden, false, 'clear cache-protection banner is rendered');
    assert.match(banner.children[0].textContent, /原缓存已完整保留.*不会被覆盖/);
    assert.equal(internals.savedStatus().kind, 'error');
    assert.equal(storage.getItem(key), bytes, 'save/retry preserve rejected cache byte for byte');
    internals.exportState();
    assert.equal(JSON.parse(await exports[0].text()).summaries.root.text, '当前页面新修改', 'new work remains exportable');
    const reopened = loadViewer(buildPayload(model, current), { localStorage: storage });
    reopened.afterStandaloneLoad();
    assert.ok(reopened.App.cacheRejected);
    assert.equal(reopened.persistStandalone(), false);
    assert.equal(storage.getItem(key), bytes, 'reopen cannot downgrade or repair rejected bytes');
  }
});

test('viewer imports v1/v2 archives and rejects future formats clearly', () => {
  const model = baseModel();
  const current = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, current));

  // A v1 export and a v2 archive are both accepted for import.
  const v1Import = { schemaVersion: 1, modelId: model.id, revision: 1, attempts: {}, schedules: {} };
  const fromV1 = internals.mergeLocal(current, v1Import);
  assert.equal(fromV1.schemaVersion, 2);
  const v2Import = { schemaVersion: 2, modelId: model.id, revision: 1, attempts: {}, schedules: {}, migrations: [] };
  const fromV2 = internals.mergeLocal(current, v2Import);
  assert.equal(fromV2.schemaVersion, 2);

  // A future archive format is refused with an upgrade hint, never parsed.
  assert.throws(
    () => internals.mergeLocal(current, { schemaVersion: 3, modelId: model.id, attempts: {}, schedules: {} }),
    /高于当前工具支持的版本 2/,
  );
  assert.throws(
    () => internals.mergeLocal(current, { schemaVersion: 'x', modelId: model.id, attempts: {}, schedules: {} }),
    /schemaVersion 必须是 1 或 2/,
  );
});

// ---------------------------------------------------------------------------
// Precise PPV + canvas cell counts
// ---------------------------------------------------------------------------

test('viewer PPV uses exact expected frequencies while the canvas keeps 1000 cells', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model, '2026-01-01T00:00:00Z')));
  const state = internals.activityState;

  state.prior = 0.01; state.sens = 0.9; state.spec = 0.95;
  const res = internals.computeActivityResults();
  assert.ok(Math.abs(res.ppv - 9 / 58.5) < 1e-12, 'PPV must come from exact expected counts');
  assert.equal((res.ppv * 100).toFixed(1), '15.4');
  assert.equal(res.cells.tp + res.cells.fp + res.cells.fn + res.cells.tn, 1000);
  const text = internals.formatActivityResults(res);
  assert.match(text, /期望计数/);
  assert.match(text, /画布格子/);

  state.prior = 0.001; state.sens = 0.5; state.spec = 0.95;
  const res2 = internals.computeActivityResults();
  assert.ok(Math.abs(res2.ppv - 0.5 / (0.5 + 49.95)) < 1e-12);
  assert.ok(Math.abs(res2.ppv - 1 / 51) > 1e-6, 'must not round counts before PPV');
  assert.equal(res2.cells.tp + res2.cells.fp + res2.cells.fn + res2.cells.tn, 1000);

  state.sens = 0; state.spec = 1;
  const res3 = internals.computeActivityResults();
  assert.equal(res3.ppv, null);
  assert.equal(internals.ppvText(res3.ppv), '无法定义（没有阳性）');

  state.prior = 0.01; state.sens = 0.9; state.spec = 0.95;
  const drawn = internals.drawActivity(makeCanvas());
  assert.equal(drawn.cells.tp + drawn.cells.fp + drawn.cells.fn + drawn.cells.tn, 1000);
});

// ---------------------------------------------------------------------------
// Due list
// ---------------------------------------------------------------------------

test('viewer due list skips own questions whose concept was removed', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  state.ownQuestions['q-orphan'] = {
    id: 'q-orphan', conceptId: 'missing', text: 'x', author: 'learner',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const internals = loadViewer(buildPayload(model, state));
  const due = internals.listDueLocal();
  assert.ok(!due.due.concat(due.unscheduled).some((d) => d.promptId === 'q-orphan'));
});

// ---------------------------------------------------------------------------
// Final proof validity: referenced attempts must be real, current, related and
// sufficient. computeView must match the authoritative core stateView.
// ---------------------------------------------------------------------------

function conceptProofModel() {
  return baseModel({
    prompts: [
      { id: 'p-prior-effect', conceptId: 'prior', kind: 'explain', question: '先验如何影响后验?', answer: '乘以似然', criteria: ['写出贝叶斯更新'] },
      { id: 'p-ppv-explain', conceptId: 'ppv', kind: 'explain', question: '为什么低患病率降低 PPV?', answer: '假阳性占比上升', criteria: ['提到分母'] },
    ],
  });
}

function viewWithViewer(model, state) {
  const internals = loadViewer(buildPayload(model, state));
  return { internals, view: plain(internals.computeView()) };
}

test('viewer proof validity mirrors core: question-only criteria change invalidates concept proof', async () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: '先验乘以似然', rating: 'good', attemptId: 'att-prior', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { conceptId: 'prior', status: 'explained', note: '能解释先验作用', attemptIds: ['att-prior'] }, '2026-01-01T02:00:00Z').state;

  const before = viewWithViewer(model, state);
  assert.deepEqual(before.view, stateView(state, model));
  assert.equal(before.view.conceptStatus.prior.status, 'explained');

  // Only the supporting prompt's criteria change; concept content is untouched.
  const updated = normalizeModel({
    ...modelToJson(model),
    prompts: model.prompts.map((p) => (p.id === 'p-prior-effect' ? { ...p, criteria: ['写出先验、似然与分母'] } : p)),
  });
  const { state: synced } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  const after = viewWithViewer(updated, synced);
  assert.deepEqual(after.view, stateView(synced, updated));
  assert.equal(after.view.conceptStatus.prior.status, 'unknown', 'obsolete question proof must not stay active');
  assert.equal(after.view.conceptStatus.prior.staleEvidence.status, 'explained', 'history is retained');
});

test('viewer proof validity mirrors core: deleted evidence prompt keeps history but no mastery', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'a', rating: 'good', attemptId: 'att-prior', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'] }, '2026-01-01T02:00:00Z').state;

  const updated = normalizeModel({ ...modelToJson(model), prompts: model.prompts.filter((p) => p.id !== 'p-prior-effect') });
  const { state: synced } = syncModel(state, updated, '2026-01-02T00:00:00Z');
  const after = viewWithViewer(updated, synced);
  assert.deepEqual(after.view, stateView(synced, updated));
  assert.equal(after.view.conceptStatus.prior.status, 'unknown');
  assert.equal(after.view.conceptStatus.prior.staleEvidence.status, 'explained');
});

test('viewer proof validity mirrors core: matching hashes with missing or empty proof are forged', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'a', rating: 'good', attemptId: 'att-prior', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'] }, '2026-01-01T02:00:00Z').state;

  state.conceptEvidence.prior = { ...state.conceptEvidence.prior, attemptIds: ['att-ghost'] };
  const ghost = viewWithViewer(model, state);
  assert.deepEqual(ghost.view, stateView(state, model));
  assert.equal(ghost.view.conceptStatus.prior.status, 'unknown');

  state.conceptEvidence.prior = { ...state.conceptEvidence.prior, attemptIds: [] };
  const legacy = viewWithViewer(model, state);
  assert.deepEqual(legacy.view, stateView(state, model));
  assert.equal(legacy.view.conceptStatus.prior.status, 'unknown', 'legacy/no-basis record is not mastery');
  assert.equal(legacy.internals.isConceptEvidenceActive('prior'), false);
});

test('viewer prompt proof needs referenced active attempts, not just a matching fingerprint', async () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'a', rating: 'good', attemptId: 'att-prior', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { promptId: 'p-prior-effect', status: 'explained', note: '能解释', attemptIds: ['att-prior'] }, '2026-01-01T02:00:00Z').state;

  const good = viewWithViewer(model, state);
  assert.equal(good.internals.isPromptEvidenceActive('p-prior-effect'), true);
  assert.deepEqual(good.view, stateView(state, model));
  assert.ok(good.view.prompts['p-prior-effect'].evidence);

  state.promptEvidence['p-prior-effect'] = { ...state.promptEvidence['p-prior-effect'], attemptIds: ['att-ghost'] };
  const forged = viewWithViewer(model, state);
  assert.equal(forged.internals.isPromptEvidenceActive('p-prior-effect'), false);
  assert.deepEqual(forged.view, stateView(state, model));
  assert.equal(forged.view.prompts['p-prior-effect'].evidence, null);
});

test('viewer valid unchanged concept and prompt proof stays active after sync', async () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'a', rating: 'good', attemptId: 'att-prior', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyTutorEvidence(state, model, { conceptId: 'prior', status: 'explained', note: '能解释', attemptIds: ['att-prior'] }, '2026-01-01T02:00:00Z').state;
  state = applyTutorEvidence(state, model, { promptId: 'p-prior-effect', status: 'explained', note: '能解释', attemptIds: ['att-prior'] }, '2026-01-01T02:30:00Z').state;
  const { state: synced } = syncModel(state, model, '2026-01-02T00:00:00Z');

  const kept = viewWithViewer(model, synced);
  assert.deepEqual(kept.view, stateView(synced, model));
  assert.equal(kept.view.conceptStatus.prior.status, 'explained');
  assert.ok(kept.view.prompts['p-prior-effect'].evidence);
  assert.equal(kept.internals.isConceptEvidenceActive('prior'), true);
});

test('viewer retained proof requires separated independent attempts', () => {
  const model = conceptProofModel();
  let state = createState(model, '2026-01-01T00:00:00Z');
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'a', rating: 'good', attemptId: 'att-a', assisted: false }, '2026-01-01T01:00:00Z').state;
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'b', rating: 'good', attemptId: 'att-b', assisted: false }, '2026-01-01T01:05:00Z').state;
  // Forge a retained claim over two same-minute attempts: not enough separation.
  state.conceptEvidence.prior = {
    status: 'retained', note: '记得', conceptFingerprint: model.conceptFingerprints.prior,
    at: '2026-01-01T02:00:00Z', attemptIds: ['att-a', 'att-b'],
  };
  const sameMinute = viewWithViewer(model, state);
  assert.deepEqual(sameMinute.view, stateView(state, model));
  assert.equal(sameMinute.internals.isConceptEvidenceActive('prior'), false);
  assert.equal(sameMinute.view.conceptStatus.prior.status, 'unknown');

  // A genuinely separated independent recall makes the same claim valid.
  state = applyAttempt(state, model, { promptId: 'p-prior-effect', answer: 'c', rating: 'good', attemptId: 'att-c', assisted: false }, '2026-01-02T12:00:00Z').state;
  state.conceptEvidence.prior = { ...state.conceptEvidence.prior, attemptIds: ['att-a', 'att-b', 'att-c'] };
  const separated = viewWithViewer(model, state);
  assert.deepEqual(separated.view, stateView(state, model));
  assert.equal(separated.internals.isConceptEvidenceActive('prior'), true);
  assert.equal(separated.view.conceptStatus.prior.status, 'retained');
});

// ---------------------------------------------------------------------------
// Title reflow: the raw effective title is re-measured, wraps into a taller
// node that reserves badge space, stays fully rendered (no ellipsis), and the
// re-placed tree keeps every box disjoint.
// ---------------------------------------------------------------------------

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function assertNodesDisjoint(nodes) {
  const ids = Object.keys(nodes);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      assert.ok(!rectsOverlap(nodes[ids[i]], nodes[ids[j]]), `nodes ${ids[i]} and ${ids[j]} must not overlap`);
    }
  }
}

test('viewer reflows a long learner title: full wrap, taller node, disjoint siblings, detail preserved', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(here, '..', 'skill', 'forge', 'assets', 'probability.json'), 'utf8'));
  const model = normalizeModel(sample);
  const state = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, state));

  const before = internals.ensureLayout().nodes['bayes-update'];
  const longTitle = '贝叶斯更新：先把先验与当前证据的似然结合，再把两条分支归一化，得到后验，并区分检测特性与阳性预测值';
  internals.localAction({ type: 'title', conceptId: 'bayes-update', title: longTitle });
  const after = internals.ensureLayout().nodes['bayes-update'];

  // The raw full title is what gets wrapped; the node grows to fit it.
  assert.ok(after.height > before.height, 'a long learner title grows the node height');
  assert.ok(after.lines.length > 1, 'the long title wraps onto multiple lines');
  assert.ok(after.lines.length <= internals.LAYOUT.maxLines, 'wrap respects the extreme-length cap');
  assert.equal(after.lines.join(''), longTitle, 'every character of the supplied title is rendered');
  assert.ok(!after.lines.some((line) => line.includes('…')), 'the supplied title is not ellipsized');
  assert.deepEqual(plain(internals.displayLines('bayes-update')), plain(after.lines));

  // Title plus badges: the box reserves enough room that they cannot collide.
  const titleHeight = after.lines.length * internals.LAYOUT.reflowLineHeight;
  assert.ok(after.height >= internals.LAYOUT.padY * 2 + titleHeight + internals.LAYOUT.badgeReserve,
    'node height reserves title lines plus the badge row');

  // The full title is preserved for the accessible label/detail, not truncated.
  assert.equal(internals.App.state.conceptRevisions['bayes-update'].title, longTitle);

  // The recomputed tree keeps every sibling and deeper row disjoint.
  assertNodesDisjoint(internals.ensureLayout().nodes);
});

test('viewer reflows the raw title even when the payload layout was built from the old title', () => {
  const model = baseModel();
  const longTitle = '先验概率与后验概率在证据下的关系需要一步步推导并且区分检测特性与阳性预测值';
  const state = createState(model, '2026-01-01T00:00:00Z');
  // Simulate a payload whose committed layout used the short author title; the
  // browser must re-measure the raw learner revision, not trust that box.
  const payload = buildPayload(model, state);
  payload.layout = { nodes: { prior: { x: 0, y: 0, width: 170, height: 55, depth: 1, lines: ['先验概率'] } }, bounds: { minX: 0, minY: 0, maxX: 170, maxY: 55 }, order: ['root', 'prior', 'ppv'] };
  const internals = loadViewer(payload);
  internals.localAction({ type: 'title', conceptId: 'prior', title: longTitle });
  const layout = internals.ensureLayout();
  const box = layout.nodes.prior;
  assert.ok(box.height > 55, 'the long revision grows the old-title node');
  assert.ok(box.lines.length > 1, 'the raw revision wraps');
  assert.equal(box.lines.join(''), longTitle, 'the full raw title is rendered, not the old author title');
  assert.ok(!box.lines.join('').includes('先验概率…'));
  assertNodesDisjoint(layout.nodes);
});

test('viewer keeps a title-driven reflow pending across subsequent nodeBox calls', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, state));

  // Establish the initial layout, then consume the one-time flag the way
  // render() does at its boundary. Ordinary calls must leave it clear.
  internals.ensureLayout();
  internals.App.layoutReflowed = false;
  const settle = internals.ensureLayout();
  assert.equal(internals.App.layoutReflowed, false, 'an unchanged signature is not a reflow');
  const viewportBefore = plain(internals.App.viewport);
  internals.App.nodeBox('root');
  internals.App.nodeBox('prior');
  assert.deepEqual(plain(internals.App.viewport), viewportBefore, 'ordinary nodeBox calls do not move the view');
  assert.equal(internals.ensureLayout(), settle, 'an unchanged signature reuses the same layout');

  // A title change marks a pending reflow. Because every nodeBox() calls
  // ensureLayout() again with the same (now updated) signature, the flag must
  // stay set until the render boundary consumes it, or render() would never
  // call ensureSelectedVisible().
  internals.localAction({ type: 'title', conceptId: 'prior', title: '先验概率与后验概率在证据下的关系需要一步步推导并且区分检测特性与阳性预测值' });
  internals.ensureLayout();
  assert.equal(internals.App.layoutReflowed, true, 'a title change marks a pending reflow');
  internals.App.nodeBox('root');
  internals.App.nodeBox('prior');
  const afterBoxes = internals.ensureLayout();
  assert.equal(internals.App.layoutReflowed, true, 'the reflow stays pending across nodeBox calls in the same render');
  assert.deepEqual(plain(internals.App.viewport), viewportBefore, 'a reflow may be pending without pre-emptively moving the view');
  assert.ok(afterBoxes.nodes.prior.lines.length > 1, 'the pending reflow carries the wrapped title');

  // The render boundary consumes the flag; after that an unchanged render does
  // not re-fit or keep the flag set.
  internals.App.layoutReflowed = false;
  internals.ensureLayout();
  internals.App.nodeBox('prior');
  assert.equal(internals.App.layoutReflowed, false, 'the boundary reset sticks until the next title change');
});

test('viewer saves an unassessed answer and reopens it as immutable saved work', async () => {
  const model = baseModel(); const initial = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id; const storage = cacheStorage('', '');
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  buttonByText(page, '练习').click();
  page.document.querySelectorAll('button').find((b) => b.textContent.includes(model.prompts[0].question)).click();
  const promptId = model.prompts[0].id;
  assert.equal(page.document.querySelectorAll('.reference').length, 0);
  const area = page.document.querySelector('#answer-' + promptId);
  area.value = 'unassessed original'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => (JSON.parse(storage.getItem(key) || '{}').attempts?.[promptId] || []).length === 1);
  await new Promise((r) => setImmediate(r));
  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.attempts[promptId][0].rating, null); assert.deepEqual(saved.schedules, {});
  assert.equal(saved.attempts[promptId][0].assisted, false);
  assert.deepEqual(saved.attempts[promptId][0].assistance, []);
  assert.ok(page.document.querySelectorAll('.reference').length > 0, 'automatic reference display follows submission');
  assert.match(page.document.querySelector('#panel').textContent, /原答已保存（独立）/);
  const reopened = await openPage(buildPayload(model, initial), { localStorage: storage });
  buttonByText(reopened, '练习').click();
  reopened.document.querySelectorAll('button').find((b) => b.textContent.includes(model.prompts[0].question)).click();
  assert.equal(reopened.document.querySelector('#answer-' + promptId).disabled, true);
  assert.equal(reopened.document.querySelector('#answer-' + promptId).value, 'unassessed original');
  assert.match(reopened.document.querySelector('#panel').textContent, /原答已保存（独立）/);
  buttonByText(reopened, '顺利').click();
  await until(() => JSON.parse(storage.getItem(key)).attempts[promptId][0].rating === 'good');
  assert.equal(JSON.parse(storage.getItem(key)).attempts[promptId].length, 1);
});

async function enterFirstPractice(page, model) {
  buttonByText(page, '练习').click();
  page.document.querySelectorAll('button').find((b) => b.textContent.includes(model.prompts[0].question)).click();
  return page.document.querySelector('#answer-' + model.prompts[0].id);
}

test('viewer appends sourced corrections and starts a new identity without requiring self-assessment', async () => {
  const model = baseModel(), initial = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id, storage = cacheStorage('', '');
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  const area = await enterFirstPractice(page, model), pid = model.prompts[0].id;
  area.value = 'independent original'; area.dispatchEvent({ type: 'input' }); buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelectorAll('button').some((b) => b.textContent === '顺利'));
  const original = JSON.parse(storage.getItem(key)).attempts[pid][0];
  const correction = page.document.querySelectorAll('textarea').find((n) => n.getAttribute('aria-label') === '补充修正');
  correction.value = 'tutor correction'; correction.dispatchEvent({ type: 'input' });
  const source = page.document.querySelectorAll('select').find((n) => n.getAttribute('aria-label') === '修正使用的协助来源');
  source.value = 'tutor-feedback'; buttonByText(page, '保存修正').click();
  await until(() => JSON.parse(storage.getItem(key)).attempts[pid][0].corrections.length === 1);
  const corrected = JSON.parse(storage.getItem(key)).attempts[pid][0];
  assert.equal(corrected.answer, original.answer); assert.equal(corrected.at, original.at); assert.equal(corrected.assisted, false);
  assert.equal(corrected.corrections[0].attemptId, original.id); assert.match(corrected.corrections[0].id, /^corr-/);
  assert.deepEqual(corrected.corrections[0].assistance, ['tutor-feedback']);
  buttonByText(page, '暂不自评，再做一次（隐藏参考）').click();
  assert.equal(page.document.querySelectorAll('.reference').length, 0);
  const next = page.document.querySelector('#answer-' + pid); assert.equal(next.value, '');
  next.value = 'new answer'; next.dispatchEvent({ type: 'input' }); buttonByText(page, '提交作答').click();
  await until(() => JSON.parse(storage.getItem(key)).attempts[pid].length === 2);
  const attempts = JSON.parse(storage.getItem(key)).attempts[pid];
  assert.notEqual(attempts[0].id, attempts[1].id); assert.notEqual(attempts[0].sessionId, attempts[1].sessionId);
  buttonByText(page, '为此原答补自评：顺利').click();
  await until(() => JSON.parse(storage.getItem(key)).attempts[pid].some((a) => a.rating === 'good'));
  assert.equal(JSON.parse(storage.getItem(key)).attempts[pid].length, 2);
  page.document.querySelector('#exportBtn').click();
  assert.doesNotThrow(() => normalizeState(JSON.parse(storage.getItem(key)), model), 'export-compatible durable records');
});

test('practice remains usable when a rebuilt model removes a round target concept', async () => {
  const oldModel = baseModel();
  const state = applyLearningRound(createState(oldModel), oldModel, {
    action: 'create', roundId: 'orphan-round', entry: 'organize-existing-material',
    goal: '合成目标', conceptIds: ['prior'], budgetMinutes: 15,
  }).state;
  const raw = modelToJson(oldModel);
  raw.concepts = raw.concepts.filter(c => c.id !== 'prior');
  raw.prompts = raw.prompts.filter(p => p.conceptId !== 'prior');
  raw.relations = raw.relations.filter(r => r.from !== 'prior' && r.to !== 'prior');
  const model = normalizeModel(raw);
  const updated = syncModel(state, model).state;
  const page = await openPage(buildPayload(model, updated));
  assert.doesNotThrow(() => buttonByText(page, '练习').click());
  const text = page.document.querySelector('#panel').textContent;
  assert.match(text, /概念已移除，历史仍保留/);
  assert.match(text, /为什么低患病率降低 PPV/);
  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports.at(-1).text());
  assert.equal(exported.learningRounds['orphan-round'].conceptIds[0], 'prior');
});

test('progressive hints reveal one step, survive reopening, and keep the submitted original assisted', async () => {
  const model = baseModel({ prompts: [{ id: 'p-step', conceptId: 'prior', kind: 'explain', question: '说明条件集合', answer: '分母限于条件集合', criteria: ['明确分母'],
    teaching: { purpose: 'explanation', objective: '解释分母范围', prerequisites: [], misconceptions: ['分母永远是全集'], hints: ['先识别条件', '再数条件内的总数'] } }] });
  const initial = createState(model, '2026-01-01T00:00:00Z'), storage = cacheStorage('', ''), key = 'ember:v1:state:' + model.id;
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  await enterFirstPractice(page, model);
  buttonByText(page, '查看提示（标记为有协助）').click();
  await until(() => Object.values(JSON.parse(storage.getItem(key)).practiceSessions)[0].hintLevel === 1);
  assert.ok(page.document.querySelector('#panel').textContent.includes('先识别条件'));
  assert.ok(!page.document.querySelector('#panel').textContent.includes('再数条件内的总数'));
  const reopened = await openPage(buildPayload(model, initial), { localStorage: storage });
  const area = await enterFirstPractice(reopened, model);
  assert.ok(reopened.document.querySelector('#panel').textContent.includes('先识别条件'));
  buttonByText(reopened, '查看提示（标记为有协助）').click();
  await until(() => Object.values(JSON.parse(storage.getItem(key)).practiceSessions)[0].hintLevel === 2);
  assert.ok(reopened.document.querySelector('#panel').textContent.includes('再数条件内的总数'));
  assert.notEqual(buttonByText(reopened, '查看提示（标记为有协助）').getAttribute('disabled'), null);
  const currentArea = reopened.document.querySelector('#answer-p-step');
  currentArea.value = '条件内成功数除以条件内总数'; currentArea.dispatchEvent({ type: 'input' });
  buttonByText(reopened, '提交作答').click();
  await until(() => (JSON.parse(storage.getItem(key)).attempts['p-step'] || []).length === 1);
  const state = JSON.parse(storage.getItem(key));
  assert.equal(state.attempts['p-step'][0].assisted, true);
  assert.deepEqual(state.attempts['p-step'][0].assistance, ['hint']);
  assert.doesNotThrow(() => normalizeState(state, model));
});

test('HTTP page forwards hint steps and restores them from the actual archive', async (t) => {
  const model = baseModel({ prompts: [{ id: 'p-step-http', conceptId: 'prior', kind: 'explain', question: '解释条件集合', answer: '限制分母', criteria: ['分母'], teaching: { hints: ['识别条件', '限定分母'] } }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hint-http-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.json'); fs.writeFileSync(source, JSON.stringify(modelToJson(model)));
  const built = buildArtifacts({ modelPath: source, outDir: dir, viewerPath });
  const started = await startServer({ dir, port: 0 }); t.after(() => started.close());
  const network = (url, options) => fetch(new URL(url, started.url), options);
  const page = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  await enterFirstPractice(page, model);
  buttonByText(page, '查看提示（标记为有协助）').click();
  await until(() => Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).practiceSessions).some(s => s.hintLevel === 1));
  const reopened = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  await enterFirstPractice(reopened, model);
  assert.match(reopened.document.querySelector('#panel').textContent, /分步提示 1\/2/);
  assert.ok(!reopened.document.querySelector('#panel').textContent.includes('限定分母'));
});

test('viewer restores draft and help facts before an assisted submission', async () => {
  const model = baseModel(), initial = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id, storage = cacheStorage('', '');
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  const area = await enterFirstPractice(page, model);
  area.value = 'draft after hint'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '查看提示（标记为有协助）').click();
  await until(() => page.document.querySelector('#panel').textContent.includes('提示：'));
  const session = Object.values(JSON.parse(storage.getItem(key)).practiceSessions)[0];
  assert.deepEqual(session.assistance, ['hint']);
  const reopened = await openPage(buildPayload(model, initial), { localStorage: storage });
  assert.equal((await enterFirstPractice(reopened, model)).value, 'draft after hint');
  assert.equal(reopened.document.querySelectorAll('.reference').length, 0, 'reference hidden on resume');
  buttonByText(reopened, '提交作答').click();
  await until(() => (JSON.parse(storage.getItem(key)).attempts[model.prompts[0].id] || []).length === 1);
  const attempt = JSON.parse(storage.getItem(key)).attempts[model.prompts[0].id][0];
  assert.equal(attempt.assisted, true); assert.deepEqual(attempt.assistance, ['hint']);
  assert.equal(attempt.sessionId, session.id);
});

test('viewer keeps failed cache submission pending until retry actually persists it', async () => {
  const model = baseModel(), initial = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id, backing = cacheStorage('', '');
  let fail = false;
  const storage = { getItem: (k) => backing.getItem(k), removeItem: (k) => backing.removeItem(k),
    setItem(k, v) { if (fail && k === key) throw new Error('quota'); backing.setItem(k, v); } };
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  const area = await enterFirstPractice(page, model);
  area.value = 'retry original'; area.dispatchEvent({ type: 'input' });
  await until(() => Object.values(JSON.parse(storage.getItem(key)).practiceSessions).some((s) => s.draft === 'retry original'));
  fail = true;
  buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelector('#saveStatus').textContent.includes('尚未保存'));
  assert.equal((JSON.parse(storage.getItem(key)).attempts[model.prompts[0].id] || []).length, 0);
  assert.equal(page.document.querySelectorAll('button').some((b) => b.textContent === '顺利'), false, 'no assessment of unsaved work');
  const reopened = await openPage(buildPayload(model, initial), { localStorage: storage });
  assert.equal((await enterFirstPractice(reopened, model)).disabled, false, 'reopen uses durable draft, never unsaved memory');
  fail = false;
  buttonByText(page, '重试保存到本机').click();
  await until(() => page.document.querySelectorAll('button').some((b) => b.textContent === '顺利'));
  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.attempts[model.prompts[0].id].length, 1); assert.equal(saved.attempts[model.prompts[0].id][0].answer, 'retry original');
  assert.match(page.document.querySelector('#saveStatus').textContent, /已缓存/);
});

test('viewer never reveals reference when assistance persistence fails', async () => {
  const model = baseModel(), initial = createState(model, '2026-01-01T00:00:00Z');
  const key = 'ember:v1:state:' + model.id, backing = cacheStorage('', '');
  let fail = false;
  const storage = { getItem: (k) => backing.getItem(k), removeItem: (k) => backing.removeItem(k),
    setItem(k, v) { if (fail && k === key) throw new Error('quota'); backing.setItem(k, v); } };
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  const area = await enterFirstPractice(page, model);
  area.value = 'keep input'; area.dispatchEvent({ type: 'input' });
  await until(() => Object.keys(JSON.parse(storage.getItem(key)).practiceSessions).length === 1);
  fail = true; buttonByText(page, '查看参考（标记为有协助）').click();
  await until(() => page.document.querySelector('#saveStatus').textContent.includes('尚未保存'));
  assert.equal(page.document.querySelectorAll('.reference').length, 0);
  assert.equal(page.document.querySelector('#answer-' + model.prompts[0].id).value, 'keep input');
  fail = false; buttonByText(page, '重试保存到本机').click();
  await until(() => page.document.querySelectorAll('.reference').length > 0);
  assert.deepEqual(Object.values(JSON.parse(storage.getItem(key)).practiceSessions)[0].assistance, ['reference']);
});

test('server viewer reconciles CLI help after submission conflict/replay and reopen', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-viewer-concurrent-help-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = conceptProofModel(), pid = 'p-prior-effect';
  const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(modelToJson(model)));
  const built = buildArtifacts({ modelPath: source, outDir: dir, viewerPath });
  const started = await startServer({ dir, port: 0 }); t.after(() => started.close());
  const submitStatuses = [];
  const network = async (url, options) => {
    const response = await fetch(started.url + url, options);
    if (url === '/api/submit') submitStatuses.push(response.status);
    return response;
  };
  const page = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  const area = await enterFirstPractice(page, model);
  area.value = '低先验会降低阳性预测值。'; area.dispatchEvent({ type: 'input' });
  await until(() => page.document.querySelector('#saveStatus').textContent.includes('已归档'));
  const before = await (await network('/api/state')).json();
  const session = Object.values(before.state.practiceSessions).find((s) => s.promptId === pid);
  assert.equal(session.draft, area.value);
  execFileSync(process.execPath, [path.join(here, '..', 'skill', 'forge', 'scripts', 'forge.mjs'),
    'practice', '--out', dir, '--prompt', pid, '--session-id', session.id, '--assistance', 'hint'], { encoding: 'utf8' });

  buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelectorAll('button').some((b) => b.textContent === '顺利'));
  assert.deepEqual(submitStatuses, [409, 200], 'stale revision refreshes and replays the actual submission');
  const saved = (await (await network('/api/state')).json()).state;
  assert.equal(saved.attempts[pid].length, 1);
  assert.equal(saved.attempts[pid][0].assisted, true);
  assert.deepEqual(saved.attempts[pid][0].assistance, ['hint']);
  assert.equal(saved.attempts[pid][0].sessionId, session.id);
  assert.match(page.document.querySelector('#panel').textContent, /原答已保存（有协助）/);
  assert.doesNotMatch(page.document.querySelector('#panel').textContent, /原答已保存（独立）/);

  const reopened = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  const restored = await enterFirstPractice(reopened, model);
  assert.equal(restored.disabled, true);
  assert.equal(restored.value, area.value);
  assert.match(reopened.document.querySelector('#panel').textContent, /原答已保存（有协助）/);
});

test('server viewer reconciles CLI help for an open draft after refresh/replay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-viewer-draft-help-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = conceptProofModel(), pid = 'p-prior-effect';
  const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(modelToJson(model)));
  const built = buildArtifacts({ modelPath: source, outDir: dir, viewerPath });
  const started = await startServer({ dir, port: 0 }); t.after(() => started.close());
  const practiceStatuses = [];
  const network = async (url, options) => {
    const response = await fetch(started.url + url, options);
    if (url === '/api/practice') practiceStatuses.push(response.status);
    return response;
  };
  const page = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  const area = await enterFirstPractice(page, model);
  area.value = 'initial draft'; area.dispatchEvent({ type: 'input' });
  await until(() => page.document.querySelector('#saveStatus').textContent.includes('已归档'));
  const session = Object.values((await (await network('/api/state')).json()).state.practiceSessions)[0];
  execFileSync(process.execPath, [path.join(here, '..', 'skill', 'forge', 'scripts', 'forge.mjs'),
    'practice', '--out', dir, '--prompt', pid, '--session-id', session.id, '--assistance', 'hint'], { encoding: 'utf8' });
  practiceStatuses.length = 0;
  const edited = page.document.querySelector('#answer-' + pid);
  edited.value = 'revised draft'; edited.dispatchEvent({ type: 'input' });
  await until(() => page.document.querySelector('#saveStatus').textContent.includes('已归档'));
  assert.deepEqual(practiceStatuses, [409, 200]);
  assert.match(page.document.querySelector('#panel').textContent, /本次练习已有协助记录/);
  assert.equal(page.document.querySelector('#answer-' + pid).value, 'revised draft');
  assert.equal(page.document.querySelector('#answer-' + pid).disabled, false);
  assert.equal(page.document.querySelectorAll('.reference').length, 0, 'reconciliation does not reveal reference');
  assert.doesNotMatch(page.document.querySelector('#panel').textContent, /提示：/);

  const reopened = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  assert.equal((await enterFirstPractice(reopened, model)).value, 'revised draft');
  assert.match(reopened.document.querySelector('#panel').textContent, /本次练习已有协助记录/);
  buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelector('#panel').textContent.includes('原答已保存（有协助）'));
  const original = (await (await network('/api/state')).json()).state.attempts[pid][0];
  assert.equal(original.answer, 'revised draft');
  assert.deepEqual(original.assistance, ['hint']);
});

test('server viewer keeps the saved independent original authoritative after later session help and reopen', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-viewer-original-help-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = conceptProofModel(), pid = 'p-prior-effect';
  const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(modelToJson(model)));
  const built = buildArtifacts({ modelPath: source, outDir: dir, viewerPath });
  const started = await startServer({ dir, port: 0 }); t.after(() => started.close());
  const network = (url, options) => fetch(started.url + url, options);
  const page = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  const area = await enterFirstPractice(page, model);
  area.value = 'independent original'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => page.document.querySelector('#panel').textContent.includes('原答已保存（独立）'));
  assert.ok(page.document.querySelectorAll('.reference').length > 0, 'reference displays after the independent submission');
  const original = (await (await network('/api/state')).json()).state.attempts[pid][0];
  assert.equal(original.assisted, false); assert.deepEqual(original.assistance, []);
  execFileSync(process.execPath, [path.join(here, '..', 'skill', 'forge', 'scripts', 'forge.mjs'),
    'practice', '--out', dir, '--prompt', pid, '--session-id', original.sessionId, '--assistance', 'reference'], { encoding: 'utf8' });
  const correction = page.document.querySelectorAll('textarea').find((n) => n.getAttribute('aria-label') === '补充修正');
  correction.value = 'correction using reference'; correction.dispatchEvent({ type: 'input' });
  buttonByText(page, '保存修正').click();
  await until(() => page.document.querySelector('#panel').textContent.includes('correction using reference'));
  const saved = (await (await network('/api/state')).json()).state;
  assert.deepEqual(saved.practiceSessions[original.sessionId].assistance, ['reference']);
  assert.deepEqual(saved.attempts[pid][0], { ...original, corrections: saved.attempts[pid][0].corrections }, 'only the correction is appended');
  assert.deepEqual(saved.attempts[pid][0].corrections[0].assistance, ['reference']);
  assert.match(page.document.querySelector('#panel').textContent, /原答已保存（独立）/);
  const reopened = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  assert.equal((await enterFirstPractice(reopened, model)).value, original.answer);
  assert.match(reopened.document.querySelector('#panel').textContent, /原答已保存（独立）/);
  assert.doesNotMatch(reopened.document.querySelector('#panel').textContent, /原答已保存（有协助）/);
});

test('server viewer restores archive drafts/help without browser cache and submits before rating', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-viewer-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = baseModel(); const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(modelToJson(model)));
  const built = buildArtifacts({ modelPath: source, outDir: dir, viewerPath });
  const started = await startServer({ dir, port: 0 }); t.after(() => started.close());
  const network = (url, options) => fetch(started.url + url, options);
  const page = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  const area = await enterFirstPractice(page, model);
  area.value = 'server draft'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '查看参考（标记为有协助）').click();
  await until(() => page.document.querySelectorAll('.reference').length > 0);
  const reopened = await openPage(buildPayload(model, built.state), { protocol: 'http:', fetch: network });
  assert.equal((await enterFirstPractice(reopened, model)).value, 'server draft');
  assert.equal(reopened.document.querySelectorAll('.reference').length, 0);
  buttonByText(reopened, '提交作答').click();
  await until(() => reopened.document.querySelectorAll('button').some((b) => b.textContent === '顺利'));
  let response = await (await network('/api/state')).json();
  assert.equal(response.state.attempts[model.prompts[0].id][0].rating, null);
  assert.equal(response.state.attempts[model.prompts[0].id][0].assisted, true);
  assert.deepEqual(response.state.schedules, {});
  assert.match(reopened.document.querySelector('#saveStatus').textContent, /已归档/);
  buttonByText(reopened, '顺利').click();
  await until(() => reopened.document.querySelector('#panel').textContent.includes('本次已经保存过自评'));
  response = await (await network('/api/state')).json();
  assert.equal(response.state.attempts[model.prompts[0].id].length, 1);
  assert.equal(response.state.attempts[model.prompts[0].id][0].rating, 'good');
});

// ---------------------------------------------------------------------------
// Cache failure: a throwing localStorage must never be reported as a durable
// save, and the in-memory data plus JSON export must still work.
// ---------------------------------------------------------------------------

test('standalone round keeps submitted identity, target adjustment and pause across reopen', async () => {
  const model = baseModel(); const initial = createState(model);
  const storage = cacheStorage('', ''); const key = 'ember:v1:state:' + model.id;
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  buttonByText(page, '本轮').click();
  page.document.querySelector('[aria-label="本轮目标概念"]').value = 'prior';
  buttonByText(page, '开始本轮').click();
  await until(() => JSON.parse(storage.getItem(key) || '{}').activeRoundId);
  const roundId = JSON.parse(storage.getItem(key)).activeRoundId;
  buttonByText(page, '进入这项练习').click();
  const area = page.document.querySelector('[aria-label="你的作答"]');
  assert.ok(area, 'task opens its real answer editor');
  area.value = '合成验收答案：先验进入分母'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => (JSON.parse(storage.getItem(key)).attempts['p-prior-apply'] || []).length === 1);
  const submitted = JSON.parse(storage.getItem(key)).attempts['p-prior-apply'][0];
  assert.equal(submitted.roundId, roundId); assert.ok(submitted.taskId);
  assert.equal(submitted.rating, null);
  assert.deepEqual(JSON.parse(storage.getItem(key)).conceptEvidence, {});
  buttonByText(page, '返回本轮任务').click();
  const minutes = page.document.querySelector('[aria-label="本轮时间预算（分钟，可留空）"]');
  minutes.value = '30'; minutes.dispatchEvent({ type: 'input' });
  buttonByText(page, '调整本轮路线').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].budgetMinutes === 30);
  buttonByText(page, '暂停本轮').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].status === 'paused');
  const reopened = await openPage(buildPayload(model, initial), { localStorage: storage });
  assert.match(reopened.document.querySelector('#panel').textContent, /已暂停/);
  buttonByText(reopened, '继续本轮').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].status !== 'paused');
  const after = JSON.parse(storage.getItem(key));
  assert.equal(after.activeRoundId, roundId);
  assert.deepEqual(after.attempts['p-prior-apply'][0], submitted);
  assert.equal(after.learningRounds[roundId].budgetMinutes, 30);
});

test('new-topic page waits for diagnostic submission and keeps the formal task separate', async () => {
  const model = baseModel(); const initial = createState(model), storage = cacheStorage('', '');
  const key = 'ember:v1:state:' + model.id;
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  buttonByText(page, '本轮').click();
  page.document.querySelector('[aria-label="本轮目标概念"]').value = 'prior';
  page.document.querySelector('[aria-label="学习入口"]').value = 'learn-new-topic';
  buttonByText(page, '开始本轮').click();
  await until(() => JSON.parse(storage.getItem(key) || '{}').activeRoundId);
  const state = JSON.parse(storage.getItem(key)); const roundId = state.activeRoundId;
  assert.equal(state.learningRounds[roundId].status, 'diagnosing');
  assert.equal(buttonByText(page, '已核对诊断，继续路线').getAttribute('disabled'), '');
  buttonByText(page, '暂停本轮').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].status === 'paused');
  buttonByText(page, '继续本轮').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].status === 'diagnosing');
  buttonByText(page, '进入这项练习').click();
  const area = page.document.querySelector('[aria-label="你的作答"]');
  area.value = '合成诊断原答'; area.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => (JSON.parse(storage.getItem(key)).attempts['p-prior-apply'] || []).length === 1);
  buttonByText(page, '返回本轮任务').click();
  buttonByText(page, '已核对诊断，继续路线').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].status === 'active');
  const buttons = page.document.querySelectorAll('button').filter((b) => b.textContent === '进入这项练习');
  buttons[1].click();
  const formalArea = page.document.querySelector('[aria-label="你的作答"]');
  assert.equal(formalArea.value, '', 'formal task cannot reuse diagnostic answer or identity');
  formalArea.value = '合成正式解释'; formalArea.dispatchEvent({ type: 'input' });
  buttonByText(page, '提交作答').click();
  await until(() => JSON.parse(storage.getItem(key)).attempts['p-prior-apply'].length === 2);
  const after = JSON.parse(storage.getItem(key));
  assert.notEqual(after.attempts['p-prior-apply'][0].taskId, after.attempts['p-prior-apply'][1].taskId);
  assert.equal(after.learningRounds[roundId].status, 'completed');
  assert.deepEqual(after.conceptEvidence, {});
});

test('an insufficient budget honestly defers work and opens it after adjustment', async () => {
  const model = baseModel(), initial = createState(model), storage = cacheStorage('', '');
  const key = 'ember:v1:state:' + model.id;
  const page = await openPage(buildPayload(model, initial), { localStorage: storage });
  buttonByText(page, '本轮').click();
  page.document.querySelector('[aria-label="本轮目标概念"]').value = 'prior';
  const budget = page.document.querySelector('[aria-label="本轮时间预算（分钟，可留空）"]');
  budget.value = '1'; budget.dispatchEvent({ type: 'input' });
  buttonByText(page, '开始本轮').click();
  await until(() => JSON.parse(storage.getItem(key) || '{}').activeRoundId);
  const roundId = JSON.parse(storage.getItem(key)).activeRoundId;
  assert.equal(JSON.parse(storage.getItem(key)).learningRounds[roundId].currentTaskId, null);
  assert.match(page.document.querySelector('#panel').textContent, /预算不足，当前没有可开始的任务/);
  assert.equal(buttonByText(page, '进入这项练习').getAttribute('disabled'), '');
  const increased = page.document.querySelector('[aria-label="本轮时间预算（分钟，可留空）"]');
  increased.value = '30'; increased.dispatchEvent({ type: 'input' });
  buttonByText(page, '调整本轮路线').click();
  await until(() => JSON.parse(storage.getItem(key)).learningRounds[roundId].budgetMinutes === 30);
  assert.doesNotMatch(page.document.querySelector('#panel').textContent, /预算不足/);
  assert.equal(buttonByText(page, '进入这项练习').getAttribute('disabled'), null);
  assert.deepEqual(JSON.parse(storage.getItem(key)).attempts, {});
});

test('offline import preserves legal prototype-named round and practice identities', () => {
  const model = baseModel(), state = createState(model);
  const source = loadViewer(buildPayload(model, state));
  source.localAction({ type: 'round', input: { action: 'create', roundId: 'toString',
    entry: 'organize-existing-material', goal: '解释先验', conceptIds: ['prior'] } });
  const taskId = source.App.state.learningRounds.toString.tasks[0].id;
  source.localAction({ type: 'practice', sessionId: 'toString', promptId: 'p-prior-apply', draft: '合成导入草稿',
    roundId: 'toString', taskId });
  const exported = plain(source.App.state);
  const destination = loadViewer(buildPayload(model, state));
  const merged = destination.mergeLocal(state, exported);
  assert.equal(merged.activeRoundId, 'toString');
  assert.deepEqual(plain(merged.learningRounds.toString), exported.learningRounds.toString);
  assert.deepEqual(plain(merged.practiceSessions.toString), exported.practiceSessions.toString);
  assert.equal(Object.hasOwn(merged.learningRounds, 'toString'), true);
  assert.equal(Object.hasOwn(merged.practiceSessions, 'toString'), true);
});

test('offline import reports a changed round binding without adopting its assessment or help', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model)));
  internals.localAction({ type: 'round', input: { action: 'create', roundId: 'round-original',
    entry: 'organize-existing-material', goal: '解释先验', conceptIds: ['prior'] } });
  const round = internals.App.state.learningRounds['round-original'];
  const taskId = round.tasks[0].id;
  const binding = { roundId: round.id, taskId };
  internals.localAction({ type: 'practice', sessionId: 'session-original', promptId: 'p-prior-apply', draft: '合成原答', ...binding });
  internals.localAction({ type: 'submit', sessionId: 'session-original', promptId: 'p-prior-apply', attemptId: 'att-original', answer: '合成原答', ...binding });
  const original = plain(internals.App.state);
  const imported = structuredClone(original);
  imported.attempts['p-prior-apply'][0].roundId = 'another-round';
  imported.attempts['p-prior-apply'][0].rating = 'good';
  imported.practiceSessions['session-original'].roundId = 'another-round';
  imported.practiceSessions['session-original'].assistance = ['reference'];
  const merged = internals.mergeLocal(original, imported);
  assert.deepEqual(plain(merged.attempts['p-prior-apply']), original.attempts['p-prior-apply']);
  assert.deepEqual(plain(merged.practiceSessions['session-original']), original.practiceSessions['session-original']);
  assert.ok(merged.conflicts.some((c) => c.kind === 'attempt'));
  assert.ok(merged.conflicts.some((c) => c.kind === 'practice'));
});

test('viewer reports a failed cache write instead of claiming a durable save', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  const throwingStorage = {
    getItem() { return null; },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() {},
  };
  const internals = loadViewer(buildPayload(model, state), { localStorage: throwingStorage });

  assert.equal(internals.persistStandalone(), false, 'failed write is reported');
  assert.equal(internals.App.storageError, true);
  const status = internals.savedStatus();
  assert.equal(status.kind, 'error');
  assert.doesNotMatch(status.message, /已保存|已缓存/);
  assert.match(status.message, /当前页面/);

  // The learning action itself does not throw, and the data stays in memory.
  assert.doesNotThrow(() => internals.localAction({ type: 'note', conceptId: 'root', kind: 'explanation', text: '离线笔记' }));
  assert.equal(internals.App.state.explanations.root.text, '离线笔记');

  // Retry still fails but keeps the data and the honest status.
  assert.doesNotThrow(() => internals.retryCache());
  assert.equal(internals.App.storageError, true);

  // Export remains available as the durable escape hatch.
  assert.doesNotThrow(() => internals.exportState());
  assert.equal(internals.App.state.explanations.root.text, '离线笔记');
});

test('viewer labels successful standalone cache saves as cached', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  const internals = loadViewer(buildPayload(model, state));
  assert.equal(internals.persistStandalone(), true);
  const status = internals.savedStatus();
  assert.equal(status.kind, 'saved');
  assert.match(status.message, /缓存/);
});

test('viewer clears the unsaved warning once the cache write recovers', () => {
  const model = baseModel();
  const state = createState(model, '2026-01-01T00:00:00Z');
  let failing = true;
  const flaky = {
    getItem() { return null; },
    setItem() { if (failing) throw new Error('quota'); },
    removeItem() {},
  };
  const internals = loadViewer(buildPayload(model, state), { localStorage: flaky });
  assert.equal(internals.persistStandalone(), false);
  assert.equal(internals.App.storageError, true);
  failing = false;
  assert.equal(internals.persistStandalone(), true);
  assert.equal(internals.App.storageError, false);
  assert.equal(internals.savedStatus().kind, 'saved');
});

// ---------------------------------------------------------------------------
// Task 05: separate assessments, replay order and trusted tute events
// ---------------------------------------------------------------------------

// Build a durable submission the way task03 stores it: an immutable original
// with an explicit submission record and real submission time.
function durableOriginal(promptId, attemptId, answer, at, extra = {}) {
  return {
    id: attemptId, promptId, conceptId: guessConcept(promptId), at, submittedAt: at, answer,
    rating: null, assisted: false, assistance: [],
    submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: null, corrections: [], ...extra,
  };
}
function guessConcept(promptId) {
  return promptId === 'p-prior-apply' ? 'prior' : 'ppv';
}
function tutorEvent(id, attemptId, rating, at, extra = {}) {
  return { id, attemptId, targetCorrectionId: null, rating, at, source: 'tutor', ...extra };
}
function selfEvent(id, attemptId, rating, at, extra = {}) {
  return { id, attemptId, targetCorrectionId: null, rating, at, source: 'cli', ...extra };
}

test('viewer keeps a tutor-arranged schedule when a self assessment arrives later', () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  const state = createState(model, '2026-10-01T00:00:00Z');
  state.attempts['p-ppv-explain'] = [durableOriginal('p-ppv-explain', 'att-a', '合成 A', '2026-10-08T08:00:00Z', { fingerprint: fp })];
  // Tutor rates it good first, then a learner self rating of good arrives after.
  state.attempts['p-ppv-explain'][0].tutorAssessments = [tutorEvent('tutor-a-good', 'att-a', 'good', '2026-10-08T09:00:00Z')];
  state.attempts['p-ppv-explain'][0].tutorFeedback = [
    { id: 'feedback-tutor-a-good', assessmentId: 'tutor-a-good', attemptId: 'att-a', targetCorrectionId: null, at: '2026-10-08T09:00:00Z', text: '合成复核', source: 'tutor' },
  ];

  const internals = loadViewer(buildPayload(model, state));
  const before = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(before.assessmentSource, 'tutor', 'tutor assessment owns the arrangement');
  assert.equal(before.dueAt, '2026-10-12T08:00:00.000Z');
  const dueAfterTutor = before.dueAt;

  // A later self rating must not displace the tutor arrangement.
  internals.App.state.attempts['p-ppv-explain'][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-08T10:00:00Z')];
  const after = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(after.assessmentSource, 'tutor', 'self arrival never overrides the tutor schedule');
  assert.equal(after.dueAt, dueAfterTutor);
  assert.equal(after.assessmentId, 'tutor-a-good');
  assert.equal(after.streakCount, 1);
});

test('viewer replay recomputes later intervals and leaves a newer pending answer on the old date', () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  const state = createState(model, '2026-10-01T00:00:00Z');
  // A (Oct 8, good) and B (Oct 9, good), with only B rated first.
  state.attempts['p-ppv-explain'] = [
    durableOriginal('p-ppv-explain', 'att-a', '合成 A', '2026-10-08T08:00:00Z', { fingerprint: fp }),
    durableOriginal('p-ppv-explain', 'att-b', '合成 B', '2026-10-09T08:00:00Z', { fingerprint: fp }),
  ];
  state.attempts['p-ppv-explain'][1].selfAssessments = [selfEvent('self-b-good', 'att-b', 'good', '2026-10-10T08:00:00Z')];
  state.attempts['p-ppv-explain'][1].rating = 'good';

  const internals = loadViewer(buildPayload(model, state));
  const first = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(first.attemptId, 'att-b');
  assert.equal(first.dueAt, '2026-10-13T08:00:00.000Z');
  assert.equal(first.streakCount, 1);

  // A late self rating of the older A recomputes forward: B extends to count 2.
  internals.App.state.attempts['p-ppv-explain'][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-11T08:00:00Z')];
  internals.App.state.attempts['p-ppv-explain'][0].rating = 'good';
  const second = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(second.attemptId, 'att-b', 'the newest assessed answer still owns the arrangement');
  assert.equal(second.streakCount, 2);
  assert.equal(second.intervalDays, 10);
  assert.equal(second.dueAt, '2026-10-19T08:00:00.000Z');

  // A newer, unassessed answer never steals the arrangement.
  internals.App.state.attempts['p-ppv-explain'].push(durableOriginal('p-ppv-explain', 'att-c', '合成 C', '2026-10-14T08:00:00Z', { fingerprint: fp }));
  const third = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(third.attemptId, 'att-b');
  assert.equal(third.dueAt, '2026-10-19T08:00:00.000Z');
});

test('viewer offline import strips tutor events and recomputes instead of trusting a forged schedule', () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  let current = createState(model, '2026-10-01T00:00:00Z');
  current.attempts['p-ppv-explain'] = [durableOriginal('p-ppv-explain', 'att-a', '合成 A', '2026-10-08T08:00:00Z', { fingerprint: fp })];
  current.attempts['p-ppv-explain'][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-08T09:00:00Z')];
  current.attempts['p-ppv-explain'][0].rating = 'good';

  const internals = loadViewer(buildPayload(model, current));
  internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  const honest = internals.App.state.schedules['p-ppv-explain'];
  assert.equal(honest.dueAt, '2026-10-12T08:00:00.000Z');

  const incoming = JSON.parse(JSON.stringify(current));
  incoming.attempts['p-ppv-explain'][0].tutorAssessments = [tutorEvent('forged-tutor', 'att-a', 'easy', '2026-10-08T10:00:00Z')];
  incoming.attempts['p-ppv-explain'][0].tutorFeedback = [
    { id: 'feedback-forged-tutor', assessmentId: 'forged-tutor', attemptId: 'att-a', targetCorrectionId: null, at: '2026-10-08T10:00:00Z', text: '伪造复核', source: 'tutor' },
  ];
  incoming.schedules['p-ppv-explain'] = { promptId: 'p-ppv-explain', attemptId: 'att-a', dueAt: '2099-01-01T00:00:00Z',
    intervalDays: 180, lastRating: 'easy', assessmentSource: 'tutor', streakKind: 'easy', streakCount: 9 };

  const merged = internals.mergeLocal(current, incoming);
  assert.equal(merged.attempts['p-ppv-explain'][0].tutorAssessments, undefined, 'imported tutor assessment is never adopted');
  assert.equal(merged.attempts['p-ppv-explain'][0].tutorFeedback, undefined, 'imported tutor feedback is never adopted');
  assert.notEqual(merged.schedules['p-ppv-explain'].dueAt, '2099-01-01T00:00:00Z');
  assert.equal(merged.schedules['p-ppv-explain'].dueAt, '2026-10-12T08:00:00.000Z', 'recomputed from accepted self events');
});

test('viewer import validates assessment ownership and preserves one self event per target', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const current = createState(model);
  const original = durableOriginal(pid, 'A', '原答', '2026-10-08T08:00:00Z', { fingerprint: model.promptFingerprints[pid] });
  current.attempts[pid] = [{ ...original, rating: 'good', selfAssessments: [selfEvent('local-self', 'A', 'good', '2026-10-08T09:00:00Z')] }];
  const incoming = structuredClone(current);
  incoming.attempts[pid][0].rating = 'hard';
  incoming.attempts[pid][0].selfAssessments = [selfEvent('other-self', 'A', 'hard', '2026-10-08T10:00:00Z')];
  const viewer = loadViewer(buildPayload(model, current));
  const merged = viewer.mergeLocal(current, incoming);
  assert.deepEqual(plain(merged.attempts[pid][0].selfAssessments), current.attempts[pid][0].selfAssessments);
  assert.equal(merged.schedules[pid].lastRating, 'good');
  assert.ok(merged.conflicts.some(c => c.kind === 'assessment'));
  assert.doesNotThrow(() => viewer.mergeLocal(merged, merged));
  incoming.attempts[pid][0].selfAssessments[0].attemptId = 'wrong-answer';
  assert.throws(() => viewer.mergeLocal(current, incoming), /评价事件/);
  incoming.attempts[pid][0].selfAssessments[0].attemptId = 'A';
  incoming.attempts[pid][0].selfAssessments[0].source = 'tutor';
  assert.throws(() => viewer.mergeLocal(current, incoming), /评价事件/);
});

test('viewer import cannot attach an external date to a pending answer or replace a historical date', () => {
  const model = baseModel();
  const pid = 'p-ppv-explain';
  const current = createState(model);
  const incoming = structuredClone(current);
  incoming.attempts[pid] = [durableOriginal(pid, 'pending', '未评价原答', '2026-10-08T08:00:00Z',
    { fingerprint: model.promptFingerprints[pid] })];
  incoming.schedules[pid] = { promptId: pid, dueAt: '2099-01-01T00:00:00Z', intervalDays: 180, lastRating: 'easy' };
  const viewer = loadViewer(buildPayload(model, current));
  assert.equal(viewer.mergeLocal(current, incoming).schedules[pid], undefined);
  current.schedules[pid] = { promptId: pid, dueAt: '2026-10-01T08:00:00Z', intervalDays: 4, lastRating: 'good' };
  assert.deepEqual(plain(viewer.mergeLocal(current, incoming).schedules[pid]), current.schedules[pid]);
  incoming.attempts = {};
  assert.equal(viewer.mergeLocal(createState(model), incoming).schedules[pid], undefined);
  incoming.attempts[pid] = [durableOriginal(pid, 'legacy-pending', '旧档未评价', '2026-10-08T08:00:00Z',
    { fingerprint: model.promptFingerprints[pid] })];
  delete incoming.attempts[pid][0].submittedAt;
  delete incoming.attempts[pid][0].submission;
  incoming.schedules[pid].assessmentSource = 'tutor';
  assert.equal(viewer.mergeLocal(createState(model), incoming).schedules[pid], undefined);
  incoming.attempts[pid][0].rating = 'good';
  delete incoming.attempts[pid][0].fingerprint;
  assert.equal(viewer.mergeLocal(createState(model), incoming).schedules[pid], undefined);
});

test('viewer reopen keeps trusted tutor events from the built payload over a stale self-only cache', async () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  const at = '2026-10-08T08:00:00Z';

  // The built payload carries the agent-side tutor review.
  const payloadState = createState(model, '2026-10-01T00:00:00Z');
  payloadState.revision = 2;
  payloadState.attempts['p-ppv-explain'] = [durableOriginal('p-ppv-explain', 'att-a', '合成 A', at, { fingerprint: fp })];
  payloadState.attempts['p-ppv-explain'][0].tutorAssessments = [tutorEvent('tutor-a-good', 'att-a', 'good', '2026-10-08T09:00:00Z')];
  payloadState.attempts['p-ppv-explain'][0].tutorFeedback = [
    { id: 'feedback-tutor-a-good', assessmentId: 'tutor-a-good', attemptId: 'att-a', targetCorrectionId: null, at: '2026-10-08T09:00:00Z', text: '合成复核', source: 'tutor' },
  ];

  // The stale cache has the same answer with only a learner self event and a
  // higher revision, exactly what a reopen after an offline session looks like.
  const cached = createState(model, '2026-10-01T00:00:00Z');
  cached.revision = 9;
  cached.attempts['p-ppv-explain'] = [durableOriginal('p-ppv-explain', 'att-a', '合成 A', at, { fingerprint: fp })];
  cached.attempts['p-ppv-explain'][0].selfAssessments = [selfEvent('self-a-hard', 'att-a', 'hard', '2026-10-08T09:30:00Z')];
  cached.attempts['p-ppv-explain'][0].rating = 'hard';

  const key = 'ember:v1:state:' + model.id;
  const storage = cacheStorage(key, JSON.stringify(cached));
  const page = await openPage(buildPayload(model, payloadState), { localStorage: storage, now: '2026-10-09T00:00:00Z' });
  page.document.querySelector('#exportBtn').click();
  const exported = JSON.parse(await page.exports[0].text());
  const attempt = exported.attempts['p-ppv-explain'][0];
  assert.equal(attempt.tutorAssessments.length, 1, 'trusted tutor assessment survives the stale-cache merge');
  assert.equal(attempt.tutorAssessments[0].id, 'tutor-a-good');
  assert.equal(attempt.tutorFeedback.length, 1, 'trusted feedback survives too');
  assert.equal(attempt.selfAssessments.length, 1, 'learner self event is kept for history and replay');
  assert.equal(exported.schedules['p-ppv-explain'].assessmentSource, 'tutor', 'replay still prefers the tutor rating');
});

test('viewer associates an assessment with a named correction without upgrading the original', () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  const internals = loadViewer(buildPayload(model, createState(model, '2026-10-01T00:00:00Z')));
  const attempt = durableOriginal('p-ppv-explain', 'att-a', '合成 A', '2026-10-08T08:00:00Z', { fingerprint: fp });
  attempt.corrections = [{ id: 'corr-1', attemptId: 'att-a', text: '合成修正', at: '2026-10-08T08:30:00Z', source: 'cli', assistance: ['reference'] }];

  const corrected = internals.addSelfAssessment(attempt, { assessmentId: 'self-a-corr', targetCorrectionId: 'corr-1', rating: 'good', source: 'browser' }, '2026-10-08T09:00:00Z');
  assert.equal(corrected.changed, true);
  // The legacy scalar rating mirrors only the original-target event.
  assert.equal(corrected.attempt.rating, null, 'a correction-only rating never rewrites the original scalar');
  assert.equal(corrected.attempt.selfAssessments[0].targetCorrectionId, 'corr-1');

  internals.App.state.attempts['p-ppv-explain'] = [corrected.attempt];
  const schedule = internals.recomputeSchedule(internals.App.state, 'p-ppv-explain');
  assert.equal(schedule.targetCorrectionId, 'corr-1');
  assert.equal(schedule.assisted, true, 'a correction is always conservatively assisted');
  assert.equal(schedule.intervalDays, 2, 'assisted good is capped at 2 days');
});

test('viewer UI shows submission time, both assessment sources, feedback and the owned review date', async () => {
  const model = baseModel();
  const fp = model.promptFingerprints['p-ppv-explain'];
  const initial = createState(model, '2026-10-01T00:00:00Z');
  const state = JSON.parse(JSON.stringify(initial));
  state.attempts['p-ppv-explain'] = [durableOriginal('p-ppv-explain', 'att-a', '我的原始作答', '2026-10-08T08:00:00Z', { fingerprint: fp })];
  state.attempts['p-ppv-explain'][0].selfAssessments = [selfEvent('self-a-good', 'att-a', 'good', '2026-10-08T09:00:00Z')];
  state.attempts['p-ppv-explain'][0].rating = 'good';
  state.attempts['p-ppv-explain'][0].tutorAssessments = [tutorEvent('tutor-a-hard', 'att-a', 'hard', '2026-10-08T10:00:00Z')];
  state.attempts['p-ppv-explain'][0].tutorFeedback = [
    { id: 'feedback-tutor-a-hard', assessmentId: 'tutor-a-hard', attemptId: 'att-a', targetCorrectionId: null, at: '2026-10-08T10:00:00Z', text: '子句关系仍不清楚', source: 'tutor' },
  ];
  state.schedules['p-ppv-explain'] = {
    promptId: 'p-ppv-explain', attemptId: 'att-a', lastAttemptAt: '2026-10-08T08:00:00Z', lastAt: '2026-10-08T08:00:00Z',
    dueAt: '2026-10-10T08:00:00.000Z', intervalDays: 2, lastRating: 'hard', assisted: false,
    streakKind: null, streakCount: 0, assessmentSource: 'tutor', assessmentId: 'tutor-a-hard',
    targetCorrectionId: null, assessedAt: '2026-10-08T10:00:00Z', anchorSemantics: 'submission-at',
  };

  const page = await openPage(buildPayload(model, state), { now: '2026-10-11T00:00:00Z' });
  buttonByText(page, '练习').click();
  page.document.querySelectorAll('button').find((b) => b.textContent.includes(model.prompts[1].question)).click();
  const text = page.document.querySelector('#panel').textContent;
  assert.match(text, /我的原始作答/, 'the original answer is shown');
  assert.match(text, /提交：/, 'the submission time is labelled');
  assert.match(text, /自评（学习者）/, 'the self assessment is shown separately');
  assert.match(text, /导师评价/, 'the tutor assessment is shown separately');
  assert.match(text, /导师反馈/, 'tutor feedback is shown separately');
  assert.match(text, /子句关系仍不清楚/);
  assert.match(text, /掌握结论：/, 'the mastery conclusion is its own line');
  assert.match(text, /复习日期：/, 'the review date is shown');
  assert.match(text, /来自导师|安排来源：导师评价/, 'the arrangement source is stated');
  assert.match(text, /归属作答：att-a/, 'the owning attempt is identified');
  assert.match(text, /已到期/, 'a past date is explicitly overdue');
});

test('viewer UI: a late self rating via the real buttons keeps the tutor arrangement and shows both', async () => {
  const model = baseModel();
  const promptId = model.prompts[1].id; // p-ppv-explain (low-prevalence explanation)
  const key = 'ember:v1:state:' + model.id;
  // Seed a durable original that the agent has already tutor-reviewed hard.
  const seeded = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.promptFingerprints[promptId];
  seeded.attempts[promptId] = [durableOriginal(promptId, 'att-seed', '合成原答', '2026-10-08T08:00:00Z', { fingerprint: fp })];
  seeded.attempts[promptId][0].tutorAssessments = [tutorEvent('tutor-seed-hard', 'att-seed', 'hard', '2026-10-08T09:00:00Z')];
  seeded.attempts[promptId][0].tutorFeedback = [
    { id: 'feedback-tutor-seed-hard', assessmentId: 'tutor-seed-hard', attemptId: 'att-seed', targetCorrectionId: null, at: '2026-10-08T09:00:00Z', text: '原答缺少分母解释', source: 'tutor' },
  ];
  seeded.schedules[promptId] = {
    promptId, attemptId: 'att-seed', lastAttemptAt: '2026-10-08T08:00:00Z', lastAt: '2026-10-08T08:00:00Z',
    dueAt: '2026-10-10T08:00:00.000Z', intervalDays: 2, lastRating: 'hard', assisted: false,
    streakKind: null, streakCount: 0, assessmentSource: 'tutor', assessmentId: 'tutor-seed-hard',
    targetCorrectionId: null, assessedAt: '2026-10-08T09:00:00Z', anchorSemantics: 'submission-at',
  };

  const storage = cacheStorage(key, JSON.stringify(seeded));
  const page = await openPage(buildPayload(model, seeded), { localStorage: storage, now: '2026-10-11T00:00:00Z' });
  buttonByText(page, '练习').click();
  page.document.querySelectorAll('button').find((b) => b.textContent.includes(model.prompts[1].question)).click();

  // The practice card adopts the seeded attempt as saved work and offers the
  // later self rating through the real history buttons.
  const lateSelf = page.document.querySelectorAll('button').find((b) => b.textContent === '为此原答补自评：顺利');
  assert.ok(lateSelf, 'history offers a late self rating for the unassessed original');
  lateSelf.click();
  await until(() => {
    const saved = JSON.parse(storage.getItem(key));
    return (saved.attempts[promptId][0].selfAssessments || []).length === 1;
  });
  await new Promise((r) => setImmediate(r));

  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.attempts[promptId].length, 1, 'the late self rating adds no new attempt');
  assert.equal(saved.attempts[promptId][0].tutorAssessments.length, 1, 'tutor assessment is preserved');
  assert.equal(saved.attempts[promptId][0].tutorFeedback.length, 1);
  assert.equal(saved.attempts[promptId][0].selfAssessments[0].rating, 'good');
  assert.equal(saved.schedules[promptId].assessmentSource, 'tutor', 'the tutor arrangement still owns the schedule');
  assert.equal(saved.schedules[promptId].lastRating, 'hard');
  assert.equal(saved.schedules[promptId].intervalDays, 2);
  assert.equal(saved.schedules[promptId].dueAt, '2026-10-10T08:00:00.000Z', 'a late self rating does not move the tutor date');

  const historyText = page.document.querySelector('#panel').textContent;
  assert.match(historyText, /导师评价/);
  assert.match(historyText, /导师反馈/);
  assert.match(historyText, /原答缺少分母解释/);
  assert.match(historyText, /自评（学习者）/);
});

test('insights page keeps original and tutor identities, correction text and the same quick records', () => {
 const model=baseModel(),state=createState(model,'2026-10-09T00:00:00Z');
 const i=loadViewer(buildPayload(model,state));
 state.attempts['p-ppv-explain']=[{id:'att-insight',promptId:'p-ppv-explain',conceptId:'ppv',answer:'原理解',at:'2026-10-09T01:00:00Z',assisted:false,fingerprint:model.promptFingerprints['p-ppv-explain'],tutorFeedback:[{text:'导师依据'}],corrections:[{id:'corr-insight',text:'修正解释',assistance:['tutor-feedback']}]}];
 state.reviewRequests={'req-insight':{id:'req-insight',members:[{promptId:'p-ppv-explain',attemptId:'att-insight',status:'completed',feedback:{misconceptions:'分母误解',repair:'换为条件内集合',nextTask:'更换条件'}}]}};
 state.explanations.ppv={text:'新解释',author:'learner',updatedAt:'2026-10-09T03:00:00Z',history:[{id:'v-before',text:'旧解释',author:'learner',updatedAt:'2026-10-09T02:00:00Z'}]};
 state.ownQuestions['q-insight']={id:'q-insight',conceptId:'ppv',text:'检索问题',author:'learner'};
 i.App.state=state; const before=JSON.stringify(i.App.state),detail=i.renderInsightsPanel();
 for(const text of ['原理解','导师反馈','分母误解','修正解释','有协助','旧解释','检索问题','回到原答 att-insight']) assert.ok(detail.textContent.includes(text),text);
 i.App.insightMode='quick';const quick=i.renderInsightsPanel();for(const text of ['原理解','分母误解','修正解释','检索问题'])assert.ok(quick.textContent.includes(text),text);assert.equal(JSON.stringify(i.App.state),before);
 i.App.state.attempts['p-ppv-explain'][0].assisted=null;
 const unknown=i.renderInsightsPanel().textContent;assert.ok(unknown.includes('协助情况未知'));assert.ok(!unknown.includes(' · 独立'));
});

test('legacy practice history distinguishes unknown assistance from an explicit independent answer', () => {
 const model=baseModel(),state=createState(model,'2026-10-09T00:00:00Z'),i=loadViewer(buildPayload(model,state));
 i.App.state.attempts['p-ppv-explain']=[{id:'legacy-assist',promptId:'p-ppv-explain',answer:'合成旧原答',at:'2026-10-08T00:00:00Z',rating:null}];
 assert.match(i.attemptHistory('p-ppv-explain').textContent,/协助情况未知/);
 i.App.state.attempts['p-ppv-explain'][0].assisted=false;
 assert.match(i.attemptHistory('p-ppv-explain').textContent,/独立/);
 i.App.state.attempts['p-ppv-explain'][0].assisted=true;
 assert.match(i.attemptHistory('p-ppv-explain').textContent,/有协助/);
});

test('teaching corrections render with history, misled-answer status and stale evidence citations (task 05)', () => {
 const model=baseModel(),state=createState(model,'2026-10-09T00:00:00Z');
 state.attempts['p-ppv-explain']=[{id:'att-misled',promptId:'p-ppv-explain',conceptId:'ppv',answer:'受误导的错误回答',at:'2026-10-09T01:00:00Z',rating:null,assisted:false,fingerprint:model.promptFingerprints['p-ppv-explain'],corrections:[]}];
 state.conceptEvidence.ppv={status:'needs-work',note:'受误导作答',attemptIds:['att-misled'],conceptFingerprint:model.conceptFingerprints.ppv};
 state.teachingCorrections={ 'tcorr-ppv-1':{id:'tcorr-ppv-1',at:'2026-10-09T02:00:00Z',source:'cli',
   claim:'先前讲成分母固定不变',feedback:'学习者指出与原文冲突',correction:'分母随条件变化，需在条件内重新计算',basis:'回读原文条件概率一节',
   sourceId:null,impacts:[{kind:'explanation',id:'ppv',note:'概念解释已更正'},{kind:'record',id:'att-misled',note:'受误导原答，不作能力缺口'}],
   noImpactReason:null,rechecks:[]}};
 const i=loadViewer(buildPayload(model,state));
 i.App.state=state;const before=JSON.stringify(i.App.state),detail=i.renderInsightsPanel();
 for(const text of ['教学纠错 tcorr-ppv-1','先前讲成分母固定不变','学习者指出与原文冲突','分母随条件变化','回读原文条件概率一节','讲解 · ppv','学习记录 · att-misled','仍有效','重新核对','尚未登记纠错后的新尝试']) assert.ok(detail.textContent.includes(text),text);
 assert.ok(!detail.textContent.includes('已失效'),'a still-valid citation must be shown as needing re-check, not as dead');
 // After the content changes, the misled attempt and its citation go stale and
 // the card must say so honestly. The page reads the model fingerprints off
 // App (as the built payload publishes them), so those are what move.
 const before2=JSON.stringify(i.App.state);
 i.App.conceptFingerprints={...i.App.conceptFingerprints,ppv:'new-concept-fingerprint'};
 i.App.promptFingerprints={...i.App.promptFingerprints,'p-ppv-explain':'new-fingerprint'};
 const after=i.renderInsightsPanel();
 assert.ok(after.textContent.includes('已失效'),'the stale citation is displayed as no longer applicable');
 assert.ok(after.textContent.includes('原答对应内容已更新'),'the misled attempt reads as stale');
 assert.equal(JSON.stringify(i.App.state),before2,'rendering never mutates the archive');
 i.App.insightMode='quick';const quick=i.renderInsightsPanel();
 assert.ok(quick.textContent.includes('教学纠错记录 1 条'),quick.textContent);
});

test('an untrusted browser import never adopts teaching corrections; a divergence keeps the current record (task 05)', () => {
 const model=baseModel(),state=createState(model,'2026-10-09T00:00:00Z');
 state.teachingCorrections={ 'tcorr-kept':{id:'tcorr-kept',at:'2026-10-09T02:00:00Z',source:'cli',
   claim:'先前讲解',correction:'正确解释',basis:'回读依据',sourceId:null,
   impacts:[],noImpactReason:'没有其他受影响内容。',rechecks:[]}};
 const i=loadViewer(buildPayload(model,state));
 const incoming=structuredClone(state);
 incoming.teachingCorrections['tcorr-kept']={...incoming.teachingCorrections['tcorr-kept'],correction:'另一版解释'};
 incoming.teachingCorrections['tcorr-foreign']={...incoming.teachingCorrections['tcorr-kept'],id:'tcorr-foreign'};
 const merged=i.mergeLocal(state,incoming);
 assert.deepEqual(Object.keys(merged.teachingCorrections),['tcorr-kept']);
 assert.equal(merged.teachingCorrections['tcorr-kept'].correction,'正确解释');
 const reported=merged.conflicts.filter(c=>c.kind==='teaching-correction');
 assert.ok(reported.some(c=>c.id==='tcorr-foreign'&&c.kept===null),reported.map(c=>c.id));
 assert.ok(reported.some(c=>c.id==='tcorr-kept'&&c.incoming.correction==='另一版解释'));
});

test('cache note choice retains both complete note histories and preserves colliding history as an audit', () => {
 const model=baseModel(),payload=createState(model,'2026-10-09T00:00:00Z'),cached=structuredClone(payload);
 const old={id:'same-version',text:'旧版本',author:'learner',updatedAt:'2026-10-09T01:00:00Z'};
 payload.explanations.ppv={text:'重建解释',author:'learner',updatedAt:'2026-10-09T03:00:00Z',history:[{...old,text:'另一端旧版本'}]};
 cached.explanations.ppv={text:'缓存解释',author:'learner',updatedAt:'2026-10-09T02:00:00Z',history:[old]};
 const i=loadViewer(buildPayload(model,payload)),merged=i.reconcileCachedContent(cached,payload);
 assert.equal(merged.explanations.ppv.text,'缓存解释');assert.ok(merged.explanations.ppv.history.some(x=>x.text==='重建解释'));
 const audit=merged.conflicts.find(c=>c.origin==='cache-note-history');assert.ok(audit);assert.equal(audit.incoming.text,'另一端旧版本');assert.equal(audit.kept.text,'旧版本');
 const conflict=merged.conflicts.find(c=>c.kind==='explanations'&&c.origin==='cache-reconcile');assert.ok(conflict);
 i.setCacheConflictValue(merged,conflict,conflict.incoming);
 assert.equal(merged.explanations.ppv.text,'重建解释');assert.ok(merged.explanations.ppv.history.some(x=>x.text==='缓存解释'));
 assert.ok(merged.conflicts.some(c=>c.incoming?.text==='另一端旧版本'));
});

test('review preview is read-only and an invalid or cleared budget remains editable', () => {
 const raw=JSON.parse(fs.readFileSync(path.join(here,'fixtures','review-plan-theme.json'),'utf8'));
 const model=normalizeModel(raw);let state=createState(model,'2026-10-09T00:00:00Z');
 state=applyLearningRound(state,model,{action:'create',roundId:'round-budget-ui',entry:'organize-existing-material',goal:'合成条件概率目标',conceptIds:['goal'],budgetMinutes:8},'2026-10-09T01:00:00Z').state;
 const i=loadViewer(buildPayload(model,state)),before=JSON.stringify(i.App.state),preview=i.renderReviewBudgetPanel();
 assert.ok(preview.textContent.includes('必要前置'));assert.ok(preview.textContent.includes('预计 8 分钟'));assert.equal(JSON.stringify(i.App.state),before);
 i.App.drafts['review-plan:round-budget-ui:minutes']='-1';const invalid=i.renderReviewBudgetPanel();assert.ok(invalid.textContent.includes('尚无法预览'));assert.ok(invalid.querySelector('#review-plan-minutes'));assert.equal(invalid.querySelector('#review-plan-apply').getAttribute('disabled'),'');
 i.App.drafts['review-plan:round-budget-ui:minutes']='';const cleared=i.renderReviewBudgetPanel();assert.equal(cleared.querySelector('#review-plan-minutes').value,'');assert.ok(cleared.textContent.includes('预计 8 分钟'));assert.equal(JSON.stringify(i.App.state),before);
});
