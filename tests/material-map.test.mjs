// Task01 material-map tests. Every model, source and reading range here is a
// SYNTHETIC fixture authored for this test; none of it is real learner data or a
// real reading record. All assertions drive the real public CLI (and, where the
// record must be readable by the page, the real HTTP server) against a throwaway
// output directory.
//
// Run: node --test tests/material-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { parseJson } from '../skill/forge/scripts/lib/io.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-material-map-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [EMBER, ...args], { encoding: 'utf8', env: process.env, ...options });
}

function cliJson(args, options) {
  const result = cli(args, options);
  assert.equal(result.status, 0, `command should succeed: forge ${args.join(' ')}\n${result.stderr}`);
  return parseJson(result.stdout, 'forge stdout');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJsonFile(filePath) {
  return parseJson(fs.readFileSync(filePath, 'utf8'), filePath);
}

function bytes(filePath) {
  return fs.readFileSync(filePath);
}

// A synthetic two-concept model with two sources: one carries kind/note, the
// other only a title, so the template snapshot must fill the missing optional
// properties with the exact empty-string values the model uses.
function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-source-map',
    title: '合成技能材料',
    goal: '能按原文规则调用技能，并说明哪些流程属于技能自身。',
    summary: '合成测试材料，不代表真实课程或学习者。',
    concepts: [
      { id: 'root', title: '技能材料', parentId: null, difficulty: 1, explanation: '组织两个分支。' },
      {
        id: 'invocation', title: '调用方式', parentId: 'root', difficulty: 1,
        explanation: '最小请求与可选约束。', example: '给技能名和目标文件。', misconception: '必须写长提示词。',
      },
      {
        id: 'ownership', title: '职责划分', parentId: 'root', difficulty: 2,
        explanation: '技能自带流程与用户必须提供的信息。', example: '拆分任务属于技能职责。',
        misconception: '用户必须重复“拆任务”。',
      },
    ],
    relations: [{ id: 'rel-invocation-ownership', from: 'invocation', to: 'ownership', type: 'prerequisite' }],
    prompts: [
      { id: 'p-invocation', conceptId: 'invocation', kind: 'apply', question: '最小请求怎么写？', answer: '技能名加目标材料。', criteria: ['含技能名', '含材料'] },
      { id: 'p-ownership', conceptId: 'ownership', kind: 'explain', question: '哪些是技能自带流程？', answer: '拆分任务与声明阻塞关系。', criteria: ['提到拆分'] },
    ],
    sources: [
      { id: 'src-skill', title: '技能原文', kind: 'provided', note: '用户提供的本地材料' },
      { id: 'src-notes', title: '总体简介' },
    ],
    limitations: ['合成样例，不用于真实教学。'],
    ...overrides,
  };
}

function six(result = 'covered', basis = '实际阅读并核对了合成材料。') {
  return [
    'goal-coverage', 'prerequisite', 'explanation-example',
    'boundary-misconception', 'task-criteria', 'sources-gaps',
  ].map((id) => ({ id, result, basis }));
}

function templateOf(outDir) {
  return cliJson(['quality-template', '--out', outDir]);
}

// Fill the six author dimensions only; the map is left exactly as the template
// produced it unless the caller fills it.
function completeRecord(outDir, fillMap) {
  const template = templateOf(outDir);
  const goal = template.goals[0];
  goal.concepts = goal.concepts.map((concept) => (concept.id === 'root'
    ? { ...concept, role: 'structural' }
    : { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] }));
  if (fillMap) template.materialMap = fillMap(template.materialMap);
  return template;
}

function writeRecord(dir, record, name = 'incoming-quality.json') {
  const file = path.join(dir, name);
  writeJson(file, record);
  return file;
}

function seed(outDir, raw = rawModel()) {
  const modelPath = path.join(outDir, 'source.json');
  writeJson(modelPath, raw);
  cliJson(['build', modelPath, '--out', outDir]);
  return modelPath;
}

