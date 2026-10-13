# GitHub 首发检查

此流程生成可复查的本地候选产物。公开上传、GitHub Release、npm 发布和个人技能升级分别记录。

## 1. 身份与权属

- 维护者确定 GitHub 账号、仓库名、版权署名和许可证；加入实际 `LICENSE`，对齐 `package.json` 的 license。
- 按[第三方说明](../THIRD_PARTY.md)核对代码、文案、教学素材和展示图的发布权属；需要时保留上游许可与 NOTICE。
- GitHub 技能分发可以保留 `private: true`，它只限制 npm publish。正式 npm 包名不阻塞 GitHub 技能分发。
- 公开地址确定后更新 README、安装指南和 GitHub 介绍中的账号、仓库及分支占位符，并补 repository/bugs/homepage。

## 2. 本地验证

```sh
node scripts/build-entries.mjs --check
npm run check:links
npm test
npm run prepare:release -- --out dist/release-candidate
npm run verify:release -- --verify dist/release-candidate
```

使用一个尚不存在的输出目录。发布工具只复制白名单中的源码与文档，排除内部历史、个人学习档案、调试日志和旧备份。输出包含干净源码目录、源码 ZIP、主技能 ZIP 和哈希清单；具体文件名以工具输出为准。哈希校验通过后，检查包内清单和首发文案。

全量测试包含真实 npm pack 和临时安装；没有运行时第三方依赖，无需为运行测试执行 npm ci。未提供真实历史工具 `EMBER_OLD_TOOL` 时，旧工具拒绝新档案的一项测试跳过，记录此边界。全量失败与单项复跑结果分开保留。

## 3. 公开前审查

- 在干净源码目录检查全部 Markdown 相对链接、六个技能身份、许可证、机器路径和匿名示例。
- 阅读白名单与哈希清单；`.gitignore` 不代替发布内容审查，npm 的 files 白名单也不代替 GitHub 源码筛选。
- 仅使用当前快照生成的 ZIP；旧清单与旧 ZIP 保留为本地历史，不能冒充首发产物。
- CI 只做验证，不自动公开、不写用户个人技能目录。

## 4. 获得上传授权后

1. 创建或核对真实仓库，把经过验证的公开内容纳入 Git，不上传整个原工作区历史。
2. 推送后记录 commit；核对 GitHub 文件、许可证、安装文案及对应 CI 结果。
3. 从远程仓库隔离安装，分别测试仓库级发现和明确的 `skill/forge` 路径，核对文件及运行工具。
4. 在目标宿主确认技能发现与真实 `/forge` 调用；按实际请求生成产物，验证保存和重新打开，不虚构学习者表现。
5. 需要 GitHub Release 时，明确版本和授权，上传与该 commit 对应的 ZIP/清单并下载读回。可选 npm 发布另行决定。

## 本次交付状态

2026-10-13 更新内容：Forge 的最新定位与六个技能描述、面向普通学习者的说明、mattpocock/skills 全套案例、20 张实际图片及三张 AI 展示图。学习流程人物按用户提供的形象替换，来源、提示词与原始上传不分发的边界随源码说明。当前上传授权已覆盖这次 GitHub 项目更新；实际提交及 CI 以仓库 main 和 Actions 对应记录为准。未创建新版本标签、GitHub Release 或 npm 发布，也未升级个人安装。

2026-10-12：仓库 [ChengYueCode/Fogre](https://github.com/ChengYueCode/Fogre) 已公开上传，使用 MIT 许可证与 ChengYueCode 版权署名。已整理公开文档、排除规则、CI 与反馈模板，并提供经过测试的干净发布快照/ZIP/清单工具。远程主技能安装和随包工具 smoke 已完成，完整宿主学习调用仍未验收。CI 状态以仓库 Actions 的对应 commit 为准；本地检查见[验收说明](skill-acceptance.md)。未发布 npm、未改动用户个人技能安装。
