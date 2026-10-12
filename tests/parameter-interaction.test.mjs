// Task-12 parameter-experiment regressions.
//
// These cover the public backend contract for ticket 12: the `parameter`
// interaction config (built-in rules only), the dependency-free shared read
// model that computes the declared rule from raw control values, the honest
// invalid/zero-denominator/overflow states, and the two authored themes the
// parent drives through the public CLI/browser journey. Fixtures live next to
// this test so a frozen copy of `tests/` alone can rerun them; nothing here is
// real learner evidence, and the medical example is a synthetic teaching number.
//
// Run: node --test tests/parameter-interaction.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelToJson, normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import { interactionParameterView } from '../skill/forge/scripts/lib/interactions.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { atomicWrite, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'parameter-themes.json');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-parameter-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  assert.ok(Array.isArray(raw) && raw.length >= 2, 'two authored themes are required');
  assert.equal(raw[0].name, 'bayes-screening', 'the first theme is the retained bayes frequency demo');
  assert.equal(raw[1].name, 'uniform-speed', 'the second theme reuses the same component on another subject');
  for (const item of raw) {
    assert.equal(typeof item.name, 'string');
    assert.ok(item.model && typeof item.model === 'object');
    assert.equal(item.model.schemaVersion, 1);
  }
  return raw;
}

function themeModel(name) {
  const item = readFixtures().find((entry) => entry.name === name);
  assert.ok(item, `fixture ${name} exists`);
  return normalizeModel(cloneJson(item.model));
}

function defaultsFor(interaction) {
  const values = {};
  interaction.inputs.forEach((input) => { values[input.id] = input.default; });
  return values;
}

// ---------------------------------------------------------------------------
// Configuration: shape, rules, fingerprint compatibility
// ---------------------------------------------------------------------------

test('both authored parameter themes validate, round-trip and stay fingerprint-compatible', () => {
  const expectedRules = new Map([['bayes-screening', 'bayes-frequency'], ['uniform-speed', 'ratio']]);
  for (const { name, model } of readFixtures()) {
    const normalized = normalizeModel(cloneJson(model));
    assert.ok(Array.isArray(normalized.interactions) && normalized.interactions.length >= 1, `${name} configures an interaction`);
    for (const interaction of normalized.interactions) {
      assert.equal(interaction.kind, 'parameter');
      assert.equal(interaction.rule, expectedRules.get(name), `${name} declares the expected built-in rule`);
      assert.ok(interaction.inputs.length >= 1, `${name} declares at least one adjustable input`);
      const seenInputs = new Set();
      for (const input of interaction.inputs) {
        assert.ok(input.id && !seenInputs.has(input.id), `${name} input ids are unique`);
        seenInputs.add(input.id);
        assert.ok(input.label.trim() !== '', `${name} input ${input.id} has a label`);
        assert.equal(typeof input.unit, 'string', `${name} input ${input.id} declares a unit`);
        assert.ok(input.unit.trim() !== '', `${name} input ${input.id} states its unit (dimensionless writes 1)`);
        assert.ok(Number.isFinite(input.min) && Number.isFinite(input.max), `${name} input ${input.id} has finite bounds`);
        assert.ok(input.min < input.max, `${name} input ${input.id} has a usable range`);
        assert.ok(Number.isFinite(input.step) && input.step > 0, `${name} input ${input.id} has a positive step`);
        assert.ok(input.default >= input.min && input.default <= input.max, `${name} input ${input.id} default is inside its range`);
        if (interaction.rule === 'bayes-frequency') {
          assert.ok(input.min >= 0 && input.max <= 1, `${name} probability input ${input.id} stays inside 0..1`);
        }
      }
      // The role map names exactly the rule's roles and never reuses one input.
      const roleInputs = Object.values(interaction.roles);
      assert.equal(new Set(roleInputs).size, roleInputs.length, `${name} roles do not reuse an input`);
      for (const inputId of roleInputs) assert.ok(seenInputs.has(inputId), `${name} role ${inputId} resolves to a declared input`);
      assert.ok(interaction.outputLabel.trim() !== '' && interaction.outputUnit.trim() !== '', `${name} labels the result`);
      assert.ok(normalized.promptFingerprints[interaction.promptId], `${name} promptId exists on the model`);
      const prompt = normalized.prompts.find((p) => p.id === interaction.promptId);
      assert.equal(prompt.conceptId, interaction.conceptId, `${name} promptId belongs to the same concept`);
      assert.ok(interaction.relatedConceptIds.length >= 1, `${name} links a related concept`);
      for (const rid of interaction.relatedConceptIds) assert.ok(normalized.byId.has(rid), `${name} related concept exists`);
    }
    const json = modelToJson(normalized);
    assert.deepEqual(modelToJson(normalizeModel(cloneJson(json))), json, `${name} survives a rebuild round-trip`);
    assert.equal(normalizeModel(cloneJson(json)).modelFingerprint, normalized.modelFingerprint);
  }
});

