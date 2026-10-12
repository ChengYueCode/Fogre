// Task06 resume-readback tests. Every model, learner answer, correction and
// goal here is a SYNTHETIC fixture authored for this test; none of it is real
// learner data. All assertions drive the real public CLI (`resume-read` and
// the round/submission commands) against a throwaway output directory, so the
// unified readback is verified exactly at the boundary a new session uses.
//
// Run: node --test tests/resume-readback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJson } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// A small synthetic two-concept model with one explain prompt per concept and
// one apply prompt, so a round can diagnose, answer, pause and resume.
function rawModel() {
  return {
    schemaVersion: 1,
    id: 'synthetic-resume',
    title: '合成恢复材料',
    goal: '能解释并应用合成概念。',
    summary: '合成测试材料，不代表真实课程或学习者。',
    sources: [{ id: 'src-note', title: '合成说明', kind: 'provided', note: '合成材料', url: '' }],
    concepts: [
      { id: 'root', title: '合成主题', parentId: null, difficulty: 1, explanation: '组织两个概念。' },
      { id: 'alpha', title: '概念甲', parentId: 'root', difficulty: 1, explanation: '概念甲的解释。' },
      { id: 'beta', title: '概念乙', parentId: 'root', difficulty: 2, explanation: '概念乙的解释。' },
    ],
    relations: [
      { id: 'rel-1', from: 'alpha', to: 'beta', type: 'prerequisite' },
    ],
    prompts: [
      { id: 'p-alpha', conceptId: 'alpha', kind: 'explain', question: '解释概念甲。', answer: '概念甲的参考解释。', criteria: ['提到核心机制'] },
      { id: 'p-beta', conceptId: 'beta', kind: 'apply', question: '把概念乙应用到一个新例子。', answer: '应用步骤的参考。', criteria: ['步骤完整', '说明核对方式'] },
    ],
  };
}

// Standard fixture: build the model, open a learn-new-topic round with a full
// profile, submit the real diagnostic answer, confirm the diagnosis, answer one
// task with starter assistance, record one correction, then pause.
function fixture(t, { track = true } = {}) {
  const out = tmpDir('ember-resume-read-');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const modelFile = path.join(out, 'model-src.json');
  writeJson(modelFile, rawModel());
  cliJson(['build', modelFile, '--out', out]);
  const model = parseJson(fs.readFileSync(path.join(out, 'model.json'), 'utf8'), 'model.json');
  const openingFile = path.join(out, 'opening.json');
  writeJson(openingFile, {
    learner: {
      role: '后端工程师', task: '把合成概念用于自己的服务',
      background: '会命令行，没有学习过该主题', preference: '完整演示后自己尝试',
      sourceNote: '隔离测试样本，学习者本轮陈述', skipped: false, temporaryApproach: null,
    },
    interactionLimit: 6,
  });
  const at = (hh, mm, half = false) => `2026-10-10T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${half ? '30' : '00'}Z`;
  cliJson(['round', '--out', out, '--action', 'create', '--at', at(9, 0), '--entry', 'learn-new-topic',
    '--round-id', 'r1', '--goal', '能解释概念甲并应用概念乙', '--concept', 'alpha', '--concept', 'beta',
    '--opening', openingFile, ...(track ? ['--track-progress'] : [])]);
  cliJson(['submit', '--out', out, '--at', at(9, 5), '--prompt', 'p-alpha', '--answer', '我理解的诊断回答：概念甲的核心是组织信息。',
    '--round-id', 'r1']);
  // One real recorded user response (the diagnostic reply), as progress does.
  const eventFile = path.join(out, 'event.json');
  writeJson(eventFile, { id: 'u1', kind: 'answer', text: '这是我对诊断的真实回答', sourceNote: '隔离教学样本第 1 条用户消息' });
  cliJson(['round', '--out', out, '--action', 'progress-event', '--at', at(9, 5, true), '--record', eventFile]);
  cliJson(['round', '--out', out, '--action', 'confirm-diagnosis', '--at', at(9, 6)]);
  const view = cliJson(['round-read', '--out', out]).round;
  const starterSession = 'sess-resume-starter';
  cliJson(['practice', '--out', out, '--at', at(9, 8), '--prompt', view.currentTaskId ? promptOf(view) : 'p-beta',
    '--session-id', starterSession, '--round-id', 'r1', '--assistance', 'starter']);
  return { out, model, at, view, starterSession };}

