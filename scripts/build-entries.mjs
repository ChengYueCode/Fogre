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
    title: '只用提问检查解释或推理',
    description: '只用苏格拉底式提问检查学习者的解释或推理：一次针对一个缺口提一个问题并停等真实回答，不讲解、不代答、不评分。当用户想「用提问检查我的解释/推理」「以问题方式检验我的理解」或明确只要提问策略时使用；需要讲解、整理产物、复核作答、安排复习或汇总洞见时改用 forge 主技能（/forge）。',
    summary: '本入口只做一件事：围绕学习者给出的解释或推理，用苏格拉底式提问暴露缺口。单项使用不建画像、不做诊断、不展开完整学习旅程。',
    example: {
      scene: '你觉得自己理解了二分查找，希望用一个问题检验解释里的条件。',
      request: '/forge-question 检查我的解释：“任何有序数据都能套同一种二分边界写法。”先问一个问题并等我回答。',
      result: '针对一个缺口提问并等待真实回答；不代答、不评分，也不宣称无档案的讨论已归档。',
    },
    bodies: ['socratic-questioning-standalone.md'],
    references: [],
    boundary: null,
    cli: false,
  },
  {
    name: 'forge-review',
    title: '集中复核作答',
    description: '复核学习者已提交的真实作答：固定复核范围，逐项说明正确部分、具体误解、核对依据与修补，并把结果写回学习档案。当用户想「检查我的作答」「复核这批答案」「集中批改本轮回答」时使用；「安排今天复习什么」用 forge-review-plan；完整学习旅程用 forge 主技能（/forge）。',
    summary: '本入口只做一件事：对已保存的真实作答做导师侧集中复核。它不新建教学、不出新题，也不把复核结论当成新的作答。',
    example: {
      scene: 'learning/binary-search 中已有本轮作答，你想集中核对并留下反馈。',
      request: '/forge-review 检查 learning/binary-search 本轮已提交作答，说明正确部分、误解和依据，保存逐项反馈。',
      result: '固定复核范围、核对真实原答并读回反馈；原答保留，缺依据或内容失效的项保持待处理。',
    },
    bodies: ['tutor-review.md'],
    references: ['evidence-and-review.md'],
    boundary: { file: 'evidence-and-review.md', heading: '## 6. 边界' },
    cli: true,
  },
  {
    name: 'forge-review-plan',
    title: '预算内复习安排',
    description: '在时间预算内安排今天该复习的内容：选择到期项、前置缺口与重复错误，说明选择理由与暂缓项，学习者可指定本轮重点。当用户想「安排今天的复习」「今天复习哪些」「X 分钟内复习」时使用；「检查/批改已有作答」用 forge-review；完整学习旅程用 forge 主技能（/forge）。',
    summary: '本入口只做一件事：产出本轮的复习安排。选择只是安排，不是完成、遗忘或新的掌握结论。',
    example: {
      scene: '今天只有 15 分钟，希望根据这个主题已有记录优先补左右边界的缺口。',
      request: '/forge-review-plan 根据 learning/binary-search 的记录安排 15 分钟复习，重点是左右边界，说明选择和暂缓理由。',
      result: '按主题的前置、主动重点、重复错误与真实到期项安排；没有到期记录如实说明，未选中不算完成。',
    },
    bodies: ['review-plan.md'],
    references: [],
    boundary: null,
    cli: true,
  },
  {
    name: 'forge-insights',
    title: '洞见与速查汇总',
    description: '按概念汇总学习档案里已有的解释、原答、修正、复核反馈与自创检索问题（洞见与速查）：只聚合已有记录，不新建事实、不提升掌握度。当用户想「汇总我的误区」「看看我的理解变化」「生成洞见速查」时使用；需要新教学或新产物时用 forge 主技能（/forge）。',
    summary: '本入口只做一件事：把同一份学习档案里的已有记录按概念重新聚合并如实呈现，区分当前内容与历史孤立项。',
    example: {
      scene: '你已学过几轮，希望看见自己的原理解、修正和反复出现的误区。',
      request: '/forge-insights 汇总 learning/binary-search 中我的原答、修正、反馈与误区，没有记录的部分不要补写。',
      result: '只聚合已有记录并区分当前内容与历史；不新建事实，不增加掌握证据。',
    },
    bodies: ['insight-notes.md'],
    references: [],
    boundary: null,
    cli: true,
  },
  {
    name: 'forge-organize',
    title: '材料整理与学习产物',
    description: '只把已有资料整理成学习产物：交互学习页、可编辑思维导图、练习问题与来源标注，不提问、不评估、不推进掌握度（初始掌握度如实未知）。当用户想「把笔记/资料做成学习页」「生成思维导图」「只要产物不要教学」时使用；要进入完整学习旅程用 forge 主技能（/forge）。',
    summary: '本入口只做一件事：从你提供的材料生成或重建学习产物，并保留来源与缺口。材料核对规则与产物命令见下方随附参考。',
    example: {
      scene: '你已有二分查找笔记，想先看清知识关系，暂时不做现场问答。',
      request: '/forge-organize 只整理我提供的笔记，生成学习页和可编辑导图，保留疑问与来源，放在 learning/binary-search。',
      result: '先核对材料再生成或重建产物，并登记标准学习目录；不强制诊断，初始掌握度保持未知。',
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
  parts.push(`# ${def.name} · ${def.title}`);
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
    `  display_name: ${JSON.stringify(`${def.name} · ${def.title}`)}`,
    `  short_description: ${JSON.stringify(def.example.result)}`,
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
