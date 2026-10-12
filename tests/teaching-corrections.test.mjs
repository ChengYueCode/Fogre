// Task05 teaching-correction tests. Every model, claim, answer and correction
// here is a SYNTHETIC fixture authored for this test; none of it is real
// learner data or a real teaching history. All assertions drive the real
// public CLI (and, where the record must survive a handoff, the real HTTP
// server) against a throwaway output directory.
//
// Run: node --test tests/teaching-corrections.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJson } from '../skill/forge/scripts/lib/io.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-teaching-corrections-'));
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

function cliError(args) {
  const result = cli(args);
  assert.equal(result.status, 1, `command should fail: forge ${args.join(' ')}\n${result.stdout}`);
  return result.stderr;
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

// A synthetic one-concept model whose explanation and exercise deliberately
// carry a mis-teaching: they claim to-tickets needs the user to re-state the
// skill's own splitting/dependency flow. This mirrors the spec's A13/A16
// regression case without copying any real repository text.
function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-tickets',
    title: '合成技能材料',
    goal: '能按原文规则调用技能，并说明哪些流程属于技能自身。',
    summary: '合成测试材料，不代表真实课程或学习者。',
    sources: [{ id: 'src-skill', title: '技能原文', kind: 'provided', note: '合成材料', url: '' }],
    concepts: [
      { id: 'root', title: '技能材料', parentId: null, difficulty: 1, explanation: '组织两个分支。' },
      {
        id: 'tickets', title: 'to-tickets 用法', parentId: 'root', difficulty: 2,
        explanation: '错误讲解：必须在请求里补写「拆分任务并声明阻塞关系」，否则技能不生效。',
        example: '示例请求带着重复的拆分指令。',
        misconception: '以为长提示词是必要输入。',
      },
    ],
    relations: [],
    prompts: [
      {
        id: 'p-tickets', conceptId: 'tickets', kind: 'apply',
        question: '把这份规格转成任务，请求该怎么写？',
        answer: '必须补写「拆分任务、声明阻塞关系」，技能才会执行。',
        criteria: ['提到拆分任务指令', '提到阻塞关系指令'],
      },
    ],
    ...overrides,
  };
}

function correctedModel() {
  return rawModel({
    concepts: [
      { id: 'root', title: '技能材料', parentId: null, difficulty: 1, explanation: '组织两个分支。' },
      {
        id: 'tickets', title: 'to-tickets 用法', parentId: 'root', difficulty: 2,
        explanation: '拆分任务与声明阻塞关系是技能自带流程；用户提供规格或可用上下文，补充特殊范围并审核结果。',
        example: '最小请求：技能名 + 规格（或已提供的上下文）。',
        misconception: '以为必须重复技能自带的拆分指令。',
      },
    ],
    prompts: [
      {
        id: 'p-tickets', conceptId: 'tickets', kind: 'apply',
        question: '把这份规格转成任务，请求该怎么写？',
        answer: '给出技能名和规格即可；拆分与阻塞关系由技能自带流程完成。',
        criteria: ['含技能名', '含规格或上下文', '不要求补写拆分/依赖指令'],
      },
    ],
  });
}

const CORRECTION = {
  claim: '先前讲成：使用 to-tickets 必须在请求里补写「拆分任务并声明阻塞关系」。',
  feedback: '学习者指出技能原文已自带拆分与阻塞声明流程。',
  correction: '拆分任务与声明阻塞关系是 to-tickets 自带流程；用户提供规格或可用上下文，补充特殊范围并审核结果即可。',
  basis: '回读技能原文「用户输入」一节：技能负责拆分任务并声明阻塞关系；最小请求无需重复这些指令。',
  sourceId: 'src-skill',
  impacts: [
    { kind: 'explanation', id: 'tickets', note: '概念解释与示例已更正并重建页面。' },
    { kind: 'exercise', id: 'p-tickets', note: '练习题干、参考答案与判定标准已更正。' },
  ],
};

function setup(dir, { model = rawModel() } = {}) {
  writeJson(path.join(dir, 'model.json'), model);
  cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);
  return path.join(dir, 'model.json');
}

function submitMisledAnswer(dir, attemptId, at) {
  cliJson(['submit', '--out', dir, '--prompt', 'p-tickets',
    '--answer', '必须补写拆分任务和阻塞关系指令，技能才会生效。',
    '--attempt-id', attemptId, '--at', at]);
}

