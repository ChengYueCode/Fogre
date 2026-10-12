// Task02 content-quality tests. All teaching content and quality records here
// are SYNTHETIC test fixtures authored for this test. They are not real learner
// data and make no claim that any source was read unless the fixture models a
// supplement that was actually checked. Every assertion runs the real public
// CLI against a throwaway output directory.
//
// Run: node --test tests/content-quality.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import { parseJson } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const QUALITY_OLD_TOOL = process.env.EMBER_QUALITY_OLD_TOOL;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-quality-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [EMBER, ...args], {
    encoding: 'utf8',
    env: process.env,
    ...options,
  });
  return result;
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

// A synthetic two-concept model. `range` is the core outcome; `copy` is the
// outcome that the gap fixture leaves unstructured.
function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-slice',
    title: '合成数组片段',
    goal: '能预测半开区间结果，并解释浅复制对原数组的影响。',
    summary: '合成测试资料，不代表真实课程或学习者。',
    concepts: [
      { id: 'root', title: '数组片段', parentId: null, difficulty: 1, explanation: '组织两个分支。' },
      {
        id: 'range', title: '半开区间', parentId: 'root', difficulty: 1,
        explanation: '包含起点、排除终点的区间。',
        example: 'slice(1,3) 取下标1到2。',
        misconception: '终点是要提取的数量。',
      },
      {
        id: 'copy', title: '浅复制', parentId: 'root', difficulty: 2,
        explanation: '返回新数组，但元素引用共享。',
        example: '改对象属性会从两个数组看到。',
        misconception: '新数组就是深复制。',
      },
    ],
    relations: [
      { id: 'rel-range-copy', from: 'range', to: 'copy', type: 'prerequisite', label: '先定区间再看引用' },
    ],
    prompts: [
      { id: 'p-range', conceptId: 'range', kind: 'apply', question: 'slice(1,3) 是什么？', answer: '含1排除3。', criteria: ['含起点', '排除终点'] },
      { id: 'p-copy', conceptId: 'copy', kind: 'explain', question: '为什么改属性会共享？', answer: '元素引用相同。', criteria: ['提到引用'] },
    ],
    sources: [
      { id: 'src-author', title: '合成作者材料', kind: 'provided', note: '验收者编写并核对。' },
      { id: 'src-primary', title: '合成一手规范占位', kind: 'primary', url: 'https://example.test/spec' },
    ],
    limitations: ['合成样例，不用于真实教学。'],
    ...overrides,
  };
}

// Build a complete six-dimension core concept record.
function six(result = 'covered', basis = '实际阅读并核对了合成材料。') {
  return [
    'goal-coverage', 'prerequisite', 'explanation-example',
    'boundary-misconception', 'task-criteria', 'sources-gaps',
  ].map((id) => ({ id, result, basis }));
}

/**
 * Produce a valid quality record for the current model by asking the CLI for
 * its template (exact scope snapshots), then filling the concepts.
 */
function recordFromTemplate(outDir, fill) {
  const template = cliJson(['quality-template', '--out', outDir]);
  const goal = template.goals[0];
  goal.concepts = goal.concepts.map((concept) => fill(concept));
  return template;
}

function completeRecord(outDir) {
  return recordFromTemplate(outDir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
  });
}

function writeRecord(dir, record) {
  const file = path.join(dir, 'incoming-quality.json');
  writeJson(file, record);
  return file;
}

function build(outDir, modelPath) {
  return cliJson(['build', modelPath, '--out', outDir]);
}

function seed(outDir, raw = rawModel()) {
  const modelPath = path.join(outDir, 'source.json');
  writeJson(modelPath, raw);
  build(outDir, modelPath);
  return modelPath;
}

// ---------------------------------------------------------------------------
// Condition 1+2: complete / supplementable / still-gap and core vs structural
// ---------------------------------------------------------------------------

test('complete material reads usable and passes the outcome; structural nodes stay structure-only', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const file = writeRecord(dir, completeRecord(dir));
  cliJson(['quality-write', '--out', dir, '--quality', file]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.stale, false);
  assert.equal(read.concepts.root.status, 'structure-only');
  assert.equal(read.concepts.range.status, 'usable');
  assert.equal(read.concepts.copy.status, 'usable');
  assert.equal(read.goals[0].status, 'usable');
  assert.equal(read.goals[0].passed, true);
});

