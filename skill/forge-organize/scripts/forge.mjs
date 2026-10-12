#!/usr/bin/env node
// Resource paths are relative to this skill. User-supplied paths are relative
// to the command's cwd, so calling an installed skill does not relocate data.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EmberError, CODES, isRecord } from './lib/errors.mjs';
import { assertLearningOutput } from './lib/output-paths.mjs';
import { atomicWrite, fileExists, nowIso, readJson, stableStringify } from './lib/io.mjs';
import { archiveLockDirs, archivePathFor, readArchive, restoreArchiveBackup, withArchiveLock, writeArchiveState } from './lib/archive.mjs';
import { modelToJson, normalizeModel } from './lib/model.mjs';
import {
  applyAttempt,
  applySubmission,
  applyAssessment,
  applyTutorAssessment,
  applyLearningRound,
  applyPractice,
  applyCorrection,
  applyTeachingCorrection,
  applyInteractionPosition,
  applyTutorEvidence,
  applyReviewItem,
  createState,
  interactionPositionView,
  isAttemptActive,
  isConceptEvidenceActive,
  isPromptEvidenceActive,
  learningRoundView,
  listDue,
  mergeImportedState,
  normalizeState,
  practiceSelection,
  reviewPlan,
  startReviewRequest,
  STATE_SCHEMA_VERSION,
  teachingCorrectionsView,
  tutorReviewSummary,
} from './lib/state.mjs';
import { buildArtifacts, buildSummary, collectPromptFingerprints, stateResponse, DEFAULT_OUT_FILES } from './lib/build.mjs';
import { roundHintTexts } from './lib/round.mjs';
import { resumeReadback } from './lib/resume.mjs';
import { catalogPath, registerTopic, listTopics, resumeTopic, removeTopic } from './lib/library.mjs';
import { interactionStepView } from './lib/interactions.mjs';
import { insightRead } from './lib/insights.mjs';
import { startServer } from './lib/server.mjs';
import {
  buildTemplate,
  normalizeQuality,
  qualityJsonText,
  qualityToJson,
  QUALITY_FILE,
  readQualityFile,
  recordDeclarationReasons,
  recordScopeReasons,
  qualityView,
} from './lib/quality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, '..');
const VIEWER_PATH = path.join(SKILL_ROOT, 'assets', 'viewer.html');