function recordCorrection(dir, at, overrides = {}, correctionId = 'tcorr-tickets-1') {
  const file = path.join(dir, `correction-${correctionId}.json`);
  writeJson(file, { ...CORRECTION, ...overrides });
  return cliJson(['correction-record', '--out', dir, '--record', file,
    ...(correctionId ? ['--correction-id', correctionId] : []), '--at', at]);
}

function readCorrections(dir) {
  return cliJson(['correction-read', '--out', dir]);
}

// ---------------------------------------------------------------------------
// Write validation
// ---------------------------------------------------------------------------

test('correction-record rejects an apology without a re-read basis, unresolvable references and unexplained no-impact', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    const noBasis = path.join(dir, 'no-basis.json');
    writeJson(noBasis, { claim: '先前的说法', correction: '正确说法', impacts: [{ kind: 'explanation', id: 'tickets', note: '已改' }] });
    assert.match(cliError(['correction-record', '--out', dir, '--record', noBasis, '--at', '2026-10-10T02:00:00Z']),
      /basis/);

    const noImpacts = path.join(dir, 'no-impacts.json');
    writeJson(noImpacts, { claim: '先前的说法', correction: '正确说法', basis: '回读了原文。', impacts: [] });
    assert.match(cliError(['correction-record', '--out', dir, '--record', noImpacts, '--at', '2026-10-10T02:00:00Z']),
      /noImpactReason/);

    const unknownConcept = path.join(dir, 'unknown-concept.json');
    writeJson(unknownConcept, { ...CORRECTION, impacts: [{ kind: 'explanation', id: 'nope', note: '不存在' }] });
    assert.match(cliError(['correction-record', '--out', dir, '--record', unknownConcept, '--at', '2026-10-10T02:00:00Z']),
      /概念不存在/);

    const unknownPrompt = path.join(dir, 'unknown-prompt.json');
    writeJson(unknownPrompt, { ...CORRECTION, impacts: [{ kind: 'exercise', id: 'p-nope', note: '不存在' }] });
    assert.match(cliError(['correction-record', '--out', dir, '--record', unknownPrompt, '--at', '2026-10-10T02:00:00Z']),
      /问题不存在/);

    const unknownAttempt = path.join(dir, 'unknown-attempt.json');
    writeJson(unknownAttempt, { ...CORRECTION, impacts: [...CORRECTION.impacts, { kind: 'record', id: 'att-nope', note: '不存在' }] });
    assert.match(cliError(['correction-record', '--out', dir, '--record', unknownAttempt, '--at', '2026-10-10T02:00:00Z']),
      /原答不存在/);

    const unknownSource = path.join(dir, 'unknown-source.json');
    writeJson(unknownSource, { ...CORRECTION, sourceId: 'src-nope' });
    assert.match(cliError(['correction-record', '--out', dir, '--record', unknownSource, '--at', '2026-10-10T02:00:00Z']),
      /来源不存在/);
  } finally {
    cleanup(dir);
  }
});

test('a same-id replay is idempotent while a same-id different content write is refused without touching the archive', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    recordCorrection(dir, '2026-10-10T02:00:00Z');
    const statePath = path.join(dir, 'state.json');
    const afterFirst = bytes(statePath);

    const replay = recordCorrection(dir, '2026-10-10T02:00:00Z');
    assert.equal(replay.saved, true);
    assert.equal(bytes(statePath).toString(), afterFirst.toString(), 'an identical replay must not rewrite the archive');

    const divergent = path.join(dir, 'divergent.json');
    writeJson(divergent, { ...CORRECTION, correction: '被改写的解释' });
    assert.match(cliError(['correction-record', '--out', dir, '--record', divergent,
      '--correction-id', 'tcorr-tickets-1', '--at', '2026-10-10T02:00:00Z']),
      /纠错历史不可改写/);
    assert.equal(bytes(statePath).toString(), afterFirst.toString(), 'a refused rewrite must not touch the archive');
  } finally {
    cleanup(dir);
  }
});

