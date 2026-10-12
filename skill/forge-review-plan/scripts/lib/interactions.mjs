// Pure teaching-interaction logic shared by the Node backend and the browser
// viewer.
//
// This module MUST stay dependency-free and portable: it may not import any
// other file, and it may not touch Node-only APIs (fs/path/crypto/process).
// `build` strips the leading `export ` from every declaration and inlines the
// source into the viewer at the interactions-library marker, and the standalone
// viewer harnesses do the same. `model.mjs` imports `interactionNormalize`
// directly, so the browser and the backend validate and present one shared
// configuration instead of two copies. No material-supplied script is ever read
// or executed: the configuration is plain data only.
//
// Internal helpers are all `interaction*`-prefixed so they can never shadow a
// viewer or core helper of the same purpose.

// `comparison` shipped in ticket 10, `step-through` in ticket 11 and the
// parameter experiment in ticket 12. Every component extends the same capability
// boundary: plain authored data only, one shared pure read model, and an unknown
// kind is refused with a readable structural error rather than silently accepted.
var INTERACTION_KINDS = ['comparison', 'step-through', 'parameter'];
var INTERACTION_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Prototype keys are refused outright so an author ID can never collide with an
// inherited member on the ID->value dictionaries. Every literal-table lookup
// still uses an own-property check and every internal dictionary uses a null
// prototype, so the validation is defense in depth alongside that checking.
var INTERACTION_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];

// The built-in parameter rules. Each rule is one verified formula over named
// roles, and every role must resolve to a declared numeric input. There is
// deliberately no way to author a formula: a script/expression field is refused
// outright instead of being ignored, so no material-supplied text is ever run.
var INTERACTION_PARAMETER_RULES = Object.freeze({
  ratio: Object.freeze(['numerator', 'denominator']),
  product: Object.freeze(['left', 'right']),
  'bayes-frequency': Object.freeze(['prior', 'sensitivity', 'falsePositive']),
});
var INTERACTION_PARAMETER_SCRIPT_KEYS = Object.freeze([
  'script', 'expression', 'formula', 'eval', 'fn', 'function', 'code', 'exec',
]);

function interactionHasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function interactionIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function interactionNullMap() {
  return Object.create(null);
}

// Errors stay plain so this module needs no shared error class; the Node caller
// supplies a `fail` that returns the error to throw (an EmberError there), and a
// standalone caller falls back to this coded Error.
function interactionFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

function interactionReject(context, code, message, where) {
  var fail = context && typeof context.fail === 'function' ? context.fail : interactionFail;
  throw fail(code, message, where);
}

function interactionText(context, value, message, where) {
  if (typeof value !== 'string' || value.trim() === '') interactionReject(context, 'E_SCHEMA', message, where);
  return value.trim();
}

function interactionSafeId(context, value, message, where) {
  if (typeof value !== 'string' || !INTERACTION_ID_RE.test(value) || INTERACTION_FORBIDDEN_IDS.indexOf(value) !== -1) {
    interactionReject(context, 'E_ID', message, where);
  }
  return value;
}

function interactionFiniteNumber(context, value, message, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    interactionReject(context, 'E_SCHEMA', message, where);
  }
  return value;
}

function interactionRejectScriptKeys(context, record, where) {
  if (!interactionIsRecord(record)) return;
  INTERACTION_PARAMETER_SCRIPT_KEYS.forEach(function (key) {
    if (interactionHasOwn(record, key)) {
      interactionReject(context, 'E_SCHEMA',
        '参数实验只运行预置规则，不接受脚本或表达式字段：' + key, where + '.' + key);
    }
  });
}

/**
 * Normalize the optional top-level `interactions` array into its canonical form
 * or `null` when unconfigured. An absent, `null` or empty array all read as "no
 * interactions" so a legacy model keeps the exact same fingerprint.
 *
 * `context` optionally wires the shared model facts so a dangling reference can
 * fail loudly with a readable path:
 *   - fail(code, message, path) -> Error to throw (defaults to a coded Error)
 *   - hasConcept(conceptId) -> boolean
 *   - promptById(promptId) -> prompt record or null
 */
