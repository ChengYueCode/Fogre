import { EmberError, CODES, isRecord } from './errors.mjs';
import { sha256, stableStringify } from './io.mjs';
import { layoutTree, estimateTextWidth } from './layout.mjs';
import { conceptDisplayTitle, relationDisplayLabel } from './state.mjs';
import { resolvePresentation } from './presentation.mjs';

const SCENE_SOURCE = 'ember skill (local deterministic exporter)';
const FONT_SIZE = 17;
const FONT_FAMILY = 5; // Excalifont in current Excalidraw; falls back safely elsewhere
const NODE_LINE_HEIGHT = 25;
const NODE_PAD_X = 12;
// Scene titles are wrapped, never truncated: a long learner title grows its box
// (layout keeps sibling rows disjoint) instead of dropping content with an ellipsis.
const SCENE_MAX_LINES = Number.POSITIVE_INFINITY;
// A single locked, invisible rectangle carries merge bookkeeping that Excalidraw
// drops from the top level (type/version/source/elements/appState/files only).
// See the merge documentation below for the persistence contract.
export const MANIFEST_ID = 'ember-manifest';

export const RELATION_STYLE = Object.freeze({
  prerequisite: { stroke: '#2857a4', strokeStyle: 'dashed', dashLabel: '前置' },
  cause: { stroke: '#805200', strokeStyle: 'solid', dashLabel: '因果' },
  contrast: { stroke: '#a13f48', strokeStyle: 'dashed', dashLabel: '对比' },
  application: { stroke: '#236044', strokeStyle: 'dotted', dashLabel: '应用' },
});


// Fields that participate in the per-field three-way merge. Each generated
// element stores a snapshot of these fields (`customData.ember.base`) taken
// from the freshly generated element, so a later rebuild can tell apart
// "the generator changed this" from "the learner changed this".
const TRACKED_FIELDS = Object.freeze([
  'type', 'x', 'y', 'width', 'height', 'angle',
  'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle',
  'roughness', 'opacity', 'roundness',
  'text', 'originalText', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign',
  'containerId', 'points', 'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead',
  'groupIds', 'boundElements', 'link', 'locked', 'isDeleted',
]);

// Only these fields carry authored meaning. Position/size/route changes are
// reported as normal merges, not as content conflicts.
const SEMANTIC_CONFLICT_FIELDS = new Set(['text', 'originalText']);

function hashInt(text, modulo = 2 ** 31) {
  return parseInt(sha256(text).slice(0, 12), 16) % modulo;
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function fieldEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function snapshotFields(element) {
  const out = {};
  for (const field of TRACKED_FIELDS) {
    if (element[field] !== undefined) out[field] = jsonClone(element[field]);
  }
  return out;
}

function displaySignature(element) {
  const copy = { ...element };
  delete copy.version;
  delete copy.versionNonce;
  delete copy.updated;
  delete copy.seed;
  delete copy.customData;
  return stableStringify(copy);
}

function baseElement(id, type, x, y, width, height) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#3b322a',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: hashInt(`${id}:seed`),
    version: 1,
    versionNonce: hashInt(`${id}:nonce`, 1000000),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function semFields(element) {
  const pick = {};
  for (const key of ['type', 'width', 'height', 'text', 'originalText', 'fontSize',
    'startArrowhead', 'endArrowhead', 'containerId']) {
    if (element[key] !== undefined) pick[key] = element[key];
  }
  if (Array.isArray(element.points)) pick.points = element.points.map(([x, y]) => [round1(x), round1(y)]);
  if (element.startBinding) pick.startBinding = simplifyBinding(element.startBinding);
  if (element.endBinding) pick.endBinding = simplifyBinding(element.endBinding);
  if (element.customData?.ember) {
    pick.ember = { kind: element.customData.ember.kind, conceptId: element.customData.ember.conceptId ?? null, relationId: element.customData.ember.relationId ?? null };
  }
  return pick;
}

function localFields(element) {
  const pick = { ...semFields(element), x: round1(element.x), y: round1(element.y) };
  for (const key of ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'angle', 'fontFamily', 'roundness']) {
    if (element[key] !== undefined) pick[key] = element[key];
  }
  return pick;
}

