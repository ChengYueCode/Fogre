# 从 GitHub 安装技能、升级与可选 CLI 使用

Forge 的日常入口是在 Agent 会话中调用技能。完整技能自带参考、脚本与资源，Agent 可以直接调用安装目录中的工具，无需用户先安装全局 CLI。工具执行需要 Node.js ≥20；没有运行时第三方依赖。源码与 npm 分发已有 Windows/Linux、Node 20/24 的 CI 验证；安装目录与真实宿主加载分别核对。

## 安装时到底叫什么

| 名称 | 用在哪里 |
| --- | --- |
| `ChengYueCode/Fogre` | GitHub 下载来源；仓库名为 Fogre |
| `forge` | 主技能名、`--skill` 参数与目录名；会话入口为 `/forge` |
| `forge-organize` 等五个 `forge-*` 名称 | 独立技能名；对应 `/forge-organize` 等入口 |
| `skills` | 由 npm/npx 运行的通用技能安装器，不是 Forge 的 CLI 包 |
| `forge-learning-local@0.1.0` | 当前本地 npm CLI 包身份，安装后终端命令为 `forge`；未发布到 npm registry |

主技能内含所有能力规则，但没有嵌套五个独立技能目录。只安装 `forge` 不会自动登记另五个命令。npm 包含六个目录也不等于它们已进入 Agent 的扫描目录。

## 优先：从 GitHub 安装技能

Forge 以 GitHub 技能目录分发即可，不要求先发布自己的 npm 包。仓库地址为 https://github.com/ChengYueCode/Fogre，采用 MIT 许可证，主分支为 main。

```sh
npx skills@latest add ChengYueCode/Fogre
```

在普通交互终端中，菜单会发现六个技能，并以可展开的 **Forge Skills** 分组展示。用方向键移动、空格勾选、回车确认；推荐选择 **Select All** 安装六个入口，再选择目标 Agent 和安装范围。默认当前项目，增加 `--global` 可安装到用户级。

想直接选择全部技能、跳过技能选择菜单，可用：

```sh
npx skills@latest add ChengYueCode/Fogre --skill '*'
```

目标 Agent 决定写入位置，全部技能不等于全部 Agent。明确指定 Codex 的例子：

```sh
npx skills@latest add ChengYueCode/Fogre --skill '*' --agent codex --global
```

只装主技能用 `--skill forge`；只装整理入口用 `--skill forge-organize`。

主技能的仓库路径为 `skill/forge/`；直接指定该目录只会安装主技能：

```sh
npx skills@latest add https://github.com/ChengYueCode/Fogre/tree/main/skill/forge --skill forge
```

