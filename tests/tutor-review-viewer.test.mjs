// Task-06 concentrated-round-review viewer regressions.
//
// These load the real assets/viewer.html script under a minimal DOM shim with
// the same three library injections the builder performs (round, schedule and
// tutor-review) so the page runs the exact shared pure functions the Node
// backend imports. They cover the UI contract of ticket 06: the round identity /
// pending counts / back-to-session guide, the two-count split (unclaimed new
// answers vs unresolved request members), per-member feedback rendering, the
// stale-content note, and the two guardrails the page must never cross — a
// browser import cannot inject a review request, and a correction-target
// assessment cannot promote the original answer to independent evidence.
//
// Run: node --test tests/tutor-review-viewer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import { applyLearningRound, applySubmission, createState } from '../skill/forge/scripts/lib/state.mjs';
import { startReviewRequest, tutorReviewSummary, validateReviewRequests } from '../skill/forge/scripts/lib/tutor-review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const viewerPath = path.join(root, 'skill', 'forge', 'assets', 'viewer.html');
const stripExports = (source) => source.replace(/^export /gm, '');
const lib = (name) => stripExports(fs.readFileSync(path.join(root, 'skill', 'forge', 'scripts', 'lib', name), 'utf8'));
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

// The page measures text through a 2d canvas context at load time; a minimal
// stub is enough for the pure-logic assertions these tests make.
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext() {
      return {
        font: '', fillStyle: '',
        setTransform() {}, clearRect() {}, fillRect() {},
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
  hasAttribute(key) { return this.attributes.has(key); }
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
  select() {}
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

function baseModel() {
  return normalizeModel({
    schemaVersion: 1,
    id: 'probability-tutor-review-test',
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
    console,
    document: documentShim,
    location: { protocol: 'file:' },
    localStorage: options.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: options.fetch || (async () => ({ ok: false })),
    requestAnimationFrame(cb) { return cb(); },
    setTimeout,
    clearTimeout,
    TextEncoder,
    crypto: globalThis.crypto,
    URL: { createObjectURL() { return 'blob:viewer-test'; }, revokeObjectURL() {} },
    Node: ShimNode,
    Blob,
    navigator: {},
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

// Build one real submission bound to a real round task, exactly as the durable
// path stores it, so the shared summary sees a genuine pending answer.
function roundWithSubmission(model, { answer = '合成原答', at = '2026-10-08T08:00:00Z' } = {}) {
  let state = createState(model, '2026-10-01T00:00:00Z');
  state = applyLearningRound(state, model, {
    action: 'create', roundId: 'round-a', goal: '理解先验', conceptIds: ['prior'], entry: 'organize-existing-material',
  }, '2026-10-07T00:00:00Z').state;
  const task = state.learningRounds['round-a'].tasks.find((t) => !t.diagnostic);
  state = applySubmission(state, model, {
    promptId: task.promptId, attemptId: 'att-a', answer, roundId: 'round-a', taskId: task.id, source: 'cli',
  }, at).state;
  return state;
}

// An unbound (no learning round) durable submission, the shape a history review
// request selects via `--history --attempt`.
// A later time keeps it valid alongside any round submission for the same
// prompt (a submission cannot predate an existing answer for that prompt).
function withHistorySubmission(model, state, { answer = '历史合成原答', attemptId = 'att-h', at = '2026-10-09T08:00:00Z', corrections } = {}) {
  const promptId = model.prompts[0].id;
  let next = applySubmission(state, model, { promptId, attemptId, answer, source: 'cli' }, at).state;
  if (corrections) {
    const attempt = next.attempts[promptId].find((a) => a.id === attemptId);
    attempt.corrections = corrections(attemptId);
  }
  return next;
}

function fingerprintsOf(model) {
  return {
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: model.promptFingerprints,
    conceptFingerprints: model.conceptFingerprints,
  };
}

// Build a genuine frozen request through the shared public function, so its
// members carry the real snapshot + fingerprints and satisfy the same validator
// the page and backend both run.
function withFrozenRequest(model, state, requestId = 'rev-1') {
  return startReviewRequest(state, modelToJson(model), { requestId, roundId: 'round-a' }, '2026-10-08T09:00:00Z', fingerprintsOf(model)).state;
}

// Freeze an unbound-history request through the same shared public function.
function withFrozenHistoryRequest(model, state, attemptIds, requestId = 'rev-h') {
  return startReviewRequest(state, modelToJson(model), { requestId, history: true, attemptIds }, '2026-10-08T09:00:00Z', fingerprintsOf(model)).state;
}

function frozenRequestOf(state, requestId = 'rev-1') {
  return state.reviewRequests[requestId];
}

// Mutate the frozen request in place the way a completed review would look,
// keeping the frozen snapshot intact so the validator still accepts it.
function completeMember(state, requestId, memberIndex, feedback, at = '2026-10-08T10:00:00Z') {
  const member = state.reviewRequests[requestId].members[memberIndex];
  member.status = 'completed';
  member.reason = null;
  member.feedback = feedback;
  member.resolvedAt = at;
  state.reviewRequests[requestId].status = 'completed';
}

function failMember(state, requestId, memberIndex, status, reason, at = '2026-10-08T10:00:00Z') {
  const member = state.reviewRequests[requestId].members[memberIndex];
  member.status = status;
  member.reason = reason;
  member.feedback = null;
  member.resolvedAt = at;
  state.reviewRequests[requestId].status = 'partial';
}

function completedFeedback() {
  return {
    correct: '真阳性计算正确', misconceptions: '未说明假阳性占比', basis: '按判定标准核对分母',
    repair: '补上分母里的假阳性', nextTask: '换一个患病率再算', rating: 'hard', targetCorrectionId: null,
  };
}

// ---------------------------------------------------------------------------

test('viewer review section shows round identity, split pending counts and the request guide', () => {
  const model = baseModel();
  const state = roundWithSubmission(model);
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const section = internals.renderRoundReviewSection(state.learningRounds['round-a']);
  const text = section.textContent;
  assert.match(text, /轮次复核身份：round-a/, 'the frozen round id is shown');
  assert.match(text, /本轮待复核合计：1 项/, 'the round total awaiting review is shown');
  assert.match(text, /尚未纳入请求的新作答 1 项/, 'answers not yet in a request are named');
  assert.match(text, /已有请求里还没完成的 0 项/, 'unresolved request members are shown separately');

  // The copyable request text must let a first-time learner actually create the
  // request: it names review-start with the round id, not just a read of an id
  // that may not exist yet.
  const area = section.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label'));
  assert.ok(area, 'a copyable request textarea is rendered');
  assert.match(area.value, /review-start/, 'the request text shows how to create the fixed scope');
  assert.match(area.value, /--round-id round-a/, 'the request text binds the real round id');
  assert.match(area.value, /review-item/, 'the request text shows the per-item write step');
});

test('viewer review section keeps an unresolved request visible after a new answer starts', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  // The request froze the answer, so it is no longer "unclaimed": pendingCount
  // drops to 0 while openPendingCount stays 1. The UI must not read as 0 to do.
  state = withFrozenRequest(model, state);
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderRoundReviewSection(state.learningRounds['round-a']).textContent;
  assert.match(text, /本轮待复核合计：1 项/, 'the total includes the still-open request member');
  assert.match(text, /尚未纳入请求的新作答 0 项/, 'no new request-external answers remain');
  assert.match(text, /已有请求里还没完成的 1 项/, 'the open request member keeps the work visible');
});

test('viewer review section renders per-item original answer, five feedback fields and tutor rating', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  state = withFrozenRequest(model, state);
  completeMember(state, 'rev-1', 0, completedFeedback());
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const section = internals.renderRoundReviewSection(state.learningRounds['round-a']);
  const text = section.textContent;
  assert.match(text, /原答：合成原答/, 'the frozen original answer is shown');
  assert.match(text, /正确部分：真阳性计算正确/);
  assert.match(text, /具体误解：未说明假阳性占比/);
  assert.match(text, /核对依据：按判定标准核对分母/);
  assert.match(text, /必要修补：补上分母里的假阳性/);
  assert.match(text, /后续任务：换一个患病率再算/);
  assert.match(text, /导师评价：困难（针对原答）/, 'the tutor rating and its target are shown');
  assert.match(text, /完成 1\/1 · 剩余 0/, 'request completion is shown');
});

test('viewer review section reports a retained failure reason and completed-but-stale history', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  state = withFrozenRequest(model, state);
  failMember(state, 'rev-1', 0, 'missing-basis', '该自创问题没有参考或判定标准，需要先补充可核对材料');
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderRoundReviewSection(state.learningRounds['round-a']).textContent;
  assert.match(text, /缺依据·待处理/, 'a failure status keeps pending-review wording');
  assert.match(text, /保留原因：该自创问题没有参考或判定标准/, 'the explicit reason is shown');
});

test('viewer review section shows a completed member as stale history after the content changed', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  state = withFrozenRequest(model, state);
  completeMember(state, 'rev-1', 0, completedFeedback());
  // Rebuild the model with edited prompt content: the frozen member no longer
  // matches the live content fingerprint, so it must read as stale history.
  const changed = normalizeModel({
    ...modelToJson(model),
    prompts: modelToJson(model).prompts.map((p) => (p.id === 'p-prior-apply' ? { ...p, question: '改过的题干？' } : p)),
  });
  const internals = loadViewer(buildPayload(changed, state));
  internals.App.state = state;
  const text = internals.renderRoundReviewSection(state.learningRounds['round-a']).textContent;
  assert.match(text, /冻结内容已过时/, 'a completed member whose content changed is shown as stale history');
  assert.match(text, /正确部分：真阳性计算正确/, 'the historical feedback is still readable');
});

test('viewer review section prefers the shared summary when the library is present', () => {
  const model = baseModel();
  const state = roundWithSubmission(model);
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  // The page delegates to the shared pure function, so its own summary must
  // equal the backend summary for the same archive and fingerprints.
  const pageSummary = internals.tutorReviewSummaryLocal('round-a');
  const backendSummary = tutorReviewSummary(state, { roundId: 'round-a', model: modelToJson(model) }, {
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: model.promptFingerprints,
    conceptFingerprints: model.conceptFingerprints,
  });
  assert.equal(pageSummary.pendingCount, backendSummary.pendingCount);
  assert.equal(pageSummary.openPendingCount, backendSummary.openPendingCount);
});

// ---------------------------------------------------------------------------
// Injection / evidence guardrails
// ---------------------------------------------------------------------------

test('viewer import cannot adopt a new review request but reports it', () => {
  const model = baseModel();
  const current = createState(model);
  const internals = loadViewer(buildPayload(model, current));
  // A hand-built request that never went through the agent-side start path.
  const forged = roundWithSubmission(model);
  forged.reviewRequests = withFrozenRequest(model, roundWithSubmission(model), 'rev-injected').reviewRequests;
  const merged = internals.mergeLocal(current, forged);
  assert.deepEqual(Object.keys(merged.reviewRequests || {}), [], 'a browser import cannot inject a review request');
  assert.ok(merged.conflicts.some((c) => c.kind === 'review-request' && c.id === 'rev-injected'),
    'the injected request is reported instead of adopted');
});

test('viewer standalone reopen does not promote a cached-only review request across a rebuild', () => {
  const model = baseModel();
  const payloadState = roundWithSubmission(model); // trusted payload: no request
  const cached = withFrozenRequest(model, JSON.parse(JSON.stringify(payloadState)), 'rev-cache');
  completeMember(cached, 'rev-cache', 0, completedFeedback());
  const storage = {
    entries: new Map([['ember:v1:state:' + model.id, JSON.stringify(cached)]]),
    getItem(name) { return this.entries.get(name) ?? null; },
    setItem(name, value) { this.entries.set(name, value); },
    removeItem(name) { this.entries.delete(name); },
  };
  const internals = loadViewer(buildPayload(model, payloadState), { localStorage: storage });
  internals.afterStandaloneLoad();
  assert.deepEqual(Object.keys(internals.App.state.reviewRequests || {}), [],
    'a cached-only review request cannot survive a rebuild as trusted state');
});

test('viewer rejects a malformed reviewRequests bucket with the shared validator', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model)));
  const bad = { ...createState(model), reviewRequests: { 'rev-bad': { id: 'rev-bad', scope: 'round', roundId: 'round-a' } } };
  assert.throws(() => internals.ensureState(bad), /内容快照|复核请求|reviewRequests/,
    'a present-but-malformed reviewRequests bucket is rejected');
  // A request that cites an attempt the archive does not contain is refused too.
  const orphaned = roundWithSubmission(model);
  orphaned.reviewRequests = withFrozenRequest(model, roundWithSubmission(model)).reviewRequests;
  delete orphaned.attempts['p-prior-apply'];
  assert.throws(() => internals.ensureState(orphaned), /作答不存在|损坏的快照/);
  // A legacy archive without the field still loads.
  const legacy = createState(model);
  delete legacy.reviewRequests;
  assert.doesNotThrow(() => internals.ensureState(legacy), 'a legacy archive omitting reviewRequests still loads');
});

