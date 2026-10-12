// 材料地图：作者侧阅读范围记录，保存在 quality.json 的可选 materialMap 字段。
//
// 这一层只做两件事：校验作者写下的范围结构，以及把它与当前模型对照，派生出
// 「哪些范围仍可读、哪些已失效」。它不判断语义、不证明读过、也不提高掌握度。
//
// 依赖约束与 interactions.mjs 相同：保持无依赖、可移植——不 import 其他文件，
// 不使用 fs/path/crypto/process。Node 侧由 quality.mjs 注入 fail 工厂得到
// EmberError；内部辅助函数沿用 materialMap* 领域前缀。
//
// 读取时只容忍两件事：完全没有地图（旧记录），以及地图引用到后来被移除的
// 来源／概念（历史引用）。这两种情况保留作者写下的范围并派生 stale，不做
// 逐字段抢救，也不猜测作者没写的内容。

// 来源快照的四个字段与模型来源一一对应。缺失的可选属性在模板里就是空字符串，
// 不用 null：快照必须能逐字与当前来源比较。
var MATERIAL_MAP_SNAPSHOT_FIELDS = ['title', 'kind', 'note', 'url'];
var MATERIAL_MAP_GAP_EFFECTS = ['blocking', 'supplementable'];
var MATERIAL_MAP_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var MATERIAL_MAP_FORBIDDEN_IDS = ['__proto__', 'constructor', 'prototype'];
// 读取时间只接受 ISO 日期/时间；Date.parse 单独用会把 '5' 之类当成合法时间。
var MATERIAL_MAP_TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
var MATERIAL_MAP_UNKNOWN_REASON = '还没有材料地图：当前阅读范围未知，未核对内容不能记作已核对';
var MATERIAL_MAP_UNRECORDED_REASON = '未包含在材料地图记录中：该来源的阅读范围未知，不表示已核对';

function materialMapHasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function materialMapIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Errors stay plain so this module needs no shared error class; the Node caller
// supplies a `fail` that returns the error to throw (an EmberError there).
function materialMapFail(code, message, path) {
  var err = new Error(path ? message + '（位置：' + path + '）' : message);
  err.code = code;
  err.rawMessage = message;
  if (path) err.path = path;
  return err;
}

function materialMapReject(context, code, message, where) {
  if (context && context.historical) return;
  var fail = context && typeof context.fail === 'function' ? context.fail : materialMapFail;
  throw fail(code, message, where);
}

function materialMapIndex(list) {
  var index = Object.create(null);
  if (!Array.isArray(list)) return index;
  for (var i = 0; i < list.length; i += 1) {
    var item = list[i];
    if (materialMapIsRecord(item) && typeof item.id === 'string' && item.id !== '') index[item.id] = item;
  }
  return index;
}

function materialMapTextValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function materialMapText(context, value, message, where) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  materialMapReject(context, 'E_SCHEMA', message, where);
  return '';
}

function materialMapId(context, value, where) {
  var id = materialMapText(context, value, '材料地图缺少合法的 ' + where + '；id 只能是 [a-z0-9-] 且首尾为小写字母或数字', where);
  if (id === '') return '';
  if (!MATERIAL_MAP_ID_RE.test(id) || MATERIAL_MAP_FORBIDDEN_IDS.indexOf(id) !== -1) {
    materialMapReject(context, 'E_ID', '材料地图的 ' + where + ' 不合法：收到 ' + JSON.stringify(value), where);
    return '';
  }
  return id;
}

// 省略字段等于「没有声明」，显式 null 不是空数组的替代写法：写入一律拒绝。
function materialMapTextList(context, value, label, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    materialMapReject(context, 'E_SCHEMA', label + ' 必须是非空字符串数组；没有内容时省略或留空数组，不要用 null', where);
    return [];
  }
  var out = [];
  for (var i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string' || value[i].trim() === '') {
      materialMapReject(context, 'E_SCHEMA', label + ' 每一项都必须是非空字符串', where + '[' + i + ']');
      continue;
    }
    out.push(value[i].trim());
  }
  return out;
}

function materialMapRecordList(context, value, label, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    materialMapReject(context, 'E_SCHEMA', label + ' 必须是数组；没有内容时省略或留空数组，不要用 null', where);
    return [];
  }
  var out = [];
  for (var i = 0; i < value.length; i += 1) {
    if (!materialMapIsRecord(value[i])) {
      materialMapReject(context, 'E_SCHEMA', label + ' 每一项都必须是对象', where + '[' + i + ']');
      continue;
    }
    out.push(value[i]);
  }
  return out;
}

