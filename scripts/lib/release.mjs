import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SKILLS = Object.freeze(['forge', 'forge-insights', 'forge-organize', 'forge-question', 'forge-review', 'forge-review-plan']);
const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'GLOSSARY.md', 'AGENTS.md', 'SECURITY.md', 'THIRD_PARTY.md', 'LICENSE', 'NOTICE', 'package.json', '.gitignore', '.gitattributes'];
const DOCS = ['installation', 'github-introduction', 'forge-methods', 'skill-architecture', 'skill-acceptance', 'open-source', 'release-checklist', 'support'].map(name => `docs/${name}.md`);
const FILES = new Set([...ROOT_FILES, ...DOCS, 'docs/assets/forge-preview.jpg']);
const TREES = ['.github', 'bin', 'scripts', 'tests', 'docs/agents', 'docs/adr', 'examples/probability', ...SKILLS.map(name => `skill/${name}`)];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.split(path.sep).join('/');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const record = (name, data) => ({ path: name, bytes: data.length, sha256: sha256(data) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Inspect every component, including missing-leaf ancestors and Windows junctions.
async function plainPath(file) {
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = await statOrNull(cursor);
    if (stat?.isSymbolicLink()) throw new Error(`Symlink path refused: ${cursor}`);
    if (cursor !== file && stat && !stat.isDirectory()) throw new Error(`Not a directory: ${cursor}`);
    if (cursor === path.dirname(cursor)) break;
  }
}

async function safeOutput(root, output) {
  await plainPath(root);
  await plainPath(output);
  const realRoot = await fs.realpath(root);
  let ancestor = output;
  while (!await statOrNull(ancestor)) ancestor = path.dirname(ancestor);
  const realOutput = path.resolve(await fs.realpath(ancestor), path.relative(ancestor, output));
  const dist = path.join(realRoot, 'dist');
  if (realOutput === path.parse(realOutput).root || within(realOutput, realRoot)
      || (within(realRoot, realOutput) && !within(dist, realOutput))) {
    throw new Error('Unsafe output: source, ancestors and source/public directories are forbidden; dist is allowed.');
  }
  if (await statOrNull(output)) throw new Error('Output already exists; never overwrite a release.');
}

function excluded(name) {
  const parts = name.split('/');
  const base = parts.at(-1);
  return parts.some(part => ['.scratch', '.git', 'dist', 'INTENT', 'research', 'validation', 'node_modules', '.forge-install-work'].includes(part))
    || /^(?:\.env(?:\.|$)|\.npmrc$)/i.test(base) || /\.(?:pem|key)$/i.test(base)
    || /\.log$/i.test(base) || /(?:^|[.-])lock(?:$|[.-])/i.test(base) || base === 'package-lock.json'
    || /(?:^|[.-])(?:backup|bak|old|orig)(?:$|[.-])/i.test(base) || /~$/.test(base)
    || /^(?:\.forge-install\.json|\.forge-library\.json|\.DS_Store|Thumbs\.db)$/i.test(base);
}

function allowed(name) {
  return !excluded(name) && (FILES.has(name) || TREES.some(tree => name.startsWith(`${tree}/`)));
}

async function walk(root, prefix = '') {
  const files = [];
  for (const name of (await fs.readdir(path.join(root, prefix))).sort(compare)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${relative}`);
    if (stat.isDirectory()) files.push(...await walk(root, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Non-regular file refused: ${relative}`);
  }
  return files.sort(compare);
}

async function publicFiles(root) {
  const result = [];
  async function visit(name) {
    const stat = await statOrNull(path.join(root, name));
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
    if (excluded(name)) return;
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(path.join(root, name))).sort(compare)) await visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      if (allowed(name)) result.push(name);
    } else throw new Error(`Non-regular file refused: ${name}`);
  }
  for (const name of [...FILES, ...TREES]) {
    // A seed such as skill/forge or docs/installation.md can otherwise hide a
    // symlink in its parent directory, even when the seed itself is regular.
    await plainPath(path.join(root, name));
    await visit(name);
  }
  return result.sort(compare);
}

