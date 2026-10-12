#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease, verifyRelease } from './lib/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/prepare-release.mjs --out <new-directory>\n       node scripts/prepare-release.mjs --verify <release-directory>');
    return;
  }
  if (args.length !== 2 || !['--out', '--verify'].includes(args[0]) || !args[1].trim() || args[1].startsWith('--')) {
    throw new Error('Use --out <new-directory> or --verify <release-directory>.');
  }
  const output = path.resolve(args[1]);
  const manifest = args[0] === '--verify' ? await verifyRelease(output) : await prepareRelease(root, output);
  console.log(JSON.stringify({ output, verified: true, version: manifest.package.version, files: manifest.source.length, skills: manifest.skills, license: manifest.license, archives: manifest.archives.map(entry => entry.path) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Release failed: ${error.message}`); process.exitCode = 1; });
}
