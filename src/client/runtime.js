    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = react.createElement;

    // Reuse the harness's own primitives/icons when present, and degrade to the
    // local fallback when a build does not export one of them.
    const IconChevronDown = P.IconChevronDownOutlineRegular;
    const IconChevronRight = P.IconChevronRightOutlineRegular;
    const IconSearch = P.IconSearchOutlineRegular;
    const primitivesAvailable = {
      Tag: typeof P.Tag === 'function',
      SegmentedTabs: typeof P.SegmentedTabs === 'function',
      Pill: typeof P.Pill === 'function',
    };

    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'sessionImport';
    /** Panel id shared by the sidebar entry and the main page it opens. */
    const PANEL_ID = 'session-import';
    /** Connection RPC channel served by the Host half. */
    const ROUTE_PREFIX = '/session-import';