function withoutFences(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

function destination(text, start) {
  let i = start;
  while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    return end < 0 ? null : text.slice(i + 1, end);
  }
  let end = i;
  let depth = 0;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === '\\') { end++; continue; }
    if (char === '(') depth++;
    if (char === ')') { if (depth === 0) break; depth--; }
    if (/\s/.test(char) && depth === 0) break;
  }
  return text.slice(i, end).replace(/\\([\\()])/g, '$1');
}

function markdownTargets(markdown) {
  const text = withoutFences(markdown);
  const targets = [];
  const references = new Map();
  const normalize = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(.*)$/gm)) {
    const target = destination(match[2], 0);
    if (target) { references.set(normalize(match[1]), target); targets.push(target); }
  }
  // Parentheses in filenames and angle-delimited filenames with spaces are valid.
  for (const match of text.matchAll(/(?<!\\)\[([^\]\n]+)\]\(/g)) {
    const target = destination(text, match.index + match[0].length);
    if (target) targets.push(target);
  }
  for (const match of text.matchAll(/(?<!\\)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    const following = text[match.index + match[0].length];
    if (following === '(' || following === ':') continue;
    const target = references.get(normalize(match[2] || match[1]));
    if (target) targets.push(target);
  }
  return targets;
}

export async function checkSnapshotLinks(root, files) {
  files ??= await walk(root);
  const known = new Set(files);
  const directories = new Set(['']);
  for (const name of files) {
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  }
  const failures = [];
  for (const file of files.filter(name => /\.md$/i.test(name))) {
    for (const target of markdownTargets(await fs.readFile(path.join(root, file), 'utf8'))) {
      if (target.startsWith('#') || target.startsWith('//')) continue;
      if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^(?:file:|[a-z]:[\\/])/i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
      catch { failures.push(`${file} -> ${target} (invalid encoding)`); continue; }
      if (!decoded) continue;
      const resolved = path.resolve(root, path.posix.dirname(file), decoded);
      const relative = slash(path.relative(root, resolved));
      if (/^(?:[\\/]|[a-z]:|file:)/i.test(decoded) || !within(root, resolved)
          || (!known.has(relative) && !directories.has(relative))) failures.push(`${file} -> ${target}`);
    }
  }
  if (failures.length) throw new Error(`Snapshot Markdown links do not resolve within release:\n${failures.join('\n')}`);
}

