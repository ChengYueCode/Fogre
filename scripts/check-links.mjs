#!/usr/bin/env node
// Check the main skill, generated entries and public user/maintenance docs.
// Release snapshots separately verify their complete copied Markdown set.
//
// Usage: node scripts/check-links.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Markdown links outside fences are real references; a `](x.md)` inside a
// fenced block is shell output or example text, not a link to check.
export function extractLinks(markdown) {
  const links = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) links.push(match[2]);
  }
  return links;
}

export function checkLinks(roots = ['skill', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY.md', 'docs/installation.md', 'docs/github-introduction.md', 'docs/forge-methods.md', 'docs/skill-architecture.md', 'docs/skill-acceptance.md', 'docs/open-source.md', 'docs/release-checklist.md', 'docs/support.md', 'docs/visual-showcase.md', 'docs/assets/showcase', 'docs/agents', 'docs/adr', 'examples']) {
  const broken = [];
  let files = 0;
  let links = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (file.endsWith('.md')) checkFile(file);
    }
  };
  const checkFile = (file) => {
    files += 1;
    const markdown = fs.readFileSync(file, 'utf8');
    for (const target of extractLinks(markdown)) {
      if (/^[a-z]+:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
      links += 1;
      const resolved = path.resolve(path.dirname(file), decodeURI(target.split('#')[0]));
      if (!fs.existsSync(resolved)) broken.push(`${path.relative(ROOT, file)} -> ${target}`);
    }
  };
  for (const root of roots) {
    const file = path.resolve(ROOT, root);
    if (fs.statSync(file).isDirectory()) walk(file);
    else checkFile(file);
  }
  return { files, links, broken };
}

function main() {
  const result = checkLinks();
  if (result.broken.length > 0) {
    console.error(`${result.broken.length} 个断链：\n${result.broken.map((line) => `  ${line}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`链接自洽：${result.files} 个 markdown 文件、${result.links} 个相对链接 0 断链。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
