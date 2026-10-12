import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import { createState, applyTitleRevision } from '../skill/forge/scripts/lib/state.mjs';
import { generateScene, buildScene, sceneToSvg, MANIFEST_ID } from '../skill/forge/scripts/lib/scene.mjs';
import { layoutTree } from '../skill/forge/scripts/lib/layout.mjs';

function rawModel(overrides = {}) {
  const base = {
    schemaVersion: 1,
    id: 'demo-model',
    title: '演示主题',
    goal: '能解释核心机制并做一次应用',
    summary: '用于场景回归测试的模型',
    concepts: [
      { id: 'root', title: '根概念', parentId: null, difficulty: 1, explanation: '根解释', example: '根例子', misconception: '' },
      { id: 'child', title: '子概念', parentId: 'root', difficulty: 2, explanation: '子解释', example: '子例子', misconception: '子误解' },
      { id: 'leaf', title: '叶概念', parentId: 'child', difficulty: 3, explanation: '叶解释', example: '叶例子', misconception: '' },
    ],
    relations: [
      { id: 'rel-root-leaf', from: 'root', to: 'leaf', type: 'cause', label: '根影响叶' },
      { id: 'rel-child-leaf', from: 'child', to: 'leaf', type: 'contrast', label: '子与叶对比' },
    ],
    prompts: [],
    sources: [],
    limitations: [],
  };
  return { ...base, ...overrides };
}

function withChangedGoal(model, goal) {
  return normalizeModel({ ...JSON.parse(JSON.stringify(pickRaw(model))), goal });
}

// modelToJson would be nicer, but models created by normalizeModel keep all
// schema fields enumerable, so a plain spread plus override works for fixtures.
function pickRaw(model) {
  return {
    schemaVersion: model.schemaVersion,
    id: model.id,
    title: model.title,
    goal: model.goal,
    summary: model.summary,
    concepts: model.concepts,
    relations: model.relations,
    prompts: model.prompts,
    sources: model.sources,
    limitations: model.limitations,
  };
}

function byId(elements) {
  return new Map(elements.map((el) => [el.id, el]));
}

function excalidrawRoundTrip(scene, deletedIds = []) {
  // mirror Excalidraw serializeAsJSON: deleted elements and top-level extras vanish
  const copy = JSON.parse(JSON.stringify(scene));
  copy.elements = copy.elements.filter((el) => !deletedIds.includes(el.id));
  delete copy.customData;
  return copy;
}

test('generated scene keeps arrows reciprocally bound and badges grouped', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const elements = generateScene(model, state);
  const map = byId(elements);

  for (const element of elements) {
    if (element.type !== 'arrow') continue;
    const kind = element.customData?.ember?.kind;
    if (kind !== 'parent-edge' && kind !== 'relation-edge') continue;
    assert.ok(element.startBinding, `${element.id} has a start binding`);
    assert.ok(element.endBinding, `${element.id} has an end binding`);
    const start = map.get(element.startBinding.elementId);
    const end = map.get(element.endBinding.elementId);
    assert.ok(start, `start shape exists for ${element.id}`);
    assert.ok(end, `end shape exists for ${element.id}`);
    assert.ok(
      (start.boundElements ?? []).some((b) => b.type === 'arrow' && b.id === element.id),
      `${element.id} listed on start shape ${start.id}`,
    );
    assert.ok(
      (end.boundElements ?? []).some((b) => b.type === 'arrow' && b.id === element.id),
      `${element.id} listed on end shape ${end.id}`,
    );
  }

  const root = map.get('c-root');
  const badge = map.get('d-root');
  assert.ok(root.boundElements.some((b) => b.type === 'text' && b.id === 't-root'));
  // the parent edge and the cross relation both touch root
  assert.ok(root.boundElements.some((b) => b.type === 'arrow' && b.id === 'e-parent-child'));
  assert.ok(root.boundElements.some((b) => b.type === 'arrow' && b.id === 'e-rel-root-leaf'));
  assert.deepEqual(badge.groupIds, root.groupIds);
  assert.ok(badge.groupIds.includes('g-root'));
  assert.ok(map.get('t-root').groupIds.includes('g-root'));
});

