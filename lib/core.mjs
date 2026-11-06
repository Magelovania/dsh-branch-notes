/**
 * 枝条笔记 · 宿主业务逻辑（可热加载）
 *
 * 路由（全部挂在 `/api/dsh-branch-notes` 前缀下）：
 *   GET  /ping        存活探测
 *   GET  /diag        诊断：默认模型、provider 列表、静态文件时间戳、服务可见性探测
 *   GET  /models      可用模型（来自 Harness 已注册的 adapter）
 *   GET  /app         枝条笔记主页面（web/app.html）
 *   GET  /probe       自检页面（web/probe.html）
 *   POST /log         客户端日志（JSONL 追加到 ~/.dsh/branch-notes/client.log）
 *   GET  /log         读回客户端日志（调试用）
 *   POST /chat        OpenAI 兼容的流式对话（SSE；data: {...choices[0].delta.content}）
 *   POST /summarize   OpenAI 兼容的非流式补全（返回 choices[0].message.content）
 *   GET  /inbox       取出智能体待导入的 Markdown
 *   POST /inbox       智能体投放 Markdown（面板会自动导入成新剧本）
 *   POST /inbox/ack   确认已导入，宿主删除收件箱文件
 *
 * 关键点：模型调用一律走 `ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()`，
 * 凭据由 Harness 自己管理，插件永远不接触 API Key，也不需要用户填写。
 */
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 包根目录：core.mjs 位于 lib/ 下，上一级即包根（不依赖宿主传入的 root）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NS = '/api/dsh-branch-notes';
const DATA_DIR = join(homedir(), '.dsh', 'branch-notes');
const CLIENT_LOG = join(DATA_DIR, 'client.log');
const HOST_LOG = join(DATA_DIR, 'host.log');

/* ------------------------------------------------------------------ HTTP 小工具 */

/**
 * 取宿主服务。
 * Cordis 对「未在 inject 声明的服务」的属性访问会抛错，但 `ctx.get(key)` 仍然可用；
 * 因此这里先试属性，再退回按 key 查找——这样即便宿主半没有重新加载，业务代码也能工作。
 */
function service(ctx, key) {
  let value = null;
  try {
    value = ctx[key];
  } catch {
    value = null;
  }
  if (value) return value;
  try {
    value = typeof ctx.get === 'function' ? ctx.get(key) : null;
  } catch {
    value = null;
  }
  return value ?? null;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

async function readStatic(root, relative) {
  const file = join(root, relative);
  const info = await stat(file);
  return { body: await readFile(file, 'utf8'), mtime: info.mtimeMs, size: info.size };
}

/* ------------------------------------------------------- 宿主侧调用追踪（排查用） */

async function trace(entry) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(HOST_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 追踪失败不影响主流程 */
  }
}

/* ------------------------------------------------------- OpenAI 消息 → Harness 请求 */

/**
 * Harness 的 `GenerateOptions.messages` 接受持久 Message 或仅供请求的 RequestUserInput。
 * 为了让插件稳定跨版本，这里把 OpenAI 风格的 messages 折成**一条** user 消息，
 * 并把所有 system 内容前置成身份/上下文说明——这是文档中给出示例的最小可用形状。
 */
function foldMessages(messages) {
  const systems = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('')
        : '';
    if (!text) continue;
    if (message.role === 'system') systems.push(text);
    else if (message.role === 'assistant') turns.push({ role: 'assistant', text });
    else turns.push({ role: 'user', text });
  }
  const parts = [];
  if (systems.length) parts.push(systems.join('\n\n'));
  if (turns.length === 1) {
    parts.push(turns[0].text);
  } else if (turns.length > 1) {
    const history = turns
      .slice(0, -1)
      .map((turn) => (turn.role === 'user' ? '【提问】' : '【上次回答】') + '\n' + turn.text);
    parts.push('【此前的对话】\n' + history.join('\n\n'));
    parts.push('【本次提问】\n' + turns[turns.length - 1].text);
  }
  return parts.join('\n\n');
}

/** 读出当前默认模型选择（provider / model / reasoningEffort）。 */
function currentSelection(ctx) {
  try {
    const selection = service(ctx, 'agentDefaultModel')?.currentSelection?.();
    if (selection && typeof selection === 'object') return { ...selection };
  } catch {
    /* 没有该服务时退化为空 */
  }
  return {};
}

