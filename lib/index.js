/**
 * 枝条笔记 · 宿主半（Cordis 插件）
 *
 * 职责：
 *  1. 在 Web 服务器上占据一段前缀路由 `/api/dsh-branch-notes/*`；
 *  2. 真正的业务逻辑放在 `core.mjs` 里，按文件修改时间动态 import —— 开发期改
 *     core.mjs 后**下一次请求**即生效，不必重装插件或重启应用；
 *  3. 供客户端 bundle（`client/client.js`）的 iframe 加载 `web/app.html`。
 *
 * 依赖注入：webServer（HTTP 载体）、llm（模型调用，Harness 内置凭据）、
 *           agentDefaultModel（当前默认 provider/model）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';

export const name = 'dsh-branch-notes';

/**
 * webServer：HTTP 载体（必需）
 * llm：Harness 的模型调用服务（凭据由 Harness 管理，插件不接触 API Key）
 * agentDefaultModel：当前默认 provider / model / reasoningEffort
 */
export const inject = ['webServer', 'llm', 'agentDefaultModel'];

const ROUTE_PREFIX = '/api/dsh-branch-notes';
const libDir = dirname(fileURLToPath(import.meta.url));
/** 包根目录（lib 的上一级），静态页面和 client 都相对它定位。 */
const packageRoot = join(libDir, '..');

/** 读取文件的修改时间（毫秒），文件不存在时返回 0。 */
async function mtimeOf(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

export function apply(ctx, config) {
  const state = { core: null, stamp: '' };

  /** 开发期热加载：core.mjs 变化后自动换成新版本。 */
  async function loadCore() {
    const file = join(libDir, 'core.mjs');
    const mtime = await mtimeOf(file);
    if (state.core !== null && String(mtime) === state.stamp) return state.core;
    const url = pathToFileURL(file).href + '?t=' + String(mtime);
    const mod = await import(url);
    state.core = mod;
    state.stamp = String(mtime);
    return state.core;
  }

  async function handler(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      /* 畸形 URL 交给 core 报 400 */
    }
    try {
      const core = await loadCore();
      await core.handle({
        ctx,
        config: config ?? {},
        root: packageRoot,
        prefix: ROUTE_PREFIX,
        pathname,
        req,
        res,
      });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error('[dsh-branch-notes] 请求处理失败：', message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: message }));
      } else {
        try {
          res.end();
        } catch {
          /* 已断开 */
        }
      }
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handler(req, res),
    });
    console.log('[dsh-branch-notes] 路由已挂载：' + ROUTE_PREFIX);
    return () => {
      dispose();
    };
  });
}
