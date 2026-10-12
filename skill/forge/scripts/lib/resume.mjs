// Unified resume readback for task 06: one read-only view that lets a new
// session (or a reopened one) continue a paused or ended learning round from
// the durable archive alone.
//
// This module MUST stay dependency-free and portable: it may not import any
// other file and may not touch Node-only APIs. It deliberately contains no
// rules of its own — staleness, evidence validity and review selection stay in
// their home modules (round.mjs / quality.mjs / corrections.mjs / state.mjs).
// The host computes those views and passes them in; this module only assembles
// the cross-capability readback and decides, per section, what is present and
// what must be reported as unknown. Internal helpers are `resume*`-prefixed.

function resumeIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resumeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Saved profile fields that may legitimately be unknown: an old archive or a
// skipped opening reports them as unknown instead of inventing a value.
var RESUME_LEARNER_FIELDS = ['role', 'task', 'background', 'preference'];

var RESUME_PERSISTENCE_NOTE = '本读回只反映目录中的学习档案（state.json）：serve 本地服务与 CLI 直接写回该档案；'
  + '独立打开的页面只写本机浏览器缓存，未导出并导入前不在此档案内，新会话读不到，也不得宣称已读。'
  + '缓存与重建发生冲突时，页面保留双方事实并如实报告，不静默覆盖任一版本。';

var RESUME_CHANGES_NOTE = '以上为保存值与当前值的差异事实：历史记录全部保留，不沿用失效结论；'
  + '先向学习者说明受影响范围，按当前目标调整路线或重新核对材料后再继续。';

function resumeLearnerProfile(opening) {
  if (!resumeIsRecord(opening) || !resumeIsRecord(opening.learner)) {
    return {
      present: false,
      learner: null,
      unknownFields: RESUME_LEARNER_FIELDS.slice(),
      interactionLimit: null,
      historyCount: 0,
      note: '本轮未记录学习画像，画像各字段未知；需要时只补影响教学的关键缺项，不补造历史画像。',
    };
  }
  const learner = opening.learner;
  const unknownFields = RESUME_LEARNER_FIELDS.filter((key) => learner[key] === null || learner[key] === undefined);
  return {
    present: true,
    learner: resumeClone(learner),
    unknownFields,
    skipped: learner.skipped === true,
    temporaryApproach: learner.temporaryApproach ?? null,
    interactionLimit: opening.interactionLimit ?? null,
    historyCount: Array.isArray(opening.history) ? opening.history.length : 0,
    note: unknownFields.length > 0
      ? '以下画像字段保存为未知：' + unknownFields.join('、') + '；恢复时不重复完整问卷，只补影响教学的缺项。'
      : '画像完整保存；恢复时不重复已回答的画像问卷。',
  };
}

function resumeScopeView(key, scope, round) {
  if (!resumeIsRecord(scope)) return null;
  // `stale` is the round view's combined verdict (goal OR fingerprint drift);
  // this view copies it without re-deriving it.
  return {
    key,
    at: scope.at ?? null,
    goal: scope.goal ?? null,
    modelFingerprint: scope.modelFingerprint ?? null,
    stale: scope.stale === true,
    estimatedMinutes: scope.estimatedMinutes ?? null,
    units: Array.isArray(scope.units) ? scope.units.length : 0,
  };
}

function resumeGoalAndBudget(round) {
  if (!resumeIsRecord(round)) {
    return { present: false, note: '没有可续接的学习轮次；目标与预算未知。新学习请先创建轮次。' };
  }
  const scopes = ['preliminary', 'calibrated']
    .map((key) => resumeScopeView(key, round.opening ? round.opening[key] : null, round))
    .filter((scope) => scope !== null);
  return {
    present: true,
    goal: round.goal ?? null,
    budgetMinutes: round.budgetMinutes ?? null,
    entry: round.entry ?? null,
    status: round.status ?? null,
    storedStatus: round.storedStatus ?? null,
    resumeStatus: round.resumeStatus ?? null,
    diagnosticGate: round.status === 'diagnosing'
      ? '本轮仍在诊断等待：先提交真实诊断作答并确认，再进入正式路线；已适用的诊断不重复进行。'
      : null,
    scopes,
    note: round.budgetMinutes === null || round.budgetMinutes === undefined
      ? '保存时未设定时间预算；预计范围见范围快照，实际用时只依可核对记录。'
      : '保存的时间预算为 ' + round.budgetMinutes + ' 分钟；预计用时不是用户硬上限。',
  };
}

