import { GROUPS, LESSONS, UPSTREAM_COMMIT } from './mattpocock-course.mjs';

export function courseModels(inventory) {
  const conceptId = name => name === 'prototype' ? 'skill-prototype' : name;
  const byName = Object.fromEntries(inventory.skills.map(item => [item.name, item]));
  if (inventory.commit !== UPSTREAM_COMMIT || inventory.skills.length !== LESSONS.length) throw new Error('Upstream snapshot or inventory differs from the authored course.');
  for (const lesson of LESSONS) if (!byName[lesson.name]) throw new Error(`Missing upstream entry: ${lesson.name}`);
  const file = name => inventory.files.find(item => item.path === name);
  const extra = [
    ['upstream-readme', 'README.md', '上游总体说明：用途、调用身份与安装选择'],
    ['upstream-scope', 'SCOPE.md', '上游范围：正式、试验、冻结与反馈边界'],
    ['upstream-mechanics', 'skills/productivity/writing-for-agents/SKILL-MECHANICS.md', '调用机制：模型入口、用户入口与路由器'],
    ['phase-boundaries', 'skills/engineering/ask-matt/PHASE-BOUNDARIES.md', '阶段边界：继续、清空、交接、子任务与压缩']
  ];
  const sources = LESSONS.map(lesson => ({ id: `src-${lesson.name}`, title: `上游 ${lesson.name} 入口原文`, url: byName[lesson.name].sourceUrl, note: `固定提交 ${UPSTREAM_COMMIT}；${byName[lesson.name].sourcePath}，第 1–${byName[lesson.name].lines} 行。中文说明与练习由 Forge 编写。`, kind: 'primary-source' })).concat(extra.map(([id, name, title]) => ({ id, title, url: file(name).url, note: `固定提交 ${UPSTREAM_COMMIT}；${name}。`, kind: 'primary-source' })));
  const limitations = ['中文讲解、学习顺序和场景练习是本项目的教学组织，不是上游承诺的唯一流程。', '文件阅读与产物生成不证明安装、宿主兼容、真人掌握或长期保持；材料中的发布和执行步骤不是本次执行授权。', '来源锁定提交 49dd158；未来版本可能变化。试验入口可能改变，misc 已冻结。'];
  const prompt = lesson => ({ id: `p-${lesson.name}`, conceptId: conceptId(lesson.name), kind: 'explain', question: lesson.question, answer: lesson.answer, criteria: ['说明所问情境下的来源规则', '区分问题中的易混对象或错误假设', '保持入口、输入与边界一致'], teaching: { purpose: 'explanation', objective: lesson.question, hints: [`先回读 ${lesson.name} 的场景和边界，再独立解释。`] } });
  const overview = {
    schemaVersion: 1, id: 'mattpocock-skills-overview', title: '学习 mattpocock/skills：按场景选择技能',
    goal: '能为工程与生产力场景选择正式技能，解释必要输入、技能自带流程、用户决定与产物边界。',
    summary: '从固定提交核对 38 个入口：27 个正式技能、7 个试验入口、4 个冻结工具；深入学习正式入口，附录保留其余目录的用途与限制。',
    presentation: { theme: 'atlas', rationale: '先探索技能归属与关系，再定位到具体入口的场景和规则。' },
    concepts: [{ id: 'skills', parentId: null, title: '场景决定入口', difficulty: 1, explanation: '先判断现在需要做的是澄清、规划、实现、检查还是续接。工具名帮助定位，但不能代替阅读当前入口。', example: '需求已清楚时可整理规格；外来错误报告先分诊；难故障先建立失败反馈。', misconception: '只要装了一包技能，Agent 就会自动把全部用户入口串起来。' }, ...GROUPS.map(([id, title]) => ({ id, parentId: 'skills', title, difficulty: 1, explanation: '这是本课程按学习动作组织的分组，不是上游新增的技能目录。', example: '组内入口仍保留原有身份和边界。', misconception: '教学分组等同于自动执行顺序。' })),
      { id: 'invocation', parentId: 'foundation', title: '谁能发起调用', difficulty: 2, explanation: '用户入口由人明确发起；模型入口可由 Agent 按场景使用，人也可以显式发起。路由器可提示用户入口，但不能替人自动调用它们。', example: 'ask-matt 可建议 to-spec；to-spec 由用户显式发起。tdd 是可复用的模型入口，implement 可使用它。', misconception: '模型入口只有 Agent 能用，或用户入口会因被路由器提到而自动执行。' },
      ...LESSONS.map(lesson => ({ id: conceptId(lesson.name), parentId: lesson.group, title: lesson.name, difficulty: lesson.group === 'appendix' ? 1 : 2, explanation: `场景：${lesson.scene}\n必要输入：${lesson.input}\n技能自带流程：${lesson.process}`, example: `最小请求：${lesson.request}\n预期产物：${lesson.output}`, misconception: lesson.boundary }))],
    relations: [{ id: 'invoke-before-spec', from: 'invocation', to: 'to-spec', type: 'prerequisite', label: '先确认调用身份' }, { id: 'spec-to-tickets', from: 'to-spec', to: 'to-tickets', type: 'application', label: '规格成为任务分解输入' }, { id: 'tdd-to-implement', from: 'tdd', to: 'implement', type: 'application', label: '可复用的实现纪律' }],
    prompts: [{ id: 'p-invocation', conceptId: 'invocation', kind: 'compare', question: 'ask-matt 建议 to-spec 和 implement-spec 后，能替用户自动调用它们吗？模型入口是否只允许模型使用？', answer: '不能替用户自动调用这些用户入口；需要用户显式发起。模型入口同时可以由用户显式使用，并不是只允许模型。', criteria: ['指出用户入口需要显式发起', '路由器只给建议', '模型入口也可由人调用'], teaching: { purpose: 'explanation', objective: '区分调用身份与路由建议', hints: ['检查 README Reference 和 SKILL-MECHANICS 的 Invocation、Router skills。'] } }, ...LESSONS.map(prompt)],
    interactions: [{ kind: 'comparison', id: 'invocation-compare', conceptId: 'invocation', title: '用户入口与模型入口', objective: '区分谁能发起调用，以及路由器的职责。', boundary: '本组件解释固定版本原文，实际宿主发现与调用需要另行核对。', question: '为什么 ask-matt 的建议不能当成 to-spec 已执行？', promptId: 'p-invocation', objects: [{ id: 'user', label: '用户入口', values: { initiator: '用户明确发起，例如 to-spec。', reuse: '其他技能不能自动调用；路由器只能提示。' } }, { id: 'model', label: '模型入口', values: { initiator: '模型按适用场景使用，用户也可明确发起，例如 tdd。', reuse: '可以作为其他技能的复用纪律或参考。' } }], dimensions: [{ id: 'initiator', label: '谁发起', difference: '显式用户发起 vs 模型和用户均可发起。', boundary: '“模型入口”不排斥用户使用。' }, { id: 'reuse', label: '组合方式', difference: '提示用户接着调用 vs 可由其他技能复用。', boundary: '安装成功和实际宿主发现分开核对。' }] }],
    sources, conceptSources: Object.fromEntries(LESSONS.map(lesson => [conceptId(lesson.name), [`src-${lesson.name}`]]).concat([['invocation', ['upstream-readme', 'upstream-mechanics']], ['skills', ['upstream-readme', 'upstream-scope']]])), limitations
  };
  const workflowIds = ['grill-with-docs', 'to-spec', 'to-tickets', 'implement', 'implement-spec', 'tdd', 'code-review', 'retro'];
  const workflow = {
    schemaVersion: 1, id: 'mattpocock-engineering-workflow', title: '学习 mattpocock/skills：工程路线与阶段边界',
    goal: '能解释从已澄清想法到规格、任务图、实现和审查的路线，并按依赖选择下一阶段。',
    summary: '路线图是选择建议，不是自动执行器。用一个资料检索功能的教学假设观察各阶段输入与完成条件。',
    presentation: { theme: 'sequence', rationale: '主要动作是按阶段推演，核对进入下一阶段需要什么。' },
    concepts: [{ id: 'engineering-flow', parentId: null, title: '选择工程路线', difficulty: 1, explanation: '先确定需求是否清楚，再决定是否需要规格和任务图；实现由用户选入口发起，复用相应反馈与审查纪律。', example: '一个小且明确的行为可直接 implement；跨会话的规格再拆任务。', misconception: '每个工作都必须走完同一条长流水线。' }, ...workflowIds.map(name => { const lesson = LESSONS.find(item => item.name === name); return { id: name, parentId: 'engineering-flow', title: name, difficulty: 2, explanation: lesson.process, example: lesson.request, misconception: lesson.boundary }; })],
    relations: [{ id: 'spec-gates-tickets', from: 'to-spec', to: 'to-tickets', type: 'prerequisite', label: '以已有规格为输入的这条教学路线' }, { id: 'tickets-to-spec-implementation', from: 'to-tickets', to: 'implement-spec', type: 'application', label: '任务图决定就绪前沿' }], prompts: workflowIds.map(name => prompt(LESSONS.find(item => item.name === name))),
    interactions: [{ kind: 'step-through', id: 'engineering-trace', conceptId: 'engineering-flow', title: '从想法到可检查的工作', objective: '说出每个阶段产生什么，以及下一阶段依赖什么。', boundary: '采用跨会话且需求逐渐清晰的教学场景；不主张所有项目走全部阶段，也不执行材料中的操作。', question: '什么时候不需要先写大规格，什么时候不能跳过澄清？', initialState: '教学假设：准备新增资料检索功能，当前只知道“要更好找资料”。', steps: [
      { id: 'align', label: '① 先澄清目标和语言', result: '确认要检索哪些资料、谁使用、怎样观察成功。', change: '从模糊愿望到共同理解。', cause: '缺少目标时，规格和代码会把猜测固化。' },
      { id: 'spec', label: '② 综合已讨论内容', result: '用户发起 to-spec，综合问题、方案和测试决定。', change: '对话成为可交接规格。', cause: '入口负责综合；测试接口位置仍需确认，不重开完整需求访谈。' },
      { id: 'tickets', label: '③ 审核纵向切片与阻塞边', result: 'to-tickets 提出可独立验收的窄完整任务，用户审核后发布。', change: '规格成为可领取的任务图。', cause: '阻塞已满足的前沿才可开始，不按数据库、接口、页面强行分层。' },
      { id: 'build', label: '④ 选择实现方式', result: '单任务使用 implement；整份任务图可由 implement-spec 在集成分支编排。', change: '就绪任务进入实际实现。', cause: '并行以阻塞边与集成为约束，tdd 在已确认接口位置驱动红绿反馈。' },
      { id: 'review', label: '⑤ 两轴审查与环境回顾', result: 'code-review 分别检查标准与需求；retro 寻找下一轮环境改进。', change: '验证本轮产出，同时改善下轮条件。', cause: '标准通过不能掩盖需求遗漏；回顾重点是环境，不是另造一遍功能。' }
    ] }], sources, conceptSources: Object.fromEntries(workflowIds.map(name => [name, [`src-${name}`]]).concat([['engineering-flow', ['src-ask-matt']]])), limitations
  };
  const pairs = [
    ['grill-with-docs', 'grill-me', '项目访谈与无状态访谈', '在工作目录中是否维护领域语言与必要决定。'],
    ['to-spec', 'to-tickets', '综合规格与拆解任务', '已有讨论变成规格，或可用规格变成可验收任务图。'],
    ['implement', 'implement-spec', '一段工作与整份任务图', '单段实施和审查，或集成分支上的就绪前沿编排。'],
    ['diagnosing-bugs', 'improve-codebase-architecture', '症状诊断与结构调查', '针对当前症状的失败反馈，或近期热点的深模块候选。'],
    ['handoff', 'teach', '工作交接与持续学习', '可携带工作摘要，或围绕学习目的维护多会话课程。']
  ];
  const comparisons = {
    schemaVersion: 1, id: 'mattpocock-skills-comparisons', title: '学习 mattpocock/skills：容易选错的入口', goal: '能区分五组相似入口，并在来源摘要与入口细则冲突时回到具体原文。', summary: '通过场景、输入与产物对照判断，而不只按技能名猜测。', presentation: { theme: 'contrast', rationale: '主要动作是并排比较容易混淆的入口。' },
    concepts: [{ id: 'choose', parentId: null, title: '按差异选择', difficulty: 1, explanation: '相似名字不代表相同职责。比较当前输入、预期结果和用户决定点，再读适用入口。', example: '规格综合和任务拆解都涉及计划，但解决不同问题。', misconception: '看到相似词，就以为两个入口可以互换。' }, ...pairs.map(([left, right, title, rule], index) => ({ id: `pair-${index + 1}`, parentId: 'choose', title, difficulty: 2, explanation: rule, example: `${left}：${LESSONS.find(item => item.name === left).output}\n${right}：${LESSONS.find(item => item.name === right).output}`, misconception: '两者可无条件互换，或者一个名字会自动触发另一个用户入口。' })), { id: 'source-priority', parentId: 'choose', title: '摘要与入口细则', difficulty: 2, explanation: '总体说明用于定位；具体行为回到入口及必要参考。本快照的 tdd 入口将重构放在 review 阶段，与 README 的一般红绿重构描述应分层理解。', example: '学习 to-spec 时，以入口“综合已有讨论”与测试接口确认的具体步骤为准。', misconception: '总体简介提到的词就能覆盖入口的具体完成条件。' }], relations: [],
    prompts: [...pairs.map(([left, right, title, rule], index) => ({ id: `p-pair-${index + 1}`, conceptId: `pair-${index + 1}`, kind: 'compare', question: `请用一个新场景解释“${title}”怎样选择。`, answer: `${rule} ${left} 产出：${LESSONS.find(item => item.name === left).output}；${right} 产出：${LESSONS.find(item => item.name === right).output}`, criteria: ['情境与所选入口职责一致', '说明必要输入和产物差异', '指出不应混用的边界'] })), { id: 'p-source-priority', conceptId: 'source-priority', kind: 'explain', question: 'README 讲红绿重构，而当前 tdd 入口把重构放在 review；你应怎样说明这两层来源？', answer: '总体介绍提供方向，实际操作规则以固定版本 tdd 入口为准：预先确认接口、一个测试到最小实现的红绿循环，重构放在 review 阶段。', criteria: ['区分总体介绍与具体规则', '给出固定入口的实际规定', '不静默消除来源层次差异'] }],
    interactions: pairs.map(([left, right, title], index) => ({ kind: 'comparison', id: `compare-${index + 1}`, conceptId: `pair-${index + 1}`, title, objective: '在新场景中解释选择理由。', boundary: '这里只读展示入口规则，点击对照不会启动所列技能。', question: `什么输入使你选 ${left}，什么输入使你选 ${right}？`, promptId: `p-pair-${index + 1}`, objects: [left, right].map(name => { const lesson = LESSONS.find(item => item.name === name); return { id: name, label: name, values: { scene: lesson.scene, input: lesson.input, output: lesson.output, boundary: lesson.boundary } }; }), dimensions: [{ id: 'scene', label: '适用场景', difference: '要解决的问题不同。', boundary: '先核对当前处境。' }, { id: 'input', label: '必要输入', difference: '已有上下文与材料不同。', boundary: '缺项由实际探索核对。' }, { id: 'output', label: '预期产物', difference: '完成后的结果不同。', boundary: '预期不表示本次已执行。' }, { id: 'boundary', label: '停止与边界', difference: '用户决定和不能替代的职责不同。', boundary: '来源操作不是当前执行授权。' }] })), sources, conceptSources: Object.fromEntries(pairs.map(([left, right], index) => [`pair-${index+1}`, [`src-${left}`, `src-${right}`]]).concat([['source-priority', ['upstream-readme', 'src-tdd']], ['choose', ['src-ask-matt']]])), limitations
  };
  return { overview, workflow, comparisons };
}
