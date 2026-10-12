<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 证据、掌握度与复习调度

这份参考在你需要判断"学习者到底会不会"、安排或检查到期复习、或复核一次作答时才需要读。

## 集中复核本轮作答

学习者请求检查多个已保存答案时，按 [集中复核操作](tutor-review.md) 建立固定范围的请求、读取真实作答与内容快照、逐项保存反馈并续做未完成项。无轮次历史先由学习者明确选择范围；请求开始后的新答案留到下一请求。评价和掌握证据仍按下面的规则分别处理。

## 1. 证据分级

| 证据 | 来源 | 能支持什么 | 不能支持什么 |
|---|---|---|---|
| 已保存原答（可未自评） | CLI `submit` 或学习页 `POST /api/submit` | 稳定 `attemptId`、原文、提交时间、内容版本、入口及协助来源；供导师读取 | 未评价时的调度、概念掌握 |
| 独立作答 + 自评 | 已保存原答的 `POST /api/assessment`（原答 `assisted: false`）；旧 `/api/attempt` 兼容 | 该问题的调度与自评记录 | 概念掌握、其他问题的掌握 |
| 有协助作答 + 自评 | 看过参考或有提示后作答（`assisted: true`） | 保守的调度；永久保留"有协助"标签 | 独立回忆的证据 |
| 导师评价与反馈 | `assess` 命令（agent 侧复核指定原答或修正） | 同一作答的有效调度输入，导师评价优先，自评仍保留 | 自动升级掌握、新的独立回忆 |
| 导师复核证据 | `evidence` 命令（agent 侧复核，写入 `reviewer: tutor`） | 该问题或概念的状态：`unknown` / `needs-work` / `explained` / `applied` / `retained`，且必须引用实际存在的当前作答 | 未复核内容或缺少当前作答依据的掌握 |
| 覆盖/打开/展开/生成图形 | 页面行为 | 只有界面状态 | 任何掌握判断 |

掌握度状态含义，必须同时有文字说明，不能只靠颜色：

- `unknown`：还没有证据。整理已有材料时的默认值。
- `needs-work`：作答暴露出可指名的缺口或误解。
- `explained`：能用学习者自己的话说明概念与关系，且没有未修补的误解。
- `applied`：能在新的情境里用出来（换数值、换场景、换表述）。
- `retained`：在间隔后仍能独立回忆或应用。

没有证据就不要升级状态。各状态在 forge 实现里的最低要求（`EVIDENCE_RULES`）是：

- `explained`：至少 1 条当前内容的独立 `explain` 或 `compare` 作答。
- `applied`：至少 1 条当前内容的独立 `apply` 作答；`applied` 不能从一次被提示后的作答推出。
- `retained`：至少 2 条当前内容的独立作答，且最早与最晚相隔 ≥20 小时；同一分钟的重复不算。
- `needs-work`：至少 1 条当前内容的作答（独立或有协助均可）。

“当前内容”指问题与参考的指纹仍与模型一致；`evidence` 复核必须用 `--attempt` 引用实际存在的作答，并写入当前指纹。20 小时是 forge 的实现下限，用来说明“跨会话再次提取”，不是学习效果的保证。问题级复核（`--prompt`）不会自动升级为概念级证据；概念证据要用 `--concept` 单独复核，并满足上面的要求。

## 2. 浏览器自评 vs 导师证据

