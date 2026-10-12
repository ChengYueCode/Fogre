// Author-side content quality record (quality.json).
//
// This module is deliberately separate from the learner archive (state.json):
// a quality record describes whether the *material* is sufficient for an
// explicit learning outcome. It never touches mastery, schedules, attempts or
// content fingerprints. The tool validates structure and scope, and derives a
// status from what the author declared — it never promotes a record to "usable"
// because fields are filled or long enough.
import { EmberError, CODES, isRecord } from './errors.mjs';
import { fileExists, nowIso, readJson, sha256, stableStringify } from './io.mjs';
import {
  materialMapNormalize,
  materialMapReasons,
  materialMapSkeleton,
  materialMapToJson,
  materialMapView,
} from './material-map.mjs';

export const QUALITY_SCHEMA_VERSION = 1;
export const QUALITY_FILE = 'quality.json';

export const DIMENSIONS = Object.freeze([
  'goal-coverage',
  'prerequisite',
  'explanation-example',
  'boundary-misconception',
  'task-criteria',
  'sources-gaps',
]);

export const DIMENSION_RESULTS = Object.freeze(['covered', 'partial', 'missing', 'not-applicable']);
export const CONCEPT_ROLES = Object.freeze(['core', 'structural']);
export const SUPPLEMENT_ROLES = Object.freeze(['supplement', 'candidate']);
export const GAP_EFFECTS = Object.freeze(['blocking', 'supplementable']);
export const CONCEPT_STATUSES = Object.freeze(['usable', 'needs-supplement', 'still-gap', 'structure-only']);
export const OUTCOME_STATUSES = Object.freeze(['usable', 'needs-supplement', 'still-gap']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GOAL_SCOPE_CHANGED_REASON = '学习目标已更新，需要重新核对目标覆盖';

function assertNoDangerousKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new EmberError(CODES.SCHEMA, `质检字段名 ${key} 被拒绝，避免对象原型污染`, `${path}.${key}`);
    }
    assertNoDangerousKeys(value[key], `${path}.${key}`);
  }
}

function requireText(value, code, message, path) {
  if (typeof value !== 'string' || value.trim() === '') throw new EmberError(code, message, path);
  return value.trim();
}

function optionalText(value, code, message, path) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new EmberError(code, message, path);
  return value.trim();
}

export function goalFingerprint(model) {
  return sha256(`goal|${model.goal}`);
}

/**
 * The exact scope a quality record was written against: the model fingerprint,
 * the goal text, and every concept/prompt fingerprint the record references.
 * A record only stays valid while each of these still matches.
 */
export function computeScope(model) {
  const concepts = Object.create(null);
  for (const concept of model.concepts) concepts[concept.id] = model.conceptFingerprints[concept.id];
  const prompts = Object.create(null);
  for (const prompt of model.prompts) prompts[prompt.id] = model.promptFingerprints[prompt.id];
  return {
    modelFingerprint: model.modelFingerprint,
    goalFingerprint: goalFingerprint(model),
    concepts,
    prompts,
  };
}

/**
 * Build the empty authoring skeleton for the current model.
 *
 * The optional material map is prefilled with source identity and the exact
 * source snapshot only: version stays `null` (unknown) and every reading field
 * stays empty. An empty `checked` list means the reading range is unknown — the
 * skeleton never writes down a "read" claim the author did not make.
 */
export function buildTemplate(model, at = nowIso()) {
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    modelId: model.id,
    generatedAt: at,
    modelFingerprint: model.modelFingerprint,
    goalFingerprint: goalFingerprint(model),
    scope: computeScope(model),
    goals: [{
      id: 'g-1',
      outcome: model.goal,
      scope: computeScope(model),
      concepts: model.concepts.map((concept) => ({
        id: concept.id,
        role: null,
        dimensions: [],
        supplements: [],
        gaps: [],
      })),
    }],
    materialMap: materialMapSkeleton(model.sources),
  };
}