function simplifyBinding(binding) {
  const out = {};
  if (binding.elementId !== undefined) out.elementId = binding.elementId;
  if (Array.isArray(binding.fixedPoint)) out.fixedPoint = binding.fixedPoint.map(round1);
  return out;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

export function elementFingerprints(element) {
  return {
    sem: sha256(stableStringify(semFields(element))),
    local: sha256(stableStringify(localFields(element))),
  };
}

function emberMeta(element) {
  return element?.customData?.ember ?? null;
}

function withMeta(element, meta) {
  return {
    ...element,
    customData: {
      ...(element.customData ?? {}),
      ember: { ...(element.customData?.ember ?? {}), ...meta },
    },
  };
}

function textElement(id, text, x, y, width, height, options = {}) {
  const element = baseElement(id, 'text', x, y, width, height);
  return {
    ...element,
    strokeColor: options.color ?? '#2f2923',
    strokeWidth: 1,
    roughness: 1,
    text,
    originalText: text,
    fontSize: options.fontSize ?? FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: options.textAlign ?? 'center',
    verticalAlign: options.verticalAlign ?? 'middle',
    containerId: options.containerId ?? null,
    lineHeight: 1.25,
    baseline: 0,
  };
}

function rectangleElement(id, x, y, width, height, fill, roundness = 12) {
  const element = baseElement(id, 'rectangle', x, y, width, height);
  return {
    ...element,
    backgroundColor: fill,
    fillStyle: 'solid',
    strokeWidth: 2,
    roundness: { type: 3, value: roundness },
    boundElements: [],
  };
}

function arrowElement(id, start, points, options) {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  const element = baseElement(id, 'arrow', start.x, start.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return {
    ...element,
    strokeColor: options.strokeColor,
    strokeStyle: options.strokeStyle ?? 'solid',
    strokeWidth: options.strokeWidth ?? 2,
    roundness: { type: 2 },
    roughness: options.roughness ?? 1,
    points: points.map(([px, py]) => [round1(px), round1(py)]),
    lastCommittedPoint: null,
    startBinding: options.startBinding ?? null,
    endBinding: options.endBinding ?? null,
    startArrowhead: options.startArrowhead ?? null,
    endArrowhead: options.endArrowhead ?? 'arrow',
  };
}

function anchorPoint(box, fixedPoint) {
  return { x: box.x + box.width * fixedPoint[0], y: box.y + box.height * fixedPoint[1] };
}

function routeArrow(startBox, endBox) {
  const startCenter = { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 };
  const endCenter = { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height / 2 };
  const sameRow = Math.abs(startBox.y - endBox.y) < 4;
  const overlapX = Math.min(startBox.x + startBox.width, endBox.x + endBox.width) - Math.max(startBox.x, endBox.x);
  if (sameRow) {
    const leftToRight = startCenter.x <= endCenter.x;
    const startFp = leftToRight ? [1, 0.5] : [0, 0.5];
    const endFp = leftToRight ? [0, 0.5] : [1, 0.5];
    const start = anchorPoint(startBox, startFp);
    const end = anchorPoint(endBox, endFp);
    return {
      start, end,
      points: [[0, 0], [end.x - start.x, end.y - start.y]],
      startFixed: startFp, endFixed: endFp,
    };
  }
  const mostlyVertical = overlapX > 40 || Math.abs(startCenter.x - endCenter.x) < startBox.width * 0.7;
  if (mostlyVertical) {
    const downward = startCenter.y < endCenter.y;
    const startFp = downward ? [0.5, 1] : [0.5, 0];
    const endFp = downward ? [0.5, 0] : [0.5, 1];
    const start = anchorPoint(startBox, startFp);
    const end = anchorPoint(endBox, endFp);
    const midY = (start.y + end.y) / 2;
    const points = [[0, 0]];
    if (Math.abs(midY - start.y) > 2) points.push([0, midY - start.y]);
    if (Math.abs(end.x - start.x) > 2) points.push([end.x - start.x, midY - start.y]);
    points.push([end.x - start.x, end.y - start.y]);
    const compact = points.filter((point, index) => index === 0
      || Math.abs(point[0] - points[index - 1][0]) > 0.5 || Math.abs(point[1] - points[index - 1][1]) > 0.5);
    return { start, end, points: compact, startFixed: startFp, endFixed: endFp };
  }
  const leftToRight = startCenter.x <= endCenter.x;
  const startFp = leftToRight ? [1, 0.5] : [0, 0.5];
  const endFp = leftToRight ? [0, 0.5] : [1, 0.5];
  const start = anchorPoint(startBox, startFp);
  const end = anchorPoint(endBox, endFp);
  return { start, end, points: [[0, 0], [end.x - start.x, end.y - start.y]], startFixed: startFp, endFixed: endFp };
}

function pathMidpoint(start, points) {
  let total = 0;
  const segments = [];
  let prev = start;
  for (const [dx, dy] of points.slice(1)) {
    const point = { x: start.x + dx, y: start.y + dy };
    const length = Math.hypot(point.x - prev.x, point.y - prev.y);
    segments.push({ from: prev, to: point, length });
    total += length;
    prev = point;
  }
  let target = total / 2;
  for (const segment of segments) {
    if (target <= segment.length || segment === segments[segments.length - 1]) {
      const t = segment.length === 0 ? 0 : target / segment.length;
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * t,
        y: segment.from.y + (segment.to.y - segment.from.y) * t,
      };
    }
    target -= segment.length;
  }
  return { x: start.x, y: start.y };
}

/**
 * Generate a complete Excalidraw element list from the model + state overlays.
 * IDs are stable and tied to concept/relation ids.
 *
 * Layout is measured against the *effective* titles (learner revisions when
 * present), so a long learner title grows its box instead of overflowing it.
 * Every arrow is reciprocally listed in both endpoint shapes' boundElements,
 * and each node's difficulty badge is grouped with the node so it follows a
 * drag in the real editor.
 */
export function generateScene(model, state) {
  const theme = resolvePresentation(model);
  const resolveTitle = (concept) => conceptDisplayTitle(model, state, concept.id);
  const layout = layoutTree(model, { resolveTitle, maxLines: SCENE_MAX_LINES });
  const elements = [];
  const meta = (kind, extra = {}) => ({ kind, generated: true, modelId: model.id, ...extra });
  const rectById = new Map();
  const arrowRefs = new Map();

  const addArrowRef = (conceptId, arrowId) => {
    if (!arrowRefs.has(conceptId)) arrowRefs.set(conceptId, []);
    arrowRefs.get(conceptId).push(arrowId);
  };

  // title + goal
  const titleWidth = Math.max(320, estimateTextWidth(model.title, 24));
  const titleEl = textElement('t-scene-title', model.title, layout.bounds.minX, layout.bounds.minY - 116,
    titleWidth, 34, { fontSize: 24, color: theme.ink, textAlign: 'left', verticalAlign: 'top' });
  elements.push(withMeta(titleEl, meta('title')));
  const goalEl = textElement('t-scene-goal', `目标：${model.goal}`, layout.bounds.minX, layout.bounds.minY - 74,
    Math.max(360, Math.min(900, estimateTextWidth(`目标：${model.goal}`, 15) + 20)), 24,
    { fontSize: 15, color: theme.muted, textAlign: 'left', verticalAlign: 'top' });
  elements.push(withMeta(goalEl, meta('goal')));

  // nodes
  for (const conceptId of model.order) {
    const box = layout.nodes[conceptId];
    const concept = model.byId.get(conceptId);
    const fill = theme.nodes[Math.min(box.depth, theme.nodes.length - 1)];
    const rectId = `c-${conceptId}`;
    const textId = `t-${conceptId}`;
    const badgeId = `d-${conceptId}`;
    const groupId = `g-${conceptId}`;
    const rect = withMeta(rectangleElement(rectId, box.x, box.y, box.width, box.height, fill), meta('node', { conceptId }));
    rect.strokeColor = theme.accent;
    rect.groupIds = [groupId];
    elements.push(rect);
    rectById.set(conceptId, rect);

    const lines = box.lines;
    const textHeight = Math.max(NODE_LINE_HEIGHT, lines.length * NODE_LINE_HEIGHT);
    const text = textElement(textId, lines.join('\n'), box.x + NODE_PAD_X, box.y + (box.height - textHeight) / 2,
      box.width - NODE_PAD_X * 2, textHeight, { containerId: rectId, verticalAlign: 'middle', color: theme.ink });
    text.height = textHeight;
    text.groupIds = [groupId];
    elements.push(withMeta(text, meta('node-text', { conceptId })));

    const difficulty = textElement(badgeId, `难度 ${concept.difficulty}`, box.x + box.width - 62, box.y + 4,
      54, 18, { fontSize: 11, color: theme.muted, textAlign: 'right', verticalAlign: 'top' });
    difficulty.groupIds = [groupId];
    elements.push(withMeta(difficulty, meta('difficulty', { conceptId })));

    if (concept.parentId !== null) {
      const parentBox = layout.nodes[concept.parentId];
      const route = routeArrow(parentBox, box);
      const arrowId = `e-parent-${conceptId}`;
      const arrow = arrowElement(arrowId, route.start, route.points, {
        strokeColor: theme.muted,
        strokeStyle: 'solid',
        strokeWidth: 2,
        startBinding: { elementId: `c-${concept.parentId}`, focus: 0, gap: 4, fixedPoint: route.startFixed },
        endBinding: { elementId: rectId, focus: 0, gap: 4, fixedPoint: route.endFixed },
      });
      elements.push(withMeta(arrow, meta('parent-edge', { conceptId })));
      addArrowRef(concept.parentId, arrowId);
      addArrowRef(conceptId, arrowId);
    }
  }

  // typed cross relations
  for (const relation of model.relations) {
    const fromBox = layout.nodes[relation.from];
    const toBox = layout.nodes[relation.to];
    const style = RELATION_STYLE[relation.type];
    const route = routeArrow(fromBox, toBox);
    const arrowId = `e-${relation.id}`;
    const arrow = arrowElement(arrowId, route.start, route.points, {
      strokeColor: style.stroke,
      strokeStyle: style.strokeStyle,
      strokeWidth: 2,
      startBinding: { elementId: `c-${relation.from}`, focus: 0, gap: 4, fixedPoint: route.startFixed },
      endBinding: { elementId: `c-${relation.to}`, focus: 0, gap: 4, fixedPoint: route.endFixed },
    });
    elements.push(withMeta(arrow, meta('relation-edge', { relationId: relation.id, relationType: relation.type })));
    addArrowRef(relation.from, arrowId);
    addArrowRef(relation.to, arrowId);

    const label = relationDisplayLabel(model, state, relation.id) || relation.label || style.dashLabel;
    const mid = pathMidpoint(route.start, route.points);
    const labelWidth = Math.max(72, Math.min(280, estimateTextWidth(label, 13) + 24));
    const labelEl = textElement(`l-${relation.id}`, label, mid.x - labelWidth / 2, mid.y - 12,
      labelWidth, 22, { fontSize: 13, color: style.stroke });
    elements.push(withMeta(labelEl, meta('relation-label', { relationId: relation.id, relationType: relation.type })));
  }

  // reciprocal bindings: arrows must appear on the shapes they touch
  for (const [conceptId, rect] of rectById) {
    const textId = `t-${conceptId}`;
    const arrows = (arrowRefs.get(conceptId) ?? []).map((id) => ({ type: 'arrow', id }));
    rect.boundElements = [{ type: 'text', id: textId }, ...arrows];
  }

  // legend
  const legendY = layout.bounds.maxY + 70;
  const legendItems = [
    { key: 'parent', label: '包含（父子层级）', color: theme.muted, strokeStyle: 'solid' },
    ...Object.entries(RELATION_STYLE).map(([key, style]) => ({ key, label: style.dashLabel, color: style.stroke, strokeStyle: style.strokeStyle })),
  ];
  let legendX = layout.bounds.minX;
  elements.push(withMeta(textElement('t-legend', '图例', legendX, legendY - 28, 60, 20, { fontSize: 14, textAlign: 'left' }), meta('legend')));
  for (const item of legendItems) {
    const arrowId = `legend-${item.key}`;
    const start = { x: legendX, y: legendY };
    const arrow = arrowElement(arrowId, start, [[0, 0], [46, 0]], {
      strokeColor: item.color,
      strokeStyle: item.strokeStyle,
      strokeWidth: 2,
      startArrowhead: null,
      endArrowhead: 'arrow',
    });
    elements.push(withMeta(arrow, meta('legend-item', { legendKey: item.key })));
    const label = textElement(`legend-label-${item.key}`, item.label, legendX + 54, legendY - 10,
      Math.max(90, estimateTextWidth(item.label, 13) + 16), 20, { fontSize: 13, textAlign: 'left', color: item.color });
    elements.push(withMeta(label, meta('legend-label', { legendKey: item.key })));
    legendX += 54 + Math.max(90, estimateTextWidth(item.label, 13) + 16) + 34;
  }

  // attach per-field baselines + build fingerprint to every generated element
  return elements.map((element) => withMeta(element, {
    base: snapshotFields(element),
    modelId: model.id,
    builtFingerprint: model.modelFingerprint,
    builtRevision: state?.revision ?? null,
  }));
}

/**
 * The merge contract.
 *
 * Excalidraw's serializeAsJSON only keeps `type/version/source/elements/appState/files`
 * and drops `isDeleted` elements, so neither the deleted element nor any
 * top-level customData survives an export/import round trip. To preserve user
 * deletions we persist a manifest inside one locked, invisible rectangle
 * (`ember-manifest`), whose own customData *is* preserved by Excalidraw:
 *
 *   customData.ember.generatedIds  every generated element id ever emitted
 *   customData.ember.tombstones    generated ids the learner deleted
 *
 * On every build we read that manifest, treat generated ids that are missing
 * now but still wanted by the model as tombstones, and never resurrect a
 * tombstoned id. Genuinely new ids (absent from `generatedIds`) are added.
 * A scene with no ember metadata, or metadata for another model, is refused
 * rather than silently merged.
 */
export function buildScene(model, state, previousScene = null) {
  const fresh = generateScene(model, state);
  const conflicts = [];
  const warnings = [];

  if (!previousScene) {
    const generatedIds = new Set(fresh.map((el) => el.id));
    const manifest = makeManifest(model, state, generatedIds, []);
    const elements = sceneOrder(collectElements(fresh, new Map(fresh.map((el) => [el.id, el])), manifest));
    return {
      scene: wrapScene(elements, model, null),
      conflicts,
      warnings,
      generated: fresh.length,
      kept: 0,
      tombstones: [],
    };
  }

  validateSceneStructure(previousScene);
  const prevElements = previousScene.elements.filter((el) => el && el.isDeleted !== true);
  const sceneModelId = readSceneModelId(prevElements);
  const hasEmberMeta = prevElements.some((el) => emberMeta(el)?.generated);
  if (sceneModelId && sceneModelId !== model.id) {
    throw new EmberError(CODES.SCENE,
      `已有场景属于模型 ${sceneModelId}，当前模型是 ${model.id}；拒绝静默合并，请显式指定 --scene 或移除旧场景`);
  }
  if (!sceneModelId && !hasEmberMeta && prevElements.length > 0) {
    throw new EmberError(CODES.SCENE, '已有场景不含 ember 元数据，无法确认身份；拒绝与学习模型静默合并');
  }

  const prevById = new Map(prevElements.map((el) => [el.id, el]));
  const freshById = new Map(fresh.map((el) => [el.id, el]));
  const merged = new Map();
  let keptUserElements = 0;

  const prevGeneratedIds = new Set();
  const tombstones = new Set();
  for (const el of prevElements) {
    const m = emberMeta(el);
    if (!m?.generated) continue;
    if (el.id !== MANIFEST_ID) prevGeneratedIds.add(el.id);
    if (Array.isArray(m.generatedIds)) m.generatedIds.forEach((id) => prevGeneratedIds.add(id));
    if (Array.isArray(m.tombstones)) m.tombstones.forEach((id) => tombstones.add(id));
  }

  for (const prev of prevElements) {
    if (prev.id === MANIFEST_ID) continue;
    const meta = emberMeta(prev);
    const freshEl = freshById.get(prev.id);
    if (!meta?.generated || !freshEl) {
      if (freshEl) {
        conflicts.push({
          id: prev.id,
          kind: 'element-id-collision',
          message: `场景里已有非自动生成的元素 ${prev.id}，与自动生成元素冲突；保留场景中的版本`,
          kept: prev.id,
          incoming: prev.id,
        });
      }
      merged.set(prev.id, prev);
      if (!freshEl) keptUserElements += 1;
      continue;
    }
    merged.set(prev.id, mergeGeneratedElement(prev, freshEl, meta, model, conflicts));
  }

  // deletions: a previously generated id that is missing but still wanted
  const nowDeleted = [...prevGeneratedIds].filter((id) => !prevById.has(id) && freshById.has(id));
  for (const id of nowDeleted) tombstones.add(id);

  // genuinely new generated elements only; tombstoned ids stay gone
  for (const el of fresh) {
    if (merged.has(el.id) || prevById.has(el.id)) continue;
    if (prevGeneratedIds.has(el.id) || tombstones.has(el.id)) continue;
    merged.set(el.id, el);
  }

  if (nowDeleted.length > 0) {
    warnings.push({
      code: 'preserved-deletions',
      message: `保留了学习者此前删除的 ${nowDeleted.length} 个图元，未因模型更新而复原`,
      ids: nowDeleted.slice().sort(),
    });
  }

  cohereGenerated(merged, warnings);

  // bump versions only when the rendered content actually changed
  for (const [id, element] of merged) {
    merged.set(id, finalizeElement(prevById.get(id) ?? null, element, model, state));
  }

  const generatedIds = new Set([...prevGeneratedIds, ...fresh.map((el) => el.id)]);
  const manifest = makeManifest(model, state, generatedIds, [...tombstones]);
  const elements = sceneOrder(collectElements(fresh, merged, manifest));

  return {
    scene: wrapScene(elements, model, previousScene),
    conflicts,
    warnings,
    generated: fresh.length,
    kept: keptUserElements,
    tombstones: [...tombstones].sort(),
  };
}

function validateSceneStructure(scene) {
  if (!isRecord(scene) || scene.type !== 'excalidraw') {
    throw new EmberError(CODES.SCENE, '已有场景不是 excalidraw 文件，拒绝覆盖');
  }
  if (scene.version !== undefined && scene.version !== 2) {
    throw new EmberError(CODES.SCENE, `已有场景 version=${scene.version}，只支持 v2`);
  }
  if (!Array.isArray(scene.elements)) {
    throw new EmberError(CODES.SCENE, '已有场景缺少 elements 数组');
  }
  const ids = new Set();
  for (const el of scene.elements) {
    if (!isRecord(el) || typeof el.id !== 'string' || el.id === '') {
      throw new EmberError(CODES.SCENE, '已有场景包含缺少 id 的元素');
    }
    if (ids.has(el.id)) throw new EmberError(CODES.SCENE, `已有场景元素 id 重复：${el.id}`);
    ids.add(el.id);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (el[key] !== undefined && !Number.isFinite(el[key])) {
        throw new EmberError(CODES.SCENE, `已有场景元素 ${el.id} 的 ${key} 不是有限数值`);
      }
    }
  }
  return ids;
}

