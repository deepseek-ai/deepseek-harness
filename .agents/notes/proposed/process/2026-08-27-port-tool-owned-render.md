# Agent Note: Port tool-owned render into current DSH APIs

Status: proposed

English | [中文](2026-08-27-port-tool-owned-render.zh.md)

## Problem

The `dsh-tool-owned-render` prototype (`Chinesezjc/dsh-tool-owned-render`) ships tool-owned render registrants for `read`, `bash`, `write`/`edit`, `grep`/`glob`, and `web_search`/`web_fetch`, written against an older API where `ToolCallBlock` exposed `callView` / `resultView` and the client received host `presentResult` output. Current master derives client cards from raw `block.call` / `block.content` / `block.meta`, and `ctx.slots` requires the `@deepseek-ai/dsh-client-ui-renderer/client` module augmentation. A direct merge of the prototype does not typecheck, so its registrants cannot ship without a port.

## Proposal

- Add `packages/client/tool-owned-render` as a workspace package.
- Port the `read`, `bash`, `write`/`edit`, `grep`/`glob`, and `web_search`/`web_fetch` registrants to derive from current `ToolCallBlock` fields.
- Add a `read_image` registrant using the same ToolCard/Segment primitives.
- Wire `ctx.slots` type augmentation through `dsh-client-ui-renderer`.
- Keep PR #2828 mergeable while this port proceeds separately.

## Alternatives considered

- **Merge the prototype and fix its type errors in place** — rejected: every registrant would have to be re-derived from the current `ToolCallBlock` fields anyway, so the port is the same work with the obsolete `callView` / `resultView` contract already gone.
- **Fold the port into PR #2828** — rejected: the image card is one feature with a defined scope, and a second package plus five more registrants would enlarge the review surface of an already large PR.

## Acceptance criteria

- `packages/client/tool-owned-render` exists as a workspace package.
- The ported registrants derive card state from current `ToolCallBlock` fields and typecheck on master.
- A `read_image` registrant renders through the same primitives as `read`.
- The `ctx.slots` type augmentation resolves through `dsh-client-ui-renderer`.
- PR #2828 merges independently of this port.

## Risks

- The port may not reproduce the prototype's exact visual output, because the current card primitives differ from the old `callView` / `resultView` contract.
- API drift while the port proceeds can stale this proposal; the acceptance criteria are re-checked against master at port time.
