# Changelog

## 0.2.0 — 2026-10-20

First public release.

- Sources: Cursor IDE (Agent/Composer), Codex (CLI and the Codex app bundled in
  ChatGPT.app share `~/.codex`), Claude Code, ZCode, Kimi (Agent/Kimi Code),
  and Kimi.
- Sidebar panel with a source rail, conversations grouped by project folder,
  search, Unimported/All filter, group-level selection and a progress/results
  dialog with retry for failed imports.
- Two import modes: **Faithful** keeps reasoning/tool blocks as structured cards,
  **Resume-safe** keeps the same content as plain text so any model can resume.
- Imported sessions get a provenance note and an empty protected system head;
  sessions are written as v4 logs and their title projections are warmed.
- Provider plugin architecture: add a `lib/host/providers/<id>.js` module and one
  registry line to support another agent.
