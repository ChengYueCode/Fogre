// Phase-2 standalone-entry tests. The generated entries under skill/<name>/ are
// build artifacts derived from the ONE authoritative body set in
// skill/forge/references/; these tests pin the generation contract: byte
// determinism, declared self-contained pieces, untouched sources, and
// link self-consistency. No learner data is involved here.
//
// Run: node --test tests/entries.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildEntries, checkEntries, entryNames } from '../scripts/build-entries.mjs';
import { checkLinks } from '../scripts/check-links.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-entry-tests-'));
const generate = () => buildEntries({ skillDir: SKILL });
generate();
after(() => fs.rmSync(SKILL, { recursive: true, force: true }));
const AUTO_MARK = '本文件由 scripts/build-entries.mjs 自动生成';

function hashTree(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      // Concurrent CLI tests create transient archive locks next to a model
      // file; they are runtime state, never part of the skill tree.
      if (name === '.ember-lock' || name === '.ember-lock.recovery') continue;
      const file = path.join(current, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files[path.relative(dir, file).replaceAll('\\', '/')] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return files;
}

function entrySkillMd(name) {
  return fs.readFileSync(path.join(SKILL, name, 'SKILL.md'), 'utf8');
}

test('P01 regeneration is byte-stable and every generated markdown carries the auto-generation header', () => {
  generate(); // normalize the tree first so the comparison below measures
  const before = {}; // generator determinism, not prior tree freshness
  for (const name of entryNames()) before[name] = hashTree(path.join(SKILL, name));
  generate();
  for (const name of entryNames()) {
    assert.deepEqual(hashTree(path.join(SKILL, name)), before[name], `${name} must regenerate to identical bytes`);
  }
  for (const name of entryNames()) {
    const files = Object.keys(hashTree(path.join(SKILL, name))).filter((file) => file.endsWith('.md'));
    assert.ok(files.length >= 1);
    for (const file of files) {
      const text = fs.readFileSync(path.join(SKILL, name, file), 'utf8');
      assert.ok(text.includes(AUTO_MARK), `${name}/${file} must carry the auto-generation header`);
    }
  }
});

test('each entry is self-contained with its declared pieces and a matching unique skill name', () => {
  const names = entryNames();
  assert.deepEqual(names, ['forge-question', 'forge-review', 'forge-review-plan', 'forge-insights', 'forge-organize']);
  const seen = new Set();
  for (const name of names) {
    const text = entrySkillMd(name);
    const frontmatter = text.slice(0, text.indexOf('---', 3));
    assert.match(frontmatter, new RegExp(`^name: ${name}$`, 'm'), 'frontmatter name must match the directory name');
    assert.ok(!seen.has(frontmatter.match(/^name: (.+)$/m)[1]), 'skill names must be unique');
    seen.add(frontmatter.match(/^name: (.+)$/m)[1]);
    assert.match(frontmatter, /^description: .{40,}/m, 'the description must carry routing triggers');
    assert.ok(fs.existsSync(path.join(SKILL, name, 'references')), 'rules must be available for progressive reading');
    const ui = fs.readFileSync(path.join(SKILL, name, 'agents', 'openai.yaml'), 'utf8');
    const prompt = JSON.parse(ui.match(/^  default_prompt: (.+)$/m)[1]);
    assert.ok(prompt.startsWith(`/${name} `), 'UI invocation must address this independent entry');
    assert.ok(text.includes(prompt), 'UI prompt must match an actual entry example');
  }
  // Declared pieces per the phase-2 spec table.
  assert.deepEqual(fs.readdirSync(path.join(SKILL, 'forge-question', 'references')), ['socratic-questioning-standalone.md']);
  assert.ok(!fs.existsSync(path.join(SKILL, 'forge-question', 'scripts')), 'the question entry is conversation-only');
  for (const name of ['forge-review', 'forge-review-plan', 'forge-insights', 'forge-organize']) {
    assert.ok(fs.existsSync(path.join(SKILL, name, 'scripts', 'forge.mjs')), `${name} must carry its own CLI`);
  }
  assert.ok(fs.existsSync(path.join(SKILL, 'forge-organize', 'assets', 'viewer.html')));
  assert.ok(fs.existsSync(path.join(SKILL, 'forge-organize', 'references', 'content-quality.md')));
  assert.ok(fs.existsSync(path.join(SKILL, 'forge-review', 'references', 'evidence-and-review.md')));
});

test('generation never touches the forge main skill sources', () => {
  const source = path.join(ROOT, 'skill', 'forge');
  const before = hashTree(source);
  generate();
  assert.deepEqual(hashTree(source), before);
});

test('P02 every relative markdown link resolves within each independently installable entry', async () => {
  const result = checkLinks([SKILL, 'README.md']);
  assert.deepEqual(result.broken, []);
  assert.ok(result.links >= 150, `expected the full link set, got ${result.links}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolated-entry-'));
  try {
    for (const name of entryNames()) {
      // Each isolated host has only this skill, no main skill or siblings.
      const target = path.join(temporary, name, 'skills', name);
      fs.cpSync(path.join(SKILL, name), target, { recursive: true });
      const installed = checkLinks([target]);
      assert.deepEqual(installed.broken, [], `${name} must resolve its own reference graph`);
      assert.deepEqual(fs.readdirSync(path.dirname(target)), [name]);
      if (name === 'forge-question') continue;
      const output = path.join(temporary, name, 'learning output');
      const built = spawnSync(process.execPath, [path.join(target, 'scripts/forge.mjs'), 'build',
        path.join(target, 'assets/probability.json'), '--out', output], { encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr || built.stdout);
      assert.ok(fs.existsSync(path.join(output, 'index.html')), `${name} must rebuild without external assets`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('stale entry checks report differences without rewriting existing files', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-check-readonly-'));
  try {
    buildEntries({ skillDir: temporary });
    const stale = path.join(temporary, 'forge-question', 'SKILL.md');
    fs.appendFileSync(stale, '\nlocal change retained for inspection\n');
    const before = hashTree(temporary);
    const result = checkEntries(temporary);
    assert.ok(result.changed.includes('forge-question/SKILL.md'));
    assert.deepEqual(hashTree(temporary), before);
    fs.rmSync(path.join(temporary, 'forge-insights'), { recursive: true });
    assert.ok(checkEntries(temporary).changed.includes('forge-insights/SKILL.md'));
    assert.ok(!fs.existsSync(path.join(temporary, 'forge-insights')), 'checking must not recreate a missing entry');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
