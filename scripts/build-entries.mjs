#!/usr/bin/env node
// Generate the standalone single-capability forge entries (skill/forge-question/
// and siblings) from the ONE authoritative body set in skill/forge/references/.
//
// The generated directories are never authoritative: every rule change happens
// in skill/forge/references/ (or skill/forge/SKILL.md) and is re-generated into
// the entries by this script. Output is deterministic — the same source bytes
// always produce the same entry bytes (no timestamps, sorted traversal).
//
// Usage: node scripts/build-entries.mjs [--check]
//   --check  exits 1 when a regeneration would change bytes (stale outputs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractLinks } from './check-links.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skill');
const SOURCE = path.join(SKILL_DIR, 'forge');

const AUTO_HEADER = [
  '<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->',
  '<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->',
].join('\n');

// Entries select the first references to read. Their transitive reference
// dependencies ship locally, but are loaded only when the current branch needs them.
const ENTRIES = [
  {
    name: 'forge-question',
    title: '检查理解',
    shortDescription: '通过提问检查你是否想清楚了，每次只问一个问题，等你自己回答。',
    description: '通过一次一个问题检查用户给出的解释或推理，问完后等待用户回答。当用户想「通过提问检查我的理解」「看看我的解释有没有漏洞」或只要问题时使用。只在聊天里提问，不直接讲解、给答案、评分或保存学习文件；需要讲解、整理资料、检查答案、保存记录或安排复习时用 forge 主技能（/forge）。',
    summary: '你先说出自己的解释，它通过追问帮你发现没想清楚的地方。一次只问一个问题，等你自己回答；这一项只在聊天里提问，不直接讲解、给答案、打分或保存文件。',
    example: {
      scene: '读完一篇文章后，你想检查自己的解释是否站得住脚。',
      request: '/forge-question 检查我的解释：“两件事一起发生，就说明其中一件导致了另一件。”每次只问一个问题，等我回答。',
      result: '围绕你的解释问一个问题，然后等待回答。不会直接替你给出答案，也不会把这次聊天说成已保存的学习记录。',
    },
    bodies: ['socratic-questioning-standalone.md'],
    references: [],
    boundary: null,
    cli: false,
  },
  {
    name: 'forge-review',
    title: '检查答案',
    shortDescription: '检查学习记录里已有的答案，说明哪里答对、哪里有问题，以及怎样改。',
    description: '检查学习记录中用户已提交的答案，对照题目和材料说明答对的部分、具体问题及修改建议，并保存反馈。当用户想「检查我的答案」「批改这次练习」「看看哪里答错了」时使用。需要可读取的学习记录和实际答案，保留原答案，把后续修改另存；不替用户作答或出新题。安排复习用 forge-review-plan，从头学习用 forge 主技能（/forge）。',
    summary: '把已有学习记录的位置告诉它，让它逐题检查你已经提交的答案，说明答对的部分、具体问题和修改建议，并保存反馈。原答案会保留，你后来的修改另存；这项功能不会替你答题或新增练习。',
    example: {
      scene: '你已经完成并保存了一批练习，希望知道具体哪里答错了。',
      request: '/forge-review 检查 learning/my-topic 里我这次已经提交的答案，说明哪里答对、哪里有问题、怎样修改，并保存反馈。',
      result: '先确认要检查哪些答案，再逐题给出反馈。原答案保留；材料不够或暂时无法判断的题目会明确说明。',
    },
    bodies: ['tutor-review.md'],
    references: ['evidence-and-review.md'],
    boundary: { file: 'evidence-and-review.md', heading: '## 6. 边界' },
    cli: true,
  },
  {
    name: 'forge-review-plan',
    title: '安排复习',
    shortDescription: '根据你以前的学习记录和今天的时间，安排先复习什么、哪些留到以后。',
    description: '根据已有学习记录和用户今天可用的时间安排复习，优先考虑该复习的题目、后续内容需要的基础和反复答错的地方，说明选择理由与暂时不复习的内容。当用户想「今天复习什么」「安排 15 分钟复习」时使用；需要可读取的学习记录，先提供安排，明确要求保存后再写入适用的学习轮次。检查已有答案用 forge-review，从头学习用 forge 主技能（/forge）。',
    summary: '告诉它学习记录在哪里、今天有多少时间，以及你想重点复习什么。它会先给出复习安排，解释为什么先选这些、哪些留到以后；你明确要求保存后才会写入记录。安排好复习不代表已经完成复习。',
    example: {
      scene: '你今天只有 15 分钟，想先复习以前经常答错的地方。',
      request: '/forge-review-plan 根据 learning/my-topic 的学习记录安排 15 分钟复习，优先处理我反复答错的地方，并说明哪些留到下次。',
      result: '给出这次要复习的内容、选择理由和以后再复习的部分。没有足够记录时会说明；这只是计划，不会把题目标成已经完成。',
    },
    bodies: ['review-plan.md'],
    references: [],
    boundary: null,
    cli: true,
  },
  {
    name: 'forge-insights',
    title: '回看变化',
    shortDescription: '回看你以前的解释、答案和修改，找出反复出错的地方与理解上的变化。',
    description: '把同一份学习记录里已有的解释、答案、修改、反馈和自创问题按知识点整理，帮助用户回看理解的变化。当用户想「汇总我的误区」「看看我的理解变化」「回看以前怎么想的」或生成洞见速查时使用。需要可读取的学习记录，只汇总已保存的内容，不补写用户没说过的话，不因此判断已经学会；需要新讲解、练习或学习文件时用 forge 主技能（/forge）。',
    summary: '读取已有学习记录，把你以前怎么解释、后来怎样修改、收到什么反馈放在一起，方便回看变化和反复出错的地方。只整理已经保存的内容；缺少旧记录时会说明，不能据此判断你已经学会。',
    example: {
      scene: '学了一段时间后，你想知道自己的解释发生了哪些变化。',
      request: '/forge-insights 回看 learning/my-topic 的记录，整理我以前的解释、后来的修改和反复出错的地方。没有记录的部分请说明。',
      result: '按知识点展示已有答案、修改和反馈。只有一次记录时会说明无法比较，不会补写你没说过的内容。',
    },
    bodies: ['insight-notes.md'],
    references: [],
    boundary: null,
    cli: true,
  },
  {
    name: 'forge-organize',
    title: '整理资料',
    shortDescription: '把文章、课程笔记等资料整理成学习网页、思维导图和练习，保留来源。',
    description: '把用户提供的文章、课程笔记等资料整理成可以阅读、做练习和记笔记的学习网页，以及可编辑的思维导图，保留资料出处和没有弄清楚的问题。当用户想「整理我的笔记」「生成学习页或思维导图」「只要整理结果，今天不提问」时使用；只整理资料，不现场提问或判断用户是否学会。需要带着学习、检查答案或安排复习时用 forge 主技能（/forge）。',
    summary: '把文章、课程笔记等材料交给它，就能整理成学习网页、可编辑思维导图和练习，并保留来源与疑问。这项功能只整理资料，不现场提问，也不把整理完成当成你已经学会。具体材料要求和生成方法见下面的参考。',
    example: {
      scene: '你有一份课程笔记，希望先整理清楚，今天不想做问答练习。',
      request: '/forge-organize 把我提供的课程笔记整理成学习网页和可编辑思维导图，保留疑问与来源，放在 learning/my-topic。今天先不提问。',
      result: '先阅读材料，再生成学习网页、导图和练习，说明保存位置。不会强制你先回答问题，也不会判断你已经学会。',
    },
    bodies: ['source-grounded-teaching.md', 'artifacts.md'],
    references: ['content-quality.md', 'learning-registration.md'],
    boundary: null,
    cli: true,
  },
];

