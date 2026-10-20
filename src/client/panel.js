import * as react from 'react';
import * as P from '@deepseek-ai/dsh-client-ui-primitives';
import { IconChevronDown, IconChevronRight, IconSearch, primitivesAvailable } from './runtime.js';
import { fmt, formatTime } from './utils.js';
import { SOURCE_ICONS } from './icons.js';
import { Badge, ConversationRow, ProgressBar, ImportModal } from './components.js';

const h = react.createElement;

    // ── panel page ──────────────────────────────────────────────────────────
    /** The full import page: pick a source, scan, select, import, review. */
    export function SessionImportPanel(props) {
      const { t, rpc, refreshSessions } = props;
      const [list, setList] = react.useState({ phase: 'loading', data: null, error: null });
      const [selected, setSelected] = react.useState(() => new Set());
      /** Provider id shown in the right-hand pane; the rail switches it. */
      const [activeSource, setActiveSource] = react.useState(() => {
        try {
          const stored = globalThis.localStorage?.getItem('session-import:source');
          return typeof stored === 'string' && stored !== '' ? stored : null;
        } catch {
          return null;
        }
      });
      const [query, setQuery] = react.useState('');
      const [scope, setScopeInner] = react.useState(() => {
        try {
          const stored = globalThis.localStorage?.getItem('session-import:scope');
          return stored === 'all' || stored === 'unimported' ? stored : 'unimported';
        } catch {
          return 'unimported';
        }
      });
      const setScope = react.useCallback((next) => {
        setScopeInner(next);
        try {
          globalThis.localStorage?.setItem('session-import:scope', next);
        } catch {
          // Preference only; import works without storage.
        }
      }, []);
      const [expandedGroups, setExpandedGroups] = react.useState(() => new Set());
      const [importMode, setImportModeInner] = react.useState(() => {
        try {
          const stored = globalThis.localStorage?.getItem('session-import:mode');
          return stored === 'compatible' || stored === 'full' ? stored : 'full';
        } catch {
          return 'full';
        }
      });
      const setImportMode = react.useCallback((mode) => {
        setImportModeInner(mode);
        try {
          globalThis.localStorage?.setItem('session-import:mode', mode);
        } catch {
          // A locked-down storage only costs the preference, not the import.
        }
      }, []);
      const [job, setJob] = react.useState(null);
      const [modalOpen, setModalOpen] = react.useState(false);
      const [cancelling, setCancelling] = react.useState(false);
      const [notice, setNotice] = react.useState(null);
      const aliveRef = react.useRef(true);

      react.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      const loadList = react.useCallback(async (refresh) => {
        setList((prev) => ({ ...prev, phase: prev.data === null ? 'loading' : 'refreshing', error: null }));
        try {
          const data = await rpc('list', { refresh: refresh === true });
          if (!aliveRef.current) return;
          setList({ phase: 'ready', data, error: null });
        } catch (error) {
          if (!aliveRef.current) return;
          setList({ phase: 'error', data: null, error: error instanceof Error ? error.message : String(error) });
        }
      }, [rpc]);

      react.useEffect(() => {
        loadList(false);
      }, [loadList]);

      react.useEffect(() => {
        if (list.phase !== 'ready' || list.data === null) return;
        const available = (Array.isArray(list.data.sources) ? list.data.sources : []).filter((source) => source.available !== false);
        if (available.length === 0) return;
        setActiveSource((prev) => (prev !== null && available.some((source) => source.id === prev) ? prev : available[0].id));
      }, [list.phase, list.data]);

      // Poll the running job; refresh the list once it settles.
      react.useEffect(() => {
        if (job === null || job.jobId === undefined) return undefined;
        let cancelled = false;
        let timer;
        const tick = async () => {
          try {
            const status = await rpc('status', { jobId: job.jobId });
            if (cancelled) return;
            setJob({ jobId: job.jobId, status });
            if (status.state !== 'running') {
              clearInterval(timer);
              setCancelling(false);
              loadList(false);
              if (typeof refreshSessions === 'function') refreshSessions(status.results);
            }
          } catch (error) {
            if (cancelled) return;
            clearInterval(timer);
            setNotice(error instanceof Error ? error.message : String(error));
          }
        };
        timer = setInterval(tick, 300);
        tick();
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [job === null ? null : job.jobId, rpc, loadList, refreshSessions]);

      const sources = Array.isArray(list.data?.sources) ? list.data.sources : [];
      const totalCount = sources.reduce((sum, source) => sum + (source.count ?? (source.conversations ?? []).length), 0);
      const currentSource = activeSource === null ? undefined : sources.find((source) => source.id === activeSource);
      const conversations = react.useMemo(() => {
        if (currentSource === undefined) return [];
        const rows = (currentSource.conversations ?? []).map((conversation) => ({
          ...conversation,
          key: typeof conversation.key === 'string' ? conversation.key : `${currentSource.id}:${conversation.id}`,
          sourceLabel: currentSource.label ?? currentSource.id,
        }));
        rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
        return rows;
      }, [currentSource]);
      const filtered = react.useMemo(() => {
        const needle = query.trim().toLowerCase();
        return conversations.filter((item) => {
          if (scope === 'unimported' && item.importedSessionId) return false;
          if (needle === '') return true;
          return String(item.title).toLowerCase().includes(needle)
            || String(item.cwdLabel ?? '').toLowerCase().includes(needle)
            || String(item.cwd ?? '').toLowerCase().includes(needle);
        });
      }, [conversations, query, scope]);

      const searching = query.trim() !== '';
      const groups = react.useMemo(() => {
        const map = new Map();
        for (const item of filtered) {
          const groupKey = typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : '__unknown__';
          let group = map.get(groupKey);
          if (group === undefined) {
            group = {
              key: groupKey,
              cwd: typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : null,
              label: item.cwdLabel || t('unknownProject'),
              items: [],
              latest: 0,
              imported: 0,
            };
            map.set(groupKey, group);
          }
          group.items.push(item);
          group.latest = Math.max(group.latest, item.updatedAt ?? 0);
          if (item.importedSessionId) group.imported += 1;
        }
        const list = Array.from(map.values());
        for (const group of list) group.items.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
        list.sort((left, right) => right.latest - left.latest);
        return list;
      }, [filtered, t]);
      const isGroupOpen = (key) => searching || expandedGroups.has(key);
      const toggleGroup = react.useCallback((key) => {
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);
      const expandAllGroups = react.useCallback(() => {
        setExpandedGroups(new Set(groups.map((group) => group.key)));
      }, [groups]);
      const collapseAllGroups = react.useCallback(() => {
        setExpandedGroups(new Set());
      }, []);
      /** Unimported rows of one project group (group checkbox target). */
      const groupUnimported = (group) => group.items.filter((item) => !item.importedSessionId);
      const groupAllSelected = (group) => {
        const rows = groupUnimported(group);
        return rows.length > 0 && rows.every((item) => selected.has(item.key));
      };
      const toggleGroupSelection = (group) => {
        const rows = groupUnimported(group);
        setSelected((prev) => {
          const next = new Set(prev);
          const all = rows.length > 0 && rows.every((item) => next.has(item.key));
          for (const item of rows) {
            if (all) next.delete(item.key);
            else next.add(item.key);
          }
          return next;
        });
      };

      const toggle = react.useCallback((key) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      const selectUnimported = react.useCallback(() => {
        setSelected(() => new Set(filtered.filter((item) => !item.importedSessionId).map((item) => item.key)));
      }, [filtered]);

      const startImport = react.useCallback(async (keys) => {
        if (keys.length === 0) return;
        const items = keys.map((key) => {
          const marker = key.indexOf(':');
          return marker < 0 ? { source: 'cursor', id: key } : { source: key.slice(0, marker), id: key.slice(marker + 1) };
        });
        setNotice(null);
        try {
          const started = await rpc('import', { items, options: { mode: importMode } });
          setModalOpen(true);
          setCancelling(false);
          setJob({ jobId: started.jobId, status: null });
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }, [rpc, importMode]);

      const cancelImport = react.useCallback(async () => {
        if (job === null || job.jobId === undefined) return;
        setCancelling(true);
        try {
          await rpc('cancel', { jobId: job.jobId });
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
          setCancelling(false);
        }
      }, [rpc, job]);

      const closeModal = react.useCallback(() => {
        setModalOpen(false);
        setJob(null);
      }, []);

      const retryFailed = react.useCallback(() => {
        const status = job?.status;
        const failed = (status?.results ?? [])
          .filter((row) => row.ok !== true && row.skipped !== true)
          .map((row) => `${row.source ?? 'cursor'}:${row.id}`);
        setModalOpen(false);
        setJob(null);
        if (failed.length > 0) startImport(failed);
      }, [job, startImport]);

      const selectedList = Array.from(selected);
      const unimportedCount = conversations.filter((item) => !item.importedSessionId).length;
      const importedTotal = conversations.filter((item) => item.importedSessionId).length;

      // ── source rail (master): switching a source never leaves the page ──
      let railBody;
      if (list.phase === 'loading' && list.data === null) {
        railBody = h('div', { className: 'ci-empty' }, t('scanning'));
      } else if (list.phase === 'error' && list.data === null) {
        railBody = h('div', { className: 'ci-error' }, fmt(t('unavailable'), { message: list.error ?? 'scan failed' }));
      } else {
        railBody = sources.map((source) => {
          const available = source.available !== false;
          const count = source.count ?? (source.conversations ?? []).length;
          const imported = (source.conversations ?? []).filter((conversation) => conversation.importedSessionId).length;
          const active = source.id === activeSource;
          const meta = available
            ? imported > 0 ? fmt(t('listSummary'), { total: count, imported }) : fmt(t('sourceConversations'), { n: count })
            : (source.error ?? t('sourceUnavailable'));
          return h(
            'button',
            {
              key: source.id,
              type: 'button',
              className: 'ci-rail-row' + (active ? ' active' : '') + (available ? '' : ' unavailable'),
              title: available ? (source.description || source.label) : (source.error ?? t('sourceUnavailable')),
              onClick: () => {
                if (!available) return;
                setActiveSource(source.id);
                try {
                  globalThis.localStorage?.setItem('session-import:source', source.id);
                } catch {
                  // Preference only; the import works without storage.
                }
                setQuery('');
                setNotice(null);
              },
            },
            h(
              'span',
              { className: 'ci-rail-row-icon' },
              SOURCE_ICONS[source.id] !== undefined
                ? h('img', { className: 'ci-source-icon-img', src: SOURCE_ICONS[source.id], alt: '', draggable: false })
                : null,
            ),
            h(
              'span',
              { className: 'ci-rail-row-main' },
              h('span', { className: 'ci-rail-row-name' }, source.label ?? source.id),
              h('span', { className: 'ci-rail-row-meta' }, meta),
            ),
          );
        });
      }

      // ── conversation list (detail) ──────────────────────────────────────
      const folderIcon = h(
        'svg',
        { className: 'ci-folder', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2 4.2c0-.5.4-.9.9-.9h3l1.2 1.4h5.8c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9H2.9a.9.9 0 0 1-.9-.9V4.2Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      );

      let listBody;
      if (currentSource === undefined) {
        listBody = h('div', { className: 'ci-empty' }, t('pickSource'));
      } else if (currentSource.available === false) {
        listBody = h(
          'div',
          { className: 'ci-error' },
          fmt(t('unavailable'), { message: currentSource.error ?? t('sourceUnavailable') }),
          h('div', { style: { marginTop: 10 } }, h(P.Button, { variant: 'outline', onClick: () => loadList(true) }, t('retry'))),
        );
      } else if (filtered.length === 0) {
        const emptyText = query.trim() !== ''
          ? t('noMatch')
          : scope === 'unimported' && conversations.length > 0
            ? t('allImported')
            : t('sourceEmpty');
        listBody = h('div', { className: 'ci-empty' }, emptyText);
      } else {
        listBody = h(
          'div',
          { className: 'ci-list', role: 'list' },
          groups.map((group) => {
            const open = isGroupOpen(group.key);
            return h(
              'div',
              { className: 'ci-group', role: 'group', key: group.key },
              h(
                'div',
                { className: 'ci-group-head', onClick: () => toggleGroup(group.key), title: group.cwd ?? undefined },
                IconChevronDown !== undefined
                  ? h('span', { className: 'ci-chevron' }, open ? h(IconChevronDown, { size: 14 }) : h(IconChevronRight ?? IconChevronDown, { size: 14 }))
                  : h('span', { className: 'ci-chevron' }, open ? '▾' : '▸'),
                folderIcon,
                h('span', { className: 'ci-group-name' }, group.label),
                h('span', { className: 'ci-group-meta' }, fmt(t('groupCount'), { n: group.items.length })),
                group.imported > 0 ? h('span', { className: 'ci-group-meta' }, fmt(t('groupImported'), { n: group.imported })) : null,
                h('span', { className: 'ci-group-spacer' }),
                h(
                  'span',
                  { className: 'ci-group-check', onClick: (event) => event.stopPropagation() },
                  h(P.Checkbox, { checked: groupAllSelected(group), onChange: () => toggleGroupSelection(group) }),
                ),
              ),
              open
                ? h(
                    'div',
                    { className: 'ci-group-body' },
                    group.items.map((item) =>
                      h(ConversationRow, { key: item.key, item, checked: selected.has(item.key), onToggle: toggle, t, nested: true })),
                  )
                : null,
            );
          }),
        );
      }

      const modeButton = (mode, label, hint) => h(
        'button',
        {
          key: mode,
          type: 'button',
          title: hint,
          className: 'ci-mode' + (importMode === mode ? ' active' : ''),
          onClick: () => setImportMode(mode),
        },
        label,
      );
      const modeControl = primitivesAvailable.SegmentedTabs
        ? h(P.SegmentedTabs, {
            value: importMode,
            onChange: (next) => setImportMode(next),
            label: t('modeLabel'),
            items: [
              { value: 'full', label: t('modeFull'), id: 'session-import-mode-full' },
              { value: 'compatible', label: t('modeCompatible'), id: 'session-import-mode-compatible' },
            ],
          })
        : h(react.Fragment, null,
          modeButton('full', t('modeFull'), t('modeFullHint')),
          modeButton('compatible', t('modeCompatible'), t('modeCompatibleHint')));

      const scopeControl = primitivesAvailable.SegmentedTabs
        ? h(P.SegmentedTabs, {
            value: scope,
            onChange: (next) => setScope(next),
            label: t('scopeLabel'),
            items: [
              { value: 'unimported', label: t('scopeUnimported'), id: 'session-import-scope-unimported' },
              { value: 'all', label: t('scopeAll'), id: 'session-import-scope-all' },
            ],
          })
        : null;

      const sourceIcon = currentSource !== undefined ? SOURCE_ICONS[currentSource.id] : undefined;
      const initialLoading = list.phase === 'loading' && list.data === null;
      const loadingPane = h(
        'div',
        { className: 'ci-loading' },
        h(
          'div',
          { className: 'ci-loading-card' },
          h('span', { className: 'ci-spinner' }, P.IconLoadingOutlineRegular !== undefined ? h(P.IconLoadingOutlineRegular, { size: 18 }) : '◌'),
          h('div', { className: 'ci-loading-title' }, t('scanningSources')),
          h('div', { className: 'ci-loading-hint' }, t('scanningHint')),
          h(
            'div',
            { className: 'ci-skeleton-list' },
            [0, 1, 2, 3, 4].map((index) =>
              h('div', { className: 'ci-skel-line', key: index, style: { width: `${52 + ((index * 17) % 36)}%` } })),
          ),
        ),
      );

      return h(
        'div',
        { className: 'ci-page' },
        h(
          'div',
          { className: 'ci-head' },
          h('div', null, h('h2', { className: 'ci-title' }, t('title')), h('p', { className: 'ci-sub' }, t('subtitle'))),
          h(P.Button, {
            variant: 'outline',
            onClick: () => loadList(true),
            disabled: list.phase === 'loading' || list.phase === 'refreshing',
            ...(list.data?.scannedAt ? { title: fmt(t('lastScan'), { time: formatTime(list.data.scannedAt) }) } : {}),
          }, list.phase === 'loading' || list.phase === 'refreshing' ? t('scanning') : t('refresh')),
        ),
        initialLoading
          ? loadingPane
          : h(
              'div',
              { className: 'ci-layout' },
          h(
            'div',
            { className: 'ci-rail' },
            h('div', { className: 'ci-rail-label' }, t('sourcesLabel')),
            railBody,
          ),
          h(
            'div',
            { className: 'ci-main' },
            currentSource === undefined
              ? null
              : h(
                  'div',
                  { className: 'ci-main-head' },
                  h(
                    'span',
                    { className: 'ci-main-head-icon' },
                    sourceIcon !== undefined ? h('img', { className: 'ci-source-icon-img', src: sourceIcon, alt: '', draggable: false }) : null,
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'ci-main-head-title' }, currentSource.label ?? currentSource.id),
                    h('div', { className: 'ci-main-head-sub' }, fmt(t('listSummary'), { total: conversations.length, imported: importedTotal })),
                  ),
                ),
            h(
              'div',
              { className: 'ci-toolbar' },
              h(P.Input, {
                className: 'ci-grow',
                icon: IconSearch !== undefined ? h(IconSearch, { size: 16 }) : undefined,
                placeholder: t('searchPlaceholder'),
                value: query,
                onChange: (event) => setQuery(event.target.value),
                'aria-label': t('searchPlaceholder'),
              }),
              scopeControl,
              h(P.Button, { variant: 'ghost', onClick: selectUnimported, disabled: unimportedCount === 0 }, t('selectAll')),
              h(P.Button, {
                variant: 'ghost',
                title: t('expandAllHint'),
                'aria-label': t('expandAllHint'),
                onClick: expandAllGroups,
                disabled: groups.length === 0,
                icon: IconChevronDown !== undefined ? h(IconChevronDown, { size: 16 }) : undefined,
              }),
              h(P.Button, {
                variant: 'ghost',
                title: t('collapseAllHint'),
                'aria-label': t('collapseAllHint'),
                onClick: collapseAllGroups,
                disabled: expandedGroups.size === 0,
                icon: P.IconChevronUpOutlineRegular !== undefined ? h(P.IconChevronUpOutlineRegular, { size: 16 }) : undefined,
              }),
            ),
            listBody,
            notice === null ? null : h('div', { className: 'ci-error' }, notice),
            h(
              'div',
              { className: 'ci-foot' },
              h(
                'div',
                { className: 'ci-foot-actions' },
                modeControl,
                h('span', { className: 'ci-hint', title: t('modeInfo') }, P.IconInfoOutlineRegular !== undefined ? h(P.IconInfoOutlineRegular, { size: 16 }) : 'ⓘ'),
                h('span', { className: 'ci-group-spacer' }),
                selected.size > 0 ? h(P.Button, { variant: 'ghost', onClick: () => setSelected(new Set()) }, t('clearSelection')) : null,
                h('span', { className: 'ci-meta' }, fmt(t('selected'), { n: selected.size })),
                h(P.Button, { variant: 'primary', disabled: selectedList.length === 0, onClick: () => startImport(selectedList) },
                  fmt(t('start'), { n: selectedList.length })),
              ),
            ),
          ),
        ),
        h(ImportModal, {
          t,
          open: modalOpen,
          status: job?.status ?? null,
          cancelling,
          labels: Object.fromEntries(sources.map((source) => [source.id, source.label ?? source.id])),
          onClose: closeModal,
          onCancel: cancelImport,
          onRetryFailed: retryFailed,
        }),
      );
    }
