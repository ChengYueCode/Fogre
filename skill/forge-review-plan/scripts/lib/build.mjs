import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmberError, CODES } from './errors.mjs';
import {
  atomicWrite,
  fileExists,
  readJson,
  stableStringify,
  writeIfChanged,
} from './io.mjs';
import { modelToJson, normalizeModel } from './model.mjs';
import {
  createState,
  promptFingerprint,
  stateView,
  syncModel,
} from './state.mjs';
import { archivePathFor, readArchive, writeArchiveState } from './archive.mjs';
import { layoutTree } from './layout.mjs';
import { buildScene, sceneToSvg } from './scene.mjs';
import { QUALITY_FILE, qualityView, readQualityFile } from './quality.mjs';
import { presentationCss } from './presentation.mjs';

export const PAYLOAD_PLACEHOLDER = '__EMBER_PAYLOAD__';
// The standalone viewer ships the same pure round algorithm the backend uses.
// build inlines lib/round.mjs here (with its `export ` keywords stripped) so a
// portable page and the Node backend never diverge on route logic.
export const ROUND_LIBRARY_PLACEHOLDER = '/*__EMBER_ROUND_LIBRARY__*/';
// Same contract for the schedule/assessment algorithm: the page inlines
// lib/schedule.mjs so replay, the tutor-over-self precedence rule and the
// transparent spacing table run once for both the Node backend and the browser.
export const SCHEDULE_LIBRARY_PLACEHOLDER = '/*__EMBER_SCHEDULE_LIBRARY__*/';
// The concentrated tutor-review read model ships to the page the same way: the
// viewer recomputes `tutorReviewSummary` from the loaded state so it can never
// diverge from the backend's pending counts or status rules.
export const TUTOR_REVIEW_LIBRARY_PLACEHOLDER = '/*__EMBER_TUTOR_REVIEW_LIBRARY__*/';
// The teaching-interaction read model ships the same way: the viewer locates a
// concept's configured comparison component and renders the shared view so the
// page and the backend never diverge on configuration or knowledge rules.
export const INTERACTIONS_LIBRARY_PLACEHOLDER = '/*__EMBER_INTERACTIONS_LIBRARY__*/';
// The insight/note read model ships the same way: the viewer renders its own
// notes and historical versions from the shared library, so browser and Node
// never disagree on history validation, merging or stale-answer marking.
export const INSIGHTS_LIBRARY_PLACEHOLDER = '/*__EMBER_INSIGHTS_LIBRARY__*/';
// The teaching-correction read model ships the same way: the viewer validates,
// merges and renders correction history with the shared library, so an
// imported or cached archive is judged by exactly the rules the backend runs.
export const CORRECTIONS_LIBRARY_PLACEHOLDER = '/*__EMBER_CORRECTIONS_LIBRARY__*/';
export const DEFAULT_OUT_FILES = Object.freeze({
  model: 'model.json',
  state: 'state.json',
  scene: 'map.excalidraw',
  html: 'index.html',
  svg: 'map.svg',
  quality: QUALITY_FILE,
});

/**
 * Collect the fingerprints the viewer/server use to decide whether an attempt
 * still belongs to the current content. Model prompts come from the normalized
 * model; learner-authored questions are recomputed through the same core
 * helper so a learner question and a model prompt cannot drift apart.
 */
export function collectPromptFingerprints(model, state) {
  const fingerprints = Object.create(null);
  for (const [id, value] of Object.entries(model.promptFingerprints ?? {})) {
    fingerprints[id] = value;
  }
  for (const question of Object.values(state.ownQuestions ?? {})) {
    const value = promptFingerprint(model, state, question.id);
    if (value) fingerprints[question.id] = value;
  }
  return fingerprints;
}

/**
 * The state response shared by the CLI/server. Kept in one place so `build`
 * payloads and HTTP responses can never diverge on ui-contract.
 */