function materialMapTime(value) {
  return MATERIAL_MAP_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** 模型来源的规范快照：缺失的可选属性是空字符串，不是 null。 */
export function materialMapSourceSnapshot(source) {
  var snapshot = {};
  for (var i = 0; i < MATERIAL_MAP_SNAPSHOT_FIELDS.length; i += 1) {
    var field = MATERIAL_MAP_SNAPSHOT_FIELDS[i];
    snapshot[field] = materialMapIsRecord(source) ? materialMapTextValue(source[field]) : '';
  }
  return snapshot;
}

/**
 * 模板骨架：只预填来源身份与快照，所有覆盖信息保持空。空 checked 表示阅读
 * 范围未知——工具不会替作者写下一个「已核对」标记。
 */
export function materialMapSkeleton(sources) {
  var list = Array.isArray(sources) ? sources : [];
  return {
    sources: list.map(function (source) {
      return {
        sourceId: materialMapTextValue(source && source.id),
        sourceSnapshot: materialMapSourceSnapshot(source),
        version: null,
        structure: [],
        goalScope: [],
        checked: [],
        unread: [],
        gaps: [],
      };
    }),
  };
}

function materialMapBlankSource() {
  return {
    sourceId: '',
    sourceSnapshot: materialMapSourceSnapshot(null),
    version: null,
    structure: [],
    goalScope: [],
    checked: [],
    unread: [],
    gaps: [],
  };
}

function materialMapNormalizeSource(entry, validationContext, where) {
  var context = validationContext.context;
  if (!materialMapIsRecord(entry)) {
    materialMapReject(context, 'E_SCHEMA', '材料地图的来源条目必须是对象', where);
    return materialMapBlankSource();
  }
  var sourceId = validationContext.historical
    ? materialMapTextValue(entry.sourceId)
    : materialMapId(context, entry.sourceId, where + '.sourceId');
  if (!validationContext.historical) {
    if (!materialMapHasOwn(validationContext.sourcesById, sourceId)) {
      materialMapReject(context, 'E_SOURCE',
        '材料地图引用当前模型中没有的来源：' + sourceId + '；请只记录当前模型的来源，已移除来源的历史记录保持只读',
        where + '.sourceId');
    }
    if (validationContext.seenSources[sourceId]) {
      materialMapReject(context, 'E_DUP_ID', '材料地图重复声明来源：' + sourceId, where + '.sourceId');
    }
    validationContext.seenSources[sourceId] = true;
    if (!materialMapIsRecord(entry.sourceSnapshot)) {
      materialMapReject(context, 'E_SCHEMA',
        '材料地图来源缺少 sourceSnapshot；请保留 quality-template 生成的来源快照', where + '.sourceSnapshot');
    } else {
      var missingFields = [];
      for (var i = 0; i < MATERIAL_MAP_SNAPSHOT_FIELDS.length; i += 1) {
        if (typeof entry.sourceSnapshot[MATERIAL_MAP_SNAPSHOT_FIELDS[i]] !== 'string') {
          missingFields.push(MATERIAL_MAP_SNAPSHOT_FIELDS[i]);
        }
      }
      if (missingFields.length > 0) {
        materialMapReject(context, 'E_SCHEMA',
          '材料地图 sourceSnapshot 缺少字段：' + missingFields.join('、') +
          '；无法确定的可选属性用空字符串（与模板取值一致），不要用 null',
          where + '.sourceSnapshot');
      }
    }
  }
  var version = null;
  if (entry.version !== undefined && entry.version !== null) {
    if (typeof entry.version === 'string' && entry.version.trim() !== '') version = entry.version.trim();
    else materialMapReject(context, 'E_SCHEMA', '材料地图 version 只能是字符串或 null；取不到稳定版本时写 null', where + '.version');
  }
  return {
    sourceId: sourceId,
    sourceSnapshot: materialMapSourceSnapshot(entry.sourceSnapshot),
    version: version,
    structure: materialMapTextList(context, entry.structure, '材料地图 structure', where + '.structure'),
    goalScope: materialMapGoalScope(context, validationContext, entry.goalScope, where + '.goalScope'),
    checked: materialMapChecked(context, validationContext, entry.checked, where + '.checked'),
    unread: materialMapTextList(context, entry.unread, '材料地图 unread', where + '.unread'),
    gaps: materialMapGaps(context, validationContext, entry.gaps, where + '.gaps'),
  };
}

function materialMapGoalScope(context, validationContext, value, where) {
  var records = materialMapRecordList(context, value, '材料地图 goalScope', where);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < records.length; i += 1) {
    var itemWhere = where + '[' + i + ']';
    var conceptId = validationContext.historical
      ? materialMapTextValue(records[i].conceptId)
      : materialMapId(context, records[i].conceptId, itemWhere + '.conceptId');
    var range = materialMapText(context, records[i].range,
      '材料地图 goalScope 必须写明目标对应范围（range）', itemWhere + '.range');
    if (!validationContext.historical && conceptId !== '') {
      if (!materialMapHasOwn(validationContext.conceptsById, conceptId)) {
        materialMapReject(context, 'E_SCHEMA',
          '材料地图目标范围引用了当前模型中没有的概念：' + conceptId, itemWhere + '.conceptId');
      }
      if (seen[conceptId]) {
        materialMapReject(context, 'E_DUP_ID', '同一来源重复声明概念范围：' + conceptId, itemWhere + '.conceptId');
      }
      seen[conceptId] = true;
    }
    out.push({ conceptId: conceptId, range: range });
  }
  return out;
}