const HELP = `forge · 锻造 — 学习产物与复习循环

用法：node <skill-dir>/scripts/forge.mjs <命令> [参数]
脚本位置由技能包决定；不需要 cd 进技能目录，学习数据放在你自己的工作区。
所有相对路径参数按执行命令时的工作目录解析，绝对路径原样定位。
需要学习目录的命令必须给 --out；不会自动创建 learning/<主题>。
学习输出、外置档案/导图、导出文件和索引均不得写入 Forge 技能目录。
import 的 --state 是导入输入；其他支持 --state 的命令用它指定档案位置。

命令：
  library register --topic <稳定ID> --out <学习目录> [--catalog <索引JSON>]
  library list [--catalog <索引JSON>] [--at <ISO 时间>]
  library resume --topic <稳定ID> [--catalog <索引JSON>] [--round-id <id>] [--at <ISO 时间>]
  library remove --topic <稳定ID> [--catalog <索引JSON>]
      统一学习档案入口；默认 ./learning/learning-index.json。登记已存在的标准学习目录，
      列表实时读回学习位置与到期数量；resume 只读恢复，不开始或切换轮次。
      remove 仅移除指针，学习档案保留；独立页未导出的缓存不在读回范围。

  validate <model.json>
      校验知识模型，不写任何文件。

  build <model.json> --out <dir> [--state <state.json>] [--scene <map.excalidraw>] [--svg]
      生成 index.html、model.json、state.json、map.excalidraw（可选 map.svg）。
      默认读取 <dir>/state.json 与 <dir>/map.excalidraw，续接学习记录与场景编辑。

  serve --out <dir> [--port 0|N] [--state <state.json>]
      在 127.0.0.1 启动本页自动存档服务；--port 0 使用临时端口。

  due --out <dir> [--at <ISO 时间>]
      打印到期与待安排问题；给定 --at 可复现。

  submit --out <dir> --prompt <id> --answer <原答案> [--attempt-id <id>] [--session-id <id>] [--round-id <id>] [--task-id <id>] [--assistance hint|reference|tutor-feedback|starter|demonstration]...
      立即保存非空原答，无需自评；相同身份与原文可安全重试。

  practice --out <dir> --prompt <id> --session-id <id> [--round-id <id>] [--task-id <id>] [--draft <文本>] [--base-draft <旧文本>] [--assistance <来源>]... [--hint-level N]
      保存草稿与协助事实；查看帮助前先保存，协助事实只增加。--hint-level 只增不减，
      不超过当前问题的提示条目；每条推进记入 hint 协助。

  correction --out <dir> --prompt <id> --attempt-id <id> --text <修正> [--correction-id <id>] [--assistance <来源>]...
      追加修正事件，不改写原答或新增作答次数。

  correction-record --out <dir> --record <纠错JSON文件> [--correction-id <id>] [--at <ISO>]
      写入教学纠错记录：先前不准确的讲解（claim）、正确解释（correction）、回读来源依据
      （basis）、影响范围 impacts（kind: explanation|example|exercise|reference|criteria|record，
      每项带处理说明）或 noImpactReason；可选 feedback 记录学习者指出的冲突、sourceId 关联来源。
      相同身份与内容可安全重试；同身份不同内容被拒绝，纠错历史不可改写。

  correction-record --out <dir> --correction-id <id> --recheck-attempt <作答ID> --recheck-note <说明> [--recheck-id <id>] [--at <ISO>]
      在已有教学纠错上追加一次纠错后的新尝试关联；原答须已存在且晚于纠错记录。

  correction-read --out <dir> [--correction-id <id>]
      公开读回教学纠错：先前讲解、正确解释与依据、影响范围每项的当前状态
      （概念/问题是否仍在模型、原答是否仍活跃、引用它的证据当前是否有效）及复核关联；
      材料更新使旧内容或证据失效时如实显示。只读，不写任何文件。

  resume-read --out <dir> [--round-id <id>] [--quality <quality.json>] [--at <ISO 时间>]
      统一恢复读回：一次读回学习身份、画像、目标与预算、当前位置、实际互动、
      真实原答（含协助属性）、当前缺口、材料核对范围、纠错历史，并列出保存值与
      当前值的差异（目标或材料变化后的受影响范围）。旧档缺少的信息如实标未知。
      只读，不写任何文件；独立页未导出的本机缓存不在读回范围内。

  review --out <dir> --prompt <id> --rating again|hard|good|easy [--answer <学习者作答>] [--at <ISO>] [--assisted] [--attempt-id <id>]
      无 --answer 时对指定已保存原答补自评（[--assessment-id <id>] [--correction-id <id>]）；
      旧的作答加自评用法保持兼容。

  assess --out <dir> --prompt <id> --attempt-id <id> --rating again|hard|good|easy --note <复核依据> [--assessment-id <id>] [--correction-id <id>] [--at <ISO>]
      导师侧：对明确已保存的真实作答（或用 --correction-id 指定某次修正）写入评价与
      关联反馈，并重算复习安排；仅 agent 使用，不新增作答、不自动升级掌握度。

  evidence --out <dir> (--prompt <id> | --concept <id>) --status unknown|needs-work|explained|applied|retained --note <依据> [--attempt <id>]... [--at <ISO>]
      导师复核真实作答后写入证据；--attempt 可重复，显式指定被复核的 attempt。

  round --out <dir> --action create|update|pause|resume|focus|confirm-diagnosis|review-plan|progress-start|progress-event|progress-time|close [--round-id <id>] [--entry learn-new-topic|organize-existing-material] [--goal <文本>] [--minutes N|none] [--concept <id>]... [--task-id <id>] [--focus-prompt <id>]... [--clear-focus] [--at <ISO>]
      create/update 可加 --opening <JSON文件>，保存画像、初步/校准范围与可选互动上限。
      create --track-progress 从本轮开始记录互动；旧轮次用 --action progress-start 从当前起算，历史总数未知。
      progress-event|progress-time|close --record <JSON文件> 保存实际回应、学习区间或收尾；update --adjustment <JSON文件> 保存路线调整依据与估计。
      创建或调整本轮路线、暂停/继续、定位任务、确认诊断。create 需要 --goal 与 --concept；
      未给 --minutes 时先组织一个聚焦单元及其必要前置；learn-new-topic 先等待真实诊断作答。
      review-plan 明确应用预算内复习选择；省略 --focus-prompt 保留已有重点，--clear-focus 清除重点。

  round-read --out <dir> [--round-id <id>]
      读取本轮路线：目标、入口、预算、任务顺序与原因/完成标准/质检/掌握，及剩余与暂缓任务。
      缺省读取 activeRoundId 指向的轮次；无轮次时如实报告 history 未知。

  practice-plan --out <dir> [--round-id <id>]
      只读列出本轮各目标概念的练习选择：目的、选中题目、选择理由与依据作答、作者判定
      标准、可用提示数，以及内容质检边界；不写任何文件。

  review-plan --out <dir> [--round-id <id>] [--minutes N|none] [--at <ISO>] [--focus-prompt <id>]...
      只读预览预算内复习选择：全部到期项与选中/暂缓项分开显示；未选中不改变真实到期状态，
      --at 只用于独立测试目录的确定性时间。

  insights --out <dir> [--concept <id>]
      只读聚合洞见：按概念列出真实原答、修正、集中复核/普通导师反馈、自己的解释与
      总结（含历史版本）和自创检索问题；缺项如实显示，不写入档案或授予掌握度。

  interaction --out <dir> --id <interactionId> --step <stepId> [--at <ISO>]
      保存分步推演组件的当前位置（步骤 id + 精确内容签名）；只记学习者观察位置，
      不写作答、评分、提示或掌握证据。内容变化后原位置失效，需明确保存新位置。

  review-start --out <dir> --request-id <稳定ID> (--round-id <轮次ID> | --history --attempt <作答ID>...)
      建立一次集中复核的固定范围：轮次请求冻结该轮当时的待复核原答、题目/参考/判定标准、
      内容指纹与已有修正；历史请求需由学习者显式指定无轮次作答。相同请求身份重试不重新选成员。

  review-read --out <dir> [--request-id <稳定ID> | --round-id <轮次ID> | --history]
      读取待复核数量、请求完成/剩余与逐项原答、参考、判定标准、当前失效原因和反馈。
      缺省读取当前轮次；request-id 读取该请求所属轮次的新增待复核；--history 列出无轮次
      待复核作答的具体 ID，供学习者选择范围后再 review-start --history --attempt。

  review-item --out <dir> --request-id <稳定ID> --prompt <题目ID> --attempt-id <作答ID> --feedback <反馈JSON文件>
      写入单项导师反馈：completed 需要五类非空反馈与合法 rating；stale/missing-basis/undetermined
      需要非空 reason 并保留待处理。相同结果可安全重试，已完成项不可改写。

  import --out <dir> --state <state.json>
      合并导出的状态文件；保留较新的现有内容并报告冲突。

  export --out <dir> --to <state.json>
      把当前状态导出为独立文件，便于备份或迁移。

  quality-template --out <dir> [--model <model.json>] [--to <quality.json>]
      依据当前模型打印（或写入）内容质检骨架：范围快照与全部概念/问题指纹已填，
      概念 role 为空，等待作者按实际阅读与核对显式填写。

  quality-validate <quality.json> --out <dir> [--model <model.json>]
      只校验内容质检结构与范围引用，不写任何文件。

  quality-write --out <dir> [--model <model.json>] --quality <quality.json>
      校验通过且范围与当前模型/目标完全一致时写入 <out>/quality.json；
      只写质检记录，不触碰学习者档案、指纹或掌握度。

  quality-read --out <dir> [--model <model.json>]
      读取内容质检结论；内容或目标更新后保留历史记录并标记需重新核对的部分。

  restore --out <dir> [--backup <state.v1.backup.json>]
      把升级前的旧档副本恢复为当前档案；恢复前核验副本属于同一模型且可读，
      并报告恢复出的档案摘要。副本文件只创建、不覆盖，可重复核验。

  help
      显示本说明。

档案写入协调：review、evidence、import、build 与本地服务的保存共用同一个
磁盘上的档案锁与档案/内容版本检查；并发保存要么保留双方新增记录，
要么返回可处理的冲突与当前状态，不会用旧快照静默覆盖当前档案。
      首次把旧版（schemaVersion 1）档案升级写入前，会在同目录保留逐字节副本
state.v1.backup.json；restore 可核验并恢复该副本。

内容质检：quality.json 是作者侧记录，单独存放；它不影响 state.json、内容
指纹或学习者掌握度。结论只来自作者填写的实际依据，字段齐全或篇幅达标本身
不构成通过。

示例（把 <skill-dir> 换成实际技能目录）：
  node <skill-dir>/scripts/forge.mjs validate ./learning/probability/model.json
  node <skill-dir>/scripts/forge.mjs build ./learning/probability/model.json --out ./learning/probability --svg
  node <skill-dir>/scripts/forge.mjs serve --out ./learning/probability --port 0
  node <skill-dir>/scripts/forge.mjs due --out ./learning/probability --at 2026-10-09T08:00:00Z
  node <skill-dir>/scripts/forge.mjs review --out ./learning/probability --prompt p-apply-ppv --rating hard --answer "真阳性 18、假阳性 49，PPV≈26.9%"
  node <skill-dir>/scripts/forge.mjs review-start --out ./learning/probability --request-id r-2026-10-09 --round-id round-1
  node <skill-dir>/scripts/forge.mjs review-read --out ./learning/probability --request-id r-2026-10-09
  node <skill-dir>/scripts/forge.mjs review-item --out ./learning/probability --request-id r-2026-10-09 --prompt p-apply-ppv --attempt-id att-xxxxxxxx --feedback ./feedback.json
  node <skill-dir>/scripts/forge.mjs evidence --out ./learning/probability --prompt p-apply-ppv --status applied --note "用 2% 患病率重算正确：真阳性 18、假阳性 49" --attempt att-xxxxxxxx
  node <skill-dir>/scripts/forge.mjs export --out ./learning/probability --to ./backup/state.json
`;