test('long learner titles grow their boxes and keep text inside', () => {
  const model = normalizeModel(rawModel());
  const learnerTitle = '这是一个由学习者改写的很长很长的标题'.repeat(20);
  const { state } = applyTitleRevision(createState(model), model, { conceptId: 'child', title: learnerTitle });

  const layout = layoutTree(model, {
    resolveTitle: (concept) => (concept.id === 'child' ? learnerTitle : concept.title),
    maxLines: Infinity,
  });
  const box = layout.nodes.child;
  assert.ok(box.height > 54, 'effective title produces a taller box');

  const map = byId(generateScene(model, state));
  const rect = map.get('c-child');
  const text = map.get('t-child');
  assert.equal(rect.height, box.height);
  assert.ok(rect.height >= text.height, 'text height fits the box');
  assert.ok(text.width <= rect.width, 'text width fits the box');
  assert.ok(!text.text.includes('…'), 'full learner title is preserved, not truncated');
  assert.ok(rect.height >= text.text.split('\n').length * 25);
});

test('per-field merge preserves a moved node when its title grows', () => {
  const model1 = normalizeModel(rawModel());
  const state1 = createState(model1);
  const built = buildScene(model1, state1).scene;

  const movedX = built.elements.find((el) => el.id === 'c-child').x + 100;
  for (const id of ['c-child', 't-child', 'd-child']) {
    const element = built.elements.find((el) => el.id === id);
    element.x += 100;
  }

  const concepts = JSON.parse(JSON.stringify(rawModel().concepts)).map((c) => (
    c.id === 'child' ? { ...c, title: '子概念（模型侧变长了很多的标题）' } : c
  ));
  const model2 = normalizeModel(rawModel({ concepts }));
  const state2 = createState(model2);

  const result = buildScene(model2, state2, built);
  const child = result.scene.elements.find((el) => el.id === 'c-child');
  const text = result.scene.elements.find((el) => el.id === 't-child');
  const badge = result.scene.elements.find((el) => el.id === 'd-child');

  assert.equal(child.x, movedX, 'learner move is preserved');
  assert.ok(child.height >= 54);
  assert.ok(text.x >= child.x && text.x + text.width <= child.x + child.width + 1, 'bound text follows the moved box');
  assert.ok(badge.x >= child.x && badge.x <= child.x + child.width, 'badge follows the moved box');
  assert.equal(result.conflicts.length, 0, 'a move plus a generated resize is not a semantic conflict');
});

test('a genuine semantic conflict is reported and the learner text is kept', () => {
  const model1 = normalizeModel(rawModel());
  const built = buildScene(model1, createState(model1)).scene;
  const text = built.elements.find((el) => el.id === 't-child');
  text.text = '学习者手改的标题';
  text.originalText = '学习者手改的标题';

  const concepts = JSON.parse(JSON.stringify(rawModel().concepts)).map((c) => (
    c.id === 'child' ? { ...c, title: '模型侧也改了标题' } : c
  ));
  const model2 = normalizeModel(rawModel({ concepts }));
  const result = buildScene(model2, createState(model2), built);
  const mergedText = result.scene.elements.find((el) => el.id === 't-child');

  assert.equal(mergedText.text, '学习者手改的标题');
  assert.ok(result.conflicts.some((c) => Array.isArray(c.fields) && c.fields.includes('text')));
});

test('deletions survive a model update even after Excalidraw drops them', () => {
  const model1 = normalizeModel(rawModel());
  const built = buildScene(model1, createState(model1)).scene;
  assert.ok(built.elements.some((el) => el.id === MANIFEST_ID), 'manifest is persisted in the scene');

  const roundTripped = excalidrawRoundTrip(built, ['c-leaf', 't-leaf']);
  assert.ok(!roundTripped.customData, 'top-level extras are gone, like Excalidraw');

  const model2 = withChangedGoal(model1, '只改了目标，不应复原被删节点');
  const result = buildScene(model2, createState(model2), roundTripped);
  const ids = new Set(result.scene.elements.map((el) => el.id));

  assert.ok(!ids.has('c-leaf'), 'deleted shape stays deleted');
  assert.ok(!ids.has('t-leaf'), 'deleted text stays deleted');
  assert.ok(result.warnings.some((w) => w.code === 'preserved-deletions'));
  assert.ok(result.tombstones.includes('c-leaf'));
});

test('genuinely new concepts are added alongside preserved deletions', () => {
  const model1 = normalizeModel(rawModel());
  const built = buildScene(model1, createState(model1)).scene;
  const roundTripped = excalidrawRoundTrip(built, ['c-leaf', 't-leaf']);

  const concepts = JSON.parse(JSON.stringify(rawModel().concepts));
  concepts.push({ id: 'extra', title: '新增概念', parentId: 'root', difficulty: 1, explanation: '新解释', example: '新例子', misconception: '' });
  const model3 = normalizeModel(rawModel({ concepts }));

  const result = buildScene(model3, createState(model3), roundTripped);
  const ids = new Set(result.scene.elements.map((el) => el.id));

  assert.ok(ids.has('c-extra'), 'new concept shape is added');
  assert.ok(ids.has('t-extra'), 'new concept text is added');
  assert.ok(!ids.has('c-leaf'), 'old deletion is still respected');
  assert.ok(ids.has('e-parent-extra'), 'new concept gets its parent edge');
});

