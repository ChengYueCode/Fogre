// Public path contracts; all models and archives are isolated test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createEmberServer } from '../skill/forge/scripts/lib/server.mjs';
import { buildArtifacts } from '../skill/forge/scripts/lib/build.mjs';
import { registerTopic } from '../skill/forge/scripts/lib/library.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repo, 'skill/forge');
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-output-path-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'installed forge');
  fs.cpSync(source, skill, { recursive: true, filter: file => !['.ember-lock', '.ember-lock.recovery'].includes(path.basename(file)) });
  const workspace = path.join(root, 'learner workspace');
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(skill, 'assets/probability.json'), path.join(workspace, 'input.json'));
  const cli = path.join(skill, 'scripts/forge.mjs');
  const run = (args, cwd = workspace, ok = true, executable = cli) => {
    const result = spawnSync(process.execPath, [executable, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, ok ? 0 : 1, result.stderr || result.stdout);
    return ok ? JSON.parse(result.stdout) : result.stderr;
  };
  return { root, skill, workspace, cli, run };
}
function tree(dir) {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, data] of Object.entries(tree(file))) result[`${entry.name}/${name}`] = data;
    } else result[entry.name] = fs.readFileSync(file).toString('base64');
  }
  return result;
}

test('relative outputs use command cwd; absolute outputs and the npm wrapper preserve the chosen location', t => {
  const { root, skill, workspace, run } = setup(t);
  const before = tree(skill);
  assert.match(run(['build', 'input.json'], workspace, false), /缺少 --out/);
  assert.deepEqual(fs.readdirSync(workspace), ['input.json']);
  const first = run(['build', 'input.json', '--out', 'learning/topic', '--svg']);
  assert.equal(first.html, path.join(workspace, 'learning/topic/index.html'));
  const other = path.join(root, 'other workspace');
  fs.mkdirSync(other);
  const second = run(['build', path.join(workspace, 'input.json'), '--out', path.join(workspace, 'learning/topic')], other);
  assert.equal(second.html, first.html);
  const wrapped = run(['build', path.join(workspace, 'input.json'), '--out', 'wrapped'], other, true, path.join(repo, 'bin/forge.mjs'));
  assert.equal(wrapped.html, path.join(other, 'wrapped/index.html'));
  assert.deepEqual(tree(skill), before, 'executing a skill does not relocate learning data into its installation');
});

test('state, scene, exports and quality drafts are cwd-relative; import state is an input', t => {
  const { workspace, run } = setup(t);
  const result = run(['build', 'input.json', '--out', 'pages', '--state', 'records/custom.json', '--scene', 'drawings/custom.excalidraw']);
  assert.equal(result.state, path.join(workspace, 'records/custom.json'));
  assert.equal(result.scene, path.join(workspace, 'drawings/custom.excalidraw'));
  assert.ok(!fs.existsSync(path.join(workspace, 'pages/state.json')));
  assert.ok(!fs.existsSync(path.join(workspace, 'pages/map.excalidraw')));
  assert.match(run(['export', '--out', 'pages', '--state', 'records/custom.json'], workspace, false), /缺少 --to/);
  run(['export', '--out', 'pages', '--state', 'records/custom.json', '--to', 'backups/export.json']);
  const incoming = fs.readFileSync(path.join(workspace, 'backups/export.json'));
  run(['build', 'input.json', '--out', 'receiver']);
  const imported = run(['import', '--out', 'receiver', '--state', 'backups/export.json']);
  assert.equal(imported.state, path.join(workspace, 'receiver/state.json'));
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'backups/export.json')), incoming);
  run(['quality-template', '--out', 'receiver', '--to', 'reports/quality.json']);
  assert.ok(fs.existsSync(path.join(workspace, 'reports/quality.json')));
  assert.ok(!fs.existsSync(path.join(workspace, 'receiver/quality.json')));
  const before = tree(workspace);
  const preview = run(['quality-template', '--out', 'receiver']);
  assert.equal(preview.modelId, JSON.parse(fs.readFileSync(path.join(workspace, 'input.json'), 'utf8')).id);
  assert.deepEqual(tree(workspace), before, 'omitting template --to only prints a preview');
});