function normalizeDimension(item, path, { historical = false } = {}) {
  if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, 'dimension 必须是对象', path);
  const id = requireText(item.id, CODES.SCHEMA, 'dimension id 必填', `${path}.id`);
  if (!DIMENSIONS.includes(id)) {
    throw new EmberError(CODES.SCHEMA, `dimension id 只能是 ${DIMENSIONS.join('/')}，收到 ${JSON.stringify(id)}`, `${path}.id`);
  }
  if (!DIMENSION_RESULTS.includes(item.result)) {
    throw new EmberError(CODES.SCHEMA, `dimension result 只能是 ${DIMENSION_RESULTS.join('/')}，收到 ${JSON.stringify(item.result)}`, `${path}.result`);
  }
  // Every declared dimension needs a written rationale, including `missing` and
  // `not-applicable`: a record of six unargued not-applicable checks must not
  // read as a supported outcome with no traceable reading behind it.
  if (!historical) requireText(item.basis, CODES.SCHEMA,
    `${id} 结论必须写明依据（basis）；即使结果是 partial/missing/not-applicable 也要说明实际核对或缺失情况，字段齐全不等于通过`,
    `${path}.basis`);
  const supplementIds = item.supplementIds === undefined || item.supplementIds === null
    ? []
    : item.supplementIds;
  if (!Array.isArray(supplementIds) || supplementIds.some((value) => typeof value !== 'string')) {
    throw new EmberError(CODES.SCHEMA, 'supplementIds 必须是字符串数组', `${path}.supplementIds`);
  }
  return {
    id,
    result: item.result,
    basis: optionalText(item.basis, CODES.SCHEMA, 'basis 需要是字符串', `${path}.basis`),
    supplementIds: supplementIds.map((value) => value.trim()).filter((value) => value !== ''),
  };
}

function normalizeSupplement(item, path, model, ownerConceptId) {
  if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, 'supplement 必须是对象', path);
  const role = item.role;
  if (!SUPPLEMENT_ROLES.includes(role)) {
    throw new EmberError(CODES.SCHEMA, `supplement role 只能是 ${SUPPLEMENT_ROLES.join('/')}，收到 ${JSON.stringify(role)}`, `${path}.role`);
  }
  const supplement = {
    id: requireText(item.id, CODES.SCHEMA, 'supplement id 必填', `${path}.id`),
    role,
    conceptId: item.conceptId === undefined || item.conceptId === null
      ? ''
      : requireText(item.conceptId, CODES.SCHEMA, 'supplement conceptId 需要是非空字符串', `${path}.conceptId`),
    dimension: item.dimension === undefined || item.dimension === null
      ? ''
      : requireText(item.dimension, CODES.SCHEMA, 'supplement dimension 需要是非空字符串', `${path}.dimension`),
    sourceId: item.sourceId === undefined || item.sourceId === null
      ? ''
      : requireText(item.sourceId, CODES.SCHEMA, 'supplement sourceId 需要是非空字符串', `${path}.sourceId`),
    checkedRange: optionalText(item.checkedRange, CODES.SCHEMA, 'checkedRange 需要是字符串', `${path}.checkedRange`),
    access: optionalText(item.access, CODES.SCHEMA, 'access 需要是字符串', `${path}.access`),
    readAt: optionalText(item.readAt, CODES.SCHEMA, 'readAt 需要是字符串', `${path}.readAt`),
    note: optionalText(item.note, CODES.SCHEMA, 'note 需要是字符串', `${path}.note`),
  };
  // A supplement belongs to one concept and answers one named dimension. A
  // mismatched owner or an invented dimension would let a note for one concept
  // silently stand in for another.
  if (supplement.conceptId !== '' && supplement.conceptId !== ownerConceptId) {
    throw new EmberError(CODES.SCHEMA,
      `补充 ${supplement.id} 的 conceptId ${JSON.stringify(supplement.conceptId)} 与所属概念 ${ownerConceptId} 不一致`,
      `${path}.conceptId`);
  }
  supplement.conceptId = ownerConceptId;
  if (supplement.dimension !== '' && !DIMENSIONS.includes(supplement.dimension)) {
    throw new EmberError(CODES.SCHEMA,
      `补充 ${supplement.id} 的 dimension 只能是 ${DIMENSIONS.join('/')}，收到 ${JSON.stringify(supplement.dimension)}`,
      `${path}.dimension`);
  }
  if (supplement.role === 'supplement') {
    requireText(supplement.checkedRange, CODES.SCHEMA, '已读取的补充必须写明核对范围（checkedRange）', `${path}.checkedRange`);
    requireText(supplement.readAt, CODES.SCHEMA, '已读取的补充必须写明读取时间（readAt）', `${path}.readAt`);
    requireText(supplement.access, CODES.SCHEMA, '已读取的补充必须给出可访问来源（access/url）', `${path}.access`);
    requireText(supplement.sourceId, CODES.SCHEMA, '已读取的补充必须引用来源 id（sourceId）', `${path}.sourceId`);
    // A source id that no longer exists in the model is historical, not fatal:
    // the record stays readable and stale, and that supplement never counts as
    // coverage (see eligibleSupplements).
  }
  return supplement;
}