test('only a configured parameter interaction participates in the model fingerprint', () => {
  const raw = cloneJson(readFixtures()[0].model);
  const withoutInteractions = cloneJson(raw);
  delete withoutInteractions.interactions;
  const legacy = normalizeModel(withoutInteractions);
  const configured = normalizeModel(raw);
  assert.notEqual(configured.modelFingerprint, legacy.modelFingerprint, 'a configured parameter experiment is part of the model identity');
  assert.deepEqual(configured.conceptFingerprints, legacy.conceptFingerprints, 'concept fingerprints are unchanged');
  assert.deepEqual(configured.promptFingerprints, legacy.promptFingerprints, 'prompt fingerprints are unchanged');
  const absent = normalizeModel(cloneJson(withoutInteractions));
  const asNull = normalizeModel({ ...cloneJson(withoutInteractions), interactions: null });
  const asEmpty = normalizeModel({ ...cloneJson(withoutInteractions), interactions: [] });
  assert.equal(absent.modelFingerprint, legacy.modelFingerprint, 'an absent field keeps the pre-ticket fingerprint');
  assert.equal(asNull.modelFingerprint, legacy.modelFingerprint, 'null keeps the pre-ticket fingerprint');
  assert.equal(asEmpty.modelFingerprint, legacy.modelFingerprint, 'an empty array keeps the pre-ticket fingerprint');
});