test('an identical replay stays idempotent even after the referenced concept was removed from the model', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.json');
  try {
    setup(dir);
    recordCorrection(dir, '2026-10-10T02:00:00Z');

    // The concept (and its prompt) disappears from the live model; the
    // correction history must still replay as a no-op — replaying history
    // never requires the live model to still match it.
    const stripped = rawModel();
    stripped.concepts = [stripped.concepts[0]];
    stripped.prompts = [];
    writeJson(path.join(dir, 'model.json'), stripped);
    cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);

    const view = readCorrections(dir);
    assert.equal(view.total, 1, 'history stays readable after the removal');
    const removedImpact = view.corrections[0].impacts.find((impact) => impact.kind === 'explanation');
    assert.equal(removedImpact.status, 'removed', 'the removed concept is reported honestly');

    // Compare against the post-rebuild archive: the replay itself must not
    // write anything (the build legitimately updated the fingerprint above).
    const afterRebuild = bytes(statePath);
    const replay = recordCorrection(dir, '2026-10-10T02:00:00Z');
    assert.equal(replay.saved, true);
    assert.equal(bytes(statePath).toString(), afterRebuild.toString(), 'the replay after removal is a byte-stable no-op');
  } finally {
    cleanup(dir);
  }
});

test('an explicit no-impact reason is saved and read back', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    const noImpact = path.join(dir, 'no-impact.json');
    writeJson(noImpact, {
      claim: '口误：把概念标题说成了另一个名字。',
      correction: '正确标题是「to-tickets 用法」，页面标题本身没有错。',
      basis: '回读原文与当前 model.json 标题一致；讲解口误未写入任何内容或练习。',
      impacts: [],
      noImpactReason: '只影响即时口头表达，概念、练习、参考与学习记录均未受影响。',
    });
    cliJson(['correction-record', '--out', dir, '--record', noImpact, '--correction-id', 'tcorr-verbal-1',
      '--at', '2026-10-10T02:00:00Z']);
    const view = readCorrections(dir);
    assert.equal(view.total, 1);
    assert.equal(view.corrections[0].noImpactReason, '只影响即时口头表达，概念、练习、参考与学习记录均未受影响。');
    assert.deepEqual(view.corrections[0].impacts, []);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Recheck links
// ---------------------------------------------------------------------------

test('recheck refuses the misled answer and unknown attempts, then links a genuine follow-up idempotently', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    recordCorrection(dir, '2026-10-10T02:00:00Z');

    // The misled answer predates the correction: it belongs to the impact
    // scope, never to the follow-up list.
    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-misled', '--recheck-note', '受误导旧答', '--at', '2026-10-10T03:00:00Z']),
      /晚于纠错记录/);
    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-nope', '--recheck-note', '不存在', '--at', '2026-10-10T03:00:00Z']),
      /原答不存在/);
    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-missing',
      '--recheck-attempt', 'att-misled', '--recheck-note', '无此纠错', '--at', '2026-10-10T03:00:00Z']),
      /没有找到教学纠错记录/);

    const statePath = path.join(dir, 'state.json');
    const before = bytes(statePath);
    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-misled', '--recheck-note', '另一次', '--at', '2026-10-10T03:00:00Z']),
      /晚于纠错记录/);
    assert.equal(bytes(statePath).toString(), before.toString(), 'refused rechecks never touch the archive');

    // Content update + a real new attempt, then link it.
    writeJson(path.join(dir, 'model.json'), correctedModel());
    cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);
    cliJson(['submit', '--out', dir, '--prompt', 'p-tickets',
      '--answer', '技能名加规格即可；拆分与阻塞关系由技能自带流程完成。',
      '--attempt-id', 'att-recheck', '--at', '2026-10-10T04:00:00Z']);
    cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。',
      '--at', '2026-10-10T04:30:00Z']);

    const view = readCorrections(dir);
    const correction = view.corrections[0];
    assert.equal(correction.rechecks.length, 1);
    assert.equal(correction.rechecks[0].attemptId, 'att-recheck');
    assert.equal(correction.rechecks[0].attemptStatus, 'current');
    assert.equal(correction.rechecks[0].assisted, false);

    const afterAppend = bytes(statePath);
    cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。',
      '--at', '2026-10-10T04:30:00Z']);
    assert.equal(bytes(statePath).toString(), afterAppend.toString(), 'an identical recheck replay is idempotent');

    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '被改写的说明', '--at', '2026-10-10T04:30:00Z']),
      /相同复核身份的内容不同/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Literal-retry idempotency without --at: a same-command retry that omits