test('supplementable material reads needs-supplement with the checked range, and does not pass', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    if (concept.id === 'range') return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
    return {
      ...concept,
      role: 'core',
      dimensions: six().map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'partial', basis: '原资料只说明返回新数组。' }
        : dimension)),
      supplements: [{
        id: 'sup-reference', role: 'supplement', conceptId: 'copy', dimension: 'explanation-example',
        sourceId: 'src-primary', checkedRange: '合成规范第 3 节元素复制步骤', access: 'https://example.test/spec',
        readAt: '2026-10-08', note: '只核对普通数组。',
      }],
      gaps: [],
    };
  });
  const file = writeRecord(dir, record);
  cliJson(['quality-write', '--out', dir, '--quality', file]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.concepts.copy.status, 'needs-supplement');
  assert.equal(read.concepts.range.status, 'usable');
  assert.equal(read.goals[0].status, 'needs-supplement');
  assert.equal(read.goals[0].passed, false);
  const supplement = read.concepts.copy.supplements[0];
  assert.equal(supplement.checkedRange, '合成规范第 3 节元素复制步骤');
  assert.equal(supplement.countedAsCoverage, true);
  assert.equal(supplement.sourceTitle, '合成一手规范占位');
});

test('still-gap material reports the gap and its outcome effect; the usable part still reads', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    if (concept.id === 'range') return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
    return {
      ...concept,
      role: 'core',
      dimensions: six().map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'missing', basis: '原资料没有对象元素共享引用的例子。' }
        : dimension)),
      supplements: [],
      gaps: [{
        id: 'gap-copy', dimension: 'explanation-example', text: '缺对象元素共享引用的解释与例子。',
        effect: 'blocking', outcomeEffect: '浅复制成果保持未通过。',
      }],
    };
  });
  const file = writeRecord(dir, record);
  cliJson(['quality-write', '--out', dir, '--quality', file]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.concepts.copy.status, 'still-gap');
  assert.equal(read.concepts.copy.gaps[0].outcomeEffect, '浅复制成果保持未通过。');
  assert.equal(read.concepts.range.status, 'usable', 'unaffected outcome stays deliverable');
  assert.equal(read.goals[0].status, 'still-gap');
  assert.equal(read.goals[0].passed, false);
});

// ---------------------------------------------------------------------------
// Condition 3: unread candidates and missing sources never count as coverage
// ---------------------------------------------------------------------------

test('an unread candidate cannot back a covered dimension or make a concept usable', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    if (concept.id === 'range') return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
    return {
      ...concept,
      role: 'core',
      dimensions: six().map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'covered', basis: '未读取，仅列出候选。', supplementIds: ['sup-unread'] }
        : dimension)),
      supplements: [{
        id: 'sup-unread', role: 'candidate', conceptId: 'copy', dimension: 'explanation-example',
        sourceId: 'src-unread', note: '没有实际读取。',
      }],
      gaps: [],
    };
  });
  const file = writeRecord(dir, record);
  const rejected = cli(['quality-write', '--out', dir, '--quality', file]);
  assert.notEqual(rejected.status, 0, 'a candidate cannot be declared as coverage');
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'rejection writes nothing');
});

test('a covered dimension pointing at a supplement whose source was removed re-reads stale and not passed', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    if (concept.id === 'range') return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
    return {
      ...concept,
      role: 'core',
      dimensions: six().map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'covered', basis: '依赖已读取补充。', supplementIds: ['sup-primary'] }
        : dimension)),
      supplements: [{
        id: 'sup-primary', role: 'supplement', conceptId: 'copy', dimension: 'explanation-example',
        sourceId: 'src-primary', checkedRange: '合成规范第 3 节', access: 'https://example.test/spec', readAt: '2026-10-08',
      }],
      gaps: [],
    };
  });
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  // Rebuild the model without that source; the record must stay readable.
  const withoutSource = rawModel({
    sources: [{ id: 'src-author', title: '合成作者材料', kind: 'provided', note: '验收者编写并核对。' }],
  });
  const modelPath = path.join(dir, 'reduced.json');
  writeJson(modelPath, withoutSource);
  build(dir, modelPath);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true, 'removed-source record stays readable');
  assert.equal(read.stale, true);
  assert.notEqual(read.concepts.copy.status, 'usable');
  assert.equal(read.goals[0].passed, false);
});

