# 来源与第三方内容

本文件区分机制参考、协议参考与随包内容。引用来源不等于拥有复制其代码、图片或文案的授权。项目采用 MIT 许可证，其范围仅覆盖维护者有权许可的项目内容；版权署名为 ChengYueCode。

## 内容类别

| 内容 | 位置 | 当前依据与边界 |
| --- | --- | --- |
| 学习机制与灵感来源 | `skill/forge/references/sources.md` | 保留原始链接、适用范围与限制；项目文档称其为机制抽象和灵感，未把上游整体随包分发 |
| Excalidraw 协议参考 | 同上及 `references/excalidraw-mcp.md` | 记录固定上游版本与 commit；本地工具使用自己的场景生成逻辑，不随包提供 Excalidraw 编辑器或 MCP 服务 |
| 概率与其他教学样例 | `skill/forge/assets/probability.json`、`tests/fixtures/` | 教学假设与机制出处随内容记录；不是真人作答或学习效果证据 |
| 页面、图形生成与 Node 工具 | `skill/forge/assets/viewer.html`、`skill/forge/scripts/` | 当前项目实现；没有声明运行时 npm 第三方依赖 |
| 展示图与生成示例 | `docs/assets/forge-preview.jpg`、`examples/probability/` | 展示项目生成的学习产物；维护者须确认截图、素材和文案的发布权属 |

## 首发核对

公开前由维护者确认项目代码、技能说明和展示素材的权属；如发现复制的第三方片段，逐项保留原许可证、版权及必要 NOTICE，或从首发内容中移除。当前来源说明和本次文件检查不能替代完整的版权溯源。

机制出处见[来源说明](skill/forge/references/sources.md)。运行时仅使用 Node.js 内置模块；用户选择的模型、安装工具、浏览器与远程编辑器属于独立产品，其使用条件由各自提供方决定。