test('viewer evidence independence refuses a good-rated correction as proof for the failed original', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.promptFingerprints['p-prior-apply'];
  state.attempts['p-prior-apply'] = [{
    id: 'att-orig', promptId: 'p-prior-apply', conceptId: 'prior', at: '2026-10-08T08:00:00Z',
    submittedAt: '2026-10-08T08:00:00Z', answer: '合成错误原答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: fp, corrections: [{
      id: 'corr-1', attemptId: 'att-orig', text: '合成修正', at: '2026-10-08T09:00:00Z',
      source: 'cli', assistance: [],
    }],
  }];
  // A tutor assessment targets the *correction*, not the original.
  state.attempts['p-prior-apply'][0].tutorAssessments = [{
    id: 'tutor-corr', attemptId: 'att-orig', targetCorrectionId: 'corr-1', rating: 'good',
    at: '2026-10-08T10:00:00Z', source: 'tutor',
  }];
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  assert.equal(internals.isIndependentForEvidence(state.attempts['p-prior-apply'][0]), false,
    'a correction-target assessment is not independent proof for the original');
  // The prompt evidence rule must therefore reject `applied` on that attempt.
  assert.equal(internals.evidenceRuleSatisfied('applied', [state.attempts['p-prior-apply'][0]]), false,
    'a corrected original cannot satisfy an applied-level evidence rule');
});