async function metadata(root, files) {
  for (const name of ['package.json', ...SKILLS.map(skill => `skill/${skill}/SKILL.md`)]) {
    if (!files.includes(name)) throw new Error(`Required public file missing: ${name}`);
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new Error('Package name and version are required.');
  for (const skill of SKILLS) {
    const text = await fs.readFile(path.join(root, 'skill', skill, 'SKILL.md'), 'utf8');
    if (!new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(text)) throw new Error(`Skill identity mismatch: ${skill}`);
  }
  return { package: { name: pkg.name, version: pkg.version }, skills: [...SKILLS],
    license: { status: files.includes('LICENSE') ? 'present' : 'pending', declared: pkg.license ?? null, file: files.includes('LICENSE') ? 'LICENSE' : null } };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Classic ZIP STORE, UTF-8 names, fixed DOS timestamp 1980-01-01 00:00:00.
// No host paths, clock, file modes or filesystem enumeration order enter the ZIP.
function zip(entries) {
  if (entries.length > 0xffff) throw new Error('ZIP32 entry limit exceeded.');
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries.sort((a, b) => compare(a.name, b.name))) {
    const encoded = Buffer.from(name, 'utf8');
    if (encoded.length > 0xffff || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP32 size limit exceeded.');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(encoded.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, encoded);
    offset += header.length + encoded.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length + 22 > 0xffffffff) throw new Error('ZIP32 archive size limit exceeded.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function archives(contents) {
  const main = new Map([...contents].filter(([name]) => name.startsWith('skill/forge/'))
    .map(([name, data]) => [`forge/${name.slice('skill/forge/'.length)}`, data]));
  // Standalone installation carries the repository license/notice. An existing
  // skill-local copy must agree byte for byte; never silently replace terms.
  for (const name of ['LICENSE', 'NOTICE']) {
    const rootFile = contents.get(name);
    if (!rootFile) continue;
    const skillFile = main.get(`forge/${name}`);
    if (skillFile && !skillFile.equals(rootFile)) throw new Error(`Conflicting root and main skill ${name}; refuse to overwrite licensing.`);
    main.set(`forge/${name}`, rootFile);
  }
  return new Map([
    ['source.zip', zip([...contents].map(([name, data]) => ({ name: `forge-source/${name}`, data })))],
    ['forge-skill.zip', zip([...main].map(([name, data]) => ({ name, data })))],
  ]);
}

export async function prepareRelease(sourceRoot, outputPath) {
  const root = path.resolve(sourceRoot);
  const output = path.resolve(outputPath);
  await safeOutput(root, output);
  const files = await publicFiles(root);
  // Capture once: ZIPs and manifests always describe the copied bytes even if
  // another agent changes the working source while this release is assembled.
  const contents = new Map();
  for (const name of files) contents.set(name, await fs.readFile(path.join(root, name)));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await safeOutput(root, output);
  await fs.mkdir(output); // exclusive ownership; never clean up a preexisting path
  const owned = await fs.lstat(output);
  try {
    for (const [name, data] of contents) {
      const target = path.join(output, 'source', name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data, { flag: 'wx' });
    }
    const snapshot = path.join(output, 'source');
    const info = await metadata(snapshot, files);
    await checkSnapshotLinks(snapshot, files);
    const bundles = archives(contents);
    for (const [name, data] of bundles) await fs.writeFile(path.join(output, name), data, { flag: 'wx' });
    const manifest = { schemaVersion: 1, ...info,
      source: [...contents].map(([name, data]) => record(name, data)),
      archives: [...bundles].map(([name, data]) => record(name, data)) };
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await verifyRelease(output);
    return manifest;
  } catch (error) {
    await plainPath(output);
    const current = await statOrNull(output);
    if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) await fs.rm(output, { recursive: true });
    throw error;
  }
}

export async function verifyRelease(outputPath) {
  const output = path.resolve(outputPath);
  await plainPath(output);
  const all = await walk(output);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.source) || !Array.isArray(manifest.archives)) throw new Error('Invalid release manifest.');
  const files = await walk(path.join(output, 'source'));
  if (files.some(name => !allowed(name))) throw new Error('Snapshot contains a file outside the public allowlist.');
  const expected = ['manifest.json', 'source.zip', 'forge-skill.zip', ...files.map(name => `source/${name}`)].sort(compare);
  if (!same(all, expected)) throw new Error('Release file set mismatch: extra or missing files.');
  const contents = new Map();
  for (const name of files) contents.set(name, await fs.readFile(path.join(output, 'source', name)));
  if (!same(manifest.source, [...contents].map(([name, data]) => record(name, data)))) throw new Error('Source hash/bytes/file set mismatch.');
  const info = await metadata(path.join(output, 'source'), files);
  if (!same(manifest.package, info.package) || !same(manifest.skills, info.skills) || !same(manifest.license, info.license)) throw new Error('Release metadata mismatch.');
  await checkSnapshotLinks(path.join(output, 'source'), files);
  const bundles = archives(contents);
  const records = [];
  for (const [name, expectedZip] of bundles) {
    const data = await fs.readFile(path.join(output, name));
    if (!data.equals(expectedZip)) throw new Error(`ZIP content/file set mismatch: ${name}`);
    records.push(record(name, data));
  }
  if (!same(manifest.archives, records)) throw new Error('ZIP hash/bytes/file set mismatch.');
  return manifest;
}