function parseArgs(argv) {
  const positional = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : next;
      if (value !== true) i += 1;
      if (flags[key] === undefined) flags[key] = value;
      else if (Array.isArray(flags[key])) flags[key].push(value);
      else flags[key] = [flags[key], value];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireFlag(flags, name, hint) {
  const value = flags[name];
  if (value === undefined || value === true) {
    throw new EmberError(CODES.USAGE, `缺少 --${name}${hint ? `（${hint}）` : ''}`);
  }
  return value;
}

function requireOut(flags) {
  const out = requireFlag(flags, 'out', '学习产物目录');
  return path.resolve(String(out));
}

function statePathFor(flags, out) {
  return archivePathFor(flags.state && flags.state !== true ? String(flags.state) : path.join(out, DEFAULT_OUT_FILES.state));
}

function modelPathFor(flags, out) {
  if (flags.model && flags.model !== true) return path.resolve(String(flags.model));
  return path.join(out, DEFAULT_OUT_FILES.model);
}

function readModelFile(filePath) {
  return normalizeModel(readJson(filePath, `模型文件 ${filePath}`));
}

function readStateFor(out, model, flags) {
  const statePath = statePathFor(flags, out);
  if (!fileExists(statePath)) return { state: createState(model), statePath };
  return { state: normalizeState(readJson(statePath, `状态文件 ${statePath}`), model), statePath };
}

// Shared write cycle for every CLI mutation: read the durable archive (migrating
// a version-1 archive in memory), apply, then persist inside the archive lock.
// The lock is the same boundary the HTTP save endpoint and build use, so
// interleaved writers either preserve each other's additions or get a
// recoverable conflict instead of a lost update.
async function withArchiveWrite(out, statePath, modelPath, apply) {
  // Capture the content the command was issued against; this is only a guard.
  // The model used to apply the operation is read again alongside the state
  // after obtaining all shared locks.
  const expectedFingerprint = readModelFile(modelPath).modelFingerprint;
  return withArchiveLock(archiveLockDirs(out, statePath, modelPath), async () => {
    const model = readModelFile(modelPath);
    const archive = readArchive(statePath, model);
    const state = archive.exists ? archive.state : createState(model);
    if (model.modelFingerprint !== expectedFingerprint || state.modelFingerprint !== model.modelFingerprint) {
      throw new EmberError(CODES.CONFLICT, '学习内容在等待写入期间已更新；请读取当前问题与档案后重新提交，本次未写入');
    }
    const result = apply(state, model);
    writeArchiveState(statePath, result.state, {
      wasV1: archive.wasV1,
      rawText: archive.rawText,
    });
    return result;
  });
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function cmdValidate(flags, positional) {
  const modelPath = positional[0] ?? (flags.model !== true ? flags.model : undefined);
  if (!modelPath) throw new EmberError(CODES.USAGE, 'validate 需要模型文件路径');
  const model = readModelFile(path.resolve(String(modelPath)));
  printJson({
    valid: true,
    id: model.id,
    title: model.title,
    concepts: model.concepts.length,
    relations: model.relations.length,
    prompts: model.prompts.length,
    warnings: model.warnings,
    modelFingerprint: model.modelFingerprint,
  });
}

async function cmdBuild(flags, positional) {
  const modelPath = positional[0] ?? (flags.model !== true ? flags.model : undefined);
  if (!modelPath) throw new EmberError(CODES.USAGE, 'build 需要模型文件路径');
  const out = requireOut(flags);
  const statePath = statePathFor(flags, out);
  const resolvedModelPath = path.resolve(String(modelPath));
  const result = await withArchiveLock(archiveLockDirs(out, statePath, resolvedModelPath), async () =>
    buildArtifacts({
      modelPath: resolvedModelPath,
      outDir: out,
      statePath,
      scenePath: flags.scene && flags.scene !== true ? path.resolve(String(flags.scene)) : undefined,
      viewerPath: VIEWER_PATH,
      svg: flags.svg === true,
      at: typeof flags.at === 'string' ? flags.at : undefined,
    }));
  printJson(buildSummary(result));
}

async function cmdServe(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  if (!fileExists(modelPath)) {
    throw new EmberError(CODES.IO, `没有找到模型文件 ${modelPath}，请先运行 build`);
  }
  const port = flags.port !== undefined && flags.port !== true ? Number(flags.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new EmberError(CODES.USAGE, `--port 必须是 0-65535 的整数，收到 ${flags.port}`);
  }
  const started = await startServer({
    dir: out,
    port,
    modelPath,
    statePath: statePathFor(flags, out),
  });
  console.log(`forge 本地服务已启动：${started.url}`);
  console.log(`服务目录：${out}`);
  console.log('按 Ctrl+C 停止。');
  const shutdown = () => started.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

function cmdDue(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  printJson(listDue(state, model, at));
}

async function cmdDurable(command, flags) {
  const out = requireOut(flags);
  const input = {
    promptId: requireFlag(flags, 'prompt'),
    attemptId: typeof flags['attempt-id'] === 'string' ? flags['attempt-id'] : undefined,
    sessionId: typeof flags['session-id'] === 'string' ? flags['session-id'] : undefined,
    correctionId: typeof flags['correction-id'] === 'string' ? flags['correction-id'] : undefined,
    // A round binding is optional; when present it must name a real task of a
    // real round, so practice and submit stay attached to the learner's route.
    roundId: typeof flags['round-id'] === 'string' ? flags['round-id'] : undefined,
    taskId: typeof flags['task-id'] === 'string' ? flags['task-id'] : undefined,
    assistance: flags.assistance === undefined ? undefined : Array.isArray(flags.assistance) ? flags.assistance : [flags.assistance],
    assisted: flags.assisted === true, source: 'cli',
  };
  const apply = command === 'submit' ? applySubmission : command === 'practice' ? applyPractice : applyCorrection;
  if (command === 'submit') input.answer = requireFlag(flags, 'answer');
  if (command === 'correction') input.text = requireFlag(flags, 'text');
  if (command === 'practice') {
    input.sessionId = requireFlag(flags, 'session-id');
    if (typeof flags.draft === 'string') input.draft = flags.draft;
    if (typeof flags['base-draft'] === 'string') input.baseDraft = flags['base-draft'];
    // Optional step-hint level; monotone, and bounded by the question's hints.
    if (flags['hint-level'] !== undefined && flags['hint-level'] !== true) {
      const level = Number(flags['hint-level']);
      if (!Number.isInteger(level) || level < 0) {
        throw new EmberError(CODES.USAGE, `--hint-level 需要非负整数，收到 ${JSON.stringify(flags['hint-level'])}`);
      }
      input.hintLevel = level;
    }
  }
  const statePath = statePathFor(flags, out);
  const result = await withArchiveWrite(out, statePath, modelPathFor(flags, out), (state, model) =>
    apply(state, model, input, typeof flags.at === 'string' ? flags.at : nowIso()));
  printJson({ saved: true, state: statePath, attempt: result.attempt, session: result.session, schedule: result.schedule });
}

async function cmdReview(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const promptId = requireFlag(flags, 'prompt', '问题 id');
  const rating = requireFlag(flags, 'rating', 'again/hard/good/easy');
  const answer = typeof flags.answer === 'string' ? flags.answer : undefined;
  if (answer === undefined && typeof flags['attempt-id'] !== 'string') requireFlag(flags, 'answer', '或用 --attempt-id 指定已保存原答');
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) => {
    const input = { promptId, attemptId: typeof flags['attempt-id'] === 'string' ? flags['attempt-id'] : undefined,
      answer, rating, assisted: flags.assisted === true, source: 'cli',
      // Self-assessment of an already-saved answer is a separate evaluation
      // event; it can target the original or one of its corrections.
      assessmentId: typeof flags['assessment-id'] === 'string' ? flags['assessment-id'] : undefined,
      targetCorrectionId: typeof flags['correction-id'] === 'string' ? flags['correction-id'] : undefined };
    const saved = (state.attempts[promptId] ?? []).find((a) => a.id === input.attemptId);
    return saved || answer === undefined ? applyAssessment(state, model, input, at) : applyAttempt(state, model, input, at);
  });
  printJson({
    saved: true,
    state: statePath,
    attempt: result.attempt,
    schedule: result.schedule,
  });
}

// Agent-side tutor assessment. The browser can never reach this path: the HTTP
// routes only ever apply self assessments and drop imported tutor events.
async function cmdAssess(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const promptId = requireFlag(flags, 'prompt', '问题 id');
  const attemptId = requireFlag(flags, 'attempt-id', '已保存原答 id');
  const rating = requireFlag(flags, 'rating', 'again/hard/good/easy');
  const note = requireFlag(flags, 'note', '针对该次真实作答的复核依据');
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    applyTutorAssessment(state, model, {
      promptId,
      attemptId,
      rating,
      note,
      source: 'cli',
      assessmentId: typeof flags['assessment-id'] === 'string' ? flags['assessment-id'] : undefined,
      targetCorrectionId: typeof flags['correction-id'] === 'string' ? flags['correction-id'] : undefined,
    }, at));
  printJson({
    saved: true,
    state: statePath,
    attempt: result.attempt,
    schedule: result.schedule,
  });
}