function resumePosition(round) {
  if (!resumeIsRecord(round)) return { present: false, note: '没有学习轮次，当前位置未知。' };
  const tasks = Array.isArray(round.tasks) ? round.tasks : [];
  const current = tasks.find((task) => task.id === round.currentTaskId) || null;
  const progress = resumeIsRecord(round.progress) ? round.progress : null;
  const next = progress && resumeIsRecord(progress.nextTask) ? progress.nextTask : null;
  return {
    present: true,
    currentTask: current
      ? {
        id: current.id,
        conceptId: current.conceptId ?? null,
        conceptTitle: current.conceptTitle ?? null,
        promptKind: current.promptKind ?? null,
        completionCriteria: Array.isArray(current.completionCriteria) ? current.completionCriteria.slice() : [],
        diagnostic: current.diagnostic === true,
        deferred: current.deferred === true,
        submitted: current.submitted === true,
        contentUpdated: current.contentUpdated === true,
      }
      : null,
    nextTask: next ? { id: next.id ?? null, conceptTitle: next.conceptTitle ?? next.conceptId ?? null } : null,
    remainingTasks: round.remainingTasks ?? 0,
    deferredTasks: round.deferredTasks ?? 0,
    submittedTasks: round.submittedTasks ?? 0,
    budgetInsufficient: round.budgetInsufficient === true,
    requiredMinutes: round.requiredMinutes ?? null,
    ended: Boolean(progress && progress.ended),
    note: current
      ? '当前位置以上方任务为准；完成标准随任务保存，恢复后不重复已提交的步骤。'
      : '本轮没有开放任务；按范围快照或收尾记录确定下一步。',
  };
}

function resumeInteractions(round) {
  if (!resumeIsRecord(round) || !resumeIsRecord(round.progress)) {
    return {
      present: false,
      countedInteractions: null,
      totalInteractions: null,
      totalKnown: false,
      actualMinutes: null,
      interactionLimit: null,
      closure: null,
      note: '本轮未启用互动计数（旧轮次或未开启进度跟踪）：实际互动总数未知，不补造计数或学习时间。',
    };
  }
  const progress = round.progress;
  const closure = resumeIsRecord(progress.closure) && !progress.closure.stale ? resumeClone(progress.closure) : null;
  const closureStale = resumeIsRecord(progress.closure) && progress.closure.stale === true;
  return {
    present: true,
    countedInteractions: Array.isArray(progress.events) ? progress.events.length : 0,
    totalInteractions: progress.totalInteractions ?? null,
    totalKnown: progress.totalInteractions !== null && progress.totalInteractions !== undefined,
    interactionLimit: progress.interactionLimit ?? null,
    actualMinutes: progress.actualMinutes ?? null,
    budgetSignal: progress.budgetSignal ?? null,
    closure,
    closureStale,
    note: (progress.totalInteractions === null || progress.totalInteractions === undefined
      ? '计数起点晚于部分历史，互动总数未知；已保存的计数只反映起点之后的真实回应。'
      : '互动计数按真实用户回应保存，工具调用与导师消息不计入。')
      + (progress.actualMinutes === null || progress.actualMinutes === undefined ? '实际用时未知。' : ''),
  };
}

