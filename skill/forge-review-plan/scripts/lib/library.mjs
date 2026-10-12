// The library stores pointers only. All learning facts are read from the
// registered archive; a missing archive must never become an empty learner.
import fs from 'node:fs';
import path from 'node:path';
import { EmberError, CODES, isRecord } from './errors.mjs';
import { assertLearningOutput } from './output-paths.mjs';
import { atomicWrite, nowIso, readJson, stableStringify } from './io.mjs';
import { withArchiveLock } from './archive.mjs';

export const DEFAULT_CATALOG = path.join('learning', 'learning-index.json');
const TOPIC_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_FILES = new Set(['model.json', 'state.json', 'quality.json', 'index.html', 'map.excalidraw', 'map.svg']);

function canonicalDir(dir) {
  try {
    const real = fs.realpathSync(dir);
    return real;
  } catch (err) {
    throw new EmberError(CODES.IO, `学习目录不可读取 ${dir}：${err.message}`);
  }
}

function sameDir(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function topicId(value) {
  if (typeof value !== 'string' || !TOPIC_ID.test(value)) {
    throw new EmberError(CODES.USAGE, '--topic 需要稳定 ASCII ID（字母、数字、点、下划线或连字符）');
  }
  return value;
}

export function catalogPath(value = DEFAULT_CATALOG) {
  if (typeof value !== 'string' || !value.trim()) throw new EmberError(CODES.USAGE, '--catalog 需要索引文件路径');
  const file = path.resolve(value);
  if (RESERVED_FILES.has(path.basename(file).toLowerCase())) {
    throw new EmberError(CODES.USAGE, '索引应使用独立文件，不能使用学习产物或档案文件名');
  }
  return file;
}

function readCatalog(file) {
  let raw;
  try {
    fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false, data: { schemaVersion: 1, topics: [] } };
    throw new EmberError(CODES.IO, `索引不可读取 ${file}：${err.message}`);
  }
  raw = readJson(file);
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.topics)) {
    throw new EmberError(CODES.STATE, '学习索引格式不受支持；保留原文件，使用兼容工具或核对备份');
  }
  const ids = new Set();
  const dirs = new Set();
  for (const entry of raw.topics) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !TOPIC_ID.test(entry.id) ||
        typeof entry.directory !== 'string' || !entry.directory.trim() ||
        typeof entry.modelId !== 'string' || !entry.modelId.trim() ||
        typeof entry.registeredAt !== 'string' || !Number.isFinite(Date.parse(entry.registeredAt))) {
      throw new EmberError(CODES.STATE, '学习索引含无效主题记录；本次未修改索引');
    }
    const dir = path.resolve(path.dirname(file), entry.directory);
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (ids.has(entry.id) || dirs.has(key)) throw new EmberError(CODES.STATE, '学习索引含重复主题或目录');
    ids.add(entry.id);
    dirs.add(key);
  }
  return { present: true, data: raw };
}

function readTopic(file, entry, reader, at, roundId) {
  const out = path.resolve(path.dirname(file), entry.directory);
  for (const name of ['model.json', 'state.json']) {
    try {
      if (!fs.statSync(path.join(out, name)).isFile()) throw new Error('不是文件');
    } catch (err) {
      throw new EmberError(CODES.IO, `主题 ${entry.id} 缺少可读取的 ${name}：${err.message}；核对目录或恢复备份`);
    }
  }
  let view;
  try {
    view = reader({ out, ...(at ? { at } : {}), ...(roundId ? { 'round-id': roundId } : {}) });
  } catch (err) {
    if (!(err instanceof EmberError) && typeof err.code === 'string') {
      throw new EmberError(CODES.IO, `主题 ${entry.id} 暂不可读取：${err.message}`);
    }
    throw err;
  }
  if (view.identity.modelId !== entry.modelId) {
    throw new EmberError(CODES.STATE, `主题 ${entry.id} 的模型身份已变化；核对目录，移除旧指针后重新登记`);
  }
  return view;
}

