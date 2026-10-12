import { EmberError, CODES, isRecord } from './errors.mjs';
import { sha256, stableStringify } from './io.mjs';
import { interactionNormalize, interactionToJson } from './interactions.mjs';
import { normalizePresentation } from './presentation.mjs';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RELATION_TYPES = new Set(['prerequisite', 'cause', 'contrast', 'application']);
const PROMPT_KINDS = new Set(['recall', 'explain', 'apply', 'compare']);
// Optional teaching goals a progressive task can be chosen for. A legacy
// question without `teaching` derives its purpose from its kind instead.
const TEACHING_PURPOSES = new Set(['explanation', 'variation', 'transfer']);
const DIFFICULTIES = new Set([1, 2, 3]);

export function assertSafeId(value, code, message, path) {
  if (typeof value !== 'string' || !ID_RE.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw new EmberError(code, `${message}：收到 ${JSON.stringify(value)}；只能是 [a-z0-9-] 且首尾为小写字母或数字`, path);
  }
  return value;
}

function rejectDangerousKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectDangerousKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new EmberError(CODES.SCHEMA, `字段名 ${key} 被拒绝，避免对象原型污染`, `${path}.${key}`);
    }
    rejectDangerousKeys(value[key], `${path}.${key}`);
  }
}

function str(value, code, message, path) {
  if (typeof value !== 'string' || value.trim() === '') throw new EmberError(code, message, path);
  return value;
}

// Optional strings may be omitted, null, or explicitly empty. They are always
// trimmed so `normalizeModel(modelToJson(normalizeModel(raw)))` is a fixed
// point: modelToJson omits empty optionals and normalize accepts them back.
function optionalStr(value, code, message, path) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new EmberError(code, `${message}：需要是字符串或省略`, path);
  return value.trim();
}

function optionalArray(value, code, message, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new EmberError(code, message, path);
  return value;
}

// A present teaching list must be a non-empty list of non-empty strings: an
// empty list would silently mean "configured but unusable", so it is refused
// instead of read as absent.
function teachingTextList(value, message, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EmberError(CODES.PROMPT, `${message}：需要是非空字符串数组`, path);
  }
  if (value.some((line) => typeof line !== 'string' || line.trim() === '')) {
    throw new EmberError(CODES.PROMPT, `${message}：每一项都必须是非空字符串`, path);
  }
  return value.map((line) => line.trim());
}

// Optional teaching metadata on an author question. Every field is optional,
// but a present field must be usable: `purpose` is one of the three teaching
// goals, `objective` is non-empty text, `prerequisites` are existing concept
// ids, and `misconceptions`/`hints` are non-empty text lists. An absent object
// (or one with no usable field) stays absent so a legacy question keeps its old
// content fingerprint exactly.
function normalizeTeaching(raw, path, byId) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new EmberError(CODES.PROMPT, 'teaching 必须是对象或省略', path);
  const teaching = {};
  if (raw.purpose !== undefined && raw.purpose !== null) {
    if (typeof raw.purpose !== 'string' || !TEACHING_PURPOSES.has(raw.purpose)) {
      throw new EmberError(CODES.PROMPT,
        `teaching.purpose 只能是 explanation/variation/transfer，收到 ${JSON.stringify(raw.purpose)}`, `${path}.purpose`);
    }
    teaching.purpose = raw.purpose;
  }
  if (raw.objective !== undefined && raw.objective !== null) {
    teaching.objective = str(raw.objective, CODES.PROMPT, 'teaching.objective 必填且非空', `${path}.objective`);
  }
  if (raw.prerequisites !== undefined && raw.prerequisites !== null) {
    if (!Array.isArray(raw.prerequisites)) {
      throw new EmberError(CODES.PROMPT, 'teaching.prerequisites 必须是概念 id 数组', `${path}.prerequisites`);
    }
    const seen = new Set();
    teaching.prerequisites = raw.prerequisites.map((value, index) => {
      const conceptId = assertSafeId(value, CODES.PROMPT, 'teaching.prerequisites 概念 id 不合法', `${path}.prerequisites[${index}]`);
      if (!byId.has(conceptId)) {
        throw new EmberError(CODES.PROMPT, `teaching.prerequisites 指向不存在的概念：${conceptId}`, `${path}.prerequisites[${index}]`);
      }
      if (seen.has(conceptId)) {
        throw new EmberError(CODES.PROMPT, `teaching.prerequisites 概念 id 重复：${conceptId}`, `${path}.prerequisites[${index}]`);
      }
      seen.add(conceptId);
      return conceptId;
    });
  }
  if (raw.misconceptions !== undefined && raw.misconceptions !== null) {
    teaching.misconceptions = teachingTextList(raw.misconceptions, 'teaching.misconceptions', `${path}.misconceptions`);
  }
  if (raw.hints !== undefined && raw.hints !== null) {
    teaching.hints = teachingTextList(raw.hints, 'teaching.hints', `${path}.hints`);
  }
  // Preserve unknown teaching fields for forward compatibility, like the model.
  for (const key of Object.keys(raw)) if (!(key in teaching)) teaching[key] = raw[key];
  return Object.keys(teaching).length > 0 ? teaching : null;
}

