// Synthetic learner data only. Every scenario crosses the public CLI in fresh
// processes, proving discovery survives the original teaching conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../skill/forge/scripts/forge.mjs', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-library-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args, ok = true) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, ok ? 0 : 1, `${args.join(' ')}\n${result.stderr}`);
    return ok ? JSON.parse(result.stdout) : result.stderr;
  };
  return { root, run, catalog: path.join(root, 'learning', 'learning-index.json') };
}
function model(id) {
  return { schemaVersion: 1, id, title: `合成主题 ${id}`, goal: '解释合成概念', summary: '合成测试材料',
    sources: [{ id: 's', title: '合成说明', kind: 'provided', note: '测试来源', url: '' }],
    concepts: [{ id: 'alpha', title: '概念甲', parentId: null, difficulty: 1, explanation: '甲的合成解释' }],
    relations: [], prompts: [{ id: 'p-alpha', conceptId: 'alpha', kind: 'explain', question: '解释甲', answer: '甲的机制', criteria: ['解释机制'] }] };
}
function build(env, id) {
  const source = path.join(env.root, `${id}.json`);
  const out = path.join(env.root, 'learning', id);
  fs.writeFileSync(source, JSON.stringify(model(id)));
  env.run(['build', source, '--out', out]);
  return { source, out };
}
function register(env, id, out) {
  return env.run(['library', 'register', '--topic', id, '--out', out]);
}
function bytes(out) {
  return Object.fromEntries(['model.json', 'state.json', 'index.html', 'map.excalidraw'].map((name) =>
    [name, fs.readFileSync(path.join(out, name), 'utf8')]));
}

test('missing library and no-op removal create no files; unknown topic fails', (t) => {
  const env = setup(t);
  const view = env.run(['library', 'list']);
  assert.equal(view.present, false);
  assert.deepEqual(view.topics, []);
  assert.equal(env.run(['library', 'remove', '--topic', 'missing']).removed, false);
  assert.match(env.run(['library', 'resume', '--topic', 'missing'], false), /E_STATE/);
  assert.equal(fs.existsSync(path.dirname(env.catalog)), false);
});

test('two themes persist, registration is byte-stable, removal preserves all learning files', (t) => {
  const env = setup(t);
  const a = build(env, 'a'); const b = build(env, 'b');
  const before = bytes(a.out);
  register(env, 'a', a.out); register(env, 'b', b.out);
  const indexBefore = fs.readFileSync(env.catalog, 'utf8');
  assert.equal(register(env, 'a', path.join(a.out, '.')).unchanged, true);
  assert.equal(fs.readFileSync(env.catalog, 'utf8'), indexBefore);
  const view = env.run(['library', 'list']);
  assert.deepEqual(view.topics.map((x) => x.id), ['a', 'b']);
  assert.ok(view.topics.every((x) => x.available && x.round === null && x.dueCount === 0));
  assert.deepEqual(bytes(a.out), before);
  assert.equal(env.run(['library', 'remove', '--topic', 'a']).archiveDeleted, false);
  assert.deepEqual(bytes(a.out), before);
  assert.deepEqual(env.run(['library', 'list']).topics.map((x) => x.id), ['b']);
});

test('fresh sessions recover paused task and assisted original answer without writing', (t) => {
  const env = setup(t); const a = build(env, 'a'); register(env, 'a', a.out);
  env.run(['round', '--out', a.out, '--action', 'create', '--round-id', 'r1', '--entry', 'organize-existing-material', '--goal', '解释甲', '--concept', 'alpha']);
  const view = env.run(['round-read', '--out', a.out]).round;
  env.run(['submit', '--out', a.out, '--prompt', 'p-alpha', '--answer', '合成原答：还有缺口', '--assistance', 'hint', '--round-id', 'r1', '--task-id', view.currentTaskId]);
  env.run(['round', '--out', a.out, '--action', 'pause', '--round-id', 'r1']);
  const before = bytes(a.out); const indexBefore = fs.readFileSync(env.catalog, 'utf8');
  const resumed = env.run(['library', 'resume', '--topic', 'a']);
  assert.equal(resumed.round.status, 'paused');
  assert.equal(resumed.round.id, 'r1');
  assert.equal(resumed.activeRoundId, 'r1');
  assert.match(JSON.stringify(resumed.answers), /合成原答：还有缺口/);
  assert.match(JSON.stringify(resumed.answers), /"assisted":true/);
  const listed = env.run(['library', 'list']).topics[0];
  assert.deepEqual(listed.position, resumed.position);
  assert.equal(listed.round.status, 'paused');
  assert.deepEqual(bytes(a.out), before);
  assert.equal(fs.readFileSync(env.catalog, 'utf8'), indexBefore);
  assert.doesNotMatch(indexBefore, /合成原答|attempts|explanations|profile/);
});