test('no-op rebuild is byte-stable and does not mutate versions', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;
  const again = buildScene(model, state, built).scene;

  assert.deepEqual(again.elements, built.elements);
});

test('learner style edits survive an unrelated model change', () => {
  const model1 = normalizeModel(rawModel());
  const built = buildScene(model1, createState(model1)).scene;
  const rect = built.elements.find((el) => el.id === 'c-child');
  rect.backgroundColor = '#ff00aa';
  rect.strokeColor = '#00aaff';
  rect.roughness = 2;

  const model2 = withChangedGoal(model1, '只改目标，不改概念样式');
  const result = buildScene(model2, createState(model2), built);
  const merged = result.scene.elements.find((el) => el.id === 'c-child');

  assert.equal(merged.backgroundColor, '#ff00aa');
  assert.equal(merged.strokeColor, '#00aaff');
  assert.equal(merged.roughness, 2);
});

test('deleting a node drops its arrows and cleans reciprocal references', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;
  // user deletes the shape but leaves the arrow behind
  const roundTripped = excalidrawRoundTrip(built, ['c-child']);
  const result = buildScene(model, state, roundTripped);
  const ids = new Set(result.scene.elements.map((el) => el.id));

  assert.ok(!ids.has('c-child'));
  assert.ok(!ids.has('e-parent-child'), 'arrow whose endpoint is gone is dropped');
  for (const element of result.scene.elements) {
    for (const bound of element.boundElements ?? []) {
      assert.ok(ids.has(bound.id), `reciprocal reference ${bound.id} points at a present element`);
    }
  }
});

test('moving a node at rebuild time reroutes its arrows and keeps bindings', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;

  const child = built.elements.find((el) => el.id === 'c-child');
  const deltaX = 140;
  const deltaY = 60;
  for (const id of ['c-child', 't-child', 'd-child']) {
    const element = built.elements.find((el) => el.id === id);
    element.x += deltaX;
    element.y += deltaY;
  }

  const result = buildScene(model, state, built);
  const map = byId(result.scene.elements);
  const arrow = map.get('e-parent-child');
  const movedChild = map.get('c-child');
  const parent = map.get('c-root');

  assert.ok(arrow.startBinding.elementId === parent.id);
  assert.ok(arrow.endBinding.elementId === movedChild.id);
  assert.ok(movedChild.boundElements.some((b) => b.type === 'arrow' && b.id === arrow.id));

  const endAbs = { x: arrow.x + arrow.points.at(-1)[0], y: arrow.y + arrow.points.at(-1)[1] };
  assert.ok(endAbs.x >= movedChild.x - 1 && endAbs.x <= movedChild.x + movedChild.width + 1, 'end reattaches to moved node x');
  assert.ok(endAbs.y >= movedChild.y - 1 && endAbs.y <= movedChild.y + movedChild.height + 1, 'end reattaches to moved node y');

  const startAbs = { x: arrow.x + arrow.points[0][0], y: arrow.y + arrow.points[0][1] };
  assert.ok(startAbs.x >= parent.x - 1 && startAbs.x <= parent.x + parent.width + 1, 'start stays on the parent');
});

test('user-added free elements are preserved across rebuilds', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;
  built.elements.push({
    id: 'user-note',
    type: 'text',
    x: 10,
    y: 10,
    width: 120,
    height: 24,
    angle: 0,
    strokeColor: '#111111',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 7,
    version: 3,
    versionNonce: 9,
    isDeleted: false,
    boundElements: null,
    updated: 5,
    link: null,
    locked: false,
    text: '我自己写的备注',
    originalText: '我自己写的备注',
    fontSize: 17,
    fontFamily: 5,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    lineHeight: 1.25,
    baseline: 0,
  });

  const model2 = withChangedGoal(model, '换了目标也不该丢备注');
  const result = buildScene(model2, createState(model2), built);
  const note = result.scene.elements.find((el) => el.id === 'user-note');

  assert.ok(note, 'free element is kept');
  assert.equal(note.text, '我自己写的备注');
  assert.equal(note.version, 3, 'free element version is not touched');
  assert.ok(result.kept >= 1);
});

