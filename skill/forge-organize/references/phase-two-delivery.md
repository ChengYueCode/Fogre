<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 第二阶段完整旅程与恢复

这份参考在需要把第二阶段能力串成一次完整学习时读：按真实表现选择解释/变式/迁移练习、
用三类互动组件核对机制与边界、把理解变化整理成洞见笔记与速查、再在时间预算内优先复习
前置缺口、反复错误和真实到期项。它把三种入口的第二阶段做法、暂停续接、独立缓存交接、
冲突与导出、原生 Excalidraw 往返串成操作步骤；字段、证据与选择规则仍由各自参考持有，
这里不重复，也不替代它们。

本文是第二阶段旅程的操作说明。forge 提供这里用到的公开命令与页面能力；
保存是否完成，以公开命令输出、本地接口读回和实际档案为准。
保存与失败恢复按[第一阶段旅程](phase-delivery.md)执行，第二阶段差异见本文。
单项能力请求先按[能力路由](module-routing.md)判定；旅程中嵌入某一能力时按[模块交接约定](module-contract.md)携带任务、预算与返回位置，完成后回到本文的循环。

## 第二阶段新增能力与路由

| 能力 | 操作入口 | 规则、字段与边界 |
| --- | --- | --- |
| 按表现选择解释/变式/迁移练习，分步提示保留协助来源 | 页面练习、`practice-plan`、`practice --hint-level` | [递进练习与帮助](progressive-practice.md) |
| 对照两个易混对象、分步推演机制、改变条件做参数实验 | 概念详情页互动卡片、模型中的 `interactions` | [对照与互动](teaching-interactions.md) |
| 按概念汇总真实原答、修正、导师反馈、自己的解释/总结与检索问题 | 学习页洞见视图、`insights --out <dir> [--concept <id>]` | [洞见与速查](insight-notes.md) |
| 在时间预算内优先复习前置缺口、反复错误和真实到期项，并可主动改重点 | `review-plan` 只读预览、`round --action review-plan` 应用 | [预算内复习选择](review-plan.md) |
| 暂停、恢复、独立缓存导出与会话侧归入 | `round --action pause|resume`、页面导出、`import`/`export` | 本文；[独立文件交接](portable-handoff.md) |

## 三种入口的第二阶段做法

三个入口共用一条循环：学习者自己解释或作答 → 暴露缺口 → 修补 → 重讲或换情境迁移；
第二阶段只在合适的位置插入递进练习、互动组件、洞见与预算内复习。完整的第一阶段
建本轮、提交与集中复核步骤见[第一阶段旅程](phase-delivery.md)，这里只写差异。

### 学新主题（learn-new-topic）