test('viewer evidence independence still accepts an original reviewed directly', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.promptFingerprints['p-prior-apply'];
  state.attempts['p-prior-apply'] = [{
    id: 'att-orig', promptId: 'p-prior-apply', conceptId: 'prior', at: '2026-10-08T08:00:00Z',
    submittedAt: '2026-10-08T08:00:00Z', answer: '合成独立原答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: fp, corrections: [],
  }];
  state.attempts['p-prior-apply'][0].tutorAssessments = [{
    id: 'tutor-orig', attemptId: 'att-orig', targetCorrectionId: null, rating: 'good',
    at: '2026-10-08T10:00:00Z', source: 'tutor',
  }];
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  assert.equal(internals.isIndependentForEvidence(state.attempts['p-prior-apply'][0]), true,
    'an original reviewed directly stays independent');
  assert.equal(internals.evidenceRuleSatisfied('applied', [state.attempts['p-prior-apply'][0]]), true);
});

test('viewer evidence independence strips an original the tutor currently judged as again', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.promptFingerprints['p-prior-apply'];
  state.attempts['p-prior-apply'] = [{
    id: 'att-orig', promptId: 'p-prior-apply', conceptId: 'prior', at: '2026-10-08T08:00:00Z',
    submittedAt: '2026-10-08T08:00:00Z', answer: '合成原答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: fp, corrections: [],
    // The tutor rated the original well first, then re-rated the same original
    // as `again`; the current judgement is that it failed. `hard` would not
    // strip independence, but `again` does.
    tutorAssessments: [
      { id: 'tutor-orig-good', attemptId: 'att-orig', targetCorrectionId: null, rating: 'good', at: '2026-10-08T09:00:00Z', source: 'tutor' },
      { id: 'tutor-orig-again', attemptId: 'att-orig', targetCorrectionId: null, rating: 'again', at: '2026-10-08T10:00:00Z', source: 'tutor' },
    ],
  }];
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  assert.equal(internals.isIndependentForEvidence(state.attempts['p-prior-apply'][0]), false,
    'the currently effective again judgement strips independence');
  assert.equal(internals.evidenceRuleSatisfied('applied', [state.attempts['p-prior-apply'][0]]), false);
});