// A filled source entry for the current template skeleton.
function filledSource(skeleton, sourceId, fill = {}) {
  const entry = skeleton.sources.find((item) => item.sourceId === sourceId);
  assert.ok(entry, `template must contain a skeleton for ${sourceId}`);
  return { ...entry, ...fill };
}

function assertNoLearnerMutation(dir, before) {
  assert.deepEqual(bytes(path.join(dir, 'state.json')), before, 'learner archive bytes must be unchanged');
}

// ---------------------------------------------------------------------------
// Slice 1: template skeleton, unknown coverage, and old-record compatibility
// ---------------------------------------------------------------------------

test('quality-template prefills every source identity/snapshot and leaves all reading information unknown', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const template = templateOf(dir);
  const map = template.materialMap;
  assert.equal(typeof map, 'object', 'the template carries a material map skeleton');
  assert.deepEqual(map.sources.map((source) => source.sourceId), ['src-skill', 'src-notes']);
  assert.deepEqual(map.sources[0].sourceSnapshot, {
    title: '技能原文', kind: 'provided', note: '用户提供的本地材料', url: '',
  });
  // The second model source declares no kind/note/url; the snapshot must use the
  // exact template values (empty strings), not null or a missing key.
  assert.deepEqual(map.sources[1].sourceSnapshot, { title: '总体简介', kind: '', note: '', url: '' });
  for (const source of map.sources) {
    assert.equal(source.version, null, 'an unknown version is null, never an invented one');
    assert.deepEqual(source.structure, []);
    assert.deepEqual(source.goalScope, []);
    assert.deepEqual(source.checked, [], 'the skeleton never pretends a range was read');
    assert.deepEqual(source.unread, []);
    assert.deepEqual(source.gaps, []);
  }
});

test('an untouched skeleton reads back with unknown coverage and invents no checked range', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const stateBefore = bytes(path.join(dir, 'state.json'));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.stale, false, 'a skeleton written against the current content is not stale');
  assert.equal(read.materialMap.present, true);
  assert.equal(read.materialMap.coverageKnown, false, 'empty checked means the reading range is unknown');
  const skill = read.materialMap.sources.find((source) => source.sourceId === 'src-skill');
  assert.equal(skill.declared, true);
  assert.equal(skill.coverageKnown, false);
  assert.deepEqual(skill.checked, []);
  assert.equal(skill.version, null);
  assert.equal(skill.versionKnown, false);
  assert.equal(skill.stale, false);
  assertNoLearnerMutation(dir, stateBefore);
});

test('a quality record written without a material map stays readable with unknown coverage', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  delete record.materialMap; // exactly the shape an older tool wrote
  writeJson(path.join(dir, 'quality.json'), record);
  const stateBefore = bytes(path.join(dir, 'state.json'));
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.stale, false, 'a missing map does not invalidate the existing conclusions');
  assert.equal(read.goals[0].passed, true);
  assert.equal(read.materialMap.present, false);
  assert.equal(read.materialMap.coverageKnown, false);
  assert.deepEqual(read.materialMap.sources, []);
  assert.ok(read.materialMap.staleReasons.some((reason) => reason.includes('未知')), 'the unknown range is named');
  assertNoLearnerMutation(dir, stateBefore);
});