// Attempts bound to this round, with their original text and assistance
// attributes read back verbatim. Attempts that belong to no resolvable round
// are counted separately so they can never masquerade as this round's work.
// Whether an attempt is still current is NOT decided here: the host passes
// `attemptActivity` ({attemptId -> boolean}) computed by state.mjs's
// isAttemptActive, so the freshness rule keeps its single home.
function resumeAnswers(state, model, round, attemptActivity) {
  const attempts = (state && state.attempts) || {};
  const rounds = (state && state.learningRounds) || {};
  const concepts = (model && model.concepts) || [];
  const conceptTitle = (conceptId) => {
    const concept = concepts.find((entry) => entry && entry.id === conceptId);
    return concept ? concept.title : conceptId;
  };
  const unattributed = [];
  const items = [];
  Object.keys(attempts).forEach((promptId) => {
    const list = Array.isArray(attempts[promptId]) ? attempts[promptId] : [];
    list.forEach((attempt) => {
      if (!resumeIsRecord(attempt)) return;
      const bound = typeof attempt.roundId === 'string' ? attempt.roundId : null;
      if (!bound || !Object.prototype.hasOwnProperty.call(rounds, bound)) {
        unattributed.push(attempt.id);
        return;
      }
      if (!resumeIsRecord(round) || round.id !== bound) return;
      const assessments = Array.isArray(attempt.tutorAssessments) ? attempt.tutorAssessments : [];
      const latest = assessments.length > 0 ? assessments[assessments.length - 1] : null;
      const active = attemptActivity && Object.prototype.hasOwnProperty.call(attemptActivity, attempt.id)
        ? attemptActivity[attempt.id] === true
        : null;
      items.push({
        id: attempt.id,
        promptId,
        conceptId: attempt.conceptId ?? null,
        conceptTitle: attempt.conceptId ? conceptTitle(attempt.conceptId) : null,
        taskId: attempt.taskId ?? null,
        answer: typeof attempt.answer === 'string' ? attempt.answer : '',
        at: attempt.at ?? null,
        assisted: attempt.assisted === true,
        assistanceSources: Array.isArray(attempt.assistance) ? attempt.assistance.slice() : [],
        assessed: assessments.length > 0,
        latestRating: latest ? latest.rating ?? null : null,
        active,
      });
    });
  });
  const roundPresent = resumeIsRecord(round);
  const roundItems = roundPresent ? items : [];
  const independent = roundItems.filter((item) => !item.assisted).length;
  return {
    present: roundPresent && roundItems.length > 0,
    total: roundItems.length,
    independent,
    assisted: roundItems.length - independent,
    pendingReview: roundItems.filter((item) => !item.assessed).length,
    items: roundItems,
    unattributed: {
      count: unattributed.length,
      ids: unattributed.slice(),
    },
    note: roundPresent
      ? '原答与协助属性按保存原文读回；有协助作答不构成独立证据，待复核作答保持待复核身份。'
      + (unattributed.length > 0 ? '另有 ' + unattributed.length + ' 条无轮次归属的历史作答，单独保留，不并入本轮。' : '')
      : '没有可续接轮次，本轮作答范围未知；无归属作答如实单独保留。',
  };
}

function resumeGaps(round, review, quality) {
  const needsWork = [];
  const progress = resumeIsRecord(round) && resumeIsRecord(round.progress) ? round.progress : null;
  if (progress && Array.isArray(progress.mastery)) {
    progress.mastery.forEach((entry) => {
      if (resumeIsRecord(entry) && entry.status === 'needs-work') {
        needsWork.push({ conceptId: entry.conceptId, status: entry.status });
      }
    });
  }
  const dueNow = [];
  if (resumeIsRecord(review) && Array.isArray(review.allDue)) {
    review.allDue.forEach((due) => {
      if (resumeIsRecord(due) && due.dueNow) {
        dueNow.push({ promptId: due.promptId ?? null, conceptId: due.conceptId ?? null, dueAt: due.dueAt ?? null });
      }
    });
  }
  const deferredTaskIds = progress && Array.isArray(progress.deferredTaskIds) ? progress.deferredTaskIds.slice() : [];
  const qualityBlockingGaps = [];
  if (resumeIsRecord(quality) && resumeIsRecord(quality.concepts)) {
    Object.keys(quality.concepts).forEach((conceptId) => {
      const record = quality.concepts[conceptId];
      if (!resumeIsRecord(record) || !Array.isArray(record.gaps)) return;
      const blocking = record.gaps.filter((gap) => resumeIsRecord(gap) && gap.effect === 'blocking').length;
      if (blocking > 0) qualityBlockingGaps.push({ conceptId, gapCount: blocking });
    });
  }
  const present = needsWork.length > 0 || dueNow.length > 0 || deferredTaskIds.length > 0 || qualityBlockingGaps.length > 0;
  return {
    present,
    needsWorkConcepts: needsWork,
    dueNow,
    deferredTaskIds,
    qualityBlockingGaps,
    note: present
      ? '缺口只统计当前内容仍有效的记录；历史缺口随原内容保留，不自动成为当前缺口。'
      : '当前没有仍有效的缺口记录；这不表示已掌握，只表示没有可核对的未决缺口。',
  };
}

