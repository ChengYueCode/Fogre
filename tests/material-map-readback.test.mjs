// Public readback regression: no author report must mean unknown coverage,
// consistently in CLI and the generated page. No learner records are authored.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'skill/forge/scripts/forge.mjs');

test('quality-read without a report explicitly returns unknown material coverage without writing', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-map-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  function run(args) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  run(['build', path.join(root, 'skill/forge/assets/probability.json'), '--out', out]);
  const before = fs.readFileSync(path.join(out, 'state.json'));
  const view = run(['quality-read', '--out', out]);
  assert.equal(view.present, false);
  assert.equal(view.materialMap.present, false);
  assert.equal(view.materialMap.coverageKnown, false);
  assert.ok(view.materialMap.staleReasons.some((reason) => reason.includes('未知')));
  assert.deepEqual(view.materialMap.sources, []);
  assert.deepEqual(fs.readFileSync(path.join(out, 'state.json')), before);
  assert.equal(fs.existsSync(path.join(out, 'quality.json')), false);
});