// ---------------------------------------------------------------------------
// Condition 4: invalid input is rejected without writing; learner state safe
// ---------------------------------------------------------------------------

test('a core concept missing one of the six dimensions is rejected and writes nothing', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    if (concept.id === 'range') return { ...concept, role: 'core', dimensions: six().slice(0, 5), supplements: [], gaps: [] };
    return { ...concept, role: 'core', dimensions: six(), supplements: [], gaps: [] };
  });
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /sources-gaps|缺少质检维度/);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'invalid record is never written');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), before, 'learner state bytes unchanged');
});

test('an illegal dimension result is rejected before any write', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    const dimensions = six().map((dimension, index) => (index === 0 ? { ...dimension, result: 'definitely' } : dimension));
    return { ...concept, role: 'core', dimensions, supplements: [], gaps: [] };
  });
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a quality record written and read leaves learner state byte-identical', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const stateBefore = fs.readFileSync(path.join(dir, 'state.json'));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  cliJson(['quality-read', '--out', dir]);
  cliJson(['quality-template', '--out', dir, '--to', path.join(dir, 'template.json')]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), stateBefore, 'quality commands do not touch learner state');
});

// ---------------------------------------------------------------------------
// Condition 5: goal and content updates invalidate scope; write refuses stale
// ---------------------------------------------------------------------------

test('changing the goal invalidates the record and a stale write is refused', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  const preChangeRecord = writeRecord(dir, completeRecord(dir));
  cliJson(['quality-write', '--out', dir, '--quality', preChangeRecord]);
  const changedGoal = rawModel({ goal: '改用不同目标：能独立实现一个不依赖内置方法的切片函数。' });
  writeJson(modelPath, changedGoal);
  build(dir, modelPath);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.stale, true);
  assert.ok(read.staleReasons.some((reason) => reason.includes('目标')), 'goal change is named');
  assert.equal(read.goals[0].passed, false);

  const refused = cli(['quality-write', '--out', dir, '--quality', preChangeRecord]);
  assert.notEqual(refused.status, 0, 'a pre-change record is refused after the goal changed');
});

test('changing concept content invalidates the record and keeps it readable with recheck reasons', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const changed = rawModel();
  changed.concepts = changed.concepts.map((concept) => (concept.id === 'copy'
    ? { ...concept, explanation: '改过的浅复制解释。' }
    : concept));
  writeJson(modelPath, changed);
  build(dir, modelPath);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.stale, true);
  assert.ok(read.staleReasons.some((reason) => reason.includes('copy')), 'changed concept is named');
  assert.equal(read.goals[0].passed, false);
});

test('a quality record for a different model id is rejected', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  record.modelId = 'someone-elses-model';
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a per-goal scope that no longer matches current content is rejected even when the top scope is current', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  // Top-level scope stays exact; the goal's own snapshot is stale, as if the
  // goal block was edited or authored against older content.
  record.goals[0].scope = { ...record.goals[0].scope, goalFingerprint: 'stale-goal-fingerprint' };
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'a stale per-goal scope must be refused');
  assert.match(rejected.stderr, /g-1|目标/);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a per-goal outcome text that differs from the model goal is rejected', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  record.goals[0].outcome = '一个与模型目标不同的成果描述';
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'the goal outcome must match the model goal');
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a supplement whose conceptId names a different concept is rejected', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    const base = { ...concept, role: 'core', dimensions: six(), gaps: [] };
    if (concept.id !== 'copy') return { ...base, supplements: [] };
    return {
      ...base,
      supplements: [{
        id: 'sup-mismatch', role: 'supplement', conceptId: 'range', dimension: 'explanation-example',
        sourceId: 'src-primary', checkedRange: '合成规范第 3 节', access: 'https://example.test/spec', readAt: '2026-10-08',
      }],
    };
  });
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'supplement must belong to its owning concept');
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a supplement with an invented dimension is rejected', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    const base = { ...concept, role: 'core', dimensions: six(), gaps: [] };
    if (concept.id !== 'copy') return { ...base, supplements: [] };
    return {
      ...base,
      supplements: [{
        id: 'sup-invented', role: 'supplement', conceptId: 'copy', dimension: 'made-up-dimension',
        sourceId: 'src-primary', checkedRange: '合成规范第 3 节', access: 'https://example.test/spec', readAt: '2026-10-08',
      }],
    };
  });
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'supplement dimension must be one of the six checks');
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

