import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRelease, verifyRelease } from '../scripts/lib/release.mjs';

// These are contract expectations, deliberately independent of tool constants.
const skills = ['forge', 'forge-insights', 'forge-organize', 'forge-question', 'forge-review', 'forge-review-plan'];
const repo = fileURLToPath(new URL('../', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');

async function put(root, name, data) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), data);
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-release-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'working source');
  await put(source, 'package.json', JSON.stringify({ name: 'fixture-forge', version: '2.3.4', license: 'UNLICENSED', type: 'module' }));
  for (const skill of skills) await put(source, `skill/${skill}/SKILL.md`, `---\nname: ${skill}\n---\n[Public guide](../../docs/installation.md)\n`);
  await put(source, 'README.md', '[Install](docs/installation.md#setup)\n[Skill](skill/forge/SKILL.md)\n');
  await put(source, 'docs/installation.md', '[Home](../README.md)\n');
  return { temp, source, output: path.join(temp, 'release') };
}

// Read central + local records, CRC and STORE payloads without importing the
// production ZIP writer/decoder. This catches mutually-consistent writer bugs.
function decodeZip(data) {
  function checksum(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  assert.equal(data.readUInt16LE(end + 4), 0);
  assert.equal(data.readUInt16LE(end + 6), 0);
  assert.equal(data.readUInt16LE(end + 20), 0);
  const count = data.readUInt16LE(end + 10);
  assert.equal(data.readUInt16LE(end + 8), count);
  let cursor = data.readUInt32LE(end + 16);
  const centralStart = cursor;
  let localEnd = 0;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50);
    assert.equal(data.readUInt16LE(cursor + 8), 0x800);
    assert.equal(data.readUInt16LE(cursor + 10), 0);
    assert.equal(data.readUInt16LE(cursor + 12), 0);
    assert.equal(data.readUInt16LE(cursor + 14), 0x21);
    const compressed = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    assert.equal(compressed, size);
    const length = data.readUInt16LE(cursor + 28);
    assert.equal(data.readUInt16LE(cursor + 30), 0);
    assert.equal(data.readUInt16LE(cursor + 32), 0);
    const name = data.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    assert.ok(!entries.has(name));
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    const offset = data.readUInt32LE(cursor + 42);
    assert.equal(offset, localEnd);
    assert.equal(data.readUInt32LE(offset), 0x04034b50);
    assert.equal(data.readUInt16LE(offset + 6), 0x800);
    assert.equal(data.readUInt16LE(offset + 8), 0);
    assert.equal(data.readUInt16LE(offset + 10), 0);
    assert.equal(data.readUInt16LE(offset + 12), 0x21);
    assert.equal(data.readUInt32LE(offset + 18), size);
    assert.equal(data.readUInt32LE(offset + 22), size);
    assert.equal(data.readUInt16LE(offset + 26), length);
    assert.equal(data.readUInt16LE(offset + 28), 0);
    assert.equal(data.subarray(offset + 30, offset + 30 + length).toString('utf8'), name);
    const payload = data.subarray(offset + 30 + length, offset + 30 + length + size);
    assert.equal(payload.length, size);
    assert.equal(checksum(payload), data.readUInt32LE(cursor + 16));
    assert.equal(checksum(payload), data.readUInt32LE(offset + 14));
    entries.set(name, payload);
    localEnd = offset + 30 + length + size;
    cursor += 46 + length;
  }
  assert.equal(localEnd, centralStart);
  assert.equal(cursor, end);
  assert.equal(cursor - centralStart, data.readUInt32LE(end + 12));
  assert.deepEqual([...entries.keys()], [...entries.keys()].sort());
  return entries;
}

