import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'skill/forge/scripts/forge.mjs');
function run(args, ok = true) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  if (ok) assert.equal(r.status, 0, r.stderr);
  return ok ? JSON.parse(r.stdout) : r;
}
function fixture(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-opening-test-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  run(['build', path.join(root, 'skill/forge/assets/probability.json'), '--out', out]);
  const model = JSON.parse(fs.readFileSync(path.join(out, 'model.json')));
  const concept = model.prompts[0].conceptId;
  return { out, concept, model };
}
const learner = { role: '运营', task: '选择合适的工具', background: '会用 GitHub，但没有开发经验', preference: '完整演示后尝试', sourceNote: '学习者本轮陈述', skipped: false, temporaryApproach: null };
test('公开开场保存未知项、初步范围与预算；真实诊断后才读到校准路线', t => {
  const { out, concept } = fixture(t);
  const file = path.join(out, 'opening.json');
  fs.writeFileSync(file, JSON.stringify({ learner, interactionLimit: 7 }));
  run(['round', '--out', out, '--action', 'create', '--entry', 'learn-new-topic', '--round-id', 'r1', '--goal', '能解释概率的用途', '--concept', concept, '--opening', file]);
  let view = run(['round-read', '--out', out]).round;
  assert.deepEqual(view.opening.learner, learner);
  assert.equal(view.opening.calibrated, null);
  assert.equal(view.opening.interactionLimit, 7);
  assert.equal(view.budgetMinutes, null);
  assert.ok(view.opening.preliminary.units.length > 0);
  assert.ok(view.opening.preliminary.estimatedMinutes > 0);
  const rejected = run(['round', '--out', out, '--action', 'confirm-diagnosis'], false);
  assert.notEqual(rejected.status, 0);
  const diagnostic = view.tasks.find(x => x.diagnostic);
  run(['submit', '--out', out, '--round-id', 'r1', '--task-id', diagnostic.id, '--prompt', diagnostic.promptId, '--answer', '概率表示某件事情发生的可能性']);
  run(['round', '--out', out, '--action', 'confirm-diagnosis']);
  view = run(['round-read', '--out', out]).round;
  assert.equal(view.opening.calibrated.goal, '能解释概率的用途');
  assert.ok(view.opening.calibrated.units.every(x => x.outcome && x.completionCriteria.length));
  run(['build', path.join(out, 'model.json'), '--out', out]);
  assert.deepEqual(run(['round-read', '--out', out]).round.opening.learner, learner);
});

test('诊断后才补写画像时初步范围保持未知；预算不足的零估计明确解释', t => {
  const { out, concept } = fixture(t);
  run(['round', '--out', out, '--action', 'create', '--entry', 'learn-new-topic', '--round-id', 'late1', '--goal', '能解释概率', '--concept', concept]);
  const diagnostic = run(['round-read', '--out', out]).round.tasks.find(x => x.diagnostic);
  run(['submit', '--out', out, '--round-id', 'late1', '--task-id', diagnostic.id, '--prompt', diagnostic.promptId, '--answer', '概率反映可能性']);
  run(['round', '--out', out, '--action', 'confirm-diagnosis']);
  const file = path.join(out, 'late.json');
  fs.writeFileSync(file, JSON.stringify({ learner }));
  run(['round', '--out', out, '--action', 'update', '--opening', file, '--minutes', '1']);
  const view = run(['round-read', '--out', out]).round;
  assert.equal(view.opening.preliminary, null);
  assert.ok(view.opening.calibrated.units.length);
  assert.equal(view.opening.calibrated.estimatedMinutes, 0);
  assert.match(view.opening.calibrated.estimateBasis, /预算不足.*首个必要单元/);
  assert.equal(view.budgetInsufficient, true);
});

test('画像纠正保留历史；跳过保持未知；上限与估计分离；旧档不补造画像', t => {
  const { out, concept } = fixture(t);
  run(['round', '--out', out, '--action', 'create', '--entry', 'organize-existing-material', '--round-id', 'r2', '--goal', '解释概率的用途', '--concept', concept]);
  assert.equal(run(['round-read', '--out', out]).round.opening, null);
  const file = path.join(out, 'opening.json');
  fs.writeFileSync(file, JSON.stringify({ learner, interactionLimit: 5 }));
  run(['round', '--out', out, '--action', 'update', '--opening', file, '--minutes', '30']);
  const first = run(['round-read', '--out', out]).round;
  assert.equal(first.budgetMinutes, 30);
  assert.notEqual(first.opening.calibrated.estimatedMinutes, first.budgetMinutes);
  const corrected = { ...learner, background: '会看代码，没有独立开发过', sourceNote: '学习者纠正' };
  fs.writeFileSync(file, JSON.stringify({ learner: corrected }));
  run(['round', '--out', out, '--action', 'update', '--opening', file]);
  let opening = run(['round-read', '--out', out]).round.opening;
  assert.deepEqual(opening.history[0].learner, learner);
  assert.equal(opening.interactionLimit, 5);
  assert.equal(opening.learner.background, corrected.background);
  fs.writeFileSync(file, JSON.stringify({ learner: { role: null, task: null, background: null, preference: null, sourceNote: '学习者主动跳过', skipped: true, temporaryApproach: '先完整演示，术语随用途解释' }, interactionLimit: null }));
  run(['round', '--out', out, '--action', 'update', '--opening', file]);
  opening = run(['round-read', '--out', out]).round.opening;
  assert.equal(opening.learner.role, null);
  assert.equal(opening.history.length, 2);
  assert.equal(opening.interactionLimit, null);
  assert.deepEqual(opening.preliminary, first.opening.preliminary);
});

