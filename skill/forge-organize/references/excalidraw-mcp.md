<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# Excalidraw MCP（可选增强）

只有当宿主**确实**提供了 Excalidraw MCP 工具时才读这份参考。不要假设工具已连接；没有工具时 `build` 生成的 `map.excalidraw` 就是交付物。

协议参考的版本与来源见 [sources.md](sources.md)；这里描述的工具行为来自对该固定版本的只读核对，不保证宿主实际暴露的 schema 与此完全一致，也不保证它始终可用。

## 1. 先探测，再使用

先看当前可用的工具列表里是否有 `read_me` 与 `create_view`。两者都没有就停在文件产物，并告诉学习者"当前宿主没有 Excalidraw MCP，已生成可编辑的 `map.excalidraw`"。不要说"已在内置画布打开"。

工具可用时，按工具自己声明的协议走：

0. 如果宿主暴露的 schema 与参考版本明显不一致（缺少 `create_view`、参数改名或类型不同），暂停并告知学习者，不要靠猜参数调用。
1. 先调用 `read_me`（每个会话一次），读它的元素格式说明与调色板。
2. 再调用 `create_view`，`elements` 参数是**JSON 数组字符串**，不是对象。
3. 工具返回 `checkpointId`；**每个会话只调一次 `read_me`**，重复调用不会得到新内容。不传 `restoreCheckpoint` 的 `create_view` 会开一块全新画布；分批发送时，每个后续 chunk 都必须以最新 `checkpointId` 的 `restoreCheckpoint` 开头，否则前面发送的内容不会被保留。

相关工具的实际行为（这些来自本地只读核对，具体参数以宿主暴露的 schema 为准）：

- `read_me`：只读，返回元素格式速查。
- `create_view(elements)`：逐个元素流式绘制，并保存 checkpoint。可用的伪元素：`cameraUpdate`（控制视口，不绘制，建议 4:3）、`delete`（按逗号分隔的 id 删除）、`restoreCheckpoint`（以已有 checkpoint 为基础继续）。
- 续接用户编辑：```[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...新增元素]```；要先看模型上下文里的编辑摘要（宿主会回传"User edited diagram … Added/Removed/Moved"），据此决定是续接还是重画。
- 只有 `create_view` 的 `elements` 是模型输入；`save_checkpoint` / `read_checkpoint` / `export_to_excalidraw` 是 App 侧工具，不要主动调用。
- `export_to_excalidraw` 会把场景**上传到远程**并返回分享链接。默认不要上传；只有学习者明确要求分享时才考虑，并说明这是网络发布。

## 2. 从模型生成元素

- 布局与 ID 由 `scripts/forge.mjs build` 生成的 `map.excalidraw` 决定：概念节点 ID 为 `c-<conceptId>`，文字为 `t-<conceptId>`，边为 `e-<relationId>`，父边为 `e-parent-<conceptId>`。这两者视觉上必须不同（见下）。
- 复用该场景的元素数组即可保持一致；不要另起一套命名，否则 Excalidraw 里的用户编辑会与重建的节点对不上。
- 精简处理：`create_view` 有约 5 MB 的输入上限，元素很多时按分支分批发送，先发父节点与父边。

元素格式要点（`read_me` 是权威来源，这里只列容易出错的地方）：

- 形状可以带 `label` 自动居中，无需另画文字元素。
- 独立文字元素的 `x` 是左边缘；不要靠 `textAlign` 定位。
- 绑定箭头用 `startBinding` / `endBinding` 指向形状 id；形状的 `boundElements` 也要反过来列出指向它的箭头与绑定文字，否则真实编辑器拖动时会断链。难度徽标等附属元素用 `groupIds` 与节点成组，拖动节点时箭头、文字与徽标才会一起移动。
- 数组顺序即 z 序，先背景后图形。

## 3. 已知边界（不要夸大）

- 现有源码里**没有**内置思维导图布局或学习专用交互；层级、布局、展开/聚焦、练习面板都由 forge 自己负责。
- `cameraUpdate` 只能引导视角，不等于展开节点或学习路线。
- 编辑摘要回传的是增删与位移的简述，不是完整的语义 diff；语义是否变化仍需你判断。
- checkpoint 存储位于系统临时目录并有数量上限，Redis 实现带 30 天期限，都不能当永久学习档案。长期保存以 `map.excalidraw` 与 `state.json` 为准。
- 本项目对 `excalidraw-mcp` 的核对基于 commit `157aa23ceb1976008aadc89eb05e3444060f09d6`（版本 0.3.2，见 [sources.md](sources.md)）；其 `CLAUDE.md` 中对纯 SVG 的旧描述与当时源码不符，以源码为准，但不依赖该项目的实现细节。
- 实测记录（项目验收，经验性，非对所有平台的保证）：原生 Excalidraw 0.18 文件模式下，21 元素场景导入已安装编辑器、拖动节点后箭头/文字/难度徽标跟随、导出回读无缺失绑定、改变 goal 重建后位置保留且无冲突。这是文件/编辑器级证据。
- 实时 Excalidraw MCP 会话还没有可用/经过测试：当前宿主没有提供 Excalidraw MCP 工具，报告结果时如实说明；不要把文件级往返当成实时 MCP 已可用。

## 4. 与语义内容对齐

MCP 画布里的人工编辑与模型内容通过稳定 ID 对齐，但场景和语义档案是两层：

- 位置、样式、图形文字和新增的自由元素：属于场景编辑，重建时保留在 `map.excalidraw`。
- 元素通过 `customData.ember.kind`、`conceptId` 和 `relationId` 与概念、关系、题目定位；
  这些稳定 ID 是场景与语义档案之间的连接点。
- 画布上的节点文字、关系标签编辑不会自动写回 `model.json` 或 `state.json`。学习页图谱
  仍使用模型与档案中的当前标题、关系和层级；如果同一 ID 的生成语义与画布版本不同，
  `build` 保留场景版本并在输出中报告冲突，由你向学习者说明后再决定是否更新语义模型。
- 元素被删除：视为用户意图，`build` 不会把它加回来。

如果应用内浏览器或官方组件宿主的原生 File System Access picker 不产生 chooser，不要
把 `.excalidraw` JSON 改成手写文本来绕过。使用宿主官方组件提供的 `input[type=file]` /
download 回退完成打开、编辑和下载，再把下载文件交给 `build --scene`；该路径的读入与写回
规则见 [学习产物](artifacts.md) 和 [第二阶段完整旅程](phase-two-delivery.md)。
