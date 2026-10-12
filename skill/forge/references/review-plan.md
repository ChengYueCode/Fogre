# 预算内复习选择

到期任务多于本轮时间时，先安排真正阻碍当前目标的前置缺口和反复错误，再按到期程度
补齐；学习者可以主动指定本轮重点，其余到期项如实暂缓并保留真实到期身份。选择只是
本轮的安排，不是完成、遗忘或新的掌握结论。

## 会话操作

1. 确认用户指定的学习目录、可读取的 `model.json` 与 `state.json`，以及本轮重点和时间预算。已有信息直接沿用；未给目录时询问档案位置，不从聊天重造档案。读取 `round-read --out <dir>` 确认适用轮次；有多个候选且用户未指定时让用户选择，不自动切换活动轮次。
2. 用下方 `review-plan` 命令生成只读预览。未给时间预算时沿用已有预算，无预算就安排一个聚焦小单元；不要求用户重复填写已保存信息。默认按真实当前时间查询，`--at` 仅用于明确标注的工具测试。
3. 向用户展示本轮预计用时、选中内容与具体选择理由，再说明暂缓内容、到期状态与前置缺口。区分“已到期”“主动重点”“普通可选”与“无法执行”；没有到期项可以依据已有缺口安排，不虚构到期事实。
4. 用户只要求安排时交付预览，不写档案。用户明确要求把计划保存或应用到本轮时，才执行下方 `round --action review-plan`，再读回同一轮次确认结果；保存计划仍不算完成练习。

完成时给出“今天先做哪些、为什么、预计多久、哪些暂缓、是否已保存”。轮次缺失（`present: false`）时如实说明本入口尚不能生成本轮计划，询问是否由已安装的主技能建立学习轮次；不擅自新建或启动诊断。档案缺失、损坏、版本冲突或诊断尚未确认时保留现有文件并说明阻塞；未完成的预览或失败的应用不宣称保存成功。

## 纯计划接口

`skill/forge/scripts/lib/round.mjs` 导出共享纯函数（Node 后端和浏览器页面运行同一份算法）：

```js
roundReviewPlan(state, model, options?, at?)
```

- `options.roundId`：缺省读 `state.activeRoundId`；没有轮次时返回 `present: false`。
- `options.budgetMinutes`：正整数或 `null`（无预算，只聚焦一个小单元）。省略时沿用已保存
  计划的预算，其次读 `round.budgetMinutes`。
- `options.focusPromptIds`：`string[]`，按给的顺序去重。省略保留已保存重点；显式 `[]`
  清除重点。列表里每一项都必须是当前内容中的真实题目（作者题或学习者自创题）。
- `at`：`ISO` 时间字符串；只用于确定性测试和对比同一档案在不同时间的选择，不写成安排。

返回对象的稳定字段：

```js
{
  present, roundId, at, budgetMinutes, focusPromptIds,
  candidates,      // 所有候选（含未进入本轮筛选的普通可选题）
  selected,        // 预算内真正安排的任务
  deferred,        // 本轮未安排、但保留真实到期/重点状态的项
  estimatedMinutes,
  allDue,          // 完整的真实到期清单，与 selected 分开
  dueCount,
  modelFingerprint
}
```

`selected` 与 `deferred` 都是候选对象数组，每个至少包含：

- 身份与内容：`promptId`、`conceptId`、`conceptTitle`、`question`、`origin`
  （`model`/`learner`）、`target`。
- 选择依据：`reason`、`priority`、`priorityKind`、`source`、`sources`、
  `estimatedMinutes`、`deferredReason`、`considered`、`focus`、`actionable`、
  `unresolved`。
- 真实复习元数据：`dueAt`（无安排为 `null`）、`dueNow`（只有当前查询时间已经越过
  `dueAt` 才是 `true`）、`assessmentSource`、`attemptId`、`pendingAssessmentAt`
  （同题更新、未评价的新原答；保留上次有效安排的身份）。

固定优先级 `priority`：前置缺口 `0`，主动重点 `1`，重复错误 `2`，真实到期 `3`，
普通可选题 `9`。同级按稳定 `promptId`/`conceptId` 排序，所以相同输入总是得到相同顺序。
`dueNow` 只表示“已经到期”这一事实：未来安排的题在重点计划里也会带真实 `dueAt`
并显示为尚未到期，不会被写成“仍到期”。

## 选择规则