test('viewer evidence independence is restored by a later good re-rating of the original', () => {
  const model = baseModel();
  const state = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.promptFingerprints['p-prior-apply'];
  state.attempts['p-prior-apply'] = [{
    id: 'att-orig', promptId: 'p-prior-apply', conceptId: 'prior', at: '2026-10-08T08:00:00Z',
    submittedAt: '2026-10-08T08:00:00Z', answer: '合成原答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: fp, corrections: [],
    tutorAssessments: [
      { id: 'tutor-orig-again', attemptId: 'att-orig', targetCorrectionId: null, rating: 'again', at: '2026-10-08T09:00:00Z', source: 'tutor' },
      { id: 'tutor-orig-good', attemptId: 'att-orig', targetCorrectionId: null, rating: 'good', at: '2026-10-08T10:00:00Z', source: 'tutor' },
    ],
  }];
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  assert.equal(internals.isIndependentForEvidence(state.attempts['p-prior-apply'][0]), true,
    'a later explicit good re-rating of the original restores independence');
});

test('the shared validator accepts the archive the page builds and rejects a bad status', () => {
  const model = baseModel();
  const state = withFrozenRequest(model, roundWithSubmission(model));
  assert.doesNotThrow(() => validateReviewRequests(state, { state }));
  const bad = JSON.parse(JSON.stringify(state));
  bad.reviewRequests['rev-1'].members[0].status = 'nonsense';
  assert.throws(() => validateReviewRequests(bad, { state: bad }), /status 不合法/);
});

