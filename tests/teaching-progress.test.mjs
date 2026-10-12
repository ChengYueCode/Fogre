import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'skill/forge/scripts/forge.mjs');
function run(args, ok = true) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  if (!ok) return r;
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function fixture(t, tracked = true, limit = 3, entry = 'organize-existing-material') {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-progress-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  run(['build', path.join(root, 'skill/forge/assets/probability.json'), '--out', out]);
  const model = JSON.parse(fs.readFileSync(path.join(out, 'model.json')));
  const opening = path.join(out, 'opening.json');
  fs.writeFileSync(opening, JSON.stringify({ learner: { role: null, task: null, background: null, preference: null, sourceNote: '隔离样本主动跳过', skipped: true, temporaryApproach: '演示后尝试' }, interactionLimit: limit }));
  run(['round', '--out', out, '--action', 'create', '--at', '2026-10-10T00:00:00Z', '--entry', entry, '--round-id', 'r1', '--goal', '解释概率的用途', '--concept', model.prompts[0].conceptId, '--opening', opening, ...(tracked ? ['--track-progress'] : [])]);
  const read = () => run(['round-read', '--out', out]).round;
  const op = (action, record, ok = true) => {
    const file = path.join(out, 'record.json');
    fs.writeFileSync(file, JSON.stringify(record));
    return run(['round', '--out', out, '--action', action, '--record', file], ok);
  };
  return { out, read, op, model };
}
const response = (id, kind = 'answer') => ({ id, kind, text: '这是实际用户回应', sourceNote: '隔离教学第 ' + id + ' 条用户消息' });

test('公开互动按真实用户事件计数，重试幂等且上限收尾保留任务语义', t => {
  const { read, op, out } = fixture(t);
  assert.equal(read().progress.totalInteractions, 0);
  op('progress-event', response('u1'));
  op('progress-event', response('u1'));
  assert.equal(read().progress.countedInteractions, 1);
  const before = fs.readFileSync(path.join(out, 'state.json'));
  assert.notEqual(op('progress-event', { ...response('u1'), text: '不同消息' }, false).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(out, 'state.json')), before);
  op('progress-event', response('u2', 'navigation'));
  assert.equal(read().progress.budgetSignal, 'near-limit');
  op('progress-event', response('u3', 'confirmation'));
  const view = read();
  assert.equal(view.progress.countedInteractions, 3);
  assert.equal(view.progress.closure.reason, 'budget-exhausted');
  assert.equal(view.status, 'active');
  assert.ok(view.progress.remainingTaskIds.length > 0);
  assert.equal(view.progress.actualMinutes, null);
  assert.notEqual(op('progress-event', response('u4'), false).status, 0);
});

test('旧轮次起算不补造历史，真实教学回应纳入且教师工具排除', t => {
  const { read, op } = fixture(t, false, null);
  assert.equal(read().progress, null);
  op('progress-start', {});
  for (const kind of ['clarification', 'correction', 'off-topic', 'goal-change']) op('progress-event', response(kind, kind));
  op('progress-event', { ...response('admin', 'excluded'), sourceNote: '教学以外的行政安排，不计教学互动' });
  assert.equal(read().progress.countedInteractions, 4);
  assert.equal(read().progress.totalInteractions, null);
  for (const kind of ['teacher', 'tool']) assert.notEqual(op('progress-event', response(kind, kind), false).status, 0);
  assert.equal(read().progress.countedInteractions, 4);
});

test('公开时间只累加可核对区间，重试不重复、重叠拒绝，耗尽后阻止新作答', t => {
  const { out, read, op } = fixture(t, true, null);
  run(['round', '--out', out, '--action', 'update', '--minutes', '10']);
  const interval = { id: 'time1', start: '2026-10-10T01:00:00Z', end: '2026-10-10T01:06:00Z', sourceNote: '实际隔离学习区间，未含暂停' };
  op('progress-time', interval);
  op('progress-time', interval);
  assert.equal(read().progress.actualMinutes, 6);
  assert.notEqual(op('progress-time', { ...interval, id: 'overlap' }, false).status, 0);
  op('progress-time', { ...interval, id: 'time2', start: interval.end, end: '2026-10-10T01:10:00Z' });
  const view = read();
  assert.equal(view.progress.actualMinutes, 10);
  assert.equal(view.progress.closure.reason, 'budget-exhausted');
  const task = view.tasks.find(x => !x.deferred && !x.diagnostic);
  if (task) assert.notEqual(run(['submit', '--out', out, '--round-id', 'r1', '--task-id', task.id, '--prompt', task.promptId, '--answer', '新作答'], false).status, 0);
});

