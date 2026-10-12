// Task-10 comparison-interaction regressions.
//
// These cover the public backend/page contract for ticket 10: optional teaching
// `interactions` configuration (validate/build/fingerprint compatibility), the
// dependency-free shared library the page and the CLI both run, the
// concept-detail comparison card, and the two authored fixtures the parent uses
// for the public CLI/browser journey. The authoritative fixtures live next to
// this test in `tests/fixtures/` so a frozen copy of `tests/` alone can rerun
// them; nothing here is real learner evidence.
//
// Run: node --test tests/interactions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import { createState } from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts, renderViewerHtml } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, sha256, stableStringify } from '../skill/forge/scripts/lib/io.mjs';
import { interactionComparisonView, interactionForConcept } from '../skill/forge/scripts/lib/interactions.mjs';

test('parameter page clears a prior result on invalid input without writing learner evidence', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'parameter-themes.json')))[1].model;
  const model = normalizeModel(raw), internals = loadViewer(payloadFor(model)), interaction = model.interactions[0];
  const card = internals.renderInteractionsPanel(interaction.conceptId);
  assert.ok(card.textContent.includes(interaction.outputLabel + '：'));
  const input = card.querySelector('#interaction-' + interaction.id + '-' + interaction.inputs[0].id);
  input.value = ''; input.dispatchEvent({type:'input'});
  assert.match(card.textContent, /无法计算/);
  assert.equal(card.textContent.includes(interaction.outputLabel + '：'), false);
  input.value = interaction.inputs[0].max + 1; input.dispatchEvent({type:'input'});
  assert.match(card.textContent, /无法计算/);
  input.value = interaction.inputs[0].default; input.dispatchEvent({type:'input'});
  assert.ok(card.textContent.includes(interaction.outputLabel + '：'));
  assert.equal(Object.keys(internals.App.state.attempts).length, 0);
  assert.equal(Object.keys(internals.App.state.conceptEvidence).length, 0);
  assert.equal(internals.App.queue.length, 0);
});

test('step-through page saves position without inventing an answer and restores the last boundary', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'step-through-themes.json')))[1].model;
  const model = normalizeModel(raw), internals = loadViewer(payloadFor(model)), interaction = model.interactions[0];
  internals.App.mode = 'standalone';
  let card = internals.renderInteractionsPanel(interaction.conceptId);
  assert.equal(card.querySelector('#interaction-' + interaction.id + '-previous').hasAttribute('disabled'), true);
  internals.localAction({ type: 'interaction', interactionId: interaction.id, stepId: interaction.steps.at(-1).id });
  assert.equal(internals.App.state.interactionPositions[interaction.id].stepId, interaction.steps.at(-1).id);
  assert.equal(Object.keys(internals.App.state.attempts).length, 0);
  assert.equal(Object.keys(internals.App.state.conceptEvidence).length, 0);
  card = internals.renderInteractionsPanel(interaction.conceptId);
  assert.match(card.textContent, /已恢复保存位置/);
  assert.ok(card.textContent.includes(interaction.steps.at(-1).cause));
  assert.equal(card.querySelector('#interaction-' + interaction.id + '-next').hasAttribute('disabled'), true);
  const incoming = JSON.parse(JSON.stringify(internals.App.state));
  incoming.interactionPositions[interaction.id].stepId = interaction.steps[0].id;
  incoming.interactionPositions[interaction.id].updatedAt = '2099-01-01T00:00:00Z';
  incoming.summaries[interaction.conceptId] = {text:'另一端的新总结',updatedAt:'2099-01-01T00:00:00Z',author:'learner'};
  const merged = internals.mergeLocal(internals.App.state, incoming);
  assert.equal(merged.summaries[interaction.conceptId].text, '另一端的新总结');
  assert.ok(merged.conflicts.some(c => c.kind === 'interaction-position' && c.kept && c.other));
  assert.throws(() => internals.ensureState({...incoming, interactionPositions:null}));
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const INTERACTIONS_LIB = path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'interactions.mjs');
// Authoritative fixtures ship inside `tests/` so the frozen review copy can
// rerun this suite without the (unfrozen) `.scratch` tree.
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'comparison-themes.json');
// The parent's public CLI/browser journey reads the same two themes from here.
// Verified only when present, so a frozen copy never depends on `.scratch`.
const FIXTURES_MIRROR = path.join(ROOT, '.scratch', 'ember-learning-journey', 'task10-validation', 'fixtures.json');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-interactions-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function buildDir(themes, name) {
  const dir = tmpDir();
  atomicWrite(path.join(dir, 'source.json'), stableStringify(themes.find((t) => t.name === name).model));
  return dir;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  assert.ok(Array.isArray(raw), 'fixtures.json must be an array of {name, model}');
  assert.ok(raw.length >= 2, 'at least two themes are required');
  for (const item of raw) {
    assert.equal(typeof item.name, 'string', 'each fixture needs a name');
    assert.ok(item.model && typeof item.model === 'object', 'each fixture needs a raw model');
    assert.equal(item.model.schemaVersion, 1);
  }
  if (fs.existsSync(FIXTURES_MIRROR)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURES_MIRROR, 'utf8')), raw,
      'the public-journey mirror must match the authoritative test fixtures');
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Shared library portability
// ---------------------------------------------------------------------------

