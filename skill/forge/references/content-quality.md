# 内容质检：按学习成果核对材料

这份参考只在整理材料、补充来源或核对内容是否足以支持学习成果时读取。质检记录是**作者内容**，与学习者档案（`state.json`）分开存放，不改变掌握度、作答、调度或内容指纹。

## 1. 六类检查与结构节点

每个承担学习成果的**核心概念**必须声明六类检查各一次：

| dimensions[].id | 检查什么 |
| --- | --- |
| `goal-coverage` | 内容是否覆盖本轮目标要求的能力 |
| `prerequisite` | 前置术语、操作与必要条件是否交代 |
| `explanation-example` | 机制解释与有效例子是否足以理解 |
| `boundary-misconception` | 适用边界与常见误区是否说明 |
| `task-criteria` | 检验任务与判定标准是否一致 |
| `sources-gaps` | 来源与未解决缺口是否如实列出 |

`result` 只能是 `covered`、`partial`、`missing`、`not-applicable`。**每一项都要带非空 `basis`**，写下实际阅读或核对的依据，或说明缺什么、为什么不可用——包括 `partial`、`missing`、`not-applicable`。字段齐全、篇幅达标或只看过标题都不算通过，工具不会替作者判定语义；六项全 `not-applicable` 而没有依据的记录不会读作通过。

这个非空要求用于当前校验与写入。旧版本合法保存的空 `basis` 报告仍可通过 `quality-read` 或 `build` 读取：保留原结果与空依据，列出缺依据的概念和维度，标记相关目标失效、未通过及概念 `still-gap`。读取和构建均保留原报告字节；重新写入前需实际核对并补充依据。

只用于组织归属的**结构节点**（`role: "structural"`）不承担学习成果，可用简略说明，结论显示为 `structure-only`，不需要六类检查。若一个目标只声明结构节点、没有任何核心概念，它永远不能读作通过。

## 2. 结论如何派生

概念状态由作者填写的结论推导，不由文字长度推导：

- `structural` → `structure-only`。
- `goal-coverage` 为 `not-applicable`，或该核心概念没有任何非 `not-applicable` 维度 → `still-gap`（没有实际核对的目标覆盖不能支撑通过）。
- 存在 `blocking` 缺口或任一 `missing` → `still-gap`。
- 存在 `partial`、`supplementable` 缺口，或 `covered` 依赖不成立/未读取的补充 → 有合格补充时 `needs-supplement`，否则 `still-gap`。
- 其余全部 `covered`/`not-applicable` → `usable`。

成果状态取该目标全部核心概念中最保守的一个：任一 `still-gap` → 成果 `still-gap` 且 `passed:false`；否则任一 `needs-supplement` → 成果可交付但 `passed:false`；全部 `usable` 才算通过。受影响成果保持未通过，其他可用部分照常交付。

每个模型概念都必须在目标 `concepts` 中显式声明 `core` 或 `structural`：遗漏任一概念时写入被拒；历史遗留的遗漏记录保持可读，但目标与扁平记录一律 `still-gap`/`passed:false`，不会因缺声明而消失或显示通过。

## 3. 补充与缺口

- `supplements[]` 中 `role: "supplement"` 表示**已经实际读取并核对**的补充，必须写明 `checkedRange`（核对到哪一节/哪一版）、`readAt`、可访问来源与 `sourceId`；只有这类记录可能计入覆盖。
- `role: "candidate"` 表示尚未读取的候选，永远记为缺口，不能被任何 `covered` 维度引用。
- `sourceId` 必须来自模型的 `sources[]`。来源后续被移除时，记录保持可读并标记失效，该补充不再计入覆盖。
- `gaps[]` 每项包含稳定 `id`、非空 `text`、`effect` 和非空 `outcomeEffect`。`effect` 为 `blocking`（阻碍成果）或 `supplementable`（可补充），`outcomeEffect` 说明这个缺口如何影响学习成果。

填写模板中的概念记录时，保留工具生成的概念ID和范围快照，显式填写 `role: "core"` 或 `"structural"`。下面是核心概念内一条维度和一条缺口的字段示例，替换为实际核对的内容；其余五类维度也必须逐项填写：

```json
{
  "dimensions": [{"id": "sources-gaps", "result": "partial", "basis": "原材料说明一般情形，尚缺重复值时首个命中的判定依据。"}],
  "gaps": [{"id": "first-match", "text": "首个命中规则未核实", "effect": "blocking", "outcomeEffect": "当前不能支持独立判断重复值中的首个命中。"}]
}
```

## 4. 公开命令与范围快照