test('explicit public allowlist ships six entries, preserves literals and excludes internal/runtime files', async t => {
  const { source, output } = await fixture(t);
  const publicNames = ['CONTRIBUTING.md', 'CHANGELOG.md', 'GLOSSARY.md', 'AGENTS.md', 'SECURITY.md', 'THIRD_PARTY.md', 'NOTICE', '.gitignore', '.gitattributes',
    '.github/workflows/ci.yml', '.claude-plugin/plugin.json', 'bin/forge.mjs', 'scripts/helper.mjs', 'tests/literals.test.mjs',
    'docs/github-introduction.md', 'docs/forge-methods.md', 'docs/skill-architecture.md', 'docs/skill-acceptance.md', 'docs/open-source.md', 'docs/release-checklist.md', 'docs/support.md',
    'docs/agents/issue-tracker.md', 'docs/adr/0001-decision.md', 'docs/assets/forge-preview.jpg',
    'examples/mattpocock-skills/README.md', 'examples/mattpocock-skills/overview/state.json', 'examples/README.md',
    'examples/mattpocock-skills/HANDBOOK.md', 'examples/mattpocock-skills/sources.json', 'examples/mattpocock-skills/tool-demo/readback.json', 'examples/mattpocock-skills/question/response.json',
    'docs/assets/cases/manifest.json', 'docs/assets/cases/mp-review.png', 'docs/visual-showcase.md',
    'docs/assets/showcase/forge-hero.png', 'docs/assets/showcase/forge-learning-flow.png', 'docs/assets/showcase/forge-case-study.png',
    'docs/assets/showcase/manifest.json', 'docs/assets/showcase/PROMPTS.md', 'skill/forge/assets/中文.txt'];
  for (const name of publicNames) await put(source, name, name.endsWith('.md') ? '[Home](/README.md)\n'.replace('/README.md', path.posix.relative(path.posix.dirname(name), 'README.md') || 'README.md') : 'C:\\Users\\personal token=example literal');
  const privateNames = ['.scratch/notes.md', '.git/config', 'dist/old.zip', 'INTENT.md', 'research/report.md', 'other.md', 'docs/research-report.md',
    'docs/validation/result.json', 'docs/assets/other.jpg', 'examples/private-learner/state.json', 'docs/assets/cases/debug.log', 'docs/assets/showcase/debug.log', 'docs/assets/showcase/.env', 'skill/foreign/SKILL.md', 'skill/forge/debug.log', 'scripts/run.log', 'tests/debug.log',
    'examples/mattpocock-skills/state.v1.backup.json', 'examples/probability/README.md', 'skill/forge/state.bak.json', 'scripts/tool.lock', 'skill/forge/.forge-install.json', 'skill/forge/.forge-install-lock',
    'skill/forge/.scratch/notes.md', 'scripts/dist/cache.json', 'scripts/node_modules/cache.json',
    'scripts/.env', 'tests/.env.local', 'skill/forge/.npmrc', 'skill/forge/private.pem', 'scripts/server.key'];
  for (const name of privateNames) await put(source, name, 'must not ship');
  const manifest = await prepareRelease(source, output);
  assert.deepEqual(manifest.skills, skills);
  assert.deepEqual(manifest.package, { name: 'fixture-forge', version: '2.3.4' });
  assert.deepEqual(manifest.license, { status: 'pending', declared: 'UNLICENSED', file: null });
  const actual = manifest.source.map(entry => entry.path);
  assert.deepEqual(actual, ['package.json', 'README.md', 'docs/installation.md', ...skills.map(name => `skill/${name}/SKILL.md`), ...publicNames].sort());
  for (const name of privateNames) assert.ok(!actual.includes(name), name);
  for (const entry of manifest.source) {
    const bytes = await fs.readFile(path.join(output, 'source', entry.path));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, digest(bytes));
  }
  assert.deepEqual(await verifyRelease(output), manifest);
  assert.equal(await fs.readFile(path.join(source, '.scratch/notes.md'), 'utf8'), 'must not ship');
});