// A fully filled, current map: the first source is scoped to two concepts with
// one checked range, one unread area and one supplementable gap; the second only
// has a recorded version, so it stays "declared but unknown coverage".
function filledMap(map) {
  return {
    sources: [
      {
        ...filledSource(map, 'src-skill'),
        version: 'commit 4f2a1c9',
        structure: ['入口与定位', '必要输入', '自带流程', '结束条件'],
        goalScope: [
          { conceptId: 'invocation', range: 'SKILL.md“最小请求”一节全文' },
          { conceptId: 'ownership', range: 'SKILL.md“职责划分”一节全文' },
        ],
        checked: [
          { range: 'SKILL.md 第 1 至 40 行', basis: '逐段核对调用步骤与结束条件。', readAt: '2026-10-10T09:30:00.000Z' },
          { range: 'references/to-tickets.md 全文', basis: '核对拆分任务与阻塞关系是否为技能自带流程。', readAt: '2026-10-10' },
        ],
        unread: ['与本次目标无关的其它参考资料'],
        gaps: [
          {
            range: '外部示例仓库（不可访问）',
            reason: '无法取得正文，未作为规则依据。',
            effect: 'supplementable',
          },
        ],
      },
      filledSource(map, 'src-notes'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Slice 2: strict validation rejects before writing
// ---------------------------------------------------------------------------

test('a filled map is saved and read back with version, structure, goal scope, checked basis, unread and gaps', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const stateBefore = bytes(path.join(dir, 'state.json'));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir, filledMap))]);

  const persisted = readJsonFile(path.join(dir, 'quality.json'));
  assert.equal(persisted.materialMap.sources.length, 2, 'the map is stored inside quality.json');
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.stale, false);
  const skill = read.materialMap.sources.find((source) => source.sourceId === 'src-skill');
  assert.equal(skill.version, 'commit 4f2a1c9');
  assert.equal(skill.versionKnown, true);
  assert.deepEqual(skill.structure, ['入口与定位', '必要输入', '自带流程', '结束条件']);
  assert.deepEqual(skill.goalScope.map((item) => [item.conceptId, item.inCurrentModel]), [['invocation', true], ['ownership', true]]);
  assert.deepEqual(skill.checked.map((item) => [item.range, item.basis, item.readAt, item.complete]), [
    ['SKILL.md 第 1 至 40 行', '逐段核对调用步骤与结束条件。', '2026-10-10T09:30:00.000Z', true],
    ['references/to-tickets.md 全文', '核对拆分任务与阻塞关系是否为技能自带流程。', '2026-10-10', true],
  ]);
  assert.deepEqual(skill.unread, ['与本次目标无关的其它参考资料']);
  assert.deepEqual(skill.gaps.map((item) => [item.effect, item.blocking]), [['supplementable', false]]);
  assert.equal(skill.coverageKnown, true);
  assert.equal(read.materialMap.coverageKnown, true);
  assert.equal(read.materialMap.counts.checked, 2);
  assert.equal(read.materialMap.counts.unknownVersionSources, 1, 'the second source records no version');
  assertNoLearnerMutation(dir, stateBefore);
  // The map never leaks into the learner archive.
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes('materialMap'), false);
});

test('a partial map is a legal record: unrecorded sources read as unknown coverage, not as stale', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir, (map) => ({
    sources: [{
      ...filledSource(map, 'src-skill'),
      version: null,
      structure: ['入口'],
      goalScope: [{ conceptId: 'invocation', range: 'SKILL.md 入口一节' }],
      checked: [{ range: 'SKILL.md 入口一节', basis: '核对最小请求。', readAt: '2026-10-10' }],
      unread: [],
      gaps: [],
    }],
  }));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.stale, false, 'deliberately recording only some sources is not an invalid record');
  assert.equal(read.goals[0].passed, true);
  const unrecorded = read.materialMap.sources.find((source) => source.sourceId === 'src-notes');
  assert.equal(unrecorded.declared, false);
  assert.equal(unrecorded.inCurrentModel, true);
  assert.equal(unrecorded.coverageKnown, false);
  assert.equal(unrecorded.checked.length, 0, 'an unrecorded source is never implied checked');
  assert.ok(unrecorded.unknownReason.includes('未知'));
  assert.equal(read.materialMap.counts.unknownSources, 1);
});

function rejectedWrite(t, mutate, message) {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const stateBefore = bytes(path.join(dir, 'state.json'));
  const record = completeRecord(dir, (map) => mutate(filledMap(map)));
  const result = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(result.status, 0, message);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'a rejected write persists nothing');
  assertNoLearnerMutation(dir, stateBefore);
  return { dir, result };
}

