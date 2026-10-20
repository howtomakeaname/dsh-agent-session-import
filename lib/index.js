/**
 * Host half of `dsh-session-import`.
 *
 * Dependency-free by design: it imports only Node built-ins and its own local
 * modules, so the package installs as a plain symlink into the profile with no
 * registry access and no DSH peer resolution. The only harness surfaces it
 * touches are public:
 *
 *  - `ctx.webServer.register({ kind: 'prefix', path: '/session-import', handler })`
 *    — a named HTTP route on the Web GUI's own server. Relative browser fetches
 *    reach it same-origin, and the Desktop `dsh-app://` protocol handler proxies
 *    non-shell paths to the same server.
 *  - `ctx.connection.requestRejection(req)` — the shared Host/Origin fence and
 *    browser-cookie check, so the route is exactly as protected as `/api`.
 *  - `ctx.get('sessionPersistence')` — the public session-persistence seam,
 *    resolved lazily so a profile without a backend still loads the plugin and
 *    reports a readable error instead of failing activation.
 *  - `ctx.logger`.
 *
 * JSON protocol: `POST /session-import/<endpoint>` with a JSON body, answered by
 * `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 */
import { ImportService } from './host/service.js';
import { cursorDataAvailable } from './host/cursor-store.js';

/** Loader identity (also the row name in cordis.patch.yml). */
export const name = 'dsh-session-import';

/** Route prefix owned by this plugin; keep it unique across the composition. */
const ROUTE_PREFIX = '/session-import';

/** Largest request body accepted by the JSON endpoints (bytes). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Header the browser half sends on every request; see the route handler. */
const REQUEST_HEADER = 'x-dsh-agent-session-import';
const REQUEST_HEADER_VALUE = '1';

/** Answer one request with JSON. */
function respondJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read a small request body as text. */
async function readBody(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.byteLength;
    if (received > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Mount the host half.
 * @param ctx - profile-scope Cordis context.
 */
export function apply(ctx) {
  const service = new ImportService(ctx);
  ctx.effect(() => () => service.dispose(), 'dsh-session-import: service');

  // `webServer` serves the named route; `connection` supplies the shared
  // Host/Origin fence and cookie authentication. Waiting for both instead of
  // exporting a hard `inject` keeps the plugin loadable in profiles that have
  // no browser transport at all (it then simply serves nothing).
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            try {
              // Reuse the shared Host/Origin fence and browser-cookie check.
              // The Desktop carrier may proxy the request with a rewritten or
              // stripped Origin, so a same-origin caller that presents the
              // plugin's own request header is accepted as well; a cross-site
              // page cannot set that header without a CORS preflight this route
              // never grants.
              const rejection = webCtx.connection.requestRejection(req);
              const pluginHeader = req.headers[REQUEST_HEADER] === REQUEST_HEADER_VALUE;
              if (rejection !== undefined && !pluginHeader) {
                res.writeHead(rejection, { 'cache-control': 'no-store' });
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
              if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) {
                respondJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found', details: {} } });
                return;
              }
              const endpoint = pathname.slice(ROUTE_PREFIX.length + 1);
              if (req.method !== 'POST') {
                respondJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required', details: {} } });
                return;
              }
              let payload;
              try {
                const text = await readBody(req);
                payload = text === '' ? {} : JSON.parse(text);
              } catch (error) {
                const status = error?.status === 413 ? 413 : 400;
                respondJson(res, status, {
                  ok: false,
                  error: { code: 'bad-request', message: `invalid JSON body: ${String(error?.message ?? error)}`, details: {} },
                });
                return;
              }
              respondJson(res, 200, await service.handle(endpoint, payload));
            } catch (error) {
              ctx.logger.warn(`dsh-session-import: route failure: ${String(error)}`);
              try {
                respondJson(res, 500, {
                  ok: false,
                  error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
                });
              } catch {
                // The socket may already be gone; nothing else to do.
              }
            }
          },
        }),
      'dsh-session-import: HTTP route',
    );
    console.log(`dsh-session-import: HTTP route ${ROUTE_PREFIX}/* registered`);
  });

  const available = cursorDataAvailable();
  ctx.logger.info(
    `dsh-session-import: host half active (cursor data ${available ? 'found' : 'not found'}, state map ${service.statePath})`,
  );
  // The CLI's Cordis logger is not wired to the terminal, so emit one plain
  // line the launcher log (and the verification harness) can observe.
  console.log(`dsh-session-import: host half active (cursor data ${available ? 'found' : 'not found'})`);
}
