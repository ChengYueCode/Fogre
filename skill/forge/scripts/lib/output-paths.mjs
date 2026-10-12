import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmberError, CODES } from './errors.mjs';

const ownSkill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillNames = new Set(['forge', 'forge-organize', 'forge-question', 'forge-review', 'forge-review-plan', 'forge-insights']);

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Resolve existing ancestors too: a junction can redirect a not-yet-created
// output directory into a skill.
function canonical(file) {
  let ancestor = file;
  const suffix = [];
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      // A dangling link exists lexically and must fail realpath, rather than
      // masquerading as an ordinary not-yet-created output directory.
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function insideSkill(file) {
  if (within(canonical(ownSkill), file)) return true;
  for (let dir = file; ; dir = path.dirname(dir)) {
    try {
      const name = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^name:\s*(\S+)\s*$/m)?.[1];
      if (skillNames.has(name)) return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    if (dir === path.dirname(dir)) return false;
  }
}

export function assertLearningOutput(value, label = '输出路径') {
  if (typeof value !== 'string' || !value.trim()) throw new EmberError(CODES.USAGE, `${label} 需要明确的路径`);
  const resolved = path.resolve(value);
  try {
    if (insideSkill(resolved) || insideSkill(canonical(resolved))) {
      throw new EmberError(CODES.USAGE, `${label} 不能位于 Forge 技能目录内：${resolved}；请选择自己的学习目录`);
    }
  } catch (error) {
    if (error instanceof EmberError) throw error;
    throw new EmberError(CODES.IO, `${label} 不可解析 ${resolved}：${error.message}`);
  }
  return resolved;
}