- 提交非空作答即保存原答，`rating: null` 表示尚未对原答自评。自评与导师评价均无时显示待复核、待安排；仅导师评价也能调度。`GET /api/state` 或 CLI `export` 可读取。提交本身不生成调度。
- 页面上的 `again/hard/good/easy` 是**自评**：对明确已保存的 `attemptId` 写入评价并安排 `schedules`；它不会新增原答或写 `conceptEvidence`。
- `practiceSessions` 保存稳定练习身份、草稿与 `assistance`（`hint`、`reference`、`tutor-feedback`、`starter`（起步帮助）、`demonstration`（完整示范））。主动查看帮助时先成功保存协助事实，再展示内容；重开仍保留有协助事实。成功提交后自动展示参考不会改写原答的独立属性。
- 修正追加独立 `correctionId`，关联原答 `attemptId` 并保留入口及协助来源；原答案、提交时间、独立属性不变，作答次数不增加。
- 参考默认隐藏，学习者先给出非空作答才能看到它。学习者也可以在作答前主动请求帮助/查看参考；这不算违规，但这次作答会被标记为有协助（`assisted: true`），不能当作独立回忆证据，也不能升级为独立掌握。
- 页面永远不能提交 `tutor` 来源的证据。这是权限边界，不是 UI 疏漏。
- 导师对指定作答使用 `assess` 保存评价与单独反馈；不需要先有自评。评价注明原答或 `--correction-id` 对应修正。自评、导师评价、反馈和 `evidence` 掌握结论分别保留，评价本身不会生成掌握结论。
- 导师复核的是**实际发生过的作答**。`evidence` 命令要求该问题存在对应的 attempts；没有作答就给掌握证据，等于编造学习证据。
- 复核时可以补充说明依据（学习者原话、计算过程、被追问后的修正），并把它写进 `note`。若学习者的解释只在部分条件下成立，用 `needs-work` 而不是 `explained`。
- `explanations` / `summaries` 里的文字是学习者自己的笔记，不是掌握证据；只有对应问题的真实作答（并有当前指纹）才可能支撑复核。

记录与复核的命令示例：

```bash
# 先保存原答；保留 attempt-id 用于安全重试与后续评价
node <skill-dir>/scripts/forge.mjs submit --out ./learning/probability --prompt p-apply-ppv \
  --answer "真阳性 18、假阳性 49，PPV≈26.9%" --attempt-id att-original

# 稍后对该已保存原答补自评（无需重传答案）
node <skill-dir>/scripts/forge.mjs review --out ./learning/probability --prompt p-apply-ppv \
  --attempt-id att-original --rating hard

# 导师读取真实作答后评价；固定事件身份用于安全重试
node <skill-dir>/scripts/forge.mjs assess --out ./learning/probability --prompt p-apply-ppv \
  --attempt-id att-original --rating again --note "原答漏计了假阳性，需要补充分母。" \
  --assessment-id tutor-original-1

# 旧的同时记录作答与自评用法仍兼容
node <skill-dir>/scripts/forge.mjs review --out ./learning/probability --prompt p-apply-ppv \
  --rating hard --answer "真阳性 18、假阳性 49，PPV≈26.9%" --at 2026-10-09T08:00:00Z

# 复核指定 attempt；--status 与 --note 必填，--attempt 可重复
node <skill-dir>/scripts/forge.mjs evidence --out ./learning/probability --prompt p-apply-ppv \
  --status applied --note "用 2% 患病率重算正确：真阳性 18、假阳性 49。" --attempt att-xxxxxxxx
```

## 3. 调度规则（确定性、可复现、不是 FSRS）

调度完全由已记录的事件推导，没有隐藏状态、没有随机数、没有后台自动化。给定同样的 `--at` 时间与同样的事件序列，结果完全一致。规则是简单的间隔表，不宣称学习效果。

初始间隔（天）：`again: 1`、`hard: 2`、`good: 4`、`easy: 7`。

- 有协助（`assisted: true`）作答：取 `min(基础间隔, 2)` 天，并保留"有协助"标记。
- 连续独立 `good`：第 1、2、3… 次分别取 4、10、18 天，其后每次乘 1.5 并四舍五入（`Math.round`）。
- 连续独立 `easy`：第 1、2、3… 次分别取 7、20、40 天，其后每次乘 1.8 并四舍五入（`Math.round`）。
- 任意一次 `again` 或 `hard` 会把该问题的连击清零；`again` 之后从初始间隔重新开始。
- 上限 180 天。新作答以实际提交时间锚定间隔，评价时间另存。旧档只有组合记录时间时沿用其历史语义，不补造提交时刻。
- 同题当前内容的已评价作答按提交时间及稳定标识排序重放；每个作答最多贡献一次输入，同次导师评价优先于自评。晚到评价替换所属输入后重算后续连击，安排始终归属最后已评价作答。评价到达顺序不影响结果。
- 更晚的未评价提交仍显示待复核、待安排，既有日期标为上次有效评价的安排；到期或逾期明确显示已到期。有协助的修正不会成为新独立回忆，按保守规则安排。
- 新提交/修正的相同身份与相同原文、来源可安全重试；改变原文或来源会冲突。同一评价目标补相同自评不会重复安排，改变已保存自评会冲突。导师评价按事件身份幂等，新复核事件替换同次作答的有效评价并重放后续安排。旧 `applyAttempt` 的组合事件回放拒绝规则保持兼容。