test('ZIPs independently decode to the exact source/main-skill bytes and are deterministic across mtimes', async t => {
  const { source, output, temp } = await fixture(t);
  await put(source, 'LICENSE', 'Fixture license text, no upstream claim');
  await put(source, 'NOTICE', 'Fixture notice');
  await put(source, 'skill/forge/assets/中文.txt', '锻造\n');
  const manifest = await prepareRelease(source, output);
  assert.equal(manifest.license.status, 'present');
  for (const archive of manifest.archives) {
    const bytes = await fs.readFile(path.join(output, archive.path));
    assert.equal(archive.sha256, digest(bytes));
    assert.equal(archive.bytes, bytes.length);
    const decoded = decodeZip(bytes);
    const selected = manifest.source.filter(entry => archive.path === 'source.zip' || entry.path.startsWith('skill/forge/') || ['LICENSE', 'NOTICE'].includes(entry.path));
    const zipName = entry => archive.path === 'source.zip' ? `forge-source/${entry.path}` : `forge/${entry.path.startsWith('skill/forge/') ? entry.path.slice('skill/forge/'.length) : entry.path}`;
    const expectedNames = selected.map(zipName).sort();
    assert.deepEqual([...decoded.keys()], expectedNames);
    for (const entry of selected) {
      const name = zipName(entry);
      assert.deepEqual(decoded.get(name), await fs.readFile(path.join(source, entry.path)));
    }
  }
  await fs.utimes(path.join(source, 'README.md'), new Date(0), new Date(0));
  const second = path.join(temp, 'second');
  assert.deepEqual(await prepareRelease(source, second), manifest);
  for (const name of ['source.zip', 'forge-skill.zip', 'manifest.json']) assert.deepEqual(await fs.readFile(path.join(output, name)), await fs.readFile(path.join(second, name)));
});

test('standalone licensing deduplicates identical copies and refuses conflicting LICENSE or NOTICE', async t => {
  const { source, output, temp } = await fixture(t);
  for (const name of ['LICENSE', 'NOTICE']) {
    await put(source, name, `same ${name} bytes`);
    await put(source, `skill/forge/${name}`, `same ${name} bytes`);
  }
  const manifest = await prepareRelease(source, output);
  assert.deepEqual(manifest.license, { status: 'present', declared: 'UNLICENSED', file: 'LICENSE' });
  const entries = decodeZip(await fs.readFile(path.join(output, 'forge-skill.zip')));
  for (const name of ['LICENSE', 'NOTICE']) assert.equal(entries.get(`forge/${name}`).toString('utf8'), `same ${name} bytes`);
  for (const name of ['LICENSE', 'NOTICE']) {
    await put(source, `skill/forge/${name}`, `different ${name} terms`);
    const failed = path.join(temp, `conflict-${name}`);
    await assert.rejects(prepareRelease(source, failed), new RegExp(`Conflicting.*${name}`));
    await assert.rejects(fs.access(failed), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(source, name), 'utf8'), `same ${name} bytes`);
    await put(source, `skill/forge/${name}`, `same ${name} bytes`);
  }
  await verifyRelease(output);
});

test('links include references, images, spaces, parentheses and encoded paths; fenced examples are ignored', async t => {
  const { source, output } = await fixture(t);
  await put(source, 'docs/agents/a (中文).md', '[back](../../README.md)');
  await put(source, 'docs/adr/a(b).md', 'text');
  await put(source, 'README.md', [
    '[space](<docs/agents/a (中文).md> "title")', '[paren](docs/adr/a(b).md)',
    '[encoded](docs/agents/a%20(%E4%B8%AD%E6%96%87).md?raw=1#section)',
    '[full][guide]', '[guide][]', '[guide]', '[guide]: docs/installation.md "guide"',
    '![preview](docs/assets/forge-preview.jpg)', '[dir](skill/forge/)', '[anchor](#local)',
    '[web](https://example.invalid/missing)', '````markdown', '[ignored](missing.md)', '```', '[also ignored](missing-again.md)', '````',
    '~~~', '[ignored tilde](missing.md)', '~~~',
    'CLI example: --out /absolute/path. Issues live under `.scratch/<feature-slug>/`.',
  ].join('\n'));
  await put(source, 'docs/assets/forge-preview.jpg', Buffer.from([0, 255, 1]));
  await prepareRelease(source, output);
  await verifyRelease(output);
});

