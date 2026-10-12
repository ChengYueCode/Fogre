// Task-11 step-through backend regressions.
//
// These cover the public backend contract for ticket 11: the `step-through`
// interaction config, the dependency-free shared library that computes the
// exact content signature and resolves a walkthrough position, the strict
// `interactionPositions` learner record, the `interaction` CLI command, the
// `/api/interaction` HTTP route, export/import/merge conflict preservation and
// legacy-archive compatibility. Fixtures live in this file's own TEMP
// directories; nothing here is real learner evidence.
//
// Run: node --test tests/step-through.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelToJson, normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import {
  interactionContentSignature,
  interactionMergePositions,
  interactionPositionFor,
  interactionRecordPosition,
  interactionStepView,
  interactionValidatePositions,
} from '../skill/forge/scripts/lib/interactions.mjs';
import {
  applyInteractionPosition,
  applySubmission,
  createState,
  interactionPositionView,
  mergeImportedState,
  mergeInteractionPositions,
  normalizeState,
  syncModel,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'step-through-themes.json');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-step-through-'));
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  assert.ok(Array.isArray(raw) && raw.length >= 2, 'two authored themes are required');
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

function buildDir(model) {
  const dir = tmpDir();
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(model)));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  return dir;
}

function readBuiltState(dir) {
  return readJson(path.join(dir, 'state.json'));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

// ---------------------------------------------------------------------------
// Shared library: config, signature, read model
// ---------------------------------------------------------------------------

test('both authored step-through themes validate, round-trip and stay fingerprint-compatible', () => {
  for (const { name, model } of readFixtures()) {
    const normalized = normalizeModel(cloneJson(model));
    const interactions = normalized.interactions;
    assert.ok(Array.isArray(interactions) && interactions.length >= 1, `${name} configures an interaction`);
    for (const interaction of interactions) {
      assert.equal(interaction.kind, 'step-through');
      assert.ok(interaction.initialState.trim() !== '', `${name} declares an initial state`);
      assert.ok(interaction.steps.length >= 2, `${name} has at least two legal steps`);
      const seen = new Set();
      for (const step of interaction.steps) {
        assert.ok(step.id && step.label && step.result && step.change && step.cause, `${name} step ${step.id} is complete`);
        assert.equal(seen.has(step.id), false, `${name} step ids are unique`);
        seen.add(step.id);
      }
      assert.ok(normalized.promptFingerprints[interaction.promptId], `${name} promptId exists on the model`);
      const prompt = normalized.prompts.find((p) => p.id === interaction.promptId);
      assert.equal(prompt.conceptId, interaction.conceptId, `${name} promptId belongs to the same concept`);
      assert.ok(interaction.relatedConceptIds.length >= 1, `${name} links a related concept`);
      for (const rid of interaction.relatedConceptIds) assert.ok(normalized.byId.has(rid), `${name} related concept exists`);
    }
    const json = modelToJson(normalized);
    assert.deepEqual(modelToJson(normalizeModel(cloneJson(json))), json, `${name} survives a rebuild round-trip`);
  }
});

test('malformed step-through configuration is rejected with a readable code', () => {
  const base = cloneJson(readFixtures()[0].model);
  const first = () => cloneJson(base.interactions[0]);
  const withInteraction = (mutate) => {
    const next = cloneJson(base);
    next.interactions = [mutate(first())];
    return next;
  };
  const cases = [
    ['missing initial state', withInteraction((i) => { delete i.initialState; return i; }), 'E_SCHEMA'],
    ['blank initial state', withInteraction((i) => ({ ...i, initialState: '   ' })), 'E_SCHEMA'],
    ['fewer than two steps', withInteraction((i) => ({ ...i, steps: [i.steps[0]] })), 'E_SCHEMA'],
    ['duplicate step id', withInteraction((i) => ({ ...i, steps: [i.steps[0], { ...i.steps[1], id: i.steps[0].id }] })), 'E_DUP_ID'],
    ['unsafe step id', withInteraction((i) => ({ ...i, steps: [{ ...i.steps[0], id: 'Bad_Id' }, i.steps[1]] })), 'E_ID'],
    ['blank label', withInteraction((i) => ({ ...i, steps: [{ ...i.steps[0], label: '  ' }, i.steps[1]] })), 'E_SCHEMA'],
    ['blank result', withInteraction((i) => ({ ...i, steps: [{ ...i.steps[0], result: '' }, i.steps[1]] })), 'E_SCHEMA'],
    ['blank change', withInteraction((i) => ({ ...i, steps: [{ ...i.steps[0], change: ' ' }, i.steps[1]] })), 'E_SCHEMA'],
    ['blank cause', withInteraction((i) => ({ ...i, steps: [{ ...i.steps[0], cause: '' }, i.steps[1]] })), 'E_SCHEMA'],
    ['dangling prompt', withInteraction((i) => ({ ...i, promptId: 'ghost' })), 'E_PROMPT'],
    ['still-unknown kind', withInteraction((i) => ({ ...i, kind: 'parameter' })), 'E_SCHEMA'],
  ];
  for (const [label, raw, code] of cases) {
    assert.throws(() => normalizeModel(raw), (err) => err.code === code, `${label} -> ${code}`);
  }
});

test('public validate/build accept both step-through themes and reject a broken step config', (t) => {
  for (const { name, model } of readFixtures()) {
    const dir = tmpDir();
    t.after(() => cleanup(dir));
    atomicWrite(path.join(dir, 'source.json'), stableStringify(model));
    const validated = runJson(['validate', path.join(dir, 'source.json')]);
    assert.equal(validated.valid, true, `${name} validates`);
    const built = runJson(['build', path.join(dir, 'source.json'), '--out', dir]);
    assert.ok(built.html, `${name} builds`);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /function interactionStepView\s*\(/, `${name} page carries the shared step read model`);
    assert.ok(html.includes('"step-through"'), `${name} payload carries the step-through config`);
  }

  const brokenDir = tmpDir();
  t.after(() => cleanup(brokenDir));
  const broken = cloneJson(readFixtures()[0].model);
  broken.interactions[0].steps = [broken.interactions[0].steps[0]];
  atomicWrite(path.join(brokenDir, 'source.json'), stableStringify(broken));
  const rejected = runCli(['validate', path.join(brokenDir, 'source.json')]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /E_SCHEMA/);
});

test('the content signature is an exact, key-order-independent canonical string', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const signature = interactionContentSignature(interaction);
  assert.equal(typeof signature, 'string');
  assert.ok(signature.length > 40, 'the signature carries the whole config, not a short hash');
  // Reordering object keys must not change identity.
  const reordered = { title: interaction.title, steps: interaction.steps, id: interaction.id, kind: interaction.kind,
    conceptId: interaction.conceptId, objective: interaction.objective, boundary: interaction.boundary,
    question: interaction.question, initialState: interaction.initialState, promptId: interaction.promptId,
    relatedConceptIds: interaction.relatedConceptIds };
  assert.equal(interactionContentSignature(reordered), signature);
  // A one-character content change must change the signature.
  const edited = cloneJson(interaction);
  edited.steps[0].result = edited.steps[0].result + ' ';
  assert.notEqual(interactionContentSignature(edited), signature);
});