function readSceneModelId(elements) {
  for (const el of elements) {
    const m = emberMeta(el);
    if (m?.modelId) return m.modelId;
  }
  return null;
}

function mergeGeneratedElement(prev, fresh, meta, model, conflicts) {
  const base = isRecord(meta.base) ? meta.base : null;
  const merged = { ...prev };
  const conflictFields = [];

  for (const field of TRACKED_FIELDS) {
    if (!(field in fresh)) continue;
    const freshVal = fresh[field];
    const prevVal = prev[field];
    const hasBase = Boolean(base) && Object.prototype.hasOwnProperty.call(base, field);
    const userChanged = hasBase ? !fieldEqual(prevVal, base[field]) : true;
    const modelChanged = hasBase ? !fieldEqual(freshVal, base[field]) : true;
    let value;
    if (hasBase && !userChanged) {
      value = freshVal; // generator owns this field
    } else if (hasBase && (!modelChanged || fieldEqual(prevVal, freshVal))) {
      value = prevVal; // learner owns this field
    } else {
      value = prevVal; // both moved: keep the learner's version and report it
      if (SEMANTIC_CONFLICT_FIELDS.has(field) && !fieldEqual(prevVal, freshVal)) conflictFields.push(field);
    }
    if (value === undefined) delete merged[field];
    else merged[field] = jsonClone(value);
  }

  merged.customData = {
    ...(prev.customData ?? {}),
    ember: {
      ...(prev.customData?.ember ?? {}),
      ...(fresh.customData?.ember ?? {}),
      base: snapshotFields(fresh),
      modelId: model.id,
      generated: true,
      builtFingerprint: model.modelFingerprint,
    },
  };

  if (conflictFields.length > 0) {
    conflicts.push({
      id: prev.id,
      kind: meta.kind ?? 'element',
      conceptId: meta.conceptId ?? null,
      relationId: meta.relationId ?? null,
      fields: conflictFields,
      message: `自动元素 ${prev.id} 的 ${conflictFields.join('、')} 与学习内容改动冲突，保留场景中的版本`,
      kept: prev.id,
      incoming: prev.id,
    });
  }
  return merged;
}

