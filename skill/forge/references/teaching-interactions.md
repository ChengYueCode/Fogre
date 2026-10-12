# 对照与互动：比较对象、分步推演与参数实验

在需要让学习者并排观察两个容易混淆的对象（例如 GET 与 POST、均值与中位数）、按步骤查看一个机制的状态变化与因果，或改变条件观察结果并核对规则的适用范围时读取。三种组件都是**只读观察**，帮助学习者看清差异、过程或规则边界，不代替练习，也不产生任何掌握度证据。

## 配置

顶层可选字段 `interactions` 是一个数组。当前支持 `kind: "comparison"`、`kind: "step-through"` 与 `kind: "parameter"`；出现其它 `kind` 时 `validate`/`build` 都会以 `E_SCHEMA` 明确拒绝并说明“尚不支持”，不会静默接受。

```json
{
  "interactions": [
    {
      "kind": "comparison",
      "id": "get-vs-post",
      "conceptId": "http-method",
      "title": "GET 与 POST 对照",
      "objective": "能说出两者在语义、副作用与数据位置上的关键差异。",
      "boundary": "只覆盖 HTTP/1.1 与 HTTP/2 的方法语义，不展开缓存策略与鉴权细节。",
      "question": "把一次『点赞』改成可安全重试的请求，你会保留 POST 还是换方法？",
      "promptId": "http-method-explain",
      "relatedConceptIds": ["http-idempotency", "http-body"],
      "objects": [
        { "id": "get", "label": "GET", "values": { "purpose": "读取资源。", "side-effect": "按约定安全且幂等。" } },
        { "id": "post", "label": "POST", "values": { "purpose": "请求处理请求体内容。", "side-effect": "按语义既不安全也不保证幂等。" } }
      ],
      "dimensions": [
        { "id": "purpose", "label": "用途与语义", "difference": "读取 vs 处理请求体内容。", "boundary": "用 POST 查询并不违背语义。" },
        { "id": "side-effect", "label": "副作用与幂等", "difference": "GET 安全且幂等；POST 不保证。", "boundary": "幂等说的是方法语义，服务端仍可实现额外保护。" }
      ]
    }
  ]
}
```

## 字段与校验

- `id` 与对象/维度 `id` 都是安全 id（`[a-z0-9]` 起止、可含 `-`）；`__proto__`、`constructor`、`prototype` 一律拒绝。`interactions[].id` 必须数组内唯一；对象 id、维度 id 只在各自组件内唯一。互动组件的 id 可以和概念/问题 id 重名，命名空间相互独立。
- `conceptId` 必须指向存在的概念；`promptId`（可选）必须指向**同一概念**下的作者题；`relatedConceptIds`（可选）必须都存在、互不重复、且不等于自身概念。
- `objects` 至少 2 个；每个对象要为**每一个**维度给出非空 `values[维度id]`，多给或不给都会报错。`dimensions` 至少 1 个，每项要求 `label`、`difference`、`boundary` 非空。
- 校验失败码：形状错误 `E_SCHEMA`，id 非法 `E_ID`，重复 id `E_DUP_ID`，问题/概念引用错误 `E_PROMPT`；错误带具体路径（如 `interactions[0].objects[1].values.purpose`）。

## 分步推演（step-through）

用来让学习者按顺序查看一个机制的状态变化与因果。除与对照相同的公共字段外，`kind: "step-through"` 增加：

```json
{
  "kind": "step-through",
  "id": "binary-search-steps",
  "conceptId": "binary-search",
  "title": "查找 11 的区间收缩",
  "objective": "能说清区间如何收缩以及每次丢弃的依据。",
  "boundary": "只演示无重复元素、一次命中的情形。",
  "question": "如果目标不存在，最后在哪一步可以确定？",
  "promptId": "p-binary-search-explain",
  "relatedConceptIds": ["search-invariant"],
  "initialState": "在 [1,3,5,7,9,11,13] 中查找 11，区间 [0,6]。",
  "steps": [
    { "id": "shrink-right", "label": "① 中点 3，值 7 < 11", "result": "区间更新为 [4,6]。", "change": "丢弃左半。", "cause": "有序性保证左半不可能命中。" },
    { "id": "hit", "label": "② 中点 5，值 11 = 目标", "result": "命中，返回下标 5。", "change": "查找结束。", "cause": "中点值等于目标。" }
  ]
}
```

