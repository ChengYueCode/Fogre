<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 学习产物：模型、构建与学习页

这份参考覆盖知识模型 schema、校验规则、`forge.mjs` 命令、构建输出与学习页交互约定。只有当任务涉及生成或重建产物时才需要读它。

生成或重建产物时，先按[视觉设计](visual-design.md)从本次内容选择 Forge 自有的配色、主题与阅读布局，保存可选的 `presentation: { theme, rationale }`。视觉字段不参与知识指纹；HTML、导图与 SVG 共用主题，来源技能的视觉样式不作为模板。

`build` 输出中的 `written.*` 表示本次是否重写该文件。已有文件内容相同时返回 `false`，并不表示文件不存在或未生成；用返回的产物路径读取实际文件。

## 1. 知识模型 schema（schemaVersion 1）

模型是作者内容，不包含学习者的作答或掌握度。用 UTF-8 JSON 保存；中文内容与中文标点都允许，但所有 ID 必须是稳定 ASCII。下面的片段只说明字段形状（shape-only），不是完整样例；可用的完整教学样例是 `assets/probability.json`，`build` 会把它生成到学习目录。

```json
{
  "schemaVersion": 1,
  "id": "probability-basics",
  "title": "条件概率与贝叶斯基础",
  "goal": "能用先验、似然和证据解释阳性预测值的变化，并独立完成一次计算。",
  "summary": "从条件概率出发，用一个医学筛查例子看清先验如何影响后验。",
  "concepts": [
    {
      "id": "root",
      "title": "条件概率",
      "parentId": null,
      "difficulty": 1,
      "explanation": "在已知 B 发生的条件下计算 A 的概率。",
      "example": "已知抽到红球时是甲袋的概率为 1/3。",
      "misconception": "把 P(A|B) 当成 P(B|A)。"
    },
    {
      "id": "prior",
      "title": "先验概率",
      "parentId": "root",
      "difficulty": 1,
      "explanation": "在看到新证据之前对假设的信念强度。",
      "example": "某病在人群中的患病率 1%。",
      "misconception": "忽略基础率，直接相信检测结果。"
    },
    {
      "id": "sensitivity",
      "title": "灵敏度与特异度",
      "parentId": "root",
      "difficulty": 2,
      "explanation": "有病者被检出阳性的比例是灵敏度；无病者被正确判为阴性的比例是特异度。",
      "example": "灵敏度 90%、特异度 95%。",
      "misconception": "把灵敏度和阳性预测值混为一谈。"
    },
    {
      "id": "ppv",
      "title": "阳性预测值",
      "parentId": "root",
      "difficulty": 3,
      "explanation": "检测阳性的人里真正有病的比例，由先验和检测特性共同决定。",
      "example": "患病率 1% 时，阳性预测值约 15%。",
      "misconception": "以为检测准确率就是阳性预测值。"
    },
    {
      "id": "bayes",
      "title": "贝叶斯更新",
      "parentId": "ppv",
      "difficulty": 3,
      "explanation": "先验乘以似然，再用全概率归一化，得到后验。",
      "example": "把 1% 先验更新为约 15% 后验。",
      "misconception": "只更新部分证据就下结论。"
    },
    {
      "id": "base-rate",
      "title": "基础率谬误",
      "parentId": "ppv",
      "difficulty": 2,
      "explanation": "忽视人群基础率，只凭个案信息判断概率。",
      "example": "看到阳性就认为大概率得病。",
      "misconception": "把事件的具体描述当成高概率的理由。"
    }
  ],
  "relations": [
    { "id": "rel-prior-bayes", "from": "prior", "to": "bayes", "type": "prerequisite", "label": "先验是更新的前提" },
    { "id": "rel-sens-ppv", "from": "sensitivity", "to": "ppv", "type": "cause", "label": "检测特性影响阳性预测值" },
    { "id": "rel-prior-ppv", "from": "prior", "to": "ppv", "type": "cause", "label": "先验改变阳性预测值" },
    { "id": "rel-base-bayes", "from": "base-rate", "to": "bayes", "type": "contrast", "label": "谬误 vs 正确更新" },
    { "id": "rel-prior-sens", "from": "prior", "to": "sensitivity", "type": "application", "label": "先验与检测特性共同参与阳性预测值计算" }
  ],
  "prompts": [
    {
      "id": "p-ppv-def",
      "conceptId": "ppv",
      "kind": "recall",
      "question": "阳性预测值回答的是什么问题？",
      "answer": "在所有检测阳性的人中，真正患病的比例。",
      "criteria": ["分母是检测阳性者", "分子是真患病者", "明确它是后验比例"]
    },
    {
      "id": "p-prior-effect",
      "conceptId": "prior",
      "kind": "explain",
      "question": "为什么同样的检测，患病率越低阳性预测值越低？请用自己的话解释。",
      "answer": "低患病率意味着大量无病者进入分母，即使特异度很高，假阳性人数仍可能超过真阳性。",
      "criteria": ["提到假阳性数量", "提到分母变化", "联系到基础率"]
    },
    {
      "id": "p-apply",
      "conceptId": "bayes",
      "kind": "apply",
      "question": "患病率 2%、灵敏度 90%、特异度 95% 时，阳性预测值大约是多少？写出计算过程。",
      "answer": "真阳性约 2%×90%=1.8%，假阳性约 98%×5%=4.9%，PPV≈1.8/(1.8+4.9)≈26.9%。",
      "criteria": ["先算真阳性", "再算假阳性", "用比例而非人数也要正确"]
    },
    {
      "id": "p-compare",
      "conceptId": "sensitivity",
      "kind": "compare",
      "question": "灵敏度与阳性预测值分别以什么为分母？",
      "answer": "灵敏度以真患病者为分母；阳性预测值以所有检测阳性者为分母。",
      "criteria": ["两个分母都正确", "指出方向相反"]
    }
  ],
  "sources": [
    { "id": "src-screening-synthetic", "title": "forge 教学示例：假设的筛查数字", "note": "数值均为教学假设，不对应真实疾病或检测。", "kind": "synthetic-teaching-material" }
  ],
  "limitations": [
    "示例数值为教学用近似，不用于真实医疗决策。",
    "交互演示只展示二分类检测的理想情形。"
  ]
}
```

