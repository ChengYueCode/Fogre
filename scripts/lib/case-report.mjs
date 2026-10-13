const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const card = (label, text, tone = '') => `<article class="card ${tone}"><h3>${escape(label)}</h3><p>${escape(text)}</p></article>`;

// This is an evidence report of CLI readbacks, not a simulated Agent chat UI.
export function renderCaseReport(data) {
  const member = data.review.requests[0].members[0];
  const attempt = data.insights.concepts[0].attempts[0];
  const paused = data.paused;
  const resumed = data.afterResume;
  const sections = [
    { id: 'review', title: '原答保留，反馈说明具体误解', eyebrow: '01 / 提交与复核', body:
      `<div class="columns">${card('演示原答 · 保存原文', member.answer, 'original')}${card('具体误解 · 已写入反馈', member.feedback.misconceptions, 'feedback')}</div>` +
      `<div class="columns">${card('正确部分', member.feedback.correct)}${card('核对依据', member.feedback.basis)}</div>` +
      card('修补建议', member.feedback.repair) + `<div class="facts"><span>请求 ${escape(data.review.requestId)}</span><span>成员 ${data.review.requests[0].completed} / ${data.review.requests[0].total} 完成</span><span>待复核 ${data.review.pendingCount}</span></div>` },
    { id: 'resume', title: '暂停后读回同一轮次与原答', eyebrow: '02 / 暂停与恢复', body:
      `<div class="columns">${card('暂停时的读回', `轮次：${paused.round.id}\n状态：${paused.round.status}\n当前位置：${paused.position.currentTask.conceptTitle}\n原答数量：${paused.answers.total}`, 'original')}${card('恢复后的读回', `轮次：${resumed.round.id}\n状态：${resumed.round.status}\n当前位置：${resumed.position.currentTask.conceptTitle}\n原答数量：${resumed.answers.total}`, 'feedback')}</div>` +
      card('保存的目标与预算', `${paused.goalAndBudget.goal}\n本轮预算：${paused.goalAndBudget.budgetMinutes} 分钟`) +
      `<div class="facts"><span>只读恢复未改写档案</span><span>原答与修正保留</span><span>掌握证据 0 条</span></div><p class="note">这里验证公开命令重新读取档案；未冒充新 Agent 会话的完整调用验收。</p>` },
    { id: 'plan', title: '预算内的选择与暂缓', eyebrow: '03 / 复习只读预览', body:
      `<div class="columns">${data.plan.selected.map(item => card(`选中 · ${item.estimatedMinutes} 分钟`, `${item.conceptTitle}\n${item.question}\n选择依据：${item.reason}`, 'feedback')).join('')}${data.plan.deferred.map(item => card(`暂缓 · ${item.estimatedMinutes} 分钟`, `${item.conceptTitle}\n${item.deferredReason}`, 'original')).join('')}</div>` +
      `<div class="facts"><span>预算 ${data.plan.budgetMinutes} 分钟</span><span>预计 ${data.plan.estimatedMinutes} 分钟</span><span>到期项 ${data.plan.dueCount} 个</span><span>预览只读</span></div><p class="note">到期比较使用合成演示的次日模拟时钟，暂缓不等于完成；本报告不证明真实保持效果。</p>` },
    { id: 'insights', title: '理解变化来自已有记录', eyebrow: '04 / 洞见与速查', body:
      `<div class="timeline">${card('① 原答', attempt.answer, 'original')}${card('② 复核指出的缺口', attempt.reviews[0].feedback.misconceptions)}${card('③ 追加修正 · 借助反馈', attempt.corrections[0].text, 'feedback')}</div>` +
      `<div class="facts"><span>原答仍为 1 次</span><span>修正来源 tutor-feedback</span><span>未授予掌握结论</span></div><p class="note">合成输入只在独立工具目录运行；这份报告不含可冒充真人档案的 state.json。</p>` }
  ];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forge 公开命令读回 · 合成工具演示</title><style>
  *{box-sizing:border-box}body{margin:0;background:#eef1f6;color:#17233b;font:18px/1.65 "Microsoft YaHei",system-ui,sans-serif}header{max-width:1180px;margin:32px auto 22px;padding:0 32px}header b{color:#315bcc;letter-spacing:2px}header p{margin:12px 0;color:#526079;font-size:15px}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:#315bcc}nav a{background:white;padding:7px 18px;border-radius:8px;text-decoration:none}section{max-width:1180px;margin:24px auto;padding:32px;background:white;border:1px solid #d8deeb;border-radius:18px;scroll-margin-top:20px}.eyebrow{color:#315bcc;font-weight:700;font-size:15px;letter-spacing:1px}h2{font-size:32px;line-height:1.35;margin:8px 0 14px}.disclosure{font-size:14px;color:#71612d;background:#fff8e6;border:1px solid #eadcaf;padding:10px 14px;border-radius:7px;margin-bottom:24px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{padding:18px 22px;border:1px solid #dce2ed;border-radius:12px;margin-bottom:18px}.card h3{font-size:16px;margin:0 0 8px;color:#455573}.card p{margin:0;white-space:pre-line}.original{background:#fff7f0;border-color:#edcfb4}.feedback{background:#eef6ff;border-color:#c9dcf5}.facts{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}.facts span{padding:6px 12px;border-radius:6px;background:#eef1f6;font-size:14px}.note{font-size:14px;color:#59667c}.timeline .card{margin-left:14px;border-left:4px solid #315bcc}footer{max-width:1180px;margin:28px auto 40px;padding:0 32px;font-size:14px}@media(max-width:650px){.columns{grid-template-columns:1fr}section{margin:16px 12px;padding:20px}h2{font-size:26px}}
  </style><header><b>Forge / ${escape(data.topic ?? '公开命令读回')}</b><p>Make sense. Keep going.</p><p>实际执行 CLI 后生成的展示报告。作答与反馈为预先编写的合成输入，不是 Agent 对话或真人学习成果。</p><nav>${sections.map(item => `<a href="#${item.id}">${escape(item.eyebrow)}</a>`).join('')}</nav></header>${sections.map(item => `<section id="${item.id}"><div class="eyebrow">${escape(data.topic ?? '')} · ${escape(item.eyebrow)}</div><h2>${escape(item.title)}</h2><div class="disclosure">合成工具演示 · 结果来自实际命令读回 · 不证明真人掌握或宿主完整调用</div>${item.body}</section>`).join('')}<footer><a href="readback.json">完整命令与读回 JSON</a> · <a href="README.md">案例说明与复现方式</a></footer></html>`;
}