function materialMapChecked(context, validationContext, value, where) {
  var records = materialMapRecordList(context, value, '材料地图 checked', where);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < records.length; i += 1) {
    var itemWhere = where + '[' + i + ']';
    var range = materialMapText(context, records[i].range,
      'checked 每项都必须写明已核对范围（range）', itemWhere + '.range');
    var basis = materialMapText(context, records[i].basis,
      'checked 每项都必须写明核对依据（basis）', itemWhere + '.basis');
    var readAt = materialMapText(context, records[i].readAt,
      'checked 每项都必须写明读取时间（readAt，ISO 日期或时间字符串）', itemWhere + '.readAt');
    if (readAt !== '' && !materialMapTime(readAt)) {
      materialMapReject(context, 'E_SCHEMA',
        'checked 的 readAt 不是 ISO 日期或时间：' + JSON.stringify(records[i].readAt) +
        '；请写例如 2026-10-10 或 2026-10-10T09:30:00.000Z', itemWhere + '.readAt');
    }
    // 结构化元组比较：范围文本里含分隔符时也不会与另一条记录撞key。
    var key = JSON.stringify([range, readAt]);
    if (!validationContext.historical && range !== '' && seen[key]) {
      materialMapReject(context, 'E_DUP_ID', 'checked 重复声明同一范围与时间：' + range, itemWhere);
    }
    seen[key] = true;
    out.push({ range: range, basis: basis, readAt: readAt });
  }
  return out;
}

function materialMapGaps(context, validationContext, value, where) {
  var records = materialMapRecordList(context, value, '材料地图 gaps', where);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < records.length; i += 1) {
    var itemWhere = where + '[' + i + ']';
    var range = materialMapText(context, records[i].range,
      'gaps 每项都必须写明缺口范围（range）', itemWhere + '.range');
    var reason = materialMapText(context, records[i].reason,
      'gaps 每项都必须写明缺口原因（reason）', itemWhere + '.reason');
    var effect = records[i].effect;
    if (MATERIAL_MAP_GAP_EFFECTS.indexOf(effect) === -1) {
      materialMapReject(context, 'E_SCHEMA',
        '材料地图 gaps.effect 只能是 blocking（阻碍成果）或 supplementable（可补充），收到 ' + JSON.stringify(effect),
        itemWhere + '.effect');
      effect = typeof effect === 'string' ? effect : '';
    }
    var key = JSON.stringify([range, reason]);
    if (!validationContext.historical && range !== '' && seen[key]) {
      materialMapReject(context, 'E_DUP_ID', 'gaps 重复声明同一缺口：' + range, itemWhere);
    }
    seen[key] = true;
    out.push({ range: range, reason: reason, effect: effect });
  }
  return out;
}

/**
 * 校验可选 materialMap。缺省、null 都读作「作者没有记录地图」。严格模式用于
 * 写入：结构、重复与引用不合规直接拒绝，不落盘。读取时保留作者写下的范围，
 * 删掉后来失效的引用由读模型派生 stale，而不是在这里报错或改写。
 */