/**
 * 组装一次模型调用参数。
 * - provider/model 默认取 Harness 的当前默认选择；
 * - 允许客户端覆盖 provider/model（调试用），但不会触碰凭据。
 */
function buildCallOptions(ctx, body) {
  const selection = currentSelection(ctx);
  const provider = typeof body.provider === 'string' && body.provider ? body.provider : selection.provider;
  const model = typeof body.model === 'string' && body.model ? body.model : selection.model;
  if (!provider || !model) throw new Error('Harness 尚未配置默认模型（agentDefaultModel 为空）');

  const prompt = foldMessages(body.messages);
  if (!prompt.trim()) throw new Error('消息为空');

  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort;
  if (typeof body.temperature === 'number') options.temperature = body.temperature;
  if (typeof body.maxTokens === 'number') options.maxTokens = body.maxTokens;
  return { options, provider, model, promptLength: prompt.length };
}

/* --------------------------------------------------------------- 路由：模型调用 */

async function routeChat({ ctx, req, res }) {
  const body = await readBody(req);
  let call;
  try {
    call = buildCallOptions(ctx, body);
  } catch (error) {
    sendJson(res, 400, { error: { message: String(error?.message ?? error) } });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (payload) => {
    if (res.writableEnded) return;
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };

  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);
  res.on('close', abort);

  const startedAt = Date.now();
  const traceId = Math.random().toString(36).slice(2, 8);
  await trace({ type: 'chat-start', traceId, provider: call.provider, model: call.model });
  let textLength = 0;
  try {
    const llm = service(ctx, 'llm');
    if (!llm || typeof llm.stream !== 'function') throw new Error('Harness 的 llm 服务不可用');
    const stream = llm.stream({ ...call.options, signal: controller.signal });
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        textLength += chunk.text.length;
        write({ choices: [{ delta: { content: chunk.text } }] });
      } else if (chunk.type === 'reasoning-delta') {
        // 思考过程不计入正文，但让客户端知道模型在动
        write({ choices: [{ delta: {} }], branchNotes: { reasoning: true } });
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason ?? {};
        if (reason.kind === 'error') {
          const failure = reason.failure ?? {};
          write({ error: { message: failure.message ?? '模型调用失败', code: failure.code ?? 'UNKNOWN' } });
        } else if (reason.kind === 'max-tokens') {
          write({ choices: [{ delta: { content: '\n\n（回答被最大长度截断）' } }] });
        }
      }
    }
  } catch (error) {
    write({ error: { message: String(error?.message ?? error), code: 'THROWN' } });
  } finally {
    req.off?.('close', abort);
    if (!res.writableEnded) {
      write({ branchNotes: { elapsedMs: Date.now() - startedAt, chars: textLength, provider: call.provider, model: call.model } });
      res.write('data: [DONE]\n\n');
      res.end();
    }
    await trace({ type: 'chat-end', traceId, ms: Date.now() - startedAt, chars: textLength, aborted: controller.signal.aborted });
  }
}