test('an unknown source, an unknown concept, a duplicate source and a duplicate scope are rejected', (t) => {
  rejectedWrite(t, (map) => {
    map.sources[0].sourceId = 'src-not-in-model';
    return map;
  }, 'a source that is not in the current model must be refused');

  rejectedWrite(t, (map) => {
    map.sources[0].goalScope[0].conceptId = 'concept-not-in-model';
    return map;
  }, 'a goal scope that names an unknown concept must be refused');

  rejectedWrite(t, (map) => {
    map.sources.push({ ...map.sources[0] });
    return map;
  }, 'the same source declared twice must be refused');

  rejectedWrite(t, (map) => {
    map.sources[0].goalScope.push({ conceptId: 'invocation', range: '重复范围' });
    return map;
  }, 'the same concept scoped twice in one source must be refused');

  rejectedWrite(t, (map) => {
    map.sources[0].checked.push({ ...map.sources[0].checked[0] });
    return map;
  }, 'the same checked range and time twice must be refused');
});

test('null where an array belongs, a non-array goal scope and an illegal effect are rejected', (t) => {
  for (const field of ['structure', 'goalScope', 'checked', 'unread', 'gaps']) {
    rejectedWrite(t, (map) => {
      map.sources[0][field] = null;
      return map;
    }, `an explicit null ${field} is not an empty array`);
  }
  rejectedWrite(t, (map) => {
    map.sources[0].goalScope = 'SKILL.md 全文';
    return map;
  }, 'a non-array goal scope must be refused');
  rejectedWrite(t, (map) => {
    map.sources[0].structure = ['入口', 3];
    return map;
  }, 'a non-string structure entry must be refused');
  rejectedWrite(t, (map) => {
    map.sources[0].gaps[0].effect = 'maybe';
    return map;
  }, 'a gap effect outside blocking/supplementable must be refused');
  rejectedWrite(t, (map) => {
    map.sources[0].version = '';
    return map;
  }, 'an empty version must be refused instead of standing in for an unknown version');
});

test('a checked range without basis or time, and a non-ISO time, are rejected', (t) => {
  rejectedWrite(t, (map) => {
    delete map.sources[0].checked[0].basis;
    return map;
  }, 'a checked range needs a written basis');
  rejectedWrite(t, (map) => {
    delete map.sources[0].checked[0].readAt;
    return map;
  }, 'a checked range needs a read time');
  // Date.parse would accept '5' as a date; the contract requires an ISO/date string.
  rejectedWrite(t, (map) => {
    map.sources[0].checked[0].readAt = '5';
    return map;
  }, 'a non-ISO read time must be refused');
  rejectedWrite(t, (map) => {
    map.sources[0].checked[0].readAt = '昨天';
    return map;
  }, 'an unparsable read time must be refused');
  rejectedWrite(t, (map) => {
    map.sources[0].checked[0].range = '';
    return map;
  }, 'a checked entry needs a non-empty range');
});

test('the source snapshot must stay byte-for-byte the current template values', (t) => {
  const { result } = rejectedWrite(t, (map) => {
    map.sources[0].sourceSnapshot.title = '旧标题';
    return map;
  }, 'a stale source snapshot must not be written');
  assert.match(result.stderr, /快照|说明已更新/);

  // A missing optional property is not the same as an empty string.
  rejectedWrite(t, (map) => {
    delete map.sources[1].sourceSnapshot.note;
    return map;
  }, 'the snapshot must keep every field, using empty strings for unknown optionals');
  rejectedWrite(t, (map) => {
    map.sources[1].sourceSnapshot.note = null;
    return map;
  }, 'null is not the template value for an unknown optional property');
});

