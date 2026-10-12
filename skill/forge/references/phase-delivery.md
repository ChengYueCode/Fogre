# 第一阶段完整旅程与交付

这份参考在需要走完第一阶段的一次完整学习——学新主题、整理材料或恢复学习——并交接待复核作答、或从失败里恢复时才读。它给出三个入口的端到端步骤、产物位置、复核交接与恢复动作；字段、证据与质检规则仍由各自参考持有，不在这里重复。按表现递进练习、三类互动组件、洞见与预算内复习的第二阶段旅程见[第二阶段完整旅程](phase-two-delivery.md)，本参考的入口步骤在那里继续。只使用单项能力（只要产物、只提问检查、只复核、只安排复习、只汇总洞见、只交接档案）的请求先按[能力路由](module-routing.md)判定，不在这里展开成完整旅程；教学旅程中嵌入单项能力时按[模块交接约定](module-contract.md)携带任务、预算与返回位置。

状态：本文是第一阶段旅程的操作说明。forge 已提供这里用到的公开命令；端到端核验、本机安装与分发包一致性需单独验证。本文不宣称阶段验收已经完成，也不把任一入口描述成已实测通过；实际结果以公开命令输出、本地接口读回、真实档案与浏览器记录为准。

## 产物与两种保存方式

一次学习放在一个学习目录，下面所有步骤都围绕它：

| 产物 | 内容 |
| --- | --- |
| `model.json` | 作者内容：概念、关系、问题与参考 |
| `state.json` | 学习者档案：轮次、作答、自评、笔记、证据与调度 |
| `index.html` | 学习页，CSS/JS/模型/状态内联，可离线打开 |
| `map.excalidraw` | 可编辑思维导图；`build --svg` 另出 `map.svg` |
| `quality.json` | 作者侧内容质检记录，由 `quality-write` 单独写入 |

保存有两种语义，不能互相顶替：

| 方式 | 什么时候用 | 写入位置 | 怎么恢复 |
| --- | --- | --- | --- |
| 本地服务 | `serve --out <dir>` 期间页面自动存档 | 直接写回 `<dir>/state.json` | 重开服务或重新 `build` 后读同一目录 |
| 独立缓存 | 直接打开 `index.html` | 只写当前浏览器的本机缓存 | 同一浏览器重开；换会话要先从页面导出档案 |

导出档案（独立页面下载，或 CLI `export --out <dir> --to <file>`）只是生成一份文件：它不自动更新学习目录，也不代表会话已经读到其中的答案。把导出文件归入目录要显式 `import`，且导入文件里的导师身份默认不可信，细节见[独立文件交接](portable-handoff.md)。

## 入口一 学新主题（learn-new-topic）

目标：诊断先行，教学路线由学习者的真实表现决定。