test('the interaction library is portable and never evaluates author text', () => {
  const source = fs.readFileSync(INTERACTIONS_LIB, 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, 'interactions.mjs must not import anything');
  for (const forbidden of ['require(', 'process.', 'fs.', 'path.', 'node:', 'Buffer', 'globalThis']) {
    assert.equal(source.includes(forbidden), false, `interactions.mjs must not use ${forbidden}`);
  }
  for (const banned of ['innerHTML', 'eval(', 'new Function', 'document.write']) {
    assert.equal(source.includes(banned), false, `interactions.mjs must never use ${banned}`);
  }
  const functionNames = [...source.matchAll(/^function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  assert.ok(functionNames.length > 0);
  for (const name of functionNames) {
    assert.ok(name.startsWith('interaction'), `${name} must be interaction*-prefixed to avoid viewer collisions`);
  }
});

test('the viewer inlines the shared interaction library at its marker', () => {
  const template = fs.readFileSync(VIEWER, 'utf8');
  assert.ok(template.includes('/*__EMBER_INTERACTIONS_LIBRARY__*/'), 'the viewer template carries the marker');
  const lib = fs.readFileSync(INTERACTIONS_LIB, 'utf8').replace(/^export /gm, '');
  const html = template.replace('/*__EMBER_INTERACTIONS_LIBRARY__*/', () => lib);
  assert.equal(html.includes('__EMBER_INTERACTIONS_LIBRARY__'), false, 'the marker is replaced');
  assert.match(html, /function interactionComparisonView\s*\(/, 'the shared read model is inlined');
  assert.equal(/export function interactionComparisonView/.test(html), false, 'the export keyword is stripped');
});

// ---------------------------------------------------------------------------
// Configuration normalization and fingerprint compatibility
// ---------------------------------------------------------------------------

test('both authored themes validate, round-trip and stay fingerprint-compatible', () => {
  const themes = readFixtures();
  for (const { name, model } of themes) {
    const normalized = normalizeModel(cloneJson(model));
    const interactions = normalized.interactions;
    assert.ok(Array.isArray(interactions) && interactions.length >= 1, `${name} configures an interaction`);
    for (const interaction of interactions) {
      assert.equal(interaction.kind, 'comparison');
      assert.ok(interaction.objects.length >= 2, `${name} compares at least two objects`);
      assert.ok(interaction.dimensions.length >= 2, `${name} has at least two dimensions`);
      assert.ok(interaction.promptId, `${name} links a real author question`);
      assert.ok(normalized.promptFingerprints[interaction.promptId], `${name} promptId exists on the model`);
      const prompt = normalized.prompts.find((p) => p.id === interaction.promptId);
      assert.equal(prompt.conceptId, interaction.conceptId, `${name} promptId belongs to the same concept`);
      assert.ok(interaction.relatedConceptIds.length >= 1, `${name} links a related concept`);
      for (const rid of interaction.relatedConceptIds) assert.ok(normalized.byId.has(rid), `${name} related concept exists`);
      // Every object carries a non-empty value for every dimension.
      for (const obj of interaction.objects) {
        for (const dim of interaction.dimensions) assert.ok(String(obj.values[dim.id] || '').trim() !== '');
      }
    }
    // Canonical serialization is a fixed point.
    const json = modelToJson(normalized);
    assert.deepEqual(modelToJson(normalizeModel(cloneJson(json))), json, `${name} survives a rebuild round-trip`);
    assert.equal(normalizeModel(cloneJson(json)).modelFingerprint, normalized.modelFingerprint);
  }
});

test('a configured interaction changes only the model fingerprint, never concept or prompt fingerprints', () => {
  const raw = cloneJson(readFixtures()[0].model);
  const withoutInteractions = { ...raw };
  delete withoutInteractions.interactions;
  const legacy = normalizeModel(cloneJson(withoutInteractions));
  const configured = normalizeModel(raw);
  assert.notEqual(configured.modelFingerprint, legacy.modelFingerprint, 'configured interactions participate in the model fingerprint');
  assert.deepEqual(configured.conceptFingerprints, legacy.conceptFingerprints, 'concept fingerprints are unchanged');
  assert.deepEqual(configured.promptFingerprints, legacy.promptFingerprints, 'prompt fingerprints are unchanged');
  // A pure observation component must never fabricate a mastery change.
  assert.deepEqual(Object.keys(configured.promptFingerprints).sort(), Object.keys(legacy.promptFingerprints).sort());
});

test('absent, null and empty interactions all keep the legacy fingerprint', () => {
  const raw = cloneJson(readFixtures()[0].model);
  delete raw.interactions;
  const absent = normalizeModel(cloneJson(raw));
  const asNull = normalizeModel({ ...cloneJson(raw), interactions: null });
  const asEmpty = normalizeModel({ ...cloneJson(raw), interactions: [] });
  assert.equal(absent.modelFingerprint, asNull.modelFingerprint);
  assert.equal(absent.modelFingerprint, asEmpty.modelFingerprint);
  assert.equal('interactions' in modelToJson(absent), false, 'an unconfigured model never grows the key');
  assert.equal('interactions' in modelToJson(asNull), false);
  assert.equal('interactions' in modelToJson(asEmpty), false);
  // The legacy fingerprint formula, with no interactions key at all.
  const expected = sha256(stableStringify({
    schemaVersion: 1, id: absent.id, title: absent.title, goal: absent.goal, summary: absent.summary,
    concepts: modelToJson(absent).concepts, relations: modelToJson(absent).relations, prompts: modelToJson(absent).prompts,
    sources: modelToJson(absent).sources, limitations: modelToJson(absent).limitations,
  }));
  assert.equal(absent.modelFingerprint, expected, 'an absent component leaves the pre-ticket-10 fingerprint intact');
});

test('malformed interaction configuration is rejected with a structured readable code', () => {
  const base = cloneJson(readFixtures()[0].model);
  const first = () => cloneJson(base.interactions[0]);
  const withInteraction = (mutate) => {
    const next = cloneJson(base);
    next.interactions = [mutate(first())];
    return next;
  };
  const cases = [
    ['unknown kind', withInteraction((i) => ({ ...i, kind: 'timeline' })), 'E_SCHEMA'],
    ['unsupported parameter kind', withInteraction((i) => ({ ...i, kind: 'parameter' })), 'E_SCHEMA'],
    ['unsafe id', withInteraction((i) => ({ ...i, id: 'Bad_Id' })), 'E_ID'],
    ['duplicate object id', withInteraction((i) => ({ ...i, objects: [i.objects[0], { ...i.objects[1], id: i.objects[0].id }] })), 'E_DUP_ID'],
    ['duplicate dimension id', withInteraction((i) => ({ ...i, dimensions: [i.dimensions[0], { ...i.dimensions[1], id: i.dimensions[0].id }] })), 'E_DUP_ID'],
    ['dangling concept', withInteraction((i) => ({ ...i, conceptId: 'ghost' })), 'E_SCHEMA'],
    ['dangling prompt', withInteraction((i) => ({ ...i, promptId: 'ghost' })), 'E_PROMPT'],
    ['dangling related concept', withInteraction((i) => ({ ...i, relatedConceptIds: ['ghost'] })), 'E_SCHEMA'],
    ['blank label', withInteraction((i) => ({ ...i, objects: [{ ...i.objects[0], label: '   ' }, i.objects[1]] })), 'E_SCHEMA'],
    ['missing value', withInteraction((i) => {
      const missing = { ...i.objects[0], values: { ...i.objects[0].values } };
      delete missing.values[i.dimensions[0].id];
      return { ...i, objects: [missing, i.objects[1]] };
    }), 'E_SCHEMA'],
    ['extra value key', withInteraction((i) => ({ ...i, objects: [{ ...i.objects[0], values: { ...i.objects[0].values, ghost: 'x' } }, i.objects[1]] })), 'E_SCHEMA'],
    ['single object', withInteraction((i) => ({ ...i, objects: [i.objects[0]] })), 'E_SCHEMA'],
    ['empty dimensions', withInteraction((i) => ({ ...i, dimensions: [] })), 'E_SCHEMA'],
    ['blank difference', withInteraction((i) => ({ ...i, dimensions: [{ ...i.dimensions[0], difference: ' ' }, i.dimensions[1]] })), 'E_SCHEMA'],
  ];
  for (const [label, raw, code] of cases) {
    assert.throws(() => normalizeModel(raw), (err) => err.code === code, `${label} -> ${code}`);
  }
});

test('a promptId on a different concept is refused and author text is inert', () => {
  const base = cloneJson(readFixtures()[0].model);
  const otherPrompt = base.prompts.find((p) => p.conceptId !== base.interactions[0].conceptId);
  assert.ok(otherPrompt, 'the fixture has a prompt on another concept');
  const mismatch = cloneJson(base);
  mismatch.interactions[0].promptId = otherPrompt.id;
  assert.throws(() => normalizeModel(mismatch), (err) => err.code === 'E_PROMPT');

  // A script-looking string only ever becomes inert text, never executed.
  const payload = '<img src=x onerror="globalThis.__pwned=1">';
  const injected = cloneJson(base);
  injected.interactions[0].objective = payload;
  const normalized = normalizeModel(injected);
  assert.equal(normalized.interactions[0].objective, payload, 'author text is preserved verbatim as data');
  assert.equal(modelToJson(normalized).interactions[0].objective, payload);
});

// ---------------------------------------------------------------------------
// Public CLI: validate / build
// ---------------------------------------------------------------------------

test('public validate/build accept a real comparison config and reject a broken one', (t) => {
  const themes = readFixtures();
  for (const theme of themes) {
    const dir = buildDir(themes, theme.name);
    t.after(() => cleanup(dir));
    const validated = runJson(['validate', path.join(dir, 'source.json')]);
    assert.equal(validated.valid, true, `${theme.name} validates`);
    const built = runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    assert.ok(built.html, `${theme.name} builds`);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal(html.includes('__EMBER_INTERACTIONS_LIBRARY__'), false, `${theme.name} marker is replaced`);
    assert.match(html, /function interactionComparisonView\s*\(/, `${theme.name} page carries the shared read model`);
    // The configuration reaches the page payload without a second copy of rules.
    assert.ok(html.includes('"interactions"'), `${theme.name} payload carries the interactions`);
  }

  const brokenDir = tmpDir();
  t.after(() => cleanup(brokenDir));
  const broken = cloneJson(themes[0].model);
  broken.interactions[0].kind = 'parameter';
  atomicWrite(path.join(brokenDir, 'source.json'), stableStringify(broken));
  const rejected = runCli(['validate', path.join(brokenDir, 'source.json')]);
  assert.equal(rejected.status, 1, 'an unsupported kind fails validate');
  assert.match(rejected.stderr, /E_SCHEMA/);
});

test('the local server serves the same inlined comparison page', async (t) => {
  const themes = readFixtures();
  const dir = buildDir(themes, themes[1].name);
  t.after(() => cleanup(dir));
  runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
  const started = await startServer({ dir, port: 0 });
  t.after(() => started.close());
  const html = await (await fetch(started.url)).text();
  assert.match(html, /function interactionComparisonView\s*\(/, 'the served page carries the shared read model');
  assert.ok(html.includes('"interactions"'), 'the served page carries the configuration');
});

// ---------------------------------------------------------------------------
// Concept-detail comparison card (portable page)
// ---------------------------------------------------------------------------

function loadViewer(payload) {
  const dataEl = { textContent: JSON.stringify(payload) };
  const documentShim = {
    createElement(tag) { return new ShimNode(tag); },
    createElementNS() { return new ShimNode(); },
    createDocumentFragment() { return new ShimNode('#fragment'); },
    createTextNode(text) { return Object.assign(new ShimNode('#text'), { textContent: text }); },
    querySelector(sel) { return sel === '#ember-data' ? dataEl : null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    activeElement: null,
    body: new ShimNode('body'),
  };
  const sandbox = {
    console, document: documentShim, location: { protocol: 'file:' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false }),
    requestAnimationFrame(cb) { return cb(); },
    setTimeout, clearTimeout, crypto: globalThis.crypto,
    URL: { createObjectURL() { return 'blob:viewer'; }, revokeObjectURL() {} },
    Node: ShimNode, Blob, navigator: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__EMBER_TEST__ = true;
  vm.createContext(sandbox);
  vm.runInContext(scriptBody, sandbox, { filename: 'viewer.html' });
  assert.ok(sandbox.__emberInternals, 'viewer test hook should be exposed');
  return sandbox.__emberInternals;
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
    this.classList = { add() {}, remove() {}, contains() { return false; } };
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
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'id') this.id = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatchEvent(event) { event.target ||= this; for (const fn of this.listeners.get(event.type) || []) fn.call(this, event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext() {
    return { font: '', fillStyle: '', setTransform() {}, clearRect() {}, fillRect() {}, measureText() { return { width: 0 }; } };
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const stripExports = (source) => source.replace(/^export /gm, '');
const viewerHtml = fs.readFileSync(VIEWER, 'utf8')
  .replace('/*__EMBER_ROUND_LIBRARY__*/', () => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'round.mjs'), 'utf8')))
  .replace('/*__EMBER_SCHEDULE_LIBRARY__*/', () => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'schedule.mjs'), 'utf8')))
  .replace('/*__EMBER_TUTOR_REVIEW_LIBRARY__*/', () => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'tutor-review.mjs'), 'utf8')))
  .replace('/*__EMBER_INTERACTIONS_LIBRARY__*/', () => stripExports(fs.readFileSync(INTERACTIONS_LIB, 'utf8')))
  .replace('/*__EMBER_INSIGHTS_LIBRARY__*/', () => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'insights.mjs'), 'utf8')))
  .replace('/*__EMBER_CORRECTIONS_LIBRARY__*/', () => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', 'corrections.mjs'), 'utf8')));
const scriptBody = (() => {
  const start = viewerHtml.lastIndexOf('<script>');
  const end = viewerHtml.indexOf('</script>', start);
  return viewerHtml.slice(viewerHtml.indexOf('>', start) + 1, end);
})();

function payloadFor(model) {
  return {
    model: modelToJson(model),
    state: createState(model, '2026-10-10T00:00:00Z'),
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: { ...model.promptFingerprints },
    conceptFingerprints: { ...model.conceptFingerprints },
  };
}

test('the comparison card shows values, difference and both boundary layers', () => {
  const model = normalizeModel(cloneJson(readFixtures()[0].model));
  const internals = loadViewer(payloadFor(model));
  const interaction = model.interactions[0];
  const node = internals.renderInteractionsPanel(interaction.conceptId);
  const text = node.textContent;
  assert.ok(text.includes(interaction.title), 'the title is shown');
  assert.ok(text.includes(interaction.objective), 'the verifiable objective is shown');
  const dim0 = interaction.dimensions[0];
  assert.ok(text.includes(dim0.difference), 'the key difference is shown');
  assert.ok(text.includes(dim0.boundary), 'the per-dimension boundary is shown');
  assert.ok(text.includes(interaction.boundary), 'the component-level boundary is shown separately');
  assert.ok(text.includes(interaction.question), 'the follow-up question is shown');
  for (const obj of interaction.objects) assert.ok(text.includes(obj.label), `object ${obj.label} is selectable`);
  // Three native selects: object A, object B and the dimension.
  assert.equal(node.querySelectorAll('select').length, 3);
  // Navigation contracts: a related concept and the real author prompt.
  const related = node.querySelectorAll('button').filter((b) => b.getAttribute('data-interaction-action') === 'related-concept');
  assert.ok(related.some((b) => b.getAttribute('data-concept-id') === interaction.relatedConceptIds[0]));
  const promptBtn = node.querySelectorAll('button').find((b) => b.getAttribute('data-interaction-action') === 'prompt');
  assert.equal(promptBtn.getAttribute('data-prompt-id'), interaction.promptId);
  // Rendering an observation card writes no learner state and queues no save.
  assert.equal(internals.App.queue.length, 0, 'observation never queues a write');
});

test('selecting the same object twice is not comparable instead of faking a difference', () => {
  const model = normalizeModel(cloneJson(readFixtures()[0].model));
  const internals = loadViewer(payloadFor(model));
  const interaction = model.interactions[0];
  internals.App.interactionSelection = { [interaction.id]: { objectAId: interaction.objects[0].id, objectBId: interaction.objects[0].id } };
  const node = internals.renderInteractionsPanel(interaction.conceptId);
  const text = node.textContent;
  assert.ok(text.includes('同一项无法比较'), 'the page says the same item cannot be compared');
  assert.equal(text.includes(interaction.dimensions[0].difference), false, 'no difference is fabricated');
  const view = internals.interactionComparisonView(interaction, internals.App.interactionSelection[interaction.id]);
  assert.equal(view.comparable, false);
  assert.equal(view.difference, null);
  assert.equal(internals.App.queue.length, 0);
});

test('an unconfigured concept states so plainly and never implies review', () => {
  const model = normalizeModel(cloneJson(readFixtures()[0].model));
  const internals = loadViewer(payloadFor(model));
  const node = internals.renderInteractionsPanel('root');
  assert.ok(node.textContent.includes('尚未配置互动组件'));
  assert.equal(node.querySelectorAll('select').length, 0);
  assert.equal(internals.interactionForConcept(modelToJson(model), 'root').length, 0);
  assert.equal(interactionForConcept(model, 'root').length, 0, 'the pure lookup agrees');
});

test('the shared read model returns defaults and reports non-comparable selections', () => {
  const model = normalizeModel(cloneJson(readFixtures()[1].model));
  const interaction = model.interactions[0];
  const view = interactionComparisonView(interaction, {});
  assert.equal(view.comparable, true);
  assert.equal(view.selection.objectAId, interaction.objects[0].id);
  assert.equal(view.selection.objectBId, interaction.objects[1].id);
  assert.equal(view.difference, interaction.dimensions[0].difference);
  assert.ok(view.values.a && view.values.b);
  const same = interactionComparisonView(interaction, { objectAId: interaction.objects[1].id, objectBId: interaction.objects[1].id });
  assert.equal(same.comparable, false);
  assert.equal(same.values.a, null);
});