export async function registerTopic(file, id, directory, reader) {
  assertLearningOutput(file, '--catalog');
  topicId(id);
  const out = canonicalDir(assertLearningOutput(directory, '--out'));
  // Read before taking the catalog lock; registration never writes the topic.
  const modelId = readJson(path.join(out, 'model.json')).id;
  const entry = {
    id, directory: path.relative(path.dirname(file), out) || '.', modelId, registeredAt: nowIso(),
  };
  readTopic(file, entry, reader);
  return withArchiveLock(path.dirname(file), () => {
    const { data } = readCatalog(file);
    const previous = data.topics.find((item) => item.id === id);
    if (previous) {
      if (!sameDir(canonicalDir(path.resolve(path.dirname(file), previous.directory)), out) || previous.modelId !== modelId) {
        throw new EmberError(CODES.STATE, `主题 ${id} 已绑定其他目录或模型；核对后先移除旧指针`);
      }
      return { saved: false, unchanged: true, catalog: file, topic: previous };
    }
    for (const item of data.topics) {
      const existing = path.resolve(path.dirname(file), item.directory);
      // A broken unrelated pointer does not prevent registering a new topic.
      if (fs.existsSync(existing) && sameDir(canonicalDir(existing), out)) {
        throw new EmberError(CODES.STATE, `该目录已登记为 ${item.id}；使用已有主题身份`);
      }
    }
    data.topics.push(entry);
    data.topics.sort((a, b) => a.id.localeCompare(b.id));
    atomicWrite(file, stableStringify(data));
    return { saved: true, catalog: file, topic: entry };
  });
}

export function listTopics(file, reader, at = nowIso()) {
  if (!Number.isFinite(Date.parse(at))) throw new EmberError(CODES.USAGE, '--at 需要有效 ISO 时间');
  const { present, data } = readCatalog(file);
  const topics = data.topics.map((entry) => {
    const directory = path.resolve(path.dirname(file), entry.directory);
    try {
      const view = readTopic(file, entry, reader, at);
      return {
        id: entry.id, directory, modelId: entry.modelId, available: true,
        title: view.identity.modelTitle, updatedAt: view.archiveUpdatedAt,
        round: view.round, position: view.position,
        dueCount: view.reviewDue.filter((due) => !due.stale).length,
        staleDueCount: view.reviewDue.filter((due) => due.stale).length,
        gaps: view.gaps, changes: view.changes,
      };
    } catch (err) {
      if (!(err instanceof EmberError)) throw err;
      return { id: entry.id, directory, modelId: entry.modelId, available: false,
        dueCount: null, error: { code: err.code, message: err.message } };
    }
  });
  return { readOnly: true, catalog: file, present, at, topics,
    note: '仅含已登记目录；独立浏览器未导出的缓存不在读回范围。主题选择由学习者决定。' };
}

export function resumeTopic(file, id, reader, at, roundId) {
  topicId(id);
  const { data } = readCatalog(file);
  const entry = data.topics.find((item) => item.id === id);
  if (!entry) throw new EmberError(CODES.STATE, `索引中没有主题 ${id}；先 library list 核对`);
  return { ...readTopic(file, entry, reader, at, roundId), catalog: file, topicId: id };
}

export async function removeTopic(file, id) {
  assertLearningOutput(file, '--catalog');
  topicId(id);
  // Missing catalogs remain missing; read commands and no-op removal create nothing.
  const initial = readCatalog(file);
  if (!initial.present) return { saved: false, removed: false, catalog: file, topicId: id };
  return withArchiveLock(path.dirname(file), () => {
    const { data } = readCatalog(file);
    const remaining = data.topics.filter((item) => item.id !== id);
    if (remaining.length === data.topics.length) return { saved: false, removed: false, catalog: file, topicId: id };
    data.topics = remaining;
    atomicWrite(file, stableStringify(data));
    return { saved: true, removed: true, catalog: file, topicId: id, archiveDeleted: false };
  });
}