1. 组织可用模型：读材料 → 写模型（schema 与命令见[学习产物](artifacts.md)）→ `validate` → `build <模型源.json> --out <dir>`，让目录里出现 `model.json`、`index.html`、`state.json`、`map.excalidraw`；轮次命令缺省从 `<dir>/model.json` 读内容，目录里没有它时先补齐或显式传 `--model`。
2. 建本轮：`round --action create --entry learn-new-topic --goal <可观察成果> --concept <概念ID> [--minutes N]`，读回轮次与诊断任务。
3. 提出真实诊断问题并**停下来等回答**；把原文按轮次与任务保存（`submit ... --round-id <轮次ID> --task-id <任务ID>`）。不代写诊断答案，也不用展开图谱代替作答。
4. 读回答辨认缺口，再 `round --action confirm-diagnosis --round-id <ID>` 开始正式路线；需要时 `round --action update` 调整目标或预算（`--minutes <N>|none`）。
5. 内容或路线变化后重新 `build <dir>/model.json --out <dir> [--svg]`，`serve --out <dir> --port 0` 打开页面练习。
6. 学习者提交非空作答即持久保存，可跳过自评；随后进入[集中复核交接](#集中复核交接)。

## 入口二 整理已有材料（organize-existing-material）

目标：先交付可用产物，再让学习者自己的解释与作答产生证据。

1. 读材料 → 写模型 → `validate`；初始掌握度一律 `unknown`，材料完整度只说明内容覆盖。
2. `build <模型源.json> --out <dir>` 先生成初始产物；质检命令缺省读 `<dir>/model.json`，目录里还没有它时 `quality-template` 会报 `E_IO`。源模型不在该目录而想先取骨架时，改为给质检命令显式传 `--model <模型源.json>`。
3. `quality-template --out <dir> --to <dir>/quality-draft.json`，按实际阅读与核对填写六类检查（见[内容质检](content-quality.md)）。`--to` 必须指向还不存在的新草稿路径，已存在会被拒绝。
4. `quality-validate` 通过后 `quality-write`，再 `build <dir>/model.json --out <dir>`（`quality-write` 不重建页面）；页面显示可用部分、需补充部分与仍未解决的缺口。
5. 需要本轮路线时 `round --action create --entry organize-existing-material --goal <成果> --concept <ID> [--minutes N]`，让学习者在产物里解释、提问、练习。
6. 作答同样用 `submit` 持久保存，再进入[集中复核交接](#集中复核交接)。

## 入口三 恢复已有学习（resume）

目标：接着上次的目标、暂停位置与到期项继续，不重复初始化。

1. 先 `resume-read --out <dir> [--round-id <ID>]` 一次读回恢复所需的全部适用信息：学习身份、画像、目标与预算、当前位置、实际互动计数、真实原答（含协助属性）、当前缺口、材料核对范围、纠错历史，以及保存值与当前值的差异（`changes`）。旧档缺少的字段如实标未知；独立页未导出的本机缓存不在档案内，不得宣称已读。需要细节再分别读 `round-read`、`due`、`review-read --round-id <ID>`、`correction-read`、`quality-read`。
2. 向学习者简短展示当前位置、下一步和剩余范围；画像与已适用的诊断不重复问卷、不重复作答，只补缺失且影响教学的关键信息。`changes` 列出的每项差异（目标变化、内容或材料更新导致的失效证据与旧作答、材料地图过期）逐项向学习者说明：历史保留，不沿用失效结论；按当前目标用 `round --action update` 调整路线或重新核对材料后再继续。
3. 已有轮次用 `round --action resume --round-id <ID>` 续接同一身份（`resume` 只是动作，不是可创建的入口）。目录里有记录但没有可续接轮次时，用 `round --action create --entry organize-existing-material ...` 开始新路线（省略 `--entry` 就是该默认入口）；未记录轮次的历史作答保持未知归属，不静默并入新轮次。
4. 处理顺序：到期复习 → 仍有缺口的前置概念 → 新内容；前置按模型的 `prerequisite` 关系与概念证据判断。已保存且仍适用的设置不重复提问。
5. 补齐本轮后按[集中复核交接](#集中复核交接)复核与重建；结束时 `round --action pause` 或直接保存，下次仍走同一入口。

## 集中复核交接

学习者请求检查本轮作答时，按[集中复核](tutor-review.md)执行范围确认、冻结集合、逐项反馈、读回和重建；无轮次历史也由该参考规定。复核结束后回到原轮次，向学习者交付新版页面与实际剩余量。

## 独立缓存交接

独立页面模式按[独立文件交接](portable-handoff.md)的顺序执行：页面导出档案 → 学习者把可读文件交给会话 → 核对 `modelId`、内容版本与导师字段来源 → `import` 归入对应目录 → 集中复核 → `build` → 学习者重开新版页面获取反馈。缓存未导出前，会话不宣称已读取其中答案；导入的导师字段在会话侧核对前不作为调度或掌握依据。

## 失败恢复

档案、缓存、版本或产物交接失败时，按[档案与产物恢复](archive-recovery.md)保留输入并处理。恢复规则由该参考唯一维护。

## 参考路由

| 需要 | 读 |
| --- | --- |
| 模型 schema、`build` 输出、学习页交互 | [学习产物](artifacts.md) |
| 轮次、诊断、预算、暂停续接 | [本轮路线与续接](learning-rounds.md) |
| 六类质检、补充与缺口 | [内容质检](content-quality.md) |
| 集中复核操作 | [集中复核](tutor-review.md) |
| 证据分级、调度与到期检查 | [证据与复习](evidence-and-review.md) |
| 独立页面导出、导入与重建 | [独立文件交接](portable-handoff.md) |
| 第二阶段递进练习、三类组件、洞见、预算复习与恢复 | [第二阶段完整旅程](phase-two-delivery.md) |