// Agent-side teaching correction (task 05). Either a full record (--record
// JSON file) or a follow-up recheck link (--recheck-attempt). Both run through
// the same archive lock/write cycle as every other public write.
async function cmdCorrectionRecord(flags) {
  const out = requireOut(flags);
  const statePath = statePathFor(flags, out);
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const isRecheck = flags['recheck-attempt'] !== undefined || flags['recheck-note'] !== undefined;
  const input = { action: isRecheck ? 'recheck' : 'record' };
  if (typeof flags['correction-id'] === 'string') input.correctionId = flags['correction-id'];
  if (isRecheck) {
    input.attemptId = requireFlag(flags, 'recheck-attempt', '纠错后新原答 id');
    input.note = requireFlag(flags, 'recheck-note', '复核关联说明');
    if (typeof flags.recheckId === 'string') input.recheckId = flags.recheckId;
  } else {
    const recordFile = requireFlag(flags, 'record', '纠错记录 JSON 文件');
    input.record = readJson(path.resolve(String(recordFile)), '纠错记录');
  }
  const result = await withArchiveWrite(out, statePath, modelPathFor(flags, out), (state, model) =>
    applyTeachingCorrection(state, model, input, at));
  printJson({ saved: true, state: statePath, action: input.action, correction: result.correction });
}

function cmdCorrectionRead(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const view = teachingCorrectionsView(state, model);
  const requested = typeof flags['correction-id'] === 'string' ? flags['correction-id'] : undefined;
  const corrections = requested === undefined ? view.corrections : view.corrections.filter((c) => c.id === requested);
  if (requested !== undefined && corrections.length === 0) {
    throw new EmberError(CODES.STATE, `没有找到教学纠错记录：${requested}`);
  }
  printJson({ readOnly: true, out, present: corrections.length > 0, total: corrections.length, corrections });
}

// Unified resume readback (task 06). Read-only assembly of everything a new
// session needs to continue: identity, profile, goal/budget, position,
// interactions, real answers, gaps, material scope, corrections, saved-vs-
// current drift and the persistence boundary. Every staleness/validity rule
// stays in its home module; this host only computes those views and passes
// them to the shared library.
function readResumeFor(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state, statePath } = readStateFor(out, model, flags);
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const roundId = typeof flags['round-id'] === 'string' ? flags['round-id'] : undefined;
  const rounds = Object.keys(state.learningRounds ?? {})
    .map((id) => learningRoundView(state, model, id))
    .filter((view) => view !== null)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id))
    .map((view) => ({
      id: view.id,
      entry: view.entry,
      goal: view.goal,
      status: view.status,
      storedStatus: view.storedStatus,
      resumeStatus: view.resumeStatus,
      currentTaskId: view.currentTaskId,
      updatedAt: view.updatedAt,
    }));
  const roundView = learningRoundView(state, model, roundId);
  // Unlike round-read (which answers "no round"), an explicit --round-id on a
  // resume is a pointer to one identity: a typo must fail loudly instead of
  // reading as "nothing to resume".
  if (roundId !== undefined && !roundView) {
    throw new EmberError(CODES.STATE, `没有找到学习轮次：${roundId}；先用 resume-read 不带 --round-id 查看全部轮次`);
  }
  const review = reviewPlan(state, model, roundView ? { roundId: roundView.id } : {}, at);
  const qualityPath = flags.quality !== undefined && flags.quality !== true
    ? path.resolve(String(flags.quality))
    : path.join(out, QUALITY_FILE);
  const quality = qualityView(readQualityFile(qualityPath, model), model);
  const corrections = teachingCorrectionsView(state, model);
  // Freshness rules stay in their home module: per-attempt currency comes from
  // state.mjs (covers author prompts and learner questions through one rule),
  // per-evidence-record currency from the two active helpers below.
  const attemptActivity = {};
  for (const list of Object.values(state.attempts ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const attempt of list) {
      if (attempt && typeof attempt.id === 'string') attemptActivity[attempt.id] = isAttemptActive(model, state, attempt);
    }
  }
  const evidenceValidity = {
    concepts: Object.fromEntries(Object.entries(state.conceptEvidence ?? {})
      .map(([id, record]) => [id, isConceptEvidenceActive(model, state, id, record)])),
    prompts: Object.fromEntries(Object.entries(state.promptEvidence ?? {})
      .map(([id, record]) => [id, isPromptEvidenceActive(model, state, id, record)])),
  };
  const readback = resumeReadback({ state, model, at, roundId, roundView, rounds, review, quality, corrections, attemptActivity, evidenceValidity });
  return { ...readback, out, stateFile: statePath, archiveUpdatedAt: state.updatedAt,
    reviewDue: listDue(state, model, at).due.map((due) => {
      const attempt = (state.attempts[due.promptId] ?? []).find((item) => item.id === due.attemptId);
      return { ...due, stale: !attempt || !isAttemptActive(model, state, attempt) };
    }) };
}