test('the read model exposes the current step, both boundaries and restore vs stale', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const signature = interactionContentSignature(interaction);
  const initial = interactionStepView(interaction, null);
  assert.equal(initial.total, interaction.steps.length);
  assert.equal(initial.index, 0);
  assert.equal(initial.current.id, interaction.steps[0].id);
  assert.equal(initial.atFirst, true);
  assert.equal(initial.atLast, false);
  assert.equal(initial.canGoBack, false);
  assert.equal(initial.canGoForward, true);
  assert.ok(initial.current.result && initial.current.change && initial.current.cause);

  const last = interactionStepView(interaction, { stepId: interaction.steps.at(-1).id, contentSignature: signature });
  assert.equal(last.restored, true);
  assert.equal(last.stale, false);
  assert.equal(last.atLast, true);
  assert.equal(last.canGoForward, false);
  assert.equal(last.canGoBack, true);

  // Same step id, changed content: history is kept but the position is stale and
  // the view opens on the initial step instead of pretending it was restored.
  const staleView = interactionStepView(interaction, { stepId: interaction.steps.at(-1).id, contentSignature: 'other-content' });
  assert.equal(staleView.restored, false);
  assert.equal(staleView.stale, true);
  assert.equal(staleView.index, 0);
  assert.ok(staleView.staleReason.includes('内容已更新'));

  // A removed step is stale too.
  const removed = interactionStepView(interaction, { stepId: 'no-such-step', contentSignature: signature });
  assert.equal(removed.stale, true);
  assert.ok(removed.staleReason.includes('移除'));

  // The position builder records the same signature the reader compares.
  const record = interactionPositionFor(interaction, interaction.steps[1].id, 'cli', '2026-10-11T00:00:00Z');
  assert.deepEqual(record, {
    interactionId: interaction.id, conceptId: interaction.conceptId, stepId: interaction.steps[1].id,
    contentSignature: signature, updatedAt: '2026-10-11T00:00:00Z', source: 'cli',
  });
});