export function interactionNormalize(raw, context) {
  var ctx = context || {};
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) interactionReject(ctx, 'E_SCHEMA', 'interactions 必须是数组（可省略）', 'interactions');
  if (raw.length === 0) return null;
  var seenInteractionIds = interactionNullMap();
  return raw.map(function (item, index) {
    var itemPath = 'interactions[' + index + ']';
    if (!interactionIsRecord(item)) interactionReject(ctx, 'E_SCHEMA', '互动组件必须是对象', itemPath);
    var kind = item.kind;
    if (typeof kind !== 'string' || INTERACTION_KINDS.indexOf(kind) === -1) {
      interactionReject(ctx, 'E_SCHEMA',
        '互动类型 ' + JSON.stringify(kind) + ' 尚不支持（当前仅支持 ' + INTERACTION_KINDS.join('/') + '）', itemPath + '.kind');
    }
    var id = interactionSafeId(ctx, item.id, '互动组件 id 不合法', itemPath + '.id');
    if (interactionHasOwn(seenInteractionIds, id)) interactionReject(ctx, 'E_DUP_ID', '互动组件 id 重复：' + id, itemPath + '.id');
    seenInteractionIds[id] = true;

    var conceptId = interactionText(ctx, item.conceptId, '互动组件必须绑定非空 conceptId', itemPath + '.conceptId');
    if (typeof ctx.hasConcept === 'function' && !ctx.hasConcept(conceptId)) {
      interactionReject(ctx, 'E_SCHEMA', '互动组件绑定的概念不存在：' + conceptId, itemPath + '.conceptId');
    }
    var title = interactionText(ctx, item.title, '互动组件 title 必填且非空', itemPath + '.title');
    var objective = interactionText(ctx, item.objective, '互动组件 objective（可核对目标）必填且非空', itemPath + '.objective');
    var boundary = interactionText(ctx, item.boundary, '互动组件 boundary（适用边界）必填且非空', itemPath + '.boundary');
    var question = interactionText(ctx, item.question, '互动组件 question（后续检验问题）必填且非空', itemPath + '.question');

    // Optional author question on the same concept: a real, checked exercise the
    // learner can enter after observing the difference.
    var promptId = null;
    if (item.promptId !== undefined && item.promptId !== null && item.promptId !== '') {
      if (typeof item.promptId !== 'string') interactionReject(ctx, 'E_PROMPT', '互动组件 promptId 必须是字符串或省略', itemPath + '.promptId');
      promptId = item.promptId;
      if (typeof ctx.promptById === 'function') {
        var prompt = ctx.promptById(promptId);
        if (!prompt) interactionReject(ctx, 'E_PROMPT', '互动组件引用的作者题不存在：' + promptId, itemPath + '.promptId');
        if (prompt.conceptId !== conceptId) {
          interactionReject(ctx, 'E_PROMPT', '互动组件的 promptId 必须属于同一概念（' + conceptId + '）', itemPath + '.promptId');
        }
      }
    }

    // Optional links back to related concepts (e.g. the concept it is easily
    // confused with). Each must exist and stay distinct.
    var relatedConceptIds = null;
    if (item.relatedConceptIds !== undefined && item.relatedConceptIds !== null) {
      if (!Array.isArray(item.relatedConceptIds)) interactionReject(ctx, 'E_SCHEMA', 'relatedConceptIds 必须是数组或省略', itemPath + '.relatedConceptIds');
      var seenRelated = interactionNullMap();
      var related = [];
      item.relatedConceptIds.forEach(function (rid, ridx) {
        var rpath = itemPath + '.relatedConceptIds[' + ridx + ']';
        var value = interactionText(ctx, rid, 'relatedConceptIds 必须是非空字符串', rpath);
        if (value === conceptId) interactionReject(ctx, 'E_SCHEMA', 'relatedConceptIds 不能包含互动组件自身绑定的概念', rpath);
        if (interactionHasOwn(seenRelated, value)) interactionReject(ctx, 'E_DUP_ID', 'relatedConceptIds 重复：' + value, rpath);
        seenRelated[value] = true;
        if (typeof ctx.hasConcept === 'function' && !ctx.hasConcept(value)) {
          interactionReject(ctx, 'E_SCHEMA', 'relatedConceptIds 指向不存在的概念：' + value, rpath);
        }
        related.push(value);
      });
      if (related.length > 0) relatedConceptIds = related;
    }

    var canonical = {
      kind: kind,
      id: id,
      conceptId: conceptId,
      title: title,
      objective: objective,
      boundary: boundary,
      question: question,
    };
    if (promptId) canonical.promptId = promptId;
    if (relatedConceptIds) canonical.relatedConceptIds = relatedConceptIds;
    if (kind === 'comparison') {
      // Dimensions are validated before objects so each object's `values` can be
      // checked against every declared dimension.
      if (!Array.isArray(item.dimensions) || item.dimensions.length === 0) {
        interactionReject(ctx, 'E_SCHEMA', '互动组件 dimensions 至少需要 1 个比较维度', itemPath + '.dimensions');
      }
      var dimensionIds = interactionNullMap();
      var dimensions = item.dimensions.map(function (dim, didx) {
        var dpath = itemPath + '.dimensions[' + didx + ']';
        if (!interactionIsRecord(dim)) interactionReject(ctx, 'E_SCHEMA', '比较维度必须是对象', dpath);
        var dimId = interactionSafeId(ctx, dim.id, '比较维度 id 不合法', dpath + '.id');
        if (interactionHasOwn(dimensionIds, dimId)) interactionReject(ctx, 'E_DUP_ID', '比较维度 id 重复：' + dimId, dpath + '.id');
        dimensionIds[dimId] = true;
        return {
          id: dimId,
          label: interactionText(ctx, dim.label, '比较维度 label 必填且非空', dpath + '.label'),
          difference: interactionText(ctx, dim.difference, '比较维度 difference（关键差异）必填且非空', dpath + '.difference'),
          boundary: interactionText(ctx, dim.boundary, '比较维度 boundary（适用边界）必填且非空', dpath + '.boundary'),
        };
      });

      if (!Array.isArray(item.objects) || item.objects.length < 2) {
        interactionReject(ctx, 'E_SCHEMA', '互动组件 objects 至少需要 2 个比较对象', itemPath + '.objects');
      }
      var objectIds = interactionNullMap();
      var objects = item.objects.map(function (obj, oidx) {
        var opath = itemPath + '.objects[' + oidx + ']';
        if (!interactionIsRecord(obj)) interactionReject(ctx, 'E_SCHEMA', '比较对象必须是对象', opath);
        var objId = interactionSafeId(ctx, obj.id, '比较对象 id 不合法', opath + '.id');
        if (interactionHasOwn(objectIds, objId)) interactionReject(ctx, 'E_DUP_ID', '比较对象 id 重复：' + objId, opath + '.id');
        objectIds[objId] = true;
        var label = interactionText(ctx, obj.label, '比较对象 label 必填且非空', opath + '.label');
        if (!interactionIsRecord(obj.values)) interactionReject(ctx, 'E_SCHEMA', '比较对象 values 必须是对象', opath + '.values');
        Object.keys(obj.values).forEach(function (key) {
          if (!interactionHasOwn(dimensionIds, key)) {
            interactionReject(ctx, 'E_SCHEMA', '比较值引用了不存在的维度：' + key, opath + '.values.' + key);
          }
        });
        // Emit a plain object in dimension order: every dimension id is a safe
        // id, so this never touches a prototype member, and the canonical key
        // order keeps the JSON round-trip stable.
        var values = {};
        dimensions.forEach(function (dim) {
          var raw = obj.values[dim.id];
          values[dim.id] = interactionText(ctx, raw, '比较对象 ' + objId + ' 缺少维度 ' + dim.id + ' 的非空比较值', opath + '.values.' + dim.id);
        });
        return { id: objId, label: label, values: values };
      });
      canonical.objects = objects;
      canonical.dimensions = dimensions;
      return canonical;
    }

    // parameter: one built-in rule over author-declared numeric inputs. The
    // formula itself is never authored — only the verified rule name plus the
    // role -> input mapping, so no material-supplied text is ever evaluated.
    if (kind === 'parameter') {
      interactionRejectScriptKeys(ctx, item, itemPath);
      var rule = item.rule;
      if (typeof rule !== 'string' || !interactionHasOwn(INTERACTION_PARAMETER_RULES, rule)) {
        interactionReject(ctx, 'E_SCHEMA',
          '参数实验 rule ' + JSON.stringify(rule) + ' 尚不支持（当前仅支持 ' + Object.keys(INTERACTION_PARAMETER_RULES).join('/') + '）',
          itemPath + '.rule');
      }
      var roleNames = INTERACTION_PARAMETER_RULES[rule];
      if (!interactionIsRecord(item.roles)) interactionReject(ctx, 'E_SCHEMA', '参数实验 roles 必须是对象', itemPath + '.roles');
      Object.keys(item.roles).forEach(function (key) {
        if (roleNames.indexOf(key) === -1) {
          interactionReject(ctx, 'E_SCHEMA', '参数实验 roles 含有 ' + rule + ' 不支持的名称：' + key, itemPath + '.roles.' + key);
        }
      });
      if (!Array.isArray(item.inputs) || item.inputs.length === 0) {
        interactionReject(ctx, 'E_SCHEMA', '参数实验 inputs 至少需要 1 个可调输入', itemPath + '.inputs');
      }
      var parameterInputIds = interactionNullMap();
      var parameterInputs = item.inputs.map(function (input, iidx) {
        var ipath = itemPath + '.inputs[' + iidx + ']';
        if (!interactionIsRecord(input)) interactionReject(ctx, 'E_SCHEMA', '参数输入必须是对象', ipath);
        interactionRejectScriptKeys(ctx, input, ipath);
        var inputId = interactionSafeId(ctx, input.id, '参数输入 id 不合法', ipath + '.id');
        if (interactionHasOwn(parameterInputIds, inputId)) interactionReject(ctx, 'E_DUP_ID', '参数输入 id 重复：' + inputId, ipath + '.id');
        parameterInputIds[inputId] = true;
        var min = interactionFiniteNumber(ctx, input.min, '参数输入 min 必须是有限数值', ipath + '.min');
        var max = interactionFiniteNumber(ctx, input.max, '参数输入 max 必须是有限数值', ipath + '.max');
        if (!(min < max)) interactionReject(ctx, 'E_SCHEMA', '参数输入范围必须满足 min < max', ipath + '.max');
        var step = interactionFiniteNumber(ctx, input.step, '参数输入 step 必须是有限数值', ipath + '.step');
        if (!(step > 0)) interactionReject(ctx, 'E_SCHEMA', '参数输入 step 必须大于 0', ipath + '.step');
        var fallback = interactionFiniteNumber(ctx, input.default, '参数输入 default 必须是有限数值', ipath + '.default');
        if (fallback < min || fallback > max) {
          interactionReject(ctx, 'E_SCHEMA', '参数输入 default 必须落在 min 与 max 之间', ipath + '.default');
        }
        // A probability input is declared inside 0..1 so the frequency rule can
        // never be handed a rate outside the space it is defined on.
        if (rule === 'bayes-frequency' && (min < 0 || max > 1)) {
          interactionReject(ctx, 'E_SCHEMA', '贝叶斯频率演示的概率输入范围必须落在 0 与 1 之间', ipath + '.max');
        }
        return {
          id: inputId,
          label: interactionText(ctx, input.label, '参数输入 label 必填且非空', ipath + '.label'),
          // A unit is declared, never inferred: a dimensionless quantity is
          // written as `1` and a probability scale as, for example, `比例0..1`,
          // so the process line and the readout always state their units.
          unit: interactionText(ctx, input.unit, '参数输入 unit（单位）必填且非空；无量纲请写 1', ipath + '.unit'),
          min: min,
          max: max,
          step: step,
          default: fallback,
        };
      });
      var parameterRoles = {};
      roleNames.forEach(function (role) {
        var rpath = itemPath + '.roles.' + role;
        var mappedId = interactionText(ctx, item.roles[role], '参数实验 roles 缺少 ' + role + '（或它不是非空字符串）', rpath);
        if (!interactionHasOwn(parameterInputIds, mappedId)) {
          interactionReject(ctx, 'E_SCHEMA', '参数实验 roles.' + role + ' 指向不存在的输入：' + mappedId, rpath);
        }
        for (var assigned = 0; assigned < roleNames.length; assigned += 1) {
          if (roleNames[assigned] !== role && parameterRoles[roleNames[assigned]] === mappedId) {
            interactionReject(ctx, 'E_SCHEMA', '参数实验 roles 不能把同一个输入用于多个角色：' + mappedId, rpath);
          }
        }
        parameterRoles[role] = mappedId;
      });
      canonical.rule = rule;
      canonical.roles = parameterRoles;
      canonical.inputs = parameterInputs;
      canonical.outputLabel = interactionText(ctx, item.outputLabel,
        '参数实验 outputLabel（结果名称）必填且非空', itemPath + '.outputLabel');
      canonical.outputUnit = interactionText(ctx, item.outputUnit,
        '参数实验 outputUnit（结果单位）必填且非空', itemPath + '.outputUnit');
      return canonical;
    }

    // step-through: an explicit starting state plus an ordered list of legal
    // steps. Each step names where the walkthrough lands, what changed and why,
    // so the page can show the current result and its cause without executing
    // any author data.
    canonical.initialState = interactionText(ctx, item.initialState,
      '分步推演的 initialState（初始状态）必填且非空', itemPath + '.initialState');
    if (!Array.isArray(item.steps) || item.steps.length < 2) {
      interactionReject(ctx, 'E_SCHEMA', '分步推演至少要 2 个合法步骤', itemPath + '.steps');
    }
    var stepIds = interactionNullMap();
    canonical.steps = item.steps.map(function (step, sidx) {
      var spath = itemPath + '.steps[' + sidx + ']';
      if (!interactionIsRecord(step)) interactionReject(ctx, 'E_SCHEMA', '推演步骤必须是对象', spath);
      var stepId = interactionSafeId(ctx, step.id, '推演步骤 id 不合法', spath + '.id');
      if (interactionHasOwn(stepIds, stepId)) interactionReject(ctx, 'E_DUP_ID', '推演步骤 id 重复：' + stepId, spath + '.id');
      stepIds[stepId] = true;
      return {
        id: stepId,
        label: interactionText(ctx, step.label, '推演步骤 label 必填且非空', spath + '.label'),
        result: interactionText(ctx, step.result, '推演步骤 result（当前结果）必填且非空', spath + '.result'),
        change: interactionText(ctx, step.change, '推演步骤 change（状态变化）必填且非空', spath + '.change'),
        cause: interactionText(ctx, step.cause, '推演步骤 cause（因果关系）必填且非空', spath + '.cause'),
      };
    });
    return canonical;
  });
}

