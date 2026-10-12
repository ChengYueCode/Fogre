# Forge 技能结构与维护约定

主技能名、调用名与安装目录名均为 `forge`；独立能力使用唯一的 `forge-*` 名称。旧安装目录 `ember` 中的 `name: forge` 应迁移到同一宿主技能根目录的 `forge`，保留旧文件在技能根目录之外，避免宿主发现两个相同身份。仓库目录名不决定技能身份。

## 编排与能力

- `skill/forge/SKILL.md` 选择本次范围、组织学习轮次、保存与续接任务；进入能力时读取自己的参考，无需依赖兄弟技能安装。
- `skill/forge/references/` 是能力规则的唯一正文，包含提问、材料核对、产物、复核、复习、洞见，以及共享交接约定。
- 五个单项目录由 `scripts/build-entries.mjs` 生成：`forge-question`、`forge-organize`、`forge-review`、`forge-review-plan`、`forge-insights`。入口保留触发、范围、示例和先读文件；详细规则按当前分支读取。

安装主技能即可用自然语言选择单项能力。单项入口也可独立安装；参考链接的递归依赖随包复制，保留本地链接与章节锚点，不把必要规则降为无目标的文字提示。随附参考用于当前能力与交接，不授权展开其他能力。参考图有回环，所以各入口可能携带较多参考；随包携带不等于每次全部加载。

`forge-question` 的独立模式只使用真实会话输入，不携带运行程序、不创建档案；解释、帮助、停止与缺依据的处理均在其先读规则内。需要持久保存或进入完整教学时说明范围变化，再使用可用的完整入口。其余入口携带 CLI 和页面资产，以支持本能力中的档案读写及复核后重建。

## 维护与验证

修改 `skill/forge/references/` 或主入口；单项入口的名称、触发和先读映射在生成器内维护。生成目录不手改。运行：

```sh
node scripts/build-entries.mjs
node scripts/build-entries.mjs --check
node scripts/check-links.mjs
node --test tests/entries.test.mjs
npm run test:distribution
```

`--check` 在临时目录生成比较结果，发现过期时返回失败，保留现有文件供检查。验证须包含单独安装后的参考可读，以及 CLI 所需资产是否可用；链接存在不证明教学行为已通过真实使用验收。

保留既有缓存键、锁协议、`customData.ember` 与历史迁移标识，它们是持久数据兼容约定。主入口和单项入口保持已有自动发现策略；分层不要求改变调用权限。源码验证、个人技能安装、当前会话发现和公开发布分别记录。