// ---------------------------------------------------------------------------
// Text transforms
// ---------------------------------------------------------------------------

// Source markdown uses CRLF on disk; generated output is uniformly LF, so all
// reads normalize line endings first (the sources themselves stay untouched).
function readSource(file) {
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

function referenceDependencies(markdown) {
  const dependencies = [];
  for (const link of extractLinks(markdown)) {
    const target = link.split('#')[0];
    if (/^[a-z]+:/i.test(target) || !target.endsWith('.md')) continue;
    // References are siblings. Reject escaping paths rather than silently
    // dropping their rules or copying files outside the skill.
    if (target !== path.basename(target)) throw new Error(`reference must be a sibling: ${target}`);
    dependencies.push(target);
  }
  return dependencies;
}

function entryReferences(def) {
  const files = new Set();
  const pending = [...def.bodies, ...def.references, ...(def.cli ? ['output-paths.md'] : [])];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const source = readSource(path.join(SOURCE, 'references', file));
    files.add(file);
    pending.push(...referenceDependencies(source));
  }
  return [...files].sort();
}

// In-package script paths only make sense inside the main skill; an entry
// carries its own copy, so point the same sentence at the entry-local path.
function rewriteScriptPaths(markdown) {
  return markdown.replaceAll('skill/forge/scripts/', '<skill-dir>/scripts/');
}