test('malformed parameter configuration is rejected with a readable code', () => {
  const bayesBase = cloneJson(readFixtures()[0].model);
  const ratioBase = cloneJson(readFixtures()[1].model);
  const withBayes = (mutate) => {
    const next = cloneJson(bayesBase);
    next.interactions = [mutate(cloneJson(bayesBase.interactions[0]))];
    return next;
  };
  const withRatio = (mutate) => {
    const next = cloneJson(ratioBase);
    next.interactions = [mutate(cloneJson(ratioBase.interactions[0]))];
    return next;
  };
  const patchInput = (interaction, inputId, patch) => ({
    ...interaction,
    inputs: interaction.inputs.map((input) => (input.id === inputId ? { ...input, ...patch } : input)),
  });
  const cases = [
    ['unknown rule', withBayes((i) => ({ ...i, rule: 'decision-tree' })), 'E_SCHEMA'],
    ['missing rule', withBayes((i) => { delete i.rule; return i; }), 'E_SCHEMA'],
    ['unknown role name', withBayes((i) => ({ ...i, roles: { ...i.roles, likelihood: 'prior' } })), 'E_SCHEMA'],
    ['blank role', withBayes((i) => ({ ...i, roles: { ...i.roles, prior: '   ' } })), 'E_SCHEMA'],
    ['role points at an undeclared input', withBayes((i) => ({ ...i, roles: { ...i.roles, prior: 'ghost' } })), 'E_SCHEMA'],
    ['one input reused by two roles', withBayes((i) => ({ ...i, roles: { ...i.roles, falsePositive: i.roles.prior } })), 'E_SCHEMA'],
    ['ratio without its denominator role', withRatio((i) => ({ ...i, roles: { numerator: 'distance' } })), 'E_SCHEMA'],
    ['no inputs', withBayes((i) => ({ ...i, inputs: [] })), 'E_SCHEMA'],
    ['inverted range', withBayes((i) => patchInput(i, 'prior', { min: 0.5, max: 0.1 })), 'E_SCHEMA'],
    ['default outside the range', withBayes((i) => patchInput(i, 'prior', { default: 2 })), 'E_SCHEMA'],
    ['zero step', withBayes((i) => patchInput(i, 'prior', { step: 0 })), 'E_SCHEMA'],
    ['missing unit', withBayes((i) => patchInput(i, 'prior', { unit: undefined })), 'E_SCHEMA'],
    ['blank unit', withBayes((i) => patchInput(i, 'prior', { unit: '   ' })), 'E_SCHEMA'],
    ['non-finite bound', withBayes((i) => patchInput(i, 'prior', { min: null })), 'E_SCHEMA'],
    ['probability range outside 0..1', withBayes((i) => patchInput(i, 'prior', { min: -0.1 })), 'E_SCHEMA'],
    ['unsafe input id', withBayes((i) => patchInput(i, 'prior', { id: 'Bad_Id' })), 'E_ID'],
    ['duplicate input id', withBayes((i) => ({ ...i, inputs: [...i.inputs, { ...i.inputs[0] }] })), 'E_DUP_ID'],
    ['missing outputLabel', withBayes((i) => { delete i.outputLabel; return i; }), 'E_SCHEMA'],
    ['blank outputUnit', withBayes((i) => ({ ...i, outputUnit: '' })), 'E_SCHEMA'],
    ['promptId on another concept', withBayes((i) => ({ ...i, promptId: 'p-speed-explain' })), 'E_PROMPT'],
    ['dangling promptId', withBayes((i) => ({ ...i, promptId: 'ghost' })), 'E_PROMPT'],
  ];
  for (const [label, raw, code] of cases) {
    assert.throws(() => normalizeModel(raw), (err) => err.code === code, `${label} -> ${code}`);
  }
});

test('script and expression fields are refused instead of being silently ignored', () => {
  const base = cloneJson(readFixtures()[1].model);
  const withParam = (mutate) => {
    const next = cloneJson(base);
    next.interactions = [mutate(cloneJson(base.interactions[0]))];
    return next;
  };
  const cases = [
    ['interaction script', (i) => ({ ...i, script: 'distance / time' })],
    ['interaction expression', (i) => ({ ...i, expression: 'numerator/denominator' })],
    ['interaction formula', (i) => ({ ...i, formula: 'x / y' })],
    ['interaction code', (i) => ({ ...i, code: 'return 1' })],
    ['interaction exec', (i) => ({ ...i, exec: 'run()' })],
    ['input fn', (i) => ({ ...i, inputs: i.inputs.map((x, idx) => (idx === 0 ? { ...x, fn: 'Math.pow' } : x)) })],
  ];
  for (const [label, mutate] of cases) {
    assert.throws(() => normalizeModel(withParam(mutate)),
      (err) => err.code === 'E_SCHEMA' && /脚本|表达式/.test(err.message), `${label} is refused, not ignored`);
  }
  // Nothing is dropped silently: a legal config serializes without those keys.
  const ok = normalizeModel(cloneJson(base)).interactions[0];
  for (const key of ['script', 'expression', 'formula', 'code', 'exec']) {
    assert.equal(Object.prototype.hasOwnProperty.call(ok, key), false, `${key} is not part of a normalized interaction`);
  }
});

// ---------------------------------------------------------------------------
// Shared read model: defaults, valid computation, honest invalid states
// ---------------------------------------------------------------------------