export function stateResponse(model, state, view = stateView(state, model)) {
  return {
    state,
    view,
    modelFingerprint: model.modelFingerprint,
    promptFingerprints: collectPromptFingerprints(model, state),
    conceptFingerprints: { ...model.conceptFingerprints },
    // The agent-side review records travel with the payload so the page can show
    // frozen requests and reconciliation can keep them across a rebuild. The page
    // never mints a request; it only renders what the CLI published.
    reviewRequests: state.reviewRequests ?? {},
  };
}

// JSON placed inside <script type="application/json"> must not be able to close
// the tag or introduce line terminators that break parsing.
export function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderViewerHtml(template, payload) {
  if (!template.includes(PAYLOAD_PLACEHOLDER)) {
    throw new EmberError(CODES.IO, `学习页模板缺少唯一占位符 ${PAYLOAD_PLACEHOLDER}`);
  }
  if (template.split(PAYLOAD_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${PAYLOAD_PLACEHOLDER} 必须恰好出现一次`);
  }
  const withLibraries = injectScheduleLibrary(injectRoundLibrary(template));
  const withTutorReview = injectTutorReviewLibrary(withLibraries);
  const withInteractions = injectInteractionsLibrary(withTutorReview);
  const withInsights = injectInsightsLibrary(withInteractions);
  const withCorrections = injectCorrectionsLibrary(withInsights);
  const styled = withCorrections.replace('/*__FORGE_PRESENTATION__*/', () => presentationCss(payload.model));
  return styled.replace(PAYLOAD_PLACEHOLDER, () => safeJsonForHtml(payload));
}

/**
 * Inline the portable round library into a viewer template at the round-library
 * marker. A template without the marker (an older or minimal test template) is
 * returned unchanged, so existing callers keep working.
 */
export function injectRoundLibrary(template, source = null) {
  if (!template.includes(ROUND_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(ROUND_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${ROUND_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(ROUND_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'round.mjs', '轮次逻辑'));
}

/**
 * Inline the portable schedule/assessment library into a viewer template at its
 * marker. Like the round library it must stay dependency-free, so the same
 * `schedule*` helpers the Node backend imports run inside the page IIFE. A
 * template without the marker (an older or minimal test template) is returned
 * unchanged.
 */
export function injectScheduleLibrary(template, source = null) {
  if (!template.includes(SCHEDULE_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(SCHEDULE_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${SCHEDULE_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(SCHEDULE_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'schedule.mjs', '评价与复习逻辑'));
}

/**
 * Inline the portable tutor-review library into a viewer template at its
 * marker. Like the round and schedule libraries it must stay dependency-free so
 * the page runs the same `tutorReviewSummary` the backend imports. A template
 * without the marker is returned unchanged.
 */
export function injectTutorReviewLibrary(template, source = null) {
  if (!template.includes(TUTOR_REVIEW_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(TUTOR_REVIEW_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${TUTOR_REVIEW_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(TUTOR_REVIEW_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'tutor-review.mjs', '集中复核逻辑'));
}

/**
 * Inline the portable teaching-interaction library into a viewer template at
 * its marker. Like the round/schedule/tutor-review libraries it must stay
 * dependency-free so the page runs the same `interactionForConcept` /
 * `interactionComparisonView` helpers the Node backend imports (nothing from a
 * material script is ever evaluated). A template without the marker is returned
 * unchanged.
 */
export function injectInteractionsLibrary(template, source = null) {
  if (!template.includes(INTERACTIONS_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(INTERACTIONS_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${INTERACTIONS_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(INTERACTIONS_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'interactions.mjs', '教学互动逻辑'));
}

/**
 * Inline the portable insight-note library into a viewer template at its
 * marker. Like the other shared libraries it must stay dependency-free so the
 * page runs the same history validation and read model the backend imports. A
 * template without the marker is returned unchanged.
 */
export function injectInsightsLibrary(template, source = null) {
  if (!template.includes(INSIGHTS_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(INSIGHTS_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${INSIGHTS_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(INSIGHTS_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'insights.mjs', '洞见与速查逻辑'));
}

/**
 * Inline the portable teaching-correction library into a viewer template at
 * its marker. Like the other shared libraries it must stay dependency-free so
 * the page validates, merges and renders correction history with the exact
 * rules the backend imports. A template without the marker is returned
 * unchanged.
 */
export function injectCorrectionsLibrary(template, source = null) {
  if (!template.includes(CORRECTIONS_LIBRARY_PLACEHOLDER)) return template;
  if (template.split(CORRECTIONS_LIBRARY_PLACEHOLDER).length !== 2) {
    throw new EmberError(CODES.IO, `学习页模板中的 ${CORRECTIONS_LIBRARY_PLACEHOLDER} 必须恰好出现一次`);
  }
  return template.replace(CORRECTIONS_LIBRARY_PLACEHOLDER, () => inlineLibrary(source, 'corrections.mjs', '教学纠错逻辑'));
}

function inlineLibrary(source, fileName, label) {
  let library = source;
  if (library === null) {
    const libraryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), fileName);
    try {
      library = fs.readFileSync(libraryPath, 'utf8');
    } catch (err) {
      throw new EmberError(CODES.IO, `无法读取${label} ${libraryPath}：${err.message}`);
    }
  }
  // Strip only a leading `export ` on a declaration so the inlined functions
  // share the viewer IIFE's scope; everything else (comments, strings) is kept.
  return String(library).replace(/^export /gm, '');
}

function readExistingState(filePath, model) {
  // Archive-aware read: a version-1 archive is migrated in memory and the
  // original bytes are carried along so the write step can back it up.
  const archive = readArchive(filePath, model);
  if (!archive.exists) return { state: createState(model), wasV1: false, rawText: null };
  return { state: archive.state, wasV1: archive.wasV1, rawText: archive.rawText };
}

function readExistingScene(filePath) {
  if (!fileExists(filePath)) return null;
  const raw = readJson(filePath, `场景文件 ${filePath}`);
  // buildScene performs the structural validation; this check only makes the
  // failure path an explicit scene error rather than a generic merge crash.
  return raw;
}

/**
 * Deterministically build every artifact for one learning model.
 *
 * All inputs are read and validated before a single output is written, so a
 * malformed model/state/scene leaves any previous build untouched.
 */
export function buildArtifacts(options) {
  const outDir = options.outDir;
  if (!outDir) throw new EmberError(CODES.USAGE, 'build 需要 --out <输出目录>');
  const modelPath = options.modelPath;
  if (!modelPath) throw new EmberError(CODES.USAGE, 'build 需要模型文件路径');

  const statePath = archivePathFor(options.statePath ?? path.join(outDir, DEFAULT_OUT_FILES.state));
  const scenePath = options.scenePath ?? path.join(outDir, DEFAULT_OUT_FILES.scene);
  const viewerPath = options.viewerPath;
  if (!viewerPath) throw new EmberError(CODES.USAGE, 'build 缺少学习页模板路径（脚本内部错误）');

  const rawModel = readJson(modelPath, `模型文件 ${modelPath}`);
  const model = normalizeModel(rawModel);

  const previousState = readExistingState(statePath, model);
  const synced = syncModel(previousState.state, model, options.at);
  const state = synced.state;
  const previousWasV1 = previousState.wasV1;
  const previousRawText = previousState.rawText;

  const previousScene = readExistingScene(scenePath);
  const sceneResult = buildScene(model, state, previousScene);
  const scene = sceneResult.scene;

  // The author quality record is read for the view only: build never writes or
  // rewrites quality.json, and a stale record keeps its historical conclusions
  // with explicit recheck reasons instead of being dropped or auto-passed.
  const qualityPath = path.join(outDir, QUALITY_FILE);
  let quality = null;
  let qualityDoc = null;
  if (fileExists(qualityPath)) {
    qualityDoc = readQualityFile(qualityPath, model);
    quality = qualityView(qualityDoc, model);
  }

  const layout = layoutTree(model, {
    resolveTitle: (concept) => state.conceptRevisions?.[concept.id]?.title ?? concept.title,
  });
  const view = stateView(state, model);
  const promptFingerprints = collectPromptFingerprints(model, state);

  const payload = {
    model: modelToJson(model),
    state,
    layout,
    view,
    modelFingerprint: model.modelFingerprint,
    promptFingerprints,
    conceptFingerprints: { ...model.conceptFingerprints },
    reviewRequests: state.reviewRequests ?? {},
    quality,
  };

  // Read the template before writing any output.
  let template;
  try {
    template = fs.readFileSync(viewerPath, 'utf8');
  } catch (err) {
    throw new EmberError(CODES.IO, `无法读取学习页模板 ${viewerPath}：${err.message}`);
  }
  const html = renderViewerHtml(template, payload);

  const modelJson = stableStringify(modelToJson(model));
  const stateJson = stableStringify(state);
  const sceneJson = stableStringify(scene);
  const svg = options.svg ? sceneToSvg(scene) : null;

  const written = {};
  written.model = writeIfChanged(path.join(outDir, DEFAULT_OUT_FILES.model), modelJson);
  // An upgraded version-1 archive is always rewritten (the migrated format
  // differs) after the verbatim pre-upgrade copy has been kept.
  if (previousWasV1) {
    writeArchiveState(statePath, state, { wasV1: true, rawText: previousRawText });
    written.state = true;
  } else {
    written.state = writeIfChanged(statePath, stateJson);
  }
  written.scene = writeIfChanged(scenePath, sceneJson);
  // Only surface a quality entry when a record exists: builds without a
  // quality.json keep their previous output summary unchanged so existing
  // callers and tests that compare the written map stay valid.
  if (qualityDoc !== null) written.quality = false;
  written.html = writeIfChanged(path.join(outDir, DEFAULT_OUT_FILES.html), html);
  if (svg !== null) {
    written.svg = writeIfChanged(path.join(outDir, DEFAULT_OUT_FILES.svg), svg);
  }

  const warnings = [...(model.warnings ?? [])];
  for (const warning of sceneResult.warnings ?? []) warnings.push(warning.message ?? warning);

  return {
    model,
    state,
    view,
    payload,
    scene,
    sceneResult,
    html,
    files: written,
    paths: {
      outDir,
      model: path.join(outDir, DEFAULT_OUT_FILES.model),
      state: statePath,
      scene: scenePath,
      html: path.join(outDir, DEFAULT_OUT_FILES.html),
      svg: svg === null ? null : path.join(outDir, DEFAULT_OUT_FILES.svg),
      quality: qualityPath,
    },
    output: {
      html: written.html,
      model: written.model,
      state: written.state,
      scene: written.scene,
      svg: svg === null ? null : written.svg,
      ...(qualityDoc === null ? {} : { quality: written.quality }),
    },
    changed: {
      model: synced.changed,
      state: written.state,
      scene: written.scene,
      html: written.html,
      ...(qualityDoc === null ? {} : { quality: written.quality }),
    },
    conflicts: {
      model: synced.conflicts,
      scene: sceneResult.conflicts,
    },
    orphans: state.orphans ?? [],
    tombstones: sceneResult.tombstones ?? [],
    warnings,
    quality,
  };
}

export function buildSummary(result) {
  return {
    html: result.paths.html,
    model: result.paths.model,
    state: result.paths.state,
    scene: result.paths.scene,
    svg: result.paths.svg,
    quality: result.paths.quality,
    written: result.output,
    conflicts: {
      model: result.conflicts.model.length,
      scene: result.conflicts.scene.length,
    },
    orphans: result.orphans.length,
    tombstones: result.tombstones.length,
    warnings: result.warnings,
    quality: result.quality
      ? {
        present: result.quality.present,
        stale: result.quality.stale,
        goals: result.quality.goals.length,
      }
      : { present: false, stale: true, goals: 0 },
  };
}

// Kept for callers that want an explicit atomic state write without the CLI.
export function writeState(filePath, state) {
  atomicWrite(filePath, stableStringify(state));
}