test('quality-validate reports a structurally valid record and refuses a malformed time', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const valid = writeRecord(dir, completeRecord(dir, filledMap));
  const ok = cliJson(['quality-validate', valid, '--out', dir]);
  assert.equal(ok.valid, true);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'validate never writes');

  const broken = completeRecord(dir, (map) => {
    const next = filledMap(map);
    next.sources[0].checked[0].readAt = '5';
    return next;
  });
  const failed = cli(['quality-validate', writeRecord(dir, broken, 'broken-map.json'), '--out', dir]);
  assert.notEqual(failed.status, 0, 'a malformed read time fails validation');
  assert.match(failed.stderr, /readAt|ISO/);
});

// ---------------------------------------------------------------------------
// Slice 3: source/goal changes keep the history and derive stale
// ---------------------------------------------------------------------------

function seededWithMap(t) {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir, filledMap))]);
  assert.equal(cliJson(['quality-read', '--out', dir]).stale, false);
  return { dir, modelPath };
}

test('goal-only drift keeps checked history and explains map and source staleness through public CLI', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const qualityBefore = bytes(path.join(dir, 'quality.json'));
  const original = cliJson(['quality-read', '--out', dir]).materialMap;
  writeJson(modelPath, rawModel({ goal: '能独立核对技能的结束条件。' }));
  cliJson(['build', modelPath, '--out', dir]);
  const stateBefore = bytes(path.join(dir, 'state.json'));
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.materialMap.stale, true);
  assert.ok(read.materialMap.staleReasons.some((reason) => reason.includes('学习目标')),
    'the map explains whole-record goal drift');
  assert.equal(new Set(read.materialMap.staleReasons).size, read.materialMap.staleReasons.length);
  for (const source of read.materialMap.sources) {
    assert.equal(source.stale, true);
    assert.ok(source.staleReasons.some((reason) => reason.includes('学习目标')));
    assert.deepEqual(source.checked, original.sources.find((item) => item.sourceId === source.sourceId).checked);
  }
  assert.equal(read.goals[0].passed, false);
  assert.deepEqual(bytes(path.join(dir, 'quality.json')), qualityBefore);
  assertNoLearnerMutation(dir, stateBefore);
});

test('a changed source note marks the map and the whole record stale, and the page shows why', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const changed = rawModel();
  changed.sources = changed.sources.map((source) => (source.id === 'src-skill'
    ? { ...source, note: '用户后来补充说明的本地材料' }
    : source));
  writeJson(modelPath, changed);
  cliJson(['build', modelPath, '--out', dir]);
  // Capture after the model change: that build legitimately re-syncs the learner
  // archive to the new content version. What must not change is anything the
  // quality read or a read-only rebuild does afterwards.
  const qualityBefore = bytes(path.join(dir, 'quality.json'));
  const stateBefore = bytes(path.join(dir, 'state.json'));

  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.materialMap.present, true);
  assert.equal(read.stale, true, 'a changed source snapshot invalidates the record');
  assert.ok(read.materialMap.staleReasons.some((reason) => reason.includes('note')), 'the changed field is named');
  const skill = read.materialMap.sources.find((source) => source.sourceId === 'src-skill');
  assert.equal(skill.stale, true);
  assert.deepEqual(skill.changedSnapshotFields, ['note']);
  for (const reason of skill.staleReasons) assert.ok(read.materialMap.staleReasons.includes(reason),
    'source and report drift use the same reason');
  assert.deepEqual(skill.checked.map((item) => item.range), [
    'SKILL.md 第 1 至 40 行', 'references/to-tickets.md 全文',
  ], 'the original ranges stay readable');
  assert.equal(read.goals[0].passed, false, 'a stale map must not pass the outcome');
  assert.equal(read.concepts.invocation.passed, false);

  // The page payload carries the same read model the CLI derived.
  const payload = extractPayload(path.join(dir, 'index.html'));
  assert.equal(payload.quality.materialMap.stale, true);
  assert.equal(payload.quality.goals[0].passed, false);
  // Reading never repairs the stored record, and never touches learner state.
  assert.deepEqual(bytes(path.join(dir, 'quality.json')), qualityBefore);
  assertNoLearnerMutation(dir, stateBefore);
});

