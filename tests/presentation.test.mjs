import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import { createState, applyAttempt, syncModel } from '../skill/forge/scripts/lib/state.mjs';
import { buildScene, sceneToSvg } from '../skill/forge/scripts/lib/scene.mjs';
import { renderViewerHtml } from '../skill/forge/scripts/lib/build.mjs';
import { THEMES, resolvePresentation } from '../skill/forge/scripts/lib/presentation.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('../skill/forge/assets/probability.json', import.meta.url)));
const template = fs.readFileSync(new URL('../skill/forge/assets/viewer.html', import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}-themes.json`, import.meta.url)));

test('content structure chooses stable themes, explicit reading choice survives round trip', () => {
  for (const [file, name] of [['parameter', 'lab'], ['step-through', 'sequence'], ['comparison', 'contrast']]) {
    const data = fixture(file);
    const models = Array.isArray(data) ? data : Object.values(data);
    for (const input of models) assert.equal(resolvePresentation(normalizeModel(input.model ?? input)).name, name);
  }
  const model = normalizeModel({ ...raw, presentation: { theme: 'editorial', rationale: '  精读解释  ' } });
  assert.deepEqual(normalizeModel(modelToJson(model)).presentation, { theme: 'editorial', rationale: '精读解释' });
  assert.throws(() => normalizeModel({ ...raw, presentation: { theme: '</style><script>' } }), { code: 'E_SCHEMA' });
  assert.throws(() => normalizeModel({ ...raw, presentation: { theme: 'atlas', rationale: 1 } }), { code: 'E_SCHEMA' });
});

test('presentation rebuild preserves answer identities and hand-edited scene styles', () => {
  const before = normalizeModel({ ...raw, presentation: { theme: 'atlas' } });
  const after = normalizeModel({ ...raw, presentation: { theme: 'lab' } });
  assert.equal(before.modelFingerprint, after.modelFingerprint);
  assert.deepEqual(before.promptFingerprints, after.promptFingerprints);
  let state = createState(before);
  state = applyAttempt(state, before, { promptId: before.prompts[0].id, answer: '合成验证原答', rating: 'good', attemptId: 'visual-test' }).state;
  const synced = syncModel(state, after);
  assert.deepEqual(synced.state.attempts, state.attempts);
  const scene = buildScene(before, state).scene;
  const node = scene.elements.find((el) => el.id === `c-${before.concepts[0].id}`);
  node.backgroundColor = '#ffccaa';
  const rebuilt = buildScene(after, synced.state, scene).scene;
  assert.equal(rebuilt.elements.find((el) => el.id === node.id).backgroundColor, '#ffccaa');
  assert.equal(rebuilt.appState.viewBackgroundColor, THEMES.lab.bg);
  assert.ok(sceneToSvg(rebuilt).includes(`fill="${THEMES.lab.bg}"`));
  rebuilt.appState.viewBackgroundColor = '#123456';
  assert.equal(buildScene(before, state, rebuilt).scene.appState.viewBackgroundColor, '#123456');
});

function contrast(a, b) {
  const luminance = (hex) => {
    const c = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test('every built HTML and diagram shares its palette with readable text and actions', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    const model = normalizeModel({ ...raw, presentation: { theme: name } });
    const state = createState(model);
    const scene = buildScene(model, state).scene;
    const html = renderViewerHtml(template, { model: modelToJson(model), state });
    assert.ok(html.includes(`Forge presentation: ${name}`));
    assert.ok(!html.includes('/*__FORGE_PRESENTATION__*/'));
    assert.equal(scene.appState.viewBackgroundColor, theme.bg);
    assert.equal(scene.elements.find((el) => el.id === `c-${model.concepts[0].id}`).backgroundColor, theme.nodes[0]);
    for (const bg of [theme.bg, theme.card, theme.soft, ...theme.nodes]) {
      assert.ok(contrast(theme.ink, bg) >= 4.5, `${name}: body on ${bg}`);
      assert.ok(contrast(theme.muted, bg) >= 4.5, `${name}: secondary on ${bg}`);
    }
    assert.ok(contrast(theme.accent, '#ffffff') >= 4.5, `${name}: button`);
  }
});
