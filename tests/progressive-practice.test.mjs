// Task09 progressive-practice backend regressions.
//
// These exercise the public behavior of ticket 09 on the backend: optional
// teaching metadata, the pure `roundPracticeSelection` used by both the CLI and
// the page, the author judgement basis on route tasks, the read-only
// `practice-plan`, and the step-hint level on practice sessions. Fixtures live
// in this file's own TEMP directories.
//
// Run: node --test tests/progressive-practice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelToJson, normalizeModel } from '../skill/forge/scripts/lib/model.mjs';
import { roundPracticeSelection } from '../skill/forge/scripts/lib/round.mjs';
import {
  applyAssessment,
  applyCorrection,
  applyLearningRound,
  applySubmission,
  applyTutorAssessment,
  applyTutorEvidence,
  createState,
  normalizeState,
  practiceSelection,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, sha256, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');
const AT = (hour) => `2026-10-09T0${hour}:00:00Z`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-progressive-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `expected success for ${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

function buildDir(model) {
  const dir = tmpDir();
  atomicWrite(path.join(dir, 'source.json'), stableStringify(modelToJson(model)));
  buildArtifacts({ modelPath: path.join(dir, 'source.json'), outDir: dir, viewerPath: VIEWER });
  return dir;
}

function readBuiltState(dir) {
  return readJson(path.join(dir, 'state.json'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// A model with one learning concept and three author questions that each opt
// into a distinct teaching purpose. The prompts are identical to `legacyModel`
// apart from the optional `teaching` metadata, so a fingerprint comparison is
// meaningful.
function teachingPrompts() {
  return [
    {
      id: 'p-explain', conceptId: 'condition', kind: 'explain',
      question: '为什么要限制分母？', answer: '分母是条件内集合。', criteria: ['明确条件集合'],
      teaching: {
        purpose: 'explanation', objective: '解释条件限制分母', prerequisites: ['root'],
        misconceptions: ['把全集当分母'],
        hints: ['先说清给定条件', '圈出满足条件的集合', '在这个集合内计算成功比例'],
      },
    },
    {
      id: 'p-variation', conceptId: 'condition', kind: 'compare',
      question: '比较红牌红桃与全集红桃的概率。', answer: '13/26 与 13/52，分母不同。', criteria: ['两种分母', '解释条件改变'],
      teaching: {
        purpose: 'variation', objective: '辨认分母变化', prerequisites: ['root'],
        misconceptions: ['混用分母'],
        hints: ['分别限定两个集合'],
      },
    },
    {
      id: 'p-transfer', conceptId: 'condition', kind: 'apply',
      question: '已知是黑牌，黑桃概率？', answer: '13/26=1/2。', criteria: ['明确黑牌分母26', '结果1/2'],
      teaching: {
        purpose: 'transfer', objective: '迁移条件计数', prerequisites: ['root'],
        misconceptions: ['用52作分母'],
        hints: ['数黑牌'],
      },
    },
  ];
}

function rawModel(prompts, conceptExplanation = '条件限定可选集合。') {
  return {
    schemaVersion: 1,
    id: 'progressive-model',
    title: '递进练习主题',
    goal: '解释条件范围并迁移到不同条件',
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: '根解释' },
      { id: 'condition', title: '条件集合', parentId: 'root', difficulty: 1, explanation: conceptExplanation, example: '红牌中的红桃为13/26。', misconception: '分母误用全集。' },
    ],
    relations: [],
    prompts,
    sources: [{ id: 'synthetic', title: '合成测试材料' }],
  };
}

function teachingModel() {
  return normalizeModel(rawModel(teachingPrompts()));
}

function changedConceptModel() {
  return normalizeModel(rawModel(teachingPrompts(), '条件限定可选集合（说明已更新）。'));
}

function legacyModel() {
  return normalizeModel(rawModel(teachingPrompts().map(({ teaching, ...rest }) => rest)));
}

function freshState(model) {
  return createState(model, AT(0));
}

function submitAt(state, model, promptId, attemptId, answer, at, extra = {}) {
  return applySubmission(state, model, { promptId, attemptId, answer, sessionId: null, ...extra }, at).state;
}

function tutorAt(state, model, promptId, attemptId, rating, at, extra = {}) {
  return applyTutorAssessment(state, model, {
    promptId, attemptId, rating, note: '合成核对依据', assessmentId: `tutor-${attemptId}-${rating}`, ...extra,
  }, at).state;
}

function selectionOf(state, model, conceptId = 'condition') {
  const choice = roundPracticeSelection(state, model, conceptId);
  return { promptId: choice.promptId, purpose: choice.purpose, basisAttemptId: choice.basisAttemptId };
}

// ---------------------------------------------------------------------------
// Teaching metadata
// ---------------------------------------------------------------------------

test('teaching metadata round-trips and never rewrites a legacy fingerprint', () => {
  const legacy = legacyModel();
  // The pre-teaching fingerprint formula, with no `teaching` key at all.
  const expected = sha256(stableStringify({
    conceptId: 'condition', kind: 'explain', question: '为什么要限制分母？',
    answer: '分母是条件内集合。', criteria: ['明确条件集合'], concept: legacy.conceptFingerprints.condition,
  }));
  assert.equal(legacy.promptFingerprints['p-explain'], expected, 'an absent teaching field leaves the old fingerprint intact');

  const legacyJson = modelToJson(legacy);
  assert.equal('teaching' in legacyJson.prompts[0], false, 'an absent optional field is not serialized');
  const legacyRoundTrip = normalizeModel(cloneJson(legacyJson));
  assert.equal(legacyRoundTrip.promptFingerprints['p-explain'], expected, 'legacy round-trip is a fixed point');
  assert.deepEqual(modelToJson(legacyRoundTrip), legacyJson);

  const teaching = teachingModel();
  assert.notEqual(teaching.promptFingerprints['p-explain'], expected, 'teaching metadata participates in the content fingerprint');
  const teachingJson = modelToJson(teaching);
  assert.deepEqual(teachingJson.prompts[0].teaching, {
    purpose: 'explanation',
    objective: '解释条件限制分母',
    prerequisites: ['root'],
    misconceptions: ['把全集当分母'],
    hints: ['先说清给定条件', '圈出满足条件的集合', '在这个集合内计算成功比例'],
  });
  assert.equal(normalizeModel(cloneJson(teachingJson)).promptFingerprints['p-explain'], teaching.promptFingerprints['p-explain'], 'teaching round-trips');
});

test('malformed teaching metadata is rejected with a structured code', () => {
  const base = teachingPrompts();
  const cases = [
    ['unknown purpose', { ...base[0], teaching: { ...base[0].teaching, purpose: 'mastery' } }],
    ['unknown prerequisite', { ...base[0], teaching: { ...base[0].teaching, prerequisites: ['ghost'] } }],
    ['duplicate prerequisite', { ...base[0], teaching: { ...base[0].teaching, prerequisites: ['root', 'root'] } }],
    ['empty hints', { ...base[0], teaching: { ...base[0].teaching, hints: [] } }],
    ['blank objective', { ...base[0], teaching: { ...base[0].teaching, objective: '   ' } }],
    ['non-string misconception', { ...base[0], teaching: { ...base[0].teaching, misconceptions: [3] } }],
  ];
  for (const [label, prompt] of cases) {
    assert.throws(() => normalizeModel(rawModel([prompt])), (err) => err.code === 'E_PROMPT', label);
  }
});

// ---------------------------------------------------------------------------
// Selection soundness
// ---------------------------------------------------------------------------

test('selection moves up only on a current independent original tutor success', () => {
  const model = teachingModel();
  const base = freshState(model);
  assert.deepEqual(selectionOf(base, model), { promptId: 'p-explain', purpose: 'explanation', basisAttemptId: null });

  // A self-assessment is not a tutor judgement.
  let self = submitAt(base, model, 'p-explain', 'a-self', '合成原答：分母是条件内集合。', AT(1));
  self = applyAssessment(self, model, { promptId: 'p-explain', attemptId: 'a-self', rating: 'good' }, AT(2)).state;
  assert.equal(selectionOf(self, model).purpose, 'explanation');

  // An assisted positive judgement cannot stand as independence.
  let assisted = submitAt(base, model, 'p-explain', 'a-assisted', '合成原答：看了提示后作答。', AT(1), { assistance: ['hint'] });
  assisted = tutorAt(assisted, model, 'p-explain', 'a-assisted', 'good', AT(2));
  assert.equal(selectionOf(assisted, model).purpose, 'explanation');

  // hard/again asks for explanation.
  let hard = submitAt(base, model, 'p-explain', 'a-hard', '合成原答：还需要补漏。', AT(1));
  hard = tutorAt(hard, model, 'p-explain', 'a-hard', 'hard', AT(2));
  assert.equal(selectionOf(hard, model).purpose, 'explanation');

  // A tutor credit aimed at a correction is not a success for the original.
  let corrected = submitAt(base, model, 'p-explain', 'a-corrected', '合成原答：第一次不完整。', AT(1));
  corrected = applyCorrection(corrected, model, { promptId: 'p-explain', attemptId: 'a-corrected', correctionId: 'c1', text: '补充后的修正。' }, '2026-10-09T01:30:00Z').state;
  corrected = tutorAt(corrected, model, 'p-explain', 'a-corrected', 'good', AT(2), { targetCorrectionId: 'c1' });
  assert.equal(selectionOf(corrected, model).purpose, 'explanation');

  // A stale attempt (content changed) no longer counts.
  let good = submitAt(base, model, 'p-explain', 'a-good', '合成原答：条件限定分母为26张红牌。', AT(1));
  good = tutorAt(good, model, 'p-explain', 'a-good', 'good', AT(2));
  assert.equal(selectionOf(good, model).purpose, 'variation');
  assert.equal(selectionOf(good, changedConceptModel()).purpose, 'explanation', 'stale content evidence is not used');

  const choice = roundPracticeSelection(good, model, 'condition');
  assert.equal(choice.promptId, 'p-variation');
  assert.equal(choice.basisAttemptId, 'a-good');
  assert.ok(choice.reason.includes('被导师评为 good'));

  // A later variation success moves to transfer.
  let strong = submitAt(good, model, 'p-variation', 'a-variation', '合成原答：13/26 与 13/52。', AT(3));
  strong = tutorAt(strong, model, 'p-variation', 'a-variation', 'easy', AT(4));
  assert.equal(selectionOf(strong, model).purpose, 'transfer');

  // A missing concept is a structured EmberError, not a raw crash.
  assert.throws(() => practiceSelection(base, model, 'ghost'), (err) => err.code === 'E_STATE');
});

test('concept evidence only progresses from live, tutor-sourced, independent, based answers', () => {
  const model = teachingModel();
  // A current independent answer with no per-attempt tutor rating: only a
  // concept-level tutor record can judge it.
  const base = submitAt(freshState(model), model, 'p-explain', 'e-ok', '合成原答：分母是条件内集合。', AT(1));
  const valid = applyTutorEvidence(base, model, {
    conceptId: 'condition', status: 'explained', note: '合成核对：原答明确条件集合。', attemptIds: ['e-ok'],
  }, AT(2)).state;
  assert.equal(valid.conceptEvidence.condition.reviewer, 'tutor');
  assert.equal(selectionOf(valid, model).purpose, 'variation', 'a live tutor-sourced record progresses');

  const notTutor = cloneJson(valid);
  notTutor.conceptEvidence.condition.reviewer = 'learner';
  assert.equal(selectionOf(notTutor, model).purpose, 'explanation', 'a non-tutor source is ignored');

  const noIds = cloneJson(valid);
  noIds.conceptEvidence.condition.attemptIds = [];
  assert.equal(selectionOf(noIds, model).purpose, 'explanation', 'empty attemptIds cannot support a positive status');

  const ghost = cloneJson(valid);
  ghost.conceptEvidence.condition.attemptIds = ['ghost'];
  assert.equal(selectionOf(ghost, model).purpose, 'explanation', 'a missing referenced attempt is ignored');

  const staleRef = cloneJson(valid);
  staleRef.attempts['p-explain'][0].fingerprint = 'deadbeef';
  assert.equal(selectionOf(staleRef, model).purpose, 'explanation', 'a stale referenced attempt is ignored');

  const assistedRef = cloneJson(valid);
  assistedRef.attempts['p-explain'][0].assisted = true;
  assert.equal(selectionOf(assistedRef, model).purpose, 'explanation', 'an assisted referenced attempt is ignored');

  const staleEvidence = cloneJson(valid);
  staleEvidence.conceptEvidence.condition.conceptFingerprint = 'deadbeef';
  assert.equal(selectionOf(staleEvidence, model).purpose, 'explanation', 'a stale concept fingerprint is ignored');

  const wrongKind = cloneJson(valid);
  wrongKind.conceptEvidence.condition.status = 'applied';
  assert.equal(selectionOf(wrongKind, model).purpose, 'explanation', 'a status not backed by its answer kinds is ignored');
});

test('a late tutor judgement cannot outrank a newer validated answer', () => {
  const model = teachingModel();
  // B is the newer answer; A is older and its judgement arrives last.
  let state = submitAt(freshState(model), model, 'p-explain', 'att-A', '合成原答 A：旧作答。', AT(1));
  state = submitAt(state, model, 'p-explain', 'att-B', '合成原答 B：新作答。', AT(2));
  state = tutorAt(state, model, 'p-explain', 'att-B', 'good', AT(3));
  state = tutorAt(state, model, 'p-explain', 'att-A', 'again', AT(9));
  assert.equal(selectionOf(state, model).purpose, 'variation', 'the newer good answer drives');
  assert.equal(roundPracticeSelection(state, model, 'condition').basisAttemptId, 'att-B');

  // Reverse: A is old and judged good late, B is newer and judged again.
  let reversed = submitAt(freshState(model), model, 'p-explain', 'att-A2', '合成原答 A2：旧作答。', AT(1));
  reversed = submitAt(reversed, model, 'p-explain', 'att-B2', '合成原答 B2：新作答。', AT(2));
  reversed = tutorAt(reversed, model, 'p-explain', 'att-B2', 'again', AT(3));
  reversed = tutorAt(reversed, model, 'p-explain', 'att-A2', 'good', AT(9));
  assert.equal(selectionOf(reversed, model).purpose, 'explanation', 'the newer again answer stays latest despite a later arrival');
});

// ---------------------------------------------------------------------------
// Route tasks and practice-plan
// ---------------------------------------------------------------------------

test('route tasks carry the author judgement basis and an explicit update preserves answered work', () => {
  const model = teachingModel();
  const base = freshState(model);
  const createdState = applyLearningRound(base, model, {
    action: 'create', roundId: 'prog', entry: 'organize-existing-material', goal: '掌握条件', conceptIds: ['condition'],
  }, AT(0)).state;
  const created = createdState.learningRounds.prog;
  const task = created.tasks.find((t) => t.promptId === 'p-explain');
  assert.ok(task, 'the first task reuses the author explanation question');
  assert.equal(task.teachingPurpose, 'explanation');
  // The pre-answer completion standard stays the kind-generic observable goal;
  // the authored rubric must never leak before the learner answers. The real
  // rubric travels separately as `authorCriteria` for the post-submission
  // practice reference.
  assert.deepEqual(task.completionCriteria, [
    '用自己的话解释机制或因果，而不是复述标题',
    '说明关键步骤之间的关系，并给出一个例子',
  ], 'a teaching prompt still shows kind-generic completion criteria, not the author rubric');
  assert.equal(JSON.stringify(task.completionCriteria).includes('明确条件集合'), false, 'the author rubric does not leak into completion criteria');
  assert.deepEqual(task.authorCriteria, ['明确条件集合'], 'the author rubric is kept as separate metadata');

  // The selected explain prompt declares `root` as a teaching prerequisite, so
  // even with no prerequisite relation the route must reach that concept first
  // and the target task must name it.
  assert.deepEqual(created.tasks.map((t) => t.conceptId), ['root', 'condition'], 'the teaching prerequisite precedes its target');
  assert.deepEqual(task.prerequisites, ['root'], 'the target task names its teaching prerequisite');

  // A legacy prompt keeps the kind-derived observable defaults but still lists
  // the author criteria separately.
  const legacy = legacyModel();
  const legacyRound = applyLearningRound(freshState(legacy), legacy, {
    action: 'create', roundId: 'legacy', entry: 'organize-existing-material', goal: '掌握条件', conceptIds: ['condition'],
  }, AT(0)).round;
  const legacyTask = legacyRound.tasks.find((t) => t.promptId === 'p-explain');
  assert.equal(JSON.stringify(legacyTask.completionCriteria).includes('明确条件集合'), false, 'the legacy rubric does not leak into completion criteria');
  assert.deepEqual(legacyTask.authorCriteria, ['明确条件集合']);

  // Independent success, then pause, then an explicit update.
  let state = applySubmission(createdState, model, {
    promptId: 'p-explain', attemptId: 'orig', answer: '合成原答：条件限定分母为26张红牌。', sessionId: null,
    roundId: 'prog', taskId: task.id,
  }, AT(1)).state;
  state = applyTutorAssessment(state, model, { promptId: 'p-explain', attemptId: 'orig', rating: 'good', note: '合成核对依据', assessmentId: 'tutor-orig' }, AT(2)).state;
  const paused = applyLearningRound(state, model, { action: 'pause', roundId: 'prog' }, AT(3)).state;
  assert.equal(paused.learningRounds.prog.status, 'paused');

  const updated = applyLearningRound(paused, model, { action: 'update', roundId: 'prog' }, AT(4)).state;
  const round = updated.learningRounds.prog;
  assert.equal(round.status, 'paused', 'update keeps a paused round paused');
  const active = round.tasks.find((t) => t.conceptId === 'condition');
  assert.equal(active.promptId, 'p-variation', 'the selector moves to variation');
  assert.equal(active.teachingPurpose, 'variation');
  assert.ok(round.archivedTasks.some((t) => t.id === task.id), 'the answered task is archived, not dropped');
  const bound = updated.attempts['p-explain'][0];
  assert.equal(bound.roundId, 'prog');
  assert.equal(bound.taskId, task.id);
  assert.ok(bound.answer.includes('合成'), 'the original answer is preserved');

  const resumed = applyLearningRound(updated, model, { action: 'resume', roundId: 'prog' }, AT(5)).state;
  assert.equal(resumed.learningRounds.prog.status, 'active');
});

test('only the selected prompt teaching prerequisite reaches the route and a budget keeps it', () => {
  // No prerequisite relations at all: the only structural links are the
  // teaching prerequisites of the prompt the selector actually picks.
  const model = normalizeModel({
    schemaVersion: 1, id: 'prereq-model', title: '前置拓扑主题', goal: '掌握条件集合',
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: '根解释' },
      { id: 'foundation', title: '基础', parentId: 'root', difficulty: 1, explanation: '基础解释' },
      { id: 'advanced', title: '进阶', parentId: 'root', difficulty: 1, explanation: '进阶解释' },
      { id: 'condition', title: '条件集合', parentId: 'root', difficulty: 1, explanation: '条件解释' },
    ],
    relations: [],
    prompts: [
      {
        id: 'p-explain', conceptId: 'condition', kind: 'explain', question: '为什么限制分母？',
        answer: '分母是条件内集合。', criteria: ['明确条件集合'],
        teaching: {
          purpose: 'explanation', objective: '解释条件限制分母', prerequisites: ['foundation'],
          misconceptions: ['把全集当分母'], hints: ['先说清给定条件'],
        },
      },
      {
        id: 'p-variation', conceptId: 'condition', kind: 'compare', question: '比较两种分母。',
        answer: '13/26 与 13/52。', criteria: ['两种分母', '解释条件改变'],
        teaching: {
          purpose: 'variation', objective: '辨认分母变化', prerequisites: ['advanced'],
          misconceptions: ['混用分母'], hints: ['分别限定两个集合'],
        },
      },
    ],
    sources: [{ id: 'synthetic', title: '合成测试材料' }],
  });

  const createdState = applyLearningRound(freshState(model), model, {
    action: 'create', roundId: 'pre', entry: 'organize-existing-material',
    goal: '掌握条件', conceptIds: ['condition'], minutes: 8,
  }, AT(0)).state;
  const created = createdState.learningRounds.pre;
  const routeIds = created.tasks.map((t) => t.conceptId);
  assert.deepEqual(routeIds, ['foundation', 'condition'], 'only the selected prompt prerequisite is scheduled ahead of the target');
  assert.equal(routeIds.includes('advanced'), false, 'the future variation prerequisite is not pulled in before it is earned');
  const target = created.tasks.find((t) => t.conceptId === 'condition');
  assert.deepEqual(target.prerequisites, ['foundation']);
  const prereqTask = created.tasks.find((t) => t.conceptId === 'foundation');
  assert.equal(prereqTask.deferred, false, 'a budget never skips an expensive prerequisite');
  assert.equal(target.deferred, true, 'the target defers once the budget is spent');

  // Lift the budget so the deferred target reopens, then earn one independent
  // explanation success: the next selection is variation, whose different
  // prerequisite now — and only now — enters the route.
  const reopened = applyLearningRound(createdState, model, { action: 'update', roundId: 'pre', minutes: 60 }, AT(1)).state;
  const openTarget = reopened.learningRounds.pre.tasks.find((t) => t.conceptId === 'condition');
  assert.equal(openTarget.deferred, false, 'raising the budget reopens the target');
  let earned = applySubmission(reopened, model, {
    promptId: 'p-explain', attemptId: 'att-e', answer: '合成原答：条件限定分母为26。',
    sessionId: null, roundId: 'pre', taskId: openTarget.id,
  }, AT(2)).state;
  earned = applyTutorAssessment(earned, model, {
    promptId: 'p-explain', attemptId: 'att-e', rating: 'good', note: '合成核对依据', assessmentId: 'tutor-e',
  }, AT(3)).state;
  const updated = applyLearningRound(earned, model, { action: 'update', roundId: 'pre' }, AT(4)).state;
  assert.equal(updated.learningRounds.pre.tasks.some((t) => t.conceptId === 'advanced'), true,
    'the earned variation prerequisite is scheduled only after the explanation success');
});

test('practice-plan is read-only and lists selection, basis, judgement and quality boundary', (t) => {
  const dir = buildDir(teachingModel());
  t.after(() => cleanup(dir));
  runJson(['round', '--out', dir, '--action', 'create', '--round-id', 'plan', '--entry', 'organize-existing-material', '--goal', '掌握条件', '--concept', 'condition']);
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const plan = runJson(['practice-plan', '--out', dir, '--round-id', 'plan']);
  assert.equal(plan.present, true);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.targets.length, 1);
  const target = plan.targets[0];
  assert.equal(target.conceptId, 'condition');
  assert.equal(target.selection.promptId, 'p-explain');
  assert.equal(target.selection.purpose, 'explanation');
  assert.ok(target.selection.reason.length > 0);
  assert.deepEqual(target.judgement.criteria, ['明确条件集合']);
  assert.equal(target.judgement.hintCount, 3);
  assert.equal(target.quality.present, false, 'an absent quality record reads as not reviewed');
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'practice-plan never writes');
});

// ---------------------------------------------------------------------------
// Step-hint level
// ---------------------------------------------------------------------------

test('hint level persists, is monotone and bounded, and import keeps the higher level', (t) => {
  const model = teachingModel();
  const dir = buildDir(model);
  t.after(() => cleanup(dir));

  runJson(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--draft', '同稿']);
  assert.equal('hintLevel' in readBuiltState(dir).practiceSessions['sess-h'], false, 'a plain draft keeps the optional field absent');

  runJson(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--hint-level', '1']);
  let session = readBuiltState(dir).practiceSessions['sess-h'];
  assert.equal(session.hintLevel, 1);
  assert.ok(session.assistance.includes('hint'), 'revealing a hint records the assistance fact');

  // Monotone: 1 -> 1 (no-op), 3 -> 2 stays 3.
  runJson(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--hint-level', '1']);
  runJson(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--hint-level', '3']);
  session = readBuiltState(dir).practiceSessions['sess-h'];
  assert.equal(session.hintLevel, 3);
  runJson(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--hint-level', '2']);
  assert.equal(readBuiltState(dir).practiceSessions['sess-h'].hintLevel, 3, 'the level only increases');

  for (const bad of ['4', '-1', '1.5']) {
    const result = runCli(['practice', '--out', dir, '--prompt', 'p-explain', '--session-id', 'sess-h', '--hint-level', bad]);
    assert.equal(result.status, 1, `hint level ${bad} is refused`);
    assert.match(result.stderr, /E_USAGE/);
  }
});

test('import merges the higher hint level', (t) => {
  const model = teachingModel();
  const dirA = buildDir(model);
  const dirB = buildDir(model);
  t.after(() => cleanup(dirA));
  t.after(() => cleanup(dirB));
  runJson(['practice', '--out', dirA, '--prompt', 'p-explain', '--session-id', 'sess-m', '--draft', '同稿']);
  runJson(['practice', '--out', dirA, '--prompt', 'p-explain', '--session-id', 'sess-m', '--hint-level', '1']);
  runJson(['practice', '--out', dirB, '--prompt', 'p-explain', '--session-id', 'sess-m', '--draft', '同稿']);
  runJson(['practice', '--out', dirB, '--prompt', 'p-explain', '--session-id', 'sess-m', '--hint-level', '2']);
  runJson(['import', '--out', dirA, '--state', path.join(dirB, 'state.json')]);
  const merged = readBuiltState(dirA).practiceSessions['sess-m'];
  assert.equal(merged.hintLevel, 2, 'import keeps the higher revealed level');
  assert.ok(merged.assistance.includes('hint'));
});

test('normalizeState rejects malformed hint levels and missing hint assistance', () => {
  const model = teachingModel();
  const session = (extra) => ({
    id: 's', promptId: 'p-explain', conceptId: 'condition',
    fingerprint: model.promptFingerprints['p-explain'], modelFingerprint: model.modelFingerprint, modelRevision: 1,
    createdAt: AT(0), updatedAt: AT(1), source: 'cli', draft: '', assistance: ['hint'], hintLevel: 1,
    ...extra,
  });
  const raw = (value) => ({ schemaVersion: 2, modelId: model.id, modelFingerprint: model.modelFingerprint, practiceSessions: { s: value } });
  const isStateError = (err) => err.code === 'E_STATE' && err.path === 'practiceSessions.s.hintLevel';
  assert.throws(() => normalizeState(raw(session({ hintLevel: -1 })), model), isStateError);
  assert.throws(() => normalizeState(raw(session({ hintLevel: 1.5 })), model), isStateError);
  assert.throws(() => normalizeState(raw(session({ hintLevel: null })), model), isStateError, 'a present null is malformed typed data');
  assert.throws(() => normalizeState(raw(session({ hintLevel: 2, assistance: [] })), model), isStateError, 'a revealed hint must record hint assistance');
  assert.equal(normalizeState(raw(session({ hintLevel: 2 })), model).practiceSessions.s.hintLevel, 2);
  assert.equal('hintLevel' in normalizeState(raw(session({ hintLevel: undefined })), model).practiceSessions.s, false);
});

test('HTTP practice accepts hintLevel and reports malformed values as structured errors', async (t) => {
  const model = teachingModel();
  const dir = buildDir(model);
  t.after(() => cleanup(dir));
  await withServer(dir, async (started) => {
    const current = await (await fetch(`${started.url}/api/state`)).json();
    const ok = await postJson(`${started.url}/api/practice`, {
      promptId: 'p-explain', sessionId: 'sess-http', draft: '', assistance: [], hintLevel: 1,
      modelFingerprint: current.modelFingerprint, revision: current.state.revision,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const saved = ok.json.state.practiceSessions['sess-http'];
    assert.equal(saved.hintLevel, 1);
    assert.ok(saved.assistance.includes('hint'));
    const revision = ok.json.state.revision;

    const tooHigh = await postJson(`${started.url}/api/practice`, {
      promptId: 'p-explain', sessionId: 'sess-http', hintLevel: 99,
      modelFingerprint: current.modelFingerprint, revision,
    });
    assert.equal(tooHigh.status, 400);
    assert.equal(tooHigh.json.code, 'E_USAGE');

    const nullLevel = await postJson(`${started.url}/api/practice`, {
      promptId: 'p-explain', sessionId: 'sess-http', hintLevel: null,
      modelFingerprint: current.modelFingerprint, revision,
    });
    assert.equal(nullLevel.status, 400);
    assert.equal(nullLevel.json.code, 'E_USAGE');

    // A malformed persisted session fails the import with a structured E_STATE,
    // never an unhandled 500.
    const badImport = await postJson(`${started.url}/api/import`, {
      modelFingerprint: current.modelFingerprint, revision,
      state: {
        schemaVersion: 2, modelId: model.id,
        practiceSessions: {
          'sess-bad': {
            id: 'sess-bad', promptId: 'p-explain', conceptId: 'condition',
            fingerprint: model.promptFingerprints['p-explain'], createdAt: AT(0), updatedAt: AT(1),
            source: 'cli', draft: '', assistance: ['hint'], hintLevel: null,
          },
        },
      },
    });
    assert.equal(badImport.status, 400);
    assert.equal(badImport.json.code, 'E_STATE');
  });
});