test('a removed source keeps its recorded ranges as history and never reads as usable', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const changed = rawModel();
  changed.sources = changed.sources.filter((source) => source.id !== 'src-notes');
  changed.concepts = changed.concepts.filter((concept) => concept.id !== 'ownership');
  changed.relations = [];
  changed.prompts = changed.prompts.filter((prompt) => prompt.conceptId !== 'ownership');
  writeJson(modelPath, changed);
  cliJson(['build', modelPath, '--out', dir]);

  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.materialMap.present, true, 'the map stays readable after a source is removed');
  const skill = read.materialMap.sources.find((source) => source.sourceId === 'src-skill');
  assert.equal(skill.inCurrentModel, true);
  assert.equal(skill.goalScope.find((item) => item.conceptId === 'ownership').inCurrentModel, false,
    'a deleted concept is reported as history, not dropped');
  assert.ok(skill.goalScope.find((item) => item.conceptId === 'ownership').staleReasons.length > 0);
  assert.equal(read.stale, true);
  assert.ok(read.materialMap.staleReasons.some((reason) => reason.includes('ownership')));
  assert.equal(read.goals[0].passed, false);
});

test('a source that was not in the record reads as unknown coverage and makes the record stale', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const changed = rawModel();
  changed.sources = changed.sources.concat([{ id: 'src-new', title: '新加入的技能参考' }]);
  writeJson(modelPath, changed);
  cliJson(['build', modelPath, '--out', dir]);

  const read = cliJson(['quality-read', '--out', dir]);
  const fresh = read.materialMap.sources.find((source) => source.sourceId === 'src-new');
  assert.equal(fresh.declared, false, 'a new source is not silently treated as recorded');
  assert.equal(fresh.coverageKnown, false);
  assert.ok(fresh.unknownReason.includes('未知'));
  assert.ok(read.materialMap.staleReasons.some((reason) => reason.includes('src-new')), 'the new source is named');
  assert.equal(read.stale, true);
  assert.equal(read.goals[0].passed, false, 'stale must propagate to the outcome');
  assert.equal(read.concepts.invocation.passed, false, 'stale must propagate to the concept record');
});

test('a changed concept marks its goal scope stale without deleting the recorded range', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const changed = rawModel();
  changed.concepts = changed.concepts.map((concept) => (concept.id === 'invocation'
    ? { ...concept, explanation: '改过的调用方式解释。' }
    : concept));
  writeJson(modelPath, changed);
  cliJson(['build', modelPath, '--out', dir]);

  const read = cliJson(['quality-read', '--out', dir]);
  const scope = read.materialMap.sources.find((source) => source.sourceId === 'src-skill')
    .goalScope.find((item) => item.conceptId === 'invocation');
  assert.equal(scope.range, 'SKILL.md“最小请求”一节全文', 'the author range is preserved');
  assert.equal(scope.inCurrentModel, true);
  assert.equal(scope.stale, true);
  assert.ok(scope.staleReasons.some((reason) => reason.includes('概念内容已更新')));
  for (const reason of scope.staleReasons) assert.ok(read.materialMap.staleReasons.includes(reason),
    'concept and report drift use the same reason');
  assert.ok(read.staleReasons.some((reason) => reason.includes('invocation')));
  assert.equal(read.goals[0].passed, false);
});

test('the served HTTP entry points expose the saved record and the rebuilt page payload', async (t) => {
  const { dir, modelPath } = seededWithMap(t);
  // The documented step after quality-write: rebuild so the page carries the view.
  cliJson(['build', modelPath, '--out', dir]);
  const started = await startServer({ dir, port: 0 });
  t.after(() => started.close());
  const response = await fetch(`${started.url}/quality.json`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes(path.join(dir, 'quality.json')),
    '/quality.json must serve exactly the saved record');
  const record = parseJson(await (await fetch(`${started.url}/quality.json`)).text(), 'served quality.json');
  assert.equal(record.materialMap.sources[0].sourceId, 'src-skill');

  const page = await (await fetch(`${started.url}/`)).text();
  const payload = extractPayloadFromHtml(page);
  assert.equal(payload.quality.materialMap.present, true);
  assert.equal(payload.quality.materialMap.sources.find((source) => source.sourceId === 'src-skill').version, 'commit 4f2a1c9');
});