// ---------------------------------------------------------------------------
// State: strict learner record
// ---------------------------------------------------------------------------

test('a legacy archive without interactionPositions reads as empty and is never given a fabricated position', () => {
  const model = themeModel('tcp-handshake');
  const legacy = createState(model, '2026-10-11T00:00:00Z');
  delete legacy.interactionPositions;
  const normalized = normalizeState(legacy, model);
  assert.deepEqual(normalized.interactionPositions, {});
  assert.deepEqual(Object.keys(normalized.interactionPositions), []);
  // An absent field is a legacy archive, but a present `null` (or array) is
  // malformed typed data: it is refused instead of being coerced to `{}`, which
  // would silently discard real positions on one surface and not the other.
  assert.throws(() => normalizeState({ ...cloneJson(legacy), interactionPositions: null }, model),
    (err) => err.code === 'E_STATE' && err.path === 'interactionPositions');
  assert.throws(() => normalizeState({ ...cloneJson(legacy), interactionPositions: [] }, model),
    (err) => err.code === 'E_STATE');
});

test('the shared library owns the position rules the page calls directly', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const state = createState(model, '2026-10-11T00:00:00Z');

  // interactionValidatePositions(rawBucket): absent reads as unconfigured (null),
  // a present `null` fails closed, and a bad record names its exact path.
  assert.equal(interactionValidatePositions(undefined), null);
  assert.throws(() => interactionValidatePositions(null), (err) => err.code === 'E_STATE' && err.path === 'interactionPositions');
  assert.throws(() => interactionValidatePositions({ [interaction.id]: { interactionId: interaction.id } }),
    (err) => err.code === 'E_STATE' && err.path === `interactionPositions.${interaction.id}.conceptId`);
  assert.deepEqual(interactionValidatePositions({}), {}, 'an empty bucket stays an empty bucket');
  assert.deepEqual(interactionValidatePositions(state.interactionPositions), {});

  // interactionRecordPosition(state, model, {interactionId, stepId, source}, at)
  // is the page's exact call: it returns the next state and never mutates the one
  // the caller passed in.
  const recorded = interactionRecordPosition(state, model, {
    interactionId: interaction.id, stepId: interaction.steps[1].id, source: 'browser',
  }, '2026-10-11T00:15:00Z');
  assert.equal(recorded.state.interactionPositions[interaction.id].stepId, interaction.steps[1].id);
  assert.equal(recorded.state.interactionPositions[interaction.id].source, 'browser');
  assert.equal(recorded.position.interactionId, interaction.id);
  assert.equal(recorded.state.revision, state.revision + 1);
  assert.deepEqual(state.interactionPositions, {}, 'the caller state is never mutated');
  assert.throws(() => interactionRecordPosition(state, model, { interactionId: interaction.id, stepId: 'ghost', source: 'browser' },
    '2026-10-11T00:15:00Z'), (err) => err.code === 'E_USAGE');

  // interactionMergePositions(current, incoming, conflicts, at) names the
  // interaction id exactly once in a conflict record (no shadowed `cf-` key).
  const conflicts = [];
  const older = interactionPositionFor(interaction, interaction.steps[0].id, 'cli', '2026-10-11T00:00:00Z');
  interactionMergePositions({ [interaction.id]: older }, { [interaction.id]: recorded.position }, conflicts, '2026-10-11T03:00:00Z');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(Object.keys(conflicts[0]).sort(), ['at', 'id', 'kept', 'kind', 'message', 'other', 'path']);
  assert.equal(conflicts[0].id, interaction.id);
  assert.equal(conflicts[0].path, `interactionPositions.${interaction.id}`);
  assert.deepEqual(conflicts[0].kept, recorded.position);
  assert.deepEqual(conflicts[0].other, older);
});

