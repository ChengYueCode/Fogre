# 来源与第三方内容

本文件区分机制参考、协议参考与随包内容。引用来源不等于拥有复制其代码、图片或文案的授权。项目采用 MIT 许可证，其范围仅覆盖维护者有权许可的项目内容；版权署名为 ChengYueCode。

## 内容类别

| 内容 | 位置 | 当前依据与边界 |
| --- | --- | --- |
| 学习机制与灵感来源 | `skill/forge/references/sources.md` | 保留原始链接、适用范围与限制；项目文档称其为机制抽象和灵感，未把上游整体随包分发 |
| Excalidraw 协议参考 | 同上及 `references/excalidraw-mcp.md` | 记录固定上游版本与 commit；本地工具使用自己的场景生成逻辑，不随包提供 Excalidraw 编辑器或 MCP 服务 |
| 工具教学夹具 | `skill/forge/assets/probability.json`、`tests/fixtures/` | 工具与测试仍保留教学假设和机制出处；不作为本次公开学习案例，也不是真人作答或效果证据 |
| 页面、图形生成与 Node 工具 | `skill/forge/assets/viewer.html`、`skill/forge/scripts/` | 当前项目实现；没有声明运行时 npm 第三方依赖 |
| 展示图与生成示例 | `docs/assets/forge-preview.jpg`、`docs/assets/cases/`、`examples/` 中的公开案例 | 实际浏览器截图，来源与哈希见图片清单；自编材料与合成工具输入明确标注，不是真人学习成果 |
| Forge 品牌展示图 | `docs/assets/showcase/` | 内置 image_gen 根据实际图片与当前技能定位生成的视觉合成及重绘；三张图均标注 AI 展示合成，不作为未修改截图或真人学习效果证据；提示词、参考图片和文件哈希随包提供，见展示图清单 |
| mattpocock/skills 学习材料 | `examples/mattpocock-skills/` | 来源固定为 49dd158d1076134a641b33efb035946536778336；中文说明与教学题由本项目编写，来源路径/行范围/哈希随包提供，上游 MIT 版权与许可保留在 UPSTREAM-LICENSE.txt；不冒充上游官方教程 |
| 独立编辑器截图 | `docs/assets/cases/mp-editor.png` | 在 Excalidraw 网页编辑器加载新主题原生工程路线文件并选中元素；编辑器是独立产品，截图不表示 Forge 携带编辑器或已验证实时 MCP |

## 首发核对

公开前由维护者确认项目代码、技能说明和展示素材的权属；如发现复制的第三方片段，逐项保留原许可证、版权及必要 NOTICE，或从首发内容中移除。当前来源说明和本次文件检查不能替代完整的版权溯源。

机制出处见[来源说明](skill/forge/references/sources.md)。运行时仅使用 Node.js 内置模块；用户选择的模型、安装工具、浏览器与远程编辑器属于独立产品，其使用条件由各自提供方决定。