这些系数是 forge 自己的选择，用于让"再次出现的时间"随表现单调变化。它们**不是** FSRS 或任何已验证算法的实现，也不应被描述成"科学保证的记忆曲线"。

## 4. 检查到期

```bash
node <skill-dir>/scripts/forge.mjs due --out ./learning/probability --at 2026-10-09T08:00:00Z
```

输出是 JSON（字段形状示例，概念/问题 id 取自教学样例）：

```json
{
  "at": "2026-10-09T08:00:00Z",
  "due": [
    { "promptId": "p-apply-ppv", "conceptId": "bayes-update", "intervalDays": 2, "lastRating": "hard",
      "lastAt": "2026-10-07T08:00:00Z", "dueAt": "2026-10-09T08:00:00Z", "assisted": false }
  ],
  "unscheduled": [
    { "promptId": "p-compare-denom", "conceptId": "sensitivity-specificity", "reason": "never-attempted", "lastSeenAt": null }
  ]
}
```

- `due`：到期或逾期的问题，先处理它们，再学新内容。
- `unscheduled`：从未作答、已保存但未评价安排，或旧证据因内容变更而失效的问题。`reason` 可为 `never-attempted`、`pending-assessment`、`stale-evidence`。
- 恢复学习时的顺序：到期复习 → 仍有缺口的前置概念 → 新内容。前置缺口按模型的 `prerequisite` 关系与概念证据判断。
- 页面打开时用同样的规则显示到期清单；forge **不**创建后台任务或定时提醒。

## 5. 记录与复核工作流

1. 学习者作答（页面或对话中）。把原话保留下来，不要只记结论。
2. 页面提交成功后读取保存位置：本地服务写入 `state.json`，独立模式写入当前浏览器缓存；导出可备份。未自评原答没有新调度。缓存写入失败时输入保留在当前页面，队列等待重试；只在实际写入成功后确认保存。
3. 判断证据等级：独立/有协助，自评/导师。
4. 有必要时用 `evidence` 命令写入复核结论与依据；一次 `explained` 不必配一次 `applied`，除非确实做对了新情境的应用。
5. 记录误解与修订：原来的说法、暴露的缺口、修补后的说法。`explanations[conceptId]` 保存当前解释，`summaries[conceptId]` 保存总结；作答原话与后续修正保留在 `attempts[promptId].answer` 与 `corrections` 中，不要用整段对话替代。
6. 内容更新后按稳定 ID 续接。若问题文本或参考被改写，旧 attempt 的 `fingerprint` 失效，其证据标为 `stale`，需要重新作答才能恢复判断。
7. 旧档升级后这些记录原样保留：原时间、协助属性、内容指纹与 `attemptIds` 关联都不会被迁移改写；缺少 `attemptIds` 的旧复核记录如实列出并按待复核处理，不会显示为当前掌握。首次升级写入前的逐字节旧档副本可用 `restore` 核验并恢复。

## 6. 边界

- 调度只根据本状态文件；不要把它描述为云同步、跨设备同步或模型记忆。
- 到期清单是提示，不是学习效果证明。
- 自评与导师复核是两类记录；导入分歧保留现有版本并报告冲突，不要静默覆盖。
- 不要因为学习者长时间未复习就降低已有证据的等级；改用“证据已过时”来提示重测。
- 页面保存、CLI 写入与 `build` 共用档案锁与档案/内容版本检查；向学习者转述冲突时要说明可以基于当前状态重试，不要让旧快照覆盖新记录。