function promptOf(roundView) {
  const task = roundView.tasks.find((task) => task.id === roundView.currentTaskId);
  return task ? task.promptId : null;
}

function pauseRound(out, at) {
  cliJson(['round', '--out', out, '--action', 'pause', '--at', at]);
}

test('暂停后 resume-read 统一读回画像、目标预算、位置、互动、原答、缺口与纠错', (t) => {
  const { out, model, at, view } = fixture(t);
  // One real assisted answer on the current task, a needs-work review over it,
  // one teaching correction, then pause.
  const taskPrompt = promptOf(view);
  const answerText = '我把概念乙用在自己的例子上：先列步骤再核对。';
  const submitted = cliJson(['submit', '--out', out, '--at', at(9, 10), '--prompt', taskPrompt, '--answer', answerText,
    '--round-id', 'r1', '--task-id', view.currentTaskId, '--session-id', 'sess-resume-starter']);
  cliJson(['evidence', '--out', out, '--at', at(9, 11), '--status', 'needs-work',
    '--note', '复核发现解释仍缺关键步骤，先补解释再应用', '--concept', 'alpha', '--attempt', submitted.attempt.id]);
  cliJson(['correction-record', '--out', out, '--at', at(9, 11), '--correction-id', 'tcorr-resume-1', '--record', recordFile(out, {
    claim: '先前把概念甲讲成不需要前置。',
    correction: '概念甲是概念乙的前置，先解释概念甲再进入应用。',
    basis: '回读合成说明「依赖」一节：概念乙建立在概念甲之上。',
    sourceId: 'src-note',
    impacts: [{ kind: 'explanation', id: 'beta', note: '更正概念乙的解释顺序' }],
  })]);
  pauseRound(out, at(9, 12));

  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.readOnly, true);
  assert.equal(read.identity.modelId, 'synthetic-resume');
  assert.equal(read.identity.modelTitle, '合成恢复材料');
  assert.ok(read.identity.modelFingerprint);

  // Same learning identity across a brand-new CLI process (this read is one).
  const reread = cliJson(['resume-read', '--out', out]);
  assert.deepEqual(reread.identity, read.identity);

  assert.equal(read.activeRoundId, 'r1');
  assert.deepEqual(read.rounds.map((r) => r.id), ['r1']);
  assert.equal(read.round.id, 'r1');
  assert.equal(read.round.status, 'paused');
  assert.equal(read.round.goal, '能解释概念甲并应用概念乙');
  assert.equal(read.round.budgetMinutes, null);

  // Profile: full saved profile read back verbatim, nothing unknown.
  assert.equal(read.profile.present, true);
  assert.equal(read.profile.learner.role, '后端工程师');
  assert.equal(read.profile.learner.preference, '完整演示后自己尝试');
  assert.deepEqual(read.profile.unknownFields, []);
  assert.equal(read.profile.interactionLimit, 6);

  // Goal & budget with calibration scopes and their staleness.
  assert.equal(read.goalAndBudget.present, true);
  assert.equal(read.goalAndBudget.goal, '能解释概念甲并应用概念乙');
  const calibrated = read.goalAndBudget.scopes.find((scope) => scope.key === 'calibrated');
  assert.ok(calibrated, '诊断确认后应有校准范围');
  assert.equal(calibrated.stale, false);

  // Position: paused round surfaces its restored position and next step.
  assert.equal(read.position.present, true);
  assert.equal(read.position.currentTask.id, view.currentTaskId);
  assert.equal(read.position.currentTask.submitted, true);
  assert.ok(Array.isArray(read.position.currentTask.completionCriteria));

  // Interactions: only real user responses counted; total known here.
  assert.equal(read.interactions.present, true);
  assert.equal(read.interactions.totalKnown, true);
  assert.ok(read.interactions.countedInteractions >= 1);
  assert.equal(read.interactions.interactionLimit, 6);

  // Answers: the original assisted answer survives byte-for-byte with its
  // assistance attributes; diagnostic answer is listed too.
  assert.equal(read.answers.present, true);
  const assisted = read.answers.items.find((item) => item.id && item.answer === answerText);
  assert.ok(assisted, '原答应完整保留');
  assert.equal(assisted.assisted, true);
  assert.deepEqual(assisted.assistanceSources, ['starter']);
  assert.equal(assisted.active, true);
  assert.ok(read.answers.items.some((item) => item.answer.startsWith('我理解的诊断回答')));
  assert.equal(read.answers.unattributed.count, 0);

  // Gaps: the needs-work review over the current answer is still-valid gap
  // evidence, so the readback names it instead of reading mastery as passed.
  assert.equal(read.gaps.present, true);
  assert.ok(read.gaps.needsWorkConcepts.some((entry) => entry.conceptId === 'alpha'),
    '仍有效的 needs-work 证据必须列为当前缺口');
  assert.ok(Array.isArray(read.gaps.dueNow));

  // Material scope: no quality record was written, and the readback says so
  // instead of implying the material was checked.
  assert.equal(read.materialScope.present, false);

  // Corrections: the recorded correction is readable with its current basis.
  assert.equal(read.corrections.present, true);
  assert.equal(read.corrections.total, 1);
  assert.equal(read.corrections.items[0].id, 'tcorr-resume-1');
  assert.equal(read.corrections.items[0].invalidatedEvidence, 0);

  // Nothing changed between save and read: no fabricated drift.
  assert.equal(read.changes.detected, false);

  // Persistence honesty: the note names the unexported-cache boundary.
  assert.ok(read.persistence.note.includes('缓存'));
  assert.ok(read.persistence.note.includes('导出'));

  // Read-only: resume-read must not touch the archive.
  const stateBefore = fs.readFileSync(path.join(out, 'state.json'), 'utf8');
  cliJson(['resume-read', '--out', out]);
  assert.equal(fs.readFileSync(path.join(out, 'state.json'), 'utf8'), stateBefore);
});