### 字段与校验约束

- `schemaVersion` 必须为 `1`；`id` 形如 `[a-z0-9][a-z0-9-]*`，不能以 `-` 结尾。
- `title` 与 `goal` 必填且非空；`summary` 可选。
- `concepts[]` 至少 1 个，且恰好一个 `parentId: null` 的根；每个非根概念必须指向存在的概念。
- `difficulty` 只能是 `1`、`2`、`3`（内容难度，不是掌握度）。
- 概念 ID 全局唯一；不能是 `__proto__`、`constructor`、`prototype` 这类原型污染键或空串。
- `relations[]` 的 `from`、`to` 必须指向存在的概念；`type` 只能是 `prerequisite`、`cause`、`contrast`、`application`；`label` 在生成图中可见，建议填写。
- `prompts[]` 的 `conceptId` 必须存在；`kind` 只能是 `recall`、`explain`、`apply`、`compare`；`question`、`answer` 必填，`criteria` 是字符串数组。
- `prompts[].teaching`（可选）是作者问题的教学字段对象；各字段可省略：`purpose` 为 `explanation`/`variation`/`transfer`，`objective` 为非空成果文本，`prerequisites` 为不重复且存在的概念 ID 数组（可为空），`misconceptions` 与 `hints` 为非空字符串数组（每项非空，提示按顺序显示）。省略或空对象保持旧题行为；判定标准仍用 `criteria`。本段只定义作者字段；需要现场教学时先说明范围变化，再由已加载的教学入口选择练习并保存协助来源。
- `interactions[]`（可选）是只读教学组件；当前支持 `kind: "comparison"`（并排对照两个对象）、`kind: "step-through"`（分步推演并保存可恢复位置）与 `kind: "parameter"`（只运行预置规则 `ratio`/`product`/`bayes-frequency` 的参数实验），其它 kind 报 `E_SCHEMA`“尚不支持”。省略或空数组不改变模型指纹。学习者的推演位置存在档案的可选 `interactionPositions` 里。字段、校验码、读模型与页面行为见 [teaching-interactions.md](teaching-interactions.md)。
- 父子引用必须构成连通的、无环的树；这是内容层级（包含）语义。`prerequisite` 等跨分支关系表达的是另一层含义，不参与父子环检测，也不会因为“父同时是前置”就被判为环——请分别按各自含义校验。
- `sources[]` 每项要求 `id` + `title`；`limitations[]` 是字符串数组。
- `conceptSources`（可选）把概念映射到来源 id，例如 `{ "ppv": ["src-screening-synthetic"] }`；未列出的概念在学习页展示全部来源。
- 校验失败时 `validate` 与 `build` 以非零码退出并指出具体路径（如 `concepts[2].parentId`），**不会写入任何输出**。

