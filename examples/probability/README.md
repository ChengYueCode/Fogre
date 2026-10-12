# 概率教学示例

**场景**：你还没有自己的学习材料，想先体验“解释 → 作答 → 反馈 → 保存 → 下次继续”的流程。此目录是教学样例，材料和案例包含合成假设，不代表真人学习成果或医疗判断依据。

## 在 Agent 会话中体验

安装并加载主技能后，请求 Agent 使用随包材料，在自己的学习目录建立或续接档案：

```text
/forge 用技能自带的 probability.json 教学示例带我体验一次学习。
这次先理解先验为什么会影响阳性预测值，请把产物和记录放在 learning/probability。
如果这个目录已有记录，先核对并读回，保留原答和未完成任务。
```

Agent 核对材料、提出诊断问题并等待你回答，再按表现推进；需要时交付学习页、可编辑导图和档案，并登记主题。生成页面或打开样例不表示已掌握。你可以直接查看本目录的 [学习页](index.html)，但在它上面的浏览器新增记录不会自动成为会话已读取的档案。

## 手动创建可自动存档的副本

**场景**：你希望从源码根目录运行本地工具，使用自己的 `learning/probability` 目录。要求 Node.js ≥20；已有目录先核对，构建默认保留有效记录。

```sh
node ./bin/forge.mjs build ./skill/forge/assets/probability.json --out ./learning/probability --svg
node ./bin/forge.mjs library register --topic probability --out ./learning/probability
node ./bin/forge.mjs serve --out ./learning/probability --port 0
```

打开服务返回的地址，页面提交保存后请求 Agent 复核同一目录。直接双击 HTML 时新增记录仅在该浏览器缓存，需导出后交给 Agent 核验、导入与复核。

## 新会话继续

**场景**：仍在原工作区，主题已经登记，希望找回自己的记录：

```text
/forge 查看已登记的 probability 主题，读回当前目标、位置、原答和缺口，再接着学。
```

没有本轮学习安排时如实说明，再按你的目标创建；索引或目录缺失时先核对位置，不凭样例补造历史。更多用法见[场景与使用示例](../../skill/forge/references/usage-examples.md)和[安装指南](../../docs/installation.md)。