async function routeSummarize({ ctx, req, res }) {
  const body = await readBody(req);
  let call;
  try {
    call = buildCallOptions(ctx, body);
  } catch (error) {
    sendJson(res, 400, { error: { message: String(error?.message ?? error) } });
    return;
  }
  let text = '';
  let failure = null;
  const startedAt = Date.now();
  const traceId = Math.random().toString(36).slice(2, 8);
  await trace({ type: 'summarize-start', traceId, provider: call.provider, model: call.model, messages: (body.messages || []).length });
  const llm = service(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(res, 502, { error: { message: 'Harness 的 llm 服务不可用' } });
    return;
  }
  /**
   * 摘要这种小任务不需要深度思考：reasoningEffort=high 时，思考过程会把
   * maxTokens 全吃光，正文一个 token 都不剩（实测 7 秒、200、content 为空）。
   * 所以这里强制降档，并在正文为空时提高额度重试一次。
   */
  async function attempt(options) {
    let out = '';
    let fail = null;
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          fail = chunk.reason.failure ?? { message: '模型调用失败' };
        }
      }
    } catch (error) {
      fail = { message: String(error?.message ?? error) };
    }
    return { text: out, failure: fail };
  }

  const baseOptions = { ...call.options, reasoningEffort: 'low' };
  let result = await attempt(baseOptions);
  text = result.text;
  failure = result.failure;
  if (!failure && !text.trim()) {
    result = await attempt({ ...call.options, reasoningEffort: 'low', maxTokens: Math.max(2400, Number(call.options.maxTokens) || 0) });
    text = result.text;
    failure = result.failure;
  }
  if (failure) {
    await trace({ type: 'summarize-end', traceId, ms: Date.now() - startedAt, chars: text.length, error: failure.message ?? '模型调用失败' });
    sendJson(res, 502, { error: { message: failure.message ?? '模型调用失败', code: failure.code ?? 'UNKNOWN' } });
    return;
  }
  if (!text.trim()) {
    await trace({ type: 'summarize-end', traceId, ms: Date.now() - startedAt, chars: 0, error: 'empty' });
    sendJson(res, 502, { error: { message: '模型这次没有给出摘要内容，请再试一次' } });
    return;
  }
  // 返回 OpenAI 兼容形状，客户端无需改动解析逻辑
  await trace({ type: 'summarize-end', traceId, ms: Date.now() - startedAt, chars: text.length });
  sendJson(res, 200, { choices: [{ message: { role: 'assistant', content: text.trim() } }] });
}

/* ----------------------------------------------------------------- 路由：元信息 */

async function routeAccountProbe({ ctx, res }) {
  const out = { ok: true, services: {} };
  for (const key of ['deepseekAccount', 'deepseekLlmApiExtensions', 'credentialsController', 'credentials', 'agentDefaultModel']) {
    const entry = { found: false };
    try {
      const svc = service(ctx, key);
      if (svc) {
        entry.found = true;
        entry.keys = [];
        for (const k in svc) entry.keys.push(k);
        const proto = Object.getPrototypeOf(svc);
        entry.proto = proto ? Object.getOwnPropertyNames(proto) : [];
        for (const m of ['status', 'getStatus', 'list', 'models', 'listModels', 'signInState', 'getState']) {
          if (typeof svc[m] === 'function') {
            try { entry[m] = await Promise.resolve(svc[m]()); } catch (e) { entry[m] = 'err: ' + String(e && e.message ? e.message : e); }
          }
        }
      } else entry.value = String(svc);
    } catch (e) { entry.error = String(e && e.message ? e.message : e); }
    out.services[key] = entry;
  }
  try {
    const arm = service(ctx, 'agentDefaultModel');
    out.agentDefaultModel = { keys: [], currentSelection: arm && arm.currentSelection ? arm.currentSelection() : null };
    for (const k in arm) out.agentDefaultModel.keys.push(k);
  } catch (e) { out.agentDefaultModelError = String(e && e.message ? e.message : e); }
  return sendJson(res, 200, out);
}

async function routeModelProbe({ ctx, res }) {
  const out = { ok: true };
  let llm = null;
  try { llm = service(ctx, 'llm'); } catch (e) { out.llmError = String(e && e.message ? e.message : e); }
  if (!llm) return sendJson(res, 200, out);
  out.keys = [];
  for (const k in llm) out.keys.push(k);
  try { out.providersRaw = typeof llm.listProviders === 'function' ? llm.listProviders() : 'no listProviders'; } catch (e) { out.providersError = String(e && e.message ? e.message : e); }
  out.perProvider = {};
  const ids = (out.providersRaw && Array.isArray(out.providersRaw) ? out.providersRaw.map((p) => p && p.id).filter(Boolean) : []);
  for (const id of ids) {
    try {
      const list = await Promise.resolve(llm.listModels ? llm.listModels(id) : null);
      out.perProvider[id] = { models: list };
    } catch (e) { out.perProvider[id] = { error: String(e && e.message ? e.message : e) }; }
  }
  const candidates = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-pro', 'deepseek-v4.1-flash', 'deepseek-web', 'deepseek-v3.2', 'deepseek-v4'];
  out.resolve = {};
  for (const pid of ids) {
    out.resolve[pid] = {};
    for (const m of candidates) {
      try {
        const info = await Promise.resolve(llm.resolveModelInfo ? llm.resolveModelInfo(pid, m) : null);
        out.resolve[pid][m] = info ? { ok: true, info } : 'null';
      } catch (e) { out.resolve[pid][m] = 'err: ' + String(e && e.message ? e.message : e); }
    }
  }
  try { out.selection = service(ctx, 'agentDefaultModel')?.currentSelection?.(); } catch (e) { out.selectionError = String(e && e.message ? e.message : e); }
  return sendJson(res, 200, out);
}