function cmdResumeRead(flags) {
  printJson(readResumeFor(flags));
}

async function cmdLibrary(flags, positional) {
  const file = catalogPath(flags.catalog);
  if (positional.length !== 1) throw new EmberError(CODES.USAGE, 'library 需要且只接受一个操作');
  for (const key of ['at', 'round-id']) {
    if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !flags[key].trim())) {
      throw new EmberError(CODES.USAGE, `--${key} 需要明确的值`);
    }
  }
  // Registry pointers always name standard archive directories. Overrides
  // would silently read a different learner than the registered identity.
  for (const key of ['model', 'state', 'quality']) {
    if (flags[key] !== undefined) throw new EmberError(CODES.USAGE, `library 不接受 --${key}；使用标准学习目录`);
  }
  switch (positional[0]) {
    case 'register':
      printJson(await registerTopic(file, requireFlag(flags, 'topic'), requireOut(flags), readResumeFor));
      return;
    case 'list':
      printJson(listTopics(file, readResumeFor, flags.at));
      return;
    case 'resume':
      printJson(resumeTopic(file, requireFlag(flags, 'topic'), readResumeFor,
        flags.at, flags['round-id']));
      return;
    case 'remove':
      printJson(await removeTopic(file, requireFlag(flags, 'topic')));
      return;
    default:
      throw new EmberError(CODES.USAGE, 'library 需要 register、list、resume 或 remove');
  }
}

async function cmdEvidence(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const status = requireFlag(flags, 'status', 'unknown/needs-work/explained/applied/retained');
  const note = requireFlag(flags, 'note', '复核依据');
  const promptId = flags.prompt !== undefined && flags.prompt !== true ? flags.prompt : undefined;
  const conceptId = flags.concept !== undefined && flags.concept !== true ? flags.concept : undefined;
  if (!promptId && !conceptId) throw new EmberError(CODES.USAGE, 'evidence 需要 --prompt 或 --concept');
  let attemptIds;
  if (flags.attempt !== undefined) attemptIds = Array.isArray(flags.attempt) ? flags.attempt : [flags.attempt];
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    applyTutorEvidence(state, model, {
      promptId,
      conceptId,
      status,
      note,
      attemptIds,
    }, at));
  printJson({ saved: true, state: statePath, status, promptId: promptId ?? null, conceptId: conceptId ?? null, attemptIds });
}

// Collect repeated --concept flags (or a single value) into an ordered array.
function flagList(value) {
  if (value === undefined || value === true) return undefined;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

async function cmdRound(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const action = requireFlag(flags, 'action', '轮次/进度操作，见 help');
  const input = { action };
  if (flags['track-progress'] === true) input.trackProgress = true;
  if (flags.record !== undefined) input.record = readJson(path.resolve(String(requireFlag(flags, 'record', '进度记录 JSON 文件'))), '进度记录');
  if (flags.adjustment !== undefined) input.adjustment = readJson(path.resolve(String(requireFlag(flags, 'adjustment', '路线调整 JSON 文件'))), '路线调整');
  if (flags.opening !== undefined) {
    const file = requireFlag(flags, 'opening', '开场记录 JSON 文件');
    input.opening = readJson(path.resolve(String(file)), '开场记录');
  }
  if (typeof flags['round-id'] === 'string') input.roundId = flags['round-id'];
  if (typeof flags.entry === 'string') input.entry = flags.entry;
  if (typeof flags.goal === 'string') input.goal = flags.goal;
  const conceptIds = flagList(flags.concept);
  if (conceptIds !== undefined) input.conceptIds = conceptIds;
  // --minutes none explicitly clears the budget; a numeric string sets it.
  if (flags.minutes !== undefined && flags.minutes !== true) {
    input.budgetMinutes = flags.minutes === 'none' ? null : Number(flags.minutes);
    if (flags.minutes !== 'none' && !Number.isInteger(input.budgetMinutes)) {
      throw new EmberError(CODES.USAGE, `--minutes 需要是正整数或 none，收到 ${JSON.stringify(flags.minutes)}`);
    }
  }
  if (typeof flags['task-id'] === 'string') input.taskId = flags['task-id'];
  const focusPrompts = flagList(flags['focus-prompt']);
  if (focusPrompts !== undefined) input.focusPromptIds = focusPrompts;
  if (flags['clear-focus'] === true) input.clearFocus = true;
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    applyLearningRound(state, model, input, at));
  const round = result.round;
  printJson({
    saved: true,
    state: statePath,
    action,
    round: {
      id: round.id,
      entry: round.entry,
      goal: round.goal,
      conceptIds: round.conceptIds,
      budgetMinutes: round.budgetMinutes ?? null,
      status: round.status,
      currentTaskId: round.currentTaskId,
      tasks: round.tasks.map((task) => ({
        id: task.id,
        conceptId: task.conceptId,
        promptId: task.promptId,
        fingerprint: task.fingerprint,
        reason: task.reason,
        teachingPurpose: task.teachingPurpose ?? null,
        estimatedMinutes: task.estimatedMinutes,
        completionCriteria: task.completionCriteria,
        authorCriteria: task.authorCriteria ?? [],
        deferred: Boolean(task.deferred),
        deferredReason: task.deferredReason ?? null,
        diagnostic: Boolean(task.diagnostic),
        reviewPlanned: Boolean(task.reviewPlanned),
        reviewSource: task.reviewSource ?? null,
        dueAt: task.dueAt ?? null,
        dueNow: Boolean(task.dueNow),
        assessmentSource: task.assessmentSource ?? null,
        attemptId: task.attemptId ?? null,
        pendingAssessmentAt: task.pendingAssessmentAt ?? null,
      })),
      reviewPlan: round.reviewPlan ?? null,
      opening: round.opening ?? null,
      progress: round.progress ?? null,
    },
  });
}

function cmdRoundRead(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const roundId = typeof flags['round-id'] === 'string' ? flags['round-id'] : undefined;
  const view = learningRoundView(state, model, roundId);
  if (!view) {
    printJson({
      present: false,
      activeRoundId: state.activeRoundId ?? null,
      rounds: Object.keys(state.learningRounds ?? {}),
    });
    return;
  }
  printJson({ present: true, activeRoundId: state.activeRoundId ?? null, rounds: Object.keys(state.learningRounds ?? {}), round: view });
}