export function materialMapNormalize(raw, context) {
  context = context || {};
  var historical = Boolean(context.historical);
  if (raw === undefined || raw === null) return null;
  if (!materialMapIsRecord(raw) || !Array.isArray(raw.sources)) {
    materialMapReject(context, 'E_SCHEMA', 'materialMap 必须是带 sources 数组的对象', 'materialMap');
    return { sources: [] };
  }
  var validationContext = {
    context: context,
    historical: historical,
    sourcesById: materialMapIndex(context.sources),
    conceptsById: materialMapIndex(context.concepts),
    seenSources: Object.create(null),
  };
  var sources = [];
  for (var index = 0; index < raw.sources.length; index += 1) {
    sources.push(materialMapNormalizeSource(raw.sources[index], validationContext, 'materialMap.sources[' + index + ']'));
  }
  return { sources: sources };
}

/** 规范化输出的稳定投影；缺失地图仍返回 null。 */
export function materialMapToJson(map) {
  if (!map) return null;
  return {
    sources: (Array.isArray(map.sources) ? map.sources : []).map(function (source) {
      return {
        sourceId: source.sourceId,
        sourceSnapshot: materialMapSourceSnapshot(source.sourceSnapshot),
        version: source.version === undefined ? null : source.version,
        structure: (source.structure || []).slice(),
        goalScope: (source.goalScope || []).map(function (item) {
          return { conceptId: item.conceptId, range: item.range };
        }),
        checked: (source.checked || []).map(function (item) {
          return { range: item.range, basis: item.basis, readAt: item.readAt };
        }),
        unread: (source.unread || []).slice(),
        gaps: (source.gaps || []).map(function (item) {
          return { range: item.range, reason: item.reason, effect: item.effect };
        }),
      };
    }),
  };
}

// 记录的范围与当前来源的差异；写入校验与读模型共用这一处比较规则。
function materialMapSourceDrift(entry, current) {
  var label = entry.sourceId || '（缺少来源 id）';
  if (current === null) return {
    removed: true, changedFields: [],
    staleReasons: ['来源 ' + label + ' 已不在当前模型中，其目标与核对范围只作历史记录'],
  };
  var changedFields = [];
  for (var i = 0; i < MATERIAL_MAP_SNAPSHOT_FIELDS.length; i += 1) {
    var field = MATERIAL_MAP_SNAPSHOT_FIELDS[i];
    if (materialMapTextValue(entry.sourceSnapshot[field]) !== materialMapTextValue(current[field])) changedFields.push(field);
  }
  return {
    removed: false, changedFields: changedFields,
    staleReasons: changedFields.length ? [
      '来源 ' + label + ' 的说明已更新（' + changedFields.join('、') + '），已核对范围需要重新核对',
    ] : [],
  };
}

function materialMapConceptChanged(entry, readContext) {
  if (readContext.recordedConcepts === null) return false;
  var recorded = readContext.recordedConcepts[entry];
  var now = readContext.fingerprints[entry];
  return typeof recorded === 'string' && typeof now === 'string' && recorded !== now;
}

function materialMapGoalScopeReasons(sourceId, conceptId, readContext) {
  var prefix = '来源 ' + (sourceId || '（缺少来源 id）') + ' 的目标范围';
  if (!materialMapHasOwn(readContext.conceptsById, conceptId)) {
    return [prefix + '引用了不在当前模型中的概念 ' + (conceptId || '（缺少概念 id）')];
  }
  return materialMapConceptChanged(conceptId, readContext)
    ? [prefix + '基于旧版概念 ' + conceptId + '：概念内容已更新，需要重新核对'] : [];
}

function materialMapReadContext(context) {
  return {
    sourcesById: materialMapIndex(context.sources),
    conceptsById: materialMapIndex(context.concepts),
    allSources: Array.isArray(context.sources) ? context.sources : [],
    fingerprints: materialMapIsRecord(context.conceptFingerprints) ? context.conceptFingerprints : Object.create(null),
    recordedConcepts: materialMapIsRecord(context.scope) && materialMapIsRecord(context.scope.concepts)
      ? context.scope.concepts : null,
    scopeCurrent: context.scopeCurrent !== false,
  };
}

