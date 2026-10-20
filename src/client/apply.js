import { NS, PANEL_ID } from './runtime.js';
import { zh, en } from './i18n.js';
import { SessionImportIcon } from './icons.js';
import { SessionImportPanel } from './panel.js';
import { injectStyles } from './styles.js';
import { rpcCall } from './utils.js';

/**
 * Services used before registration: the sessions store refreshes the sidebar
 * after an import; slots and layout provide the entry and page.
 */
export const inject = ['slots', 'locale', 'layout', 'sessions'];

/**
 * Mount the browser half: dictionaries, sidebar entry and its page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx) {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-import: dictionaries');
  const t = ctx.locale.bind(NS);
  const rpc = (endpoint, payload) => rpcCall(endpoint, payload);

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => t('panel'),
    locale: NS,
  }, SessionImportIcon));

  // Refresh the sidebar's session catalog (and each imported session's title
  // projection) so imported conversations appear without a page reload.
  const refreshSessions = (results) => {
    const sessions = ctx.sessions;
    if (sessions === undefined) return;
    for (const result of results ?? []) {
      if (result?.ok === true && typeof result.sessionId === 'string') {
        sessions.refreshProjections(result.sessionId).catch(() => {});
      }
    }
    sessions.refresh().catch(() => {});
  };

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ rpc, refreshSessions }),
  }, SessionImportPanel));
}