test('broken and escaping links fail and roll back only the new output, preserving source and siblings', async t => {
  const { source, temp } = await fixture(t);
  const sibling = path.join(temp, 'keep.txt');
  await fs.writeFile(sibling, 'keep');
  await fs.writeFile(path.join(temp, 'outside.md'), 'exists outside snapshot');
  const targets = ['missing.txt', 'docs/research-private.md', '../outside.md', '%2E%2E/outside.md', '[reference]: missing.md',
    '/README.md', 'file:///tmp/guide.md', 'C:/Users/person/guide.md', 'docs/%ZZ.md'];
  await put(source, 'docs/research-private.md', 'exists only in working source');
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    await put(source, 'README.md', target.startsWith('[reference]') ? `[use][reference]\n${target}` : `[broken](${target})`);
    const output = path.join(temp, `failed-${index}`);
    await assert.rejects(prepareRelease(source, output), /Markdown links/);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
    assert.equal(await fs.readFile(sibling, 'utf8'), 'keep');
    assert.match(await fs.readFile(path.join(source, 'README.md'), 'utf8'), /broken|reference/);
  }
});

test('verification detects changed, missing and extra files, ZIP tampering, and manifest hash tampering', async t => {
  const { source, temp } = await fixture(t);
  const mutations = [
    ['changed', async output => put(output, 'source/README.md', 'changed bytes'), /Source hash/],
    ['missing', async output => fs.unlink(path.join(output, 'source/README.md')), /Source hash/],
    ['extra source', async output => put(output, 'source/tests/extra.mjs', 'extra'), /Source hash/],
    ['private source', async output => put(output, 'source/.scratch/leak.md', 'private'), /allowlist/],
    ['extra root', async output => put(output, 'unexpected.txt', 'extra'), /file set/],
    ['ZIP bytes', async output => {
      const zip = path.join(output, 'source.zip');
      const bytes = await fs.readFile(zip); bytes[35] ^= 1; await fs.writeFile(zip, bytes);
    }, /ZIP content/],
    ['missing ZIP', async output => fs.unlink(path.join(output, 'forge-skill.zip')), /file set/],
    ['manifest source hash', async output => {
      const file = path.join(output, 'manifest.json'); const data = JSON.parse(await fs.readFile(file, 'utf8'));
      data.source[0].sha256 = '0'.repeat(64); await fs.writeFile(file, JSON.stringify(data));
    }, /Source hash/],
    ['manifest archive hash', async output => {
      const file = path.join(output, 'manifest.json'); const data = JSON.parse(await fs.readFile(file, 'utf8'));
      data.archives[0].sha256 = '0'.repeat(64); await fs.writeFile(file, JSON.stringify(data));
    }, /ZIP hash/],
  ];
  for (let i = 0; i < mutations.length; i++) {
    const [name, mutate, error] = mutations[i];
    const output = path.join(temp, `mutation-${i}`);
    await prepareRelease(source, output);
    await mutate(output);
    await assert.rejects(verifyRelease(output), error, name);
    await fs.access(output); // verification is read-only, even on failure
  }
});

