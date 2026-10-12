import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installSkill } from '../scripts/install-skill.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'bin/forge.mjs');

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

async function temporary(prefix) {
  // The installer returns real paths; Windows runner temp roots can differ
  // in case or use short aliases. Match the same filesystem identity.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('explicit installation refuses overwrite, preserves upgrade backup, and rolls back rename failure', async () => {
  const temp = await temporary('forge-install-');
  const target = path.join(temp, 'skills with spaces', 'forge');
  const originalRename = fs.rename;
  try {
    assert.equal((await installSkill(['--target', target])).backup, null);
    await fs.writeFile(path.join(target, 'local-note.txt'), '保留旧目录');
    await assert.rejects(installSkill(['--target', target]), /目标已存在/);
    fs.rename = async (from, to) => {
      if (path.basename(from) === 'staging' && to === target) throw new Error('simulated rename failure');
      return originalRename(from, to);
    };
    await assert.rejects(installSkill(['--target', target, '--upgrade']), /simulated/);
    fs.rename = originalRename;
    assert.equal(await fs.readFile(path.join(target, 'local-note.txt'), 'utf8'), '保留旧目录');
    const result = await installSkill(['--target', target, '--upgrade']);
    assert.ok(!result.backup.startsWith(`${path.dirname(target)}${path.sep}`));
    assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ['forge']);
    assert.equal(await fs.readFile(path.join(result.backup, 'local-note.txt'), 'utf8'), '保留旧目录');
    await assert.rejects(fs.access(path.join(target, 'local-note.txt')));
    const output = path.join(temp, 'learning');
    run([path.join(target, 'scripts/forge.mjs'), 'build', path.join(target, 'assets/probability.json'), '--out', output, '--svg'], temp);
    for (const name of ['index.html', 'state.json', 'model.json', 'map.excalidraw', 'map.svg']) await fs.access(path.join(output, name));
  } finally {
    fs.rename = originalRename;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('installer rejects broad, foreign, aliased and locked targets', async () => {
  const temp = await temporary('forge-guard-');
  try {
    await assert.rejects(installSkill([]), /--target/);
    await assert.rejects(installSkill(['--target', root]), /npm 包/);
    await assert.rejects(installSkill(['--target', path.parse(root).root]), /根目录/);
    const foreign = path.join(temp, 'foreign');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'SKILL.md'), '---\nname: other\n---\n');
    await assert.rejects(installSkill(['--target', foreign, '--upgrade']), /身份/);
    const alias = path.join(temp, 'alias');
    await fs.symlink(foreign, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installSkill(['--target', alias]), /符号链接/);
    const aliased = await installSkill(['--target', path.join(alias, 'forge')]);
    assert.equal(aliased.installed, path.join(await fs.realpath(foreign), 'forge'));
    const dangling = path.join(temp, 'dangling');
    await fs.symlink(path.join(temp, 'nonexistent'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installSkill(['--target', path.join(dangling, 'forge')]), /失效的符号链接/);
    const locked = path.join(temp, 'locked');
    await fs.writeFile(`${locked}.forge-install-lock`, '');
    await assert.rejects(installSkill(['--target', locked]), /安装锁/);
    await assert.rejects(fs.access(locked));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('real npm tarball installs a runnable CLI and complete standalone skill', async () => {
  assert.ok(process.env.npm_execpath, 'Run via npm run test:distribution or npm test to supply npm_execpath');
  const temp = await temporary('forge-npm-');
  try {
    const npm = process.env.npm_execpath;
    const packResult = JSON.parse(run([npm, 'pack', '--json', '--pack-destination', temp]));
    const pack = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
    const files = pack.files.map(file => file.path);
    assert.ok(files.includes('.claude-plugin/plugin.json'), 'npm distribution preserves the grouped skill catalog');
    const catalog = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(catalog.name, 'forge-skills');
    assert.deepEqual([...catalog.skills].sort(), ['forge', 'forge-organize', 'forge-question', 'forge-review', 'forge-review-plan', 'forge-insights'].map(name => `./skill/${name}`).sort());
    for (const directory of catalog.skills) assert.ok(files.includes(`${directory.slice(2)}/SKILL.md`), 'every menu entry ships with its real skill');
    assert.ok(files.includes('skill/forge/SKILL.md'));
    assert.ok(files.includes('skill/forge/assets/viewer.html'));
    for (const entry of ['forge-question', 'forge-review', 'forge-review-plan', 'forge-insights', 'forge-organize']) {
      assert.ok(files.includes(`skill/${entry}/SKILL.md`), `the tarball must ship the ${entry} entry`);
    }
    assert.ok(files.includes('bin/forge.mjs'));
    assert.ok(files.includes('docs/skill-architecture.md'), 'linked architecture documentation must ship in the package');
    assert.ok(files.every(file => /^(package\.json|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|GLOSSARY\.md|SECURITY\.md|THIRD_PARTY\.md|LICENSE|\.claude-plugin\/plugin\.json$|bin\/|scripts\/install-skill\.mjs|skill\/|docs\/(installation|skill-architecture|open-source|skill-acceptance|support|release-checklist|forge-methods|github-introduction)\.md)/.test(file)));
    assert.ok(files.every(file => !/(^|\/)(debug\.log|\.scratch|\.env|state\.v1\.backup\.json)(\/|$)/.test(file)), 'private files never ship');
    const prefix = path.join(temp, 'npm prefix');
    run([npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, pack.filename)], temp);
    // Exercise npm's generated command shim, including Windows paths with spaces.
    const shim = path.join(prefix, process.platform === 'win32' ? 'forge.cmd' : 'bin/forge');
    const command = process.platform === 'win32' ? process.env.ComSpec : shim;
    const help = spawnSync(command, process.platform === 'win32' ? ['/d', '/s', '/c', `""${shim}" help"`] : ['help'], { cwd: temp, encoding: 'utf8', windowsVerbatimArguments: process.platform === 'win32' });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /install-skill/);
    const installedBin = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'forge-learning-local/bin/forge.mjs');
    assert.equal(run([installedBin, '--version'], temp).trim(), '0.1.0');
    const skill = path.join(temp, 'host', 'forge');
    const installed = JSON.parse(run([installedBin, 'install-skill', '--target', skill], temp));
    assert.equal(installed.installed, skill);
    assert.equal(installed.skill, 'forge');
    assert.equal(installed.version, '0.1.0');
    assert.equal(await fs.readFile(path.join(skill, 'LICENSE'), 'utf8'), await fs.readFile(path.join(root, 'LICENSE'), 'utf8'), 'standalone main install preserves MIT notice');
    // One entry install through the real npm CLI: identity, manifest, and a
    // runnable entry-local CLI (the question entry is conversation-only).
    const question = path.join(temp, 'host', 'forge-question');
    const entry = JSON.parse(run([installedBin, 'install-skill', '--target', question, '--skill', 'forge-question'], temp));
    assert.equal(entry.skill, 'forge-question');
    assert.equal(await fs.readFile(path.join(question, 'LICENSE'), 'utf8'), await fs.readFile(path.join(root, 'LICENSE'), 'utf8'), 'independent conversation-only install preserves MIT notice');
    assert.deepEqual(entry.versionMismatches, []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(question, '.forge-install.json'), 'utf8')),
      { skill: 'forge-question', version: '0.1.0' });
    assert.deepEqual(await fs.readdir(path.join(question, 'references')), ['socratic-questioning-standalone.md']);
    await assert.rejects(fs.access(path.join(question, 'scripts')));
    run([installedBin, 'validate', path.join(skill, 'assets/probability.json')], temp);
    run([installedBin, 'build', path.join(skill, 'assets/probability.json'), '--out', path.join(temp, 'artifacts')], temp);
    await fs.access(path.join(temp, 'artifacts/state.json'));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('entry installs are identity-checked and version-guarded (P06 reports, never silently mixes)', async () => {
  const temp = await temporary('forge-entries-');
  try {
    const host = path.join(temp, 'host');
    // A legacy sibling kept under an old directory name but exposing the main
    // skill identity: the installer must report the collision, not hide it.
    const legacy = path.join(host, 'legacy-ember');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'SKILL.md'), '---\nname: forge\n---\n旧版主技能', 'utf8');

    const main = await installSkill(['--target', path.join(host, 'forge')]);
    assert.deepEqual(main.versionMismatches, []);
    assert.deepEqual(main.identityCollisions, [{ skill: 'forge', dir: legacy }]);

    const reviewPlan = path.join(host, 'forge-review-plan');
    await installSkill(['--target', reviewPlan, '--skill', 'forge-review-plan']);
    const help = spawnSync(process.execPath, [path.join(reviewPlan, 'scripts/forge.mjs'), 'help'], { cwd: temp, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);

    await assert.rejects(installSkill(['--target', path.join(host, 'other'), '--skill', 'nope']), /未知技能身份/);
    await assert.rejects(installSkill(['--target', reviewPlan, '--upgrade']), /身份必须为 forge/);

    // A sibling left at an older version (manifest tampered to simulate drift)
    // is reported by the next install in the same host root.
    const manifestPath = path.join(reviewPlan, '.forge-install.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.version = '9.9.9';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const insights = await installSkill(['--target', path.join(host, 'forge-insights'), '--skill', 'forge-insights']);
    assert.deepEqual(insights.versionMismatches, [{ skill: 'forge-review-plan', version: '9.9.9', dir: reviewPlan }]);
    assert.deepEqual(insights.identityCollisions, []);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