function recordFile(out, record) {
  const file = path.join(out, `record-${record.id}.json`);
  writeJson(file, record);
  return file;
}

test('旧档与缺省目录：缺什么如实标 unknown，不补造画像、计数或材料范围', (t) => {
  const out = tmpDir('ember-resume-old-');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const modelFile = path.join(out, 'model-src.json');
  writeJson(modelFile, rawModel());
  cliJson(['build', modelFile, '--out', out]);

  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.readOnly, true);
  assert.equal(read.identity.modelId, 'synthetic-resume');
  assert.equal(read.roundPresent, false);
  assert.equal(read.round, null);
  assert.deepEqual(read.rounds, []);
  assert.equal(read.profile.present, false);
  assert.equal(read.goalAndBudget.present, false);
  assert.equal(read.position.present, false);
  assert.equal(read.interactions.present, false);
  assert.equal(read.answers.present, false);
  assert.equal(read.gaps.present, false);
  assert.equal(read.materialScope.present, false);
  assert.equal(read.corrections.present, false);
  assert.equal(read.changes.detected, false);
  // No fabricated numbers anywhere in the readback.
  assert.equal(JSON.stringify(read).includes('"totalInteractions":0'), false);
});

test('无归属作答单独列出，不并入恢复轮次', (t) => {
  const { out, at } = fixture(t);
  cliJson(['submit', '--out', out, '--at', at(9, 20), '--prompt', 'p-alpha', '--answer', '没有绑定轮次的自由作答。']);
  pauseRound(out, at(9, 21));
  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.answers.unattributed.count, 1);
  assert.equal(read.answers.unattributed.ids.length, 1);
  assert.equal(read.answers.items.some((item) => item.answer === '没有绑定轮次的自由作答。'), false,
    '无归属作答不能冒充本轮作答');
});