function normalizeGap(item, path) {
  if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, 'gap 必须是对象', path);
  if (!GAP_EFFECTS.includes(item.effect)) {
    throw new EmberError(CODES.SCHEMA, `gap effect 只能是 ${GAP_EFFECTS.join('/')}，收到 ${JSON.stringify(item.effect)}`, `${path}.effect`);
  }
  return {
    id: requireText(item.id, CODES.SCHEMA, 'gap id 必填', `${path}.id`),
    dimension: item.dimension === undefined || item.dimension === null
      ? ''
      : requireText(item.dimension, CODES.SCHEMA, 'gap dimension 需要是非空字符串', `${path}.dimension`),
    text: requireText(item.text, CODES.SCHEMA, 'gap text 必填', `${path}.text`),
    effect: item.effect,
    outcomeEffect: requireText(item.outcomeEffect, CODES.SCHEMA, 'gap outcomeEffect 必填：说明对成果的影响', `${path}.outcomeEffect`),
  };
}

function normalizeConceptRecord(item, index, model, options) {
  const path = `goals[].concepts[${index}]`;
  if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, '质检概念必须是对象', path);
  const id = requireText(item.id, CODES.SCHEMA, '质检概念 id 必填', `${path}.id`);
  // A concept that was later removed stays as historical record data; scope
  // comparison (not normalization) marks it stale. Normalization must stay
  // readable so build/quality-read never fail on an older record.
  if (!CONCEPT_ROLES.includes(item.role)) {
    throw new EmberError(CODES.SCHEMA, `质检概念 role 必须是 core 或 structural，收到 ${JSON.stringify(item.role)}`, `${path}.role`);
  }
  const dimensions = Array.isArray(item.dimensions) ? item.dimensions : [];
  const seen = new Set();
  const normalizedDimensions = dimensions.map((entry, dimIndex) => {
    const dimension = normalizeDimension(entry, `${path}.dimensions[${dimIndex}]`, options);
    if (seen.has(dimension.id)) {
      throw new EmberError(CODES.DUP_ID, `同一概念重复声明 dimension：${dimension.id}`, `${path}.dimensions[${dimIndex}].id`);
    }
    seen.add(dimension.id);
    return dimension;
  });
  if (item.role === 'structural') {
    // Structure nodes carry organization only; a short note is allowed, grading
    // dimensions are not required and are ignored for sufficiency.
    return { id, role: 'structural', dimensions: [], supplements: [], gaps: [] };
  }
  // A core concept must carry the full six-check semantic record. Allowing a
  // subset would let a record with nothing to say about sources or boundaries
  // read as complete; the schema requires each dimension exactly once.
  const missing = DIMENSIONS.filter((dimension) => !seen.has(dimension));
  if (missing.length > 0) {
    throw new EmberError(CODES.SCHEMA,
      `核心概念 ${id} 缺少质检维度：${missing.join('、')}；核心概念必须六项各声明一次`,
      `${path}.dimensions`);
  }
  const supplements = (Array.isArray(item.supplements) ? item.supplements : []).map((entry, supIndex) =>
    normalizeSupplement(entry, `${path}.supplements[${supIndex}]`, model, id));
  const supplementIds = new Set();
  for (const supplement of supplements) {
    if (supplementIds.has(supplement.id)) {
      throw new EmberError(CODES.DUP_ID, `同一概念重复声明补充：${supplement.id}`, path);
    }
    supplementIds.add(supplement.id);
    for (const dimension of normalizedDimensions) {
      if (dimension.supplementIds.includes(supplement.id) && supplement.role !== 'supplement') {
        throw new EmberError(CODES.SCHEMA,
          `未读取候选 ${supplement.id} 不能被声明为覆盖依据`, `${path}.dimensions`);
      }
    }
  }
  for (const dimension of normalizedDimensions) {
    for (const supplementId of dimension.supplementIds) {
      if (!supplementIds.has(supplementId)) {
        throw new EmberError(CODES.SCHEMA,
          `dimension ${dimension.id} 引用了不存在的 supplement：${supplementId}`, `${path}.dimensions`);
      }
    }
  }
  const gaps = (Array.isArray(item.gaps) ? item.gaps : []).map((entry, gapIndex) =>
    normalizeGap(entry, `${path}.gaps[${gapIndex}]`));
  return { id, role: 'core', dimensions: normalizedDimensions, supplements, gaps };
}

