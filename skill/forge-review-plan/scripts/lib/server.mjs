import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { EmberError, CODES, isRecord } from './errors.mjs';
import { assertLearningOutput } from './output-paths.mjs';
import { fileExists, nowIso, parseJson, readJson } from './io.mjs';
import { modelToJson, normalizeModel } from './model.mjs';
import { archiveLockDirs, archivePathFor, readArchive, withArchiveLock, writeArchiveState } from './archive.mjs';
import {
  applyAttempt,
  applySubmission,
  applyAssessment,
  applyInteractionPosition,
  applyLearningRound,
  applyPractice,
  applyCorrection,
  applyNote,
  applyOwnQuestion,
  applyRelationRevision,
  applyTitleRevision,
  createState,
  listDue,
  mergeImportedState,
  normalizeState,
} from './state.mjs';
import { stateResponse, DEFAULT_OUT_FILES } from './build.mjs';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ACTION_ROUTES = new Set(['note', 'title', 'relation', 'question', 'attempt', 'submit', 'assessment', 'practice', 'correction', 'import', 'round', 'interaction']);

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.excalidraw': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
});

// Only these logical paths are served. Everything else, including traversal
// attempts, falls through to 404 without ever touching the filesystem path.
const STATIC_ROUTES = Object.freeze({
  '/': DEFAULT_OUT_FILES.html,
  [`/${DEFAULT_OUT_FILES.html}`]: DEFAULT_OUT_FILES.html,
  [`/${DEFAULT_OUT_FILES.model}`]: DEFAULT_OUT_FILES.model,
  [`/${DEFAULT_OUT_FILES.state}`]: DEFAULT_OUT_FILES.state,
  [`/${DEFAULT_OUT_FILES.scene}`]: DEFAULT_OUT_FILES.scene,
  [`/${DEFAULT_OUT_FILES.svg}`]: DEFAULT_OUT_FILES.svg,
  [`/${DEFAULT_OUT_FILES.quality}`]: DEFAULT_OUT_FILES.quality,
});