test('overdue answers without a round are counted live, old content is counted separately', (t) => {
  const env = setup(t); const a = build(env, 'a'); register(env, 'a', a.out);
  const indexBefore = fs.readFileSync(env.catalog, 'utf8');
  const submitted = env.run(['submit', '--out', a.out, '--prompt', 'p-alpha', '--answer', '合成独立原答']);
  env.run(['assess', '--out', a.out, '--prompt', 'p-alpha', '--attempt-id', submitted.attempt.id, '--rating', 'hard', '--note', '合成反馈']);
  const listed = env.run(['library', 'list', '--at', '2099-01-01T00:00:00Z']).topics[0];
  assert.equal(listed.round, null); assert.equal(listed.dueCount, 1);
  const raw = model('a'); raw.prompts[0].question = '用新的条件解释甲';
  fs.writeFileSync(a.source, JSON.stringify(raw)); env.run(['build', a.source, '--out', a.out]);
  const changed = env.run(['library', 'list', '--at', '2099-01-01T00:00:00Z']).topics[0];
  assert.equal(changed.dueCount, 0); assert.equal(changed.staleDueCount, 1);
  assert.equal(fs.readFileSync(env.catalog, 'utf8'), indexBefore);
});

test('missing, corrupt and identity-changed themes remain isolated from a valid theme', (t) => {
  const env = setup(t);
  const a = build(env, 'a'); const b = build(env, 'b'); register(env, 'a', a.out); register(env, 'b', b.out);
  const stateFile = path.join(a.out, 'state.json'); const saved = fs.readFileSync(stateFile);
  for (const mode of ['missing', 'corrupt', 'wrong-id']) {
    fs.writeFileSync(stateFile, saved);
    if (mode === 'missing') fs.unlinkSync(stateFile);
    if (mode === 'corrupt') fs.writeFileSync(stateFile, '{broken');
    if (mode === 'wrong-id') {
      const raw = model('other'); fs.writeFileSync(a.source, JSON.stringify(raw));
      fs.writeFileSync(path.join(a.out, 'model.json'), JSON.stringify(raw));
    }
    const listed = env.run(['library', 'list']).topics;
    assert.equal(listed[0].available, false, mode); assert.equal(listed[0].dueCount, null);
    assert.equal(listed[1].available, true);
    assert.match(env.run(['library', 'resume', '--topic', 'a'], false), /E_IO|E_STATE|E_IDENTITY/);
    if (mode === 'missing') assert.equal(fs.existsSync(stateFile), false);
  }
});

test('damaged and future indexes refuse writes, including removal', (t) => {
  const env = setup(t); const a = build(env, 'a'); register(env, 'a', a.out);
  for (const content of ['{broken', JSON.stringify({ schemaVersion: 999, topics: [] }), JSON.stringify({ schemaVersion: 1, topics: [{ id: 'a' }] })]) {
    fs.writeFileSync(env.catalog, content);
    for (const args of [['list'], ['register', '--topic', 'a', '--out', a.out], ['remove', '--topic', 'a']]) {
      assert.match(env.run(['library', ...args], false), /E_IO|E_STATE/);
      assert.equal(fs.readFileSync(env.catalog, 'utf8'), content);
    }
  }
});

test('identity conflicts and path aliases cannot create duplicate learners', (t) => {
  const env = setup(t); const a = build(env, 'a'); const b = build(env, 'b'); register(env, 'a', a.out);
  assert.match(env.run(['library', 'register', '--topic', 'a', '--out', b.out], false), /E_STATE/);
  assert.match(env.run(['library', 'register', '--topic', 'alias', '--out', path.join(a.out, '..', 'a')], false), /E_STATE/);
  const alias = path.join(env.root, 'alias');
  fs.symlinkSync(a.out, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(env.run(['library', 'register', '--topic', 'alias', '--out', alias], false), /E_STATE/);
  assert.equal(env.run(['library', 'list']).topics.length, 1);
});

test('moving the library with its themes preserves relative pointers', (t) => {
  const env = setup(t); const a = build(env, 'a'); register(env, 'a', a.out);
  assert.equal(path.isAbsolute(JSON.parse(fs.readFileSync(env.catalog)).topics[0].directory), false);
  const moved = path.join(env.root, 'moved'); fs.renameSync(path.dirname(env.catalog), moved);
  const catalog = path.join(moved, 'learning-index.json');
  const resumed = env.run(['library', 'resume', '--catalog', catalog, '--topic', 'a']);
  assert.equal(resumed.out, path.join(moved, 'a'));
  assert.equal(resumed.identity.modelId, 'a');
});

test('concurrent registrations preserve both topics', async (t) => {
  const env = setup(t); const a = build(env, 'a'); const b = build(env, 'b');
  await Promise.all([a, b].map(({ out }, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'library', 'register', '--topic', i === 0 ? 'a' : 'b', '--out', out], { cwd: env.root });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.deepEqual(env.run(['library', 'list']).topics.map((x) => x.id), ['a', 'b']);
});

test('usage errors and protected artifact names leave archives intact', (t) => {
  const env = setup(t); const a = build(env, 'a'); const before = bytes(a.out);
  for (const args of [[], ['unknown'], ['list', '--at'], ['list', '--at', 'bad'], ['list', '--state', 'other.json'], ['list', 'extra'],
    ['register', '--topic', '中文', '--out', a.out], ['register', '--topic', 'a', '--out', env.root],
    ['register', '--topic', 'a', '--out', a.out, '--catalog', path.join(a.out, 'state.json')]]) {
    assert.match(env.run(['library', ...args], false), /E_USAGE|E_IO/);
  }
  assert.deepEqual(bytes(a.out), before);
});