// --at must derive the same identity, keep the first write time and stay a
// byte-stable no-op for both record and recheck.
// ---------------------------------------------------------------------------

test('a literal record retry without --at is a byte-stable no-op, with explicit and auto ids', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    const statePath = path.join(dir, 'state.json');

    // Explicit correction id: the same command minus --at replays idempotently.
    recordCorrection(dir, '2026-10-10T02:00:00Z', {}, 'tcorr-explicit');
    const afterFirst = bytes(statePath);
    const recordFile = path.join(dir, 'correction-tcorr-explicit.json');
    const replay = cliJson(['correction-record', '--out', dir, '--record', recordFile,
      '--correction-id', 'tcorr-explicit']);
    assert.equal(replay.saved, true);
    assert.equal(replay.correction.at, '2026-10-10T02:00:00Z', 'the replay keeps the first write time');
    assert.equal(bytes(statePath).toString(), afterFirst.toString(), 'the literal retry must not rewrite the archive');

    // Auto-derived id: the same command without --at or --correction-id must
    // derive a stable identity from the record content alone.
    const autoFile = path.join(dir, 'correction-auto.json');
    writeJson(autoFile, CORRECTION);
    const first = cliJson(['correction-record', '--out', dir, '--record', autoFile, '--at', '2026-10-10T03:00:00Z']);
    const afterAuto = bytes(statePath);
    assert.notEqual(first.correction.id, 'tcorr-explicit');
    const second = cliJson(['correction-record', '--out', dir, '--record', autoFile]);
    assert.equal(second.correction.id, first.correction.id, 'the auto id is stable across literal retries');
    assert.equal(second.correction.at, '2026-10-10T03:00:00Z', 'the auto-id replay keeps the first write time');
    assert.equal(bytes(statePath).toString(), afterAuto.toString(), 'the auto-id retry must not rewrite the archive');
    assert.equal(readCorrections(dir).total, 2, 'no silent duplicate correction was created');
  } finally {
    cleanup(dir);
  }
});

test('a literal recheck retry without --at is a byte-stable no-op and a same-target new note is refused', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    recordCorrection(dir, '2026-10-10T02:00:00Z');
    writeJson(path.join(dir, 'model.json'), correctedModel());
    cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);
    cliJson(['submit', '--out', dir, '--prompt', 'p-tickets',
      '--answer', '技能名加规格即可；拆分与阻塞关系由技能自带流程完成。',
      '--attempt-id', 'att-recheck', '--at', '2026-10-10T04:00:00Z']);
    const statePath = path.join(dir, 'state.json');
    cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。',
      '--at', '2026-10-10T04:30:00Z']);
    const afterFirst = bytes(statePath);

    // Literal retry: the same command without --at or --recheck-id must not
    // append a second recheck for the same attempt.
    const replay = cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。']);
    assert.equal(replay.saved, true);
    assert.equal(bytes(statePath).toString(), afterFirst.toString(), 'the literal recheck retry must not rewrite the archive');
    const view = readCorrections(dir);
    assert.equal(view.corrections[0].rechecks.length, 1, 'no silent duplicate recheck was appended');
    assert.equal(view.corrections[0].rechecks[0].at, '2026-10-10T04:30:00Z', 'the first link time is kept');

    // The same correction+attempt derives one recheck identity: a different
    // note is a conflict requiring an explicit --recheck-id, never a silent
    // second entry.
    assert.match(cliError(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '被改写的说明', '--at', '2026-10-10T05:00:00Z']),
      /相同复核身份的内容不同/);
    assert.equal(bytes(statePath).toString(), afterFirst.toString(), 'the refused rewrite must not touch the archive');
  } finally {
    cleanup(dir);
  }
});

test('replaying the original record after a recheck was appended is refused as moved-on history', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    recordCorrection(dir, '2026-10-10T02:00:00Z');
    writeJson(path.join(dir, 'model.json'), correctedModel());
    cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);
    cliJson(['submit', '--out', dir, '--prompt', 'p-tickets',
      '--answer', '技能名加规格即可；拆分与阻塞关系由技能自带流程完成。',
      '--attempt-id', 'att-recheck', '--at', '2026-10-10T04:00:00Z']);
    cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。',
      '--at', '2026-10-10T04:30:00Z']);
    const statePath = path.join(dir, 'state.json');
    const before = bytes(statePath);
    const recordFile = path.join(dir, 'correction-tcorr-tickets-1.json');
    assert.match(cliError(['correction-record', '--out', dir, '--record', recordFile,
      '--correction-id', 'tcorr-tickets-1', '--at', '2026-10-10T04:30:00Z']),
      /纠错历史不可改写/);
    assert.equal(bytes(statePath).toString(), before.toString(), 'the refused replay must not touch the archive');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Full journey: history preserved, evidence re-check surfaced honestly
