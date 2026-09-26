# Agent Note: Plugin detail pages as an extension point

Status: implemented

English | [中文](2026-09-17-plugin-detail-page-extension-slots.zh.md)

## Problem

The Plugins page's detail pages — a bundle's page, a row's page, an official plugin's page — carried only what the page drew itself and the object's own configuration ([plugin configuration on the Plugins page](2026-09-16-plugin-configuration-on-the-plugins-page.md)). A plugin with something to say about a bundle it does not own — a diagnostics plugin's health check, a market plugin's update badge, a documentation plugin's README section — had no place on that bundle's page, and importing the page to extend it is forbidden by the client bundle purity rule.

## Decision

**The page declares three list slots keyed by region, not by object.** `plugins.detail.actions` renders at the head of a page before the page's own switch and uninstall; `plugins.detail.badge` beside the title after the version, beta, and problem tags; `plugins.detail.section` under the page's own content — after the rows on a bundle's page, after the configuration on a row's or an official plugin's page. Each entry is rendered with the page's `subject`: `{ kind: 'bundle', pkg }`, `{ kind: 'row', pkg, row }`, or `{ kind: 'item', id }`. An entry decides from the subject whether to render and returns null otherwise; the page orders entries by `order`.

**The subject is a projection, not the store.** `PluginPackageRef` and `PluginRowRef` carry the name, version, installed and enabled facts, and the row list — the facts a contribution decides on — and nothing of the page's own state, so the page's store stays private and the contract stays small.

**A row's page still exists only for a configured row.** A list entry cannot say in advance which rows it has something for, and a row page with nothing on it shows nothing worth opening, so the configure control keeps its rule: a row is opened when a `plugins.row.config` entry names it, and contributions for the row render on that page.

## Alternatives considered

**One slot per object and region (`plugins.bundle.section`, `plugins.row.section`, ...).** Rejected: nine slots for three regions, and a contribution that spans objects would register three times. The subject discriminator carries the same information in three slots.

**Passing the page's `PackageView` and `PackageRow` as the subject.** Rejected: those types carry the Host's read-only reasons, errors, entry ids, and fiber phases, which are the page's business; exposing them would make store internals a public contract.

**Every row gets a page so row contributions always have a home.** Deferred: a row without configuration has nothing a page would show beyond its module and state; the rule can widen when a contribution needs it.

## Consequences

- A contribution is a slot registration with `import type` of `ui-plugin-manager` for the declarations; the page never names a contributing plugin.
- The e2e fixture bundle (`@fixture/live-client`) contributes to its own bundle and row pages through the three slots; its browser half registers them with the rest, and they leave with it.
- The slot catalog and the slots subsystem hierarchy list the three slots under `main`.

## Testing

`packages/client/ui-plugin-manager/tests/components.client.spec.tsx` renders contributions on a bundle's page, a row's page, and an official plugin's page with the subject each is about, and pins the projection; `browser-plugin.client.spec.tsx` pins the declarations. `apps/web/tests/plugin-config.e2e.ts` switches the fixture bundle on and asserts its action, badge, and section on the bundle's page and the row's page, their absence on an official plugin's page, and holds the bundle page's golden.