### 未知字段

schema 之外的多余字段会被保留在 `model.json` 里，但生成页与图形只使用上表定义的内容。不要在模型里保存学习者状态。

## 2. 状态与证据

新建或接收标准学习目录后，按[学习目录登记](learning-registration.md)登记目录，使后续会话能够发现主题；学习记录继续由该目录的档案维护。

状态由 CLI 与学习页维护，不要手写完整状态文件。学习档案（`state.json`）格式版本为 `schemaVersion: 2`；版本 1 的旧档会被新版工具在读取时显式迁移（见下文“旧档升级、备份与恢复”）。下面的结构只是字段形状示例（schema-only），不是可直接导入的样例状态；真实教学样例来自 `assets/probability.json`，由 `build` 生成到学习目录。

```json
{
  "schemaVersion": 2,
  "modelId": "probability-basics",
  "modelRevision": 4,
  "revision": 12,
  "conceptRevisions": {
    "ppv": { "title": "阳性预测值（PPV）", "updatedAt": "2026-10-08T09:00:00.000Z", "modelFingerprint": "2f1c..." }
  },
  "relationRevisions": {},
  "explanations": {
    "ppv": {
      "text": "……",
      "updatedAt": "...",
      "author": "learner",
      "history": [
        { "id": "稳定版本身份", "text": "之前版本", "author": "learner", "updatedAt": "..." }
      ]
    }
  },
  "summaries": {},
  "ownQuestions": {},
  "conceptEvidence": {},
  "promptEvidence": {
    "p-apply-ppv": {
      "status": "applied",
      "note": "用 2% 患病率重算正确：真阳性 18、假阳性 49。",
      "reviewer": "tutor",
      "at": "2026-10-08T09:30:00.000Z",
      "fingerprint": "...",
      "attemptIds": ["att-..."]
    }
  },
  "schedules": {
    "p-apply-ppv": { "dueAt": "2026-10-12T09:30:00.000Z", "intervalDays": 4, "lastRating": "good", "lastAt": "..." }
  },
  "attempts": {
    "p-apply-ppv": [
      { "id": "att-...", "at": "...", "answer": "真阳性 18、假阳性 49，PPV≈26.9%", "rating": "good", "assisted": false, "fingerprint": "...", "corrections": [] }
    ]
  }
}
```