// ---------------------------------------------------------------------------
// Condition 6+7: build payload exposes quality; template snapshots are exact
// ---------------------------------------------------------------------------

test('build payload carries a quality view without altering learner state or quality.json', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const qualityBefore = fs.readFileSync(path.join(dir, 'quality.json'));
  const summary = build(dir, modelPath);
  assert.equal(summary.quality.present, true);
  assert.equal(summary.quality.stale, false);

  const payload = extractPayload(path.join(dir, 'index.html'));
  assert.ok(payload.quality, 'payload must include a quality view');
  assert.equal(payload.quality.present, true);
  assert.equal(payload.quality.concepts.copy.status, 'usable');
  assert.equal(payload.quality.concepts.root.status, 'structure-only');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'quality.json')), qualityBefore, 'build never rewrites quality.json');
});

test('the template command snapshots exact current scope fingerprints', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const template = cliJson(['quality-template', '--out', dir]);
  const model = normalizeModel(rawModel());
  assert.equal(template.scope.modelFingerprint, model.modelFingerprint);
  assert.equal(template.goals[0].scope.concepts.range, model.conceptFingerprints.range);
  assert.equal(template.goals[0].scope.prompts['p-copy'], model.promptFingerprints['p-copy']);
  for (const concept of template.goals[0].concepts) assert.equal(concept.role, null);
});

test('the read/build payload exposes each goal original scope and full per-goal concept records', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const read = cliJson(['quality-read', '--out', dir]);
  const goal = read.goals[0];
  // Original version snapshot for AC5: not just a pass/fail summary.
  assert.equal(typeof goal.scope.modelFingerprint, 'string');
  assert.equal(goal.scope.modelFingerprint.length, 64);
  assert.equal(goal.scope.concepts.copy, normalizeModel(rawModel()).conceptFingerprints.copy);
  assert.equal(typeof goal.recordedAt, 'string');
  const copy = goal.concepts.find((concept) => concept.id === 'copy');
  assert.equal(copy.role, 'core');
  assert.equal(copy.status, 'usable');
  assert.deepEqual(copy.dimensions.map((dimension) => dimension.id).sort(), [
    'boundary-misconception', 'explanation-example', 'goal-coverage',
    'prerequisite', 'sources-gaps', 'task-criteria',
  ]);
  assert.deepEqual(copy.gaps, []);
  assert.deepEqual(copy.staleReasons, []);
  assert.ok(Array.isArray(copy.supplements));
  // Flat map stays for existing readers and carries the same detail.
  assert.equal(read.concepts.copy.status, 'usable');
  assert.deepEqual(read.concepts.copy.dimensions.map((dimension) => dimension.id).sort(), copy.dimensions.map((dimension) => dimension.id).sort());

  const payload = extractPayload(path.join(dir, 'index.html'));
  void payload;
  build(dir, modelPath);
  const rebuilt = extractPayload(path.join(dir, 'index.html'));
  assert.equal(rebuilt.quality.goals[0].scope.modelFingerprint, goal.scope.modelFingerprint);
  assert.equal(rebuilt.quality.goals[0].concepts.find((concept) => concept.id === 'copy').status, 'usable');
});

test('one concept supporting two goals keeps both conclusions in the flat map', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  const secondGoal = JSON.parse(JSON.stringify(record.goals[0]));
  secondGoal.id = 'g-2';
  // Second goal: copy is a still-gap, range stays usable.
  secondGoal.concepts = secondGoal.concepts.map((concept) => (concept.id === 'copy'
    ? {
      ...concept,
      dimensions: concept.dimensions.map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'missing', basis: '第二目标下缺少可核对的例子。' }
        : dimension)),
      gaps: [{
        id: 'gap-2', dimension: 'explanation-example', text: '第二个目标缺例子。',
        effect: 'blocking', outcomeEffect: '第二目标未通过。',
      }],
    }
    : concept));
  record.goals.push(secondGoal);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  const firstCopy = read.goals[0].concepts.find((concept) => concept.id === 'copy');
  const secondCopy = read.goals[1].concepts.find((concept) => concept.id === 'copy');
  assert.equal(firstCopy.status, 'usable', 'first goal conclusion is preserved');
  assert.equal(secondCopy.status, 'still-gap', 'second goal conclusion is independent');
  assert.deepEqual(read.concepts.copy.goalIds, ['g-1', 'g-2']);
  assert.equal(read.concepts.copy.status, 'still-gap', 'flat map keeps the most conservative status');
});

