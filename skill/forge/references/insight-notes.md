# 洞见与速查

洞见视图不新建事实，只把同一份学习档案里已有的记录按概念重新聚合。它复用公开的
笔记、自创问题、真实作答、修正和导师复核写入；读取本身不写档案、不改内容指纹，
也不会因为解释或导师文本齐全而提高掌握度。

## 会话操作

1. 确认可读取的学习目录；用户提供指定概念时沿用其真实 ID，未指定则汇总当前模型及有历史记录的概念。目录未知时只问档案位置，只有旧聊天记录时说明尚无所需档案，不重造模型或虚构学习记录。
2. 用下方 `insights --out <dir> [--concept <id>]` 读取已有记录；材料、文件或身份有误时说明具体缺项，保留原文件。结果没有学习者记录时交付空态，不把作者解释填成学习者理解。
3. 按概念呈现原解释或原答、已有修正、已保存反馈、反复出现且有记录依据的误区与自创检索问题。区分作者参考、学习者文本、导师反馈；注明缺项、历史孤立项与过时或无法核对当前版本的内容。
4. 结束时交代本次读取的目录与范围、看见的变化和仍缺少的记录。只读汇总在会话中交付，不写档案、不提升掌握度，也不替用户安排新教学或复习；用户请求额外产物或新学习时说明范围变化，再选择已安装的对应入口。

变化必须能定位到两份实际记录；只有一个版本时说明没有可比较的前后变化。误区次数与改善判断按真实记录说明，不从文字变长、反馈齐全或页面打开次数推断进步。用户明确要求另存本次汇总时，只能另存派生摘要并标注来源与范围，不修改原档案或将摘要写成新的学习事实。

## 读取模型

`insightRead(state, model, conceptId?)` 返回 `{ concepts: [...] }`。缺省列出当前模型
中的概念，并保留档案里仍有历史记录、但已从模型移除的概念；传入 `conceptId` 时只返回
该概念。每个概念至少包含：

- `conceptId`、`title`、`historical`：概念身份、当前标题，以及它是否只存在于历史
  记录中。
- `attempts`：该概念下的真实原答。每条保留原答的 `id`、`promptId`、`answer`、
  `at`、`assisted`、`tutorFeedback`、`corrections` 等真实字段，并补充：
  - `stale`：内容已经变化、问题已移除，或旧档缺少用于核对当前内容的指纹时为 `true`；
    页面明确显示“已过时或无法核对当前版本”，历史原答仍保留，缺指纹不证明内容曾变化。
  - `reviews`：来自合法集中复核请求成员关联的 `requestId`、`status`、`feedback`，
    并带 `pending`、`feedbackComplete`、`feedbackMissing`，让待复核项不会被误标为已完成。
  - `corrections`：修正事件保持真实结构（`text` 与 `assistance` 数组等），不是第二条
    作答，也不改写原答的 `assisted` 属性。
- `explanation`、`summary`：学习者或明确标记为导师的当前笔记，以及保留的
  `history` 版本；没有笔记时为 `null`。
- `questions`：绑到该概念的 `ownQuestion` 记录。
- `authorExplanation`、`authorExample`、`authorMisconception`：当前模型作者原文，
  用于区分“原理解”和“学习者的解释”。概念被移除时这些字段为 `null`。

集中复核反馈中的 `correct`、`misconceptions`、`basis`、`repair`、`nextTask` 是导师
原文；普通导师反馈来自原答的 `tutorFeedback`。两者都只显示身份和内容，不自动成为
掌握结论。缺失的解释、总结、作答或反馈按缺项显示，不从其它字段推断。

模型参数可以来自浏览器 `roundModel()`，即只有 `concepts` 数组、没有 `byId` 的原始
对象；读取和记录都会按稳定 `conceptId` 查找，不要求 Node 专用结构。

## 笔记历史

`explanations` 与 `summaries` 的每个值仍是可读的当前笔记：

```json
{
  "text": "当前文本",
  "updatedAt": "2026-10-10T08:00:00.000Z",
  "author": "learner",
  "history": [
    {
      "id": "稳定版本身份",
      "text": "之前的文本",
      "author": "learner",
      "updatedAt": "2026-10-09T08:00:00.000Z"
    }
  ]
}
```

`history` 是 optional 字段。旧笔记没有它仍可读取和重写；首次覆盖旧版本时，原来的
`text`、`author`、`updatedAt` 会写入历史。版本 `id` 是文本、作者和时间的精确稳定
元组，不使用可能碰撞的短哈希；界面只显示版本内容，不暴露长身份。

同一 `text` 和同一作者重复保存是幂等的：不新增历史、不推进 revision。新写入的
`author` 只能是 `learner` 或 `tutor`；省略作者时按网页的既有契约写 `learner`。
旧档中缺失或其它作者值不会被改写：缺失读作 `unknown`，其它值原样保留到当前记录和
历史。保存了不同文本或不同作者时，当前文本更新，旧版本留在 `history`。跨端合并时第一个参数是当前
可见版本，传入版本进入历史；两端的历史做并集。相同历史 `id` 但内容不同的记录不会
静默覆盖，会写入 `conflicts` 并保留两端内容供核对。

严格校验规则：

- `explanations`/`summaries` 旧档可省略；出现时必须是对象。
- `history` 出现时必须是数组；每项必须有非空 `id`、`text`、`author`；`updatedAt`
  可以是合法时间或 `null`（旧档未记录时间时）。
- 同一笔记内，同一历史 `id` 不允许对应不同内容。
- 纯读取不补写历史或迁移旧笔记。

## 只读命令

```bash
node <skill-dir>/scripts/forge.mjs insights --out <dir>
node <skill-dir>/scripts/forge.mjs insights --out <dir> --concept <id>
```

命令只读取当前 `model.json` 与 `state.json`，打印上述读模型；没有笔记 CLI 写入命令。
解释和总结仍由学习页的 note 保存接口写入，自创问题仍由 own-question 写入接口写入，
修正仍由 correction 写入接口写入。