/**
 * Canonical plain-JSON projection of a normalized interaction, used by
 * `modelToJson` so the serialized form, the fingerprint payload and a rebuild
 * round-trip stay byte-for-byte identical.
 */
export function interactionToJson(interaction) {
  var out = {
    kind: interaction.kind,
    id: interaction.id,
    conceptId: interaction.conceptId,
    title: interaction.title,
    objective: interaction.objective,
    boundary: interaction.boundary,
    question: interaction.question,
  };
  if (interaction.promptId) out.promptId = interaction.promptId;
  if (Array.isArray(interaction.relatedConceptIds) && interaction.relatedConceptIds.length > 0) {
    out.relatedConceptIds = interaction.relatedConceptIds.slice();
  }
  if (interaction.kind === 'step-through') {
    out.initialState = interaction.initialState;
    out.steps = (interaction.steps || []).map(function (step) {
      return { id: step.id, label: step.label, result: step.result, change: step.change, cause: step.cause };
    });
    return out;
  }
  if (interaction.kind === 'parameter') {
    out.rule = interaction.rule;
    out.roles = {};
    (INTERACTION_PARAMETER_RULES[interaction.rule] || []).forEach(function (role) {
      out.roles[role] = interaction.roles[role];
    });
    out.inputs = (interaction.inputs || []).map(function (input) {
      return {
        id: input.id,
        label: input.label,
        unit: input.unit,
        min: input.min,
        max: input.max,
        step: input.step,
        default: input.default,
      };
    });
    out.outputLabel = interaction.outputLabel;
    out.outputUnit = interaction.outputUnit;
    return out;
  }
  out.objects = (interaction.objects || []).map(function (obj) {
    var values = {};
    (interaction.dimensions || []).forEach(function (dim) {
      if (interactionHasOwn(obj.values, dim.id)) values[dim.id] = obj.values[dim.id];
    });
    return { id: obj.id, label: obj.label, values: values };
  });
  out.dimensions = (interaction.dimensions || []).map(function (dim) {
    return { id: dim.id, label: dim.label, difference: dim.difference, boundary: dim.boundary };
  });
  return out;
}