test('修改目标、补讲与跳过更新估计和范围，原答及调整前快照保留', t => {
  const { out, read, op } = fixture(t, true, null);
  const task = read().tasks.find(x => !x.diagnostic && !x.deferred);
  run(['submit', '--out', out, '--round-id', 'r1', '--task-id', task.id, '--prompt', task.promptId, '--answer', '学习者的原始解释', '--attempt-id', 'original1']);
  const old = read();
  const record = path.join(out, 'adjust.json');
  fs.writeFileSync(record, JSON.stringify({ reason: '从理解设计改成学习使用，补完整演示', evidenceApplicability: '原解释只支持旧目标；新目标的应用仍待检验', extraMinutes: 5, interactionEstimate: { min: 1, max: 2, basis: '演示后一次尝试；必要时补充' }, skipTaskIds: [task.id] }));
  run(['round', '--out', out, '--action', 'update', '--goal', '能在任务中使用概率', '--adjustment', record]);
  const view = read();
  assert.equal(view.progress.adjustments[0].previousGoal, old.goal);
  assert.equal(view.progress.extraMinutes, 5);
  assert.deepEqual(view.progress.interactionEstimate, { min: 1, max: 2, basis: '演示后一次尝试；必要时补充' });
  assert.ok(view.archivedTasks.some(x => x.id === task.id));
  assert.equal(view.progress.independentAttemptIds.length, 1);
  run(['round', '--out', out, '--action', 'update']);
  assert.ok(!read().tasks.some(x => x.id === task.id));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'state.json'))).attempts[task.promptId][0].answer, '学习者的原始解释');
  assert.notEqual(op('close', { reason: 'goal-achieved', gaps: [], continuation: '学习新目标', saveNote: 'state.json', evidenceApplicability: '没有证据不应通过' }, false).status, 0);
});

test('公开提前收尾要求导师独立证据；收尾不改提交或掌握，目标变化标失效', t => {
  const { out, read, op } = fixture(t, true, 9);
  run(['round', '--out', out, '--action', 'update', '--concept', 'prior', '--minutes', '100']);
  const task = read().tasks.find(x => x.conceptId === 'prior');
  run(['submit', '--out', out, '--round-id', 'r1', '--task-id', task.id, '--prompt', task.promptId, '--answer', '概率描述可能性，用零到一表示，例如公平硬币正面概率为二分之一', '--attempt-id', 'success1']);
  const closure = { reason: 'goal-achieved', gaps: [], continuation: '可在新情境检验应用', saveNote: '原答与复核保存在 state.json', evidenceApplicability: '本轮只要求解释用途，当前独立解释及例子足够' };
  assert.notEqual(op('close', closure, false).status, 0);
  run(['assess', '--out', out, '--prompt', task.promptId, '--attempt-id', 'success1', '--rating', 'good', '--note', '独立解释及公平硬币例子满足当前标准']);
  run(['evidence', '--out', out, '--concept', task.conceptId, '--status', 'explained', '--attempt', 'success1', '--note', '独立解释有机制和例子']);
  const before = JSON.parse(fs.readFileSync(path.join(out, 'state.json')));
  op('close', closure);
  const view = read();
  assert.equal(view.progress.closure.reason, 'goal-achieved');
  assert.equal(view.progress.ended, true);
  assert.equal(view.progress.countedInteractions, 0);
  const after = JSON.parse(fs.readFileSync(path.join(out, 'state.json')));
  assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(after.conceptEvidence, before.conceptEvidence);
  run(['round', '--out', out, '--action', 'update', '--goal', '能独立应用概率']);
  assert.equal(read().progress.closure.stale, true);
  assert.equal(read().progress.ended, false);
});

