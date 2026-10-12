# 开源准备与发布说明

Forge 以 GitHub 技能目录分发，主入口为 `skill/forge/`；不要求先发布自己的 npm 包。当前本地 npm 准备身份为 `forge-learning-local@0.1.0`，保留 `private: true`，许可证为 MIT，版权署名为 ChengYueCode；仓库为 [ChengYueCode/Fogre](https://github.com/ChengYueCode/Fogre)。npm registry 发布仍是独立流程。

## 公开内容

使用 `scripts/prepare-release.mjs` 的显式白名单生成公开快照。它包含完整六个技能目录、工具、测试、用户与维护文档、匿名教学示例和 CI；排除内部 `.scratch/`、本机意图/研究记录、个人学习档案、调试日志、旧 ZIP 与过时备份。内部原件保留在本地。

公开源码、npm 包与主技能 ZIP 是不同交付物。npm 的 files 白名单不代替 GitHub 内容筛选；主技能安装必须包含完整 references、scripts 和 assets，而不只是 SKILL.md。

## 本地准备

```sh
node scripts/build-entries.mjs --check
npm run check:links
npm test
npm run prepare:release -- --out dist/release-candidate
npm run verify:release -- --verify dist/release-candidate
```

输出目录必须尚不存在。结果为 `source/`、`source.zip`、`forge-skill.zip` 和 `manifest.json`；验证同时检查哈希、完整文件集合以及 ZIP 与源码字节对应。已有 LICENSE/NOTICE 会附入主技能 ZIP；冲突时拒绝生成。检查清单、文件哈希及候选包内容后再考虑上传。当前旧 dist 清单保留为历史，不作为首发交付。CI 只做验证，没有自动发布步骤。

## 身份与公开验证

1. 本次确认 GitHub 账号为 ChengYueCode、仓库名为 Fogre，使用 MIT 与 ChengYueCode 署名。LICENSE 随每个技能独立分发；来源说明不代替授权核对。
2. README、安装指南和项目介绍使用实际仓库地址。仅 GitHub 分发无需移除 private；正式 npm 身份和 registry 权限另行决定。
3. 明确公开上传授权，再将验证后的公开内容推送并读回对应 commit、CI 与远程安装结果。真实宿主发现和调用单独验收。

来源与资产分类见[第三方说明](../THIRD_PARTY.md)，完整操作与验收门槛见[首发检查](release-checklist.md)，本地证据见[验收说明](skill-acceptance.md)。

## 可选 npm CLI

当前没有 npm publish。若以后需要：确定正式包名/scope、账号权限与版本；核对 LICENSE 和 repository/bugs/homepage；更新分发测试的包身份并执行真实 tgz 安装。维护者明确授权后才移除 private 并发布，随后读取 registry 版本与包完整性。

## 用户介绍

forge · 锻造，供 AI Agent 调用的中文学习技能。核对材料、组织知识，先自己解释与作答，再获得针对缺口的提问、讲解或反馈；按需生成交互学习页和可编辑思维导图，保留原答、修正与复习记录。支持完整学习与单项能力，可从本地索引查找已登记主题，读回目标、暂停位置与缺口后继续学习。

档案保存在学习者自己的目录；模型会话的数据处理由宿主决定。项目不提供云同步、自动跨主题复习总计划或学习效果保证。公开介绍见[GitHub 介绍](github-introduction.md)。