运行 npx 需要 Node.js/npm 与网络。安装规则、范围与支持的 Agent 以 [Skills 官方文档](https://github.com/vercel-labs/skills#install-a-skill) 为准；不能把工具支持某个 Agent 当作 Forge 已在该宿主完成学习验收。

也可以让 AI 按 [README 的安装提示词](../README.md#开始使用) 读取仓库并安装。优先使用 Skills；不可用时使用当前宿主支持的 GitHub 技能安装方式，逐一安装所选技能的完整目录：主技能来自 `skill/forge/`，独立入口来自同级的 `skill/forge-*/`。安装全部六个时不能只复制主技能。已有同名技能时检查实际目录和版本，不能盲目覆盖或另建副本。

宿主的加载与刷新方式以其实际要求为准。安装关键文件完整、工具环境可用、宿主能发现并实际调用是分别核对的步骤。完整功能仍需文件读写和命令权限；只复制 SKILL.md 不构成完整技能安装。

### 安装后怎样调用

安装并加载后，在 AI 会话中使用 `/技能名 + 请求`。主技能例如：

```text
/forge 我想学概率，请用生活中的例子带我入门。
```

独立技能例如，先提供材料，再输入：

```text
/forge-organize 请把我提供的笔记整理成学习页和可编辑导图。
```

其余入口为 `/forge-question`、`/forge-review`、`/forge-review-plan`、`/forge-insights`，分别用于提问检查、复核已有作答、安排复习与汇总已有记录。只安装主技能也能用自然语言选择这些能力；独立入口可分别安装。

这些调用写在 AI 会话里。安装命令的 `--skill` 参数仍使用不带 `/` 的技能名，例如 `--skill forge-organize`。

### 发布前本地试装与验证边界

在源码根目录，可以只扫描真实技能集合或直接安装主技能：

```sh
npx skills@latest add ./skill --list
npx skills@latest add ./skill/forge --skill forge
```

2026-10-11 使用 Skills 1.7.2，在隔离的干净发布目录发现主技能及五个单项入口，并在临时项目以 `--agent codex --copy --yes` 安装主技能。完整文件与工具执行另行核对；这不是 GitHub 下载或真实宿主运行时调用的证据。

仓库根目录的 `.claude-plugin/plugin.json` 明确列出六个分发目录，并提供 `Forge Skills` 菜单分组；使用仓库根目录安装时，Skills 按这份清单发现技能。内部历史副本与发布临时文件仍须排除在公开分发之外。

菜单分组是安装器的展示方式。实际安装后，六个技能仍在目标 Agent 的技能根目录下并列放置，不会把五个独立入口藏在 `forge` 里面。若从 Agent 自动化环境执行，Skills 可能自动确认选项而不显示交互菜单；要手动勾选，请在自己的交互终端运行上面的默认命令。

2026-10-12 使用 Skills 1.7.2，在隔离临时目录对干净发布源码运行无筛选参数的安装命令，实际显示 `Found 6 skills`、`Select All (0/6)` 与可展开的 `Forge Skills` 分组及全部六个入口；在菜单阶段取消，未写入用户技能目录。

## 备用：使用源码自带安装器

取得源码后，在项目根目录执行。使用默认用户级 Codex 技能目录的 Windows PowerShell 示例：

```powershell
node ./bin/forge.mjs install-skill --target "$env:USERPROFILE/.agents/skills/forge"
```

该入口直接使用源码包的安装器，无需 `npm pack` 或全局 npm 安装。它复制完整技能目录，不自动配置宿主或安装 Node.js。`--target` 指向宿主技能根目录的直接子目录；其他宿主或自定义配置请换成实际加载位置。

按宿主要求加载并确认发现技能后，在会话中输入：

场景：你能读简单代码，希望用真实练习检验二分查找的边界判断。

```text
/forge 带我学习二分查找，目标是独立解释循环不变式，并判断边界是否正确。
```

Agent 根据请求核对材料、教学并按需生成产物、保存记录和打开学习页；用户不需要先手动运行构建或服务命令。完整行为需要宿主提供文件读写和命令执行能力，权限或环境不足时按实际阻塞说明。

也可以将完整 `skill/forge/` 目录按宿主的本地技能导入方式安装，不能只复制 `SKILL.md`。已有安装先核对原目录，再用同一个源码安装入口加 `--upgrade`；不要为升级另建同身份副本。

使用源码自带安装器安装独立入口同样无需全局 CLI，例如：

```powershell
node ./bin/forge.mjs install-skill --target "$env:USERPROFILE/.agents/skills/forge-question" --skill forge-question
```

通过主技能 `/forge` 也能选择单项能力，不必安装所有独立入口。宿主确认发现后才使用对应调用名。GitHub 分发后的入口安装可用 `npx skills@latest add ChengYueCode/Fogre --skill forge-question`。

## 可选：安装本地 CLI 包

以下方式面向希望手动调用命令、维护档案或验证工具的用户，不是日常在 Agent 中使用技能的前置步骤。示例中的 `forge install-skill` 也可以替换为项目根目录的 `node ./bin/forge.mjs install-skill`。

当前没有 Forge 的 npm registry 发布版本。`npx skills` 路径可以直接从 GitHub 安装技能；下面是独立的 Forge CLI 本地包路径，不能把包名当成已经发布的 registry 地址。

在完整源码目录执行 `npm pack` 得到 tgz，再安装：

```sh
npm pack
npm install -g ./forge-learning-local-0.1.0.tgz
forge help
```

这个 npm 包包含全部六个技能目录，但 npm 安装本身只安装 CLI，不写 Agent 的技能目录，没有自动注册入口的 postinstall。

Windows PowerShell 下，只安装主技能到用户级 Codex 技能根目录：

```powershell
forge install-skill --target "$env:USERPROFILE/.agents/skills/forge"
```

`$env:USERPROFILE` 展开为当前用户目录；若配置了自定义根目录，替换为配置值。

想通过这个 npm CLI 一次安装六个入口，可在 PowerShell 显式执行：

```powershell
$forgeSkillRoot = "$env:USERPROFILE/.agents/skills"
'forge', 'forge-organize', 'forge-question', 'forge-review', 'forge-review-plan', 'forge-insights' | ForEach-Object {
  forge install-skill --target "$forgeSkillRoot/$_" --skill $_
}
```

这段调用现有的单技能安装器六次，不是 npm 自动安装。Claude Code 将根目录换成 `$env:USERPROFILE/.claude/skills`；其他宿主用实际支持的目录。已有目录默认拒绝覆盖，需要核对后显式升级。本地 tgz 安装及显式复制六个入口已实测；npm registry 发布仍未执行。


`--target` 可以是绝对路径或相对当前工作目录的路径，必须指向宿主技能根目录的直接子目录（如 `.agents/skills/forge`），不是整个技能根目录。不要使用 vendor/forge 等多层嵌套布局，以免递归扫描器发现暂存或备份。安装器不会猜测宿主。上面的用户目录示例展开后是绝对路径；使用相对路径时以当前工作目录为基准，仍需核对目标是宿主实际加载的位置。通过源码入口直接运行时，目标必须在当前源码包目录之外。将生成目录交给你的 AI 宿主加载，宿主若支持 `/forge` 可按此名称调用。

## 安装目录与发现检查

Skills 安装器 1.7.2 的目录映射及本次隔离安装结果如下。项目级仅对相应工作区可见；用户级用于该用户的多个项目。自定义配置或其他工具按其实际支持的目录核对。

| 目标 Agent | 项目级目录 | 用户级目录 |
| --- | --- | --- |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Cursor | `.agents/skills/` | `~/.cursor/skills/` |
| OpenCode | `.agents/skills/` | `~/.config/opencode/skills/` |

依据：[Skills 安装器的目录映射](https://github.com/vercel-labs/skills#supported-agents)、[OpenAI 的技能发现说明](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)、[Claude Code 的加载位置](https://code.claude.com/docs/en/skills#choose-where-skills-load)。这些目录与安装器版本有关，升级时核对其实际输出。

以 Codex 项目级完整安装为例：

```text
当前项目/
└── .agents/skills/
    ├── forge/SKILL.md
    ├── forge-organize/SKILL.md
    ├── forge-question/SKILL.md
    ├── forge-review/SKILL.md
    ├── forge-review-plan/SKILL.md
    └── forge-insights/SKILL.md
```

六个目录并列，每个都有自己的 `name`、LICENSE 和随包参考；需要本地工具的入口还携带 scripts/assets。`forge-question` 是纯会话入口，没有运行脚本。五个独立技能不藏在 `forge` 的子目录里，也不依赖兄弟目录。

仓库里的 `skill/` 和 npm 安装目录里的 `node_modules/forge-learning-local/skill/` 是分发源。下载源码或安装 npm 包，不代表这些位置自动成为宿主加载位置；复制、链接或导入到宿主支持的目录后，才检查宿主是否发现。

安装完成后：

1. 核对安装器输出的目标 Agent、范围和目录，检查要用的每个入口都有 `SKILL.md`，其中 `name` 与技能名一致。
2. 用 `npx skills@latest list --agent codex` 查看项目安装记录；用户级安装增加 `--global`，其他宿主替换 agent 参数。Skills 的列表不等于 Agent 自己的加载结果。
3. 按工具要求刷新或重新打开当前项目，在工具自己的技能/命令列表确认六个入口。找不到时先核对工作区、目录和配置，而不是仅更换调用前缀。
4. 实际调用一个入口并给出所需材料，确认按该能力响应；需要存档时再核对文件读回。

2026-10-12，使用 Skills 1.7.2 对 Codex、Claude Code、Cursor、OpenCode 的安装目标进行隔离安装：主技能模式只落盘 forge；全部模式在共同根目录及 Claude Code 根目录各出现六个正确身份，Skills 的 Codex/Claude Code 列表各返回六个入口。本地 npm 包经真实安装，再显式复制六个入口，五个带工具入口的模型验证及构建均通过，纯会话入口没有运行脚本。这证明目录和随包资源可用，不等于四个宿主都已完成菜单发现与真实调用验收。

## 单项入口与安装检查

主技能的技能名、调用名与安装目录名统一为 `forge`。旧目录 `ember` 若暴露 `name: forge`，迁移时先确认目标 `forge` 不存在，将旧件移到技能根目录之外备份，再安装至 `forge`；不要保留两个暴露相同身份的安装目录。运行时历史缓存和档案标识仍按兼容合同保留，详见[技能架构](skill-architecture.md)。

单项入口先读规则及其引用的参考均随包提供，按当前分支读取，不要求另装主技能；需要 CLI 的入口同时携带页面资产，支持复核或导入后的重建。

除主技能外，包内还带五个由 `skill/forge/references/` 唯一正文生成的单项入口：`forge-question`（只用提问检查解释/推理）、`forge-review`（集中复核作答）、`forge-review-plan`（预算内复习安排）、`forge-insights`（洞见与速查汇总）、`forge-organize`（只整理材料生成学习产物）。每个入口都是独立技能目录，自包含先读能力规则、随附参考与（多数情况下的）CLI 和资产副本，单独安装即可被宿主独立发现：

```powershell
forge install-skill --target "$env:USERPROFILE/.agents/skills/forge-question" --skill forge-question
forge install-skill --target "$env:USERPROFILE/.agents/skills/forge-review" --skill forge-review
```

省略 `--skill` 时安装主技能 forge。升级校验按目标目录内 `SKILL.md` 的 `name:` 与 `.forge-install.json` 记录的身份进行：主技能与各入口是彼此独立的技能身份，不能互相覆盖。每个安装件都会写入 `.forge-install.json`（所装技能与包版本）；同一宿主根目录下若存在其他 forge 系安装件的版本与本次不同，或另一目录已暴露相同技能身份（例如改名前遗留的旧目录），安装器会在返回 JSON 的 `versionMismatches` / `identityCollisions` 中如实报告——安装本身成功，但混合版本不会被静默处理，请按报告对齐或清理。生成入口不是权威版本：修改规则只能改 `skill/forge/references/`（或主技能 `SKILL.md`），再运行 `node scripts/build-entries.mjs` 重新生成。

安装技能后，无需源码仓库就能运行随包示例：

场景：你想手动打开随包概率教学示例，体验页面和自动存档；它不是已有学习成果。

```powershell
forge build "$env:USERPROFILE/.agents/skills/forge/assets/probability.json" --out ./learning/probability --svg
forge library register --topic probability --out ./learning/probability
forge serve --out ./learning/probability --port 0
```

示例打开后，在已加载技能的会话中输入 `/forge 接着 learning/probability 里的档案学习，先查看当前任务。`；没有创建学习轮次时，Agent 如实说明并按你的目标开始学习。使用自己的材料或目标时，参考[场景与使用示例](../skill/forge/references/usage-examples.md)。路径相对会话工作目录解析，跨目录会话提供可读目录或索引。两种保存方式见本文[保存与反馈交接](#保存与反馈交接)。

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
forge install-skill --target "$env:USERPROFILE/.agents/skills/forge" --upgrade
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
/forge 查看当前工作区已登记的主题，告诉我各自的目标、暂停位置和待复习情况，让我选一个继续。
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