test('恢复前目标变化：changes 列出受影响范围，历史与画像保留', (t) => {
  const { out, at, view } = fixture(t);
  pauseRound(out, at(9, 12));
  const before = cliJson(['resume-read', '--out', out]);
  assert.equal(before.changes.detected, false);

  cliJson(['round', '--out', out, '--action', 'update', '--at', at(9, 30), '--goal', '改为只应用概念乙']);
  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.changes.detected, true);
  assert.ok(read.changes.goalChanged.detected, '目标变化必须被指出');
  assert.ok(read.changes.goalChanged.scopes.length >= 1);
  // The saved profile and history stay untouched; nothing was rewritten.
  assert.equal(read.profile.learner.role, '后端工程师');
  assert.equal(read.round.goal, '改为只应用概念乙');
  // The saved pre-diagnosis scope keeps the original goal (history is kept)
  // and now reads stale against it; the calibrated scope is rebuilt for the
  // current goal by the existing update path.
  const preliminary = read.goalAndBudget.scopes.find((scope) => scope.key === 'preliminary');
  assert.equal(preliminary.stale, true, '旧初步范围对新目标必须标 stale');
  assert.ok(read.changes.goalChanged.scopes.some((scope) => scope.where === 'opening.preliminary'),
    '目标变化必须列出保存值与当前值的差异');
  const calibrated = read.goalAndBudget.scopes.find((scope) => scope.key === 'calibrated');
  assert.equal(calibrated.stale, false);
  assert.equal(read.changes.note.includes('历史'), true);
  // Answers and position survive the goal edit.
  assert.equal(read.position.currentTask.id, view.currentTaskId);
});

test('恢复前材料变化：失效证据、旧作答与材料地图如实标 stale', (t) => {
  const { out, at, view } = fixture(t);
  // Author-side quality record with a material map, written before the change.
  cliJson(['quality-template', '--out', out, '--to', path.join(out, 'quality-draft.json')]);
  const draft = parseJson(fs.readFileSync(path.join(out, 'quality-draft.json'), 'utf8'), 'quality-draft');
  const DIMENSIONS = ['goal-coverage', 'prerequisite', 'explanation-example', 'boundary-misconception', 'task-criteria', 'sources-gaps'];
  for (const goal of draft.goals) {
    goal.concepts.forEach((concept) => {
      concept.role = concept.id === 'root' ? 'structural' : 'core';
      if (concept.role === 'core') {
        concept.dimensions = DIMENSIONS.map((id) => ({ id, result: 'covered', basis: '回读合成说明并核对。' }));
      }
    });
  }
  writeJson(path.join(out, 'quality-draft.json'), draft);
  cliJson(['quality-write', '--out', out, '--quality', path.join(out, 'quality-draft.json')]);

  // A correction plus a real assessed answer exist before the material change.
  cliJson(['correction-record', '--out', out, '--at', at(9, 11), '--correction-id', 'tcorr-resume-2', '--record', recordFile(out, {
    claim: '先前把概念乙的应用讲成无需核对。',
    correction: '应用后必须按判定标准核对结果。',
    basis: '回读合成说明「核对」一节。',
    sourceId: 'src-note',
    impacts: [{ kind: 'exercise', id: 'p-beta', note: '更正练习判定说明' }],
  })]);
  const taskPrompt = promptOf(view);
  cliJson(['submit', '--out', out, '--at', at(9, 10), '--prompt', taskPrompt, '--answer', '材料变化前的原答。',
    '--round-id', 'r1', '--task-id', view.currentTaskId]);
  pauseRound(out, at(9, 12));

  // The material changes under the paused round: the answered prompt and its
  // concept are rewritten, so the saved answer and route drift from content.
  const changed = rawModel();
  changed.prompts[0].answer = '改写后的参考答案。';
  changed.concepts[1].explanation = '概念甲改写后的解释。';
  const changedFile = path.join(out, 'model-changed.json');
  writeJson(changedFile, changed);
  cliJson(['build', changedFile, '--out', out]);

  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.changes.detected, true);
  assert.equal(read.changes.contentChanged.detected, true);
  // Build reconciles route tasks to the new content, so the drift shows as
  // stale submissions and/or affected tasks; either way it is named here.
  assert.ok(read.changes.contentChanged.affectedTasks.includes(view.currentTaskId)
    || read.changes.contentChanged.staleSubmissions >= 1,
    '内容更新的任务或旧提交必须列入受影响范围');
  assert.ok(read.changes.contentChanged.scopes.length >= 1, '保存的范围快照指纹差异必须列出');
  const moved = read.answers.items.find((item) => item.answer === '材料变化前的原答。');
  assert.ok(moved, '原答仍保留');
  assert.equal(moved.active, false, '旧指纹作答应如实标为不再当前');
  assert.equal(read.materialScope.present, true);
  assert.equal(read.materialScope.stale, true, '内容变化后旧质检范围必须标 stale');
  assert.ok(read.materialScope.staleReasons.length > 0);
  assert.equal(read.corrections.items[0].id, 'tcorr-resume-2');
});