test('interaction positions are strictly validated and fail closed on malformed typed data', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const base = createState(model, '2026-10-11T00:00:00Z');
  const good = interactionPositionFor(interaction, interaction.steps[0].id, 'browser', '2026-10-11T00:00:00Z');
  const withPositions = (positions) => ({ ...cloneJson(base), interactionPositions: positions });

  assert.deepEqual(normalizeState(withPositions({ [interaction.id]: good }), model).interactionPositions[interaction.id], good);
  const cases = [
    ['missing updatedAt', { ...good }],
    ['unknown field', { ...good, extra: true }],
    ['bad source', { ...good, source: 'tutor' }],
    ['bad time', { ...good, updatedAt: 'not-a-time' }],
    ['blank step id', { ...good, stepId: '  ' }],
    ['key mismatch', { ...good, interactionId: 'other-id' }],
  ];
  delete cases[0][1].updatedAt;
  for (const [label, record] of cases) {
    assert.throws(() => normalizeState(withPositions({ [interaction.id]: record }), model),
      (err) => err.code === 'E_STATE', `${label} -> E_STATE`);
  }
  assert.throws(() => normalizeState(withPositions({ [interaction.id]: 'not-an-object' }), model),
    (err) => err.code === 'E_STATE');
});

test('recording a position writes only the learner position, never mastery or answer data', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const state = createState(model, '2026-10-11T00:00:00Z');
  const result = applyInteractionPosition(state, model, {
    interactionId: interaction.id, stepId: interaction.steps[1].id, source: 'cli',
  }, '2026-10-11T00:05:00Z');
  const next = result.state;
  assert.equal(next.interactionPositions[interaction.id].stepId, interaction.steps[1].id);
  assert.equal(next.interactionPositions[interaction.id].conceptId, interaction.conceptId);
  assert.equal(next.interactionPositions[interaction.id].source, 'cli');
  assert.equal(next.revision, state.revision + 1);
  // No attempts, evidence, schedules, notes or review requests were touched.
  assert.deepEqual(next.attempts, state.attempts);
  assert.deepEqual(next.conceptEvidence, state.conceptEvidence);
  assert.deepEqual(next.promptEvidence, state.promptEvidence);
  assert.deepEqual(next.schedules, state.schedules);
  assert.deepEqual(next.explanations, state.explanations);
  assert.deepEqual(next.reviewRequests, state.reviewRequests);
  // The original state is untouched (pure apply).
  assert.deepEqual(state.interactionPositions, {});
});

test('recording an unknown interaction or step is a readable usage error, not a silent write', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const state = createState(model);
  const attempt = (input) => assert.throws(() => applyInteractionPosition(state, model, input, '2026-10-11T00:05:00Z'),
    (err) => err.code === 'E_USAGE');
  attempt({ interactionId: 'ghost', stepId: interaction.steps[0].id, source: 'cli' });
  attempt({ interactionId: interaction.id, stepId: 'ghost', source: 'cli' });
  attempt({ interactionId: interaction.id, stepId: interaction.steps[0].id, source: 'tutor' });
});

test('the read-only position view reports restore, staleness and removal honestly', () => {
  const model = themeModel('binary-search');
  const interaction = model.interactions[0];
  let state = createState(model, '2026-10-11T00:00:00Z');
  assert.equal(interactionPositionView(state, model, interaction.id).present, false);
  state = applyInteractionPosition(state, model, {
    interactionId: interaction.id, stepId: interaction.steps[0].id, source: 'browser',
  }, '2026-10-11T00:10:00Z').state;
  const view = interactionPositionView(state, model, interaction.id);
  assert.equal(view.present, true);
  assert.equal(view.view.restored, true);
  assert.equal(view.saved.source, 'browser');

  // Content changes: the saved position is preserved but the view is stale.
  const changed = cloneJson(modelToJson(model));
  changed.interactions[0].steps[0].result += '（补充说明）';
  const changedModel = normalizeModel(changed);
  const stale = interactionPositionView(state, changedModel, interaction.id);
  assert.equal(stale.present, true, 'the historical position is kept');
  assert.equal(stale.view.stale, true);
  assert.equal(stale.view.index, 0);
});

test('syncModel keeps a removed interaction position as honest history', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  let state = applyInteractionPosition(createState(model, '2026-10-11T00:00:00Z'), model, {
    interactionId: interaction.id, stepId: interaction.steps[1].id, source: 'cli',
  }, '2026-10-11T00:10:00Z').state;
  const withoutInteraction = cloneJson(modelToJson(model));
  delete withoutInteraction.interactions;
  const trimmed = normalizeModel(withoutInteraction);
  const synced = syncModel(state, trimmed, '2026-10-11T00:20:00Z').state;
  assert.equal(synced.interactionPositions[interaction.id].stepId, interaction.steps[1].id, 'the position is never dropped');
  assert.ok(synced.orphans.some((o) => o.kind === 'interaction-position' && o.id === interaction.id));
});

// ---------------------------------------------------------------------------
// Merge (import) conflict preservation
// ---------------------------------------------------------------------------