test('the shared read model computes both themes and previews the declared defaults', () => {
  const bayes = themeModel('bayes-screening').interactions[0];
  const ratio = themeModel('uniform-speed').interactions[0];

  // A key that was never supplied previews the declared default, so the first
  // render and the first computed value agree.
  const bayesPreview = interactionParameterView(bayes, {});
  assert.equal(bayesPreview.valid, true);
  assert.ok(Math.abs(bayesPreview.result - 0.15384615384615385) < 1e-12, 'bayes preview uses the declared defaults');
  assert.equal(bayesPreview.values.prior, 0.01);
  const ratioPreview = interactionParameterView(ratio, {});
  assert.equal(ratioPreview.valid, true);
  assert.equal(ratioPreview.result, 60);
  assert.equal(ratioPreview.resultText, '60 km/h');

  // Raw control strings are parsed strictly, and the process line states units.
  const bayesView = interactionParameterView(bayes, {
    prior: '0.01', sensitivity: '0.9', 'false-positive': '0.05',
  });
  assert.equal(bayesView.valid, true);
  assert.ok(Math.abs(bayesView.result - 9 / 58.5) < 1e-12, 'PPV is sens×prior ÷ (sens×prior + far×(1−prior))');
  assert.equal(bayesView.error, null);
  assert.equal(bayesView.errorCode, null);
  assert.match(bayesView.process, /÷/);
  assert.match(bayesView.process, /×/);
  assert.match(bayesView.process, /比例0\.\.1/);
  assert.equal(bayesView.formula, bayesView.process, 'formula is the same readable line under its alias');
  assert.match(bayesView.resultText, /比例0\.\.1$/);

  const ratioView = interactionParameterView(ratio, { distance: '120', time: '2' });
  assert.equal(ratioView.valid, true);
  assert.equal(ratioView.result, 60);
  assert.match(ratioView.process, /路程/);
  assert.match(ratioView.process, /120 km/);
  assert.match(ratioView.process, /2 h/);
  assert.match(ratioView.process, /60 km\/h$/);
});

test('parameter input accepts decimal scientific numbers and rejects alternate-base strings', () => {
  const interaction = themeModel('uniform-speed').interactions[0];
  const values = defaultsFor(interaction), id = interaction.inputs[0].id;
  for (const raw of ['0x10', '0b10', '0o10']) {
    const view = interactionParameterView(interaction, { ...values, [id]: raw });
    assert.equal(view.valid, false);
    assert.equal(view.result, null);
  }
  assert.equal(interactionParameterView(interaction, { ...values, [id]: '1e2' }).valid, true);
});