function resumeMaterialScope(quality) {
  if (!resumeIsRecord(quality) || quality.present !== true) {
    return {
      present: false,
      stale: false,
      staleReasons: [],
      counts: null,
      sources: [],
      note: '未写入质检记录（quality.json），材料核对范围未知；恢复讲解前需按目标重新核对相关原文。',
    };
  }
  const map = resumeIsRecord(quality.materialMap) ? quality.materialMap : null;
  return {
    present: true,
    stale: quality.stale === true,
    staleReasons: Array.isArray(quality.staleReasons) ? quality.staleReasons.slice() : [],
    coverageKnown: Boolean(map && map.coverageKnown),
    counts: map && resumeIsRecord(map.counts) ? resumeClone(map.counts) : null,
    sources: map && Array.isArray(map.sources) ? map.sources.map((source) => ({
      sourceId: source.sourceId ?? null,
      declared: source.declared !== false,
      title: source.sourceTitle ?? null,
      versionKnown: source.versionKnown === true,
      version: source.version ?? null,
      checkedCount: Array.isArray(source.checked) ? source.checked.length : 0,
      unreadCount: Array.isArray(source.unread) ? source.unread.length : 0,
      gapCount: Array.isArray(source.gaps) ? source.gaps.length : 0,
      coverageKnown: source.coverageKnown === true,
      inCurrentModel: source.inCurrentModel !== false,
      stale: source.stale === true,
    })) : [],
    note: quality.stale === true
      ? '质检记录相对当前内容已失效：历史结论保留但不再自动适用，恢复讲解前重新核对受影响部分。'
      : '材料核对范围按保存记录读回；范围之外的内容仍是未核实状态。',
  };
}

function resumeCorrections(corrections) {
  if (!resumeIsRecord(corrections) || corrections.present !== true) {
    return {
      present: false,
      total: 0,
      items: [],
      note: '没有教学纠错记录（旧档或未发生纠错）；这不表示讲解从未出错，只表示档案中没有已保存的纠错。',
    };
  }
  let invalidated = 0;
  const items = (corrections.corrections || []).map((record) => {
    const evidenceEntries = [];
    (Array.isArray(record.impacts) ? record.impacts : []).forEach((impact) => {
      (Array.isArray(impact.evidence) ? impact.evidence : []).forEach((entry) => evidenceEntries.push(entry));
    });
    const invalid = evidenceEntries.filter((entry) => resumeIsRecord(entry) && entry.current === false).length;
    invalidated += invalid;
    return {
      id: record.id,
      at: record.at ?? null,
      claim: record.claim ?? null,
      correction: record.correction ?? null,
      basis: record.basis ?? null,
      impactCount: Array.isArray(record.impacts) ? record.impacts.length : 0,
      recheckCount: Array.isArray(record.rechecks) ? record.rechecks.length : 0,
      invalidatedEvidence: invalid,
    };
  });
  return {
    present: true,
    total: items.length,
    items,
    invalidatedEvidence: invalidated,
    note: '纠错历史按追加记录读回；引用的证据已失效时如实计数，原答与协助属性不受影响。',
  };
}

// Saved-vs-current drift, as facts only: the readback never rewrites history
// or re-plans a route. Each detected change lists what was saved, what is
// current now, and how much preserved evidence is no longer current.
//
// The raw saved-vs-current comparisons here ARE the report's subject (the
// changes section exists to name them, separating goal drift from fingerprint
// drift, which the round view's combined `stale` flag deliberately does not).
// No rule is re-derived: staleness verdicts shown elsewhere are copied from
// the home views, and evidence validity comes in via `evidenceValidity`.
function resumeChanges(evidenceValidity, model, round, quality) {
  const goalScopes = [];
  const contentScopes = [];
  if (resumeIsRecord(round) && resumeIsRecord(round.opening)) {
    ['preliminary', 'calibrated'].forEach((key) => {
      const scope = round.opening[key];
      if (!resumeIsRecord(scope)) return;
      if (scope.goal !== round.goal) {
        goalScopes.push({ where: 'opening.' + key, savedGoal: scope.goal, currentGoal: round.goal });
      }
      if (scope.modelFingerprint && scope.modelFingerprint !== model.modelFingerprint) {
        contentScopes.push({ where: 'opening.' + key, savedFingerprint: scope.modelFingerprint, currentFingerprint: model.modelFingerprint });
      }
    });
  }
  // Rounds without an opening snapshot (organize-existing-material, older
  // archives) still record their goal in the append-only round history, so a
  // goal edit remains detectable there instead of silently invisible.
  if (resumeIsRecord(round) && Array.isArray(round.history)) {
    round.history.forEach((entry, index) => {
      if (!resumeIsRecord(entry) || typeof entry.goal !== 'string') return;
      if (entry.goal !== round.goal) {
        goalScopes.push({ where: 'history[' + index + '] (' + (entry.action ?? 'entry') + ')', savedGoal: entry.goal, currentGoal: round.goal });
      }
    });
  }
  if (resumeIsRecord(round) && resumeIsRecord(round.progress) && resumeIsRecord(round.progress.closure)) {
    const closure = round.progress.closure;
    if (closure.goal !== round.goal) {
      goalScopes.push({ where: 'progress.closure', savedGoal: closure.goal, currentGoal: round.goal });
    }
    if (closure.modelFingerprint && closure.modelFingerprint !== model.modelFingerprint) {
      contentScopes.push({ where: 'progress.closure', savedFingerprint: closure.modelFingerprint, currentFingerprint: model.modelFingerprint });
    }
  }
  const tasks = resumeIsRecord(round) && Array.isArray(round.tasks) ? round.tasks : [];
  const affectedTasks = tasks
    .filter((task) => resumeIsRecord(task) && task.contentUpdated === true)
    .map((task) => task.id);
  const staleSubmissions = tasks.reduce((sum, task) => {
    return sum + (resumeIsRecord(task) && typeof task.staleSubmissions === 'number' ? task.staleSubmissions : 0);
  }, 0);
  const validity = resumeIsRecord(evidenceValidity) ? evidenceValidity : null;
  const invalidated = { concepts: 0, prompts: 0, ids: [] };
  if (resumeIsRecord(validity)) {
    ['concepts', 'prompts'].forEach((bucket) => {
      Object.keys(validity[bucket] || {}).forEach((id) => {
        if (validity[bucket][id] === false) {
          invalidated[bucket] += 1;
          invalidated.ids.push(bucket + ':' + id);
        }
      });
    });
  }
  const goalChanged = { detected: goalScopes.length > 0, scopes: goalScopes };
  const contentChanged = {
    detected: contentScopes.length > 0 || affectedTasks.length > 0 || invalidated.ids.length > 0,
    scopes: contentScopes,
    affectedTasks,
    staleSubmissions,
    invalidatedEvidence: invalidated,
  };
  const materialScopeStale = {
    detected: resumeIsRecord(quality) && quality.present === true && quality.stale === true,
    reasons: resumeIsRecord(quality) && Array.isArray(quality.staleReasons) ? quality.staleReasons.slice() : [],
  };
  return {
    detected: goalChanged.detected || contentChanged.detected || materialScopeStale.detected,
    goalChanged,
    contentChanged,
    materialScopeStale,
    note: RESUME_CHANGES_NOTE,
  };
}

