import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Resolve ancestor aliases, but refuse a symlink as the final skill directory.
async function checkTarget(target) {
  if (target === path.parse(target).root) throw new Error('目标不能是文件系统根目录。');
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    const stat = await statOrNull(cursor);
    if (cursor === target && stat?.isSymbolicLink()) throw new Error(`技能目标本身不能是符号链接：${cursor}`);
    if (stat) {
      let followed;
      try { followed = await fs.stat(cursor); }
      catch (error) {
        if (['ENOENT', 'ELOOP'].includes(error.code)) throw new Error(`目标路径包含失效的符号链接：${cursor}`, { cause: error });
        throw error;
      }
      if (!followed.isDirectory()) throw new Error(`目标路径不是目录：${cursor}`);
    }
    if (cursor === path.dirname(cursor)) break;
  }
  const realPackage = await fs.realpath(packageRoot);
  // Resolve existing ancestors to catch aliases beyond ordinary symlinks.
  let ancestor = target;
  while (!(await statOrNull(ancestor))) ancestor = path.dirname(ancestor);
  let realAncestor;
  try { realAncestor = await fs.realpath(ancestor); }
  catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) throw new Error(`目标路径包含失效的符号链接：${ancestor}`, { cause: error });
    throw error;
  }
  const realTarget = path.resolve(realAncestor, path.relative(ancestor, target));
  if (within(realPackage, realTarget) || within(realTarget, realPackage)) {
    throw new Error('目标不能位于 npm 包内，也不能包含当前包。');
  }
  return realTarget;
}

// The installable pieces are the forge main skill and the generated
// single-capability entries: every skill/ directory that ships a SKILL.md.
async function availableSkills() {
  const out = [];
  for (const name of (await fs.readdir(path.join(packageRoot, 'skill'))).sort()) {
    if ((await statOrNull(path.join(packageRoot, 'skill', name, 'SKILL.md')))?.isFile()) out.push(name);
  }
  return out;
}

async function readJsonOrNull(file) {
  const stat = await statOrNull(file);
  if (!stat?.isFile()) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}

// The identity a host discovers: the `name:` field of the sibling's SKILL.md.
async function readSkillName(dir) {
  const stat = await statOrNull(path.join(dir, 'SKILL.md'));
  if (!stat?.isFile()) return null;
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return text.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export async function installSkill(args) {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
    return { usage: 'forge install-skill --target <技能完整目录> [--skill <forge|forge-question|...>] [--upgrade]', note: '目标必须是单个技能目录，升级保留原目录备份；每个入口都是独立技能，用 --skill 选择，缺省为主技能 forge。' };
  }
  let targetInput;
  let skillId;
  let upgrade = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && targetInput === undefined && args[i + 1] && !args[i + 1].startsWith('--')) targetInput = args[++i];
    else if (args[i] === '--skill' && skillId === undefined && args[i + 1] && !args[i + 1].startsWith('--')) skillId = args[++i];
    else if (args[i] === '--upgrade' && !upgrade) upgrade = true;
    else throw new Error(`无效或重复参数：${args[i]}`);
  }
  if (skillId === undefined) skillId = 'forge';
  const skills = await availableSkills();
  if (!skills.includes(skillId)) throw new Error(`未知技能身份：${skillId}；本包可安装：${skills.join(', ')}`);
  const source = path.join(packageRoot, 'skill', skillId);
  const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!targetInput?.trim()) throw new Error('请用 --target 指定技能完整目录，例如 ./skills/forge。');
  const target = await checkTarget(path.resolve(targetInput));
  const existing = await statOrNull(target);
  if (existing && !upgrade) throw new Error('目标已存在；显式使用 --upgrade 才会备份并替换。');
  if (existing) {
    const entry = await statOrNull(path.join(target, 'SKILL.md'));
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error('升级目标必须是包含普通 SKILL.md 文件的单个技能目录。');
    const text = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8');
    if (!new RegExp(`^name:\\s*${skillId}\\s*$`, 'm').test(text)) {
      throw new Error(`升级目标的技能身份必须为 ${skillId}（主技能与各入口是彼此独立的技能身份）。`);
    }
    const manifest = await readJsonOrNull(path.join(target, '.forge-install.json'));
    if (manifest && manifest.skill !== skillId) {
      throw new Error(`升级目标记录的技能身份是 ${manifest.skill}，与本次要安装的 ${skillId} 不同；请核对目标目录。`);
    }
  }
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  // An exclusive sibling lock coordinates concurrent installer invocations.
  const lock = `${target}.forge-install-lock`;
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`安装锁已存在：${lock}；确认没有安装进程后再处理。`); throw error; }
  // Keep full skill copies outside the host's skill root, so discovery sees one skill.
  const workRoot = path.join(path.dirname(parent), '.forge-install-work');
  let transaction;
  let staging;
  let backup = null;
  let moved = false;
  try {
    await checkTarget(workRoot);
    await fs.mkdir(workRoot, { recursive: true });
    transaction = path.join(workRoot, `${path.basename(target)}-${randomUUID()}`);
    await fs.mkdir(transaction);
    staging = path.join(transaction, 'staging');
    backup = existing ? path.join(transaction, 'backup') : null;
    await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    // The manifest makes every installed piece self-describing: the version
    // guard below (and any future audit) can see which package produced it.
    await fs.writeFile(path.join(staging, '.forge-install.json'),
      `${JSON.stringify({ skill: skillId, version }, null, 2)}\n`, 'utf8');
    await checkTarget(target);
    const current = await statOrNull(target);
    if (Boolean(current) !== Boolean(existing)) throw new Error('安装期间目标发生变化，请重新核对。');
    if (existing) { await fs.rename(target, backup); moved = true; }
    try { await fs.rename(staging, target); }
    catch (error) {
      if (moved) {
        try { await fs.rename(backup, target); moved = false; }
        catch (recovery) { throw new Error(`安装失败且恢复失败；原目录保存在 ${backup}：${recovery.message}`, { cause: error }); }
      }
      throw error;
    }
    // Version guard (P06): never silently mix versions inside one host. Any
    // sibling forge-family piece whose recorded version differs from the piece
    // just installed is reported, as is any sibling already exposing the same
    // skill identity (e.g. a legacy directory kept under an old name). The
    // install itself succeeds; aligning the reported pieces is explicit work.
    const versionMismatches = [];
    const identityCollisions = [];
    for (const name of (await fs.readdir(parent)).sort()) {
      const sibling = path.join(parent, name);
      if (name === path.basename(target) || !(await statOrNull(sibling))?.isDirectory()) continue;
      const manifest = await readJsonOrNull(path.join(sibling, '.forge-install.json'));
      if (manifest && (manifest.skill === 'forge' || String(manifest.skill ?? '').startsWith('forge-'))
        && manifest.version !== version) {
        versionMismatches.push({ skill: manifest.skill, version: manifest.version ?? null, dir: sibling });
      }
      const siblingSkill = await readSkillName(sibling);
      if (siblingSkill === skillId) identityCollisions.push({ skill: siblingSkill, dir: sibling });
    }
    return { installed: target, backup, skill: skillId, version, versionMismatches, identityCollisions };
  } finally {
    try {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
      if (transaction && (!backup || !await statOrNull(backup))) await fs.rmdir(transaction);
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
}