- `initialState` 必填且非空；`steps` 至少 2 个，每个 step 的 `id`（安全 id 且组件内唯一）、`label`、`result`、`change`、`cause` 都必填且非空。作者数据只作为文本渲染，永远不执行。
- `steps[0]` 是初始步骤，`steps` 的顺序就是推演顺序；页面显示当前步骤的 `result`/`change`/`cause`，并明确首末边界（第一/最后一步的按钮禁用）。

### 当前位置与内容版本

位置只保存“学习者在看哪一步”，写入档案的可选 `interactionPositions` 映射（键为 `interactionId`）：

```json
{
  "interactionPositions": {
    "binary-search-steps": {
      "interactionId": "binary-search-steps",
      "conceptId": "binary-search",
      "stepId": "hit",
      "contentSignature": "<规范化配置的精确稳定串>",
      "updatedAt": "2026-10-11T03:00:00Z",
      "source": "cli"
    }
  }
}
```

- 记录字段必须完整且类型正确（`source` 只能是 `browser`/`cli`，`updatedAt` 必须是合法时间，键必须等于 `interactionId`），出现未知字段或缺失字段会以 `E_STATE` 明确拒绝。
- `contentSignature` 是共享库由**规范化配置的精确稳定串**生成的，不是弱哈希；读取时逐字比较，只有完全一致且步骤仍存在才恢复，否则把位置标为过时并回到初始步骤。
- 组件被移除时位置作为历史保留，不静默删除也不复活。

```bash
node <skill-dir>/scripts/forge.mjs interaction --out <dir> --id <interactionId> --step <stepId>
```

页面通过本地服务的 `POST /api/interaction` 保存同一位置（请求带 `interactionId`、`stepId`、`modelFingerprint` 与 `revision`，沿用档案锁与版本检查）。导出、导入与重建都会带上有效位置；两端都有位置时保留较新的一次并报告另一版。这里只记观察位置，不写作答、评分、提示或掌握证据。

## 参数实验（parameter）

用来让学习者改变条件、观察结果，并核对一条规则的适用范围。组件只运行**预置规则**，作者只声明输入与角色映射，没有任何脚本入口。除与对照相同的公共字段外，`kind: "parameter"` 增加：

```json
{
  "kind": "parameter",
  "id": "uniform-speed-params",
  "conceptId": "uniform-motion",
  "title": "改变路程与时间，观察平均速率",
  "objective": "调整路程与时间，观察平均速率如何变化并核对『路程 ÷ 时间』。",
  "boundary": "这里用匀速直线运动演示：平均速率 = 总路程 ÷ 总历时，该关系对非匀速运动同样成立，只有在匀速直线运动里才同时等于瞬时速率；总历时必须大于 0。本次未模拟加速度、方向变化与瞬时过程。",
  "question": "时间不变而路程翻倍时平均速率怎样变化？",
  "promptId": "p-uniform-explain",
  "relatedConceptIds": ["speed-rate"],
  "rule": "ratio",
  "roles": { "numerator": "distance", "denominator": "time" },
  "inputs": [
    { "id": "distance", "label": "路程", "unit": "km", "min": 0, "max": 1000, "step": 1, "default": 120 },
    { "id": "time", "label": "时间", "unit": "h", "min": 0, "max": 24, "step": 0.1, "default": 2 }
  ],
  "outputLabel": "平均速率",
  "outputUnit": "km/h"
}
```