export function computeConceptFingerprint(concept) {
  return sha256(stableStringify({
    id: concept.id,
    title: concept.title,
    explanation: concept.explanation ?? '',
    example: concept.example ?? '',
    misconception: concept.misconception ?? '',
  }));
}

// Prompt identity includes the concept context (and therefore its content) so a
// changed concept invalidates prompt evidence even when the prompt text did not.
// Teaching metadata participates only when present, so a legacy question's
// fingerprint is byte-for-byte the same as before this field existed.
export function computePromptFingerprint(prompt, conceptFingerprint = '') {
  const payload = {
    conceptId: prompt.conceptId,
    kind: prompt.kind,
    question: prompt.question,
    answer: prompt.answer ?? '',
    criteria: prompt.criteria ?? [],
    concept: conceptFingerprint,
  };
  if (prompt.teaching !== undefined && prompt.teaching !== null && Object.keys(prompt.teaching).length > 0) {
    payload.teaching = prompt.teaching;
  }
  return sha256(stableStringify(payload));
}

export function normalizeModel(raw) {
  if (!isRecord(raw)) throw new EmberError(CODES.SCHEMA, '模型必须是一个 JSON 对象', '$');
  rejectDangerousKeys(raw);
  if (raw.schemaVersion !== 1) {
    throw new EmberError(CODES.SCHEMA, `schemaVersion 必须是 1，收到 ${JSON.stringify(raw.schemaVersion)}`, 'schemaVersion');
  }
  const id = assertSafeId(raw.id, CODES.ID, '模型 id 不合法', 'id');
  const title = str(raw.title, CODES.SCHEMA, 'title 必填且非空', 'title');
  const goal = str(raw.goal, CODES.SCHEMA, 'goal 必填且非空', 'goal');
  const summary = optionalStr(raw.summary, CODES.SCHEMA, 'summary 需要是非空字符串或省略', 'summary');
  const presentation = normalizePresentation(raw.presentation);

  if (!Array.isArray(raw.concepts) || raw.concepts.length === 0) {
    throw new EmberError(CODES.SCHEMA, 'concepts 至少需要 1 个概念', 'concepts');
  }

  const conceptIds = new Map();
  const concepts = raw.concepts.map((item, index) => {
    const path = `concepts[${index}]`;
    if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, '概念必须是对象', path);
    const conceptId = assertSafeId(item.id, CODES.ID, '概念 id 不合法', `${path}.id`);
    if (conceptIds.has(conceptId)) {
      throw new EmberError(CODES.DUP_ID, `概念 id 重复：${conceptId}`, `${path}.id`);
    }
    if (!DIFFICULTIES.has(item.difficulty)) {
      throw new EmberError(CODES.DIFFICULTY, `difficulty 只能是 1、2、3，收到 ${JSON.stringify(item.difficulty)}`, `${path}.difficulty`);
    }
    const concept = {
      id: conceptId,
      title: str(item.title, CODES.SCHEMA, '概念 title 必填且非空', `${path}.title`),
      parentId: item.parentId === null || item.parentId === undefined
        ? null
        : assertSafeId(item.parentId, CODES.PARENT, 'parentId 不合法', `${path}.parentId`),
      difficulty: item.difficulty,
      explanation: optionalStr(item.explanation, CODES.SCHEMA, 'explanation 需要是非空字符串或省略', `${path}.explanation`),
      example: optionalStr(item.example, CODES.SCHEMA, 'example 需要是非空字符串或省略', `${path}.example`),
      misconception: optionalStr(item.misconception, CODES.SCHEMA, 'misconception 需要是非空字符串或省略', `${path}.misconception`),
    };
    conceptIds.set(conceptId, index);
    return concept;
  });

  // exactly one root
  const roots = concepts.filter((c) => c.parentId === null);
  if (roots.length !== 1) {
    throw new EmberError(CODES.FOREST, `必须恰好有 1 个根概念（parentId 为 null），当前有 ${roots.length} 个`,
      roots.length === 0 ? 'concepts' : 'concepts');
  }

  const byId = new Map(concepts.map((c) => [c.id, c]));
  const childrenById = new Map(concepts.map((c) => [c.id, []]));
  for (const [index, concept] of concepts.entries()) {
    if (concept.parentId === null) continue;
    if (!byId.has(concept.parentId)) {
      throw new EmberError(CODES.PARENT, `parentId 指向不存在的概念：${concept.parentId}`, `concepts[${index}].parentId`);
    }
    if (concept.parentId === concept.id) {
      throw new EmberError(CODES.CYCLE, `概念不能把自己当作父节点：${concept.id}`, `concepts[${index}].parentId`);
    }
    childrenById.get(concept.parentId).push(concept.id);
  }

  // acyclic + connected from the root
  const depthById = new Map();
  const order = [];
  const visit = (conceptId, depth, chain) => {
    if (chain.has(conceptId)) {
      throw new EmberError(CODES.CYCLE, `父子关系形成环：${[...chain, conceptId].join(' -> ')}`, 'concepts');
    }
    if (depthById.has(conceptId)) return;
    depthById.set(conceptId, depth);
    order.push(conceptId);
    chain.add(conceptId);
    for (const childId of childrenById.get(conceptId)) visit(childId, depth + 1, chain);
    chain.delete(conceptId);
  };
  visit(roots[0].id, 0, new Set());
  for (const concept of concepts) {
    if (!depthById.has(concept.id)) {
      throw new EmberError(CODES.FOREST, `概念 ${concept.id} 与根概念不连通；父子关系必须是一棵连通的树`, 'concepts');
    }
  }

  const relationIds = new Set();
  const relations = optionalArray(raw.relations, CODES.SCHEMA, 'relations 必须是数组', 'relations').map((item, index) => {
    const path = `relations[${index}]`;
    if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, '关系必须是对象', path);
    const relationId = assertSafeId(item.id, CODES.ID, '关系 id 不合法', `${path}.id`);
    if (relationIds.has(relationId)) throw new EmberError(CODES.DUP_ID, `关系 id 重复：${relationId}`, `${path}.id`);
    if (!byId.has(item.from)) {
      throw new EmberError(CODES.RELATION, `from 指向不存在的概念：${JSON.stringify(item.from)}`, `${path}.from`);
    }
    if (!byId.has(item.to)) {
      throw new EmberError(CODES.RELATION, `to 指向不存在的概念：${JSON.stringify(item.to)}`, `${path}.to`);
    }
    if (item.from === item.to) {
      throw new EmberError(CODES.RELATION, '关系不能指向自身', `${path}`);
    }
    if (!RELATION_TYPES.has(item.type)) {
      throw new EmberError(CODES.RELATION, `type 只能是 prerequisite/cause/contrast/application，收到 ${JSON.stringify(item.type)}`, `${path}.type`);
    }
    relationIds.add(relationId);
    return {
      id: relationId,
      from: item.from,
      to: item.to,
      type: item.type,
      label: optionalStr(item.label, CODES.SCHEMA, '关系 label 需要是非空字符串或省略', `${path}.label`),
    };
  });

  const promptIds = new Set();
  const prompts = optionalArray(raw.prompts, CODES.SCHEMA, 'prompts 必须是数组', 'prompts').map((item, index) => {
    const path = `prompts[${index}]`;
    if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, '问题必须是对象', path);
    const promptId = assertSafeId(item.id, CODES.ID, '问题 id 不合法', `${path}.id`);
    if (promptIds.has(promptId)) throw new EmberError(CODES.DUP_ID, `问题 id 重复：${promptId}`, `${path}.id`);
    if (!byId.has(item.conceptId)) {
      throw new EmberError(CODES.PROMPT, `conceptId 指向不存在的概念：${JSON.stringify(item.conceptId)}`, `${path}.conceptId`);
    }
    if (!PROMPT_KINDS.has(item.kind)) {
      throw new EmberError(CODES.PROMPT, `kind 只能是 recall/explain/apply/compare，收到 ${JSON.stringify(item.kind)}`, `${path}.kind`);
    }
    let criteria = [];
    if (item.criteria !== undefined) {
      if (!Array.isArray(item.criteria) || item.criteria.some((line) => typeof line !== 'string' || line.trim() === '')) {
        throw new EmberError(CODES.PROMPT, 'criteria 必须是非空字符串数组', `${path}.criteria`);
      }
      criteria = item.criteria.map((line) => line.trim());
    }
    promptIds.add(promptId);
    const teaching = normalizeTeaching(item.teaching, `${path}.teaching`, byId);
    const prompt = {
      id: promptId,
      conceptId: item.conceptId,
      kind: item.kind,
      question: str(item.question, CODES.PROMPT, 'question 必填且非空', `${path}.question`),
      answer: str(item.answer, CODES.PROMPT, 'answer 必填且非空', `${path}.answer`),
      criteria,
    };
    // Only attach the key when metadata is present: an absent key keeps the
    // serialized prompt (and therefore the model fingerprint) unchanged.
    if (teaching) prompt.teaching = teaching;
    return prompt;
  });

  // Optional teaching interactions (ticket 10). Normalized here so a dangling
  // reference or an unsupported kind fails `validate`/`build` with a readable
  // path, and so the canonical form participates in the model fingerprint.
  // An absent, null or empty array all read as unconfigured and leave a legacy
  // model's fingerprint byte-for-byte unchanged.
  const interactions = interactionNormalize(raw.interactions, {
    fail: (code, message, where) => new EmberError(code, message, where),
    hasConcept: (conceptId) => byId.has(conceptId),
    promptById: (promptId) => prompts.find((prompt) => prompt.id === promptId) ?? null,
  });

  const sourceIds = new Set();
  const sources = optionalArray(raw.sources, CODES.SCHEMA, 'sources 必须是数组', 'sources').map((item, index) => {
    const path = `sources[${index}]`;
    if (!isRecord(item)) throw new EmberError(CODES.SCHEMA, '来源必须是对象', path);
    const sourceId = assertSafeId(item.id, CODES.ID, '来源 id 不合法', `${path}.id`);
    if (sourceIds.has(sourceId)) throw new EmberError(CODES.DUP_ID, `来源 id 重复：${sourceId}`, `${path}.id`);
    sourceIds.add(sourceId);
    return {
      id: sourceId,
      title: str(item.title, CODES.SOURCE, '来源 title 必填且非空', `${path}.title`),
      note: optionalStr(item.note, CODES.SOURCE, '来源 note 需要是非空字符串或省略', `${path}.note`),
      kind: optionalStr(item.kind, CODES.SOURCE, '来源 kind 需要是非空字符串或省略', `${path}.kind`),
      url: optionalStr(item.url, CODES.SOURCE, '来源 url 需要是非空字符串或省略', `${path}.url`),
    };
  });

  const limitationsRaw = optionalArray(raw.limitations, CODES.SCHEMA, 'limitations 必须是字符串数组', 'limitations');
  if (limitationsRaw.some((line) => typeof line !== 'string' || line.trim() === '')) {
    throw new EmberError(CODES.SCHEMA, 'limitations 必须是非空字符串数组', 'limitations');
  }
  const limitations = limitationsRaw.map((line) => line.trim());

  const warnings = [];
  const conceptFingerprints = Object.create(null);
  for (const concept of concepts) {
    conceptFingerprints[concept.id] = computeConceptFingerprint(concept);
    if (concept.explanation === '' && concept.example === '') {
      warnings.push(`概念 ${concept.id} 没有 explanation 或 example`);
    }
  }
  const promptFingerprints = Object.create(null);
  for (const prompt of prompts) {
    promptFingerprints[prompt.id] = computePromptFingerprint(prompt, conceptFingerprints[prompt.conceptId]);
  }
  for (const prompt of prompts) {
    if (prompt.kind === 'apply' && prompt.criteria.length === 0) {
      warnings.push(`应用题 ${prompt.id} 没有 criteria`);
    }
  }

  const model = {
    schemaVersion: 1,
    id,
    title,
    goal,
    summary,
    concepts,
    relations,
    prompts,
    sources,
    limitations,
  };
  // preserve unknown top-level fields for forward compatibility
  for (const key of Object.keys(raw)) {
    if (!(key in model)) model[key] = raw[key];
  }
  // The interactions bucket is attached only in its canonical form. `[]` and an
  // absent/null field both normalize to null, so a legacy model never grows the
  // key (and keeps its old fingerprint).
  if (interactions) model.interactions = interactions;
  else delete model.interactions;
  // Presentation changes rebuild artifacts without invalidating learning facts.
  if (presentation) model.presentation = presentation;
  else delete model.presentation;

  const interactionsById = Object.create(null);
  const interactionsByConcept = Object.create(null);
  for (const interaction of interactions ?? []) {
    interactionsById[interaction.id] = interaction;
    if (!interactionsByConcept[interaction.conceptId]) interactionsByConcept[interaction.conceptId] = [];
    interactionsByConcept[interaction.conceptId].push(interaction);
  }

  defineDerived(model, {
    byId,
    childrenById,
    depthById,
    order,
    roots,
    promptFingerprints,
    conceptFingerprints,
    interactionsById,
    interactionsByConcept,
    modelFingerprint: sha256(stableStringify({
      schemaVersion: 1, id, title, goal, summary, concepts, relations, prompts, sources, limitations,
      // Only a configured interaction set participates, so an absent/null/[]
      // field reproduces the pre-ticket-10 fingerprint exactly.
      ...(interactions ? { interactions } : {}),
    })),
    warnings,
  });
  return model;
}