// ---------------------------------------------------------------------------
// Slice 4: the real page renders the map in the "来源" panel
// ---------------------------------------------------------------------------

test('the sources panel shows versions, structure, goal scope, checked basis, unread and gaps', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  cliJson(['build', modelPath, '--out', dir]);
  const internals = loadViewer(extractPayload(path.join(dir, 'index.html')));
  const text = textOf(internals.renderMaterialMap());
  assert.match(text, /材料地图/);
  assert.match(text, /版本：commit 4f2a1c9/);
  assert.match(text, /版本未知/, 'the source that records no version says so');
  assert.match(text, /入口与定位/);
  assert.match(text, /SKILL\.md“最小请求”一节全文/);
  assert.match(text, /调用方式（invocation）/);
  assert.match(text, /SKILL\.md 第 1 至 40 行/);
  assert.match(text, /逐段核对调用步骤与结束条件。/);
  assert.match(text, /2026-10-10T09:30:00\.000Z/);
  assert.match(text, /与本次目标无关的其它参考资料/);
  assert.match(text, /无法取得正文，未作为规则依据。/);
  assert.match(text, /已核对范围 2 条/);
  // The panel itself routes the map in, so the "来源" tab shows it.
  const panel = textOf(internals.renderSourcesPanel());
  assert.match(panel, /材料地图/);
  assert.match(panel, /内容质检报告/);
});

test('the sources panel shows an unrecorded source as unknown and a removed concept as history', (t) => {
  const { dir, modelPath } = seededWithMap(t);
  const changed = rawModel();
  changed.sources = [
    { id: 'src-skill', title: '技能原文', kind: 'provided', note: '用户后来补充说明的本地材料' },
    { id: 'src-new', title: '新加入的技能参考' },
  ];
  changed.concepts = changed.concepts.filter((concept) => concept.id !== 'ownership');
  changed.relations = [];
  changed.prompts = changed.prompts.filter((prompt) => prompt.conceptId !== 'ownership');
  writeJson(modelPath, changed);
  cliJson(['build', modelPath, '--out', dir]);
  const internals = loadViewer(extractPayload(path.join(dir, 'index.html')));
  const text = textOf(internals.renderMaterialMap());
  assert.match(text, /这份材料地图已失效/);
  assert.match(text, /说明已更新（note）/, 'the changed snapshot field is named');
  assert.match(text, /新加入的技能参考/);
  assert.match(text, /未包含在材料地图记录中/, 'a new source reads as unknown coverage');
  assert.match(text, /已不在当前模型中/, 'the removed concept is kept as history');
  assert.match(text, /ownership：SKILL\.md“职责划分”一节全文/, 'the author range survives the removal');
});

test('the page renders an unknown reading range for a record without a map', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  const record = completeRecord(dir);
  delete record.materialMap;
  writeJson(path.join(dir, 'quality.json'), record);
  cliJson(['build', modelPath, '--out', dir]);
  const internals = loadViewer(extractPayload(path.join(dir, 'index.html')));
  internals.App.quality.materialMap.staleReasons.push('旧范围的专用复核原因');
  const text = textOf(internals.renderMaterialMap());
  assert.match(text, /旧范围的专用复核原因/, 'the absent-map panel consumes read-model reasons');
  assert.match(text, /没有材料地图/);
  assert.match(text, /阅读范围未知/);
  assert.doesNotMatch(text, /已核对范围 [1-9]/);
});

// ---------------------------------------------------------------------------
// Helpers: read the embedded payload exactly as the page receives it
// ---------------------------------------------------------------------------