test('merging positions keeps the newer record, reports the other and never drops unrelated history', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const older = interactionPositionFor(interaction, interaction.steps[0].id, 'cli', '2026-10-11T00:00:00Z');
  const newer = interactionPositionFor(interaction, interaction.steps[2].id, 'browser', '2026-10-11T01:00:00Z');
  const other = interactionPositionFor(
    themeModel('binary-search').interactions[0], 'shrink-right', 'browser', '2026-10-11T00:30:00Z');

  const conflicts = [];
  const merged = mergeInteractionPositions({ [interaction.id]: older }, { [interaction.id]: newer, [other.interactionId]: other }, conflicts, '2026-10-11T02:00:00Z');
  assert.deepEqual(merged[interaction.id], newer, 'the newer position wins');
  assert.deepEqual(merged[other.interactionId], other, 'a different interaction is untouched');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'interaction-position');
  assert.deepEqual(conflicts[0].kept, newer);
  assert.deepEqual(conflicts[0].other, older, 'the other branch stays readable in the conflict record');

  // A tie keeps the current branch; identical records produce no conflict.
  const tieConflicts = [];
  const tied = mergeInteractionPositions({ [interaction.id]: newer }, { [interaction.id]: { ...newer, stepId: interaction.steps[0].id } }, tieConflicts, '2026-10-11T02:00:00Z');
  assert.deepEqual(tied[interaction.id], newer);
  const sameConflicts = [];
  mergeInteractionPositions({ [interaction.id]: newer }, { [interaction.id]: cloneJson(newer) }, sameConflicts, '2026-10-11T02:00:00Z');
  assert.equal(sameConflicts.length, 0, 'an identical import is a no-op');
});

test('a full import merges positions alongside newly imported answers', () => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const prompt = model.prompts[0];
  const current = createState(model, '2026-10-11T00:00:00Z');
  let incoming = createState(model, '2026-10-11T00:00:00Z');
  incoming = applySubmission(incoming, model, {
    promptId: prompt.id, attemptId: 'att-import-1', answer: '导入端的新作答', source: 'browser',
  }, '2026-10-11T00:40:00Z').state;
  incoming = applyInteractionPosition(incoming, model, {
    interactionId: interaction.id, stepId: interaction.steps[1].id, source: 'browser',
  }, '2026-10-11T00:41:00Z').state;

  const merged = mergeImportedState(current, incoming, model, '2026-10-11T01:00:00Z');
  assert.equal((merged.attempts[prompt.id] ?? []).some((a) => a.id === 'att-import-1'), true, 'the new answer is merged');
  assert.equal(merged.interactionPositions[interaction.id].stepId, interaction.steps[1].id, 'the new position is merged');
});

// ---------------------------------------------------------------------------
// Public CLI: interaction / export / import / rebuild
// ---------------------------------------------------------------------------

test('the public interaction CLI saves, exports, imports and rebuilds a position', async (t) => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const dir = buildDir(model);
  t.after(() => cleanup(dir));

  const saved = runJson(['interaction', '--out', dir, '--id', interaction.id, '--step', interaction.steps[2].id, '--at', '2026-10-11T03:00:00Z']);
  assert.equal(saved.saved, true);
  assert.equal(saved.stepId, interaction.steps[2].id);
  assert.equal(saved.conceptId, interaction.conceptId);
  assert.equal(saved.restored, true);
  assert.equal(saved.atLast, true);
  const onDisk = readBuiltState(dir);
  assert.equal(onDisk.interactionPositions[interaction.id].stepId, interaction.steps[2].id);

  // Unknown step fails with a readable error and leaves the archive untouched.
  const bad = runCli(['interaction', '--out', dir, '--id', interaction.id, '--step', 'ghost']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /E_USAGE/);
  assert.equal(readBuiltState(dir).interactionPositions[interaction.id].stepId, interaction.steps[2].id);

  // Export → import into a second, freshly built directory restores it.
  const exportPath = path.join(tmpDir(), 'export.json');
  t.after(() => cleanup(path.dirname(exportPath)));
  runJson(['export', '--out', dir, '--to', exportPath]);
  const dir2 = buildDir(model);
  t.after(() => cleanup(dir2));
  runJson(['import', '--out', dir2, '--state', exportPath]);
  assert.equal(readBuiltState(dir2).interactionPositions[interaction.id].stepId, interaction.steps[2].id);

  // A rebuild of the same directory keeps the position.
  runJson(['build', path.join(dir, 'model.json'), '--out', dir]);
  assert.equal(readBuiltState(dir).interactionPositions[interaction.id].stepId, interaction.steps[2].id);
});