test('无画像轮次（整理材料入口）改目标也能经历史检出变化', (t) => {
  const out = tmpDir('ember-resume-noopen-');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const modelFile = path.join(out, 'model-src.json');
  writeJson(modelFile, rawModel());
  cliJson(['build', modelFile, '--out', out]);
  // organize-existing-material without --opening: no opening snapshot exists.
  cliJson(['round', '--out', out, '--action', 'create', '--at', '2026-10-10T09:00:00Z', '--entry', 'organize-existing-material',
    '--round-id', 'r-org', '--goal', '最初的整理目标', '--concept', 'alpha']);
  pauseRound(out, '2026-10-10T09:10:00Z');
  const before = cliJson(['resume-read', '--out', out]);
  assert.equal(before.profile.present, false, '无画像轮次如实报告画像未知');
  assert.equal(before.changes.detected, false);
  cliJson(['round', '--out', out, '--action', 'update', '--at', '2026-10-10T09:20:00Z', '--goal', '改动后的目标']);
  const read = cliJson(['resume-read', '--out', out]);
  assert.equal(read.changes.detected, true);
  assert.ok(read.changes.goalChanged.scopes.some((scope) => scope.where.startsWith('history[')),
    '无快照时目标变化必须经轮次历史检出');
  assert.equal(read.profile.present, false, '目标变化不补造画像');
});

test('--round-id 读取指定轮次；未知轮次报错', (t) => {
  const { out, at } = fixture(t);
  const openingFile = path.join(out, 'opening-2.json');
  writeJson(openingFile, {
    learner: { role: null, task: null, background: null, preference: null, sourceNote: '跳过画像', skipped: true, temporaryApproach: '按表现调整' },
  });
  cliJson(['round', '--out', out, '--action', 'create', '--at', at(10, 0), '--entry', 'organize-existing-material',
    '--round-id', 'r2', '--goal', '整理第二个目标', '--concept', 'alpha', '--opening', openingFile]);
  pauseRound(out, at(10, 1));

  const read = cliJson(['resume-read', '--out', out, '--round-id', 'r1']);
  assert.equal(read.round.id, 'r1');
  assert.equal(read.requestedRoundId, 'r1');
  assert.deepEqual(read.rounds.map((r) => r.id), ['r1', 'r2']);
  const other = cliJson(['resume-read', '--out', out, '--round-id', 'r2']);
  assert.equal(other.round.id, 'r2');
  assert.equal(other.profile.present, true);
  assert.equal(other.profile.learner.skipped, true);
  cliError(['resume-read', '--out', out, '--round-id', 'nope']);
});

test('导出导入交接后新目录可统一读回，未导出的独立缓存不被宣称可读', (t) => {
  const { out, at, view } = fixture(t);
  const taskPrompt = promptOf(view);
  cliJson(['submit', '--out', out, '--at', at(9, 10), '--prompt', taskPrompt, '--answer', '导出前保存的原答。',
    '--round-id', 'r1', '--task-id', view.currentTaskId]);
  pauseRound(out, at(9, 12));
  cliJson(['export', '--out', out, '--to', path.join(out, 'handoff-state.json')]);

  // A brand-new directory (new session) that only received the export.
  const fresh = tmpDir('ember-resume-handoff-');
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  const modelFile = path.join(fresh, 'model-src.json');
  writeJson(modelFile, rawModel());
  cliJson(['build', modelFile, '--out', fresh]);
  cliJson(['import', '--out', fresh, '--state', path.join(out, 'handoff-state.json')]);

  const read = cliJson(['resume-read', '--out', fresh]);
  assert.equal(read.roundPresent, true);
  assert.equal(read.round.id, 'r1');
  assert.equal(read.round.status, 'paused');
  assert.equal(read.profile.learner.role, '后端工程师');
  assert.ok(read.answers.items.some((item) => item.answer === '导出前保存的原答。'));
  // The readback still says plainly that a page cache outside this archive is
  // not visible here.
  assert.ok(read.persistence.note.includes('导出'));
});
