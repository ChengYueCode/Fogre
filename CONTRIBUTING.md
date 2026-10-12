# 贡献指南

项目采用 [MIT 许可证](LICENSE)，版权署名为 ChengYueCode。公开仓库为 [ChengYueCode/Fogre](https://github.com/ChengYueCode/Fogre)；本文件说明复现、维护与交付验证。

## 目录与开发

- `skill/forge/` 是完整可移植技能，包含入口、参考、模板和 Node 工具。
- `bin/forge.mjs` 是 npm 命令入口；`scripts/install-skill.mjs` 只负责显式技能复制与升级。
- `tests/` 覆盖学习行为、持久档案和 npm 分发。
- `docs/` 是使用、机制与维护材料；内部历史记录保留在本地，公开源快照按发布工具白名单筛选。

以下开发命令必须在完整源码检出目录运行；npm 安装包不包含 tests，不能用安装包里的测试命令作为验证结果。使用 Node.js ≥20 和 npm，无需安装运行时依赖：

```sh
npm test
npm run test:distribution
npm run check:package
node scripts/build-entries.mjs --check
npm run check:links
npm run prepare:release -- --out dist/release-candidate
npm run verify:release -- --verify dist/release-candidate
```

分发测试会在系统临时目录真实 pack、安装到临时 prefix、执行 npm 生成的命令入口并生成学习产物，不更改实际全局安装。旧工具拒绝新档案的测试需要 `EMBER_OLD_TOOL` 指向真实历史工具；未提供时该项会跳过，应报告跳过，不能将结果称为零跳过验收。当前旧档案迁移测试仍正常执行，合成旧工具不能代替真实历史版本。

CI 配置覆盖 Windows/Linux、Node 20/24；远程结果以对应 commit 的 Actions 记录为准。准备脚本拒绝已有输出目录，生成新的候选快照及 ZIP，不升级个人安装、不上传、不发布 npm。首发流程见[发布检查](docs/release-checklist.md)。

技能说明更改后运行 skill-creator 的 `quick_validate.py`（若开发环境提供；中文 Windows 使用 `python -X utf8 <validator路径> skill/forge`），并核对技能目录内所有相对引用。不要把个人技能目录、平台依赖路径或本机用户名写入公开安装命令。

## 行为与兼容

学新主题必须等待真实诊断回答；整理材料可先交付；只要产物不生成伪造学习证据。原始作答和协助事实不可改写；修正、导师反馈、自评与掌握结论分别保留。页面与会话保存必须保留合法新增记录。

旧 `ember` 字样部分属于持久化契约：缓存键、`customData.ember`、锁协议与历史迁移标识。不要为统一品牌机械替换。修改内容后保持稳定 ID，保留过时与孤立历史。

## 反馈与验证

问题报告包含 Node/npm 与系统版本、复现命令、预期和实际结果、保存方式。可提供匿名最小模型或临时档案，不提交个人答案、凭据或绝对用户路径。

有用户行为变化时说明触发路径、前后结果和验证。区分源码测试、真实 CLI/HTTP 回读、浏览器关闭重开、原生编辑器和实际发布；任何一层通过都不代表其他层完成。提交前检查 npm 实际包清单，避免泄漏个人档案或内部运行记录。
