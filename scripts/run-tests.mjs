#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Node 20 on Windows does not expand CLI globs. Enumerate files here so npm
// supplies the same environment and test set on every supported platform.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => path.join(root, 'tests', name));
if (files.length === 0) throw new Error('No test files found.');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