function defineDerived(model, derived) {
  for (const [key, value] of Object.entries(derived)) {
    Object.defineProperty(model, key, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(model.concepts);
  Object.freeze(model.relations);
  Object.freeze(model.prompts);
  Object.freeze(model.sources);
  Object.freeze(model.limitations);
  if (Array.isArray(model.interactions)) Object.freeze(model.interactions);
}

// Copy a record, dropping optional keys that are empty/omitted. This keeps the
// canonical JSON stable so normalized output validates again on rebuild.
function copyPresent(record, optionalKeys) {
  const out = {};
  for (const key of Object.keys(record)) {
    if (optionalKeys.includes(key)) {
      const value = record[key];
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
      continue;
    }
    out[key] = record[key];
  }
  return out;
}

export function modelToJson(model) {
  const known = ['schemaVersion', 'id', 'title', 'goal', 'summary', 'concepts', 'relations', 'prompts', 'interactions', 'sources', 'limitations'];
  const out = {};
  for (const key of Object.keys(model)) {
    if (!known.includes(key)) out[key] = model[key];
  }
  for (const key of known) {
    if (key === 'summary') {
      if (typeof model.summary === 'string' && model.summary !== '') out[key] = model.summary;
      continue;
    }
    if (key === 'concepts') { out[key] = model.concepts.map((c) => copyPresent(c, ['explanation', 'example', 'misconception'])); continue; }
    if (key === 'relations') { out[key] = model.relations.map((r) => copyPresent(r, ['label'])); continue; }
    if (key === 'prompts') { out[key] = model.prompts.map((p) => copyPresent(p, [])); continue; }
    if (key === 'interactions') {
      // Only emit a configured set; the canonical projection keeps the round-trip
      // and the fingerprint payload identical, and never adds the key to a
      // legacy model.
      if (Array.isArray(model.interactions) && model.interactions.length > 0) out[key] = model.interactions.map(interactionToJson);
      continue;
    }
    if (key === 'sources') { out[key] = model.sources.map((s) => copyPresent(s, ['note', 'kind', 'url'])); continue; }
    out[key] = model[key];
  }
  // stable key order: known schema first, extras after
  const ordered = {};
  for (const key of known) if (key in out) ordered[key] = out[key];
  for (const key of Object.keys(out)) if (!(key in ordered)) ordered[key] = out[key];
  return ordered;
}

export const MODEL_CONSTANTS = Object.freeze({
  ID_RE,
  RELATION_TYPES,
  PROMPT_KINDS,
  TEACHING_PURPOSES,
  DIFFICULTIES,
});
