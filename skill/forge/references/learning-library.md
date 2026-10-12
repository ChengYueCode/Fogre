# 统一学习档案入口

用于“继续上次学习”“我学过哪些主题”“学到了哪”，以及新建/接收学习目录后的登记。一个索引服务一个学习者；学习事实保存在各主题的 `state.json`，索引只保存稳定主题 ID、目录指针、模型身份和登记时间。

## 登记与发现

新建或接收学习目录后的索引位置、登记命令与身份冲突处理见[学习目录登记](learning-registration.md)。

## 再次交流

1. 用户给了明确学习目录时，直接 `resume-read --out <dir>`；用户只说继续学习时，先 `library list` 读取当前工作区或已指定索引。索引缺失时询问已有目录或索引位置；空索引不表示用户从未学习。
2. 主题已明确时按稳定 ID 读取；多个候选时展示主题、当前目标/暂停位置和待复习数量，让学习者选择，不因更新时间最近自动决定主题。
3. `library resume --topic <id>` 只读回恢复上下文，保留原轮次身份。按[本轮续接](learning-rounds.md)说明保存值与当前值差异，再用现有 `round --action resume --out <返回的out> --round-id <原轮次ID>` 继续。有多个历史轮次时可用 `--round-id` 明确选择，读取不切换轮次。

```bash
node <skill-dir>/scripts/forge.mjs library resume --topic probability
node <skill-dir>/scripts/forge.mjs library list --catalog ./my-learning/learning-index.json
```

列表每次实时读档案：标题、档案更新时间、本轮目标/状态/当前位置、当前有效 `dueCount` 和旧内容的 `staleDueCount`，以及缺口与材料变化。档案更新时间不是上次真正学习的时间；没有本轮、画像或表现证据时保持未知。列表是跨主题导航，不自动形成跨主题复习总计划；选定主题后再调用原有复习安排。

## 恢复与移除

主题缺文件、损坏或模型身份变化时列表显示 `available: false` 与具体错误，其他主题仍可读。先核对原目录或恢复备份；读取与续接不会初始化缺失档案。索引损坏/未来版本则保留原文件并报错，不覆盖。浏览器缓存需导出、核验并导入对应主题后再读；索引不能读取未导出的缓存。

```bash
node <skill-dir>/scripts/forge.mjs library remove --topic probability
```

移除只删除索引指针，保留学习目录及全部记录。索引中记录的目录路径只用于定位；读取范围限用户确认的索引和主题，多个学习者使用各自索引与目录。全局技能安装目录和宿主聊天记忆不保存用户学习档案。