function normalizeGoalRecord(item, index, model, options) {
  const path = `goals[${index}]`;
  if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, 'goal 记录必须是对象', path);
  const outcome = requireText(item.outcome, CODES.SCHEMA, 'goal outcome 必填', `${path}.outcome`);
  if (!isRecord(item.scope)) throw new EmberError(CODES.SCHEMA, 'goal 记录缺少 scope 快照', `${path}.scope`);
  const scope = item.scope;
  const concepts = isRecord(scope.concepts) ? scope.concepts : {};
  const prompts = isRecord(scope.prompts) ? scope.prompts : {};
  if (!Array.isArray(item.concepts) || item.concepts.length === 0) {
    throw new EmberError(CODES.SCHEMA, 'goal 记录至少需要 1 个概念的质检结论', `${path}.concepts`);
  }
  const conceptIds = new Set();
  const normalizedConcepts = item.concepts.map((entry, conceptIndex) => {
    const concept = normalizeConceptRecord(entry, conceptIndex, model, options);
    if (conceptIds.has(concept.id)) {
      throw new EmberError(CODES.DUP_ID, `同一目标重复声明概念：${concept.id}`, `${path}.concepts`);
    }
    conceptIds.add(concept.id);
    return concept;
  });
  return {
    id: requireText(item.id, CODES.SCHEMA, 'goal id 必填', `${path}.id`),
    outcome,
    scope: {
      modelFingerprint: optionalText(scope.modelFingerprint, CODES.SCHEMA, 'modelFingerprint 需要是字符串', `${path}.scope.modelFingerprint`),
      goalFingerprint: optionalText(scope.goalFingerprint, CODES.SCHEMA, 'goalFingerprint 需要是字符串', `${path}.scope.goalFingerprint`),
      concepts: Object.fromEntries(Object.entries(concepts).map(([key, value]) => [key, String(value)])),
      prompts: Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, String(value)])),
    },
    concepts: normalizedConcepts,
  };
}

export function normalizeQuality(raw, model, options = {}) {
  if (!isRecord(raw)) throw new EmberError(CODES.SCHEMA, '质检文件必须是一个 JSON 对象', '$');
  assertNoDangerousKeys(raw);
  if (raw.schemaVersion !== QUALITY_SCHEMA_VERSION) {
    throw new EmberError(CODES.SCHEMA, `quality schemaVersion 必须是 ${QUALITY_SCHEMA_VERSION}，收到 ${JSON.stringify(raw.schemaVersion)}`, 'schemaVersion');
  }
  if (raw.modelId !== model.id) {
    throw new EmberError(CODES.IDENTITY, `质检记录属于模型 ${raw.modelId}，当前模型是 ${model.id}`, 'modelId');
  }
  if (!Array.isArray(raw.goals) || raw.goals.length === 0) {
    throw new EmberError(CODES.SCHEMA, 'goals 至少需要 1 条质检目标记录', 'goals');
  }
  const goalIds = new Set();
  const goals = raw.goals.map((item, index) => {
    const goal = normalizeGoalRecord(item, index, model, options);
    if (goalIds.has(goal.id)) {
      throw new EmberError(CODES.DUP_ID, `goal id 重复：${goal.id}`, `goals[${index}].id`);
    }
    goalIds.add(goal.id);
    return goal;
  });
  // The material map is optional. Strict validation (write/validate) rejects an
  // unknown source or concept reference, a duplicate or malformed entry, or an
  // incomplete reading claim; a historical read keeps the original ranges and
  // flags the record instead of failing (see material-map.mjs).
  const materialMap = materialMapNormalize(raw.materialMap, {
    sources: model.sources,
    concepts: model.concepts,
    historical: Boolean(options.historical),
    fail: (code, message, where) => new EmberError(code, message, where),
  });
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    modelId: model.id,
    generatedAt: optionalText(raw.generatedAt, CODES.SCHEMA, 'generatedAt 需要是字符串', 'generatedAt') || nowIso(),
    modelFingerprint: optionalText(raw.modelFingerprint, CODES.SCHEMA, 'modelFingerprint 需要是字符串', 'modelFingerprint'),
    goalFingerprint: optionalText(raw.goalFingerprint, CODES.SCHEMA, 'goalFingerprint 需要是字符串', 'goalFingerprint'),
    scope: isRecord(raw.scope) ? raw.scope : {},
    goals,
    materialMap,
  };
}