1. 前置缺口：按当前轮次目标的有效教学/关系前置拓扑排序，只排当前内容里真实存在、
   但还没有当前独立原答导师成功依据的前置。前置概念没有作者题时该项是
   `actionable: false` 的 `unresolved` 暂缓项，不占预算、不伪造可执行任务；原因明确
   写出需作者补题或改为可核对材料。
2. 重复错误：同一题在“最近一次独立原答导师成功”之后，至少 2 条当前内容的独立原答
   被导师评为 `hard`/`again` 才成立。每条原答只看它最新的**原答目标**导师事件：
   后来针对修正的 `good` 既不能抹掉原答的 `hard`/`again`，也不能把修正当成新的独立
   原答；后来的当前独立原答导师成功才会清除旧错误。重复事件、自评、有协助作答都不
   计次。
3. 真实到期：`state.schedules` 里有有效 `dueAt` 且当前查询时间已过的题，按到期先后
   排序；未选中的到期项只在 `deferred` 里暂缓，不改 `schedule`、`dueAt`、`attempt`，
   也不当作完成或遗忘。
4. 预算执行：只按确定后的顺序取前缀。某项放不下时，它和之后的所有项都暂缓，所以
   预算永远不能跳过较贵的前置去安排更便宜的后续题。无预算时只打开一个聚焦小单元。

## 学习者主动重点

`focusPromptIds` 是学习者对本轮的真实覆盖，不是装饰性标记：

- 先安排重点自己的必要前置，再安排重点题本身。
- 旧目标、默认复习计划里的其他项（包括旧目标前置、重复错误、其他到期题）保留在
  `deferred` 里，除非它们同时是重点所需的前置。
- 重点题的 `reason` 明确写出“学习者主动调整本轮重点”；只改安排，不表示完成，也不
  改写复习日期。
- 未到期或未来安排的重点题同样可选，并如实带 `dueAt` 与 `dueNow: false`；没有安排的
  重点题也如实显示等待后续补漏。

## 只读预览与显式应用

只读预览不写档案：

```bash
node <skill-dir>/scripts/forge.mjs review-plan --out <dir> \
  [--round-id <id>] [--minutes N|none] [--at <ISO>] [--focus-prompt <promptId>]...
```

输出把 `allDue`（完整到期清单）与 `selected`/`deferred`（预算筛选结果）分开，
并标注 `--at` 是独立测试目录的模拟时间，不代表真实保持效果。

只有显式的轮次操作才会把计划写回路线：

```bash
node <skill-dir>/scripts/forge.mjs round --out <dir> --action review-plan \
  [--round-id <id>] [--minutes N|none] [--at <ISO>] \
  [--focus-prompt <promptId>]... [--clear-focus]
```

- 省略 `--focus-prompt` 保留已保存重点；`--clear-focus` 与 `--focus-prompt` 不能同时用。
- 应用后把 `selected` 与 `deferred` 写成带稳定 id 的路线任务，并保存
  `round.reviewPlan`；被替换的旧任务进入 `archivedTasks`，原任务 id 与已绑定作答保留。
- 应用**不写** attempt、rating、schedule、dueAt 或完成标记：选中不等于完成，任务真正
  完成仍由真实提交决定。
- 之后只有显式 `review-plan`、或明确改预算/概念的 `update` 才会重新规划；仅改目标文字
  不会静默用新证据改写已保存路线。暂停/恢复保留 `round.reviewPlan` 与重点。
- 诊断未确认的轮次拒绝应用复习计划（`E_CONFLICT`），避免绕过诊断门。

## 学习者自创问题

`focusPromptIds` 可以指向学习者自创问题（`origin: "learner"`）。后端和页面提供同一份
question fingerprint，所以：

- 计划出的自创题任务带真实 `fingerprint`，能完成绑定提交并参与本轮完成判定。
- 修改自创问题文字后，旧任务读作 `contentUpdated`/`staleSubmissions`，新的作答被拒绝，
  不会静默匹配旧内容。
- 自创题永远不产生导师掌握、独立成功或重复错误依据；没有作者参考时如实标出
  `hasBasis: false` 边界。

## 兼容与校验

- `round.reviewPlan` 是可选字段：旧档不含它仍可读取、校验和继续使用；一旦存在就严格
  校验 `at`、`budgetMinutes`、`focusPromptIds`、`selected`、`deferred`、
  `estimatedMinutes`、`dueCount`、`modelFingerprint` 和每个候选的字段类型。
- 非法预算、空/重复非法重点 id、未知重点题都返回结构化 `E_USAGE`；诊断轮次应用返回
  `E_CONFLICT`。这些错误不会写入档案。