function findBoundText(byId, node) {
  for (const entry of node.boundElements ?? []) {
    if (entry.type !== 'text') continue;
    const text = byId.get(entry.id);
    if (text && text.containerId === node.id) return text;
  }
  return null;
}

function repositionText(text, node) {
  const lines = String(text.text ?? '').split('\n');
  const textHeight = Math.max(NODE_LINE_HEIGHT, lines.length * NODE_LINE_HEIGHT);
  const neededHeight = textHeight + NODE_PAD_X * 2;
  if (node.height < neededHeight) node.height = neededHeight;
  text.x = node.x + NODE_PAD_X;
  text.y = node.y + (node.height - textHeight) / 2;
  text.height = textHeight;
  text.width = Math.max(40, node.width - NODE_PAD_X * 2);
}

/**
 * Keep derived geometry coherent after user edits: bound text stays centred in
 * its node, difficulty badges follow their node, generated arrows re-route to
 * their current endpoint boxes, and dangling bindings are dropped.
 */
function cohereGenerated(merged, warnings) {
  const byId = new Map(merged);
  const drop = new Set();

  for (const element of merged.values()) {
    const meta = emberMeta(element);
    if (!meta?.generated) continue;
    if (meta.kind === 'node') {
      const text = findBoundText(byId, element);
      if (text) repositionText(text, element);
    } else if (meta.kind === 'difficulty') {
      const node = byId.get(`c-${meta.conceptId}`);
      if (node) {
        element.x = node.x + node.width - 62;
        element.y = node.y + 4;
      } else {
        drop.add(element.id);
      }
    }
  }

  for (const element of merged.values()) {
    const meta = emberMeta(element);
    if (!meta?.generated) continue;
    if (meta.kind !== 'parent-edge' && meta.kind !== 'relation-edge') continue;
    const startId = element.startBinding?.elementId;
    const endId = element.endBinding?.elementId;
    const startBox = byId.get(startId);
    const endBox = byId.get(endId);
    if (!startBox || !endBox) { drop.add(element.id); continue; }
    const route = routeArrow(startBox, endBox);
    element.x = route.start.x;
    element.y = route.start.y;
    element.points = route.points;
    element.width = Math.max(...route.points.map(([px]) => px)) - Math.min(...route.points.map(([px]) => px));
    element.height = Math.max(...route.points.map(([, py]) => py)) - Math.min(...route.points.map(([, py]) => py));
    element.startBinding = { ...(element.startBinding ?? {}), elementId: startId, fixedPoint: route.startFixed };
    element.endBinding = { ...(element.endBinding ?? {}), elementId: endId, fixedPoint: route.endFixed };
  }

  for (const id of drop) merged.delete(id);
  if (drop.size > 0) {
    warnings.push({
      code: 'dropped-orphan-element',
      message: `端点缺失的自动图元已移除：${[...drop].sort().join(', ')}`,
      ids: [...drop].sort(),
    });
  }

  // drop bound text whose container is gone, then clean reciprocal references
  for (const element of [...merged.values()]) {
    if (element.containerId && !merged.has(element.containerId)) merged.delete(element.id);
  }
  for (const element of merged.values()) {
    const meta = emberMeta(element);
    if (!meta?.generated || meta.kind !== 'node') continue;
    element.boundElements = (element.boundElements ?? []).filter((entry) => {
      if (entry.type === 'text') {
        const text = merged.get(entry.id);
        return Boolean(text) && text.containerId === element.id;
      }
      if (entry.type === 'arrow') {
        const arrow = merged.get(entry.id);
        return Boolean(arrow) && (arrow.startBinding?.elementId === element.id || arrow.endBinding?.elementId === element.id);
      }
      return false;
    });
  }
}

