# Agent Note: structured index injection table (webserver/index-inject)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-19-web-index-injection-table.zh.md)

## Problem

The web shell's boot HTML needs three kinds of injection: client-modules' boot protocol (the `__ModuleLoader__` registration queue inline script, the parser-blocking preload `<script src>` tags, the `__DSH_BOOT__` graph global) and ui-theme's first-paint theme script. The old mechanism was `webServer.tapIndex(html => html)` string transforms: each registrant regex-located `<head>`/`<body>` and spliced HTML on its own. The static worker deployment (the page is a build artifact; the host tree runs in a Web Worker) has no serve-HTML step at all, so the worker side hand-copied the same data into its `/__boot__` payload (`graph` + `theme` via `ctx.get`), and the page side re-implemented what the taps did (a facade installer, a theme applier, a preload loop) — one boot semantics, three implementations.

## Decision

Make the injection surface an event over pure data: the webserver declares the `webserver/index-inject` event and the `IndexInjection` row union (`global`/`script`/`script-src`/`script-preload`/`style`/`html`, with placement where applicable). A plugin that wants to inject subscribes and pushes rows; every collection (`collectIndexInjections()`) is a fresh emit, so subscribers read live state at emit time (module graph, theme preference — no re-registration staleness), and a subscription dies with its fiber.

One table, two renderers: the served form's `webServer.renderIndex(html)` renders rows into index.html deterministically (head rows after the opening head tag, body rows after the opening body tag; `<` JSON-escaped in global values, attribute-escaped `src`); the worker form's `/__boot__` payload is `{ injections }`, executed row by row by a small page-side interpreter (set global / create script element / load external through the tunnel's `loadBundle` / mount style and markup). A `script-preload` row renders a browser preload hint in served HTML and is ignored by the worker interpreter, whose `/plugins` resources exist only behind the tunnel and load on demand. Rows are pure JSON data — that is the both-ends-equivalent discipline.

`tapIndex`/`applyIndexTaps` survive as the raw-HTML escape hatch, applied after row rendering; every internal consumer moved to the event.

## Consequences

- client-modules and ui-theme no longer regex-edit HTML; the worker's `readBootPayload` service-poking (`clientModules`, `settings`, theme constants through `loader.load`) is deleted; the page-side `installModuleLoaderFacade`, `applyBootTheme`, and `PARSER_PRELOAD_IDS` re-implementations retire.
- Ordering: across subscribers, subscription order (same as the old tap order); within one subscriber, push order — modules itself guarantees queue → application preload → bootstrap script → global.
- The served rendering of the manifest global changed from `window.__DSH_BOOT__ =` to `globalThis["__DSH_BOOT__"] =`; no committed snapshot expectation carries that text, so none needed re-recording.
- New model-visible or page-visible boot inputs extend the row union; no new tap consumers.

## Alternatives considered

- **Keep tap functions, add a worker-side renderer that re-runs them over a fake document** — rejected: taps are opaque `html => html` closures, so the worker cannot serialize or replay them without shipping a DOM emulation into the boot path.
- **A registration-style table (`registerInjection(row): dispose`)** — rejected for the two problems the event dissolves: rows staled against live state (theme preference, module graph) unless every producer re-registered on change, and every producer owned one more disposer. The per-emit pull reads fresh state with fiber-scoped cleanup for free.
- **Deleting `tapIndex` outright** — rejected: an escape hatch for raw HTML transforms costs nothing while the table is young, and external compositions may have transforms no row kind expresses yet.