test('catalog default is caller-local; catalog-relative topic pointers work from another cwd', t => {
  const { root, workspace, run } = setup(t);
  run(['build', 'input.json', '--out', 'topics/one']);
  const registered = run(['library', 'register', '--topic', 'one', '--out', 'topics/one']);
  assert.equal(registered.catalog, path.join(workspace, 'learning/learning-index.json'));
  assert.equal(registered.topic.directory, path.join('..', 'topics', 'one'));
  const other = path.join(root, 'another workspace'); fs.mkdirSync(other);
  assert.equal(run(['library', 'list'], other).present, false);
  const list = run(['library', 'list', '--catalog', registered.catalog], other);
  assert.equal(list.topics[0].directory, path.join(workspace, 'topics/one'));
  assert.ok(!fs.existsSync(path.join(other, 'learning')));
  run(['library', 'register', '--topic', 'one', '--out', 'topics/one', '--catalog', 'lists/catalog.json']);
  assert.ok(fs.existsSync(path.join(workspace, 'lists/catalog.json')));
});

test('all learning writers refuse skill destinations before creating files, including alternate destinations', t => {
  const { skill, workspace, run } = setup(t);
  const before = tree(skill);
  const forbidden = path.join(skill, 'learner-output');
  for (const command of ['build', 'serve', 'submit', 'practice', 'correction', 'correction-record', 'review', 'assess', 'evidence', 'round', 'interaction', 'review-start', 'review-item', 'import', 'restore', 'quality-write']) {
    assert.match(run([command, 'input.json', '--out', forbidden], workspace, false), /不能位于 Forge 技能目录内/, command);
  }
  for (const flag of ['state', 'scene']) {
    assert.match(run(['build', 'input.json', '--out', 'not-created', `--${flag}`, path.join(skill, `custom.${flag}`)], workspace, false), /不能位于 Forge 技能目录内/);
  }
  for (const command of ['export', 'quality-template']) {
    assert.match(run([command, '--out', 'not-created', '--to', path.join(skill, 'report.json')], workspace, false), /不能位于 Forge 技能目录内/);
  }
  assert.match(run(['library', 'register', '--topic', 'x', '--out', workspace], skill, false), /不能位于 Forge 技能目录内/);
  assert.match(run(['library', 'remove', '--topic', 'x', '--catalog', path.join(skill, 'catalog.json')], workspace, false), /不能位于 Forge 技能目录内/);
  assert.deepEqual(tree(skill), before);
  assert.deepEqual(fs.readdirSync(workspace), ['input.json']);
});

test('junction aliases and another installed Forge skill cannot bypass output protection', t => {
  const { root, skill, workspace, run } = setup(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(skill, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(run(['build', 'input.json', '--out', path.join(alias, 'new-output')], workspace, false), /不能位于 Forge 技能目录内/);
  const dangling = path.join(root, 'dangling alias');
  fs.symlinkSync(path.join(skill, 'missing-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(run(['build', 'input.json', '--out', path.join(dangling, 'new-output')], workspace, false), /不可解析/);
  assert.ok(!fs.existsSync(path.join(skill, 'missing-target')));
  const sibling = path.join(root, 'forge-insights'); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'SKILL.md'), '---\nname: forge-insights\n---\n');
  assert.match(run(['build', 'input.json', '--out', path.join(sibling, 'new-output')], workspace, false), /不能位于 Forge 技能目录内/);
  assert.throws(() => buildArtifacts({ modelPath: path.join(workspace, 'input.json'), outDir: path.join(skill, 'new-output') }), /不能位于 Forge 技能目录内/);
  assert.throws(() => createEmberServer({ dir: workspace, statePath: path.join(skill, 'state.json') }), /不能位于 Forge 技能目录内/);
  assert.ok(!fs.existsSync(path.join(skill, 'new-output')));
});

test('registration refuses a legacy archive inside a skill even when the catalog is outside', async t => {
  const { root, workspace, run } = setup(t);
  run(['build', 'input.json', '--out', 'existing']);
  const legacy = path.join(root, 'legacy forge');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: forge\n---\n');
  fs.cpSync(path.join(workspace, 'existing'), path.join(legacy, 'learning'), { recursive: true });
  const before = tree(legacy);
  const catalog = path.join(workspace, 'new-catalog/index.json');
  assert.match(run(['library', 'register', '--topic', 'legacy', '--out', path.join(legacy, 'learning'), '--catalog', catalog], workspace, false), /不能位于 Forge 技能目录内/);
  await assert.rejects(registerTopic(catalog, 'legacy', path.join(legacy, 'learning'), () => {}), /不能位于 Forge 技能目录内/);
  assert.deepEqual(tree(legacy), before);
  assert.ok(!fs.existsSync(path.dirname(catalog)), 'registration fails before creating a catalog directory or lock');
});