- `attempts` 保留不可变原答案、实际提交时间、题目与概念、内容指纹/版本、入口和协助来源；`rating: null` 表示未自评。自评与修正追加关联信息，不增加作答次数。新 `submit`/修正相同身份与相同载荷可安全重试，改变原文或来源会冲突；旧组合 `review --answer` 与 `/api/attempt` 保持兼容。
- `practiceSessions` 按稳定练习身份保存 `draft`、`assistance`（`hint`、`reference`、`tutor-feedback`、`starter`（起步帮助）、`demonstration`（完整示范））与提交后的 `attemptId`。草稿与帮助恢复以实际档案或缓存为准；协助事实只增加。导入同身份分歧保留当前原答/草稿并记录冲突，同时合并不冲突的修正、补自评与协助事实。读取与导入校验要求每个练习会话都携带显式的 `assistance` 数组（缺失、null、非数组或未知来源都会以 `E_STATE` 拒绝并指出 `practiceSessions.<id>.assistance`）；完全没有 `practiceSessions` 的旧档仍然有效。
- `promptEvidence` / `conceptEvidence` 保存导师复核，并用 `attemptIds` 指向实际被复核的作答；没有 `attemptIds` 的旧记录被当作待复核，不显示为当前掌握。
- `assisted: true`（看过参考、有提示或用了帮助）走保守间隔，并永久带“有协助”标签。
- `fingerprint` 记录该次作答时的问题与参考内容；模型更新后旧证据会失效为 `stale`，不会被拿去充当新内容的掌握度。
- `conceptRevisions`、`explanations`、`summaries`、`ownQuestions` 保存学习者修订，重构建时按稳定 ID 续接。`explanations` / `summaries` 的 optional `history` 保存被覆盖前的 `text`/作者/时间版本；旧笔记没有该字段仍可读取，同一文本与作者重复保存保持幂等，跨端合并保留当前可见版本并合并双方历史。读取、导入和缓存校验共用同一严格规则；纯读取洞见不会补写历史或改写旧笔记。
- `migrations` 记录档案格式升级历史（从哪一版升级、时间、缺失信息清单）；重复读取或重复升级不会新增记录。比当前工具更新的档案格式会被明确拒绝并提示升级，原档案不会被修改。

### 旧档升级、备份与恢复

- 通过公开命令读取、保存或重建旧档即触发显式迁移：作答、自评、原时间、协助属性、内容指纹、证据关联、笔记、自创问题与用户修订全部按原样保留；迁移不推进 `revision`，缺失信息（如缺少指纹或 `attemptIds` 的记录）在 `migrations[].warnings` 中如实列出，并按保守语义处理（缺指纹的作答不作为当前内容证据），不编造缺失值。
- 首次把版本 1 档案升级写入前，工具会在同目录保留逐字节副本 `state.v1.backup.json`；副本只创建、不覆盖，重复升级或恢复后再次升级都不会破坏它。
- `restore` 命令核验该副本（属于同一模型且可完整读回）后把它逐字节恢复为当前档案，并打印恢复摘要；恢复后旧版工具也能再次读取该档案。
- 只读操作（`due`、`export`、页面读取）会在内存中迁移旧档但绝不改写磁盘档案，也不创建副本；只有会写入档案的公开操作（`review`、`evidence`、`import`、`build`、页面保存）才持久化升级结果并先留副本。

## 3. 命令

全部命令通过技能包内唯一入口 `scripts/forge.mjs` 调用。脚本位置由技能包决定，不需要 `cd` 进技能目录；用 `node <skill-dir>/scripts/forge.mjs help` 查看当前可用选项，路径参数相对于当前工作目录。