test('unsafe, existing, root and all source paths except dist are refused without modifying them', async t => {
  const { source, output, temp } = await fixture(t);
  for (const target of [source, temp, path.parse(source).root, path.join(source, 'docs/release'), path.join(source, 'skill/release'),
    path.join(source, '.scratch/release'), path.join(source, 'new-public'), path.join(source, 'dist-neighbor/release')]) {
    await assert.rejects(prepareRelease(source, target), /Unsafe output/);
  }
  await fs.mkdir(output);
  await put(output, 'keep.txt', 'keep');
  await assert.rejects(prepareRelease(source, output), /already exists/);
  assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'keep');
  const fileOutput = path.join(temp, 'existing-file');
  await fs.writeFile(fileOutput, 'keep');
  await assert.rejects(prepareRelease(source, fileOutput), /already exists/);
  await assert.rejects(prepareRelease(source, path.join(fileOutput, 'child')), /Not a directory|ENOTDIR/);
  const dist = path.join(source, 'dist/release');
  await prepareRelease(source, dist);
  await verifyRelease(dist);
  assert.equal(await fs.readFile(fileOutput, 'utf8'), 'keep');
});

test('source symlinks, junctions, dangling output and ancestor aliases are refused', async t => {
  const { source, temp } = await fixture(t);
  const foreign = path.join(temp, 'foreign');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'keep'), 'keep');
  const alias = path.join(temp, 'alias');
  await fs.symlink(foreign, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRelease(source, alias), /Symlink/);
  await assert.rejects(prepareRelease(source, path.join(alias, 'release')), /Symlink/);
  const dangling = path.join(temp, 'dangling');
  await fs.symlink(path.join(temp, 'nonexistent'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRelease(source, path.join(dangling, 'release')), /Symlink/);
  const linkedSource = path.join(source, 'scripts/linked');
  await fs.mkdir(path.dirname(linkedSource), { recursive: true });
  await fs.symlink(foreign, linkedSource, process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(temp, 'source-link-release');
  await assert.rejects(prepareRelease(source, output), /Symlink/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  await fs.unlink(linkedSource);
  const originalSkills = path.join(source, 'skill-original');
  await fs.rename(path.join(source, 'skill'), originalSkills);
  await fs.symlink(originalSkills, path.join(source, 'skill'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRelease(source, output), /Symlink/);
  await fs.unlink(path.join(source, 'skill'));
  await fs.rename(originalSkills, path.join(source, 'skill'));
  await prepareRelease(source, output);
  await fs.symlink(foreign, path.join(output, 'source/tests'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyRelease(output), /Symlink/);
  assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'keep');
});

test('missing or misidentified entries fail without requiring a LICENSE or repository address', async t => {
  const { source, output } = await fixture(t);
  await fs.unlink(path.join(source, 'skill/forge-question/SKILL.md'));
  await assert.rejects(prepareRelease(source, output), /Required public file/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  await put(source, 'skill/forge-question/SKILL.md', '---\nname: another-skill\n---');
  await assert.rejects(prepareRelease(source, output), /identity mismatch/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('public command creates and verifies a fixture snapshot; invalid options and extra files fail', async t => {
  const { source, output, temp } = await fixture(t);
  // Run the real entrypoint from an isolated package, so no pending main-agent
  // Markdown edits or license decision can make the command test flaky.
  await put(source, 'scripts/prepare-release.mjs', await fs.readFile(path.join(repo, 'scripts/prepare-release.mjs')));
  await put(source, 'scripts/lib/release.mjs', await fs.readFile(path.join(repo, 'scripts/lib/release.mjs')));
  const cli = path.join(source, 'scripts/prepare-release.mjs');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: temp, encoding: 'utf8' });
  assert.equal(run(['--help']).status, 0);
  for (const args of [[], ['--out'], ['--out', output, '--verify', output], ['--unknown', output], ['--out', '--verify']]) assert.equal(run(args).status, 1);
  const built = run(['--out', output]);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(JSON.parse(built.stdout).skills, skills);
  assert.equal(run(['--verify', output]).status, 0);
  assert.equal(run(['--out', output]).status, 1);
  await put(output, 'extra.txt', 'extra');
  const failed = run(['--verify', output]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /file set/);
});
