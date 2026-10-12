# 既有学习产物的重建

复核、导入或内容更新后重建已有学习目录时读取。使用本技能自带工具与既有模型，不需要另装主技能；重建不启动现场教学。

```bash
node <skill-dir>/scripts/forge.mjs build <dir>/model.json --out <dir> [--svg]
```

交付前读回返回路径，核对原答与新增反馈仍在同一档案中；本地服务页面刷新，独立页面重新打开新版 HTML。构建失败时按[档案与产物恢复](archive-recovery.md)保留原文件及输入，不宣称新版已交付。

## 输出与幂等性

`build` 每次写出：

- `index.html`：所有 CSS、JS、模型数据和当前状态都内联，可离线双击打开，无网络依赖。
- `model.json`：规范化的模型副本，默认写到 `--out` 目录；如果输入模型与输出路径相同（例如对已生成的 `model.json` 再构建），它会原地重写，所以不要把它当作不可变原件。
- `state.json`：当前状态；默认读取已存在的 state.json，按稳定 ID 协调模型变化并保留学习者修订与真实作答。
- `map.excalidraw`：真实 Excalidraw v2 场景，可用编辑器打开继续编辑。传 `--scene <文件>`
  时，`<文件>` 既是读入的已有场景，也是构建后写回的场景路径；构建不会自动把该文件复制或
  另写为 `<out>/map.excalidraw`。要让标准路径更新，先把原生编辑器下载的场景复制或另存为
  `<out>/map.excalidraw`，再省略 `--scene` 或用 `--scene <out>/map.excalidraw`。
- `map.svg`：仅在传 `--svg` 时生成，供快速查看或嵌入。

`quality.json` 与上面这些产物分开：它是作者侧的内容质检记录，由 `quality-write` 写入，`build` 只读取并把质检视图放进学习页载荷，永远不会改写它。质检不进入学习者档案，不改变掌握度。因为 `quality-write` 不重建页面，写入质检后要重跑 `build <out>/model.json --out <out>` 并刷新或重新打开新版页面，学习页才会显示质检结论；重建按稳定 ID 续接并保留已有学习档案与导图编辑。

Excalidraw 场景和页面图谱是两层产物：场景通过稳定的 `customData.ember.conceptId` /
`relationId` 与模型、题目互相定位，具体位置、绑定和图形文字编辑保留在场景里；学习页的
概念标题、解释和关系语义仍以 `model.json` 与 `state.json` 的当前内容为准。只改原生图形
文字不会自动回写这些语义字段；需要同步页面标题或关系名称时，要更新模型或页面内的标题
修订后重新构建。

重复 `build` 不会新增任何 attempt；`state.json` 只在模型语义变化或出现冲突时推进 revision，没有变化的构建保持稳定，所以重建页面可以随时做。若已有 `state.json` 属于另一个 `modelId`，`build` 会停止并要求显式处理，而不是把两份学习记录混在一起。

`build` 会打印一行 JSON 摘要（`html`、`model`、`state`、`scene`、`svg`、`warnings`），把 `warnings` 如实转述给学习者。