export function qualityToJson(quality) {
  return {
    schemaVersion: quality.schemaVersion,
    modelId: quality.modelId,
    generatedAt: quality.generatedAt,
    modelFingerprint: quality.modelFingerprint,
    goalFingerprint: quality.goalFingerprint,
    scope: quality.scope,
    // Only a record that actually declares a map emits one, so an older record
    // is never silently upgraded with an empty map on write.
    ...(quality.materialMap ? { materialMap: materialMapToJson(quality.materialMap) } : {}),
    goals: quality.goals.map((goal) => ({
      id: goal.id,
      outcome: goal.outcome,
      scope: goal.scope,
      concepts: goal.concepts.map((concept) => ({
        id: concept.id,
        role: concept.role,
        ...(concept.role === 'structural'
          ? {}
          : {
            dimensions: concept.dimensions.map((dimension) => ({
              id: dimension.id,
              result: dimension.result,
              ...(dimension.basis ? { basis: dimension.basis } : {}),
              ...(dimension.supplementIds.length ? { supplementIds: dimension.supplementIds } : {}),
            })),
            supplements: concept.supplements.map((supplement) => ({
              id: supplement.id,
              role: supplement.role,
              ...(supplement.conceptId ? { conceptId: supplement.conceptId } : {}),
              ...(supplement.dimension ? { dimension: supplement.dimension } : {}),
              ...(supplement.sourceId ? { sourceId: supplement.sourceId } : {}),
              ...(supplement.checkedRange ? { checkedRange: supplement.checkedRange } : {}),
              ...(supplement.access ? { access: supplement.access } : {}),
              ...(supplement.readAt ? { readAt: supplement.readAt } : {}),
              ...(supplement.note ? { note: supplement.note } : {}),
            })),
            gaps: concept.gaps.map((gap) => ({
              id: gap.id,
              ...(gap.dimension ? { dimension: gap.dimension } : {}),
              text: gap.text,
              effect: gap.effect,
              outcomeEffect: gap.outcomeEffect,
            })),
          }),
      })),
    })),
  };
}

/**
 * Compare a record's scope against the current model. Returns per-item reasons
 * so the page and CLI can name exactly what must be re-checked instead of
 * silently reusing an outdated conclusion.
 */
export function scopeDiff(scope, model) {
  const reasons = [];
  if (!isRecord(scope)) return ['质检记录缺少范围快照，无法核对当前内容'];
  if (scope.modelFingerprint !== model.modelFingerprint) {
    reasons.push('模型内容版本已更新，需要重新核对全部结论');
  }
  if (scope.goalFingerprint !== goalFingerprint(model)) {
    reasons.push(GOAL_SCOPE_CHANGED_REASON);
  }
  const concepts = isRecord(scope.concepts) ? scope.concepts : {};
  for (const concept of model.concepts) {
    const recorded = concepts[concept.id];
    if (recorded === undefined) {
      reasons.push(`概念 ${concept.id} 未包含在质检范围中`);
    } else if (recorded !== model.conceptFingerprints[concept.id]) {
      reasons.push(`概念 ${concept.id} 内容已更新，需要重新核对`);
    }
  }
  const prompts = isRecord(scope.prompts) ? scope.prompts : {};
  for (const prompt of model.prompts) {
    const recorded = prompts[prompt.id];
    if (recorded === undefined) {
      reasons.push(`问题 ${prompt.id} 未包含在质检范围中`);
    } else if (recorded !== model.promptFingerprints[prompt.id]) {
      reasons.push(`问题 ${prompt.id} 内容已更新，需要重新核对`);
    }
  }
  return reasons;
}

/**
 * True only when every concept/prompt fingerprint in the current model matches
 * the record's snapshot. Used by quality-write to refuse a stale record.
 */
export function scopeMatches(scope, model) {
  return scopeDiff(scope, model).length === 0;
}

// One authoritative rule for whether a supplement may count as coverage. A
// supplement qualifies only when it was actually read (checked range, read
// date, reachable access) and its source still exists in the model. Both the
// derived status and the payload view use this helper so they cannot drift.
export function isSupplementEligible(supplement, sourceIds = null) {
  return isRecord(supplement) &&
    supplement.role === 'supplement' &&
    typeof supplement.checkedRange === 'string' && supplement.checkedRange !== '' &&
    typeof supplement.readAt === 'string' && supplement.readAt !== '' &&
    typeof supplement.access === 'string' && supplement.access !== '' &&
    (sourceIds === null || sourceIds.has(supplement.sourceId));
}

/**
 * Every goal carries its own snapshot, so a record cannot pass on a current
 * top-level scope while an individual goal still points at an older goal text
 * or content version. The top-level scope must also match. Returns a flat list
 * of "{goalId}: reason" strings (top-level reasons are unprefixed).
 */