// ---------------------------------------------------------------------------
// History scope (no active round) and the shared renderer
// ---------------------------------------------------------------------------

test('viewer renders nothing for the history scope when there is no history work', () => {
  const model = baseModel();
  const internals = loadViewer(buildPayload(model, createState(model)));
  assert.equal(internals.renderRoundReviewSection(null), null,
    'an empty history scope must not print an empty section');
});

test('viewer history section appears with no active round and guides explicit range selection', () => {
  const model = baseModel();
  let state = withHistorySubmission(model, createState(model));
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  // No active round at all, yet the history answers are reviewable.
  assert.equal(state.activeRoundId, null);
  const section = internals.renderRoundReviewSection(null);
  assert.ok(section, 'the history section renders without an active round');
  const text = section.textContent;
  assert.match(text, /无轮次历史复核/, 'the section names the history scope');
  assert.match(text, /历史待复核合计：1 项/, 'the history total uses the history wording');
  // The history guide must say answers are explicitly selected, not swept in.
  assert.match(text, /需你明确选择范围后才会纳入，不会自动全部包含/,
    'history pending wording must not imply automatic inclusion');
  const area = section.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label'));
  assert.match(area.value, /review-read --out <学习目录> --history/,
    'the history copy text reads the history range first');
  assert.match(area.value, /review-start --out <学习目录> --request-id <新的稳定请求ID> --history --attempt <作答ID>/,
    'the history copy text shows the explicit --history --attempt start command');
  assert.doesNotMatch(area.value, /--round-id/, 'the history copy text must not fabricate a round id');
});

test('viewer keeps round and history review counts in separate sections', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  state = withFrozenRequest(model, state);          // round scope: 1 open member
  state = withHistorySubmission(model, state);      // history scope: 1 new answer
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const roundText = internals.renderRoundReviewSection(state.learningRounds['round-a']).textContent;
  const historyText = internals.renderRoundReviewSection(null).textContent;
  // The round section reports only its own scope and merely notes history exists.
  assert.match(roundText, /本轮待复核合计：1 项/);
  assert.doesNotMatch(roundText, /历史待复核合计/);
  assert.match(roundText, /另有 1 项无轮次历史待复核/);
  // The history section reports only history and never the round member.
  assert.match(historyText, /历史待复核合计：1 项/);
  assert.doesNotMatch(historyText, /本轮待复核合计/);
});

test('viewer history section renders a frozen history request with per-item feedback', () => {
  const model = baseModel();
  let state = withHistorySubmission(model, createState(model));
  state = withFrozenHistoryRequest(model, state, ['att-h']);
  completeMember(state, 'rev-h', 0, completedFeedback());
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderRoundReviewSection(null).textContent;
  assert.match(text, /复核请求 rev-h/);
  assert.match(text, /范围：无轮次历史/);
  assert.match(text, /原答：历史合成原答/);
  assert.match(text, /正确部分：真阳性计算正确/);
  assert.match(text, /导师评价：困难（针对原答）/);
  assert.match(text, /完成 1\/1 · 剩余 0/);
});

