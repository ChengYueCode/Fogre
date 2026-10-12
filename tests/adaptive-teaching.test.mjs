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
function fixture(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-adaptive-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  run(['build', path.join(root, 'skill/forge/assets/probability.json'), '--out', out]);
  run(['round', '--out', out, '--action', 'create', '--entry', 'organize-existing-material', '--round-id', 'adaptive', '--goal', '解释先验概率', '--concept', 'prior', '--track-progress']);
  const read = () => run(['round-read', '--out', out]).round;
  const task = read().tasks.find(x => !x.deferred && !x.diagnostic);
  const bind = ['--round-id', 'adaptive', '--task-id', task.id, '--prompt', task.promptId];
  return { out, read, task, bind };
}

test('公开起步帮助与示范随原答保存，确认不作答，重试与交接不升级独立证据', t => {
  const { out, read, task, bind } = fixture(t);
  const record = path.join(out, 'response.json');
  fs.writeFileSync(record, JSON.stringify({ id: 'ack', kind: 'confirmation', text: '好的', sourceNote: '隔离接口测试认可回应，不是答案' }));
  run(['round', '--out', out, '--action', 'progress-event', '--record', record]);
  assert.equal(read().submittedTasks, 0);
  for (const source of ['starter', 'demonstration']) {
    const before = run(['insights', '--out', out, '--concept', 'prior']);
    const sessionId = 'help-' + source;
    const help = run(['practice', '--out', out, ...bind, '--session-id', sessionId, '--assistance', source]);
    assert.deepEqual(help.session.assistance, [source]);
    assert.deepEqual(run(['insights', '--out', out, '--concept', 'prior']), before);
    const args = ['submit', '--out', out, ...bind, '--session-id', sessionId, '--attempt-id', 'answer-' + source, '--answer', '先验是知道新线索之前的概率，不是检查后的概率。'];
    const saved = run(args).attempt;
    assert.equal(saved.assisted, true);
    assert.deepEqual(saved.assistance, [source]);
    assert.equal(saved.roundId, 'adaptive');
    assert.equal(saved.taskId, task.id);
    assert.equal(saved.rating, null);
    assert.deepEqual(run(args).attempt, saved);
  }
  assert.equal(read().progress.assistedAttemptIds.length, 2);
  assert.equal(read().progress.independentAttemptIds.length, 0);
  assert.equal(read().progress.mastery[0].status, 'unknown');
  const exported = path.join(out, 'exported.json');
  run(['export', '--out', out, '--to', exported]);
  const imported = path.join(out, 'imported');
  run(['build', path.join(out, 'model.json'), '--out', imported]);
  run(['import', '--out', imported, '--state', exported]);
  run(['build', path.join(imported, 'model.json'), '--out', imported]);
  assert.deepEqual(run(['insights', '--out', imported, '--concept', 'prior']).concepts, run(['insights', '--out', out, '--concept', 'prior']).concepts);
  assert.equal(run(['round-read', '--out', imported]).round.progress.independentAttemptIds.length, 0);
});

test('HTTP 帮助继承、修正来源、非法来源拒绝与即时停止经重启读回', async t => {
  const { out, read, task, bind } = fixture(t);
  let server = await startServer({ dir: out, port: 0 });
  const get = async () => (await fetch(server.url + '/api/state')).json();
  const post = async (route, body) => {
    const current = await get();
    return fetch(server.url + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, revision: current.state.revision, modelFingerprint: current.modelFingerprint }) });
  };
  const binding = { promptId: task.promptId, roundId: 'adaptive', taskId: task.id };
  try {
    assert.equal((await post('practice', { ...binding, sessionId: 'http-help', assistance: ['starter', 'demonstration'] })).status, 200);
    assert.equal((await post('submit', { ...binding, sessionId: 'http-help', attemptId: 'http-answer', answer: '先验来自检查之前，不由一次检测结果决定。' })).status, 200);
    const submitted = (await get()).state.attempts[task.promptId][0];
    assert.equal(submitted.assisted, true);
    assert.deepEqual(submitted.assistance, ['demonstration', 'starter']);
    assert.equal((await post('correction', { promptId: task.promptId, attemptId: 'http-answer', correctionId: 'http-correction', text: '例如检查前人群患病率是先验。', assistance: ['demonstration'] })).status, 200);
    const beforeBad = (await get()).state;
    const bad = await post('practice', { ...binding, sessionId: 'bad', assistance: ['teacher-magic'] });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'E_USAGE');
    assert.deepEqual((await get()).state, beforeBad);
    const malformed = structuredClone(beforeBad);
    malformed.practiceSessions['http-help'].assistance = ['teacher-magic'];
    const rejected = await post('import', { state: malformed });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'E_STATE');
    assert.deepEqual((await get()).state, beforeBad);
    const record = path.join(out, 'stop.json');
    fs.writeFileSync(record, JSON.stringify({ reason: 'learner-stop', gaps: ['独立应用尚未检验'], continuation: '从独立新情境题续接', saveNote: '隔离样本 state.json', evidenceApplicability: '有帮助解释不证明独立应用' }));
    run(['round', '--out', out, '--action', 'pause']);
    run(['round', '--out', out, '--action', 'close', '--record', record]);
    assert.equal(read().status, 'paused');
    assert.equal(read().progress.closure.reason, 'learner-stop');
    const stopped = (await get()).state;
    assert.equal((await post('submit', { ...binding, attemptId: 'after-stop', answer: '停止后不应写入' })).status, 409);
    assert.deepEqual((await get()).state, stopped);
    // Safe replay of the immutable original remains possible after pausing.
    assert.equal((await post('submit', { ...binding, sessionId: 'http-help', attemptId: 'http-answer', answer: submitted.answer })).status, 200);
    assert.deepEqual((await get()).state, stopped);
    await server.close();
    run(['build', path.join(out, 'model.json'), '--out', out]);
    server = await startServer({ dir: out, port: 0 });
    const reopened = (await get()).state.attempts[task.promptId][0];
    assert.equal(reopened.answer, submitted.answer);
    assert.deepEqual(reopened.assistance, submitted.assistance);
    assert.deepEqual(reopened.corrections[0].assistance, ['demonstration']);
    assert.equal(reopened.rating, null);
    assert.equal(read().progress.mastery[0].status, 'unknown');
  } finally { await server.close(); }
});
