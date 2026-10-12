<!-- 本文件由 scripts/build-entries.mjs 自动生成，勿手改。 -->
<!-- 规则唯一来源：skill/forge/references/；重新生成：node scripts/build-entries.mjs -->

# 集中复核本轮作答

学习者回到会话请求检查时，先用 `round-read` 确认轮次与目录，再执行以下步骤。教学判断由导师根据已保存原答完成，页面展示结果。合成测试答案只用于明确标注的独立工具验收目录，不能写入真实学习档案或交付示例，也不证明真人掌握。

## 建立范围与续做

先用 `review-read --out <学习目录> --round-id <轮次ID>` 列出待复核作答、已有请求与剩余量；没有待处理项是正常空态。没有待复核真实作答时，`review-start` 返回 `E_CONFLICT`，先等待新作答；已有未完成请求则读回同一请求继续。

```bash
node <skill-dir>/scripts/forge.mjs review-start --out <学习目录> --request-id <稳定请求ID> --round-id <轮次ID>
node <skill-dir>/scripts/forge.mjs review-read --out <学习目录> --request-id <稳定请求ID>
```

开始时固定该轮次当时的待复核作答及内容快照。保留返回的请求身份，暂停后读取同一请求，只处理未完成成员；同一身份重试保持原范围。后来提交的答案和其他轮次的答案分别留待下一请求。请求完成只表示其固定成员完成，仍须读取当前轮次的新待复核数量。

无轮次的历史不并入当前轮次。先用 `review-read --out <学习目录> --history` 读取 `historyPendingCount` 及 `historyPendingAttempts` 中的原答、`attemptId`、`promptId`，由学习者明确选择后建立独立请求；此读取只列历史请求和历史待处理数量：

```bash
node <skill-dir>/scripts/forge.mjs review-start --out <学习目录> --request-id <历史请求ID> --history --attempt <作答ID> [--attempt <另一ID>]
```

## 逐项反馈

读取返回的题目、原答、协助来源、参考、判定标准、冻结修正和当前有效性。逐项说明正确部分、具体误解、核对依据、必要修补、后续任务。没有误解或无需修补也用文字说明理由；`basis` 写明实际核对的标准、材料与答案表现。

把真实判断保存为JSON文件，然后写入明确成员：

```bash
node <skill-dir>/scripts/forge.mjs review-item --out <学习目录> --request-id <请求ID> --prompt <题目ID> --attempt-id <作答ID> --feedback <反馈JSON文件>
```

成功反馈结构如下（字段中的中文是填写要求，需替换为实际判断）：

```json
{
  "status": "completed",
  "correct": "原答中核对正确的部分",
  "misconceptions": "具体误解，或未发现误解的依据",
  "basis": "根据何处参考或判定标准核对了什么",
  "repair": "必要修补，或无需修补的理由",
  "nextTask": "适合的后续检验任务",
  "rating": "hard",
  "targetCorrectionId": null
}
```

`targetCorrectionId` 为空表示原答；评价某次修正时填请求快照内的修正身份，原答和修正分别保留。复核开始后才发生的修正需在后续明确复核中处理。修正借助提示、参考或导师反馈，不会把原答变成新的独立成功。

过时、缺依据、无法判断分别保存 `stale`、`missing-basis`、`undetermined`，并给非空 `reason`，例如：

```json
{"status":"missing-basis","reason":"该自创问题没有参考或判定标准，需要先补充可核对的材料。"}
```

失败项保留待处理，可以在同一请求内续做。已完成项不再改写，重复写相同结果不新增作答或评价。内容已更新时保留原快照及原因，不把旧答案当作当前掌握；需要新的真实作答。自创问题仍可练习和讨论，缺少可核对依据时保留缺口。

## 读回与证据

再次 `review-read --out <学习目录> --request-id <请求ID>` 确认每项结果、剩余项和新增待复核数，再用 `build <学习目录>/model.json --out <学习目录>` 重建学习产物。学习者在本地服务页面点“刷新复核结果”，或重新打开新版独立页面，查看原答、导师反馈、评价来源、复习日期和后续任务。更新不覆盖交错新增的笔记或作答；内容版本冲突时保留输入并按页面指引恢复。

导师评价参与已有透明调度，每次真实作答只贡献一次有效输入。题目级、概念级掌握结论分别用 `evidence` 复核，并沿用当前内容、独立性、任务类型及跨会话时间要求，详见 [证据与复习](evidence-and-review.md)。成功反馈或某一道题的结论不自动提升整个概念。

缺少参考和判定标准的自创问题可保留 `unknown` 或 `needs-work` 讨论与缺口，不能授予正向掌握；自由填写的证据说明不能替代可核对依据。旧档已有的此类正向记录保留为历史，读取时不作为当前有效掌握；概念级保持也不能靠缺依据作答凑次数。

独立文件的浏览器缓存需先导出，导师只读取实际提供的文件。接收档案、核对来源、导入对应目录、复核重建及重新打开新版产物，按[独立文件交接](portable-handoff.md)完成。浏览器缓存与导入文件不能新增可信导师结论；全局安装和分发包的交付状态另行核验。