test('a legacy ember scene without modelId still merges', () => {
  const model1 = normalizeModel(rawModel());
  const built = buildScene(model1, createState(model1)).scene;
  const legacy = JSON.parse(JSON.stringify(built));
  for (const element of legacy.elements) {
    if (element.customData?.ember) delete element.customData.ember.modelId;
  }
  const model2 = withChangedGoal(model1, '旧场景也能续接新目标');
  const result = buildScene(model2, createState(model2), legacy);
  assert.equal(result.scene.elements.find((el) => el.id === 't-scene-goal').text, '目标：旧场景也能续接新目标');
});

test('an unrelated scene is refused instead of merged', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;

  const foreign = JSON.parse(JSON.stringify(built));
  for (const element of foreign.elements) {
    if (element.customData?.ember) element.customData.ember.modelId = 'some-other-model';
  }
  assert.throws(() => buildScene(model, state, foreign), (err) => err.code === 'E_SCENE');

  const noMeta = {
    type: 'excalidraw',
    version: 2,
    source: 'hand-made',
    elements: [{ id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 20, height: 20 }],
    appState: {},
    files: {},
  };
  assert.throws(() => buildScene(model, state, noMeta), (err) => err.code === 'E_SCENE');
});

test('scene structure and reference validation rejects malformed scenes', () => {
  const model = normalizeModel(rawModel());
  const state = createState(model);
  const built = buildScene(model, state).scene;

  const duplicate = JSON.parse(JSON.stringify(built));
  duplicate.elements.push({ ...duplicate.elements[0] });
  assert.throws(() => buildScene(model, state, duplicate), (err) => err.code === 'E_SCENE');

  const badGeometry = JSON.parse(JSON.stringify(built));
  badGeometry.elements[0].width = Number.NaN;
  assert.throws(() => buildScene(model, state, badGeometry), (err) => err.code === 'E_SCENE');

  const notV2 = JSON.parse(JSON.stringify(built));
  notV2.version = 1;
  assert.throws(() => buildScene(model, state, notV2), (err) => err.code === 'E_SCENE');
});

test('scene output is a complete editable v2 scene and svg export is safe', () => {
  const model = normalizeModel(rawModel({ title: '<script>alert(1)</script>' }));
  const state = createState(model);
  const scene = buildScene(model, state).scene;

  assert.equal(scene.type, 'excalidraw');
  assert.equal(scene.version, 2);
  assert.ok(Array.isArray(scene.elements));
  assert.ok(scene.appState);
  assert.ok(scene.files);
  assert.ok(scene.elements.every((el) => typeof el.id === 'string' && Number.isFinite(el.x) && Number.isFinite(el.y)));

  const svg = sceneToSvg(scene);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<script>alert'), 'title markup is escaped, not injected');
  assert.ok(svg.includes('&lt;script&gt;'), 'escaped title appears');
  assert.ok(!svg.includes(MANIFEST_ID), 'invisible manifest is excluded from export');

  // attribute values from a hand-edited scene must not break out of quotes
  const malicious = JSON.parse(JSON.stringify(scene));
  malicious.elements.find((el) => el.type === 'rectangle').backgroundColor = '"><script>bad()</script>';
  const evilSvg = sceneToSvg(malicious);
  assert.ok(!evilSvg.includes('<script>bad'), 'color attribute is escaped');
});

test('layout keeps boxes disjoint for deeper and wider trees', () => {
  const concepts = [{ id: 'root', title: '根', parentId: null, difficulty: 1, explanation: 'e', example: 'x', misconception: '' }];
  for (let i = 0; i < 4; i += 1) {
    concepts.push({ id: `b${i}`, title: `分支 ${i} 的一个比较长的标题`, parentId: 'root', difficulty: 2, explanation: 'e', example: 'x', misconception: '' });
    for (let j = 0; j < 3; j += 1) {
      concepts.push({ id: `b${i}-${j}`, title: `叶 ${i}-${j}`, parentId: `b${i}`, difficulty: 3, explanation: 'e', example: 'x', misconception: '' });
    }
  }
  const model = normalizeModel(rawModel({ concepts, relations: [] }));
  const { nodes } = layoutTree(model);
  const boxes = Object.entries(nodes);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [idA, a] = boxes[i];
      const [idB, b] = boxes[j];
      const disjoint = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(disjoint, `boxes ${idA} and ${idB} do not overlap`);
    }
  }
});
