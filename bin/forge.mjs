#!/usr/bin/env node
import { installSkill } from '../scripts/install-skill.mjs';

const args = process.argv.slice(2);
if (args[0] === 'install-skill') {
  try {
    console.log(JSON.stringify(await installSkill(args.slice(1))));
  } catch (error) {
    console.error(`forge install-skill: ${error.message}`);
    process.exitCode = 1;
  }
} else if (args[0] === '--version' || args[0] === '-v') {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log('npm 入口：forge install-skill --target <技能完整目录> [--skill <forge|forge-question|...>] [--upgrade]');
    console.log('安装器仅在显式调用时复制技能；已有目录默认拒绝覆盖。每个单项入口是独立技能，用 --skill 安装。forge --version 查看包版本。\n');
    process.argv[2] = 'help';
  }
  await import('../skill/forge/scripts/forge.mjs');
}