function interactionList(model) {
  return model && Array.isArray(model.interactions) ? model.interactions : [];
}

function interactionFindById(list, id) {
  if (typeof id !== 'string' || id === '') return null;
  for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  return null;
}

export function interactionById(model, interactionId) {
  return interactionFindById(interactionList(model), interactionId);
}

/** Interactions configured for one concept, in model order. */
export function interactionForConcept(model, conceptId) {
  return interactionList(model).filter(function (interaction) { return interaction.conceptId === conceptId; });
}

function interactionResolve(list, id, fallback) {
  return interactionFindById(list, id) || interactionFindById(list, fallback);
}

/**
 * The read model the concept-detail comparison card renders. Pure: it depends
 * only on the normalized interaction and the current selection, so the page and
 * any caller see exactly the same values, difference and boundary.
 *
 * Selecting the same object twice is explicitly not comparable: the view says
 * so instead of fabricating a difference between an item and itself.
 */
export function interactionComparisonView(interaction, selection) {
  var sel = selection || {};
  var objects = interaction && Array.isArray(interaction.objects) ? interaction.objects : [];
  var dimensions = interaction && Array.isArray(interaction.dimensions) ? interaction.dimensions : [];
  var defaultAId = objects.length > 0 ? objects[0].id : null;
  var defaultBId = objects.length > 1 ? objects[1].id : null;
  var objectA = interactionResolve(objects, typeof sel.objectAId === 'string' ? sel.objectAId : null, defaultAId);
  var objectB = interactionResolve(objects, typeof sel.objectBId === 'string' ? sel.objectBId : null, defaultBId);
  var dimension = interactionResolve(dimensions, typeof sel.dimensionId === 'string' ? sel.dimensionId : null, dimensions.length > 0 ? dimensions[0].id : null);
  var comparable = Boolean(objectA && objectB && objectA.id !== objectB.id && dimension);
  var reason = null;
  if (!comparable) {
    if (objectA && objectB && objectA.id === objectB.id) reason = '同一项无法比较：请选择两个不同的比较对象';
    else if (!dimension) reason = '该组件没有可用的比较维度';
    else reason = '请选择两个不同的比较对象';
  }
  return {
    interactionId: interaction ? interaction.id : null,
    kind: interaction ? interaction.kind : null,
    conceptId: interaction ? interaction.conceptId : null,
    title: interaction ? interaction.title : '',
    objective: interaction ? interaction.objective : '',
    question: interaction ? interaction.question : '',
    promptId: interaction && interaction.promptId ? interaction.promptId : null,
    relatedConceptIds: interaction && Array.isArray(interaction.relatedConceptIds) ? interaction.relatedConceptIds.slice() : [],
    objects: objects.map(function (obj) { return { id: obj.id, label: obj.label }; }),
    dimensions: dimensions.map(function (dim) { return { id: dim.id, label: dim.label, difference: dim.difference, boundary: dim.boundary }; }),
    selection: {
      objectAId: objectA ? objectA.id : null,
      objectBId: objectB ? objectB.id : null,
      dimensionId: dimension ? dimension.id : null,
    },
    comparable: comparable,
    notComparableReason: reason,
    values: {
      a: comparable ? objectA.values[dimension.id] : null,
      b: comparable ? objectB.values[dimension.id] : null,
    },
    difference: comparable ? dimension.difference : null,
    // `boundary` is the selected dimension's applicability boundary; the
    // component-wide boundary stays under `interactionBoundary` so the two
    // layers never collapse into one ambiguous key.
    boundary: comparable ? dimension.boundary : null,
    interactionBoundary: interaction ? interaction.boundary : null,
  };
}