test('a candidate supplement is readable but never counted as coverage', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => {
    if (concept.id === 'root') return { ...concept, role: 'structural' };
    const base = { ...concept, role: 'core', dimensions: six(), gaps: [] };
    if (concept.id !== 'copy') return { ...base, supplements: [] };
    return {
      ...base,
      dimensions: base.dimensions.map((dimension) => (dimension.id === 'explanation-example'
        ? { id: dimension.id, result: 'partial', basis: '原资料不足。' }
        : dimension)),
      supplements: [{
        id: 'sup-candidate', role: 'candidate', conceptId: 'copy', dimension: 'explanation-example',
        sourceId: 'src-primary', note: '列为候选，尚未读取。',
      }],
    };
  });
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  const supplement = read.concepts.copy.supplements[0];
  assert.equal(supplement.role, 'candidate');
  assert.equal(supplement.countedAsCoverage, false);
  assert.notEqual(read.concepts.copy.status, 'usable');
  assert.equal(read.goals[0].passed, false);
});

test('a goal that declares only structural concepts can never pass', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = recordFromTemplate(dir, (concept) => ({ ...concept, role: 'structural' }));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.goals[0].status, 'still-gap');
  assert.equal(read.goals[0].passed, false, 'organization-only goal has no learning outcome to pass');
  assert.equal(read.concepts.range.status, 'structure-only');
});

test('quality-validate reports validity without writing and fails on a malformed record', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const validFile = writeRecord(dir, completeRecord(dir));
  const ok = cliJson(['quality-validate', validFile, '--out', dir]);
  assert.equal(ok.valid, true);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'validate never writes the record');

  const broken = completeRecord(dir);
  // Drop one required dimension from a core concept: structurally malformed.
  broken.goals[0].concepts = broken.goals[0].concepts.map((concept) => (concept.role === 'core'
    ? { ...concept, dimensions: concept.dimensions.slice(0, 5) }
    : concept));
  const brokenFile = path.join(dir, 'broken.json');
  writeJson(brokenFile, broken);
  const failed = cli(['quality-validate', brokenFile, '--out', dir]);
  assert.notEqual(failed.status, 0, 'a core concept missing a dimension fails validation');
});

test('quality-template refuses to overwrite an existing record and a fresh draft still succeeds', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const qualityPath = path.join(dir, 'quality.json');
  const before = fs.readFileSync(qualityPath);

  // Pointing the skeleton at the durable record must refuse without writing.
  const refused = cli(['quality-template', '--out', dir, '--to', qualityPath]);
  assert.notEqual(refused.status, 0, 'template must not overwrite an existing record');
  assert.match(refused.stderr, /已存在/);
  assert.deepEqual(fs.readFileSync(qualityPath), before, 'existing report bytes are retained');
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true);
  assert.equal(read.stale, false, 'the retained report still reads as current');
  assert.equal(read.goals[0].passed, true);

  // A brand-new draft path still works.
  const draft = path.join(dir, 'quality-draft.json');
  const fresh = cliJson(['quality-template', '--out', dir, '--to', draft]);
  assert.equal(fresh.template, true);
  assert.equal(fs.existsSync(draft), true);
});

test('the documented author journey rebuilds the page: write leaves it unqualified, build shows the record', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const modelPath = seed(dir);
  const htmlBeforeWrite = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const htmlAfterWrite = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.deepEqual(htmlAfterWrite, htmlBeforeWrite, 'quality-write never rebuilds index.html');

  // The documented step: rebuild from the written model so the page carries the
  // quality view, while the learner archive stays byte-identical.
  const stateBefore = fs.readFileSync(path.join(dir, 'state.json'));
  build(dir, modelPath);
  const rebuiltPayload = extractPayload(path.join(dir, 'index.html'));
  assert.equal(rebuiltPayload.quality.present, true);
  assert.equal(rebuiltPayload.quality.stale, false);
  assert.equal(rebuiltPayload.quality.concepts.root.status, 'structure-only');
  assert.equal(rebuiltPayload.quality.goals[0].passed, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), stateBefore,
    'rebuilding for quality preserves the learner archive byte-for-byte');
});