async function routeModels(ctx, res) {
  const selection = currentSelection(ctx);
  let providers = [];
  const models = [];
  const unavailable = [];
  let account = null;
  let llm = null;
  try { llm = service(ctx, 'llm'); } catch { /* 忽略 */ }
  try {
    for (const provider of (llm?.listProviders?.() ?? [])) {
      if (!provider || !provider.id) continue;
      providers.push({ id: provider.id, name: provider.name || provider.id });
      let list = [];
      try {
        const got = await Promise.resolve(llm.listModels(provider.id));
        if (Array.isArray(got)) list = got;
      } catch (error) {
        providers[providers.length - 1].error = String(error?.message ?? error);
      }
      for (const model of list) {
        const id = model && (model.id || model.model);
        if (!id) continue;
        models.push({
          provider: provider.id,
          id,
          name: model.name || id,
          description: typeof model.description === 'string' ? model.description : '',
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ['text'],
        });
      }
    }
  } catch (error) {
    providers.push({ id: 'error', name: String(error?.message ?? error) });
  }

  /* DeepSeek 账号通道（免费额度那套）的登录状态：未登录时它不会公布任何模型 */
  try {
    const svc = service(ctx, 'deepseekAccount');
    if (svc && typeof svc.getState === 'function') {
      const state = await Promise.resolve(svc.getState());
      account = { status: (state && state.status) || 'unknown' };
    } else {
      account = { status: 'service-missing' };
    }
  } catch (error) {
    account = { status: 'probe-error', error: String(error?.message ?? error) };
  }

  /* 用户想要的「免费网页版模型」：它不是一个 API 模型名，而是走账号通道；
     账号通道当前没公布任何模型（或压根没登录）时，作为不可用项报给前端，并说明原因。 */
  const hasAccountModel = models.some((m) => m.provider === 'deepseek-account');
  if (!hasAccountModel) {
    unavailable.push({
      provider: 'deepseek-account',
      id: 'deepseek-web',
      name: 'DeepSeek 网页版（免费额度）',
      reason: account && account.status === 'signed-in'
        ? '账号通道没有公布可用模型'
        : '需要先在 Harness「设置 → 账号」登录 DeepSeek 账号',
    });
  }

  sendJson(res, 200, {
    ok: true,
    selection,
    providers,
    models,
    account,
    unavailable,
    note: 'AI 由 DeepSeek Harness 的内置模型凭据提供，插件不保存也不需要 API Key。',
  });
}


/** 探测当前 inject 声明下各个服务是否可见（未声明 inject 的属性访问会抛错）。 */
function serviceProbe(ctx) {
  const probe = {};
  for (const key of ['llm', 'agentDefaultModel', 'webServer']) {
    try {
      probe['ctx.' + key] = ctx[key] ? 'ok' : 'null';
    } catch (error) {
      probe['ctx.' + key] = 'throw: ' + String(error?.message ?? error);
    }
  }
  const lookups = [
    ['ctx.get(llm)', () => ctx.get?.('llm')],
    ['ctx.root.get(llm)', () => ctx.root?.get?.('llm')],
    ['ctx.reflect.get(llm)', () => ctx.reflect?.get?.('llm')],
  ];
  for (const [label, fn] of lookups) {
    try {
      const value = fn();
      probe[label] = value ? 'ok' : 'null';
    } catch (error) {
      probe[label] = 'throw: ' + String(error?.message ?? error);
    }
  }
  return probe;
}