test('invalid or missing parameter values are reported instead of clamped or carried over', () => {
  const ratio = themeModel('uniform-speed').interactions[0];
  const bayes = themeModel('bayes-screening').interactions[0];

  // An explicitly present empty value is real input: it is refused, and the
  // previous normal result is never shown again as if it were the new one.
  const blank = interactionParameterView(ratio, { distance: '120', time: '' });
  assert.equal(blank.valid, false);
  assert.equal(blank.result, null);
  assert.equal(blank.resultText, null);
  assert.equal(blank.errorCode, 'E_VALUE');
  assert.match(blank.error, /尚未填写/);
  assert.equal(blank.process, blank.formula, 'the formula is still shown while the value is missing');
  assert.equal(interactionParameterView(ratio, { distance: '120', time: null }).valid, false);
  assert.equal(interactionParameterView(ratio, { distance: '120', time: undefined }).valid, false);
  assert.equal(interactionParameterView(ratio, { distance: '120', time: 'abc' }).valid, false);
  assert.equal(interactionParameterView(ratio, { distance: '120', time: '1e999' }).valid, false, 'a non-finite value is refused');
  // Only a number or a numeric string is real input: a boolean, array or object
  // is refused by type instead of being coerced by Number().
  for (const bad of [true, false, [], [2], {}, { value: 2 }]) {
    const refused = interactionParameterView(ratio, { distance: '120', time: bad });
    assert.equal(refused.valid, false, `raw ${JSON.stringify(bad)} is refused`);
    assert.equal(refused.result, null);
    assert.match(refused.error, /只接受数值或数字字符串/, `raw ${JSON.stringify(bad)} names the real problem`);
  }
  // A numeric value is accepted like its string form, and zero stays a domain
  // error rather than a type error.
  assert.equal(interactionParameterView(ratio, { distance: 120, time: 2 }).result, 60);
  const numericZero = interactionParameterView(ratio, { distance: 120, time: 0 });
  assert.equal(numericZero.valid, false);
  assert.equal(numericZero.errorCode, 'E_ZERO_DENOMINATOR');

  // Out of range is refused, never clamped to the endpoint.
  const tooBig = interactionParameterView(ratio, { distance: '1200', time: '2' });
  assert.equal(tooBig.valid, false);
  assert.equal(tooBig.result, null);
  assert.match(tooBig.error, /超出允许范围/);
  assert.match(tooBig.error, /1200/);

  // A zero denominator (a legal endpoint of the time input) explains itself.
  const zeroTime = interactionParameterView(ratio, { distance: '120', time: '0' });
  assert.equal(zeroTime.valid, false);
  assert.equal(zeroTime.result, null);
  assert.equal(zeroTime.errorCode, 'E_ZERO_DENOMINATOR');
  assert.match(zeroTime.error, /为 0/);

  // An extreme but in-range divisor overflows: rejected, not shown as Infinity.
  const overflow = interactionParameterView(ratio, { distance: '1000', time: '1e-306' });
  assert.equal(overflow.valid, false);
  assert.equal(overflow.result, null);
  assert.equal(overflow.errorCode, 'E_OVERFLOW');

  // The bayes denominator can vanish for reasons other than "prior and false
  // positive rate are both zero", so the message names the actual condition.
  const zeroPositive = interactionParameterView(bayes, { prior: '1', sensitivity: '0', 'false-positive': '0.05' });
  assert.equal(zeroPositive.valid, false);
  assert.equal(zeroPositive.result, null);
  assert.equal(zeroPositive.errorCode, 'E_ZERO_DENOMINATOR');
  assert.equal(zeroPositive.error, '所给条件下阳性事件的概率为 0，不能计算阳性条件下的后验概率');
});

test('the product rule is a verified built-in: it computes and refuses overflow', () => {
  const raw = cloneJson(readFixtures()[1].model);
  const interaction = raw.interactions[0];
  interaction.rule = 'product';
  interaction.roles = { left: 'left', right: 'right' };
  interaction.inputs = [
    { id: 'left', label: '左值', unit: '1', min: -1e308, max: 1e308, step: 1, default: 2 },
    { id: 'right', label: '右值', unit: '1', min: -1e308, max: 1e308, step: 1, default: 3 },
  ];
  interaction.outputLabel = '乘积';
  interaction.outputUnit = '1';
  interaction.promptId = null;
  delete interaction.promptId;
  const product = normalizeModel(raw).interactions[0];
  const ok = interactionParameterView(product, { left: '2', right: '3' });
  assert.equal(ok.valid, true);
  assert.equal(ok.result, 6);
  assert.match(ok.process, /×/);
  const big = interactionParameterView(product, { left: '1e308', right: '1e308' });
  assert.equal(big.valid, false);
  assert.equal(big.result, null);
  assert.equal(big.errorCode, 'E_OVERFLOW');
});

test('the process text stays finite and never rounds a real value down to zero', () => {
  const ratio = themeModel('uniform-speed').interactions[0];
  // A tiny denominator is a legal in-range value that overflows the quotient:
  // the formula must still print the real (non-zero) denominator.
  const tiny = interactionParameterView(ratio, { distance: '1000', time: '1e-306' });
  assert.equal(tiny.valid, false);
  assert.equal(tiny.errorCode, 'E_OVERFLOW');
  assert.match(tiny.process, /1e-306/, 'a tiny value is printed instead of being rounded to 0');
  assert.match(tiny.process, /÷/, 'the formula keeps its structure');
  assert.equal(/÷ 0(?!\.)/.test(tiny.process), false, 'the process never claims a zero denominator it never had');
  assert.equal(/Infinity|NaN/.test(tiny.process), false, 'the process never prints a non-finite number');

  // A huge numerator must not overflow while being formatted for display.
  const raw = cloneJson(readFixtures()[1].model);
  raw.interactions[0].inputs = raw.interactions[0].inputs.map((input) => (
    input.id === 'distance' ? { ...input, max: 1e308, default: 1e308 } : input
  ));
  const wide = normalizeModel(raw).interactions[0];
  const view = interactionParameterView(wide, { distance: '1e308', time: '1' });
  assert.equal(view.valid, true);
  assert.equal(view.result, 1e308);
  assert.match(view.process, /1e\+308/);
  assert.equal(/Infinity|NaN/.test(view.process), false);
  assert.equal(/Infinity|NaN/.test(view.resultText), false);
});