function copiedReference(def, file) {
  let source = readSource(path.join(SOURCE, 'references', file));
  if (def.cli) source = rewriteScriptPaths(source);
  return `${AUTO_HEADER}\n\n${source.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function buildSkillMd(def) {
  const parts = [];
  parts.push('---');
  parts.push(`name: ${def.name}`);
  parts.push(`description: ${def.description}`);
  parts.push('metadata:');
  parts.push(`  short-description: ${def.title}`);
  parts.push('---');
  parts.push('');
  parts.push(AUTO_HEADER);
  parts.push('');
  parts.push(`# Forge · ${def.title}`);
  parts.push('');
  parts.push(def.summary);
  parts.push('');
  parts.push(`安装并加载后，在会话中用 \`/${def.name} + 请求\` 调用；安装参数与目录名使用 \`${def.name}\`。以本次加载的 SKILL.md 所在目录定位随附文件，不依赖源码仓库、主技能或兄弟技能目录。`);
  parts.push('');
  parts.push('## 场景示例');
  parts.push('');
  parts.push(`**场景**：${def.example.scene}`);
  parts.push('');
  parts.push('```text');
  parts.push(def.example.request);
  parts.push('```');
  parts.push('');
  parts.push(`**预期处理**：${def.example.result}`);
  parts.push('');
  parts.push('目录相对当前会话工作目录解析，材料需已提供且可读；保存情况以实际工具读回为准。');
  parts.push('');
  parts.push('## 入口步骤');
  parts.push('');
  parts.push('1. 按下方能力规则的顺序读取先读文件，在第一次回复里说明本次范围。后续只沿当前分支读取参考。');
  if (def.cli) {
    parts.push('2. 命令使用本目录自带的 CLI：`node <本目录>/scripts/forge.mjs <命令>`，先用 `help` 查看当前命令；按[输出位置与保存合同](references/output-paths.md)确认执行工作目录与明确的学习路径，数据不写入技能目录。');
  } else {
    parts.push('2. 本能力是纯会话能力：无需 Node.js 或本地脚本，不创建文件、不宣称归档或推进掌握；学习者请求持久保存时说明范围变化，确认 forge 主技能已安装并加载后再进入模型与任务准备步骤。');
  }
  parts.push('3. 按能力规则的等待点停等真实用户输入；完成时交代结果与未验证缺口，未持久化的内容如实说明。');
  parts.push('4. 当前能力所引用的规则随附在本目录的 references/，单项任务无需另装主技能。参考中其他能力的说明只用于交接；用户改变目标时说明新的范围，再选择已安装并加载的入口，缺少入口时如实说明。');
  parts.push('');
  parts.push('## 能力规则');
  parts.push('');
  for (const file of def.bodies) {
    const title = readSource(path.join(SOURCE, 'references', file)).match(/^# (.+)$/m)?.[1] ?? file;
    parts.push(`- 先读：[${title}](references/${file})。`);
  }
  if (def.boundary) {
    const source = readSource(path.join(SOURCE, 'references', def.boundary.file));
    if (!source.split('\n').includes(def.boundary.heading)) throw new Error(`missing reference heading: ${def.boundary.heading}`);
    const anchor = def.boundary.heading.replace(/^#+ /, '').toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-');
    parts.push(`- 复核结论与掌握度的边界：读[证据与复习](references/${def.boundary.file}#${anchor})。`);
  }
  return parts.join('\n');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src).sort()) {
    // Transient archive-lock files appear next to a model while another
    // process runs `build` on it; they are runtime state, never skill content.
    if (name === '.ember-lock' || name === '.ember-lock.recovery') continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

// Build one entry from scratch: remove any previous output first so stale
// files can never survive a source change.
function buildEntry(def, skillDir) {
  const references = entryReferences(def);
  const target = path.join(skillDir, def.name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'references'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), buildSkillMd(def), 'utf8');
  // UI prompts use the same public invocation and scope as the entry itself.
  fs.mkdirSync(path.join(target, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'agents', 'openai.yaml'), [
    '# Generated by scripts/build-entries.mjs; edit the entry definition instead.',
    'interface:',
    `  display_name: ${JSON.stringify(`Forge · ${def.title}`)}`,
    `  short_description: ${JSON.stringify(def.shortDescription)}`,
    '  brand_color: "#3F6B4F"',
    `  default_prompt: ${JSON.stringify(def.example.request)}`,
    '',
  ].join('\n'), 'utf8');
  // Each independently installed skill carries its own license notice.
  for (const file of ['LICENSE', 'NOTICE']) {
    const source = path.join(SOURCE, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, file));
  }
  for (const file of references) {
    fs.writeFileSync(path.join(target, 'references', file), copiedReference(def, file), 'utf8');
  }
  if (def.cli) copyDir(path.join(SOURCE, 'scripts'), path.join(target, 'scripts'));
  // CLI workflows can rebuild artifacts (including after review/import).
  // Their runtime requires the viewer template even outside forge-organize.
  if (def.cli) copyDir(path.join(SOURCE, 'assets'), path.join(target, 'assets'));
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function entryNames() {
  return ENTRIES.map((entry) => entry.name);
}

function snapshot(skillDir) {
  const files = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files[path.relative(skillDir, file).replaceAll('\\', '/')] = fs.readFileSync(file, 'utf8');
    }
  };
  for (const name of entryNames()) {
    const directory = path.join(skillDir, name);
    if (fs.existsSync(directory)) walk(directory);
  }
  return files;
}

export function buildEntries({ skillDir = SKILL_DIR } = {}) {
  for (const def of ENTRIES) buildEntry(def, skillDir);
  return entryNames().map((name) => path.join(skillDir, name));
}

export function checkEntries(skillDir = SKILL_DIR) {
  const before = snapshot(skillDir);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-entries-check-'));
  let after;
  try {
    buildEntries({ skillDir: temporary });
    after = snapshot(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const changed = Object.keys(after).filter((file) => before[file] !== after[file]);
  const removed = Object.keys(before).filter((file) => after[file] === undefined);
  return { changed, removed, files: Object.keys(after).length };
}

function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const { changed, removed, files } = checkEntries();
    if (changed.length > 0 || removed.length > 0) {
      console.error(`生成的入口与源文件不同步，请运行 node scripts/build-entries.mjs：\n${[...changed, ...removed].map((file) => `  ${file}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.error(`生成的 ${files} 个入口文件与源文件同步。`);
    }
    return;
  }
  buildEntries();
  // stderr keeps stdout clean: `prepack` runs this script inside `npm pack
  // --json`, whose stdout must stay parseable.
  console.error(`已从 skill/forge/references/ 生成 ${ENTRIES.length} 个自包含入口：${entryNames().join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