test('viewer shows the targeted frozen correction text beside the original answer', () => {
  const model = baseModel();
  let state = roundWithSubmission(model);
  // Add a frozen correction to the attempt *before* freezing the request, then
  // have the tutor rate that specific correction.
  const attempt = state.attempts['p-prior-apply'][0];
  attempt.corrections = [{ id: 'corr-1', attemptId: 'att-a', text: '合成修正后的完整解法', at: '2026-10-08T08:30:00Z', source: 'cli', assistance: [] }];
  state = withFrozenRequest(model, state);
  completeMember(state, 'rev-1', 0, { ...completedFeedback(), targetCorrectionId: 'corr-1' });
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  const text = internals.renderRoundReviewSection(state.learningRounds['round-a']).textContent;
  assert.match(text, /原答：合成原答/, 'the original answer is still shown');
  assert.match(text, /评价所针对的修正（corr-1）：合成修正后的完整解法/,
    'the targeted correction text is shown, not just its id');
  assert.match(text, /导师评价：困难（针对一次修正）/, 'the rating is marked as targeting a correction');
});

test('viewer keeps an unsupported positive evidence record on a self-authored question inactive', () => {
  const model = baseModel();
  // A learner-authored question has no author reference or criteria, so it has
  // no basis for a positive judgement.
  let state = createState(model, '2026-10-01T00:00:00Z');
  state.ownQuestions['q-mine'] = {
    id: 'q-mine', conceptId: 'root', text: '自创问题：条件概率是什么？', author: 'learner',
    createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
  };
  const fp = model.conceptFingerprints.root;
  state.attempts['q-mine'] = [{
    id: 'att-q', promptId: 'q-mine', conceptId: 'root', at: '2026-10-02T08:00:00Z',
    submittedAt: '2026-10-02T08:00:00Z', answer: '合成自创作答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli', fingerprint: 'own-q-fp', corrections: [],
  }];
  // A historical positive evidence record citing that unsupported answer.
  state.promptEvidence['q-mine'] = {
    status: 'explained', note: '合成历史证据', reviewer: 'tutor', at: '2026-10-02T09:00:00Z',
    promptId: 'q-mine', fingerprint: 'own-q-fp', conceptId: 'root', conceptFingerprint: fp,
    attemptIds: ['att-q'], independent: true,
  };
  state.conceptEvidence.root = {
    status: 'explained', note: '合成历史概念证据', reviewer: 'tutor', at: '2026-10-02T09:00:00Z',
    conceptId: 'root', conceptFingerprint: fp, attemptIds: ['att-q'], promptIds: ['q-mine'], independent: true,
  };
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  assert.equal(internals.promptHasEvidenceBasis('q-mine'), false, 'a self-authored question has no evidence basis');
  assert.equal(internals.isPromptEvidenceActive('q-mine'), false,
    'an unsupported positive record reads as inactive, not mastery');
  assert.equal(internals.evidenceRuleSatisfied('explained', [state.attempts['q-mine'][0]]), false,
    'an unsupported answer cannot satisfy a positive evidence rule');
  // The record is preserved, not deleted: the archive still carries it.
  assert.ok(state.promptEvidence['q-mine'], 'the historical record is kept, only shown as inactive');
});

test('viewer mixed-concept retained evidence does not count an unsupported answer', () => {
  const model = baseModel();
  let state = createState(model, '2026-10-01T00:00:00Z');
  const fp = model.conceptFingerprints.root;
  // One supported model answer for `root`...
  state.attempts[model.prompts[0].id] = [{
    id: 'att-supported', promptId: model.prompts[0].id, conceptId: 'prior', at: '2026-10-02T08:00:00Z',
    submittedAt: '2026-10-02T08:00:00Z', answer: '合成支持作答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli',
    fingerprint: model.promptFingerprints[model.prompts[0].id], corrections: [],
  }];
  // ...and one unsupported self-authored answer for the same concept.
  state.ownQuestions['q-mine'] = {
    id: 'q-mine', conceptId: 'prior', text: '自创问题', author: 'learner',
    createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
  };
  state.attempts['q-mine'] = [{
    id: 'att-unsupported', promptId: 'q-mine', conceptId: 'prior', at: '2026-10-02T20:00:00Z',
    submittedAt: '2026-10-02T20:00:00Z', answer: '合成自创作答', rating: null, assisted: false,
    assistance: [], submission: { assisted: false, assistance: [] }, source: 'cli', fingerprint: 'own-q-fp', corrections: [],
  }];
  const internals = loadViewer(buildPayload(model, state));
  internals.App.state = state;
  // `retained` needs two independent, separated answers; only one of the two is
  // supported, so the unsupported one must not be counted.
  assert.equal(internals.evidenceRuleSatisfied('retained',
    [state.attempts[model.prompts[0].id][0], state.attempts['q-mine'][0]]), false,
    'an unsupported answer cannot count towards a retained judgement');
});
