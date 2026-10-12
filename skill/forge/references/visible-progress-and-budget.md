# 可见进度、预算与收尾

用于现场教学、调整路线、询问“下一步呢”、预算临近与结束。恢复教学先 round-read；只要产物时直接交付，不强制教学计数。

## 一条真实回复，一个事件

新轮次 create 可加 `--track-progress`，总数从零起。已有轮次先 `round --action progress-start --out <dir>`，只从当前起算，历史总数仍未知。旧对话不能按印象补造次数；旧轮次的互动上限需明确重新约定为从此起点的上限。没有起点的读回保持未知。

实际用户的作答 answer、补充 clarification、纠错 correction、问路 navigation、改目标 goal-change、教学确认 confirmation、短暂离题 off-topic 均计一次。一个消息包含多个意图仍只记一个事件；“好的”计回应，但不能代填答案或证明掌握。教学之外的行政消息可用 excluded 保存，sourceNote 说明为何排除。导师消息、工具调用和页面点击不作为教学回应。

导师为每条真实用户消息提供稳定 ID、原文与出处。重试沿用 ID；不要给同一消息换 ID。工具不自动监听对话，也不解析用户原话。先保存该回复产生的真实作答，再记录计数，以便最后一次回应到达上限时答案已保存。

```json
{"id":"user-turn-01","kind":"navigation","text":"下一步呢？","sourceNote":"隔离教学第1条用户消息"}
```

```bash
node <skill-dir>/scripts/forge.mjs round --out <dir> --action progress-event --record <response.json>
node <skill-dir>/scripts/forge.mjs round-read --out <dir>
```

## 时间和估计

互动数不是耗时。实际时间仅累计明确的实际学习区间，不把创建到当前的墙钟差或问答数当作学习时间。暂停、离开、工具运行等不包含在区间中；sourceNote 说明依据。区间不得重复、重叠或晚于记录时间；没有区间时 actualMinutes=null，记录量不保证覆盖全部学习时间。

```json
{"id":"interval-01","start":"2026-10-10T01:00:00Z","end":"2026-10-10T01:06:00Z","sourceNote":"学习者确认的实际学习区间，未包含暂停"}
```

通过 `round --action progress-time --record <interval.json>` 保存。用户分钟上限用于既有路线安排，记录时间达到上限也会触发收尾；预计任务分钟不等于实际消耗。记录量临近上限时提示优先核对和收尾；时间未知时明确未知并询问是否仍有预算，不默认为未消耗。

## 导航与调整

开场、单元切换、路线调整、预算临近、恢复和结束展示“当前单元 → 当前任务 → 下一步 → 剩余与暂缓范围”，普通反馈只保留当前任务和下一步。用户问“下一步呢”时直接给位置和任务，修复此前缺少的导航，不要求再问是否继续。

补讲、跳过、新增或修改目标后，先更新公开路线，再解释范围与预计剩余量如何变化。update 的既有 goal/concept/minutes 用于修改目标、扩展范围及预算；附 adjustment 保存理由、旧证据适用范围、补讲预计剩余分钟、预计剩余互动范围，以及正式任务 skipTaskIds。extraMinutes 是当前剩余补讲估计，重写替换而非累加；预计互动不是硬上限。

```json
{"reason":"从理解机制改为实际使用，补完整演示","evidenceApplicability":"原解释只支持旧目标；新应用仍待检验","extraMinutes":5,"interactionEstimate":{"min":1,"max":2,"basis":"示范后一次独立尝试，必要时补充"},"skipTaskIds":[]}
```

```bash
node <skill-dir>/scripts/forge.mjs round --out <dir> --action update --goal <新目标> --concept <目标概念> --adjustment <adjustment.json>
```

旧作答原文保留；移出或跳过任务保留为归档，跳过不等于完成。自动生成的任务估计会随路线更新，未提供互动估计保持未知；目标/内容变化后历史收尾失效，需要导师重新核对。预算耗尽后经明确提高/清除上限可续接，旧收尾保留在 closureHistory，计数不重置。

## 如实结束

达到用户互动硬上限或已记录时间达到分钟上限时，工具保存预算收尾并拒绝新增本轮学习任务。补写明确缺口、保存说明和续接点；不为凑次数继续提问。有充分证据时提前结束，工具检查每个目标概念的当前独立导师证据，导师另须核对该证据是否足以支持本轮自然语言目标，不能以解释证据宣布操作应用已达成。

`round --action close --record <closure.json>` 支持 budget-exhausted、goal-achieved、learner-stop：

```json
{"reason":"budget-exhausted","gaps":["新情境应用仍待检验"],"continuation":"下次从应用任务开始，先核对预算","saveNote":"原答和进度已保存到学习目录 state.json","evidenceApplicability":"原答已提交，尚待导师核对；未宣布应用掌握"}
```

收尾说明实际完成内容、独立与有协助表现、未解决缺口、结束原因、产物目录与保存方式、下一次入口。学习结束、任务已提交、证据待复核和掌握判断分开，工具不会用收尾改写原答、评价、调度或 round.status。unknown 保持未知。

HTTP `/api/round` 使用同一 action/record/adjustment 合同及版本检查。页面“本轮”只读进度和收尾，不将点击或提交自动翻成聊天次数。服务保存到档案；独立页仅浏览器缓存，导出并导入之后才可交给会话，未交接时如实说明。