// The page is loaded under a minimal DOM shim with the same library injections
// the builder performs, so the "来源" panel is exercised as the shipped page
// renders it — not as a private copy of the rendering logic.
function loadViewer(payload) {
  const stripExports = (source) => source.replace(/^export /gm, '');
  const library = (name) => stripExports(fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'scripts', 'lib', name), 'utf8'));
  const html = fs.readFileSync(path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html'), 'utf8')
    .replace('/*__EMBER_ROUND_LIBRARY__*/', () => library('round.mjs'))
    .replace('/*__EMBER_SCHEDULE_LIBRARY__*/', () => library('schedule.mjs'))
    .replace('/*__EMBER_TUTOR_REVIEW_LIBRARY__*/', () => library('tutor-review.mjs'))
    .replace('/*__EMBER_INTERACTIONS_LIBRARY__*/', () => library('interactions.mjs'))
    .replace('/*__EMBER_INSIGHTS_LIBRARY__*/', () => library('insights.mjs'))
    .replace('/*__EMBER_CORRECTIONS_LIBRARY__*/', () => library('corrections.mjs'));
  const start = html.lastIndexOf('<script>');
  const body = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));
  const canvas = {
    width: 0, height: 0, style: {},
    getContext() {
      return {
        font: '', fillStyle: '', setTransform() {}, clearRect() {}, fillRect() {},
        measureText() { return { width: 0 }; },
      };
    },
  };
  const dataEl = { textContent: JSON.stringify(payload) };
  const documentShim = {
    createElement(tag) { return tag === 'canvas' ? Object.assign(new ShimNode(tag), canvas) : new ShimNode(tag); },
    createElementNS() { return new ShimNode(); },
    createDocumentFragment() { return new ShimNode('#fragment'); },
    createTextNode(text) { return Object.assign(new ShimNode('#text'), { textContent: text }); },
    querySelector(selector) { return selector === '#ember-data' ? dataEl : null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    activeElement: null,
    body: new ShimNode('body'),
  };
  const sandbox = {
    console,
    document: documentShim,
    location: { protocol: 'file:' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false }),
    requestAnimationFrame(cb) { return cb(); },
    setTimeout,
    clearTimeout,
    TextEncoder,
    crypto: globalThis.crypto,
    URL: { createObjectURL() { return 'blob:material-map-test'; }, revokeObjectURL() {} },
    Node: ShimNode,
    Blob,
    navigator: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__EMBER_TEST__ = true;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox, { filename: 'viewer.html' });
  const internals = sandbox.__emberInternals;
  assert.ok(internals, 'the viewer test hook must be exposed');
  return internals;
}

class ShimNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this._text = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set((this.className || '').split(' ').concat(names))].join(' '); },
      remove: (...names) => {
        this.className = (this.className || '').split(' ').filter((name) => !names.includes(name)).join(' ');
      },
      contains: (name) => (this.className || '').split(' ').includes(name),
    };
  }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(text) { this._text = String(text); this.children = []; }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      for (const item of [...child.children]) this.appendChild(item);
      child.children = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener() {}
  dispatchEvent() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  matches(selector) { return selector.startsWith('#') ? this.id === selector.slice(1) : false; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
}

function textOf(nodes) {
  return (Array.isArray(nodes) ? nodes : [nodes])
    .map((node) => (node ? node.textContent : ''))
    .join('\n');
}

function extractPayloadFromHtml(html) {
  const marker = '<script id="ember-data" type="application/json">';
  const start = html.indexOf(marker);
  assert.ok(start !== -1, 'payload script is present');
  const end = html.indexOf('</script>', start);
  const text = html.slice(start + marker.length, end)
    .replaceAll('\\u0026', '&').replaceAll('\\u003c', '<').replaceAll('\\u003e', '>')
    .replaceAll('\\u2028', '\u2028').replaceAll('\\u2029', '\u2029');
  return parseJson(text, 'embedded payload');
}

function extractPayload(htmlPath) {
  return extractPayloadFromHtml(fs.readFileSync(htmlPath, 'utf8'));
}