// ---------------------------------------------------------------------------
// F1: every current model concept must be explicitly declared
// ---------------------------------------------------------------------------

test('a record that omits a current model concept is rejected on write', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  // `root` still sits in scope.concepts but is silently dropped from the goal's
  // own concept list: no explicit core/structural role for it.
  record.goals[0].concepts = record.goals[0].concepts.filter((concept) => concept.id !== 'root');
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'a current concept must be declared core or structural');
  assert.match(rejected.stderr, /root/);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a legacy record that omits a concept still reads conservatively as not-passed', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  delete record.scope; // legacy shape: no top-level snapshot
  record.goals[0].concepts = record.goals[0].concepts.filter((concept) => concept.id !== 'root');
  // Bypass the write gate: place the record directly as a historical file, the
  // way an older tool or hand-edit could have left it.
  writeJson(path.join(dir, 'quality.json'), record);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true, 'legacy record stays readable');
  assert.equal(read.goals[0].status, 'still-gap');
  assert.equal(read.goals[0].passed, false, 'an undeclared concept must not read as passing');
  assert.ok(read.staleReasons.some((reason) => reason.includes('root')));
  assert.equal(read.concepts.root.status, 'still-gap');
});

// ---------------------------------------------------------------------------
// F2: top-level scope is enforced on write, not just per-goal scope
// ---------------------------------------------------------------------------

test('a corrupt top-level scope is rejected even when every per-goal scope is current', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  record.scope = { ...record.scope, modelFingerprint: 'corrupt-top-scope', goalFingerprint: 'corrupt-goal' };
  record.scope.concepts = { ...record.scope.concepts, range: 'corrupt-concept' };
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'the top-level scope must also match current content');
  assert.match(rejected.stderr, /模型内容版本|概念|目标/);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false, 'a write that would land stale never persists');
});

test('a written record reads back with stale:false so write and read agree', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, completeRecord(dir))]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.stale, false, 'a just-written record must not immediately read as stale');
  assert.deepEqual(read.staleReasons, []);
  assert.equal(read.goals[0].passed, true);
});

test('a persisted record with a corrupt top scope reads stale and never goal-passed', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  // Simulate a v1-admitted bad record already on disk: valid per-goal scopes
  // and full declarations, but a corrupted top-level scope. It bypasses the new
  // write gate by landing directly as a historical file.
  const record = completeRecord(dir);
  record.scope = { ...record.scope, modelFingerprint: 'corrupt-top-scope', goalFingerprint: 'corrupt-goal' };
  record.scope.concepts = { ...record.scope.concepts, range: 'corrupt-range' };
  writeJson(path.join(dir, 'quality.json'), record);

  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.present, true, 'the old record is still readable, not dropped');
  assert.equal(read.stale, true);
  // No goal may claim a pass while the report is globally stale.
  assert.equal(read.goals[0].passed, false, 'a stale report must not pass any goal');
  assert.equal(read.goals[0].stale, true);
  assert.ok(read.goals[0].staleReasons.length > 0, 'the goal carries the top-level reasons too');
  assert.ok(read.staleReasons.some((reason) => reason.includes('模型内容版本')), 'top-level drift is named');
  // Flat records agree with the goal-level view.
  assert.equal(read.concepts.copy.passed, false);
  assert.equal(read.concepts.copy.stale, true);

  // The original record-level scope snapshot is retained for the page to show,
  // alongside the goal's own (still-current) snapshot.
  assert.equal(read.scope.modelFingerprint, 'corrupt-top-scope');
  assert.equal(typeof read.goals[0].scope.modelFingerprint, 'string');
  const after = parseJson(fs.readFileSync(path.join(dir, 'quality.json'), 'utf8'), 'persisted quality');
  assert.equal(after.scope.modelFingerprint, 'corrupt-top-scope', 'read never repairs the persisted bytes');
});

// ---------------------------------------------------------------------------
// F3: flat concept map aggregates conservatively, in both goal orders
// ---------------------------------------------------------------------------

function twoGoalRecord(dir, firstRole, secondRole) {
  const record = completeRecord(dir);
  const g1 = record.goals[0];
  const g2 = JSON.parse(JSON.stringify(g1));
  g2.id = 'g-2';
  g1.concepts = g1.concepts.map((concept) => (concept.id === 'copy' ? firstRole(concept) : concept));
  g2.concepts = g2.concepts.map((concept) => (concept.id === 'copy' ? secondRole(concept) : concept));
  record.goals = [g1, g2];
  return record;
}