// ---------------------------------------------------------------------------

test('the to-tickets mis-teaching case corrects explanation, exercise and records together, keeps the misled answer intact and surfaces the evidence re-check', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    // The tutor recorded a capability gap from the misled answer.
    cliJson(['evidence', '--out', dir, '--concept', 'tickets', '--status', 'needs-work',
      '--note', '把技能自带流程当成必要输入，需要修补。', '--attempt', 'att-misled',
      '--at', '2026-10-10T01:30:00Z']);
    const misledBefore = readJsonFile(path.join(dir, 'state.json')).attempts['p-tickets']
      .find((attempt) => attempt.id === 'att-misled');

    recordCorrection(dir, '2026-10-10T02:00:00Z', {
      impacts: [...CORRECTION.impacts,
        { kind: 'record', id: 'att-misled', note: '该原答受误导，错误归因于教学而非学习者；needs-work 证据需按纠错后内容重核。' }],
    });

    // Before the content update the misled answer is still current content,
    // and the view names the still-valid evidence that must be re-checked.
    let view = readCorrections(dir);
    let recordImpact = view.corrections[0].impacts.find((impact) => impact.kind === 'record');
    assert.equal(recordImpact.status, 'current');
    assert.deepEqual(recordImpact.evidence, [{ bucket: 'conceptEvidence', id: 'tickets', status: 'needs-work', current: true }]);

    // The fix corrects the author content and rebuilds: the misled answer and
    // the needs-work evidence derived from it stop being current evidence.
    writeJson(path.join(dir, 'model.json'), correctedModel());
    cliJson(['build', path.join(dir, 'model.json'), '--out', dir]);
    cliJson(['submit', '--out', dir, '--prompt', 'p-tickets',
      '--answer', '技能名加规格即可；拆分与阻塞关系由技能自带流程完成。',
      '--attempt-id', 'att-recheck', '--at', '2026-10-10T04:00:00Z']);
    cliJson(['correction-record', '--out', dir, '--correction-id', 'tcorr-tickets-1',
      '--recheck-attempt', 'att-recheck', '--recheck-note', '纠错后独立作答，正确说明最小请求。',
      '--at', '2026-10-10T04:30:00Z']);

    view = readCorrections(dir);
    const correction = view.corrections[0];
    assert.equal(correction.impacts.length, 3, 'all three affected categories stay in the record');
    recordImpact = correction.impacts.find((impact) => impact.kind === 'record');
    assert.equal(recordImpact.status, 'stale', 'the misled answer is no longer current-content evidence');
    assert.deepEqual(recordImpact.evidence, [{ bucket: 'conceptEvidence', id: 'tickets', status: 'needs-work', current: false }],
      'the stale evidence citation is displayed honestly as no longer applicable');
    assert.equal(correction.impacts.find((impact) => impact.kind === 'explanation').status, 'current');
    assert.equal(correction.rechecks[0].attemptStatus, 'current');

    // The misled answer keeps its original text, time, attribution and
    // assistance bit: the correction appended history, it never rewrote it.
    const misledAfter = readJsonFile(path.join(dir, 'state.json')).attempts['p-tickets']
      .find((attempt) => attempt.id === 'att-misled');
    assert.deepEqual(misledAfter, misledBefore);

    // The corrected content is live in the rebuilt product.
    const model = readJsonFile(path.join(dir, 'model.json'));
    assert.match(model.prompts[0].answer, /自带流程/);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('自带流程'), 'the rebuilt page ships the corrected reference answer');
    assert.ok(html.includes('拆分任务与声明阻塞关系是 to-tickets 自带流程'), 'the rebuilt page carries the correction text');
    assert.ok(html.includes('att-misled'), 'the page payload keeps the misled original answer');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Legacy compatibility
// ---------------------------------------------------------------------------

