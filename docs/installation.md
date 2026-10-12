# 从 GitHub 安装技能、升级与可选 CLI 使用

Forge 的日常入口是在 Agent 会话中调用技能。完整技能自带参考、脚本与资源，Agent 可以直接调用安装目录中的工具，无需用户先安装全局 CLI。工具执行需要 Node.js ≥20；没有运行时第三方依赖。npm 分发当前已在 Windows 验证，其他系统与宿主的支持范围以实际测试为准。

## 优先：从 GitHub 安装技能

Forge 以 GitHub 技能目录分发即可，不要求先发布自己的 npm 包。仓库地址为 https://github.com/ChengYueCode/Fogre，采用 MIT 许可证，主分支为 main。

```sh
npx skills@latest add ChengYueCode/Fogre --skill forge
```

按提示选择目标 Agent 与范围，默认当前项目；增加 `--global` 可安装到用户级。明确指定 Codex 的例子：

```sh
npx skills@latest add ChengYueCode/Fogre --skill forge --agent codex --global
```

主技能的仓库路径为 `skill/forge/`；直接指定目录可避免误选其他位置的历史副本：

```sh
npx skills@latest add https://github.com/ChengYueCode/Fogre/tree/main/skill/forge --skill forge
```

运行 npx 需要 Node.js/npm 与网络。安装规则、范围与支持的 Agent 以 [Skills 官方文档](https://github.com/vercel-labs/skills#install-a-skill) 为准；不能把工具支持某个 Agent 当作 Forge 已在该宿主完成学习验收。

也可以让 AI 按 [README 的安装提示词](../README.md#开始使用) 读取仓库并安装。优先使用 Skills；不可用时使用当前宿主支持的 GitHub 技能安装方式，选取完整 `skill/forge/` 目录。已有同名技能时检查实际目录和版本，不能盲目覆盖或另建副本。

宿主的加载与刷新方式以其实际要求为准。安装关键文件完整、工具环境可用、宿主能发现并实际调用是分别核对的步骤。完整功能仍需文件读写和命令权限；只复制 SKILL.md 不构成完整技能安装。

### 发布前本地试装与验证边界

在源码根目录，可以只扫描真实技能集合或直接安装主技能：

```sh
npx skills@latest add ./skill --list
npx skills@latest add ./skill/forge --skill forge
```

2026-10-11 使用 Skills 1.7.2，在隔离的干净发布目录发现主技能及五个单项入口，并在临时项目以 `--agent codex --copy --yes` 安装主技能。完整文件与工具执行另行核对；这不是 GitHub 下载或真实宿主运行时调用的证据。

当前工作区包含 `.scratch/` 历史技能副本。对整个工作区根目录扫描已实测发现多余技能并选中旧版 Forge 描述；发布时须排除内部历史文件，或用明确技能路径安装。不要把当前工作区原样作为公开仓库。

## 备用：使用源码自带安装器

取得源码后，在项目根目录执行。使用默认用户级 Codex 技能目录的 Windows PowerShell 示例：

```powershell
node ./bin/forge.mjs install-skill --target "$env:USERPROFILE/.codex/skills/forge"
```

该入口直接使用源码包的安装器，无需 `npm pack` 或全局 npm 安装。它复制完整技能目录，不自动配置宿主或安装 Node.js。`--target` 指向宿主技能根目录的直接子目录；其他宿主或自定义配置请换成实际加载位置。

按宿主要求加载并确认发现技能后，在会话中输入：

场景：你能读简单代码，希望用真实练习检验二分查找的边界判断。

```text
$forge 带我学习二分查找，目标是独立解释循环不变式，并判断边界是否正确。
```

Agent 根据请求核对材料、教学并按需生成产物、保存记录和打开学习页；用户不需要先手动运行构建或服务命令。完整行为需要宿主提供文件读写和命令执行能力，权限或环境不足时按实际阻塞说明。

也可以将完整 `skill/forge/` 目录按宿主的本地技能导入方式安装，不能只复制 `SKILL.md`。已有安装先核对原目录，再用同一个源码安装入口加 `--upgrade`；不要为升级另建同身份副本。

使用源码自带安装器安装独立入口同样无需全局 CLI，例如：

```powershell
node ./bin/forge.mjs install-skill --target "$env:USERPROFILE/.codex/skills/forge-question" --skill forge-question
```

通过主技能 `$forge` 也能选择单项能力，不必安装所有独立入口。宿主确认发现后才使用对应调用名。GitHub 分发后的入口安装可用 `npx skills@latest add ChengYueCode/Fogre --skill forge-question`。

## 可选：安装本地 CLI 包

以下方式面向希望手动调用命令、维护档案或验证工具的用户，不是日常在 Agent 中使用技能的前置步骤。示例中的 `forge install-skill` 也可以替换为项目根目录的 `node ./bin/forge.mjs install-skill`。

当前正式包名和 registry 发布地址待定。先从源码运行 `npm pack` 得到 tgz；以下版本对应当前本地准备包：

```sh
npm install -g ./forge-learning-local-0.1.0.tgz
forge help
```

Windows PowerShell 下，使用用户级 `.codex/skills` 根目录的 Codex 宿主示例：

```powershell
forge install-skill --target "$env:USERPROFILE/.codex/skills/forge"
```

`$env:USERPROFILE` 展开为当前用户目录；若配置了自定义根目录，替换为配置值。

`--target` 可以是绝对路径或相对当前工作目录的路径，必须指向宿主技能根目录的直接子目录（如 `.codex/skills/forge`），不是整个技能根目录。不要使用 vendor/forge 等多层嵌套布局，以免递归扫描器发现暂存或备份。安装器不会猜测宿主。上面的用户目录示例展开后是绝对路径；使用相对路径时以当前工作目录为基准，仍需核对目标是宿主实际加载的位置。通过源码入口直接运行时，目标必须在当前源码包目录之外。将生成目录交给你的 AI 宿主加载，宿主若支持 `$forge` 可按此名称调用。

## 单项入口与安装检查

主技能的技能名、调用名与安装目录名统一为 `forge`。旧目录 `ember` 若暴露 `name: forge`，迁移时先确认目标 `forge` 不存在，将旧件移到技能根目录之外备份，再安装至 `forge`；不要保留两个暴露相同身份的安装目录。运行时历史缓存和档案标识仍按兼容合同保留，详见[技能架构](skill-architecture.md)。

单项入口先读规则及其引用的参考均随包提供，按当前分支读取，不要求另装主技能；需要 CLI 的入口同时携带页面资产，支持复核或导入后的重建。

除主技能外，包内还带五个由 `skill/forge/references/` 唯一正文生成的单项入口：`forge-question`（只用提问检查解释/推理）、`forge-review`（集中复核作答）、`forge-review-plan`（预算内复习安排）、`forge-insights`（洞见与速查汇总）、`forge-organize`（只整理材料生成学习产物）。每个入口都是独立技能目录，自包含先读能力规则、随附参考与（多数情况下的）CLI 和资产副本，单独安装即可被宿主独立发现：

```powershell
forge install-skill --target "$env:USERPROFILE/.codex/skills/forge-question" --skill forge-question
forge install-skill --target "$env:USERPROFILE/.codex/skills/forge-review" --skill forge-review
```

省略 `--skill` 时安装主技能 forge。升级校验按目标目录内 `SKILL.md` 的 `name:` 与 `.forge-install.json` 记录的身份进行：主技能与各入口是彼此独立的技能身份，不能互相覆盖。每个安装件都会写入 `.forge-install.json`（所装技能与包版本）；同一宿主根目录下若存在其他 forge 系安装件的版本与本次不同，或另一目录已暴露相同技能身份（例如改名前遗留的旧目录），安装器会在返回 JSON 的 `versionMismatches` / `identityCollisions` 中如实报告——安装本身成功，但混合版本不会被静默处理，请按报告对齐或清理。生成入口不是权威版本：修改规则只能改 `skill/forge/references/`（或主技能 `SKILL.md`），再运行 `node scripts/build-entries.mjs` 重新生成。

安装技能后，无需源码仓库就能运行随包示例：

场景：你想手动打开随包概率教学示例，体验页面和自动存档；它不是已有学习成果。

```powershell
forge build "$env:USERPROFILE/.codex/skills/forge/assets/probability.json" --out ./learning/probability --svg
forge library register --topic probability --out ./learning/probability
forge serve --out ./learning/probability --port 0
```

示例打开后，在已加载技能的会话中输入 `$forge 接着 learning/probability 里的档案学习，先查看当前任务。`；没有创建学习轮次时，Agent 如实说明并按你的目标开始学习。使用自己的材料或目标时，参考[场景与使用示例](../skill/forge/references/usage-examples.md)。路径相对会话工作目录解析，跨目录会话提供可读目录或索引。两种保存方式见本文[保存与反馈交接](#保存与反馈交接)。

项目本地安装：

```sh
npm install ./forge-learning-local-0.1.0.tgz
npm exec -- forge help
```

临时使用本地 tgz（将路径替换为真实绝对路径）：

```sh
npm exec --package /absolute/path/forge-learning-local-0.1.0.tgz -- forge help
```

正式发布后可用 `npm install -g <正式包名>` 或 `npx --package <正式包名> forge ...`；尖括号为待填参数，当前不能复制为有效的 registry 安装命令。此临时包名不代表注册名可用或已归项目所有。

## 升级技能

通过 Skills 安装的技能按其记录与官方更新方式维护，例如 `npx skills@latest update forge`；当前只有本地安装验证，尚未验收本项目的 GitHub 远程更新。不要与下面的源码/npm 自带安装器混用并假定两者的备份、版本记录相同。

以下说明适用于源码或 npm 自带安装器维护的技能：

更新 CLI 不会自动更新宿主里复制的技能。安装器默认拒绝已有目标；显式升级：

```powershell
forge install-skill --target "$env:USERPROFILE/.codex/skills/forge" --upgrade
```

目标必须含普通 `SKILL.md` 且其技能名与本次安装的身份一致（主技能与各入口彼此独立）。旧目录完整保存在技能根目录外的 `.forge-install-work/<技能名>-<标识>/backup` 路径，返回 JSON 给出实际备份位置。新的文件先复制到临时目录，再替换目标；替换失败时尝试恢复旧目录，恢复失败则报告保留的备份路径。安装器解析祖先目录的符号链接，拒绝目标技能目录本身为符号链接、文件系统根目录以及与当前 npm 包重叠的目标。安装暂存和备份位于宿主技能根目录外，避免发现重复技能；该目录需可写，并与目标在同一文件系统，否则替换会失败并尝试恢复。

安装锁冲突时先确认其他安装是否仍运行。不要在运行中的安装进程旁删除锁。安装被强制终止时可能留下锁及 `.forge-install-work/` 中的暂存或备份。先检查返回的路径与目标是否存在，保留备份；若目标缺失，可在确认没有安装进程后将对应 backup 恢复到目标。确认目录内容后再清理暂存及锁，不能只删锁后忽略备份。新安装完成后可能留下空的 `.forge-install-work/` 容器；确认没有安装进程且目录为空时可删除。返回的 installed 路径为解析链接后的实际路径。备份需要手动保留或清理；回退时先保留新目录，再将旧备份恢复为原目标，不合并两份技能源码。

学习档案应放在自己的 `learning/<主题>/`，升级不操作这些目录。不要在技能目录内保存学习数据。

## 卸载与命令冲突

通过 Skills 安装的技能使用它的移除命令，例如 `npx skills@latest remove forge`，并核对实际安装范围。下面的 npm 卸载只针对可选 CLI 包，不是 Skills 技能卸载方式。

```sh
npm uninstall -g forge-learning-local
```

该命令只移除 npm 包；显式复制到宿主的技能目录、旧技能备份以及自己的学习档案需分别管理。若系统已经有别的 `forge` 命令，可使用 `npm exec --package <本地tgz绝对路径> -- forge help` 明确选择本包，或直接调用安装技能目录的 `scripts/forge.mjs`。

## 保存与反馈交接

常规使用可以在 Agent 会话中请求打开学习页、保存记录、导入导出或复核作答，由 Agent 使用随包工具处理。下面是对应的手动方式。

`forge serve --out <学习目录> --port 0` 在本机回环地址提供服务，并直接保存档案；关闭服务后重新启动同一目录即可继续。独立 HTML 的记录位于浏览器缓存，导出后经会话核对、导入、复核和重建才能回到可信新版反馈。完整步骤见[独立文件交接](../skill/forge/references/portable-handoff.md)。

## 持续学习：登记、查找与续接

日常由 Agent 处理索引与读回；在原工作区可以说：

场景：你换了一个会话，想找回之前已登记的主题，但不记得目录名称。

```text
$forge 查看当前工作区已登记的主题，告诉我各自的目标、暂停位置和待复习情况，让我选一个继续。
```

需要手动维护时，使用以下命令。场景：已有标准学习目录 `learning/probability`，希望登记后从新进程读回；`resume` 只读取，不开始或切换轮次。

```sh
forge library register --topic probability --out ./learning/probability
forge library list
forge library resume --topic probability
```

默认索引为当前工作区 `learning/learning-index.json`，只存目录指针与身份，列表实时读取主题档案。旧目录需先登记；没有轮次或表现证据时保持未知，目录缺失/损坏时明确报错。独立 HTML 的缓存导入之前，索引不会读到新增答案。

场景：你将索引与对应主题目录整体放到新工作区的 `my-learning/`，使用指定索引读回：

```sh
forge library list --catalog ./my-learning/learning-index.json
forge library resume --catalog ./my-learning/learning-index.json --topic probability
```

场景：暂时不想在索引里展示这个主题，但需要保留全部学习文件：

```sh
forge library remove --topic probability
```

移除仅删除指针，目录和记录保留。升级或卸载技能也不更新、删除或迁移这些学习目录；索引不提供云同步或跨主题自动复习总计划。细节见[学习档案入口](../skill/forge/references/learning-library.md)。
