// Integration tests for the forge CLI, builder and loopback service.
// Run: node --test tests/integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeModel, modelToJson } from '../skill/forge/scripts/lib/model.mjs';
import {
  applyAttempt,
  applyNote,
  applyTitleRevision,
  applyTutorEvidence,
  createState,
  promptFingerprint,
} from '../skill/forge/scripts/lib/state.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { startServer } from '../skill/forge/scripts/lib/server.mjs';
import { atomicWrite, readJson, stableStringify } from '../skill/forge/scripts/lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMBER = path.join(ROOT, 'skill', 'forge', 'scripts', 'forge.mjs');
const VIEWER = path.join(ROOT, 'skill', 'forge', 'assets', 'viewer.html');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ember-it-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rawModel(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'it-model',
    title: '集成主题',
    goal: '能解释并应用核心机制',
    concepts: [
      { id: 'root', title: '根概念', parentId: null, difficulty: 1, explanation: '根解释', example: '根例子' },
      { id: 'child', title: '子概念', parentId: 'root', difficulty: 2, explanation: '子解释' },
    ],
    relations: [
      { id: 'rel-root-child', from: 'root', to: 'child', type: 'prerequisite', label: '先根后子' },
    ],
    prompts: [
      { id: 'p-explain', conceptId: 'child', kind: 'explain', question: '请解释子概念', answer: '参考答案', criteria: ['说到要点'] },
      { id: 'p-apply', conceptId: 'child', kind: 'apply', question: '换一个情境应用', answer: '参考应用', criteria: ['步骤正确'] },
    ],
    // summary/sources/limitations deliberately omitted (optional fields).
    ...overrides,
  };
}

function build(dir, { raw = rawModel(), modelPath, svg = false } = {}) {
  const source = modelPath ?? path.join(dir, 'source.json');
  if (modelPath === undefined) atomicWrite(source, stableStringify(raw));
  return buildArtifacts({ modelPath: source, outDir: dir, viewerPath: VIEWER, svg });
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function setState(dir, state) {
  atomicWrite(path.join(dir, 'state.json'), stableStringify(state));
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EMBER, ...args], { cwd, encoding: 'utf8' });
}

