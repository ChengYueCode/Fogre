<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 能力路由：意图判定与按需读取

这份参考在收到 `/forge` 请求、需要判断这次是完整学习还是某一单项能力时读取。它只负责意图判定、模块选择和读取顺序；每个模块自己的规则、字段与命令由各自的参考持有，本文不重复。单项或嵌入模式的交接约定（输入、等待点、结果语义、记录约束）见[模块交接约定](module-contract.md)。

总入口是同一会话中的指令路由，不是后台调度器或强制工作流引擎。拆分文件不提供执行保证；可靠性靠显式读取条件、交接约定和真实行为验证保证。

## 判定顺序

按以下顺序判定，命中即停；前一优先级的处理不改写后一优先级的结论：

1. **明确停止或预算约束**：学习者要求停止、暂停、只花 N 分钟——先按停止与预算规则处理（见[主动教学](adaptive-teaching-and-cases.md)即时停止、[进度预算](visible-progress-and-budget.md)），不因路由覆盖停止请求。
2. **用户本次显式范围**：本次消息明确只做一件事（只要产物、只用提问检查、只复核、只安排复习、只汇总洞见、只做交接）。单项意图所需信息已充分时直接进入对应模块；只有缺项会改变下一步动作时才补问，不做完整问卷。
3. **已有任务身份及上下文**：消息未显式限定范围，但要求继续已有学习——有目录时按[恢复学习](phase-delivery.md)读回；未指定目录先按[学习档案入口](learning-library.md)查已登记主题并选定，不重新初始化。
4. **默认完整旅程**：以上都不命中（如「带我学条件概率」），走[完整旅程](phase-delivery.md)的三种入口判定。

材料核对、真实证据、存储权限等共享硬约束对每种选择都适用，摘要见 SKILL.md；单项使用不豁免它们。

## 模块映射

| 用户单项意图（示例） | 模块 | 先读 | 模块规则正文 |
|---|---|---|---|
| 「带我学 X」「继续 learning/X」 | 完整旅程 | [phase-delivery.md](phase-delivery.md) | 同左；第二阶段见[phase-two-delivery.md](phase-two-delivery.md) |
| 「我学过哪些主题」「上次学到哪」「继续之前的学习」且未给目录 | 档案查找与续学 | [learning-library.md](learning-library.md) | 选定主题后统一恢复读回；完整续学见[learning-rounds.md](learning-rounds.md) |
| 「只整理这份资料」「只做学习页/导图」 | 材料与知识产物 | [source-grounded-teaching.md](source-grounded-teaching.md) → [artifacts.md](artifacts.md) | 同左；质检见[content-quality.md](content-quality.md) |
| 「带我理解这个概念」「练这个」 | 教学与练习 | [learner-aware-opening.md](learner-aware-opening.md)（如已有画像先读回）→ [learning-rounds.md](learning-rounds.md) | [adaptive-teaching-and-cases.md](adaptive-teaching-and-cases.md)、[progressive-practice.md](progressive-practice.md) |
| 「用提问检查我的解释/推理」 | 苏格拉底提问 | [socratic-questioning-standalone.md](socratic-questioning-standalone.md) | 同左（会话规则唯一正文）；嵌入教学时读[教学交接](socratic-questioning.md) |
| 「检查这次/本轮的作答」 | 作答复核 | [tutor-review.md](tutor-review.md) | 同左；证据边界见[evidence-and-review.md](evidence-and-review.md) |
| 「给我安排今天的复习」 | 复习安排 | [review-plan.md](review-plan.md) | 同左 |
| 「汇总我的误区和理解变化」 | 洞见整理 | [insight-notes.md](insight-notes.md) | 同左 |
| 「导入/导出档案」「换会话续接」 | 档案交接 | [portable-handoff.md](portable-handoff.md) | 同左；恢复读回见[phase-delivery.md](phase-delivery.md)入口三 |

「先读」列是从路由进入模块时最先读取的文件；读完仍缺信息按各参考内部的路由继续。单项请求不需要把整张表读完。

## 按场景选择请求

- 学过公式但不能解释用途：`/forge 带我学习条件概率，目标是解释一个实际判断。` → 完整旅程，诊断后按真实缺口推进。
- 已有笔记，暂时不做问答：`/forge 只整理这份资料，生成学习页和导图。` → 材料核对与构建，不强制画像或诊断。
- 已有自己的解释，想检验推理：`/forge 只用苏格拉底提问检查这段解释：……` → 一个缺口、一个问题，等待真实回答。
- 已提交答案，希望集中反馈：`/forge 检查 learning/probability 里本轮的作答。` → 固定原答范围，核对并保存反馈。
- 时间有限，希望按记录选择复习：`/forge 根据 learning/probability 的记录安排 15 分钟复习。` → 说明选择与暂缓项。
- 新会话忘记档案目录：`/forge 查看已登记主题，让我选一个继续。` → 查当前工作区索引，选定后读回学习上下文。

`/forge` 加自然语言目标即可选择单项能力；五个独立入口已随源码提供，安装并确认宿主发现后可分别调用，不能把源码存在当作宿主已加载。完整场景、请求与预期处理见[使用示例](usage-examples.md)。

## 边界

- 仅创建页面、整理笔记、导出文件不触发现场教学问答；产物能力不因材料完整就宣称学习者会什么（初始掌握度一律未知）。
- 单项提问默认在会话中完成，不因缺少 `model.json` 强制生成整套学习产物，也不新建无关文件。
- 用户请求持久保存（归档作答、推进掌握、安排持久复习）时才进入既有模型与任务准备步骤，并说明尚未归档的内容；在此之前只报告当前讨论结果。
- 教学互动组件与 Excalidraw 是按需支撑参考，不因路由命中而自动加载；一个参考文件不等于一个独立入口。