test('HTTP 计数持久保存/冲突/重启；坏进度导入拒绝且预算调整可续接', async t => {
  const { out, read, op } = fixture(t, true, 1);
  let server = await startServer({ dir: out, port: 0 });
  try {
    const initial = await (await fetch(server.url + '/api/state')).json();
    const body = { revision: initial.state.revision, modelFingerprint: initial.modelFingerprint, action: 'progress-event', record: response('http1') };
    const post = body => fetch(server.url + '/api/round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(body)).status, 200);
    assert.equal((await post(body)).status, 409);
    await server.close();
    run(['build', path.join(out, 'model.json'), '--out', out]);
    server = await startServer({ dir: out, port: 0 });
    const reopened = await (await fetch(server.url + '/api/state')).json();
    assert.equal(reopened.state.learningRounds.r1.progress.events.length, 1);
    assert.equal(read().progress.closure.reason, 'budget-exhausted');
    const stateFile = path.join(out, 'state.json'), before = fs.readFileSync(stateFile);
    for (const mutate of [p => p.intervals.push(null), p => p.events.push({ ...p.events[0] }), p => p.adjustments.push(null), p => p.interactionEstimate = { min: 2, max: 1 }, p => p.closure.gaps = [null]]) {
      const state = JSON.parse(before);
      mutate(state.learningRounds.r1.progress);
      const file = path.join(out, 'bad.json');
      fs.writeFileSync(file, JSON.stringify(state));
      const rejected = run(['import', '--state', file, '--out', out], false);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /E_STATE/);
      assert.deepEqual(fs.readFileSync(stateFile), before);
    }
    const openingFile = path.join(out, 'opening.json');
    fs.writeFileSync(openingFile, JSON.stringify({ interactionLimit: 3 }));
    run(['round', '--out', out, '--action', 'update', '--opening', openingFile]);
    op('progress-event', response('http2'));
    assert.equal(read().progress.countedInteractions, 2);
    assert.equal(read().progress.closure, null);
    assert.equal(read().progress.closureHistory[0].reason, 'budget-exhausted');
  } finally { await server.close(); }
});

test('导入的目标达成收尾缺少独立导师证据时保持历史，不能读作有效达成', t => {
  const { out, read } = fixture(t, true, null);
  const file = path.join(out, 'untrusted.json');
  const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json')));
  state.learningRounds.r1.progress.closure = { at: '2026-10-10T01:00:00Z', reason: 'goal-achieved', goal: read().goal,
    conceptIds: state.learningRounds.r1.conceptIds, taskIds: state.learningRounds.r1.tasks.map(t => t.id),
    modelFingerprint: state.modelFingerprint, gaps: [], continuation: '历史续接点', saveNote: '导入样本', evidenceApplicability: '导入方宣称达成，未有实际导师证据' };
  fs.writeFileSync(file, JSON.stringify(state));
  const imported = path.join(out, 'imported');
  run(['build', path.join(out, 'model.json'), '--out', imported]);
  run(['import', '--out', imported, '--state', file]);
  const view = run(['round-read', '--out', imported]).round;
  assert.equal(view.progress.closure.stale, true);
  assert.equal(view.progress.ended, false);
  assert.equal(view.progress.mastery[0].status, 'unknown');
});

test('同名目标切换概念范围后旧主动结束失效，新路线可继续', t => {
  const { out, read, op } = fixture(t, true, null);
  op('close', { reason: 'learner-stop', gaps: ['下次核对范围'], continuation: '从新目标续接', saveNote: 'state.json', evidenceApplicability: '本次只暂停，不宣称掌握' });
  assert.equal(read().progress.ended, true);
  run(['round', '--out', out, '--action', 'update', '--concept', 'prior']);
  assert.equal(read().progress.closure.stale, true);
  op('progress-event', response('new-scope'));
  assert.equal(read().progress.countedInteractions, 1);
});

test('诊断前剩余估计包含真实待答诊断与计划单元，不把门控算作全部暂缓', t => {
  const { out, read } = fixture(t, true, null, 'learn-new-topic');
  const initial = read();
  assert.equal(initial.progress.estimatedRemainingMinutes, 16);
  const task = initial.tasks.find(x => x.diagnostic);
  run(['submit', '--out', out, '--round-id', 'r1', '--task-id', task.id, '--prompt', task.promptId, '--answer', '概率表示可能性']);
  assert.equal(read().progress.estimatedRemainingMinutes, 8);
  assert.equal(read().progress.actualMinutes, null);
});

test('诊断前显式跳过的任务在确认诊断后保持归档，不重新安排', t => {
  const { out, read } = fixture(t, true, null, 'learn-new-topic');
  const formal = read().tasks.find(x => !x.diagnostic), diagnostic = read().tasks.find(x => x.diagnostic);
  const file = path.join(out, 'skip.json');
  fs.writeFileSync(file, JSON.stringify({ reason: '本轮跳过正式单元', evidenceApplicability: '跳过不等于完成', skipTaskIds: [formal.id] }));
  run(['round', '--out', out, '--action', 'update', '--adjustment', file]);
  run(['submit', '--out', out, '--round-id', 'r1', '--task-id', diagnostic.id, '--prompt', diagnostic.promptId, '--answer', '概率表示可能性']);
  run(['round', '--out', out, '--action', 'confirm-diagnosis']);
  assert.equal(read().tasks.some(t => t.id === formal.id), false);
  assert.equal(read().archivedTasks.some(t => t.id === formal.id), true);
});
