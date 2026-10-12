<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 学习目录登记

生成或核验导入一个标准学习目录后读取。登记只保存主题与目录指针，不展开续学，也不把产物生成当作学习完成。

## 登记与发现

默认索引是当前工作目录的 `./learning/learning-index.json`；用户指定索引时所有操作沿用该位置。索引中的目录路径相对索引文件解析，整体移动学习目录与索引后可续接。换到其他工作区或设备时需要提供索引位置及对应学习目录；没有账号/云同步或全盘搜索。

创建或导入学习目录并核对读回后，用稳定 ASCII ID 登记：

```bash
node <skill-dir>/scripts/forge.mjs library register --topic probability --out ./learning/probability
node <skill-dir>/scripts/forge.mjs library list
```

登记要求目录内已有 `model.json` 和 `state.json`。使用外部 `--state` 的档案先按现有导出/导入流程归入标准目录再登记。登记同主题/同目录可安全重试；同身份不同目录或同目录不同身份会拒绝。目录改为另一位置时先核对旧指针，再移除并登记新位置。登记失败分别报告“学习产物已保存”和“索引未登记”，不能把目录错误解释为学习记录不存在。