function materialMapPushReason(reasons, reason) {
  if (reasons.indexOf(reason) === -1) reasons.push(reason);
}

/**
 * 地图与当前内容的对照结果，作为「需要重新核对」的原因清单。写入前用它拒绝与
 * 当前来源不一致的地图；读取时用它派生 stale，两类调用共用一处规则。
 *
 * context.sources／concepts 是当前模型数组；context.scope 是记录写入时的范围
 * 快照（用来判断目标范围所依据的概念内容是否已更新）；context.scopeCurrent
 * 为 false 时，当前模型里「没有出现在地图中」的来源按记录后新增处理。
 */
export function materialMapReasons(map, context) {
  var readContext = materialMapReadContext(context || {});
  if (!map) return [];
  var reasons = [];
  var listed = Object.create(null);
  for (var i = 0; i < map.sources.length; i += 1) {
    var entry = map.sources[i];
    if (entry.sourceId !== '') listed[entry.sourceId] = true;
    var current = materialMapHasOwn(readContext.sourcesById, entry.sourceId) ? readContext.sourcesById[entry.sourceId] : null;
    var drift = materialMapSourceDrift(entry, current);
    drift.staleReasons.forEach(function (reason) { materialMapPushReason(reasons, reason); });
    entry.goalScope.forEach(function (item) {
      materialMapGoalScopeReasons(entry.sourceId, item.conceptId, readContext).forEach(function (reason) {
        materialMapPushReason(reasons, reason);
      });
    });
  }
  // 记录之后新增、或从未被记录的来源：只有在地图记录已与当前内容不一致时才算
  // 失效原因。作者主动只记录部分来源的完整地图不算失效，但那些来源在下文的
  // 读模型里显示为「阅读范围未知」，不会被当成已核对。
  if (!readContext.scopeCurrent) {
    for (var s = 0; s < readContext.allSources.length; s += 1) {
      var source = readContext.allSources[s];
      if (typeof source.id === 'string' && !materialMapHasOwn(listed, source.id)) {
        materialMapPushReason(reasons, '来源 ' + source.id + ' 不在材料地图记录范围内，阅读范围未知');
      }
    }
  }
  return reasons;
}

function materialMapRecordedSource(entry, readContext) {
  var current = materialMapHasOwn(readContext.sourcesById, entry.sourceId) ? readContext.sourcesById[entry.sourceId] : null;
  var drift = materialMapSourceDrift(entry, current);
  var ownReasons = drift.staleReasons.slice();
  readContext.recordGoalReasons.forEach(function (reason) { materialMapPushReason(ownReasons, reason); });
  var goalScope = entry.goalScope.map(function (item) {
    var concept = materialMapHasOwn(readContext.conceptsById, item.conceptId) ? readContext.conceptsById[item.conceptId] : null;
    var itemReasons = materialMapGoalScopeReasons(entry.sourceId, item.conceptId, readContext);
    return {
      conceptId: item.conceptId,
      conceptTitle: concept ? concept.title : null,
      range: item.range,
      inCurrentModel: concept !== null,
      stale: itemReasons.length > 0,
      staleReasons: itemReasons,
    };
  });
  var checked = entry.checked.map(function (item) {
    return {
      range: item.range,
      basis: item.basis,
      readAt: item.readAt,
      complete: item.range !== '' && item.basis !== '' && item.readAt !== '',
    };
  });
  return {
    sourceId: entry.sourceId,
    declared: true,
    sourceTitle: current ? current.title : (entry.sourceSnapshot.title || entry.sourceId),
    sourceKind: materialMapTextValue(current ? current.kind : entry.sourceSnapshot.kind),
    sourceNote: materialMapTextValue(current ? current.note : entry.sourceSnapshot.note),
    sourceUrl: materialMapTextValue(current ? current.url : entry.sourceSnapshot.url),
    inCurrentModel: current !== null,
    snapshot: materialMapSourceSnapshot(entry.sourceSnapshot),
    currentSnapshot: current === null ? null : materialMapSourceSnapshot(current),
    changedSnapshotFields: drift.changedFields,
    version: entry.version === undefined ? null : entry.version,
    versionKnown: typeof entry.version === 'string' && entry.version !== '',
    structure: entry.structure.slice(),
    goalScope: goalScope,
    checked: checked,
    unread: entry.unread.slice(),
    gaps: entry.gaps.map(function (item) {
      return { range: item.range, reason: item.reason, effect: item.effect, blocking: item.effect === 'blocking' };
    }),
    // 空 checked 就是「阅读范围未知」，不能因为其它字段齐全而读成已核对。
    coverageKnown: checked.length > 0,
    stale: readContext.recordStale || ownReasons.length > 0,
    staleReasons: ownReasons,
  };
}