```bash
# 校验模型（不写文件）
node <skill-dir>/scripts/forge.mjs validate ./learning/probability/model.json

# 构建命令示例；输出与写回合同见 references/artifact-rebuild.md
node <skill-dir>/scripts/forge.mjs build ./learning/probability/model.json --out ./learning/probability --svg
# 使用另一份场景（先读重建规则确认写回位置）：
node <skill-dir>/scripts/forge.mjs build ./learning/probability/model.json --out ./learning/probability --scene ./learning/probability/map.edited.excalidraw

# 本地自动存档
node <skill-dir>/scripts/forge.mjs serve --out ./learning/probability --port 0

# 到期清单
node <skill-dir>/scripts/forge.mjs due --out ./learning/probability --at 2026-10-09T08:00:00Z

# 保存未自评原答；同一真实练习固定身份，新练习使用新身份
node <skill-dir>/scripts/forge.mjs submit --out ./learning/probability --prompt p-apply-ppv \
  --answer "真阳性 18、假阳性 49，PPV≈26.9%" --attempt-id att-original
# 对指定已保存原答补自评
node <skill-dir>/scripts/forge.mjs review --out ./learning/probability --prompt p-apply-ppv \
  --attempt-id att-original --rating hard
# 保存草稿与帮助；修改已保存草稿时传 --base-draft 指定旧原文
node <skill-dir>/scripts/forge.mjs practice --out ./learning/probability --prompt p-apply-ppv \
  --session-id practice-current --draft "暂存想法" --assistance hint
# 追加带来源的修正事件
node <skill-dir>/scripts/forge.mjs correction --out ./learning/probability --prompt p-apply-ppv \
  --attempt-id att-original --correction-id corr-original --text "补充修正" --assistance reference

# 旧组合操作：记录一次真实作答与自评
node <skill-dir>/scripts/forge.mjs review --out ./learning/probability --prompt p-apply-ppv \
  --rating hard --answer "真阳性 18、假阳性 49，PPV≈26.9%" --at 2026-10-09T08:00:00Z

# 导师复核真实作答后添加有依据的掌握证据；--attempt 可重复，显式指出被复核的作答
node <skill-dir>/scripts/forge.mjs evidence --out ./learning/probability --prompt p-apply-ppv \
  --status applied --note "用 2% 患病率重算正确：真阳性 18、假阳性 49。" --attempt att-xxxxxxxx

# 内容质检：先写新草稿，填写六类检查后再写入正式记录（详见 references/content-quality.md）
node <skill-dir>/scripts/forge.mjs quality-template --out ./learning/probability --to ./learning/probability/quality-draft.json
node <skill-dir>/scripts/forge.mjs quality-write --out ./learning/probability --quality ./learning/probability/quality-draft.json
node <skill-dir>/scripts/forge.mjs quality-read --out ./learning/probability
# 只读聚合真实原答、修正、导师反馈、自己的解释/总结历史与自创问题
node <skill-dir>/scripts/forge.mjs insights --out ./learning/probability
node <skill-dir>/scripts/forge.mjs insights --out ./learning/probability --concept ppv
# 只读预览预算内复习选择；不写档案，--at 只用于独立测试目录的模拟时间
node <skill-dir>/scripts/forge.mjs review-plan --out ./learning/probability --round-id <id> --minutes 20
# 显式把计划应用到当前轮次；省略 --focus-prompt 保留已保存重点，--clear-focus 清除
node <skill-dir>/scripts/forge.mjs round --out ./learning/probability --action review-plan --round-id <id> --minutes 20 --focus-prompt p-apply-ppv
# 将质检结论放入新版页面（重建步骤见下方规则）
node <skill-dir>/scripts/forge.mjs build ./learning/probability/model.json --out ./learning/probability

# 独立文件模式的导入导出
# 独立页面交接与导师字段来源核验见 portable-handoff.md；先核验导入副本再归入原目录。
node <skill-dir>/scripts/forge.mjs export --out ./learning/probability --to ./backup/state-20261009.json
node <skill-dir>/scripts/forge.mjs import --out ./learning/probability --state ./backup/state-20261009.json

# 恢复升级前的旧档副本（可选指定副本路径；恢复前会核验）
node <skill-dir>/scripts/forge.mjs restore --out ./learning/probability
node <skill-dir>/scripts/forge.mjs restore --out ./learning/probability --backup ./learning/probability/state.v1.backup.json
```

### build 的输出与幂等性

完整输出、导图路径、质检显示与状态幂等规则见[既有产物重建](artifact-rebuild.md)。新建与重建使用同一组构建合同。

### 复习计划（review-plan）

需要预览或应用预算内复习时，按[预算内复习选择](review-plan.md)执行；命令、选中/暂缓语义、重点覆盖与重新规划条件均以该参考为准。

## 4. 学习页交互约定

页面是给学习者的主要界面。脚本与本地服务接口已由集成测试覆盖。下面是实现契约。

已确认的验收边界（经验记录，不是对所有环境的保证）：

- 在环回服务下用真实浏览器完成了学习页操作：导航/聚焦、隐藏参考作答、独立与有协助状态、自创问题与笔记刷新后保留、CLI 重建保留学习者数据。
- 浏览器缓存模式导出的状态可被核心读回；约 390px 宽度的响应式检查；概率交互组件的边界算术。
- 原生 Excalidraw 0.18 的文件导入/拖动/导出往返已确认。
- 未验证或不可用：实时 Excalidraw MCP 会话（宿主未提供工具）；直接以 `file://` 打开的界面（应用内浏览器禁止该协议，未尝试绕过）；各平台的完整 UI 覆盖。这里只列实际做过的项目验收，未在真实浏览器中单独验证的界面行为不作结论。

