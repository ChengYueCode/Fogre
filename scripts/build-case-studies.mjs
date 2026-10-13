#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { UPSTREAM_COMMIT, GROUPS, LESSONS, UNITS } from './lib/mattpocock-course.mjs';
import { courseModels } from './lib/mattpocock-models.mjs';
import { renderLearningHub, renderQuickReference } from './lib/mattpocock-pages.mjs';
import { renderCaseReport } from './lib/case-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !args[1].trim()) throw new Error('Usage: node scripts/build-case-studies.mjs --out <new-directory>');
const output = path.resolve(args[1]);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output, { recursive: false });
const inventory = JSON.parse(await fs.readFile(path.join(root, 'examples/mattpocock-skills/sources.json'), 'utf8'));
const models = courseModels(inventory);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mattpocock-tool-'));
const commands = [];
const clean = value => typeof value === 'string' ? value.split(temp).join('<isolated-tool-directory>').split(output).join('<case-output>').split(root).join('<source>') : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)])) : value;
const write = async (file, value) => fs.writeFile(file, `${JSON.stringify(value,null,2)}\n`, 'utf8');
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
function run(...command) {
  const result=spawnSync(process.execPath,[path.join(root,'bin/forge.mjs'),...command],{cwd:root,encoding:'utf8',maxBuffer:12*1024*1024});
  if(result.status!==0)throw new Error(`${command[0]}: ${(result.stderr||result.stdout).slice(0,700)}`);
  commands.push(clean(command)); return clean(JSON.parse(result.stdout));
}
const sourceById = Object.fromEntries(models.overview.sources.map(source=>[source.id,source]));
const sourceRows = Object.fromEntries(inventory.skills.map(entry=>[`src-${entry.name}`,entry]));
const dimensions=['goal-coverage','prerequisite','explanation-example','boundary-misconception','task-criteria','sources-gaps'];
try {
  await write(path.join(output,'sources.json'),inventory);
  await fs.copyFile(path.join(root,'examples/mattpocock-skills/UPSTREAM-LICENSE.txt'),path.join(output,'UPSTREAM-LICENSE.txt'));
  for(const [name,model] of Object.entries(models)) {
    const input=path.join(temp,`${name}.json`);await write(input,model);
    const dir=path.join(output,name);run('build',input,'--out',dir,'--svg');
    const quality=run('quality-template','--out',dir);
    const template=quality.template ?? quality; // CLI normally returns the template itself.
    if(!template.goals)throw new Error('Unexpected quality template');
    for(const item of template.goals[0].concepts) {
      const concept=model.concepts.find(row=>row.id===item.id);
      const structural=GROUPS.some(([id])=>id===item.id)||['skills','engineering-flow','choose'].includes(item.id)||LESSONS.some(lesson=>lesson.name===item.id&&lesson.group==='appendix');
      item.role=structural?'structural':'core';
      if(!structural) {
        const refs=(model.conceptSources?.[item.id]??['src-ask-matt']).map(id=>sourceById[id]?.title??id).join('；');
        const questions=model.prompts.filter(prompt=>prompt.conceptId===item.id);
        item.dimensions=dimensions.map(id=>({id,result:questions.length||id!=='task-criteria'?'covered':'partial',basis:({
          'goal-coverage':`本概念以“${concept.title}”支持入口选择、输入与边界解释；对应作者讲解已与 ${refs} 核对。`,
          prerequisite:`先交代技能/入口、项目上下文与用户决定；涉及固定版本 ${UPSTREAM_COMMIT.slice(0,7)} 的条件，不把未知安装或学习基础当成已确认。`,
          'explanation-example':`讲解：${concept.explanation}；例子：${concept.example}。中文情境为教学组织，不声称实际执行。`,
          'boundary-misconception':`边界和误区：${concept.misconception}。不把阅读、建议或生成页面当成已运行与已掌握。`,
          'task-criteria':questions.length?`已核对 ${questions.map(q=>q.id).join('、')} 的题目、参考与判定标准与本概念一致。`:'本节点解释路线整体，分步观察问题尚无独立作者判定题；需后续补充整体迁移作答依据。',
          'sources-gaps':`来源以固定提交链接及行范围定位：${refs}。支持模板的完整运行、其他宿主和外部链接不属于本材料已验证范围。`
        })[id],supplementIds:[]}));
      }
    }
    for(const source of template.materialMap.sources) {
      const row=sourceRows[source.sourceId];source.version=UPSTREAM_COMMIT;
      source.structure=['用途与身份','输入与流程','输出、用户决定与边界','必要引用'];
      const ids=model.concepts.filter(c=>(model.conceptSources?.[c.id]??[]).includes(source.sourceId)).map(c=>c.id);
      source.goalScope=ids.map(conceptId=>({conceptId,range:row?`${row.sourcePath} 1–${row.lines} 行`:'固定版本的对应章节'}));
      source.checked=[{range:row?`${row.sourcePath} 入口全文 1–${row.lines} 行`:'总体说明/调用机制/阶段边界的相关完整章节',basis:'逐项核对定位、所需输入、自带步骤、用户决定、输出与限制；教学次序与示范假设另行说明。',readAt:new Date().toISOString()}];
      source.unread=['未作为本课程操作依据的支持模板实现细节与外部链接'];source.gaps=[];
    }
    const qualityFile=path.join(temp,`${name}-quality.json`);await write(qualityFile,template);
    run('quality-write','--out',dir,'--quality',qualityFile);const checked=run('quality-read','--out',dir);await write(path.join(dir,'quality-readback.json'),checked);
    run('build',path.join(dir,'model.json'),'--out',dir,'--svg');
    const state=await read(path.join(dir,'state.json'));if(Object.keys(state.attempts).length||Object.keys(state.conceptEvidence).length)throw new Error('Author materials contain learner evidence.');
  }
  // Reproducible authored layout edit for the workflow diagram only.
  // Detached relation notes keep the editor labels clear of the skill nodes.
  const sceneFile=path.join(output,'workflow/map.excalidraw');const scene=await read(sceneFile);
  const model=models.workflow;
  let labelIndex=0;
  for(const element of scene.elements){
    const relation=model.relations.find(r=>`l-${r.id}`===element.id);
    if(relation){element.x=labelIndex*650;element.y=340;element.width=620;element.height=44;element.fontSize=15;element.text=`${relation.from} → ${relation.to}\n${relation.label}`;element.originalText=element.text;element.version+=1;labelIndex++;}
  }
  await write(sceneFile,scene);run('build',path.join(output,'workflow/model.json'),'--out',path.join(output,'workflow'),'--svg');
  const byName=Object.fromEntries(inventory.skills.map(item=>[item.name,item]));
  const header=`来源：[mattpocock/skills 固定提交](https://github.com/mattpocock/skills/tree/${UPSTREAM_COMMIT})，2026-10-13 核对。中文说明、学习顺序与教学场景由 Forge 编写；未填入真人作答和掌握结论。\n`;
  let handbook=`# 学习 mattpocock/skills：完整中文学习手册\n\n${header}\n## 怎样使用\n\n先看 [8 单元路线](ROUTE.md)，再按当前问题定位技能。必要输入来自上下文或材料；自带流程无需每次在提示词里重复。以下最小请求均为教学用法，不表示上游入口已在你的宿主安装或执行。正式入口 27 个，试验 7 个，冻结 4 个；弃用目录为空。\n\n`;
  for(const [group,title] of GROUPS) {
    handbook+=`## ${title}\n\n`;
    for(const lesson of LESSONS.filter(item=>item.group===group)) {
      const entry=byName[lesson.name];handbook+=`### ${lesson.name}：${lesson.title}\n\n**目录与调用身份**：${entry.bucket}；${entry.invocation==='user'?'用户显式发起':'模型与用户均可发起'}。\n\n**场景**：${lesson.scene}\n\n**必要输入**：${lesson.input}\n\n**技能自带流程**：${lesson.process}\n\n**预期产物**：${lesson.output}\n\n**边界与停止条件**：${lesson.boundary}\n\n**最小请求**（已安装并加载时）：\n\n\`\`\`text\n${lesson.request}\n\`\`\`\n\n**自检**：${lesson.question}\n\n[入口原文：1–${entry.lines} 行](${entry.sourceUrl}#L1-L${entry.lines})。参考解释见 [ANSWERS.md](ANSWERS.md)。\n\n`;
    }
  }
  handbook+=`## 四个关键核对\n\n1. 用户入口与模型入口区别在发起权限；模型入口并不排斥用户使用，路由器也不能自动执行用户入口。\n2. to-spec 综合已有讨论，并确认测试接口位置；这不是新一轮全需求采访。to-tickets 另需用户审核切片与阻塞。\n3. 本快照 README 有一般红绿重构介绍，但当前 tdd 入口将重构放到 review 阶段；以具体入口规则解释操作，不消除这层差异。\n4. in-progress 的目录文件与简介可能不同步：实际文件树存在 chief-of-staff，来源清单以固定提交文件树为准。试验条目不等于正式插件承诺。\n\n来源与范围：[SOURCE-MAP.md](SOURCE-MAP.md)。\n`;
  await fs.writeFile(path.join(output,'HANDBOOK.md'),handbook);
  await fs.writeFile(path.join(output,'ROUTE.md'),`# 8 单元学习路线\n\n${header}\n这是教学建议，约 120 分钟（每单元约 15 分钟），不承诺固定时间掌握。可以按可用预算只做一个单元；未完成内容留下，下一次继续。基础与掌握程度未评估。\n\n| 单元 | 内容 | 相关入口 | 可检查的成果 |\n| --- | --- | --- | --- |\n${UNITS.map(([n,t,m,names,goal])=>`| ${n} / ${m} 分钟 | ${t} | ${names.join('、')||'综合迁移与附录'} | ${goal} |`).join('\n')}\n\n## 每个单元怎样结束\n\n读相关原文和讲解 → 不看参考，自己说明选择 → 对照标准找缺口 → 保存原答与帮助来源 → 如需复核，交给 Agent。结束条件是本轮可观察目标或时间预算，不是“已经打开所有页面”。\n\n## 下一次从哪里开始\n\n真实作答存入自己的目录后，请 /forge 读回目标、原答、修正与暂停位置；不要将公开样例或合成演示当成自己的历史。只整理材料时不强制创建轮次。\n`);
  const questions=[...models.overview.prompts,...models.comparisons.prompts];
  await fs.writeFile(path.join(output,'EXERCISES.md'),`# 练习：场景选择、边界与迁移\n\n${header}\n共 ${questions.length} 道作者题，包含正式技能检验与试验/冻结边界核对。先作答，再看 [参考解释](ANSWERS.md)。这些题和标准不是学习者已提交的答案。\n\n${questions.map((q,i)=>`## ${String(i+1).padStart(2,'0')} · ${q.id}\n\n${q.question}\n\n**检查标准**：${q.criteria.join('；')}。\n\n**我的原答**：\n\n>\n\n**是否借助提示、参考或反馈**：\n\n>\n`).join('\n')}\n## 综合任务\n\n教学假设：一份新资料检索功能需求已经明确，但有多个互相依赖的任务。请说明下一入口、必要输入、预期产物、谁要确认和何时能并行；再说明出现难复现错误时，为什么应先建立反馈而不是继续猜原因。\n`);
  await fs.writeFile(path.join(output,'ANSWERS.md'),`# 作者参考解释与核对标准\n\n${header}\n这里是作者参考，不是你的原答或已经批改的结果。有帮助的修正仍保留帮助来源，不升级为独立成功。\n\n${questions.map((q,i)=>`## ${String(i+1).padStart(2,'0')} · ${q.id}\n\n${q.answer}\n\n核对：${q.criteria.join('；')}。\n`).join('\n')}`);
  await fs.writeFile(path.join(output,'MISSION.md'),`# 本资料的学习目标\n\n本次任务是围绕 mattpocock/skills 制作完整学习资料及 Forge 公开案例。资料组织目标：从真实入口原文理解适用场景、必要输入、自带流程、用户决定和产物边界。\n\n这是本次资料任务的目标说明，不是代写学习者画像；个人背景、进度、真实解释、作答和掌握状态仍未知。\n`);
  await fs.writeFile(path.join(output,'TERMS.md'),`# 学习术语速查\n\n${header}\n| 术语 | 在材料中的含义 |\n| --- | --- |\n| 用户入口 | 需要用户明确发起，其他技能和路由器不能自动替人发起。 |\n| 模型入口 | 模型可按场景使用，用户也能显式调用。 |\n| 路由器 | 阅读入口后建议选什么，不是自动流水线执行器。 |\n| 纵向切片 | 窄而完整、能单独验证的跨层行为；宽机械迁移是例外。 |\n| 阻塞边 / 就绪前沿 | 任务依赖以及前置已完成、可领取的工作。 |\n| 决定任务 | wayfinder 解决的决定，不等同于交付实现的任务。 |\n| Module / Interface | 模块与调用者须掌握的全部接口知识，不只类型签名。 |\n| Depth | 少量接口知识带来的行为能力，不是代码行数比。 |\n| Seam / Adapter | 可以替换行为的位置，以及在该位置满足接口的具体适配者。 |\n| Leverage / Locality | 对调用者的能力收益，与对维护者的变更集中程度。 |\n| Standards / Spec | 编码规范与需求符合度两条独立审查轴。 |\n| 上下文指针 | 说明材料是什么，以及什么条件下应读它的引用。 |\n| 流利 / 保持 | 当下可提取与长期存储表现；阅读和自评不自动证明保持。 |\n\n概念依据来自 codebase-design、writing-for-agents、teach 和目录说明；详见来源清单。\n`);
  await fs.writeFile(path.join(output,'LEARNING-RECORD-TEMPLATE.md'),'# 空白学习记录模板\n\n本文件未填入真人表现，填写后才可作为需要核对的输入。\n\n- 主题与固定来源版本：\n- 当前目标 / 单元 / 时间预算：\n- 题目身份：\n- 我的原答（保留原文）：\n- 借助的提示、参考或反馈：\n- 后续修正（另记，不覆盖原答）：\n- Agent 复核依据与未决项：\n- 实际保存目录与读回结果：\n- 暂停位置和下一步：\n\n有协助答对不自动证明独立成功；作者参考和工具合成记录不能填写成自己的原答。\n');
  await fs.writeFile(path.join(output,'SOURCE-MAP.md'),`# 固定来源、阅读范围与未核对项\n\n${header}\n## 版本与定位\n\n提交：\`${UPSTREAM_COMMIT}\`。38 个入口的每项输入、过程、输出与边界依据入口原文；涉及复用纪律时回读相关原文。其余支持模板和外部链接不据文件哈希冒充已经全文讲授、执行或验收。完整目录及 ${inventory.files.length} 个原始文件的 SHA-256 在 [sources.json](sources.json)。\n\n## 入口定位\n\n| 入口 | 目录 | 发起身份 | 固定来源与行范围 |\n| --- | --- | --- | --- |\n${inventory.skills.map(s=>`| ${s.name} | ${s.bucket} | ${s.invocation} | [${s.sourcePath}：1–${s.lines}](${s.sourceUrl}#L1-L${s.lines}) |`).join('\n')}\n\n## 重要差异与限制\n\n- 总体说明与入口细则处于不同层级：to-spec 不是完整的新需求访谈；tdd 入口将重构放在 review 阶段。\n- in-progress 简介未列全实际入口，chief-of-staff 以文件树为准，仍按试验处理。\n- 正式入口规则不证明所有宿主已经安装发现或能运行；本次不安装上游技能到个人目录，也不执行其 Git、外发或凭据步骤。\n- 截图和结构/质检记录证明对应产物和作者核对范围，不证明真人理解或长期保持。\n- MIT 许可随包保留；中文说明与教学案例由本项目编写，不冒充上游官方教程。\n`);
  await fs.writeFile(path.join(output,'index.html'),renderLearningHub(inventory));
  await fs.writeFile(path.join(output,'quick-reference.html'),renderQuickReference(inventory));
  // A separate synthetic tool fixture, never a delivered learner archive.
  const demo=path.join(temp,'tool-demo');run('build',path.join(output,'overview/model.json'),'--out',demo,'--svg');
  const round=run('round','--out',demo,'--action','create','--round-id','matt-skills-demo','--entry','organize-existing-material','--goal','区分用户入口、模型入口与路由建议（合成工具演示）','--concept','invocation','--concept','to-spec','--minutes','45');
  const task=round.round.tasks.find(t=>t.promptId==='p-invocation');if(!task||task.deferred)throw new Error('Invocation task not actionable');
  run('round','--out',demo,'--action','focus','--round-id',round.round.id,'--task-id',task.id);
  const answer='这些技能都能由模型自动触发；ask-matt 给出路线后就会替我执行 to-spec 和 implement-spec。';
  const corrected='用户入口要由用户明确发起，ask-matt 只给建议；模型入口可由 Agent 复用，用户也能显式使用。';
  run('practice','--out',demo,'--prompt','p-invocation','--session-id','matt-demo-session','--round-id',round.round.id,'--task-id',task.id,'--draft',answer);
  const submitted=run('submit','--out',demo,'--prompt','p-invocation','--answer',answer,'--attempt-id','matt-demo-original','--session-id','matt-demo-session','--round-id',round.round.id,'--task-id',task.id);
  run('review-start','--out',demo,'--request-id','matt-demo-review','--round-id',round.round.id);
  const feedback={status:'completed',correct:'原答知道 ask-matt 会提供技能路线建议。',misconceptions:'把路由建议当成执行，并把全部入口混为模型自动触发；遗漏用户入口的显式发起要求。',basis:`固定提交 ${UPSTREAM_COMMIT.slice(0,7)} 的 README Reference、SKILL-MECHANICS 的 Invocation/Router skills，以及 p-invocation 的三条标准。`,repair:'区分“人发起用户入口”“Agent 或人使用模型入口”“路由器只提示下一入口”。to-spec 和 implement-spec 不能被 ask-matt 自动发起。',nextTask:'解释为什么 to-spec 的测试接口确认不是一轮完整的需求访谈。',rating:'again',targetCorrectionId:null};
  const feedbackFile=path.join(temp,'feedback.json');await write(feedbackFile,feedback);run('review-item','--out',demo,'--request-id','matt-demo-review','--prompt','p-invocation','--attempt-id','matt-demo-original','--feedback',feedbackFile);
  const correction=run('correction','--out',demo,'--prompt','p-invocation','--attempt-id','matt-demo-original','--text',corrected,'--correction-id','matt-demo-correction','--assistance','tutor-feedback');
  const review=run('review-read','--out',demo,'--request-id','matt-demo-review');
  run('round','--out',demo,'--action','pause','--round-id',round.round.id);
  const before=await fs.readFile(path.join(demo,'state.json'));const paused=run('resume-read','--out',demo,'--round-id',round.round.id);if(!before.equals(await fs.readFile(path.join(demo,'state.json'))))throw new Error('Readback wrote the archive');
  const resumed=run('round','--out',demo,'--action','resume','--round-id',round.round.id);const afterResume=run('resume-read','--out',demo,'--round-id',round.round.id);
  const previewAt=new Date(Date.now()+86400000).toISOString();const plan=run('review-plan','--out',demo,'--round-id',round.round.id,'--minutes','15','--at',previewAt,'--focus-prompt','p-to-spec');const insights=run('insights','--out',demo,'--concept','invocation');
  const state=await read(path.join(demo,'state.json'));if(state.attempts['p-invocation'].length!==1||state.attempts['p-invocation'][0].answer!==answer||Object.keys(state.conceptEvidence).length||Object.keys(state.promptEvidence).length||paused.round.id!==afterResume.round.id||paused.position.currentTask.id!==afterResume.position.currentTask.id)throw new Error('Tool demonstration invariant failed');
  const report={kind:'synthetic-cli-demonstration',topic:'学习 mattpocock/skills',upstreamCommit:UPSTREAM_COMMIT,generatedAt:new Date().toISOString(),disclosure:'作答与反馈为合成演示，结果由公开 CLI 实际执行并读回；不是真人记录或完整 Agent 教学。',reviewClock:{kind:'simulated-next-day',at:previewAt},checks:{originalPreserved:true,correctionsDoNotAddAttempts:true,readbackDidNotWrite:true,masteryEvidenceEntries:0},submitted,correction,review,paused,resumed,afterResume,plan,insights,commands};
  await fs.mkdir(path.join(output,'tool-demo'));await write(path.join(output,'tool-demo/readback.json'),report);await fs.writeFile(path.join(output,'tool-demo/index.html'),renderCaseReport(report));
  console.log(JSON.stringify({output,upstream:UPSTREAM_COMMIT,entries:LESSONS.length,models:Object.keys(models),uniqueQuestions:questions.length,toolChecks:'passed',selected15Minutes:plan.selected.length,deferred15Minutes:plan.deferred.length}));
} finally { await fs.rm(temp,{recursive:true,force:true}); }