export function recordScopeReasons(quality, model) {
  const reasons = [...scopeDiff(quality.scope, model)];
  for (const goal of quality.goals) {
    if (goal.outcome !== model.goal) {
      reasons.push(`${goal.id}: 目标文本与当前学习目标不一致`);
    }
    for (const reason of scopeDiff(goal.scope, model)) {
      reasons.push(`${goal.id}: ${reason}`);
    }
  }
  // The optional material map is compared against the current sources with the
  // read model's own rule, so a write can never persist a snapshot that already
  // reads as stale. Omitting a current source from a partial map stays legal:
  // that source reads as unknown coverage, not as an invalid record.
  for (const reason of materialMapReasons(quality.materialMap, {
    sources: model.sources,
    concepts: model.concepts,
    conceptFingerprints: model.conceptFingerprints,
    scope: quality.scope,
  })) {
    reasons.push(`材料地图：${reason}`);
  }
  return reasons;
}

/**
 * Every concept in the current model must be declared explicitly in a goal
 * (as core or structural). A record that silently omits a concept cannot be
 * written, because the outcome would read as passed while an unreviewed
 * concept still exists. Legacy records that already omit concepts stay
 * readable: qualityView reports the omission instead of failing.
 */
export function undeclaredConceptIds(goal, model) {
  const declared = new Set(goal.concepts.map((concept) => concept.id));
  return model.concepts.filter((concept) => !declared.has(concept.id)).map((concept) => concept.id);
}

export function recordDeclarationReasons(quality, model) {
  const reasons = [];
  for (const goal of quality.goals) {
    const missing = undeclaredConceptIds(goal, model);
    if (missing.length > 0) {
      reasons.push(`${goal.id}: 目标未声明概念 ${missing.join('、')}；每个模型概念必须显式标记 core 或 structural`);
    }
  }
  return reasons;
}

function eligibleSupplements(concept, sourceIds = null) {
  return concept.supplements.filter((supplement) => isSupplementEligible(supplement, sourceIds));
}

/**
 * Derive a concept status from the declared conclusions. This never reads text
 * length or field counts as evidence of teaching adequacy.
 */
export function conceptStatus(concept, sourceIds = null) {
  if (concept.role === 'structural') return 'structure-only';
  // Older reports allowed empty rationales for partial/missing/N/A. Keep them
  // readable, but none of those unsupported conclusions can count as usable.
  if (concept.dimensions.some((dimension) => !dimension.basis?.trim())) return 'still-gap';
  // A core concept whose goal coverage is declared not-applicable (or which has
  // no applicable check at all) cannot stand as a supported outcome: every
  // check being N/A means nothing was actually verified for this goal.
  const goalCoverage = concept.dimensions.find((dimension) => dimension.id === 'goal-coverage');
  const hasApplicable = concept.dimensions.some((dimension) => dimension.result !== 'not-applicable');
  if ((goalCoverage && goalCoverage.result === 'not-applicable') || !hasApplicable) {
    return 'still-gap';
  }
  const eligible = eligibleSupplements(concept, sourceIds);
  const eligibleIds = new Set(eligible.map((supplement) => supplement.id));
  // A "covered" dimension that leans on a supplement which is not an eligible,
  // actually-read, still-present source cannot stand as coverage.
  const coveredOnIneligible = concept.dimensions.some((dimension) =>
    dimension.result === 'covered' &&
    dimension.supplementIds.length > 0 &&
    dimension.supplementIds.some((supplementId) => !eligibleIds.has(supplementId)));
  const blocking = concept.gaps.some((gap) => gap.effect === 'blocking');
  const missingDimension = concept.dimensions.some((dimension) => dimension.result === 'missing');
  const supplementableGap = concept.gaps.some((gap) => gap.effect === 'supplementable');
  const partialDimension = concept.dimensions.some((dimension) => dimension.result === 'partial');
  if (blocking || missingDimension) return 'still-gap';
  if (supplementableGap || partialDimension || coveredOnIneligible) {
    return eligible.length > 0 ? 'needs-supplement' : 'still-gap';
  }
  // A dimension that claims coverage only through an unread candidate must not
  // read as usable; the candidate is never an eligible supplement.
  return 'usable';
}

export function goalStatus(goal, model, sourceIds = new Set(model.sources.map((source) => source.id))) {
  const byId = new Map(goal.concepts.map((concept) => [concept.id, concept]));
  // A concept present in the model but missing from the goal is unreviewed, not
  // passing. New writes reject that explicitly; a historical record that omits
  // it must still read conservatively as not-passed instead of claiming the
  // outcome is covered while an unchecked concept exists.
  if (undeclaredConceptIds(goal, model).length > 0) return 'still-gap';
  const coreIds = model.concepts.filter((concept) => {
    const record = byId.get(concept.id);
    return isRecord(record) && record.role === 'core';
  }).map((concept) => concept.id);
  // A goal that only names organization nodes has no core learning outcome of
  // its own, so it can never read as a passed learning outcome.
  const statuses = coreIds.map((id) => conceptStatus(byId.get(id), sourceIds));
  if (coreIds.length === 0) return 'still-gap';
  if (statuses.includes('still-gap')) return 'still-gap';
  if (statuses.includes('needs-supplement')) return 'needs-supplement';
  return 'usable';
}