function finalizeElement(prev, candidate, model, state) {
  const next = { ...candidate };
  next.customData = {
    ...(candidate.customData ?? {}),
    ember: {
      ...(candidate.customData?.ember ?? {}),
      modelId: model.id,
      generated: true,
      builtFingerprint: model.modelFingerprint,
      builtRevision: state?.revision ?? null,
    },
  };
  if (!prev) return next;
  if (displaySignature(prev) === displaySignature(next)) {
    next.version = prev.version ?? next.version;
    next.versionNonce = prev.versionNonce ?? next.versionNonce;
    next.updated = prev.updated ?? next.updated;
    next.seed = prev.seed ?? next.seed;
  } else {
    next.version = (prev.version ?? 1) + 1;
    next.versionNonce = hashInt(`${next.id}:${next.version}:${displaySignature(next)}`, 1000000);
    next.updated = (prev.updated ?? 1) + 1;
  }
  return next;
}

function makeManifest(model, state, generatedIds, tombstones) {
  const element = rectangleElement(MANIFEST_ID, 0, 0, 1, 1, 'transparent', 0);
  element.opacity = 0;
  element.locked = true;
  element.boundElements = [];
  return withMeta(element, {
    kind: 'manifest',
    presentationBackground: resolvePresentation(model).bg,
    generated: true,
    modelId: model.id,
    generatedIds: [...generatedIds].sort(),
    tombstones: [...tombstones].sort(),
    base: snapshotFields(element),
    builtFingerprint: model.modelFingerprint,
    builtRevision: state?.revision ?? null,
  });
}