test('the parameter read model is pure: it observes nothing and mutates nothing', () => {
  const interaction = themeModel('bayes-screening').interactions[0];
  const before = stableStringify(JSON.parse(JSON.stringify(interaction)));
  const values = { prior: '0.02', sensitivity: '0.8', 'false-positive': '0.1' };
  const first = interactionParameterView(interaction, values);
  const second = interactionParameterView(interaction, values);
  assert.deepEqual(second, first, 'the same inputs always give the same view');
  assert.deepEqual(values, { prior: '0.02', sensitivity: '0.8', 'false-positive': '0.1' }, 'the value map is not rewritten');
  assert.equal(stableStringify(JSON.parse(JSON.stringify(interaction))), before, 'the interaction config is never mutated');
  assert.equal(interactionParameterView(null, {}).valid, false, 'an unconfigured interaction reports instead of throwing');
});

test('the legacy bayes-frequency activity demo keeps its behavior', () => {
  const raw = cloneJson(readFixtures()[1].model);
  delete raw.interactions;
  raw.activity = 'bayes-frequency';
  const legacy = normalizeModel(raw);
  assert.equal(legacy.activity, 'bayes-frequency', 'the legacy activity key is preserved, not normalized away');
  const json = modelToJson(legacy);
  assert.equal(json.activity, 'bayes-frequency');
  assert.deepEqual(modelToJson(normalizeModel(cloneJson(json))), json, 'the legacy activity model round-trips');
  assert.equal(normalizeModel(cloneJson(json)).modelFingerprint, legacy.modelFingerprint);
  // Adding a parameter experiment leaves the legacy activity demo in place.
  const both = cloneJson(raw);
  both.interactions = [cloneJson(readFixtures()[1].model.interactions[0])];
  assert.equal(normalizeModel(both).activity, 'bayes-frequency');
});

// ---------------------------------------------------------------------------
// Public CLI: validate and build accept both themes, refuse an authored script
// ---------------------------------------------------------------------------

test('public validate/build accept both parameter themes and reject an authored script field', (t) => {
  const dirs = [];
  t.after(() => dirs.forEach(cleanup));
  for (const { name, model } of readFixtures()) {
    const dir = tmpDir();
    dirs.push(dir);
    atomicWrite(path.join(dir, 'source.json'), stableStringify(model));
    const validated = runJson(['validate', path.join(dir, 'source.json')]);
    assert.equal(validated.modelFingerprint, normalizeModel(cloneJson(model)).modelFingerprint, `${name} validates through the public CLI`);
    const built = runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    assert.equal(built.written.html, true, `${name} builds through the public CLI`);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('interactionParameterView'), `${name} build inlines the shared parameter read model`);
    assert.ok(html.includes(model.interactions[0].id), `${name} build carries the configured interaction`);
  }

  const brokenDir = tmpDir();
  dirs.push(brokenDir);
  const broken = cloneJson(readFixtures()[1].model);
  broken.interactions[0].script = 'viewer.compute = function () {}';
  atomicWrite(path.join(brokenDir, 'source.json'), stableStringify(broken));
  const rejected = runCli(['validate', path.join(brokenDir, 'source.json')]);
  assert.equal(rejected.status, 1, 'an authored script field fails validate');
  assert.match(rejected.stderr, /E_SCHEMA/);
  assert.match(rejected.stderr, /script/);
});