function materialMapUnrecordedSource(source, recordStale) {
  return {
    sourceId: source.id,
    declared: false,
    sourceTitle: source.title,
    sourceKind: materialMapTextValue(source.kind),
    sourceNote: materialMapTextValue(source.note),
    sourceUrl: materialMapTextValue(source.url),
    inCurrentModel: true,
    snapshot: null,
    currentSnapshot: materialMapSourceSnapshot(source),
    changedSnapshotFields: [],
    version: null,
    versionKnown: false,
    structure: [],
    goalScope: [],
    checked: [],
    unread: [],
    gaps: [],
    coverageKnown: false,
    // 未记录来源本身没有可失效的范围记录；记录整体失效时同样不能当作已核对。
    stale: recordStale,
    staleReasons: [],
    unknownReason: MATERIAL_MAP_UNRECORDED_REASON,
  };
}

function materialMapCounts(sources) {
  var counts = {
    sources: sources.length,
    declaredSources: 0,
    unknownSources: 0,
    checked: 0,
    unread: 0,
    gaps: 0,
    blockingGaps: 0,
    unknownVersionSources: 0,
    staleSources: 0,
  };
  for (var i = 0; i < sources.length; i += 1) {
    var item = sources[i];
    if (!item.declared) {
      counts.unknownSources += 1;
      continue;
    }
    counts.declaredSources += 1;
    if (!item.versionKnown) counts.unknownVersionSources += 1;
    if (item.stale) counts.staleSources += 1;
    counts.checked += item.checked.length;
    counts.unread += item.unread.length;
    counts.gaps += item.gaps.length;
    for (var g = 0; g < item.gaps.length; g += 1) if (item.gaps[g].blocking) counts.blockingGaps += 1;
  }
  return counts;
}

/**
 * 读模型：公开 quality-read 与学习页共用同一份派生结果。它只描述作者声明的
 * 范围与失效原因，不判断语义，也不把未核对内容记作已核对。
 */
export function materialMapView(map, context) {
  var recordStaleReasons = (context && Array.isArray(context.recordStaleReasons) ? context.recordStaleReasons : [])
    .filter(function (reason) { return typeof reason === 'string' && reason !== ''; });
  var recordStale = context && context.recordStale !== undefined
    ? Boolean(context.recordStale) : recordStaleReasons.length > 0;
  if (!map) {
    return {
      present: false,
      coverageKnown: false,
      stale: true,
      staleReasons: recordStaleReasons.concat([MATERIAL_MAP_UNKNOWN_REASON]),
      sources: [],
      counts: materialMapCounts([]),
    };
  }
  var readContext = materialMapReadContext(context || {});
  readContext.recordStale = recordStale;
  // Each stale source card explains a goal change affecting its scope; the
  // header also retains the complete report reasons for the overall map.
  readContext.recordGoalReasons = context && Array.isArray(context.recordGoalReasons)
    ? context.recordGoalReasons : [];
  var sources = [];
  var listed = Object.create(null);
  for (var i = 0; i < map.sources.length; i += 1) {
    var entry = map.sources[i];
    if (entry.sourceId !== '') listed[entry.sourceId] = true;
    sources.push(materialMapRecordedSource(entry, readContext));
  }
  for (var j = 0; j < readContext.allSources.length; j += 1) {
    var source = readContext.allSources[j];
    if (typeof source.id !== 'string') continue;
    if (!materialMapHasOwn(listed, source.id)) sources.push(materialMapUnrecordedSource(source, recordStale));
  }
  var counts = materialMapCounts(sources);
  var reasons = [];
  recordStaleReasons.concat(readContext.recordGoalReasons, materialMapReasons(map, context || {})).forEach(function (reason) {
    materialMapPushReason(reasons, reason);
  });
  return {
    present: true,
    coverageKnown: counts.checked > 0,
    stale: recordStale || reasons.length > 0,
    staleReasons: reasons,
    sources: sources,
    counts: counts,
  };
}