test('the CLI interaction write is version-locked to the content it was issued against', async (t) => {
  const model = themeModel('tcp-handshake');
  const interaction = model.interactions[0];
  const dir = buildDir(model);
  t.after(() => cleanup(dir));
  runJson(['interaction', '--out', dir, '--id', interaction.id, '--step', interaction.steps[0].id]);
  // Replace the built model with edited content: the saved signature no longer
  // matches, so the read view is stale instead of "restored".
  const edited = cloneJson(modelToJson(model));
  edited.interactions[0].steps[0].cause += '（补充）';
  atomicWrite(path.join(dir, 'model.json'), stableStringify(edited));
  const normalized = normalizeModel(edited);
  const state = normalizeState(readBuiltState(dir), normalized);
  const view = interactionPositionView(state, normalized, interaction.id);
  assert.equal(view.present, true);
  assert.equal(view.view.stale, true);
});

// ---------------------------------------------------------------------------
// Public HTTP: /api/interaction
// ---------------------------------------------------------------------------

test('POST /api/interaction records a position under the revision/model lock', async (t) => {
  const model = themeModel('binary-search');
  const interaction = model.interactions[0];
  const dir = buildDir(model);
  t.after(() => cleanup(dir));

  await withServer(dir, async (started) => {
    const stateRes = await fetch(`${started.url}/api/state`);
    const before = await stateRes.json();
    const body = {
      interactionId: interaction.id, stepId: interaction.steps[1].id,
      modelFingerprint: before.modelFingerprint, revision: before.state.revision,
    };
    const ok = await postJson(`${started.url}/api/interaction`, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.state.interactionPositions[interaction.id].stepId, interaction.steps[1].id);
    assert.equal(ok.json.state.interactionPositions[interaction.id].source, 'browser');
    assert.ok(ok.json.view && ok.json.promptFingerprints, 'the route returns the shared state response');

    // A stale revision is a recoverable conflict, not a silent overwrite.
    const stale = await postJson(`${started.url}/api/interaction`, body);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'E_CONFLICT');
    assert.ok(stale.json.state, 'the conflict carries the current state');

    // A stale content fingerprint is refused too.
    const wrongContent = await postJson(`${started.url}/api/interaction`, {
      ...body, revision: ok.json.state.revision, modelFingerprint: 'nope',
    });
    assert.equal(wrongContent.status, 409);

    // A malformed request is a structured 400, not a 500.
    const missingStep = await postJson(`${started.url}/api/interaction`, {
      interactionId: interaction.id, modelFingerprint: before.modelFingerprint, revision: ok.json.state.revision,
    });
    assert.equal(missingStep.status, 400);
    assert.equal(missingStep.json.code, 'E_USAGE');
    const unknownStep = await postJson(`${started.url}/api/interaction`, {
      interactionId: interaction.id, stepId: 'ghost', modelFingerprint: before.modelFingerprint, revision: ok.json.state.revision,
    });
    assert.equal(unknownStep.status, 400);
    assert.equal(unknownStep.json.code, 'E_USAGE');

    // The durable archive still holds the recorded position.
    assert.equal(readBuiltState(dir).interactionPositions[interaction.id].stepId, interaction.steps[1].id);
  });
});

test('a browser import may merge learner positions but still cannot mint tutor records', async (t) => {
  const model = themeModel('binary-search');
  const interaction = model.interactions[0];
  const dir = buildDir(model);
  t.after(() => cleanup(dir));
  let incoming = createState(model, '2026-10-11T00:00:00Z');
  incoming = applyInteractionPosition(incoming, model, {
    interactionId: interaction.id, stepId: interaction.steps[0].id, source: 'browser',
  }, '2026-10-11T00:05:00Z').state;
  incoming.reviewRequests = { 'req-forged': { scope: 'round', id: 'req-forged', members: [] } };

  await withServer(dir, async (started) => {
    const stateRes = await fetch(`${started.url}/api/state`);
    const before = await stateRes.json();
    const ok = await postJson(`${started.url}/api/import`, {
      state: incoming, modelFingerprint: before.modelFingerprint, revision: before.state.revision,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.state.interactionPositions[interaction.id].stepId, interaction.steps[0].id, 'the learner position merges');
    assert.equal(ok.json.state.reviewRequests['req-forged'], undefined, 'the forged review request is dropped');
  });
});