function stillGapCopy(concept) {
  return {
    ...concept,
    dimensions: concept.dimensions.map((dimension) => (dimension.id === 'explanation-example'
      ? { id: dimension.id, result: 'missing', basis: '该目标下没有例子。' }
      : dimension)),
    gaps: [{
      id: 'gap-x', dimension: 'explanation-example', text: '缺例子。',
      effect: 'blocking', outcomeEffect: '该目标未通过。',
    }],
    supplements: [{
      id: 'candidate-gap', role: 'candidate', conceptId: 'copy',
      dimension: 'explanation-example', sourceId: 'src-primary',
      note: '合成测试的未读取候选，不计入覆盖。',
    }],
  };
}

test('flat map: still-gap then usable keeps passed:false', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = twoGoalRecord(dir, stillGapCopy, (concept) => concept);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  const flat = read.concepts.copy;
  assert.equal(flat.status, 'still-gap');
  assert.equal(flat.passed, false, 'a later usable goal must not flip the aggregate to passed');
  assert.notEqual(flat.outcomeStatus, 'usable');
  assert.deepEqual(flat.goalIds, ['g-1', 'g-2']);
  // Per-goal detail is preserved independently.
  assert.equal(read.goals[0].concepts.find((c) => c.id === 'copy').status, 'still-gap');
  assert.equal(read.goals[1].concepts.find((c) => c.id === 'copy').status, 'usable');
  assertFlatRepresentative(read, 'g-1');
  build(dir, path.join(dir, 'model.json'));
  assertFlatRepresentative(extractPayload(path.join(dir, 'index.html')).quality, 'g-1');
});

test('flat map: usable then still-gap also reads not-passed', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = twoGoalRecord(dir, (concept) => concept, stillGapCopy);
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  const flat = read.concepts.copy;
  assert.equal(flat.status, 'still-gap');
  assert.equal(flat.passed, false);
  assert.notEqual(flat.outcomeStatus, 'usable');
  assert.deepEqual(flat.goalIds, ['g-1', 'g-2']);
  assert.equal(read.goals[0].concepts.find((c) => c.id === 'copy').status, 'usable');
  assert.equal(read.goals[1].concepts.find((c) => c.id === 'copy').status, 'still-gap');
  assertFlatRepresentative(read, 'g-2');
  build(dir, path.join(dir, 'model.json'));
  assertFlatRepresentative(extractPayload(path.join(dir, 'index.html')).quality, 'g-2');
});

function assertFlatRepresentative(view, goalId) {
  const flat = view.concepts.copy;
  const representative = view.goals.find((goal) => goal.id === goalId).concepts.find((concept) => concept.id === 'copy');
  for (const field of ['goalId', 'outcome', 'role', 'dimensions', 'gaps', 'supplements']) {
    assert.deepEqual(flat[field], representative[field], `${field} must describe the goal behind the worst status`);
  }
  assert.equal(flat.dimensions.find((dimension) => dimension.id === 'explanation-example').result, 'missing');
  assert.equal(flat.gaps[0].effect, 'blocking');
  assert.equal(flat.supplements[0].role, 'candidate');
}