function collectElements(fresh, merged, manifest) {
  const out = [];
  const emitted = new Set();
  for (const freshEl of fresh) {
    const element = merged.get(freshEl.id);
    if (element && !emitted.has(element.id)) {
      out.push(element);
      emitted.add(element.id);
    }
  }
  for (const element of merged.values()) {
    if (!emitted.has(element.id)) {
      out.push(element);
      emitted.add(element.id);
    }
  }
  out.push(manifest);
  return out;
}

function sceneOrder(elements) {
  const result = [];
  const emitted = new Set();
  const textByContainer = new Map();
  for (const element of elements) {
    if (element.containerId) textByContainer.set(element.containerId, element);
  }
  for (const element of elements) {
    if (emitted.has(element.id)) continue;
    if (element.containerId && textByContainer.get(element.containerId) === element) continue;
    result.push(element);
    emitted.add(element.id);
    const boundText = textByContainer.get(element.id);
    if (boundText && !emitted.has(boundText.id)) {
      result.push(boundText);
      emitted.add(boundText.id);
    }
  }
  for (const element of elements) {
    if (!emitted.has(element.id)) {
      result.push(element);
      emitted.add(element.id);
    }
  }
  return result;
}

function wrapScene(elements, model, previousScene) {
  const background = resolvePresentation(model).bg;
  const oldBackground = previousScene?.appState?.viewBackgroundColor;
  const oldBase = emberMeta(previousScene?.elements?.find((el) => el.id === MANIFEST_ID))?.presentationBackground ?? '#faf6ef';
  const appState = {
    gridSize: null,
    ...(previousScene?.appState ?? {}),
    viewBackgroundColor: oldBackground && oldBackground !== oldBase ? oldBackground : background,
  };
  return {
    type: 'excalidraw',
    version: 2,
    source: SCENE_SOURCE,
    elements,
    appState,
    files: previousScene?.files ?? {},
    customData: {
      ember: {
        modelId: model.id,
        modelFingerprint: model.modelFingerprint,
        generatedAt: 'deterministic',
      },
    },
  };
}