// Learner walkthrough position for a step-through interaction. This is
// observation only: it writes the current step and its exact content signature,
// never an attempt, rating, hint or mastery evidence, and it runs inside the
// same archive lock plus content/revision guard as every other public write.
async function cmdInteraction(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const interactionId = requireFlag(flags, 'id', '互动组件 id');
  const stepId = requireFlag(flags, 'step', '推演步骤 id');
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    applyInteractionPosition(state, model, { interactionId, stepId, source: 'cli' }, at));
  const view = interactionStepView(result.interaction, result.position);
  printJson({
    saved: true,
    state: statePath,
    interactionId,
    stepId,
    conceptId: result.position.conceptId,
    contentSignature: result.position.contentSignature,
    updatedAt: result.position.updatedAt,
    source: result.position.source,
    restored: view.restored,
    stale: view.stale,
    index: view.index,
    stepNumber: view.stepNumber,
    total: view.total,
    atFirst: view.atFirst,
    atLast: view.atLast,
  });
}

// The content-quality boundary for one concept, read-only. A target affected by
// a gap keeps that fact visible here so the plan never implies the outcome was
// passed while the material still has an unresolved gap.
function practiceQualityBoundary(view, conceptId) {
  const concept = view && view.concepts ? view.concepts[conceptId] : null;
  if (!concept) return { present: false, status: null, stale: true, gapCount: 0, blockingGaps: 0, outcomeStatus: null };
  const gaps = Array.isArray(concept.gaps) ? concept.gaps : [];
  return {
    present: true,
    status: concept.status ?? null,
    stale: Boolean(concept.stale),
    gapCount: gaps.length,
    blockingGaps: gaps.filter((gap) => gap && gap.effect === 'blocking').length,
    outcomeStatus: concept.outcomeStatus ?? null,
  };
}

// Read-only practice plan: for every target concept of the round, the selected
// author question, the reason it was chosen, the attempt it rests on, the
// author's judgement basis, and the content-quality boundary. It never writes.
function cmdPracticePlan(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const roundId = typeof flags['round-id'] === 'string' ? flags['round-id'] : (state.activeRoundId ?? null);
  const round = roundId ? (state.learningRounds ?? {})[roundId] ?? null : null;
  const quality = qualityView(readQualityFile(path.join(out, QUALITY_FILE), model), model);
  const qualitySummary = { present: quality.present, stale: quality.stale, staleReasons: quality.staleReasons };
  if (!round) {
    printJson({
      present: false,
      readOnly: true,
      roundId: roundId ?? null,
      activeRoundId: state.activeRoundId ?? null,
      rounds: Object.keys(state.learningRounds ?? {}),
      quality: qualitySummary,
      targets: [],
    });
    return;
  }
  const targets = (round.conceptIds ?? []).map((conceptId) => {
    const concept = model.byId.get(conceptId) ?? null;
    let selection;
    try {
      selection = practiceSelection(state, model, conceptId);
    } catch (err) {
      // A deleted concept (or any selection refusal) is reported honestly; the
      // read-only plan never crashes on one unresolved target.
      selection = { promptId: null, purpose: null, reason: err.message, basisAttemptId: null };
    }
    const prompt = selection.promptId ? model.prompts.find((item) => item.id === selection.promptId) ?? null : null;
    return {
      conceptId,
      conceptTitle: concept ? concept.title : null,
      conceptMissing: !concept,
      selection: {
        promptId: selection.promptId,
        purpose: selection.purpose,
        reason: selection.reason,
        basisAttemptId: selection.basisAttemptId,
      },
      judgement: {
        kind: prompt ? prompt.kind : null,
        criteria: prompt ? (prompt.criteria ?? []).slice() : [],
        hintCount: selection.promptId ? roundHintTexts(model, selection.promptId).length : 0,
      },
      teaching: prompt && prompt.teaching ? prompt.teaching : null,
      quality: practiceQualityBoundary(quality, conceptId),
    };
  });
  printJson({
    present: true,
    readOnly: true,
    roundId: round.id,
    goal: round.goal,
    budgetMinutes: round.budgetMinutes ?? null,
    status: round.status,
    modelFingerprint: model.modelFingerprint,
    quality: qualitySummary,
    targets,
  });
}

// Read-only budgeted review selection. `allDue` is the complete due list;
// `selected` and `deferred` are the budget-filtered plan. No attempt, schedule,
// round task or completion flag is written.
function cmdReviewPlan(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const options = {};
  if (typeof flags['round-id'] === 'string') options.roundId = flags['round-id'];
  if (flags.minutes !== undefined && flags.minutes !== true) {
    if (flags.minutes === 'none') options.budgetMinutes = null;
    else {
      const minutes = Number(flags.minutes);
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw new EmberError(CODES.USAGE, `--minutes 需要是正整数或 none，收到 ${JSON.stringify(flags.minutes)}`);
      }
      options.budgetMinutes = minutes;
    }
  }
  const focusPrompts = flagList(flags['focus-prompt']);
  if (focusPrompts !== undefined) options.focusPromptIds = focusPrompts;
  const plan = reviewPlan(state, model, options, typeof flags.at === 'string' ? flags.at : undefined);
  printJson({
    readOnly: true,
    out,
    timeSource: typeof flags.at === 'string' ? 'explicit-test-time' : 'current',
    timeNote: typeof flags.at === 'string'
      ? '--at 是用于独立测试目录的模拟时间，不代表真实保持效果。'
      : null,
    ...plan,
  });
}

// Read-only insight view. It aggregates the real archive records for every
// concept (or one requested concept) and never writes a note, a mastery claim
// or a derived fact.
function cmdInsights(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const conceptId = flags.concept !== undefined && flags.concept !== true ? String(flags.concept) : undefined;
  const view = insightRead(state, model, conceptId);
  printJson({
    readOnly: true,
    out,
    conceptId: conceptId ?? null,
    concepts: view.concepts,
  });
}

// Build the fingerprint bundle (model + learner question fingerprints) exactly
// as the page and server do, so the CLI's staleness rule matches the rendered
// page for the same content version.
function reviewFingerprints(model, state) {
  return {
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: collectPromptFingerprints(model, state),
    conceptFingerprints: { ...model.conceptFingerprints },
  };
}

async function cmdReviewStart(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const requestId = requireFlag(flags, 'request-id', '稳定请求ID');
  const history = flags.history === true;
  const input = { requestId, history };
  if (!history) {
    input.roundId = requireFlag(flags, 'round-id', '轮次ID；无轮次历史请用 --history --attempt');
  } else {
    input.attemptIds = flagList(flags.attempt);
    if (input.attemptIds === undefined) {
      throw new EmberError(CODES.USAGE, '历史复核需要至少一个 --attempt <作答ID> 指定范围');
    }
  }
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    startReviewRequest(state, model, input, at));
  printJson({
    saved: true,
    state: statePath,
    requestId: result.request.id,
    scope: result.request.scope,
    roundId: result.request.roundId ?? null,
    created: result.changed,
    members: result.request.members.map((member) => ({
      promptId: member.promptId,
      attemptId: member.attemptId,
      conceptId: member.conceptId,
      status: member.status,
    })),
  });
}