```bash
# 生成当前目标与内容的精确范围快照骨架；概念 role 与六类检查等待作者填写
# 写到新的草稿路径，不要指向已有的 quality.json
node <skill-dir>/scripts/forge.mjs quality-template --out ./learning/probability --to ./learning/probability/quality-draft.json

# 只校验结构与范围引用，不写文件
node <skill-dir>/scripts/forge.mjs quality-validate ./learning/probability/quality-draft.json --out ./learning/probability

# 范围与当前模型/目标完全一致时写入 <out>/quality.json
node <skill-dir>/scripts/forge.mjs quality-write --out ./learning/probability --quality ./learning/probability/quality-draft.json

# 读取结论（含失效说明），保留历史记录
node <skill-dir>/scripts/forge.mjs quality-read --out ./learning/probability

# 重建学习页，让页面显示质检结论
# quality-write 只写 quality.json，不重建页面；写入后重跑 build 并刷新或重新打开新版页面
node <skill-dir>/scripts/forge.mjs build ./learning/probability/model.json --out ./learning/probability
```

`quality-template --to` 只写**新草稿路径**：骨架带空的 `role` 与未填检查，若目标文件已存在（包括 `<out>/quality.json`）会拒绝并提示改用新的草稿名，绝不覆盖已写入的质检记录。

`quality-read` 的输出包含报告级 `scope` 与 `recordedAt`（整份结论写入时的内容版本），每条目标的原始范围（目标、模型与逐概念/问题的指纹）和 `recordedAt`，以及完整的逐目标概念记录（`dimensions`、`supplements`、`gaps`、`staleReasons`）。同时保留扁平 `concepts[id]` 视图供既有读者使用：一个概念服务多个目标时，扁平视图保留全部 `goalIds`，`status`/`outcomeStatus` 取最保守、`passed` 取与、`stale` 取或，后出现的可用目标不会把先前 `still-gap` 结论改成通过。

扁平视图的 `goalId`、`outcome`、`role`、`dimensions`、`gaps`、`supplements` 取自概念状态最保守的那条目标记录；状态相同时保留先出现的记录。聚合标记与完整依据保持一致，各目标的完整记录仍保留在 `goals[].concepts` 中。

写入要求报告级 `scope`、每条目标自身的 `scope` 与目标文本都与当前模型一致（`modelFingerprint`、`goalFingerprint`、全部概念与问题指纹），且每个模型概念都已显式声明；任一不符即 `E_CONFLICT` 且不落盘。只写 `quality.json`，从不变动 `state.json`、内容指纹或掌握度。`build` 会把质检视图放进学习页载荷并读取记录，但不会改写 `quality.json`；因此写入质检后必须重跑 `build <out>/model.json --out <out>` 并刷新或重新打开页面，否则页面仍显示未质检。重建按稳定 ID 续接，保留已有学习档案与导图编辑。

## 5. 内容更新的处理

目标或内容更新后重建时，原结论只对原范围有效：`quality-read` 与学习页保留历史记录，标记 `stale:true` 并逐项列出需重新核对的目标、概念或问题；被移除的概念与来源不会让记录报错，只是不再计为覆盖。重新生成模板、核对变化部分后再写入即可。

报告级 `scope` 失效时整份报告 `stale:true`，所有目标、概念与扁平记录都 `passed:false`，且各自带上失效原因；读取只派生这些标记并保留原 `scope`，不会改写或补齐磁盘上的旧记录。历史遗留、缺声明或顶层版本不符的记录同样保持可读、只标为未通过。

## 6. 材料地图

收到原始资料或讲技能时，按 [source-grounded-teaching.md](source-grounded-teaching.md) 先核对材料。质检文件可选的 `materialMap.sources` 复用模型来源 ID，记录资料结构和真实阅读范围；模板仅给出来源身份与快照，未填写的阅读信息保持未知。

下面是地图中一个来源条目的形状示例，需替换为实际核对的信息；保留模板里的 `sourceSnapshot`，其字段以当前来源为准。

```json
{
  "sourceId": "src-skill",
  "sourceSnapshot": {"title": "技能原文", "kind": "provided", "note": "用户提供的本地材料", "url": ""},
  "version": null,
  "structure": ["入口", "输入", "流程", "必要引用"],
  "goalScope": [{"conceptId": "invocation", "range": "SKILL.md 全文及身份定位引用"}],
  "checked": [{"range": "SKILL.md 第1至30行", "basis": "逐段核对输入、自带流程及结束条件；引用另列", "readAt": "2026-10-10T00:00:00.000Z"}],
  "unread": ["与本次目标无关的其他技能"],
  "gaps": [{"range": "不可访问的外部示例", "reason": "无法取得正文，未作为规则依据", "effect": "supplementable"}]
}
```

`version: null` 表示取不到稳定版本；有可核对修订号、提交号或日期时填写字符串。`checked` 的每项都要有非空范围、具体依据与读取时间。未读材料放在 `unread`，读取失败、截断未补齐或引用不可访问放在 `gaps` 并注明对教学的影响。已核对部分可继续交付，不把缺口记作覆盖。

保存和读回继续使用 `quality-write`／`quality-read`，页面需写后 `build` 再打开「来源」。来源说明变化、来源移除、目标或内容范围变化会显示失效原因，历史地图原样保留；新写入需匹配当前来源快照与质检范围。旧记录无地图时显示范围未知；地图不进入 `state.json`，也不改变知识指纹、作答、调度或掌握度。工具只核对记录结构和范围一致性，不自动监测外部材料、不替导师证明已经读懂。
