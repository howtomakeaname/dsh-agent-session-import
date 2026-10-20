# Changelog

## 0.2.2 — 2026-10-20

- Host 导入服务拆分为 state/jobs/scan 模块，端点错误结构统一。
- 修正来源展示顺序为 Codex、Claude Code、Cursor、ZCode、Kimi，并更新界面预览截图。

## 0.2.1 — 2026-10-20

- 精简来源列表，仅保留开源工具的本地历史导入。
- 首次进入导入面板时显示加载状态（spinner + skeleton 占位），避免空白等待。

## 0.2.0 — 2026-10-20

首个公开版本。

- Sources: Codex (CLI and the Codex app bundled in ChatGPT.app share
  `~/.codex`), Claude Code, Cursor IDE (Agent/Composer), ZCode, and Kimi
  (Agent/Kimi Code).
- Sidebar panel with a source rail, conversations grouped by project folder,
  search, Unimported/All filter, group-level selection and a progress/results
  dialog with retry for failed imports.
- Two import modes: **Faithful** keeps reasoning/tool blocks as structured cards,
  **Resume-safe** keeps the same content as plain text so any model can resume.
- Imported sessions get a provenance note and an empty protected system head;
  sessions are written as v4 logs and their title projections are warmed.
- Provider plugin architecture: add a `lib/host/providers/<id>.js` module and one
  registry line to support another agent.
