import * as P from '@deepseek-ai/dsh-client-ui-primitives';

/** Locale dictionary namespace owned by this plugin. */
export const NS = 'sessionImport';

/** Panel id shared by the sidebar entry and the main page it opens. */
export const PANEL_ID = 'session-import';

/** Connection RPC channel served by the Host half. */
export const ROUTE_PREFIX = '/session-import';

// Reuse the harness icons when present; `undefined` lets callers fall back.
export const IconChevronDown = P.IconChevronDownOutlineRegular;
export const IconChevronRight = P.IconChevronRightOutlineRegular;
export const IconSearch = P.IconSearchOutlineRegular;

/** Harness primitives this UI treats as optional for forward compatibility. */
export const primitivesAvailable = {
  Tag: typeof P.Tag === 'function',
  SegmentedTabs: typeof P.SegmentedTabs === 'function',
  Pill: typeof P.Pill === 'function',
};