1. 先按[第一阶段入口一](phase-delivery.md#入口一-学新主题learn-new-topic)完成诊断与
   `confirm-diagnosis`，得到正式路线。
2. 用 `round-read --out <dir>` 读本轮任务，再用只读 `practice-plan --out <dir>` 看
   本轮每个目标概念现在该出解释、变式还是迁移题，以及选择依据的作答 id。选择规则见
   [递进练习与帮助](progressive-practice.md)；没有当前内容的独立原答导师成功时不会
   跳到变式/迁移，也不会替学习者写答案。
3. 在页面练习。参考默认隐藏；主动查看帮助用页面按钮“查看提示（标记为有协助）”，
   每次点击只多显示一条并按同一次练习推进 `hintLevel`，关闭重开仍恢复已查看步骤；
   有协助的作答可以提交，但不会成为独立成功依据。
4. 需要核对机制或边界时，作者可在模型里配置对照、分步推演或参数实验组件，页面按
   概念与本题入口显示。组件只在浏览器/后端共享的 `interactions.mjs` 规则上运行，
   不执行任何来自资料的脚本字段；观察组件不写作答、评分、提示或掌握证据。
5. 集中复核按[第一阶段交接](phase-delivery.md#集中复核交接)执行；随后进入本参考的
   “洞见”和“预算内复习”。

### 整理已有材料（organize-existing-material）

1. 先按[第一阶段入口二](phase-delivery.md#入口二-整理已有材料organize-existing-material)
   生成可用产物与质检记录；初始掌握度仍是未知。
2. 需要路线时用 `round --action create --entry organize-existing-material --goal <成果> --concept <ID>`
   开本轮，让学习者在产物里解释、练习、提问。
3. 从第二轮开始，材料整理与后续练习复用同一批稳定 id：组件、洞见和任务都回到相同
   概念与题目；重建产物不会把已有作答、组件的当前位置或洞见历史换成新身份。

### 恢复已有学习（resume）

1. 按[第一阶段入口三](phase-delivery.md#入口三-恢复已有学习resume)先读
   `round-read`、`due`、`review-read` 与 `state.json`。
2. `round --action resume --round-id <ID>` 续接同一身份；暂停前保存的预算、当前任务
   与 `round.reviewPlan`（重点、选中/暂缓）都保留，恢复只续接，不重放或伪造已完成。
3. 第二步先看第二轮的真实到期与待安排项：`review-plan --out <dir> [--round-id <ID>]`
   只读列出完整 `allDue` 与预算内 `selected`/`deferred`；需要改重点时用
   `round --action review-plan --focus-prompt <id>`，省略 `--focus-prompt` 保留重点，
   `--clear-focus` 清除重点。选择规则见[预算内复习选择](review-plan.md)。
4. 组件位置、洞见、作答与布置的任务都按稳定 id 回到同一概念；内容更新后旧依据如实
   标 `stale`，要重新作答或重新保存位置，不静默沿用。

## 递进练习与分步帮助

需要选择下一题、保存分步帮助或提交有协助作答时，按[递进练习与帮助](progressive-practice.md)执行；作者字段见[模型约束](artifacts.md#字段与校验约束)，导师评价边界见[证据与复习](evidence-and-review.md)。完成后回到本轮任务，再进入互动、洞见或预算复习。

## 三类互动组件

组件是作者在模型里配置的教学内容，不是脚本沙箱。字段、校验码、共享读模型与页面行为
见[对照与互动](teaching-interactions.md)；这里只提醒走旅程时的边界：

- `comparison`：两个对象 + 一个维度，可回到关联概念与本题 `promptId`；两个选择器允许
  选到同一项，此时页面明确显示“同一项无法比较”，不伪造差异。
- `step-through`：初始状态 + 具名步骤 + 前进/回退/重置；第一步前的按钮禁用。学习者
  的当前位置由 `interaction --out <dir> --id <interactionId> --step <stepId> [--at <ISO>]`
  保存为步骤 id 加精确内容签名；内容变化后旧位置失效，需要显式保存新位置。这只是
  观察位置，不写作答、评分、提示或掌握证据。
- `parameter`：作者声明 `rule` 与 `roles` 和必填 `inputs`（含 `unit`），共享
  `interactionParameterView(interaction, values)` 是唯一计算入口；未知规则、脚本字段
  或非法数值结构化拒绝，不把物料的文本当代码执行。
- 内容来源边界：组件的可核对依据放在模型的 `sources` 或组件 `boundary`/`limitations`
  中，机制出处与“能支持什么、不能支持什么”见[机制来源与灵感边界](sources.md)。
  文案不要给出绝对结论：例如 HTTP `GET`/`POST` 的语义、“中位数对极端值更稳健但
  新增/替换数据仍可能改变结果”、“平均速率是总路程 ÷ 总历时，匀速条件才等于瞬时速率”
  之类说法都要带条件。
- 未配置组件时页面显示中性占位，不暗示内容已核对；组件不改变概念指纹、任务状态或
  掌握度，除非作者真的修改了模型内容。

## 洞见与速查

洞见视图不新建事实，只把同一份档案已有的真实记录按概念重新聚合；规则见
[洞见与速查](insight-notes.md)。

- 学习者的原话、导师反馈、修正、自创检索问题分别标识来源；缺少作者参考时如实标出
  依据边界，不把导师文本或组件观察自动升级为掌握。
- 笔记与检索问题通过页面的 note / own-question 写入接口保存（`POST /api/note`、
  `POST /api/question`）；CLI 只提供只读 `insights --out <dir> [--concept <id>]`，
  不虚构笔记写入命令。每次 POST 都带 `revision` 与 `modelFingerprint` 守卫。
- 导出、重建、关闭重开后按稳定 `conceptId`/`promptId` 重新定位；从模型移除的概念与
  问题作为孤立历史只读展示，不重新激活掌握度。

## 预算内复习

按[预算内复习选择](review-plan.md)先预览、再依学习者决定应用；该参考持有重点、前置、重复错误、到期/暂缓语义与重新规划条件。

## 恢复、缓存、冲突与导出

暂停续接保持同一轮次身份。保存方式见[产物与两种保存方式](phase-delivery.md#产物与两种保存方式)，异常按[失败恢复](phase-delivery.md#失败恢复)处理；独立缓存先按[独立文件交接](portable-handoff.md)核对、导入，再回到当前任务。

## 原生 Excalidraw：打开、编辑、保存、重建

内置生成器写出的 `map.excalidraw` 是真实 Excalidraw v2 场景，节点位置、箭头绑定与
难度徽标一起移动；不需要 MCP。要把学习者的真实图形编辑带回公开重建流程：

1. 用原生 Excalidraw 打开学习目录里的 `map.excalidraw`，按需移动节点、编辑文字或
   结构调整；例如选中元素后用 Shift+方向键微调位置，或双击文字元素编辑关系标签。
   这些操作走官方编辑器控件，不直接改 `.excalidraw` JSON。
2. 编辑器保存/导出场景文件（保留真实 Excalidraw 序列化，不要手改 JSON）。
3. 按[构建输出与场景路径](artifacts.md#build-的输出与幂等性)的 `--scene` 规则把保存文件交给 `build`；先确认希望写回的路径。
4. 重建按稳定 id 续接概念、题目与图形；已有作答、轮次、洞见和调度保留。位置、绑定与
   难度徽标应继续可读；冲突与孤立项照实报告，不静默丢弃。

图形编辑和语义编辑要分开看：原生 Excalidraw 里的位置、样式、图形文字与绑定会保留在
场景文件（以稳定的 `customData.ember.conceptId` / `relationId` 对齐），但不会自动写回
`model.json` 或 `state.json` 的概念标题、解释与关系语义。学习页图谱仍使用模型和档案
中的标题、关系与层级；要让页面语义文字一起变化，必须更新模型或页面内的标题修订后
重新构建，而不是只改 Excalidraw 图形文字。

在应用内浏览器（IAB）或官方 Excalidraw 组件宿主中，如果原生 File System Access picker
没有产生 chooser，这是宿主文件选择能力受限，不要改为手改 JSON 绕过。应使用该宿主
官方组件提供的 `input[type=file]` / download 回退完成真实的打开、编辑与下载；再把
下载场景按上面的 `--scene` 路径规则交给 CLI。这个回退仍是官方编辑器操作，不是把
`.excalidraw` JSON 当文本编辑。

这条路径证明的是文件生成、原生编辑与公开重建的续接；它不是实时 MCP 会话证据，也不
代表所有 Excalidraw 版本的兼容性。来源与边界见[机制来源与灵感边界](sources.md)与
[Excalidraw MCP 参考](excalidraw-mcp.md)。

## 验收边界

本文描述使用与恢复步骤，不代表所有平台已验证。核验时在独立测试目录检查递进练习、两种主题的互动组件、洞见记录定位、超预算复习与重点恢复、三种入口、桌面/窄屏/键盘、两种保存方式和原生 Excalidraw 往返，并记录实际结果。模拟作答、时间与调度只进入独立测试目录，不证明真实学习效果。

## 参考路由

| 需要 | 读 |
| --- | --- |
| 模型 schema、`build`/`serve`/`--scene` 输出、学习页交互 | [学习产物](artifacts.md) |
| 本轮路线、诊断、预算、暂停续接 | [本轮路线与续接](learning-rounds.md) |
| 递进练习、提示等级与协助来源 | [递进练习与帮助](progressive-practice.md) |
| 对照/分步推演/参数组件字段与页面行为 | [对照与互动](teaching-interactions.md) |
| 洞见与速查读模型 | [洞见与速查](insight-notes.md) |
| 预算内复习预览与应用 | [预算内复习选择](review-plan.md) |
| 集中复核操作 | [集中复核](tutor-review.md) |
| 证据分级、调度与到期检查 | [证据与复习](evidence-and-review.md) |
| 独立页面导出、导入与重建 | [独立文件交接](portable-handoff.md) |
| 机制出处与不能支持的结论 | [机制来源与灵感边界](sources.md) |