/**
 * Assemble the unified resume readback. `input` carries the raw archive plus
 * every host-computed view: `roundView` (learningRoundView), `rounds` (per-round
 * summary list), `review` (reviewPlan), `quality` (qualityView or null),
 * `corrections` (teachingCorrectionsView or null), `attemptActivity`
 * ({attemptId -> boolean} from state.mjs isAttemptActive) and
 * `evidenceValidity` ({concepts, prompts} maps of id -> current). The result is
 * read-only: no field of `state` or `model` is modified, and nothing here
 * writes files.
 */
export function resumeReadback(input) {
  if (!resumeIsRecord(input)) throw new Error('resumeReadback 输入必须是对象');
  const { state, model, at, roundView, rounds, review, quality, corrections, attemptActivity, evidenceValidity } = input;
  if (!resumeIsRecord(state) || !resumeIsRecord(model)) throw new Error('resumeReadback 需要 state 与 model');
  const round = resumeIsRecord(roundView) ? roundView : null;
  return {
    readOnly: true,
    at: at ?? null,
    identity: {
      modelId: model.id ?? null,
      modelTitle: model.title ?? null,
      modelFingerprint: model.modelFingerprint ?? null,
    },
    activeRoundId: typeof state.activeRoundId === 'string' ? state.activeRoundId : null,
    requestedRoundId: typeof input.roundId === 'string' ? input.roundId : null,
    rounds: Array.isArray(rounds) ? resumeClone(rounds) : [],
    roundPresent: round !== null,
    round: round
      ? {
        id: round.id ?? null,
        entry: round.entry ?? null,
        goal: round.goal ?? null,
        conceptIds: Array.isArray(round.conceptIds) ? round.conceptIds.slice() : [],
        budgetMinutes: round.budgetMinutes ?? null,
        status: round.status ?? null,
        storedStatus: round.storedStatus ?? null,
        resumeStatus: round.resumeStatus ?? null,
        createdAt: round.createdAt ?? null,
        updatedAt: round.updatedAt ?? null,
      }
      : null,
    profile: resumeLearnerProfile(round ? round.opening : null),
    goalAndBudget: resumeGoalAndBudget(round),
    position: resumePosition(round),
    interactions: resumeInteractions(round),
    answers: resumeAnswers(state, model, round, attemptActivity),
    gaps: resumeGaps(round, review, quality),
    materialScope: resumeMaterialScope(quality),
    corrections: resumeCorrections(corrections),
    changes: resumeChanges(evidenceValidity, model, round, quality),
    persistence: {
      archive: 'state.json',
      note: RESUME_PERSISTENCE_NOTE,
    },
  };
}