function cmdReviewRead(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const requestId = typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined;
  const roundId = typeof flags['round-id'] === 'string' ? flags['round-id'] : undefined;
  const fingerprints = reviewFingerprints(model, state);
  // `--history` (or no round at all) reads the unbound-history scope: the
  // concrete answers a learner can choose from, plus historical requests.
  const historyOnly = flags.history === true;
  // No filter at all summarises the active round's next work and still lists
  // the unbound history answers so the learner can choose an explicit range.
  const options = requestId !== undefined
    ? { requestId }
    : { roundId: roundId !== undefined ? roundId : (state.activeRoundId ?? null) };
  const summary = historyOnly
    ? tutorReviewSummary(state, { roundId: null, scope: 'history' }, fingerprints)
    : tutorReviewSummary(state, options, fingerprints);
  if (requestId !== undefined && summary.requests.length === 0) {
    // An unknown request id is reported honestly instead of looking empty.
    printJson({ present: false, requestId, roundId: summary.roundId, requests: [], ...summary });
    return;
  }
  printJson({ present: true, ...summary });
}

async function cmdReviewItem(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const requestId = requireFlag(flags, 'request-id', '稳定请求ID');
  const promptId = requireFlag(flags, 'prompt', '题目ID');
  const attemptId = requireFlag(flags, 'attempt-id', '作答ID');
  const feedbackPath = requireFlag(flags, 'feedback', '反馈JSON文件');
  const feedback = readJson(path.resolve(String(feedbackPath)), `反馈文件 ${feedbackPath}`);
  if (!isRecord(feedback)) throw new EmberError(CODES.USAGE, '反馈文件必须是 JSON 对象');
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const result = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    applyReviewItem(state, model, { requestId, promptId, attemptId, feedback }, at));
  printJson({
    saved: true,
    state: statePath,
    requestId,
    promptId,
    attemptId,
    changed: result.changed,
    rated: result.rated,
    status: result.member.status,
    reason: result.member.reason ?? null,
    feedback: result.member.feedback ?? null,
  });
}

async function cmdImport(flags) {
  const out = requireOut(flags);
  const incomingPath = requireFlag(flags, 'state', '要导入的状态文件');
  const modelPath = modelPathFor(flags, out);
  // Here --state is the file being imported, not an override of the durable
  // archive path, so import always merges into <out>/state.json.
  const statePath = archivePathFor(path.join(out, DEFAULT_OUT_FILES.state));
  const incoming = readJson(path.resolve(String(incomingPath)), `导入状态 ${incomingPath}`);
  const at = typeof flags.at === 'string' ? flags.at : nowIso();
  const merged = await withArchiveWrite(out, statePath, modelPath, (state, model) =>
    ({ state: mergeImportedState(state, incoming, model, at) }));
  printJson({
    imported: true,
    state: statePath,
    revision: merged.state.revision,
    conflicts: merged.state.conflicts.length,
    orphans: merged.state.orphans.length,
  });
}

async function cmdRestore(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const statePath = statePathFor(flags, out);
  const backupPath = flags.backup !== undefined && flags.backup !== true
    ? path.resolve(String(flags.backup))
    : undefined;
  const expectedFingerprint = readModelFile(modelPath).modelFingerprint;
  const result = await withArchiveLock(archiveLockDirs(out, statePath, modelPath), async () => {
    const model = readModelFile(modelPath);
    if (model.modelFingerprint !== expectedFingerprint) {
      throw new EmberError(CODES.CONFLICT, '学习内容在等待恢复期间已更新；请核验当前内容后重试，本次未恢复');
    }
    // The current archive is only a guard here, not a prerequisite: a truncated
    // or malformed live archive must not block recovery from a verified backup.
    // A readable archive that is a newer unsupported format or a different model
    // is still refused, and the backup itself is validated independently.
    if (fileExists(statePath)) {
      let rawCurrent = null;
      try { rawCurrent = readJson(statePath, `状态文件 ${statePath}`); } catch { rawCurrent = null; }
      if (isRecord(rawCurrent)) {
        if (Number.isInteger(rawCurrent.schemaVersion) && rawCurrent.schemaVersion > STATE_SCHEMA_VERSION) {
          throw new EmberError(CODES.STATE,
            `当前档案格式版本 ${rawCurrent.schemaVersion} 高于当前工具支持的版本 ${STATE_SCHEMA_VERSION}；拒绝恢复，以免覆盖更新的档案`);
        }
        if (typeof rawCurrent.modelId === 'string' && rawCurrent.modelId !== model.id) {
          throw new EmberError(CODES.IDENTITY, `当前档案属于模型 ${rawCurrent.modelId}，当前模型是 ${model.id}，拒绝恢复`);
        }
        if (rawCurrent.schemaVersion === STATE_SCHEMA_VERSION &&
            typeof rawCurrent.modelFingerprint === 'string' &&
            rawCurrent.modelFingerprint !== model.modelFingerprint) {
          throw new EmberError(CODES.CONFLICT, '学习内容与当前档案内容版本不一致；请核验后重试，本次未恢复');
        }
      }
    }
    return restoreArchiveBackup({ statePath, model, backupPath });
  });
  printJson(result);
}

function cmdExport(flags) {
  const out = requireOut(flags);
  const to = requireFlag(flags, 'to', '导出目标路径');
  const model = readModelFile(modelPathFor(flags, out));
  const { state } = readStateFor(out, model, flags);
  const target = path.resolve(String(to));
  atomicWrite(target, stableStringify(state));
  printJson({ exported: true, from: statePathFor(flags, out), to: target, revision: state.revision });
}

function readQualityArg(flags) {
  const file = flags.quality;
  if (file === undefined || file === true) throw new EmberError(CODES.USAGE, '缺少 --quality <quality.json>');
  return path.resolve(String(file));
}

function cmdQualityTemplate(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const template = buildTemplate(model, nowIso());
  if (flags.to !== undefined && flags.to !== true) {
    const target = path.resolve(String(flags.to));
    // The skeleton has empty roles and no checks; writing it over an existing
    // record (for example <out>/quality.json) would replace a validated report
    // with an unvalidated draft. Refuse without touching the file and point at
    // a fresh draft path instead.
    if (fileExists(target)) {
      throw new EmberError(CODES.CONFLICT,
        `目标文件已存在：${target}；为避免覆盖已有内容，本次未写入。` +
        '请改用一个新的草稿路径（例如 quality-draft.json），填写核对后再用 quality-write 写入');
    }
    atomicWrite(target, stableStringify(template));
    printJson({ template: true, to: target, modelId: model.id, concepts: template.goals[0].concepts.length });
    return;
  }
  printJson(template);
}

