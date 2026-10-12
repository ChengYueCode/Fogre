# 本轮路线与续接

本轮是一次学习安排，目标、预算、任务、作答归属和暂停位置保存于学习目录的 `state.json`。生成产物、定位图谱、任务已提交分别不构成概念掌握。仅需产物时直接交付模型、学习页和导图，保留问题及参考，不必创建轮次。

## 开始与诊断

现场新主题先按 [开场参考](learner-aware-opening.md) 复用画像并展示有限初步范围；`round create|update --opening <JSON文件>` 保存画像及开场范围，`round-read` 和本轮页面读回。未知历史保持 null。

先读材料并生成可用模型。目标写成学习者要能解释、比较或应用什么；概念ID来自该模型，必要前置使用 `prerequisite` 的 `from → to` 关系。路线按目标和必要前置排序，已核对且仍有效的缺口参与排序。未填预算时先安排一个目标小单元及其必要前置；分钟是估计，不是学习成效承诺。

```bash
node <skill-dir>/scripts/forge.mjs round --out <dir> --action create --round-id <稳定ID> --entry organize-existing-material --goal <可观察成果> --concept <概念ID> [--concept <另一ID>] [--minutes <分钟>]
node <skill-dir>/scripts/forge.mjs round-read --out <dir> [--round-id <ID>]
```

新主题把入口改为 `learn-new-topic`。先看返回的诊断任务，提出问题并**等待学习者真实回答**；将收到的原文关联轮次与诊断任务保存，读取答案后辨认缺口，再显式确认诊断并按需要调整路线。不能自己写诊断答案或用展开图谱代替作答。诊断题目不足时先补入真正可回答、可检验的问题，保留真实材料来源。

```bash
node <skill-dir>/scripts/forge.mjs submit --out <dir> --prompt <题目ID> --answer <真实原文> --round-id <轮次ID> --task-id <任务ID> [--attempt-id <ID>]
node <skill-dir>/scripts/forge.mjs round --out <dir> --action confirm-diagnosis --round-id <轮次ID>
```

页面的诊断确认只表示显式开始正式路线，实际导师讲解仍须基于刚读取的回答。确认不会写掌握证据；记录有协助的诊断也不会变成独立回忆证据。

## 调整、暂停与恢复

只有“继续上次学习”而没有目录时，先按[学习档案入口](learning-library.md)查找已登记主题，选定后读回。显式目录仍直接使用下列命令。

```bash
node <skill-dir>/scripts/forge.mjs round --out <dir> --action update --round-id <ID> [--goal <新成果>] [--concept <ID>] [--minutes <分钟>|none]
node <skill-dir>/scripts/forge.mjs round --out <dir> --action focus --round-id <ID> --task-id <任务ID>
node <skill-dir>/scripts/forge.mjs round --out <dir> --action pause --round-id <ID>
node <skill-dir>/scripts/forge.mjs round --out <dir> --action resume --round-id <ID>
```

恢复先 `resume-read --out <dir> [--round-id <ID>]` 统一读回：身份、画像、目标预算、位置、互动、原答（含协助属性）、缺口、材料范围与纠错历史一次给全，并单独列出保存值与当前值的差异。仍适用的画像、目标和已适用的诊断不重复；`changes` 里目标或材料变化波及的任务、失效证据与过期材料地图要逐项向学习者说明——历史保留，不沿用失效结论，按当前目标调整后再继续。再 `resume` 继续同一轮次，保留原目标、预算、诊断状态、已发生作答和暂停位置，不重新初始化。目标或预算变动保留修订历史；预算外任务明确暂缓。更换轮次不挪用旧轮草稿；历史未记录轮次的作答继续保持未知归属。

入口是轮次创建时的来源，不能通过调整改成另一入口；换入口时另开一轮。预算连首个必要任务也容不下时，路线仍保存，但没有可开始的任务，读取与页面会显示所需分钟；增加时间或调整目标后再继续，不跳过前置或把暂缓任务当作完成。已移出路线的任务保留旧答案，不能新增作答；相同事件的幂等重放仍可确认。

内容更新保留原作答并标记失效，删除内容保留孤立历史。读取后通过 `update` 重新安排当前有效内容，再取得真实新作答，原答和新答各自保留。学习页上「已提交」说明有实际表现可核对，不保证答对；完成标准、内容质检、层级、难度与掌握状态分别阅读。

## 页面与保存

「本轮」标签可开始、调整、暂停和恢复，任务可进入练习或定位图谱，概念和练习可返回本轮。提交时保存明确的轮次/任务身份，无需先自评。公开 `round-read` 与 `export` 可供导师核对。

本地服务通过现有版本检查和共享档案锁写回 `state.json`；独立页面只写本机浏览器缓存，关闭后在同一浏览器恢复。独立模式先导出状态，把可读取文件交给导师；导师不能宣称已读取尚未导出的缓存。重建学习页会保留档案与图形编辑，独立缓存与新版内容有分歧时保留记录并提示冲突。

学习者请求“检查本轮作答”时，用轮次身份建立固定范围的复核请求，再逐项读取原答、保存反馈与导师评价。部分复核沿用同一请求续做；新答案保留到下一请求。操作步骤和证据边界见 [集中复核](evidence-and-review.md#集中复核本轮作答)。独立文件完整往返见[交接步骤](portable-handoff.md)，按表现调整后续练习见[递进练习](progressive-practice.md)；预算内复习选择另按对应能力验收。