class HttpError extends EmberError {
  constructor(status, code, message, extra) {
    super(code, message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES['.json'],
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendError(res, status, code, message, extra) {
  sendJson(res, status, { error: message, code, ...(extra ?? {}) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, CODES.USAGE, `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        // Drain the rest so the connection is not left half-read; the response
        // is sent by the handler once this promise rejects.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(new HttpError(400, CODES.IO, `读取请求失败：${err.message}`)));
    req.on('aborted', () => fail(new HttpError(400, CODES.IO, '连接在请求完成前中断')));
  });
}

// Loopback detection for both the bind address and request headers. The
// service is only ever reachable from the local machine, so Host/Origin checks
// must compare against that loopback address instead of trusting one request
// header to validate another.
function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(value);
}

// Same-origin: the Host being served must be a loopback address on the port we
// actually bound. When a browser sends Origin (all cross-origin and non-GET
// requests do), it must also be an http origin on that same loopback host/port.
// Non-browser loopback clients without an Origin are still confined by the bind.
// A URL.host port is empty when it is the scheme default (80 for http).
// Normalize so a bound :80 matches an implicit-port Host/Origin header.
function normalizedPort(url) {
  if (url.port) return String(Number(url.port));
  return url.protocol === 'https:' ? '443' : '80';
}

function sameOrigin(req, bound) {
  const expectedPort = String(Number(bound.port));
  const host = req.headers.host;
  if (!host) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.protocol !== 'http:' || !isLoopbackHostname(hostUrl.hostname) || normalizedPort(hostUrl) !== expectedPort) {
    return false;
  }
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' || !isLoopbackHostname(originUrl.hostname) || normalizedPort(originUrl) !== expectedPort) {
    return false;
  }
  return true;
}

function parseAction(pathname) {
  const match = /^\/api\/([a-z]+)$/.exec(pathname);
  if (!match) return null;
  return match[1];
}

export function createEmberServer(options) {
  const dir = options.dir;
  if (!dir) throw new EmberError(CODES.USAGE, 'serve 需要 --out <输出目录>');
  const outDir = assertLearningOutput(dir, '--out');
  const bound = { host: options.host ?? '127.0.0.1', port: options.port ?? 0 };
  const modelPath = options.modelPath ?? path.join(outDir, DEFAULT_OUT_FILES.model);
  const statePath = archivePathFor(assertLearningOutput(options.statePath ?? path.join(outDir, DEFAULT_OUT_FILES.state), '--state'));
  const now = options.now ?? nowIso;

  function readModel() {
    return normalizeModel(readJson(modelPath, `模型文件 ${modelPath}`));
  }

  function readState(model) {
    // normalizeState migrates a version-1 archive in memory; read-only
    // endpoints never write, so no backup is needed here.
    if (!fileExists(statePath)) return createState(model, now());
    return normalizeState(parseJson(fs.readFileSync(statePath, 'utf8'), `状态文件 ${statePath}`), model);
  }

  function readStateForWrite(model) {
    const archive = readArchive(statePath, model);
    if (!archive.exists) return { state: createState(model, now()), wasV1: false, rawText: null };
    return { state: archive.state, wasV1: archive.wasV1, rawText: archive.rawText };
  }

  function writeState(state, { wasV1 = false, rawText = null } = {}) {
    writeArchiveState(statePath, state, { wasV1, rawText });
  }

  function respondState(res, model, state) {
    sendJson(res, 200, stateResponse(model, state));
  }

  // Every mutation runs through this queue: read fresh model + state, check
  // revision/fingerprint, apply, write. Nothing else can interleave, so the
  // revision check and the write are one atomic critical section.
  let tail = Promise.resolve();
  function serialize(task) {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  function dispatch(name, model, state, body, at) {
    switch (name) {
      case 'note':
        return applyNote(state, model, { conceptId: body.conceptId, kind: body.kind, text: body.text }, at).state;
      case 'title':
        return applyTitleRevision(state, model, { conceptId: body.conceptId, title: body.title }, at).state;
      case 'relation':
        return applyRelationRevision(state, model, { relationId: body.relationId, label: body.label }, at).state;
      case 'question':
        return applyOwnQuestion(state, model, { conceptId: body.conceptId, text: body.text, id: body.id }, at).state;
      case 'practice':
        return applyPractice(state, model, { ...body, source: 'browser' }, at).state;
      case 'submit':
        return applySubmission(state, model, { ...body, source: 'browser' }, at).state;
      case 'round':
        // The page never sets tutor identity; a round operation only shapes the
        // learner's own route and can never mint mastery or tutor evidence.
        return applyLearningRound(state, model, { ...body, source: 'browser' }, at).state;
      case 'interaction':
        // A walkthrough position is learner observation only: it writes the
        // current step and its content version, never an attempt, rating, hint
        // or mastery evidence, and the page can never set tutor identity.
        return applyInteractionPosition(state, model, { ...body, source: 'browser' }, at).state;
      case 'assessment':
        return applyAssessment(state, model, { ...body, source: 'browser' }, at).state;
      case 'attempt': {
        // The old combined answer/rating route remains available. A missing
        // rating saves an original; a rating can assess a saved new-format original.
        if (body.rating === undefined || body.rating === null) return applySubmission(state, model, { ...body, source: 'browser' }, at).state;
        const saved = (state.attempts[body.promptId] ?? []).find((a) => a.id === body.attemptId);
        if (saved?.rating === null || saved?.assessment) return applyAssessment(state, model, { ...body, source: 'browser' }, at).state;
        return applyAttempt(state, model, {
          promptId: body.promptId,
          attemptId: body.attemptId,
          answer: body.answer,
          rating: body.rating,
          assisted: body.assisted,
          source: 'browser',
        }, at).state;
      }
      case 'correction':
        return applyCorrection(state, model, { ...body, source: 'browser' }, at).state;
      case 'import': {
        if (!isRecord(body.state)) {
          throw new HttpError(400, CODES.USAGE, 'import 需要 {state: ...} 形式的导入状态');
        }
        const incoming = JSON.parse(JSON.stringify(body.state));
        // A browser session may submit notes/attempts/edits, but mastery evidence
        // is tutor-reviewed and agent-side only. Dropping imported evidence keeps
        // the existing結論 and leaves newly imported proof pending review.
        delete incoming.conceptEvidence;
        delete incoming.promptEvidence;
        // Schedules are derived from accepted assessments, not imported claims.
        // Otherwise an untrusted file could bypass the tutor-event filter by
        // presenting the forged result directly as an incoming arrangement.
        delete incoming.schedules;
        // Review requests are agent-side records created only by the public
        // `review-start` CLI. A browser import may never mint a request, adopt a
        // forged one, or smuggle in a forged "completed" tutor result: the whole
        // bucket is dropped and the existing requests are kept.
        delete incoming.reviewRequests;
        // Teaching corrections are agent-side records for the same reason: they
        // name what the teacher re-checked and which answers were misled. A
        // browser import may never fabricate that history; the existing
        // corrections are kept.
        delete incoming.teachingCorrections;
        // Tutor ratings are as privileged as mastery evidence. Browser imports
        // may carry learner history, but only an agent-side review can publish
        // a new trusted tutor assessment or its associated feedback.
        for (const list of Object.values(incoming.attempts ?? {})) {
          if (!Array.isArray(list)) continue;
          for (const attempt of list) {
            if (!isRecord(attempt)) continue;
            delete attempt.tutorAssessments;
            delete attempt.tutorFeedback;
          }
        }
        return mergeImportedState(state, incoming, model, at);
      }
      default:
        throw new HttpError(404, CODES.SERVER, `未知操作：${name}`);
    }
  }

  async function handlePost(req, res, name, rawBody) {
    await serialize(async () => {
      // The in-process queue orders requests; the archive lock extends the same
      // coordination boundary across processes so a concurrent CLI review or
      // build can never interleave with this read→apply→write cycle.
      await withArchiveLock(archiveLockDirs(outDir, statePath, modelPath), async () => {
      const model = readModel();
      const current = readStateForWrite(model);
      const state = current.state;
      let body;
      try {
        body = rawBody === '' ? {} : JSON.parse(rawBody);
      } catch (err) {
        throw new HttpError(400, CODES.IO, `请求体不是合法 JSON：${err.message}`);
      }
      if (!isRecord(body)) throw new HttpError(400, CODES.USAGE, '请求体必须是 JSON 对象');

      // ui-contract requires both revision and modelFingerprint on every POST.
      // The fingerprint is a required guard, not an optional one: accepting an
      // absent fingerprint would let a stale client mutate changed content.
      if (typeof body.modelFingerprint !== 'string' || body.modelFingerprint.trim() === '') {
        throw new HttpError(400, CODES.USAGE,
          '请求缺少 modelFingerprint；请重新加载页面后再提交，草稿会保留');
      }
      if (body.modelFingerprint !== model.modelFingerprint || state.modelFingerprint !== model.modelFingerprint) {
        throw new HttpError(409, CODES.CONFLICT, '学习模型已更新，请载入新内容后再提交；草稿会保留',
          { ...stateResponse(model, state), modelChanged: true });
      }
      if (body.revision !== state.revision) {
        throw new HttpError(409, CODES.CONFLICT,
          `状态 revision 不匹配（服务器 ${state.revision}，请求 ${JSON.stringify(body.revision)}），请基于最新状态重试`,
          stateResponse(model, state));
      }

      const at = now();
      let next;
      try {
        next = dispatch(name, model, state, body, at);
      } catch (err) {
        // A duplicate attempt id (or similar replay) is still a useful 409:
        // include the durable state so a retrying client can acknowledge it.
        if (err instanceof EmberError && err.code === CODES.CONFLICT) {
          throw new HttpError(409, err.code, err.message, stateResponse(model, state));
        }
        throw err;
      }
      writeState(next, { wasV1: current.wasV1, rawText: current.rawText });
      respondState(res, model, next);
      });
    });
  }

  function handleStatic(res, logicalName) {
    const filePath = path.join(outDir, logicalName);
    // Defense in depth: the allowlist above already guarantees logicalName is a
    // bare filename with no separators.
    if (path.dirname(path.resolve(filePath)) !== outDir) {
      throw new HttpError(404, CODES.SERVER, '路径不在服务目录内');
    }
    if (!fileExists(filePath)) throw new HttpError(404, CODES.SERVER, `文件不存在：${logicalName}`);
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(logicalName)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (!sameOrigin(req, bound)) {
        sendError(res, 403, CODES.SERVER, '拒绝跨源请求');
        return;
      }
      const pathname = url.pathname;

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/api/model') {
          sendJson(res, 200, modelToJson(readModel()));
          return;
        }
        if (pathname === '/api/state') {
          const model = readModel();
          const state = readState(model);
          respondState(res, model, state);
          return;
        }
        if (pathname === '/api/due') {
          const model = readModel();
          const state = readState(model);
          sendJson(res, 200, listDue(state, model, now()));
          return;
        }
        if (pathname.startsWith('/api/')) {
          sendError(res, 404, CODES.SERVER, `未知接口：${pathname}`);
          return;
        }
        const logicalName = STATIC_ROUTES[pathname];
        if (!logicalName) {
          sendError(res, 404, CODES.SERVER, `未找到：${pathname}`);
          return;
        }
        handleStatic(res, logicalName);
        return;
      }

      if (req.method === 'POST') {
        const name = parseAction(pathname);
        if (!name || !ACTION_ROUTES.has(name)) {
          sendError(res, 404, CODES.SERVER, `未知接口：${pathname}`);
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '');
        if (!contentType.toLowerCase().includes('application/json')) {
          sendError(res, 415, CODES.USAGE, 'POST 请求必须使用 application/json');
          req.resume();
          return;
        }
        const rawBody = await readBody(req);
        await handlePost(req, res, name, rawBody);
        return;
      }

      sendError(res, 405, CODES.SERVER, `不支持的方法：${req.method}`);
      req.resume();
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, err.extra);
        return;
      }
      if (err instanceof EmberError) {
        const status = err.code === CODES.CONFLICT || err.code === CODES.IDENTITY ? 409 : 400;
        let extra;
        if (status === 409) {
          try {
            const model = readModel();
            extra = stateResponse(model, readState(model));
          } catch { /* report the original conflict if the archive is unreadable */ }
        }
        sendError(res, status, err.code, err.message, extra);
        return;
      }
      sendError(res, 500, CODES.SERVER, `服务器内部错误：${err.message}`);
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, 500, CODES.SERVER, `服务器内部错误：${err.message}`);
    });
  });
  // startServer updates the actual ephemeral port in place after listen().
  server.bound = bound;
  return server;
}

export function startServer(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  if (!isLoopbackHostname(host)) {
    return Promise.reject(new EmberError(CODES.USAGE,
      `拒绝绑定非环回地址 ${host}；forge 服务只允许在本机环回地址运行`));
  }
  const server = createEmberServer({ ...options, host, port });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      server.bound.port = actualPort;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        dir: path.resolve(options.dir),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