test('an archive without teachingCorrections reads as none, and a malformed bucket is rejected loudly', () => {
  const dir = tmpDir();
  try {
    setup(dir);
    const statePath = path.join(dir, 'state.json');
    const state = readJsonFile(statePath);
    delete state.teachingCorrections;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const empty = readCorrections(dir);
    assert.equal(empty.present, false);
    assert.equal(empty.total, 0);

    const malformed = readJsonFile(statePath);
    malformed.teachingCorrections = ['not-an-object'];
    fs.writeFileSync(statePath, JSON.stringify(malformed, null, 2), 'utf8');
    assert.match(cliError(['correction-read', '--out', dir]), /teachingCorrections 必须是对象/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Handoff: CLI import merges, divergence reports, HTTP import drops
// ---------------------------------------------------------------------------

test('CLI export/import carries the correction across archives; a divergent same-id record keeps the current one and is reported', () => {
  const dir = tmpDir();
  const other = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    recordCorrection(dir, '2026-10-10T02:00:00Z');
    cliJson(['export', '--out', dir, '--to', path.join(dir, 'export.json')]);

    // A second archive on the same model imports the exported correction.
    writeJson(path.join(other, 'model.json'), rawModel());
    cliJson(['build', path.join(other, 'model.json'), '--out', other]);
    const imported = cliJson(['import', '--out', other, '--state', path.join(dir, 'export.json')]);
    assert.ok(imported, 'import succeeds');
    const otherView = readCorrections(other);
    assert.equal(otherView.total, 1, 'the trusted CLI import adopts the correction');
    assert.equal(otherView.corrections[0].id, 'tcorr-tickets-1');
    assert.equal(otherView.corrections[0].basis, CORRECTION.basis);

    // A divergent same-id correction keeps the current record and reports.
    // The divergence is hand-crafted in an exported file: same correction id,
    // different content, merged back into the archive that owns the original.
    const export2 = path.join(dir, 'export-divergent.json');
    const exported = readJsonFile(path.join(dir, 'export.json'));
    exported.teachingCorrections['tcorr-tickets-1'].correction = '另一版解释';
    writeJson(export2, exported);
    cliJson(['import', '--out', dir, '--state', export2]);
    const dirState = readJsonFile(path.join(dir, 'state.json'));
    const correctionConflicts = (dirState.conflicts ?? []).filter((conflict) =>
      conflict.kind === 'teaching-correction' && conflict.id === 'tcorr-tickets-1');
    assert.ok(correctionConflicts.length >= 1, 'the divergence is reported as a teaching-correction conflict');
    const dirView = readCorrections(dir);
    assert.equal(dirView.total, 1, 'the current correction survives');
    assert.equal(dirView.corrections[0].correction, CORRECTION.correction, 'the current text is kept, not rewritten');
  } finally {
    cleanup(dir);
    cleanup(other);
  }
});

test('the HTTP import route never adopts teaching corrections from a browser payload', async () => {
  const dir = tmpDir();
  try {
    setup(dir);
    submitMisledAnswer(dir, 'att-misled', '2026-10-10T01:00:00Z');
    recordCorrection(dir, '2026-10-10T02:00:00Z');
    const state = readJsonFile(path.join(dir, 'state.json'));
    const forged = structuredClone(state);
    forged.teachingCorrections = {
      ...forged.teachingCorrections,
      'tcorr-forged': {
        id: 'tcorr-forged', at: '2026-10-10T09:00:00Z', source: 'cli',
        claim: '伪造的先前讲解', correction: '伪造的解释', basis: '伪造的依据',
        impacts: [], noImpactReason: '伪造', rechecks: [],
      },
    };

    const started = await startServer({ dir, port: 0 });
    try {
      const response = await fetch(`${started.url}/api/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelFingerprint: state.modelFingerprint, revision: state.revision, state: forged }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const ids = Object.keys(body.state.teachingCorrections ?? {});
      assert.deepEqual(ids, ['tcorr-tickets-1'], 'the forged correction is dropped, the real one kept');

      // A fresh read of the served state shows the same protected history.
      const fresh = await (await fetch(`${started.url}/api/state`)).json();
      assert.deepEqual(Object.keys(fresh.state.teachingCorrections ?? {}), ['tcorr-tickets-1']);
    } finally {
      await started.close();
    }
  } finally {
    cleanup(dir);
  }
});
