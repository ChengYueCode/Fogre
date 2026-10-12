<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 机制来源与灵感边界

这份参考只在需要说明"某个机制从哪来、能支持什么、不能支持什么"时读。它把 forge 的机制来源、灵感来源和第三方协议来源分开列出。

## 1. 学习机制来源

- **解释检验（费曼机制）**：费曼本人 [What is Science?](https://feynman.com/science/what-is-science/) 的原始演讲主张用学习者自己的话解释，而不是复述术语。操作步骤参考 Kansas State University 的 [Feynman Technique 指南](https://www.k-state.edu/aac/success-tools/collection/feynman_technique.html)：学习、讲授、补漏、简化。现代四步版是大学学习中心的整理，不是费曼本人发布的固定流程，文档中不要把它写成费曼原始方法。
- **笔记到检索（Cornell 机制）**：Cornell University 学习中心 [Cornell Note-Taking System](https://lsc.cornell.edu/how-to-study/taking-notes/cornell-note-taking-system/) 把方法归于 Walter Pauk，包含记录、提问、遮住笔记自答、反思、复习；官方工作页见 [Cornell Note-Taking System worksheet](https://lsc.cornell.edu/wp-content/uploads/2015/10/Cornell-Note_Taking-System.pdf)。forge 只借用"由笔记生成可复用检索线索"这一机制，不复制三栏格式。
- **目标聚焦与组块（Simon/Chase）**：Simon 与 Chase 的一手论文 *Skill in Chess*（1973）讨论棋局模式识别与组块，约 5 万个棋局模式是特定任务的粗略估计；原文见 [CMU IIIF 存档 PDF](https://iiif.library.cmu.edu/file/Simon_box00066_fld05052_bdl0001_doc0001/Simon_box00066_fld05052_bdl0001_doc0001.pdf)。forge 只把"面向目标、聚焦相关知识并组块"抽象为通用学习流程；这是 forge 自己的跨领域抽象，不是 Simon 原始论文提出的通用配方。该来源不支持"任何学科六个月精通"一类普遍保证，forge 也不做这种承诺。
- **间隔复习**：forge 使用自己透明、确定性、可复现的间隔表，见 [evidence-and-review.md](evidence-and-review.md)。它不是 FSRS，也不引用未经核实的近似公式。

## 2. 五套灵感仓库

以下素材只作为思路灵感。forge 没有复制它们的目录结构、提示词或调度实现，也不引用它们证明学习效果：

1. `learn-anything` — [vesperchinn/learn-anything-skill](https://github.com/vesperchinn/learn-anything-skill)
2. `teach` — [mattpocock/skills](https://github.com/mattpocock/skills) 中的 teach
3. `agent-tutor-skill` — [Bhala-Srinivash/agent-tutor-skill](https://github.com/Bhala-Srinivash/agent-tutor-skill) @ `e273585b542d1d77b72c87eaa605d384ea4479f1`
4. `teacher-skill` — [chentao326/teacher-skill](https://github.com/chentao326/teacher-skill) @ `86056ac80f9e5f80c1e965a0de7e358ca54f4bdc`
5. `teach-yourself-skill` — [chokcoco/teach-yourself-skill](https://github.com/chokcoco/teach-yourself-skill) @ `484e77adc945e680b705762b947da3e1b3570a0b`

这些素材只作为灵感；项目侧的审计记录属于仓库维护信息，不随技能分发。

## 3. 第三方协议参考

- **Excalidraw MCP**：本地只读核对的项目是 `excalidraw/excalidraw-mcp`，版本 `0.3.2`，源码固定在上游 commit [`157aa23ceb1976008aadc89eb05e3444060f09d6`](https://github.com/excalidraw/excalidraw-mcp/tree/157aa23ceb1976008aadc89eb05e3444060f09d6)（MIT）。这里只把它的 `read_me` / `create_view` 输入协议当作协议参考，不依赖其具体实现，也不把它的 checkpoint 存储当永久学习档案。

## 4. 第二阶段教学样例来源

下面的来源只支持各自条目写明的机制与边界；学习页对应的 `sources`/`limitations` 仍是最终
声明。样例用于核对组件配置和文案，不证明特定学习效果。

- **HTTP 方法对照**：[RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) 的
  §9.2.1（安全方法）、§9.2.2（幂等方法）、§9.2.3（方法与缓存）、§9.3.1（GET）和
  §9.3.3（POST）。来源只支持方法语义：安全指用户意图没有写副作用，日志等附带作用仍可
  发生；幂等是方法语义，服务端可实现额外保护；POST 不因方法语义获得安全或幂等保证，
  GET 的内容和请求体也没有一条“只能 URL、绝不能有请求体”的通用规定。
- **集中趋势对照**：[OpenStax — Introductory Statistics](https://openstax.org/details/books/introductory-statistics)
  的描述性统计内容。中位数按排序位置取中间值，偶数样本取两个中间值的平均；它对极端值的
  幅度通常比均值更稳健，但新增、替换或删除数据点以及样本量变化仍可能改变中位数。
- **TCP 握手推演**：[RFC 9293 §3.4 — Sequence Numbers](https://www.rfc-editor.org/rfc/rfc9293#section-3.4)
  与 [§3.5 — Establishing a Connection](https://www.rfc-editor.org/rfc/rfc9293#section-3.5)。
  确认号是累积的：ACK=X 表示 X 之前的字节都已按序收到，期待的下一个字节序号是 X；SYN 占用
  一个序号，所以确认 SYN 时 ACK=ISN+1，这不是一般数据段的算法。成功路径是客户端发 SYN 后
  进入 SYN-SENT，收到 SYN+ACK 后回复 ACK 并进入 ESTABLISHED，服务器收到该 ACK 后也从
  SYN-RECEIVED 进入 ESTABLISHED。
- **贝叶斯筛查参数**：[Gigerenzer & Hoffrage (1995)](https://pure.mpg.de/pubman/item/item_2543495_7/component/file_2562163/GG_How_1995.pdf)
  只支持概率公式和同一个人群中的频数化解释，不是医学建议，也未建模重复检测相关性、金标准
  不完美或患病率估计误差。
- **速度参数**：[OpenStax College Physics 2e §2.3 — Time, Velocity, and Speed](https://openstax.org/books/college-physics-2e/pages/2-3-time-velocity-and-speed)
  支持“平均速率 = 总路程 ÷ 总历时”，该关系对非匀速运动同样成立，只在匀速直线运动里同时
  等于瞬时速率。[BIPM SI Brochure](https://www.bipm.org/en/publications/si-brochure)
  只支持单位与允许并用单位，不支持速率数学定义。
- **二分查找推演**：CLRS《Introduction to Algorithms》的二分查找与循环不变式内容；来源
  只支持有序数组、区间收缩与对数复杂度的基本解释。

## 5. 边界

- 来源只说明机制出处，不构成学习效果保证；学习效果尚未被证明。
- 回环浏览器操作与原生 Excalidraw 0.18 文件往返已在项目验收中核对：21 元素场景导入编辑器，拖动节点后箭头/文字/难度徽标跟随，导出回读无缺失绑定，改变 goal 重建后位置保留且无冲突。
- 实时 MCP 不可用，未做测试。
- 直接 file:// UI 受应用内浏览器策略限制，未做测试。
- 其他平台未穷尽测试。