function cmdQualityValidate(flags, positional) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const qualityPath = positional[0] !== undefined
    ? path.resolve(String(positional[0]))
    : readQualityArg(flags);
  const quality = normalizeQuality(readJson(qualityPath, `质检文件 ${qualityPath}`), model);
  const view = qualityView(quality, model);
  printJson({
    valid: true,
    file: qualityPath,
    modelId: quality.modelId,
    goals: quality.goals.length,
    stale: view.stale,
    staleReasons: view.staleReasons,
  });
}

async function cmdQualityWrite(flags) {
  const out = requireOut(flags);
  const modelPath = modelPathFor(flags, out);
  const qualityPath = readQualityArg(flags);
  const raw = readJson(qualityPath, `质检文件 ${qualityPath}`);
  // Validate structure and scope against the content the command was issued
  // against, then re-read inside the lock so a concurrent build cannot land
  // between the check and the write.
  const expected = readModelFile(modelPath).modelFingerprint;
  const currentModel = readModelFile(modelPath);
  const incoming = normalizeQuality(raw, currentModel);
  // Top scope, every per-goal scope/outcome, and full concept declaration are
  // all required: a record may not be written while any of them is stale or
  // while a current model concept is left undeclared.
  const incomingReasons = [
    ...recordScopeReasons(incoming, currentModel),
    ...recordDeclarationReasons(incoming, currentModel),
  ];
  if (incomingReasons.length > 0) {
    throw new EmberError(CODES.CONFLICT,
      `内容质检范围与当前学习内容或目标不一致：${incomingReasons.join('；')}；请按当前模型重新核对后再写入，本次未写入`);
  }
  const target = path.join(out, QUALITY_FILE);
  const result = await withArchiveLock([out], async () => {
    const model = readModelFile(modelPath);
    if (model.modelFingerprint !== expected) {
      throw new EmberError(CODES.CONFLICT, '学习内容在等待写入期间已更新；请重新核对质检范围，本次未写入');
    }
    const normalized = normalizeQuality(raw, model);
    const reasons = [
      ...recordScopeReasons(normalized, model),
      ...recordDeclarationReasons(normalized, model),
    ];
    if (reasons.length > 0) {
      throw new EmberError(CODES.CONFLICT, `内容质检范围与当前学习内容或目标不一致：${reasons.join('；')}；本次未写入`);
    }
    atomicWrite(target, stableStringify(qualityToJson(normalized)));
    return normalized;
  });
  printJson({
    written: true,
    quality: target,
    modelId: result.modelId,
    goals: result.goals.length,
    modelFingerprint: result.modelFingerprint,
  });
}

function cmdQualityRead(flags) {
  const out = requireOut(flags);
  const model = readModelFile(modelPathFor(flags, out));
  const qualityPath = path.join(out, QUALITY_FILE);
  const quality = readQualityFile(qualityPath, model);
  printJson({ path: qualityPath, ...qualityView(quality, model) });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const rest = positional.slice(1);
  // Validate destinations before creating locks, directories or files.
  // Read-only inputs remain available for recovery and export.
  const outputs = {
    build: ['out', 'state', 'scene'], serve: ['out', 'state'],
    submit: ['out', 'state'], practice: ['out', 'state'], correction: ['out', 'state'],
    'correction-record': ['out', 'state'], review: ['out', 'state'], assess: ['out', 'state'],
    evidence: ['out', 'state'], round: ['out', 'state'], interaction: ['out', 'state'],
    'review-start': ['out', 'state'], 'review-item': ['out', 'state'],
    import: ['out'], restore: ['out', 'state'], 'quality-write': ['out'],
    export: ['to'], 'quality-template': ['to'],
  };
  for (const flag of outputs[command] ?? []) {
    if (flags[flag] !== undefined) assertLearningOutput(flags[flag], `--${flag}`);
  }
  if (command === 'library' && ['register', 'remove'].includes(rest[0])) {
    assertLearningOutput(catalogPath(flags.catalog), '--catalog');
  }
  switch (command) {
    case 'library':
      await cmdLibrary(flags, rest);
      return;
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return;
    case 'validate':
      cmdValidate(flags, rest);
      return;
    case 'build':
      await cmdBuild(flags, rest);
      return;
    case 'serve':
      await cmdServe(flags);
      return;
    case 'due':
      cmdDue(flags);
      return;
    case 'submit':
    case 'practice':
    case 'correction':
      await cmdDurable(command, flags);
      return;
    case 'correction-record':
      await cmdCorrectionRecord(flags);
      return;
    case 'correction-read':
      cmdCorrectionRead(flags);
      return;
    case 'resume-read':
      cmdResumeRead(flags);
      return;
    case 'review':
      await cmdReview(flags);
      return;
    case 'assess':
      await cmdAssess(flags);
      return;
    case 'evidence':
      await cmdEvidence(flags);
      return;
    case 'round':
      await cmdRound(flags);
      return;
    case 'round-read':
      cmdRoundRead(flags);
      return;
    case 'practice-plan':
      cmdPracticePlan(flags);
      return;
    case 'review-plan':
      cmdReviewPlan(flags);
      return;
    case 'insights':
      cmdInsights(flags);
      return;
    case 'interaction':
      await cmdInteraction(flags);
      return;
    case 'review-start':
      await cmdReviewStart(flags);
      return;
    case 'review-read':
      cmdReviewRead(flags);
      return;
    case 'review-item':
      await cmdReviewItem(flags);
      return;
    case 'import':
      await cmdImport(flags);
      return;
    case 'export':
      cmdExport(flags);
      return;
    case 'quality-template':
      cmdQualityTemplate(flags, rest);
      return;
    case 'quality-validate':
      cmdQualityValidate(flags, rest);
      return;
    case 'quality-write':
      await cmdQualityWrite(flags);
      return;
    case 'quality-read':
      cmdQualityRead(flags);
      return;
    case 'restore':
      await cmdRestore(flags);
      return;
    default:
      throw new EmberError(CODES.USAGE, `未知命令：${command}。运行 help 查看用法。`);
  }
}

main().catch((err) => {
  if (err instanceof EmberError) {
    process.stderr.write(`forge 错误 [${err.code}]：${err.message}\n`);
    if (err.code === CODES.CONFLICT) {
      try {
        const { positional, flags } = parseArgs(process.argv.slice(2));
        const out = requireOut(flags);
        const model = readModelFile(modelPathFor(flags, out));
        const statePath = positional[0] === 'import' ? archivePathFor(path.join(out, DEFAULT_OUT_FILES.state)) : statePathFor(flags, out);
        const archive = readArchive(statePath, model);
        const current = archive.exists ? archive.state : createState(model);
        process.stderr.write(JSON.stringify({ statePath, ...stateResponse(model, current) }, null, 2) + '\n');
      } catch (readErr) {
        process.stderr.write(`当前档案暂不可读取：${readErr.message}\n`);
      }
    }
  } else {
    process.stderr.write(`forge 未预期错误：${err && err.stack ? err.stack : err}\n`);
  }
  process.exitCode = 1;
});