async function withServer(dir, fn) {
  const started = await startServer({ dir, port: 0 });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// Raw request path so a test can forge a Host header (fetch may normalize it).
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Build artifact behavior
// ---------------------------------------------------------------------------

test('valid build writes every artifact and a no-op reread rebuild is stable', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const first = build(dir, { svg: true });
  assert.equal(first.state.revision, 0, 'fresh build does not invent learner events');
  assert.equal(first.state.modelRevision, 1);
  for (const name of ['index.html', 'model.json', 'state.json', 'map.excalidraw', 'map.svg']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} exists`);
  }
  assert.deepEqual(first.output, { html: true, model: true, state: true, scene: true, svg: true });

  // reread/rebuild reads its own generated model.json and produces byte-identical files
  const before = {
    html: readFile(path.join(dir, 'index.html')),
    model: readFile(path.join(dir, 'model.json')),
    state: readFile(path.join(dir, 'state.json')),
    scene: readFile(path.join(dir, 'map.excalidraw')),
  };
  const second = build(dir, { modelPath: path.join(dir, 'model.json'), svg: true });
  assert.deepEqual(second.output, { html: false, model: false, state: false, scene: false, svg: false });
  assert.equal(second.state.revision, first.state.revision, 'no-op rebuild keeps revision stable');
  assert.equal(readFile(path.join(dir, 'index.html')), before.html);
  assert.equal(readFile(path.join(dir, 'state.json')), before.state);
  assert.equal(readFile(path.join(dir, 'model.json')), before.model);
  assert.equal(readFile(path.join(dir, 'map.excalidraw')), before.scene);
});

test('omitted optional fields build cleanly and survive a round-trip', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const result = build(dir);
  assert.equal(result.warnings.length, 0);
  // modelToJson drops empty optional strings; the generated model must still validate.
  const reread = normalizeModel(readJson(path.join(dir, 'model.json')));
  assert.equal(reread.id, 'it-model');
  assert.equal(reread.concepts.find((c) => c.id === 'child').example, '');
  assert.equal(reread.summary, '');
  assert.deepEqual(modelToJson(reread), modelToJson(result.model));
});

test('invalid input leaves prior outputs byte-for-byte unchanged and BOM JSON parses', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  build(dir);
  const snapshot = {};
  for (const name of ['index.html', 'model.json', 'state.json', 'map.excalidraw']) {
    snapshot[name] = readFile(path.join(dir, name));
  }

  // duplicate concept id: validation fails before any write
  const broken = rawModel({
    concepts: [
      { id: 'root', title: '根', parentId: null, difficulty: 1, explanation: 'e' },
      { id: 'root', title: '重复', parentId: null, difficulty: 1, explanation: 'e' },
    ],
  });
  atomicWrite(path.join(dir, 'broken.json'), stableStringify(broken));
  assert.throws(() => build(dir, { modelPath: path.join(dir, 'broken.json') }), (err) => err.code === 'E_DUP_ID');
  for (const name of Object.keys(snapshot)) {
    assert.equal(readFile(path.join(dir, name)), snapshot[name], `${name} unchanged after failed validation`);
  }

  // UTF-8 BOM is accepted by readJson
  atomicWrite(path.join(dir, 'bom.json'), '\uFEFF' + stableStringify(rawModel()));
  const parsed = readJson(path.join(dir, 'bom.json'));
  assert.equal(parsed.id, 'it-model');
});

test('learner edits and real attempts are preserved when the model changes', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  const model1 = normalizeModel(rawModel());
  let state = createState(model1);
  state = applyTitleRevision(state, model1, { conceptId: 'child', title: '学习者改的子概念' }, '2026-01-01T00:00:00Z').state;
  state = applyNote(state, model1, { conceptId: 'child', kind: 'explanation', text: '我的解释' }, '2026-01-01T00:00:01Z').state;
  state = applyAttempt(state, model1, { promptId: 'p-apply', answer: '我的应用作答', rating: 'good', assisted: false }, '2026-01-02T00:00:00Z').state;
  setState(dir, state);

  const changed = rawModel({ goal: '换成新的目标' });
  atomicWrite(path.join(dir, 'changed.json'), stableStringify(changed));
  const result = build(dir, { modelPath: path.join(dir, 'changed.json') });

  assert.equal(result.state.conceptRevisions.child.title, '学习者改的子概念');
  assert.equal(result.state.explanations.child.text, '我的解释');
  assert.equal(result.state.attempts['p-apply'][0].answer, '我的应用作答');
  assert.equal(result.state.attempts['p-apply'].length, 1, 'rebuild does not fabricate attempts');
  assert.equal(result.changed.model, true);
  assert.ok(result.state.modelRevision > 1);
});

test('changed concept content inactivates old proof instead of showing stale mastery', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const model1 = normalizeModel(rawModel());
  let state = createState(model1);
  state = applyAttempt(state, model1, { promptId: 'p-apply', answer: '作答', rating: 'good', assisted: false }, '2026-01-02T00:00:00Z').state;
  state = applyTutorEvidence(state, model1, { promptId: 'p-apply', status: 'applied', note: '当次应用正确' }, '2026-01-02T01:00:00Z').state;
  setState(dir, state);

  const changed = rawModel({
    concepts: rawModel().concepts.map((c) => (c.id === 'child' ? { ...c, explanation: '完全改写后的子解释' } : c)),
  });
  atomicWrite(path.join(dir, 'changed.json'), stableStringify(changed));
  const result = build(dir, { modelPath: path.join(dir, 'changed.json') });

  assert.ok(result.state.promptEvidence['p-apply'], 'historical proof is retained');
  assert.equal(result.view.prompts['p-apply'].evidence, null, 'active proof is cleared');
  assert.equal(result.view.prompts['p-apply'].staleEvidence.status, 'applied');
  assert.equal(result.view.prompts['p-apply'].stale, true);
});

test('removing a concept reports orphaned learner edits instead of blocking reconciliation', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const model1 = normalizeModel(rawModel());
  let state = createState(model1);
  state = applyTitleRevision(state, model1, { conceptId: 'child', title: '学习者的子标题' }, '2026-01-01T00:00:00Z').state;
  state = applyNote(state, model1, { conceptId: 'child', kind: 'summary', text: '我的总结' }, '2026-01-01T00:00:01Z').state;
  state = applyAttempt(state, model1, { promptId: 'p-apply', answer: '我的作答', rating: 'good', assisted: false }, '2026-01-02T00:00:00Z').state;
  setState(dir, state);

  const shrunk = rawModel({
    concepts: [{ id: 'root', title: '根概念', parentId: null, difficulty: 1, explanation: '根解释' }],
    relations: [],
    prompts: [],
  });
  atomicWrite(path.join(dir, 'shrunk.json'), stableStringify(shrunk));
  const result = build(dir, { modelPath: path.join(dir, 'shrunk.json') });

  const kinds = new Set(result.orphans.map((o) => `${o.kind}:${o.id}`));
  assert.ok(kinds.has('concept-revision:child'));
  assert.ok(kinds.has('summary:child'));
  assert.ok(kinds.has('attempt:p-apply'));
  assert.ok(result.state.conceptRevisions.child, 'orphan edit is preserved, not deleted');
  assert.equal(readFile(path.join(dir, 'index.html')).includes('学习者'), true);
});

test('built page escapes closing-script text and embeds no external resources', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const hostile = rawModel({
    title: '标题</script><script>alert("x")</script>',
    concepts: rawModel().concepts.map((c) => (c.id === 'root'
      ? { ...c, title: '根</script><script>alert(1)</script>' }
      : c)),
  });
  build(dir, { raw: hostile });
  const html = readFile(path.join(dir, 'index.html'));

  assert.ok(!html.includes('</script><script>alert'), 'raw closing script is escaped');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'payload uses escaped tag text');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external script');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheet');
  assert.ok(!/https?:\/\/[^"']+\.(?:js|css)/i.test(html), 'no remote js/css reference');

  const match = html.match(/<script id="ember-data" type="application\/json">([\s\S]*?)<\/script>/);
  const payload = JSON.parse(match[1]);
  assert.equal(payload.model.title, '标题</script><script>alert("x")</script>');
  assert.equal(payload.model.concepts.find((c) => c.id === 'root').title, '根</script><script>alert(1)</script>');
});

// ---------------------------------------------------------------------------
// Loopback service
// ---------------------------------------------------------------------------

test('HTTP note and practice answer save and survive a restart', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  let firstBody;
  await withServer(dir, async (s) => {
    const state = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(state.state.revision, 0);
    assert.equal(typeof state.modelFingerprint, 'string');
    assert.ok(Object.keys(state.promptFingerprints).includes('p-apply'));

    const note = await postJson(`${s.url}/api/note`, {
      revision: state.state.revision,
      modelFingerprint: state.modelFingerprint,
      conceptId: 'child',
      kind: 'explanation',
      text: '浏览器里写的解释',
    });
    assert.equal(note.status, 200);
    assert.equal(note.json.state.revision, 1);

    const attempt = await postJson(`${s.url}/api/attempt`, {
      revision: note.json.state.revision,
      modelFingerprint: note.json.modelFingerprint,
      promptId: 'p-apply',
      attemptId: 'att-integration-1',
      answer: '浏览器里的应用作答',
      rating: 'hard',
      assisted: false,
    });
    assert.equal(attempt.status, 200);
    assert.equal(attempt.json.state.revision, 2);
    firstBody = attempt.json;

    // duplicate event id is a conflict, not a second attempt
    const dup = await postJson(`${s.url}/api/attempt`, {
      revision: attempt.json.state.revision,
      modelFingerprint: attempt.json.modelFingerprint,
      promptId: 'p-apply',
      attemptId: 'att-integration-1',
      answer: '浏览器里的应用作答',
      rating: 'hard',
      assisted: false,
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'E_CONFLICT');
    assert.equal(dup.json.state.attempts['p-apply'].length, 1, 'replay adds no event');
  });

  // restart: durable state is re-read from disk
  await withServer(dir, async (s) => {
    const state = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(state.state.revision, firstBody.state.revision);
    assert.equal(state.state.explanations.child.text, '浏览器里写的解释');
    assert.equal(state.state.attempts['p-apply'].length, 1);
    assert.equal(state.state.schedules['p-apply'].intervalDays, 2, 'assisted=false hard uses the hard interval');
    const due = await (await fetch(`${s.url}/api/due`)).json();
    assert.ok(Array.isArray(due.due));
    assert.ok(Array.isArray(due.unscheduled));
  });
});

test('revision conflict returns useful 409 state and import cannot forge tutor evidence', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  await withServer(dir, async (s) => {
    const base = await (await fetch(`${s.url}/api/state`)).json();
    const first = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child',
      kind: 'summary',
      text: '第一次保存',
    });
    assert.equal(first.status, 200);

    const stale = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision, // now stale
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child',
      kind: 'summary',
      text: '基于旧 revision 的保存',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'E_CONFLICT');
    assert.ok(stale.json.state, '409 carries the current state for reconciliation');
    assert.equal(stale.json.state.summaries.child.text, '第一次保存');

    // A browser import that carries forged mastery evidence must not elevate it.
    const forged = JSON.parse(JSON.stringify(first.json.state));
    forged.promptEvidence['p-apply'] = { status: 'retained', note: '伪造', reviewer: 'tutor', at: '2026-01-01T00:00:00Z' };
    forged.conceptEvidence.child = { status: 'applied', note: '伪造', reviewer: 'tutor', at: '2026-01-01T00:00:00Z' };
    forged.revision = first.json.state.revision + 1;
    const imported = await postJson(`${s.url}/api/import`, {
      revision: first.json.state.revision,
      modelFingerprint: first.json.modelFingerprint,
      state: forged,
    });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.json.state.promptEvidence, {}, 'imported tutor evidence is dropped');
    assert.deepEqual(imported.json.state.conceptEvidence, {}, 'imported concept evidence is dropped');
    assert.equal(imported.json.state.summaries.child.text, '第一次保存', 'existing edits are preserved');

    // Identity mismatch is a conflict, not a silent overwrite.
    const wrongId = JSON.parse(JSON.stringify(first.json.state));
    wrongId.modelId = 'someone-else';
    const badIdentity = await postJson(`${s.url}/api/import`, {
      revision: imported.json.state.revision,
      modelFingerprint: imported.json.modelFingerprint,
      state: wrongId,
    });
    assert.equal(badIdentity.status, 409);
    assert.equal(badIdentity.json.code, 'E_IDENTITY');
  });
});

test('a late request against a changed model is rejected and does not write stale proof', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  await withServer(dir, async (s) => {
    const base = await (await fetch(`${s.url}/api/state`)).json();
    const stateFile = path.join(dir, 'state.json');
    const before = readFile(stateFile);

    // Rebuild the model on disk (goal change => new fingerprint) without touching state.
    const changed = normalizeModel(rawModel({ goal: '模型已经被外部改动' }));
    atomicWrite(path.join(dir, 'model.json'), stableStringify(modelToJson(changed)));

    const stale = await postJson(`${s.url}/api/attempt`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      promptId: 'p-apply',
      attemptId: 'att-stale',
      answer: '基于旧模型的作答',
      rating: 'good',
      assisted: false,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'E_CONFLICT');
    assert.equal(stale.json.modelChanged, true);
    assert.notEqual(stale.json.modelFingerprint, base.modelFingerprint);
    assert.equal(readFile(stateFile), before, 'no stale proof was written');

    const fresh = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(fresh.modelFingerprint, changed.modelFingerprint);
  });
});

test('malformed JSON, wrong content type, oversized body, origin and traversal are rejected', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  await withServer(dir, async (s) => {
    const badJson = await postJson(`${s.url}/api/note`, '{ not json');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.code, 'E_IO');

    const wrongType = await fetch(`${s.url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(wrongType.status, 415);

    const evilOrigin = await postJson(`${s.url}/api/note`, { revision: 0 }, { Origin: 'http://evil.example' });
    assert.equal(evilOrigin.status, 403);

    const tooBig = await postJson(`${s.url}/api/note`, 'x'.repeat(4 * 1024 * 1024 + 64));
    assert.equal(tooBig.status, 413);

    for (const candidate of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/skill/forge/SKILL.md', '/..%2f..%2fpackage.json']) {
      const res = await fetch(`${s.url}${candidate}`);
      assert.equal(res.status, 404, `${candidate} is not served`);
    }
    const unknownApi = await fetch(`${s.url}/api/nope`);
    assert.equal(unknownApi.status, 404);
  });
});