- `rule` 当前只支持 `"ratio"`（`numerator`/`denominator` → 分子 ÷ 分母）、`"product"`（`left`/`right` → 左值 × 右值）与 `"bayes-frequency"`（`prior`/`sensitivity`/`falsePositive` → 灵敏度 × 先验 ÷ (灵敏度 × 先验 + 假阳性率 × (1 − 先验))）。
- `roles` 必须恰好给出该规则的角色名，每个角色映射到已声明的 `inputId`，且同一个 `inputId` 不能用于两个角色。
- `inputs` 至少 1 个，每项 `id`（安全 id 且组件内唯一）、`label`、`unit`、`min`、`max`、`step`、`default` 都必填：范围是有限数值且 `min < max`，`step > 0`，`default` 落在范围内。`unit` 必填非空，无量纲写 `1`，概率刻度写例如 `比例0..1`。
- `bayes-frequency` 的三个概率输入范围必须落在 0 与 1 之间。
- `outputLabel` 与 `outputUnit` 必填非空。`process` 不由作者提供：共享读模型按规则生成可读的计算过程并带上单位。
- 出现 `script`、`expression`、`formula`、`code` 等脚本或表达式字段时一律 `E_SCHEMA` 拒绝，不静默忽略，也不执行任何来自资料的文本。

共享读模型 `interactionParameterView(interaction, values)` 是页面、后端与其它调用方共用的**唯一**计算入口：

- `values` 是以 `inputId` 为键的映射，值只接受数值或数字字符串；布尔、数组与对象按无效输入报错，不靠 `Number()` 强转。**未提供**某个键表示控件还未被触碰，此时用该输入的 `default` 计算并显示，保证首屏与首次计算一致；显式给出 `''`、`null` 或 `undefined` 视为真实输入并报错。
- 返回 `{ valid, error, errorCode, result, resultText, process, formula, inputs, values, inputErrors, rule, roles, outputLabel, outputUnit, objective, boundary, question, promptId, relatedConceptIds, contentSignature }`，其中 `formula` 是 `process` 的别名。
- 空值、非有限数、越界、`ratio` 分母为 0、`bayes-frequency` 阳性事件概率为 0、以及计算结果溢出（非有限）都返回 `valid: false`、`result: null` 与可读的 `error`：不把数值夹到范围端点，也不把上一次的正常结果当作新结果继续显示。`process` 仍展示公式与单位，便于对照当前缺少什么条件。
- 调参本身只是观察：不写入作答、评分、提示或掌握度证据，也不产生复习安排。

组件样例的机制出处与可以支持的范围见[机制来源与灵感边界](sources.md)。例如参数样例的速度来源只支持
“平均速率 = 总路程 ÷ 总历时”及单位说明，不把匀速演示写成公式的适用条件；HTTP 对照只引
RFC 9110 的方法语义，不把某一种接口风格写成通用规则；筛查样例来自固定人群下的频率化贝叶斯
解释，不是医学建议，也没有建模重复检测相关性、金标准误差或估计误差。

## 序列化与指纹兼容

- 未配置（字段缺失、`null` 或空数组）时不会新增 `interactions` 键，模型的 `modelFingerprint` 与引入本组件之前逐字节一致，概念与问题指纹也不变。
- 非空配置参与 `modelFingerprint`，因此内容变化会正常更新 `modelRevision`；`modelToJson` 输出规范形，重建后仍是固定点。

## 页面行为

- 概念详情页对 `comparison` 显示对照卡片：**两个**对象选择器加**一个**维度选择器，以及差异、维度边界、组件边界、后续检验问题和关联概念/本题入口。两个选择器允许选到同一个对象，此时页面明确显示“同一项无法比较”，**不会伪造差异**。
- 对 `step-through` 显示推演卡片：初始状态、原生步骤选择器、前进/回退与重置（首末按钮禁用），当前步骤的 `result`/`change`/`cause`，以及边界、后续检验问题和关联概念/本题入口。
- 边界分两层显示：所选维度/步骤的 `boundary` 与整个组件的 `boundary`，语义不混用。
- 未配置该概念时显示中性占位（“尚未配置互动组件”），不暗示内容已核对。
- 作者文本一律作为文本节点渲染，材料里形如脚本的字符串只作为纯文本显示，绝不执行。
- 观察对照与推演不写入任何作答、评分、提示或掌握度证据：选择对象、切换维度、逐步前进与重置都是纯观察。

选择规则由与后端共享的 `interactions.mjs` 提供（页面内联同一份实现，不复制规则）。新增对照组件后请同时更新模型、重建学习页，并保留 `sources`/`limitations` 中的核对依据。