test('非法开场及导入在落盘前拒绝，原档不变', t => {
  const { out, concept } = fixture(t);
  const file = path.join(out, 'opening.json');
  fs.writeFileSync(file, JSON.stringify({ learner }));
  run(['round', '--out', out, '--action', 'create', '--round-id', 'r3', '--entry', 'organize-existing-material', '--goal', '能解释概率', '--concept', concept, '--opening', file]);
  const stateFile = path.join(out, 'state.json');
  const before = fs.readFileSync(stateFile);
  for (const bad of [{ learner: { ...learner, skipped: 'true' } }, { learner, interactionLimit: -1 }, { learner: null }, { calibrated: {} }, { learner: { ...learner, background: null } }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.notEqual(run(['round', '--out', out, '--action', 'update', '--opening', file], false).status, 0);
    assert.deepEqual(fs.readFileSync(stateFile), before);
  }
  const imported = JSON.parse(before);
  imported.learningRounds.r3.opening.calibrated.units = [null];
  fs.writeFileSync(file, JSON.stringify(imported));
  const rejected = run(['import', '--state', file, '--out', out], false);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /E_STATE/);
  assert.deepEqual(fs.readFileSync(stateFile), before);
});

test('HTTP 开场保存、冲突与重启读回使用同一公开合同', async t => {
  const { out, concept } = fixture(t);
  let server = await startServer({ dir: out, port: 0 });
  const post = async (url, body) => fetch(url + '/api/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const initial = await (await fetch(server.url + '/api/state')).json();
    const body = { revision: initial.state.revision, modelFingerprint: initial.modelFingerprint, action: 'create', entry: 'organize-existing-material', roundId: 'http1', goal: '能解释概率', conceptIds: [concept], opening: { learner, interactionLimit: 6 } };
    assert.equal((await post(server.url, body)).status, 200);
    assert.equal((await post(server.url, body)).status, 409);
    const saved = await (await fetch(server.url + '/api/state')).json();
    assert.deepEqual(saved.state.learningRounds.http1.opening.learner, learner);
    const before = fs.readFileSync(path.join(out, 'state.json'));
    assert.equal((await post(server.url, { revision: saved.state.revision, modelFingerprint: saved.modelFingerprint, action: 'update', opening: { learner, interactionLimit: 0 } })).status, 400);
    assert.deepEqual(fs.readFileSync(path.join(out, 'state.json')), before);
    await server.close();
    run(['build', path.join(out, 'model.json'), '--out', out]);
    server = await startServer({ dir: out, port: 0 });
    const reopened = await (await fetch(server.url + '/api/state')).json();
    assert.deepEqual(reopened.state.learningRounds.http1.opening, saved.state.learningRounds.http1.opening);
  } finally { await server.close(); }
});

test('历史范围在目标或内容变更后保留并标记失效，不把旧画像改成能力判断', t => {
  const { out, concept } = fixture(t);
  const file = path.join(out, 'opening.json');
  fs.writeFileSync(file, JSON.stringify({ learner }));
  run(['round', '--out', out, '--action', 'create', '--round-id', 'stale1', '--entry', 'organize-existing-material', '--goal', '能解释概率', '--concept', concept, '--opening', file]);
  const initial = run(['round-read', '--out', out]).round.opening;
  run(['round', '--out', out, '--action', 'update', '--goal', '能检查概率判断']);
  let view = run(['round-read', '--out', out]).round.opening;
  assert.equal(view.preliminary.stale, true);
  assert.equal(view.preliminary.goal, '能解释概率');
  assert.equal(view.calibrated.goal, '能检查概率判断');
  assert.equal(view.calibrated.stale, false);
  const modelFile = path.join(out, 'model.json');
  const model = JSON.parse(fs.readFileSync(modelFile));
  model.concepts.find(x => x.id === concept).explanation += ' 内容变更';
  fs.writeFileSync(modelFile, JSON.stringify(model));
  run(['build', modelFile, '--out', out]);
  view = run(['round-read', '--out', out]).round.opening;
  assert.equal(view.calibrated.stale, true);
  assert.deepEqual(view.learner, initial.learner);
  run(['round', '--out', out, '--action', 'update']);
  assert.equal(run(['round-read', '--out', out]).round.opening.calibrated.stale, false);
  const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json')));
  assert.deepEqual(state.conceptEvidence, {});
  assert.deepEqual(state.attempts, {});
});