// ----- step-through (ticket 11) -------------------------------------------
// A walkthrough exposes an explicit initial state and an ordered list of legal
// steps. The learner's position is a step id plus an exact content signature, so
// a position survives reopening, export/import and a rebuild, and is reported as
// stale (never silently "restored") once the authored content changed.

// A deterministic, key-order-independent serialization used ONLY as a content
// identity string. It is deliberately an exact canonical string, not a weak or
// truncated hash: two configs compare equal only when every field matches.
function interactionCanonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(interactionCanonicalJson).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    var keys = Object.keys(value).filter(function (key) { return value[key] !== undefined; }).sort();
    return '{' + keys.map(function (key) {
      return JSON.stringify(key) + ':' + interactionCanonicalJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The exact content signature of one normalized interaction. Identity checks
 * compare this string for equality; nothing is ever "close enough".
 */
export function interactionContentSignature(interaction) {
  return interaction ? interactionCanonicalJson(interactionToJson(interaction)) : null;
}

function interactionStepsOf(interaction) {
  return interaction && Array.isArray(interaction.steps) ? interaction.steps : [];
}

function interactionStepIndexOf(interaction, stepId) {
  if (typeof stepId !== 'string') return -1;
  var steps = interactionStepsOf(interaction);
  for (var i = 0; i < steps.length; i += 1) if (steps[i].id === stepId) return i;
  return -1;
}

/** True when the step id is one of the walkthrough's legal steps. */
export function interactionStepExists(interaction, stepId) {
  return interactionStepIndexOf(interaction, stepId) !== -1;
}

/**
 * Canonical position record for one walkthrough step. The same builder runs in
 * the backend and (if needed) the page, so a saved position is byte-identical
 * whichever surface recorded it.
 */
export function interactionPositionFor(interaction, stepId, source, at) {
  return {
    interactionId: interaction.id,
    conceptId: interaction.conceptId,
    stepId: stepId,
    contentSignature: interactionContentSignature(interaction),
    updatedAt: at,
    source: source,
  };
}

/**
 * Read model for one step-through interaction. `savedPosition` is the record the
 * archive holds (or null). The returned view always exposes the legal step list,
 * the initial step and the current step's result/change/cause; a saved position
 * is restored only when it is the same content signature AND still a legal step,
 * otherwise `stale` is true and the view opens on the initial step.
 */
export function interactionStepView(interaction, savedPosition) {
  var steps = interactionStepsOf(interaction);
  var total = steps.length;
  var signature = interaction ? interactionContentSignature(interaction) : null;
  var saved = interactionIsRecord(savedPosition) ? savedPosition : null;
  var restored = false;
  var stale = false;
  var staleReason = null;
  var index = 0;
  if (saved && typeof saved.stepId === 'string') {
    var savedIndex = interactionStepIndexOf(interaction, saved.stepId);
    if (saved.contentSignature !== signature) {
      stale = true;
      staleReason = '互动内容已更新，原位置失效；已回到初始步骤，可在此重新保存位置';
    } else if (savedIndex === -1) {
      stale = true;
      staleReason = '原步骤已被移除，原位置失效；已回到初始步骤，可在此重新保存位置';
    } else {
      restored = true;
      index = savedIndex;
    }
  }
  if (index < 0 || index >= total) index = 0;
  var current = total > 0 ? steps[index] : null;
  return {
    interactionId: interaction ? interaction.id : null,
    kind: interaction ? interaction.kind : null,
    conceptId: interaction ? interaction.conceptId : null,
    title: interaction ? interaction.title : '',
    objective: interaction ? interaction.objective : '',
    boundary: interaction ? interaction.boundary : '',
    question: interaction ? interaction.question : '',
    promptId: interaction && interaction.promptId ? interaction.promptId : null,
    relatedConceptIds: interaction && Array.isArray(interaction.relatedConceptIds) ? interaction.relatedConceptIds.slice() : [],
    initialState: interaction && typeof interaction.initialState === 'string' ? interaction.initialState : '',
    steps: steps.map(function (step) {
      return { id: step.id, label: step.label, result: step.result, change: step.change, cause: step.cause };
    }),
    selection: { stepId: current ? current.id : null },
    current: current ? { id: current.id, label: current.label, result: current.result, change: current.change, cause: current.cause } : null,
    index: index,
    total: total,
    stepNumber: total > 0 ? index + 1 : 0,
    initialStepId: total > 0 ? steps[0].id : null,
    atFirst: index === 0,
    atLast: total > 0 && index === total - 1,
    canGoBack: index > 0,
    canGoForward: index < total - 1,
    contentSignature: signature,
    restored: restored,
    stale: stale,
    staleReason: staleReason,
    saved: saved ? {
      stepId: saved.stepId,
      updatedAt: saved.updatedAt ?? null,
      source: saved.source ?? null,
      contentSignature: saved.contentSignature ?? null,
    } : null,
  };
}

// ----- parameter experiment (ticket 12) ------------------------------------
//
// One built-in, verified rule over author-declared numeric inputs. The page
// reads the declarations straight off the normalized interaction (`rule`,
// `roles`, `inputs`, `outputLabel`, `outputUnit`) and calls this read model for
// every change, so the backend, the page and any public caller compute the same
// number from the same rules. Nothing here evaluates author text: an invalid or
// missing value is reported as "cannot compute" and never clamped to a range
// endpoint, and a stale normal-looking result is never shown as a new one.

function interactionParameterRole(interaction, role) {
  var roles = interaction && interactionIsRecord(interaction.roles) ? interaction.roles : {};
  return typeof roles[role] === 'string' ? roles[role] : '';
}

function interactionParameterInput(interaction, inputId) {
  var inputs = interaction && Array.isArray(interaction.inputs) ? interaction.inputs : [];
  for (var i = 0; i < inputs.length; i += 1) if (inputs[i].id === inputId) return inputs[i];
  return null;
}

// Readable number text for the process line only: the computed `result` always
// keeps full precision. Six significant digits keep ordinary values readable
// without ever overflowing (multiplying 1e308 by 1e6 would be Infinity) and
// without rounding a tiny non-zero value down to a literal 0, which would make
// the process line claim a zero denominator it never had. A non-finite value is
// rendered as an em dash, which is what an unfilled input shows.
function interactionNumberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  return String(Number(value.toPrecision(6)));
}

// Units read naturally: an ASCII unit is separated by a space ("60 km/h"), a
// CJK unit is appended directly ("10人").
function interactionWithUnit(text, unit) {
  if (typeof unit !== 'string' || unit === '') return String(text);
  return (/^[A-Za-z]/.test(unit) ? String(text) + ' ' + unit : String(text) + unit);
}

function interactionParameterParse(input, raw) {
  var range = interactionWithUnit(interactionNumberText(input.min), input.unit) + ' ~ ' +
    interactionWithUnit(interactionNumberText(input.max), input.unit);
  if (raw === undefined || raw === null) return { ok: false, value: null, reason: input.label + ' 尚未填写（允许范围 ' + range + '）' };
  // Only a number or a numeric string is real control input. A boolean, array or
  // object is refused by type instead of being coerced (`Number(true)` is 1 and
  // `Number([])` is 0, which would silently invent a value).
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, value: null, reason: input.label + ' 只接受数值或数字字符串（收到 ' + interactionValueKind(raw) + '）' };
  }
  var text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '') return { ok: false, value: null, reason: input.label + ' 尚未填写（允许范围 ' + range + '）' };
  if (typeof text === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return { ok: false, value: null, reason: input.label + ' 只接受十进制或科学计数法数字：' + text };
  }
  var value = typeof raw === 'number' ? raw : Number(text);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, value: null, reason: input.label + ' 不是可计算的有限数值：' + String(text) };
  }
  if (value < input.min || value > input.max) {
    return { ok: false, value: null, reason: input.label + ' 超出允许范围 ' + range + '：' + String(text) + '（不会自动夹到端点）' };
  }
  return { ok: true, value: value, reason: null };
}