export function sceneToSvg(scene, padding = 48) {
  const elements = scene.elements.filter((el) => el.isDeleted !== true && emberMeta(el)?.kind !== 'manifest');
  const attr = (value) => escapeXml(String(value ?? ''));
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? round1(value) : fallback);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const el of elements) {
    if (el.type !== 'rectangle' && el.type !== 'text' && el.type !== 'arrow') continue;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 400; maxY = 300;
  }
  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="${Math.round(maxX - minX)}" height="${Math.round(maxY - minY)}" font-family="system-ui, 'Noto Sans SC', sans-serif">`);
  parts.push(`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${attr(scene.appState?.viewBackgroundColor ?? '#f1f5fa')}"/>`);
  parts.push('<defs><marker id="ember-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>');
  for (const el of elements) {
    if (el.type === 'rectangle') {
      parts.push(`<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.width)}" height="${num(el.height)}" rx="12" fill="${attr(el.backgroundColor)}" stroke="${attr(el.strokeColor)}" stroke-width="2"/>`);
    }
  }
  for (const el of elements) {
    if (el.type === 'arrow') {
      const dash = el.strokeStyle === 'dashed' ? ' stroke-dasharray="8 6"' : el.strokeStyle === 'dotted' ? ' stroke-dasharray="2 5"' : '';
      const points = [[el.x, el.y], ...(el.points ?? []).slice(1).map(([dx, dy]) => [el.x + dx, el.y + dy])];
      const d = points.map(([px, py], index) => `${index === 0 ? 'M' : 'L'} ${num(px)} ${num(py)}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${attr(el.strokeColor)}" stroke-width="${num(el.strokeWidth, 2)}"${dash} marker-end="url(#ember-arrow)"/>`);
    }
  }
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const lines = String(el.text ?? '').split('\n');
    const anchor = el.textAlign === 'left' ? 'start' : el.textAlign === 'right' ? 'end' : 'middle';
    const anchorX = el.textAlign === 'left' ? el.x : el.textAlign === 'right' ? el.x + el.width : el.x + el.width / 2;
    const lineHeight = (el.fontSize ?? 17) * 1.3;
    const startY = el.y + (el.height - lines.length * lineHeight) / 2 + lineHeight * 0.8;
    parts.push(`<text x="${num(anchorX)}" y="${num(startY)}" font-size="${num(el.fontSize, 17)}" fill="${attr(el.strokeColor)}" text-anchor="${attr(anchor)}">`);
    lines.forEach((line, index) => {
      parts.push(`<tspan x="${num(anchorX)}" dy="${index === 0 ? 0 : num(lineHeight)}">${escapeXml(line)}</tspan>`);
    });
    parts.push('</text>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