test('mutating API requires modelFingerprint and rejects non-loopback Host/Origin without writing', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  await withServer(dir, async (s) => {
    const stateFile = path.join(dir, 'state.json');
    const before = readFile(stateFile);
    const base = await (await fetch(`${s.url}/api/state`)).json();

    // Missing fingerprint: rejected before any mutation and state is untouched.
    const missing = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      conceptId: 'child', kind: 'explanation', text: '没有指纹',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'E_USAGE');
    assert.equal(readFile(stateFile), before, 'missing fingerprint writes nothing');

    // Non-string and empty fingerprints are equally rejected.
    const wrongType = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: 42,
      conceptId: 'child', kind: 'explanation', text: '类型错误',
    });
    assert.equal(wrongType.status, 400);
    assert.equal(readFile(stateFile), before);

    const empty = await postJson(`${s.url}/api/attempt`, {
      revision: base.state.revision,
      modelFingerprint: '',
      promptId: 'p-apply', attemptId: 'att-no-fp', answer: '缺少指纹', rating: 'good', assisted: false,
    });
    assert.equal(empty.status, 400);
    assert.equal(readFile(stateFile), before, 'empty fingerprint writes nothing');

    // A changed fingerprint is still a useful 409, not a 400.
    const stale = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: 'not-the-current-fingerprint',
      conceptId: 'child', kind: 'summary', text: '旧模型',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'E_CONFLICT');
    assert.equal(readFile(stateFile), before);

    // Host and Origin must name this loopback port, not an unrelated peer.
    const badHost = await rawRequest(s.port, {
      path: '/api/state',
      headers: { Host: `unrelated.example:${s.port}`, Origin: `http://unrelated.example:${s.port}` },
    });
    assert.equal(badHost.status, 403, 'unrelated Host is rejected even when Origin agrees with it');
    assert.equal(readFile(stateFile), before);

    const badOrigin = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child', kind: 'summary', text: '跨源',
    }, { Origin: `http://unrelated.example:${s.port}` });
    assert.equal(badOrigin.status, 403);

    const badScheme = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child', kind: 'summary', text: 'https',
    }, { Origin: `https://127.0.0.1:${s.port}` });
    assert.equal(badScheme.status, 403, 'wrong Origin scheme is rejected');

    const badPort = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child', kind: 'summary', text: '错误端口',
    }, { Origin: `http://127.0.0.1:${s.port + 1}` });
    assert.equal(badPort.status, 403, 'wrong Origin port is rejected');
    assert.equal(readFile(stateFile), before, 'all rejected requests leave state untouched');

    // Normal loopback clients, including localhost, still work.
    const ok = await postJson(`${s.url}/api/note`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child', kind: 'explanation', text: '正常保存',
    }, { Origin: `http://localhost:${s.port}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.state.revision, 1);
  });
});

test('startServer refuses a non-loopback bind before opening a socket', async () => {
  for (const host of ['0.0.0.0', '192.168.1.10', 'example.com']) {
    await assert.rejects(
      () => startServer({ dir: ROOT, host, port: 0 }),
      (err) => err instanceof Error && err.code === 'E_USAGE',
      `${host} should be refused`,
    );
  }
});

test('server recomputes learner-question fingerprints with the core helper', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);

  await withServer(dir, async (s) => {
    const base = await (await fetch(`${s.url}/api/state`)).json();
    const question = await postJson(`${s.url}/api/question`, {
      revision: base.state.revision,
      modelFingerprint: base.modelFingerprint,
      conceptId: 'child',
      text: '我自己的检索问题是什么？',
      id: 'q-own-1',
    });
    assert.equal(question.status, 200);
    assert.ok(question.json.promptFingerprints['q-own-1'], 'own-question fingerprint is part of the response');

    // Recompute with the same core helper the server used; the browser must get
    // this exact value rather than hashing only the question text.
    const model = normalizeModel(readJson(path.join(dir, 'model.json')));
    const expected = promptFingerprint(model, question.json.state, 'q-own-1');
    assert.equal(question.json.promptFingerprints['q-own-1'], expected);

    const attempt = await postJson(`${s.url}/api/attempt`, {
      revision: question.json.state.revision,
      modelFingerprint: question.json.modelFingerprint,
      promptId: 'q-own-1',
      answer: '我的回答',
      rating: 'good',
      assisted: false,
    });
    assert.equal(attempt.status, 200);
    assert.equal(attempt.json.state.attempts['q-own-1'][0].fingerprint, expected);
  });
});

test('CLI submission is durable without a rating and review assesses that saved identity', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  build(dir);
  const args = ['submit', '--out', dir, '--prompt', 'p-apply', '--answer', '  original answer  ', '--attempt-id', 'durable-1'];
  const saved = runCli(args);
  assert.equal(saved.status, 0, saved.stderr);
  const first = JSON.parse(saved.stdout).attempt;
  assert.equal(first.rating, null);
  assert.equal(first.answer, '  original answer  ');
  assert.equal(runCli(args).status, 0, 'identical submission retries safely');
  assert.equal(runCli([...args.slice(0, 6), '--answer', 'altered', '--attempt-id', 'durable-1']).status, 1);
  const exported = path.join(dir, 'read.json');
  assert.equal(runCli(['export', '--out', dir, '--to', exported]).status, 0);
  assert.equal(readJson(exported).attempts['p-apply'].length, 1);
  assert.deepEqual(readJson(exported).schedules, {});
  const review = ['review', '--out', dir, '--prompt', 'p-apply', '--attempt-id', 'durable-1', '--rating', 'good'];
  assert.equal(runCli(review).status, 0);
  const once = readJson(path.join(dir, 'state.json'));
  assert.equal(runCli(review).status, 0);
  assert.deepEqual(readJson(path.join(dir, 'state.json')), once);
  assert.equal(once.attempts['p-apply'][0].answer, first.answer);
  assert.equal(once.attempts['p-apply'][0].at, first.at);
  assert.equal(once.attempts['p-apply'].length, 1);
});

test('HTTP durable practice, submission, correction and explicit assessment survive restart', async (t) => {
  const dir = tmpDir(); t.after(() => cleanup(dir)); build(dir);
  let original;
  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    async function save(route, input) {
      const result = await postJson(`${s.url}/api/${route}`, { revision: current.state.revision, modelFingerprint: current.modelFingerprint, ...input });
      if (result.status === 200) current = result.json;
      return result;
    }
    assert.equal((await save('practice', { promptId: 'p-apply', sessionId: 'session-http', draft: 'draft', assistance: ['hint'] })).status, 200);
  });
  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(current.state.practiceSessions['session-http'].draft, 'draft');
    async function save(route, input) {
      const result = await postJson(`${s.url}/api/${route}`, { revision: current.state.revision, modelFingerprint: current.modelFingerprint, ...input });
      if (result.status === 200) current = result.json;
      return result;
    }
    const input = { promptId: 'p-apply', sessionId: 'session-http', attemptId: 'att-http', answer: 'original' };
    assert.equal((await save('submit', { ...input, answer: '  ' })).status, 400);
    assert.equal((await save('submit', input)).status, 200);
    original = current.state.attempts['p-apply'][0];
    assert.equal(original.rating, null); assert.equal(original.assisted, true);
    assert.deepEqual(original.assistance, ['hint']); assert.deepEqual(current.state.schedules, {});
    const revision = current.state.revision;
    assert.equal((await save('submit', input)).status, 200);
    assert.equal(current.state.revision, revision);
    assert.equal((await save('practice', { promptId: 'p-apply', sessionId: 'session-http', assistance: ['reference'] })).status, 200);
    assert.equal((await save('submit', input)).status, 200, 'identical retry survives later help without changing original provenance');
    assert.deepEqual(current.state.attempts['p-apply'][0].assistance, ['hint']);
    assert.equal((await save('submit', { ...input, answer: 'altered' })).status, 409);
    const correction = { promptId: 'p-apply', attemptId: 'att-http', correctionId: 'corr-http', text: 'fixed', assistance: ['reference', 'tutor-feedback'] };
    assert.equal((await save('correction', correction)).status, 200);
    assert.equal((await save('correction', correction)).status, 200);
    assert.equal((await save('correction', { ...correction, assistance: ['hint'] })).status, 409);
    assert.equal((await save('assessment', { promptId: 'p-apply', attemptId: 'att-http', rating: 'good' })).status, 200);
    const assessedRevision = current.state.revision;
    assert.equal((await save('assessment', { promptId: 'p-apply', attemptId: 'att-http', rating: 'good' })).status, 200);
    assert.equal(current.state.revision, assessedRevision);
    assert.equal((await save('assessment', { promptId: 'p-apply', attemptId: 'att-http', rating: 'easy' })).status, 409);
  });
  await withServer(dir, async (s) => {
    const { state, view } = await (await fetch(`${s.url}/api/state`)).json();
    const list = state.attempts['p-apply']; assert.equal(list.length, 1);
    assert.equal(list[0].answer, original.answer); assert.equal(list[0].at, original.at);
    assert.equal(list[0].corrections.length, 1); assert.equal(list[0].corrections[0].id, 'corr-http');
    assert.equal(state.schedules['p-apply'].intervalDays, 2);
    assert.equal(view.conceptStatus.child.status, 'pending-review');
  });
});

test('public import merges corrections, assessment and assistance without rewriting originals', async (t) => {
  const dir = tmpDir(); t.after(() => cleanup(dir)); build(dir);
  assert.equal(runCli(['practice', '--out', dir, '--prompt', 'p-apply', '--session-id', 'session-import', '--draft', 'draft']).status, 0);
  assert.equal(runCli(['submit', '--out', dir, '--prompt', 'p-apply', '--session-id', 'session-import', '--attempt-id', 'original-import', '--answer', 'answer']).status, 0);
  const stalePath = path.join(dir, 'stale.json');
  assert.equal(runCli(['export', '--out', dir, '--to', stalePath]).status, 0);
  const stale = readJson(stalePath);
  const other = tmpDir(); t.after(() => cleanup(other)); build(other);
  assert.equal(runCli(['import', '--out', other, '--state', stalePath]).status, 0);
  assert.equal(runCli(['practice', '--out', other, '--prompt', 'p-apply', '--session-id', 'session-import', '--assistance', 'reference']).status, 0);
  assert.equal(runCli(['correction', '--out', other, '--prompt', 'p-apply', '--attempt-id', 'original-import', '--correction-id', 'import-correction', '--text', 'fixed', '--assistance', 'tutor-feedback']).status, 0);
  assert.equal(runCli(['review', '--out', other, '--prompt', 'p-apply', '--attempt-id', 'original-import', '--rating', 'good']).status, 0);
  const branchPath = path.join(other, 'branch.json'); assert.equal(runCli(['export', '--out', other, '--to', branchPath]).status, 0);
  assert.equal(runCli(['import', '--out', dir, '--state', branchPath]).status, 0);
  const mergedPath = path.join(dir, 'merged.json'); assert.equal(runCli(['export', '--out', dir, '--to', mergedPath]).status, 0);
  const merged = readJson(mergedPath), original = merged.attempts['p-apply'][0];
  assert.equal(original.answer, 'answer'); assert.equal(original.at, stale.attempts['p-apply'][0].at);
  assert.equal(original.assisted, false, 'post-submit help does not rewrite original independence');
  assert.equal(original.rating, 'good'); assert.equal(original.corrections.length, 1);
  assert.equal(original.corrections[0].id, 'import-correction'); assert.deepEqual(original.corrections[0].assistance, ['tutor-feedback']);
  assert.deepEqual(merged.practiceSessions['session-import'].assistance, ['reference']);
  // Reimport an old snapshot: new corrections, self-assessment and assistance survive.
  assert.equal(runCli(['import', '--out', dir, '--state', stalePath]).status, 0);
  assert.equal(runCli(['export', '--out', dir, '--to', mergedPath]).status, 0);
  assert.equal(readJson(mergedPath).attempts['p-apply'][0].corrections.length, 1);
  const altered = readJson(branchPath); altered.attempts['p-apply'][0].answer = 'forged rewrite';
  atomicWrite(branchPath, stableStringify(altered));
  assert.equal(runCli(['import', '--out', dir, '--state', branchPath]).status, 0);
  assert.equal(runCli(['export', '--out', dir, '--to', mergedPath]).status, 0);
  assert.equal(readJson(mergedPath).attempts['p-apply'][0].answer, 'answer');
  assert.ok(readJson(mergedPath).conflicts.some((c) => c.kind === 'attempt'));
});

test('CLI import rejects missing/null/wrong-type/unknown session assistance with E_STATE and keeps the archive', async (t) => {
  const dir = tmpDir(); t.after(() => cleanup(dir)); build(dir);
  const sessionId = 'malformed-import-session';
  const saved = runCli(['practice', '--out', dir, '--prompt', 'p-apply', '--session-id', sessionId,
    '--draft', 'draft with help', '--assistance', 'hint']);
  assert.equal(saved.status, 0, saved.stderr);
  const incomingPath = path.join(dir, 'incoming.json');
  assert.equal(runCli(['export', '--out', dir, '--to', incomingPath]).status, 0);
  const exported = readJson(incomingPath);
  const stateBytes = readFile(path.join(dir, 'state.json'));
  for (const id of [sessionId, 'new-import-session']) {
    for (const assistance of [undefined, null, 'hint', {}, 1, ['bogus']]) {
      const incoming = structuredClone(exported);
      const session = incoming.practiceSessions[sessionId];
      delete incoming.practiceSessions[sessionId];
      session.id = id;
      if (assistance === undefined) delete session.assistance;
      else session.assistance = assistance;
      incoming.practiceSessions[id] = session;
      atomicWrite(incomingPath, stableStringify(incoming));
      const rejected = runCli(['import', '--out', dir, '--state', incomingPath]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /forge 错误 \[E_STATE\]/);
      assert.ok(rejected.stderr.includes(`practiceSessions.${id}.assistance`));
      assert.doesNotMatch(rejected.stderr, /TypeError|未预期|\n\s+at /);
      assert.equal(rejected.stdout, '');
      assert.equal(readFile(path.join(dir, 'state.json')), stateBytes);
      const readback = path.join(dir, 'readback.json');
      assert.equal(runCli(['export', '--out', dir, '--to', readback]).status, 0);
      assert.deepEqual(readJson(readback), exported, 'revision, draft and help stay unchanged');
    }
  }
});

test('HTTP import rejects malformed session assistance with a structured E_STATE error and keeps the archive', async (t) => {
  const dir = tmpDir(); t.after(() => cleanup(dir)); build(dir);
  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    const created = await postJson(`${s.url}/api/practice`, { revision: current.state.revision, modelFingerprint: current.modelFingerprint,
      promptId: 'p-apply', sessionId: 'http-help-session', draft: 'draft', assistance: ['hint'] });
    assert.equal(created.status, 200); current = created.json;
    const revision = current.state.revision;
    const stateBytes = readFile(path.join(dir, 'state.json'));
    for (const id of ['http-help-session', 'http-new-session']) {
      for (const assistance of [undefined, null, 'hint', {}, 1, ['bogus']]) {
        const incoming = structuredClone(current.state);
        const session = { ...incoming.practiceSessions['http-help-session'] };
        delete incoming.practiceSessions['http-help-session'];
        session.id = id;
        if (assistance === undefined) delete session.assistance;
        else session.assistance = assistance;
        incoming.practiceSessions[id] = session;
        const rejected = await postJson(`${s.url}/api/import`, { revision, modelFingerprint: current.modelFingerprint, state: incoming });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.json.code, 'E_STATE');
        assert.ok(rejected.json.error.includes(`practiceSessions.${id}.assistance`));
        assert.ok(!/\n\s+at /.test(rejected.json.error), 'no internal stack in the structured error');
      }
    }
    const after = await (await fetch(`${s.url}/api/state`)).json();
    assert.equal(after.state.revision, revision);
    assert.deepEqual(after.state.practiceSessions['http-help-session'].assistance, ['hint']);
    assert.equal(readFile(path.join(dir, 'state.json')), stateBytes);
  });
});

test('concurrent public saves preserve both new answers and assistance after revision retry', async (t) => {
  const dir = tmpDir(); t.after(() => cleanup(dir)); build(dir);
  await withServer(dir, async (s) => {
    let current = await (await fetch(`${s.url}/api/state`)).json();
    const create = await postJson(`${s.url}/api/practice`, { revision: current.state.revision, modelFingerprint: current.modelFingerprint,
      promptId: 'p-apply', sessionId: 'concurrent-practice', draft: 'draft' });
    assert.equal(create.status, 200); current = create.json;
    const base = { revision: current.state.revision, modelFingerprint: current.modelFingerprint, promptId: 'p-apply', sessionId: 'concurrent-practice' };
    const results = await Promise.all([
      postJson(`${s.url}/api/practice`, { ...base, assistance: ['hint'] }),
      postJson(`${s.url}/api/practice`, { ...base, assistance: ['reference'] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const rejectedIndex = results.findIndex((r) => r.status === 409), fresh = results[rejectedIndex].json;
    const retried = await postJson(`${s.url}/api/practice`, { ...base, revision: fresh.state.revision, assistance: [rejectedIndex === 0 ? 'hint' : 'reference'] });
    assert.equal(retried.status, 200); assert.deepEqual(retried.json.state.practiceSessions['concurrent-practice'].assistance, ['hint', 'reference']);
    current = retried.json;
    const inputs = ['one', 'two'].map((answer) => ({ promptId: 'p-apply', attemptId: 'concurrent-' + answer, answer,
      revision: current.state.revision, modelFingerprint: current.modelFingerprint }));
    const attempts = await Promise.all(inputs.map((input) => postJson(`${s.url}/api/attempt`, input)));
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
    const rejected = attempts.findIndex((r) => r.status === 409);
    const retry = await postJson(`${s.url}/api/attempt`, { ...inputs[rejected], revision: attempts[rejected].json.state.revision });
    assert.equal(retry.status, 200); assert.equal(retry.json.state.attempts['p-apply'].length, 2);
    assert.deepEqual(retry.json.state.schedules, {});
    const reviewed = await postJson(`${s.url}/api/attempt`, { revision: retry.json.state.revision, modelFingerprint: retry.json.modelFingerprint,
      promptId: 'p-apply', attemptId: inputs[rejected].attemptId, rating: 'hard' });
    assert.equal(reviewed.status, 200); assert.equal(reviewed.json.state.attempts['p-apply'].length, 2);
  });
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

test('CLI help matches real commands and review/evidence record real attempts', async (t) => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));

  const help = runCli(['help']);
  assert.equal(help.status, 0);
  for (const command of ['validate', 'build', 'serve', 'due', 'review', 'evidence', 'import', 'export']) {
    assert.ok(help.stdout.includes(command), `help documents ${command}`);
  }
  assert.ok(help.stdout.includes('<skill-dir>/scripts/forge.mjs'), 'help resolves the script from the skill dir');
  assert.ok(!help.stdout.includes('scaffold'), 'omitted scaffold is not advertised');

  // seed a real model and build
  atomicWrite(path.join(dir, 'source.json'), stableStringify(rawModel()));
  const built = runCli(['build', path.join(dir, 'source.json'), '--out', dir]);
  assert.equal(built.status, 0, built.stderr);

  const missingAnswer = runCli(['review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good']);
  assert.equal(missingAnswer.status, 1);
  assert.ok(missingAnswer.stderr.includes('--answer'));

  const review = runCli([
    'review', '--out', dir, '--prompt', 'p-apply', '--rating', 'good',
    '--answer', '真阳性18 假阳性49，PPV约26.9%',
    '--at', '2026-02-01T08:00:00Z', '--attempt-id', 'att-cli-1',
  ]);
  assert.equal(review.status, 0, review.stderr);
  const reviewJson = JSON.parse(review.stdout);
  assert.equal(reviewJson.attempt.answer, '真阳性18 假阳性49，PPV约26.9%');
  assert.equal(reviewJson.attempt.rating, 'good');

  const evidence = runCli([
    'evidence', '--out', dir, '--prompt', 'p-apply', '--status', 'applied',
    '--note', '换情境计算正确', '--attempt', 'att-cli-1', '--at', '2026-02-01T09:00:00Z',
  ]);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.deepEqual(JSON.parse(evidence.stdout).attemptIds, ['att-cli-1']);

  const badEvidence = runCli([
    'evidence', '--out', dir, '--prompt', 'p-apply', '--status', 'applied',
    '--note', 'x', '--attempt', 'att-does-not-exist', '--at', '2026-02-01T09:00:00Z',
  ]);
  assert.equal(badEvidence.status, 1);
  assert.ok(badEvidence.stderr.includes('att-does-not-exist'));

  // export -> import into a fresh directory preserves the attempt and evidence
  const exported = path.join(dir, 'exported.json');
  assert.equal(runCli(['export', '--out', dir, '--to', exported]).status, 0);
  const otherDir = tmpDir();
  t.after(() => cleanup(otherDir));
  atomicWrite(path.join(otherDir, 'source.json'), stableStringify(rawModel()));
  assert.equal(runCli(['build', path.join(otherDir, 'source.json'), '--out', otherDir]).status, 0);
  const imported = runCli(['import', '--out', otherDir, '--state', exported, '--at', '2026-02-02T08:00:00Z']);
  assert.equal(imported.status, 0, imported.stderr);
  const importedState = readJson(path.join(otherDir, 'state.json'));
  assert.equal(importedState.attempts['p-apply'][0].id, 'att-cli-1');
  assert.equal(importedState.promptEvidence['p-apply'].status, 'applied');
});