function interactionParameterOperand(input, parsedValues) {
  if (!input) return '—';
  var value = parsedValues[input.id];
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return interactionWithUnit(interactionNumberText(value), input.unit);
}

function interactionValueKind(value) {
  if (Array.isArray(value)) return '数组';
  if (value !== null && typeof value === 'object') return '对象';
  return typeof value;
}

/**
 * The shared parameter read model. `values` is a plain map of inputId to the raw
 * value the page holds (usually the `<input>` string); empty, non-finite,
 * out-of-range, zero-denominator and overflow states all return
 * `valid:false` with a readable `error` and `result:null`, while `process`
 * keeps showing the formula and units so the learner can see what is missing.
 */
export function interactionParameterView(interaction, values) {
  var given = interactionIsRecord(values) ? values : {};
  var inputs = interaction && Array.isArray(interaction.inputs) ? interaction.inputs : [];
  var parsedValues = {};
  var inputErrors = {};
  var firstError = null;
  var firstErrorCode = null;
  for (var i = 0; i < inputs.length; i += 1) {
    // A key that was never supplied means the control has not been touched yet:
    // the declared default is shown AND computed, so the first render and the
    // first change agree. An explicitly present key (even `''`, `null` or
    // `undefined`) is real input and is reported instead of silently falling
    // back to the default.
    var raw = interactionHasOwn(given, inputs[i].id) ? given[inputs[i].id] : inputs[i].default;
    var parsed = interactionParameterParse(inputs[i], raw);
    parsedValues[inputs[i].id] = parsed.ok ? parsed.value : null;
    inputErrors[inputs[i].id] = parsed.ok ? null : parsed.reason;
    if (!parsed.ok && firstError === null) { firstError = parsed.reason; firstErrorCode = 'E_VALUE'; }
  }

  var rule = interaction ? interaction.rule : null;
  var roleNames = INTERACTION_PARAMETER_RULES[rule] || null;
  var roles = {};
  if (roleNames) roleNames.forEach(function (role) { roles[role] = interactionParameterRole(interaction, role); });
  var outputLabel = interaction ? interaction.outputLabel : '';
  var outputUnit = interaction ? interaction.outputUnit : '';
  var formula = '';
  var result = null;
  var error = firstError;
  var errorCode = firstErrorCode;

  if (!interaction) {
    error = '未配置参数互动';
    errorCode = 'E_STATE';
  } else if (!roleNames) {
    error = '不支持的参数规则：' + JSON.stringify(rule);
    errorCode = 'E_SCHEMA';
  } else if (rule === 'ratio') {
    var ratioNum = interactionParameterInput(interaction, roles.numerator);
    var ratioDen = interactionParameterInput(interaction, roles.denominator);
    formula = outputLabel + ' = ' + (ratioNum ? ratioNum.label : '分子') + ' ÷ ' + (ratioDen ? ratioDen.label : '分母') +
      ' = ' + interactionParameterOperand(ratioNum, parsedValues) + ' ÷ ' + interactionParameterOperand(ratioDen, parsedValues);
    if (error === null) {
      if (parsedValues[roles.denominator] === 0) {
        error = (ratioDen ? ratioDen.label : '分母') + ' 为 0，无法计算（除数不能为 0）';
        errorCode = 'E_ZERO_DENOMINATOR';
      } else {
        result = parsedValues[roles.numerator] / parsedValues[roles.denominator];
      }
    }
  } else if (rule === 'product') {
    var productLeft = interactionParameterInput(interaction, roles.left);
    var productRight = interactionParameterInput(interaction, roles.right);
    formula = outputLabel + ' = ' + (productLeft ? productLeft.label : '左值') + ' × ' + (productRight ? productRight.label : '右值') +
      ' = ' + interactionParameterOperand(productLeft, parsedValues) + ' × ' + interactionParameterOperand(productRight, parsedValues);
    if (error === null) result = parsedValues[roles.left] * parsedValues[roles.right];
  } else {
    var prior = interactionParameterInput(interaction, roles.prior);
    var sensitivity = interactionParameterInput(interaction, roles.sensitivity);
    var falsePositive = interactionParameterInput(interaction, roles.falsePositive);
    var priorLabel = prior ? prior.label : '先验';
    var sensitivityLabel = sensitivity ? sensitivity.label : '灵敏度';
    var falsePositiveLabel = falsePositive ? falsePositive.label : '假阳性率';
    var priorText = interactionParameterOperand(prior, parsedValues);
    var sensitivityText = interactionParameterOperand(sensitivity, parsedValues);
    var falsePositiveText = interactionParameterOperand(falsePositive, parsedValues);
    formula = outputLabel + ' = ' + sensitivityLabel + ' × ' + priorLabel +
      ' ÷ (' + sensitivityLabel + ' × ' + priorLabel + ' + ' + falsePositiveLabel + ' × (1 − ' + priorLabel + '))' +
      ' = ' + sensitivityText + ' × ' + priorText +
      ' ÷ (' + sensitivityText + ' × ' + priorText + ' + ' + falsePositiveText + ' × (1 − ' + priorText + '))';
    if (error === null) {
      var truePositive = parsedValues[roles.sensitivity] * parsedValues[roles.prior];
      var positiveTotal = truePositive + parsedValues[roles.falsePositive] * (1 - parsedValues[roles.prior]);
      if (positiveTotal === 0) {
        error = '所给条件下阳性事件的概率为 0，不能计算阳性条件下的后验概率';
        errorCode = 'E_ZERO_DENOMINATOR';
      } else {
        result = truePositive / positiveTotal;
      }
    }
  }

  if (error === null && (typeof result !== 'number' || !Number.isFinite(result))) {
    error = '计算结果超出可表示范围，已拒绝显示';
    errorCode = 'E_OVERFLOW';
  }
  var valid = error === null && typeof result === 'number' && Number.isFinite(result);
  var processText = valid ? formula + ' = ' + interactionWithUnit(interactionNumberText(result), outputUnit) : formula;

  return {
    interactionId: interaction ? interaction.id : null,
    kind: interaction ? interaction.kind : null,
    conceptId: interaction ? interaction.conceptId : null,
    title: interaction ? interaction.title : '',
    objective: interaction ? interaction.objective : '',
    boundary: interaction ? interaction.boundary : '',
    question: interaction ? interaction.question : '',
    promptId: interaction && interaction.promptId ? interaction.promptId : null,
    relatedConceptIds: interaction && Array.isArray(interaction.relatedConceptIds) ? interaction.relatedConceptIds.slice() : [],
    rule: rule,
    roles: roles,
    inputs: inputs.map(function (input) {
      return {
        id: input.id, label: input.label, unit: input.unit,
        min: input.min, max: input.max, step: input.step, default: input.default,
      };
    }),
    values: parsedValues,
    inputErrors: inputErrors,
    outputLabel: outputLabel,
    outputUnit: outputUnit,
    valid: valid,
    error: valid ? null : error,
    errorCode: valid ? null : errorCode,
    result: valid ? result : null,
    resultText: valid ? interactionWithUnit(interactionNumberText(result), outputUnit) : null,
    process: processText,
    // The page reads `process`; `formula` is the same readable line under the
    // name callers asked for, so both keys always agree.
    formula: processText,
    contentSignature: interaction ? interactionContentSignature(interaction) : null,
  };
}