交互契约：

- 首屏：中心主题与主要分支；层级可折叠，可聚焦分支并随时回到总览；支持缩放、平移、适配视图。返回总览时当前概念保持高亮。
- 关系含义可辨认：包含/归属与 `prerequisite`、`cause`、`contrast`、`application` 用不同线型、标签和方向区分，并有图例。
- 分级可辨认：内容层级、难度（1–3）与掌握度分开显示；掌握度用文字与颜色双重表达。展开节点、打开页面、生成图形都不改变掌握度。
- 由概念进入解释、示例、常见误解、自己的解释、相关问题与来源引用；返回后仍在同一结构中的同一位置。
- 练习先只显示问题：参考默认隐藏。学习者给出**非空**作答并提交后，才显示参考与评分标准，然后可以自评 `again/hard/good/easy`。学习者也可以在作答前主动请求查看参考（页面提供的帮助动作）；这不是禁止项，但这次作答会被标记为"有协助"，不能算作独立证据。自评明确标注为"自我评估，只影响复习安排"。
- 复习时重新给出隐藏参考的问题；同一身份的相同提交、修正和补自评可安全重试，不产生额外作答或安排。选择“再做一次”创建新练习身份。
- 笔记面板保存自己的解释、反思/总结与自创的检索问题；概念标题与关系含义可修订并保存。
- 自创问题可转为练习与复习项，并保留提问者是学习者这一事实。
- 保存状态在页面上可见：自动存档（本地服务）、独立浏览器缓存、导入/导出分别如实标注，不宣称云同步。
- 独立文件导出、会话侧合并复核、重建并重新打开新版反馈的完整步骤见[独立文件交接](portable-handoff.md)。缓存按学习者事件合并，整档 revision 的高低不决定是否丢弃增量；新产物中的导师结果保持可信，缓存或浏览器导入中的新导师声称留待会话核验。
- 页面非空作答先写原答，可关闭重开后再自评。主动查看提示/参考先保存协助事实；写入失败保留输入并等待重试，成功保存后才揭示帮助。原答提交后的参考展示不改变原答属性；修正保留其独立事件身份与协助来源。
- 切换视图或刷新页面时，同一次练习的草稿与协助事实从档案或浏览器缓存恢复；快速连续编辑排队同步，revision 冲突会保留草稿并提示核对。
- 窄至约 390px、宽至约 1400px 都能使用；按钮有可读文本、键盘可聚焦可操作。

### 浏览器与服务端边界