async function routeDiag({ ctx, root, res }) {
  const files = {};
  for (const relative of ['web/app.html', 'web/probe.html', 'client/client.js', 'lib/core.mjs']) {
    try {
      const info = await stat(join(root, relative));
      files[relative] = { size: info.size, mtime: new Date(info.mtimeMs).toISOString() };
    } catch {
      files[relative] = null;
    }
  }
  let providerInfo = null;
  try {
    providerInfo = {
      providers: service(ctx, 'llm')?.listProviders?.() ?? null,
      selection: currentSelection(ctx),
    };
  } catch (error) {
    providerInfo = { error: String(error?.message ?? error) };
  }
  sendJson(res, 200, {
    ok: true,
    plugin: 'dsh-branch-notes',
    routePrefix: NS,
    root,
    files,
    llm: providerInfo,
    probe: serviceProbe(ctx),
    dataDir: DATA_DIR,
    node: process.version,
    pid: process.pid,
    now: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ 路由：日志 */

async function routeLogPost({ req, res }) {
  const payload = await readBody(req);
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n';
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(CLIENT_LOG, line, 'utf8');
  } catch (error) {
    console.error('[dsh-branch-notes] 写客户端日志失败：', error);
  }
  sendJson(res, 200, { ok: true });
}

async function routeLogGet({ res, query }) {
  let text = '';
  try {
    text = await readFile(CLIENT_LOG, 'utf8');
  } catch {
    text = '';
  }
  if (query.get('format') === 'json') {
    const lines = text.split('\n').filter(Boolean).slice(-400);
    sendJson(res, 200, { ok: true, lines });
    return;
  }
  sendText(res, 200, 'text/plain; charset=utf-8', text);
}

async function routeLogClear({ res }) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CLIENT_LOG, '', 'utf8');
  } catch {
    /* 忽略 */
  }
  sendJson(res, 200, { ok: true });
}

/* -------------------------------------------------------------- 路由：开发开关 */

/**
 * 开发期开关，放在数据目录的 dev.json 里，形如：
 *   { "autoOpen": true }
 * 用来在不改客户端代码的前提下让客户端自动打开面板、复验链路。
 */
async function routeDevFlags({ res }) {
  let flags = {};
  try {
    flags = JSON.parse(await readFile(join(DATA_DIR, 'dev.json'), 'utf8'));
  } catch {
    flags = {};
  }
  sendJson(res, 200, { ok: true, ...flags });
}

/* ------------------------------------------------------------ 导出落盘（宿主半） */

const EXPORT_ROOT = join(homedir(), 'Documents', '枝条笔记导出');