// ---------------------------------------------------------------------------
// Walkthrough positions (ticket 11).
//
// These three entries are the ONE rule set for a saved step position: the Node
// backend wraps them with the shared error class and the archive writer, and the
// standalone viewer inlines this module and calls them directly, so no surface
// keeps a second copy of the position rules.
//
// A position is a strict, self-describing learner record: the exact field set, a
// key equal to `interactionId`, a real time and a known source. Anything else is
// malformed typed data and fails closed instead of being read as honest history.
// The interaction and step are NOT required to still exist: a position for
// removed content stays in the archive as history.
// ---------------------------------------------------------------------------

var INTERACTION_POSITION_FIELDS = ['interactionId', 'conceptId', 'stepId', 'contentSignature', 'updatedAt', 'source'];
var INTERACTION_POSITION_SOURCES = ['browser', 'cli'];

function interactionClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Write an ID-keyed entry without ever invoking an inherited setter (`__proto__`
// is rejected upstream, but defineProperty keeps the dictionary shape explicit).
function interactionSetOwn(bucket, key, value) {
  Object.defineProperty(bucket, key, {
    value: value, enumerable: true, writable: true, configurable: true,
  });
  return bucket;
}

function interactionOwnEntry(bucket, key) {
  if (bucket === null || bucket === undefined || key === null || key === undefined) return undefined;
  return interactionHasOwn(bucket, key) ? bucket[key] : undefined;
}

function interactionValidTime(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

/**
 * Validate ONE position record against its bucket key. Returns the record so a
 * caller can chain, and throws a coded error otherwise. `context.fail` may
 * translate that error (the Node backend supplies the shared EmberError); the
 * fallback is a plain Error carrying `code` and `path`.
 */
export function interactionValidatePosition(id, position, context) {
  var ctx = context || {};
  var path = 'interactionPositions.' + id;
  if (!interactionIsRecord(position)) interactionReject(ctx, 'E_STATE', '互动位置必须是对象', path);
  var keys = Object.keys(position);
  for (var i = 0; i < keys.length; i += 1) {
    if (INTERACTION_POSITION_FIELDS.indexOf(keys[i]) === -1) {
      interactionReject(ctx, 'E_STATE', '互动位置包含未知字段：' + keys[i], path + '.' + keys[i]);
    }
  }
  for (var j = 0; j < INTERACTION_POSITION_FIELDS.length; j += 1) {
    if (!interactionHasOwn(position, INTERACTION_POSITION_FIELDS[j])) {
      interactionReject(ctx, 'E_STATE', '互动位置缺少字段 ' + INTERACTION_POSITION_FIELDS[j], path + '.' + INTERACTION_POSITION_FIELDS[j]);
    }
  }
  if (typeof position.interactionId !== 'string' || position.interactionId !== id) {
    interactionReject(ctx, 'E_STATE', '互动位置的键必须等于 interactionId', path + '.interactionId');
  }
  var textFields = ['conceptId', 'stepId', 'contentSignature'];
  for (var k = 0; k < textFields.length; k += 1) {
    if (typeof position[textFields[k]] !== 'string' || position[textFields[k]].trim() === '') {
      interactionReject(ctx, 'E_STATE', '互动位置 ' + textFields[k] + ' 必须是非空字符串', path + '.' + textFields[k]);
    }
  }
  if (INTERACTION_POSITION_SOURCES.indexOf(position.source) === -1) {
    interactionReject(ctx, 'E_STATE', '互动位置 source 只能是 browser 或 cli', path + '.source');
  }
  if (!interactionValidTime(position.updatedAt)) {
    interactionReject(ctx, 'E_STATE', '互动位置 updatedAt 必须是合法时间', path + '.updatedAt');
  }
  return position;
}

/**
 * Validate a raw `interactionPositions` bucket. An absent bucket (`undefined`)
 * is a legacy archive and reads as "no positions"; an explicit `null`, an array
 * or any other non-object is malformed typed data and is refused rather than
 * coerced to `{}` (which would silently drop real history). Every present record
 * is checked with `interactionValidatePosition`. Returns the bucket (`null` when
 * absent) so the caller can use the validated value directly.
 */
export function interactionValidatePositions(raw, context) {
  var ctx = context || {};
  if (raw === undefined) return null;
  if (raw === null) {
    interactionReject(ctx, 'E_STATE', 'interactionPositions 不能为 null（旧档可省略该字段）', 'interactionPositions');
  }
  if (!interactionIsRecord(raw)) {
    interactionReject(ctx, 'E_STATE', 'interactionPositions 必须是对象（旧档可省略该字段）', 'interactionPositions');
  }
  var ids = Object.keys(raw);
  for (var i = 0; i < ids.length; i += 1) interactionValidatePosition(ids[i], raw[ids[i]], ctx);
  return raw;
}

/**
 * Build the canonical record of the learner's current walkthrough position plus
 * the state that persists it. This is observation only: it never writes an
 * attempt, rating, hint, note or mastery evidence, and it never touches another
 * interaction's position (the map is keyed by `interactionId`). The stored
 * `contentSignature` is the exact normalized interaction string, so a later
 * reader restores the position only while the authored content is unchanged. An
 * unknown interaction, a non-step-through interaction, an unknown step or an
 * unknown source is refused with a usage error instead of writing a position
 * that can never be reopened.
 *
 * Returns `{ state, position, interaction, contentSignature }`; `state` is a
 * fresh clone, so the caller's state is never mutated.
 */
export function interactionRecordPosition(state, model, input, at) {
  var ctx = {};
  if (!interactionIsRecord(input)) interactionReject(ctx, 'E_USAGE', '互动位置需要对象输入');
  var interactionId = input.interactionId;
  var stepId = input.stepId;
  if (typeof interactionId !== 'string' || interactionId.trim() === '') {
    interactionReject(ctx, 'E_USAGE', '互动位置需要 interactionId');
  }
  if (typeof stepId !== 'string' || stepId.trim() === '') {
    interactionReject(ctx, 'E_USAGE', '互动位置需要 stepId');
  }
  var source = input.source === 'cli' ? 'cli' : input.source === 'browser' ? 'browser' : null;
  if (source === null) interactionReject(ctx, 'E_USAGE', '互动位置 source 只能是 browser 或 cli');
  var interaction = interactionById(model, interactionId);
  if (!interaction) interactionReject(ctx, 'E_USAGE', '互动组件不存在：' + interactionId);
  if (interaction.kind !== 'step-through') {
    interactionReject(ctx, 'E_USAGE', '互动组件 ' + interactionId + ' 不是分步推演（kind=' + interaction.kind + '），无法保存位置');
  }
  if (!interactionStepExists(interaction, stepId)) {
    interactionReject(ctx, 'E_USAGE', '分步推演 ' + interactionId + ' 没有步骤 ' + stepId);
  }
  var nextState = interactionClone(state);
  if (!interactionIsRecord(nextState.interactionPositions)) nextState.interactionPositions = {};
  var position = interactionPositionFor(interaction, stepId, source, at);
  interactionSetOwn(nextState.interactionPositions, interactionId, position);
  nextState.revision = (Number.isInteger(nextState.revision) ? nextState.revision : 0) + 1;
  nextState.updatedAt = at;
  return {
    state: nextState,
    position: position,
    interaction: interaction,
    contentSignature: interactionContentSignature(interaction),
  };
}

/**
 * Merge two walkthrough-position maps. A position is a single learner fact per
 * interaction, so a same-id divergence keeps the newer `updatedAt` (a tie keeps
 * the current branch) and records the other branch in `conflicts`. Both versions
 * stay readable in the archive; nothing is silently overwritten and no other
 * interaction's position is affected. The conflict record carries `id` once —
 * the interaction id — beside the readable `kept`/`other` versions.
 */
export function interactionMergePositions(current, incoming, conflicts, at) {
  var out = interactionClone(current && typeof current === 'object' ? current : {});
  var ids = Object.keys(incoming && typeof incoming === 'object' ? incoming : {});
  for (var i = 0; i < ids.length; i += 1) {
    var id = ids[i];
    var position = incoming[id];
    var existing = interactionOwnEntry(out, id);
    if (existing === undefined) { interactionSetOwn(out, id, position); continue; }
    if (interactionCanonicalJson(existing) === interactionCanonicalJson(position)) { interactionSetOwn(out, id, existing); continue; }
    var existingAt = new Date(existing.updatedAt ?? 0).getTime();
    var incomingAt = new Date(position.updatedAt ?? 0).getTime();
    var chosen = incomingAt > existingAt ? position : existing;
    interactionSetOwn(out, id, chosen);
    conflicts.push({
      kind: 'interaction-position',
      id: id,
      path: 'interactionPositions.' + id,
      kept: chosen,
      other: chosen === position ? existing : position,
      message: '互动位置（' + id + '）存在分歧，保留较新一次的位置并报告另一版',
      at: at,
    });
  }
  return out;
}

export var INTERACTION_CONSTANTS = Object.freeze({
  KINDS: INTERACTION_KINDS,
  ID_RE: INTERACTION_ID_RE,
  FORBIDDEN_IDS: INTERACTION_FORBIDDEN_IDS,
  PARAMETER_RULES: INTERACTION_PARAMETER_RULES,
  PARAMETER_SCRIPT_KEYS: INTERACTION_PARAMETER_SCRIPT_KEYS,
});