- 页面的作答、自评、笔记与修订只写入本地 state。
- 浏览器**不能**写入导师复核的掌握证据；`conceptEvidence`/`promptEvidence` 只能由 agent 侧的 `evidence` 命令写入。
- `POST /api/practice` 保存会话（`promptId`、`sessionId`、可选 `draft`/`baseDraft`/`assistance`）；`POST /api/submit` 保存原答（`promptId`、`attemptId`、`answer`、可选 `sessionId`/`assistance`/`assisted`）；`POST /api/assessment` 对指定 `promptId`/`attemptId` 补 `rating`。`POST /api/correction` 接受 `promptId`/`attemptId`/`correctionId`/`text`/`assistance`。每次 POST 保留必需的 `revision` 与 `modelFingerprint` 守卫。`GET /api/state` 返回未自评原答与练习会话。旧 `/api/attempt` 仍接受组合操作，也可省略 rating 保存或明确指定新格式原答补自评。
- 自评只改变指定原答的评价与 `schedules`，不会新增作答、创建 `promptEvidence`/`conceptEvidence`；它不等同于导师确认。
- `review` 与 `/api/assessment` 支持独立 `assessmentId`（CLI `--assessment-id`）及可选修正目标 `targetCorrectionId`（CLI `--correction-id`）。导师会话使用 `assess --out <dir> --prompt <id> --attempt-id <id> --rating <rating> --note <真实复核依据> --assessment-id <稳定事件id>`，可附 `--correction-id` 和 `--at`。学习页没有导师写入接口，浏览器导入不能新增可信导师评价。
- 作答分别保留 `selfAssessments`、`tutorAssessments` 与 `tutorFeedback`；旧 `rating/assessment` 自评兼容字段保留。评价记录关联原答身份和目标，不修改原文或提交事实。复习安排按提交顺序重算，并记录归属作答、评价来源与独立评价时间；掌握结论继续由既有 `evidence` 路径单独复核。
- 服务只提供构建目录内白名单对象与 `model.json`、`state.json`，拒绝目录穿越与非环回 Host/Origin，写入采用临时文件 + 原子替换，并做乐观并发检查（请求体 revision 与 modelFingerprint 校验）。冲突返回 409 并附带当前状态；页面保留草稿、报告冲突并排队重试。构建与导入保留当前持久版本并报告实际冲突/孤立项，但不保证所有冲突分支都无损保留。浏览器导入不能写入导师证据，已有证据原样保留。
- 页面保存、CLI 写入命令与 `build` 共用磁盘上的 `.ember-lock` 协议：默认锁定 `<out>`；指定外部 `--state` 时，还锁定规范化后的档案所在目录与模型目录，目录别名归一化并按固定顺序加锁。同一档案或同一内容目录下的多个档案共享协调边界。交错保存时双方合法新增记录都保留；拿不到锁时返回可恢复的冲突及当前状态、视图和内容指纹，保持档案不变。CLI 在锁内重新读取模型与档案；等待期间内容改变会拒绝本次修改，要求读取新内容后再提交。档案（`schemaVersion`）与内容（`modelFingerprint`/`modelRevision`）版本在公开写入路径上一致检查。
- 崩溃锁恢复：只有确认本机拥有者已退出且锁已到期，才会清理遗留的 `.ember-lock`；存活、未知或其他主机的拥有者不会因锁龄被抢占。恢复过程由同目录下的一次性 `<out>/.ember-lock.recovery` 严格串行化，避免两个恢复者先后删除刚建立的新锁。该恢复锁是 fail-closed 的：只要它存在，就不会按年龄或“看起来已死”自动接管，而是返回可恢复冲突并提示人工确认后删除；因此崩溃在恢复窗口内可能留下需要人工清理的恢复锁，这是为了避免不安全删除而有意接受的罕见代价。恢复锁会随正常持锁流程释放，释放同样核验唯一拥有者标记。
- `restore` 在当前档案损坏（截断或结构错误）时仍可从同模型的合法 v1 副本恢复：副本会先按模型完整校验，损坏的当前字节会被另存为 `state.corrupt.<时间戳>.json` 而不是直接丢弃，原始 `state.v1.backup.json` 永不覆盖。可读的更高版本（未来 schemaVersion）或属于其他模型的当前档案仍会被拒绝。缓存中已从模型移除的概念/关系的笔记、总结、标题/关系修订与自创问题会按稳定 ID 保留为孤立历史，在页面“笔记”视图只读展示，不会重新激活掌握度或变成可练习问题。
- 独立页面读取本机缓存时拒绝不支持的版本和损坏的记录结构，显示原因并保留原缓存字节；普通保存与重试均不能覆盖它。当前页面的新修改仍可另行导出。版本 1 缓存会保留旧历史并追加一次迁移记录，诚实说明缺失信息；保存和重开不会追加重复迁移。
- 服务是前台、环回地址（127.0.0.1）、由 agent 启动的短生命周期进程；页面本身可独立打开，不依赖它运行。

## 5. 给结构增量的建议

- 图的标题要短而信息明确，让它只标示主题或分支；详细解释放在节点/概念面板里，不要把长句塞进图标签。
- 总览用于看出概念之间的关系；具体文字较密时，引导学习者聚焦分支并缩放阅读。这里只说明阅读方式，不保证所有标签在任何缩放下同时可读。
- 分支超过 6 个且无法平铺时，加深树而不是并排塞满；生成器按层级自动分配横向间距。
- 一段单元先给一个可观察成果，例如"能算出一个数"或"能指出一个反例"，再配 1–3 个 `prompts`。
- `misconception` 与 `contrast` 关系通常成对出现：写明容易混淆的一方，再给出可辨认的标签。
- 问题和参考要能在隐藏参考的前提下独立成立，避免"参考里才有题干条件"。