function safeName(value, fallback) {
  const text = String(value ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  return (text || fallback).slice(0, 120);
}

/**
 * 把「导出 Markdown / 导出备份」直接落盘到 `文档/枝条笔记导出/<文档名>/`。
 * 面板在 Electron 的嵌套视图里，`a[download]` 不保证可用；这里由宿主 node 直接写文件，
 * 前端拿到真实路径后 toast 出来——比浏览器下载可靠。
 */
async function routeSaveExport({ req, res }) {
  const body = await readBody(req, 64 * 1024 * 1024);
  const dir = join(EXPORT_ROOT, safeName(body.name, '枝条笔记'));
  await mkdir(dir, { recursive: true });
  const files = [];
  if (typeof body.text === 'string' && body.text) {
    const file = join(dir, safeName(body.filename, '导出.md'));
    await writeFile(file, body.text, 'utf8');
    files.push(file);
  }
  const savedAssets = [];
  for (const asset of Array.isArray(body.assets) ? body.assets : []) {
    const raw = String(asset?.base64 ?? '');
    if (!raw) continue;
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length) continue;
    const assetsDir = join(dir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const file = join(assetsDir, safeName(asset.filename, `asset-${savedAssets.length + 1}`));
    await writeFile(file, buffer);
    savedAssets.push(file);
  }
  sendJson(res, 200, { ok: true, dir, files, assets: savedAssets });
}

/* -------------------------------------------------------------- 打开面板命令 */
/**
 * 「在任意对话里直接打开枝条笔记」的通道：
 *  - 智能体调用工具 branch_notes_open → 这里写一次 commands.json；
 *  - 客户端 bundle 每 2 秒拉 GET /commands，发现 openRequest 变新就 selectPanel 切过来；
 *  - 可选 note 标题，客户端会让 iframe 带 ?goto=<标题> 重载，面板落位到那条枝条。
 * 用文件而不是内存变量，是因为 core.mjs 会按 mtime 重新 import、模块状态会重置。
 */
const COMMANDS_FILE = join(DATA_DIR, 'commands.json');
const TOOL_FLAG = Symbol.for('dsh-branch-notes.open-tool');

async function readCommands() {
  try {
    return JSON.parse(await readFile(COMMANDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function requestOpen(note, reload) {
  const payload = { openRequest: Date.now(), note: String(note ?? '').slice(0, 200), reload: reload === true };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(COMMANDS_FILE, JSON.stringify(payload), 'utf8');
  await trace({ type: 'open-request', note: payload.note });
  return payload;
}

async function routeCommandsGet({ res }) {
  const data = await readCommands();
  sendJson(res, 200, {
    ok: true,
    openRequest: Number(data.openRequest) || 0,
    note: typeof data.note === 'string' ? data.note : '',
    reload: data.reload === true,
    tool: globalThis[TOOL_FLAG] ? 'registered' : 'pending',
  });
}

async function routeCommandsPost({ req, res }) {
  const body = await readBody(req);
  const payload = await requestOpen(body.note, body.reload);
  sendJson(res, 200, { ok: true, ...payload });
}

/** 工具定义：手写对象即可（Harness 的 defineTool 只是把它整理成这个形状）。 */
function buildOpenTool() {
  return {
    name: 'branch_notes_open',
    description:
      '打开（或切换到）「枝条笔记」面板：在 Harness 中央面板里显示剧本/设定的枝条树。' +
      '当用户说“打开枝条笔记 / 分支笔记 / 剧本笔记 / 大纲面板”，或让你“在面板里看剧本、改剧本”时调用。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '可选：打开后定位到的枝条标题（精确或包含匹配）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 15000,
    async execute(args) {
      const note = typeof args?.note === 'string' ? args.note : '';
      await requestOpen(note);
      return note ? `已打开「枝条笔记」面板，并定位到「${note}」` : '已打开「枝条笔记」面板';
    },
  };
}

/** 懒注册工具：core 每次请求都会进来一次，注册一次即可（用 globalThis 跨模块重载去重）。 */
function ensureOpenTool(ctx) {
  if (globalThis[TOOL_FLAG]) return;
  let tools = null;
  try {
    tools = service(ctx, 'tools');
  } catch {
    tools = null;
  }
  if (!tools || typeof tools.register !== 'function') return;
  try {
    const dispose = tools.register(buildOpenTool());
    globalThis[TOOL_FLAG] = typeof dispose === 'function' ? dispose : () => {};
    console.log('[dsh-branch-notes] 已注册工具 branch_notes_open');
  } catch (error) {
    globalThis[TOOL_FLAG] = { error: String(error?.message ?? error) };
    console.error('[dsh-branch-notes] 工具注册失败：', String(error?.message ?? error));
  }
}

/* ------------------------------------------------------------------ 收件箱 */
/**
 * 智能体收件箱：宿主/智能体把 Markdown 放进 `~/.dsh/branch-notes/inbox/`，
 * 笔记面板每 4 秒拉一次，按「笔记协议 v1」自动导成新剧本。
 *
 *   POST /inbox       { name, markdown } 或 { items: [{ name, markdown }, …] }
 *   GET  /inbox       取出待导入清单
 *   POST /inbox/ack   { ids: [...] } 确认已导入，宿主删文件
 *
 * 这是「智能体 → 面板」的单向管道：写入即展示，不需要页面里的文件选择框。
 */
const INBOX_DIR = join(DATA_DIR, 'inbox');

async function listInbox() {
  let names = [];
  try {
    names = await readdir(INBOX_DIR);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
    const file = join(INBOX_DIR, name);
    try {
      const info = await stat(file);
      items.push({
        id: name,
        name: name.replace(/^\d+-\d+-/, '').replace(/\.md$/, ''),
        at: new Date(info.mtimeMs).toISOString(),
        markdown: await readFile(file, 'utf8'),
      });
    } catch {
      /* 单个文件读失败不影响其它 */
    }
  }
  return items;
}

async function routeInboxGet({ res }) {
  const items = await listInbox();
  sendJson(res, 200, { ok: true, count: items.length, items });
}

async function routeInboxPost({ req, res }) {
  const body = await readBody(req, 32 * 1024 * 1024);
  const incoming = Array.isArray(body.items) ? body.items : [body];
  await mkdir(INBOX_DIR, { recursive: true });
  const saved = [];
  let index = 0;
  for (const item of incoming) {
    const markdown = typeof item?.markdown === 'string' ? item.markdown : '';
    if (!markdown.trim()) continue;
    const base = safeName(item?.name ?? item?.filename ?? 'note', 'note').replace(/\.md$/i, '');
    const file = join(INBOX_DIR, `${Date.now()}-${index++}-${base}.md`);
    await writeFile(file, markdown, 'utf8');
    saved.push(file);
  }
  sendJson(res, 200, { ok: true, count: saved.length, pending: (await listInbox()).length });
}

async function routeInboxAck({ req, res }) {
  const body = await readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  let removed = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id.endsWith('.md') || /[\\/]/.test(id)) continue;
    try {
      await unlink(join(INBOX_DIR, id));
      removed++;
    } catch {
      /* 已被消费 */
    }
  }
  sendJson(res, 200, { ok: true, removed, pending: (await listInbox()).length });
}

/* ------------------------------------------------------------------------ 入口 */

export async function handle({ ctx, config, root: hostRoot, pathname, req, res }) {
  // 静态资源始终相对包根定位，避免宿主把 lib/ 当成根
  const root = PACKAGE_ROOT;
  // 工具注册懒执行：这里有 ctx，就能拿到 tools 服务（不依赖 index.js 的 inject 声明）
  try {
    ensureOpenTool(ctx);
  } catch {
    /* 工具注册失败不影响 HTTP 功能 */
  }
  const relative = pathname.startsWith(NS) ? pathname.slice(NS.length) : pathname;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = (relative || '/').replace(/\/+$/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    if (route === '/ping') {
      sendJson(res, 200, { ok: true, plugin: 'dsh-branch-notes', now: Date.now() });
      return;
    }
    if (route === '/diag') {
      await routeDiag({ ctx, root, res });
      return;
    }
    if (route === '/model-probe') { await routeModelProbe({ ctx, res }); return; }
    if (route === '/account-probe') { await routeAccountProbe({ ctx, res }); return; }
    if (route === '/models') {
      await routeModels(ctx, res);
      return;
    }
    if (route === '/dev-flags') {
      await routeDevFlags({ res });
      return;
    }
    if (route === '/app' || route === '/') {
      const page = await readStatic(root, 'web/app.html');
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      sendText(res, 200, 'text/html; charset=utf-8', page.body);
      return;
    }
    if (route === '/probe') {
      const page = await readStatic(root, 'web/probe.html');
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      sendText(res, 200, 'text/html; charset=utf-8', page.body);
      return;
    }
    if (route === '/log') {
      if (method === 'POST') await routeLogPost({ req, res });
      else if (method === 'DELETE') await routeLogClear({ res });
      else await routeLogGet({ res, query: url.searchParams });
      return;
    }
    if (route === '/save-export') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: { message: '只接受 POST' } });
        return;
      }
      await routeSaveExport({ req, res });
      return;
    }
    if (route === '/chat') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: { message: '只接受 POST' } });
        return;
      }
      await routeChat({ ctx, req, res });
      return;
    }
    if (route === '/summarize') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: { message: '只接受 POST' } });
        return;
      }
      await routeSummarize({ ctx, req, res });
      return;
    }
    if (route === '/commands') {
      if (method === 'POST') await routeCommandsPost({ req, res });
      else await routeCommandsGet({ res });
      return;
    }
    if (route === '/inbox') {
      if (method === 'POST') await routeInboxPost({ req, res });
      else await routeInboxGet({ res });
      return;
    }
    if (route === '/inbox/ack') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: { message: '只接受 POST' } });
        return;
      }
      await routeInboxAck({ req, res });
      return;
    }
    sendJson(res, 404, { ok: false, error: '未知路由：' + route, prefix: NS });
  } catch (error) {
    const message = String(error?.stack ?? error?.message ?? error);
    console.error('[dsh-branch-notes] core 处理失败：', message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: message });
    else if (!res.writableEnded) res.end();
  }
}