/**
 * Read-only payload view for build and quality-read. Keeps the historical
 * record intact while flagging every stale scope item.
 */
export function qualityView(quality, model) {
  const mapContext = {
    sources: model && Array.isArray(model.sources) ? model.sources : [],
    concepts: model && Array.isArray(model.concepts) ? model.concepts : [],
    conceptFingerprints: model ? model.conceptFingerprints : null,
    scope: quality ? quality.scope : null,
  };
  if (!quality) {
    return {
      present: false,
      stale: true,
      staleReasons: ['还没有内容质检记录'],
      goals: [],
      concepts: {},
      // No record at all means no reading range is recorded either: the map is
      // unknown, never an empty map that happens to read as checked.
      materialMap: materialMapView(null, mapContext),
    };
  }
  // The top-level scope and each goal's own snapshot are both authoritative.
  // A record whose top scope is corrupt is globally invalid: every goal is
  // stale and nothing may read as passed, even when each goal snapshot still
  // matches. This is a read-only derivation, so an already-persisted bad
  // record is reported rather than repaired or dropped.
  const scopeDriftReasons = scopeDiff(quality.scope, model);
  // A material map also carries reading-scope claims about the sources. Once the
  // record no longer matches the current content, a source the map never listed
  // counts as new/unrecorded, and both kinds of drift invalidate the whole
  // record the same way a changed scope does.
  const mapReasons = materialMapReasons(quality.materialMap, {
    ...mapContext,
    scopeCurrent: scopeDriftReasons.length === 0,
  });
  const reportStaleReasons = [
    ...scopeDriftReasons,
    ...mapReasons.map((reason) => `材料地图：${reason}`),
  ];
  const reportStale = reportStaleReasons.length > 0;
  const goalOwnReasons = new Map();
  for (const goal of quality.goals) {
    const reasons = [];
    if (goal.outcome !== model.goal) reasons.push('目标文本与当前学习目标不一致');
    reasons.push(...scopeDiff(goal.scope, model));
    const missing = undeclaredConceptIds(goal, model);
    if (missing.length > 0) {
      reasons.push(`目标未声明概念 ${missing.join('、')}；每个模型概念必须显式标记 core 或 structural`);
    }
    for (const concept of goal.concepts) {
      for (const dimension of concept.dimensions) {
        if (!dimension.basis.trim()) reasons.push(`概念 ${concept.id} 的 ${dimension.id} 缺少 basis 依据，需要重新核对`);
      }
    }
    goalOwnReasons.set(goal.id, reasons);
  }
  const staleReasons = [
    ...reportStaleReasons,
    ...[...goalOwnReasons.entries()].flatMap(([id, reasons]) => reasons.map((reason) => `${id}: ${reason}`)),
  ];
  const stale = staleReasons.length > 0;
  const concepts = Object.create(null);
  const sourceById = new Map(model.sources.map((source) => [source.id, source]));
  const sourceIds = new Set(sourceById.keys());
  const conceptGoalIds = Object.create(null);
  const statusRank = { usable: 0, 'needs-supplement': 1, 'still-gap': 2, 'structure-only': -1 };

  // Derive the full, goal-specific view of one declared concept. Both the
  // per-goal array and the flat map use this so no caller can see a summary
  // that hides dimensions, supplements, gaps or recheck reasons.
  function deriveConcept(concept, { goalStale, goalStaleReasons }) {
    const status = conceptStatus(concept, sourceIds);
    const sourceSupplements = concept.supplements.map((supplement) => ({
      id: supplement.id,
      role: supplement.role,
      dimension: supplement.dimension,
      sourceId: supplement.sourceId,
      sourceTitle: sourceById.get(supplement.sourceId)?.title ?? supplement.sourceId,
      sourceUrl: sourceById.get(supplement.sourceId)?.url ?? '',
      checkedRange: supplement.checkedRange,
      access: supplement.access,
      readAt: supplement.readAt,
      note: supplement.note,
      countedAsCoverage: isSupplementEligible(supplement, sourceIds),
    }));
    return {
      id: concept.id,
      role: concept.role,
      status,
      stale: stale || goalStale,
      staleReasons: goalStale ? goalStaleReasons : [],
      inCurrentModel: model.byId.has(concept.id),
      dimensions: concept.dimensions,
      supplements: sourceSupplements,
      gaps: concept.gaps,
    };
  }
  const goals = quality.goals.map((goal) => {
    // Global report invalidity propagates into every goal so the goal's
    // stale/passed flags can never contradict the record-level stale flag.
    const goalStaleReasons = [...reportStaleReasons, ...(goalOwnReasons.get(goal.id) ?? [])];
    const goalStale = goalStaleReasons.length > 0;
    const outcomeStatus = goalStatus(goal, model, sourceIds);
    const goalConcepts = [];
    for (const concept of goal.concepts) {
      const record = deriveConcept(concept, { goalStale, goalStaleReasons });
      record.goalId = goal.id;
      record.outcome = goal.outcome;
      record.outcomeStatus = outcomeStatus;
      record.passed = outcomeStatus === 'usable' && !goalStale;
      goalConcepts.push(record);
      // The flat map keeps one record per concept for existing readers, but a
      // concept can support several goals: it remembers every goal id and
      // keeps the most conservative status instead of letting a later goal
      // silently overwrite an earlier conclusion.
      if (conceptGoalIds[concept.id] === undefined) {
        conceptGoalIds[concept.id] = [goal.id];
        concepts[concept.id] = { ...record, goalIds: [goal.id] };
      } else {
        conceptGoalIds[concept.id].push(goal.id);
        const existing = concepts[concept.id];
        const representative = statusRank[record.status] > statusRank[existing.status] ? record : existing;
        // Aggregate conservatively: status takes the worst ranking, and the
        // pass/stale flags are AND/OR so a later usable goal can never flip an
        // earlier still-gap conclusion to passed:true.
        concepts[concept.id] = {
          ...representative,
          goalIds: conceptGoalIds[concept.id],
          status: statusRank[record.status] > statusRank[existing.status] ? record.status : existing.status,
          stale: existing.stale || record.stale,
          staleReasons: [...new Set([...(existing.staleReasons ?? []), ...(record.staleReasons ?? [])])],
          passed: existing.passed && record.passed,
          outcomeStatus: existing.outcomeStatus === 'usable' && record.outcomeStatus === 'usable'
            ? 'usable'
            : (existing.outcomeStatus === 'still-gap' || record.outcomeStatus === 'still-gap'
              ? 'still-gap'
              : 'needs-supplement'),
        };
      }
    }
    return {
      id: goal.id,
      outcome: goal.outcome,
      status: outcomeStatus,
      passed: outcomeStatus === 'usable' && !goalStale,
      stale: goalStale,
      staleReasons: goalStaleReasons,
      // The original scope snapshot this goal's conclusions were written
      // against, plus when the record was authored, so the page can show the
      // exact content version rather than just a pass/fail summary.
      scope: goal.scope,
      recordedAt: quality.generatedAt,
      concepts: goalConcepts,
    };
  });
  // Concepts that exist in the current model but were never declared are named
  // explicitly so the page can say what still needs checking.
  for (const concept of model.concepts) {
    if (concepts[concept.id] === undefined) {
      concepts[concept.id] = {
        id: concept.id,
        role: null,
        status: 'still-gap',
        stale: true,
        staleReasons: [`概念 ${concept.id} 尚未包含在质检记录中`],
        inCurrentModel: true,
        dimensions: [],
        supplements: [],
        gaps: [],
        goalId: null,
        goalIds: [],
        outcome: null,
        outcomeStatus: 'still-gap',
        passed: false,
      };
    }
  }
  return {
    present: true,
    stale,
    staleReasons,
    // The record-level snapshot the whole report was written against, kept
    // readable even when it no longer matches so the page can show the exact
    // version (and what drifted) instead of just a stale flag.
    scope: quality.scope,
    recordedAt: quality.generatedAt,
    // The derived reading-scope view for the sources panel and quality-read.
    materialMap: materialMapView(quality.materialMap, {
      ...mapContext,
      scopeCurrent: scopeDriftReasons.length === 0,
      recordStale: stale,
      // Map reasons are already derived by materialMapView; pass only the
      // independent scope reasons, without report presentation prefixes.
      recordStaleReasons: scopeDriftReasons,
      recordGoalReasons: quality.scope.goalFingerprint !== goalFingerprint(model)
        || quality.goals.some((goal) => goal.outcome !== model.goal
          || goal.scope.goalFingerprint !== goalFingerprint(model))
        ? [GOAL_SCOPE_CHANGED_REASON] : [],
    }),
    goals,
    concepts,
  };
}

export function readQualityFile(filePath, model) {
  if (!fileExists(filePath)) return null;
  return normalizeQuality(readJson(filePath, `质检文件 ${filePath}`), model, { historical: true });
}

export function qualityJsonText(quality) {
  return stableStringify(qualityToJson(quality));
}