// These legal v2 shapes are persisted directly on every checkout. Optionally
// set EMBER_QUALITY_OLD_TOOL to verify creation with a real v2 CLI as well.
// Current read/build retain the bytes and expose the missing rationale;
// current write remains strict.
for (const result of ['partial', 'missing', 'not-applicable']) {
  test(`v2 ${result} with empty basis survives current read/build as stale and not-passed`, (t) => {
      const dir = tmpDir();
      t.after(() => cleanup(dir));
      seed(dir);
      const record = completeRecord(dir);
      const copy = record.goals[0].concepts.find((concept) => concept.id === 'copy');
      copy.dimensions = copy.dimensions.map((dimension) => dimension.id === 'explanation-example'
        ? { ...dimension, result, basis: '' } : dimension);
      const draft = writeRecord(dir, record);
      const qualityPath = path.join(dir, 'quality.json');
      if (QUALITY_OLD_TOOL) {
        const oldWrite = spawnSync(process.execPath,
          [QUALITY_OLD_TOOL, 'quality-write', '--out', dir, '--quality', draft], { encoding: 'utf8' });
        assert.equal(oldWrite.status, 0, `real v2 write must accept the historical record: ${oldWrite.stderr}`);
        assert.equal(parseJson(oldWrite.stdout).written, true);
      } else {
        writeJson(qualityPath, record);
      }
      const original = fs.readFileSync(qualityPath);
      const stateBefore = fs.readFileSync(path.join(dir, 'state.json'));
      const sceneBefore = fs.readFileSync(path.join(dir, 'map.excalidraw'));
      const read = cliJson(['quality-read', '--out', dir]);
      assert.equal(read.present, true);
      assert.equal(read.stale, true);
      assert.equal(read.goals[0].stale, true);
      assert.equal(read.goals[0].passed, false);
      assert.equal(read.goals[0].status, 'still-gap');
      assert.equal(read.concepts.copy.status, 'still-gap');
      assert.equal(read.concepts.copy.passed, false);
      assert.ok(read.goals[0].staleReasons.some((reason) => reason.includes('copy') && reason.includes('basis')));
      const historicalDimension = read.concepts.copy.dimensions.find((dimension) => dimension.id === 'explanation-example');
      assert.equal(historicalDimension.result, result);
      assert.equal(historicalDimension.basis, '');

      const summary = build(dir, path.join(dir, 'model.json'));
      assert.equal(summary.quality.stale, true);
      assert.equal(summary.written.quality, false);
      const payload = extractPayload(path.join(dir, 'index.html'));
      assert.equal(payload.quality.goals[0].passed, false);
      assert.equal(payload.quality.concepts.copy.status, 'still-gap');
      assert.deepEqual(fs.readFileSync(qualityPath), original, 'read/build retain the actual v2 report bytes');
      assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), stateBefore);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'map.excalidraw')), sceneBefore);

      const rejected = cli(['quality-write', '--out', dir, '--quality', qualityPath]);
      assert.notEqual(rejected.status, 0, 'historical read tolerance must not weaken current write validation');
      assert.match(rejected.stderr, /basis/);
      assert.deepEqual(fs.readFileSync(qualityPath), original, 'strict rejection also retains the historical report');
    });
}

// ---------------------------------------------------------------------------
// F3b: every declared dimension needs a rationale; no free "all N/A" pass
// ---------------------------------------------------------------------------

test('a dimension with an empty basis is rejected for every result', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  record.goals[0].concepts = record.goals[0].concepts.map((concept) => (concept.role === 'core'
    ? {
      ...concept,
      dimensions: concept.dimensions.map((dimension) => (dimension.id === 'boundary-misconception'
        ? { id: dimension.id, result: 'not-applicable', basis: '' }
        : dimension)),
    }
    : concept));
  const rejected = cli(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  assert.notEqual(rejected.status, 0, 'not-applicable still needs a written basis');
  assert.match(rejected.stderr, /basis|依据/);
  assert.equal(fs.existsSync(path.join(dir, 'quality.json')), false);
});

test('a core concept with goal-coverage not-applicable cannot pass the outcome', (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  seed(dir);
  const record = completeRecord(dir);
  record.goals[0].concepts = record.goals[0].concepts.map((concept) => (concept.role === 'core'
    ? {
      ...concept,
      dimensions: concept.dimensions.map((dimension) => ({
        id: dimension.id,
        result: 'not-applicable',
        basis: '合成测试：该维度不在本目标范围内。',
      })),
    }
    : concept));
  cliJson(['quality-write', '--out', dir, '--quality', writeRecord(dir, record)]);
  const read = cliJson(['quality-read', '--out', dir]);
  assert.equal(read.concepts.range.status, 'still-gap', 'all-N/A core coverage is not a pass');
  assert.equal(read.goals[0].passed, false);
  assert.notEqual(read.goals[0].status, 'usable');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPayload(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const marker = '<script id="ember-data" type="application/json">';
  const start = html.indexOf(marker);
  assert.ok(start !== -1, 'payload script is present');
  const end = html.indexOf('</script>', start);
  const text = html.slice(start + marker.length, end)
    .replaceAll('\\u0026', '&').replaceAll('\\u003c', '<').replaceAll('\\u003e', '>')
    .replaceAll('\\u2028', '\u2028').replaceAll('\\u2029', '\u2029');
  return parseJson(text, 'embedded payload');
}

void modelToJson;
