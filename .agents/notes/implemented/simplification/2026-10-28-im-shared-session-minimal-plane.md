# Agent Note: IM runs one shared session as an experimental bundle

Status: implemented

English | [中文](2026-10-28-im-shared-session-minimal-plane.zh.md)

## Problem

The IM plane shipped five optional plugins beside the host: per-chat conversations (`dsh-im-session-conversations`), background task workers (`dsh-im-session-tasks`), a one-shot command example (`dsh-im-session-oneshot`), and two turn renderers (`dsh-im-output-summary`, `dsh-im-output-trace`). Together they added about eight thousand lines, a durable `im_tasks` unit, a log-only `im/progress-summary-request` event, and a dedicated `im` profile with its own command-line entry whose default routing was per-chat conversations. The host already contains everything a working deployment needs: durable intake, hosted sessions, publication receipts, the `im_*` tools, and the default dispatcher that delivers every unhandled addressed message to one session shared by every chat.

## Decision

IM is an experimental capability without a profile of its own. The [IM bundle](../../../../packages/experimental/im-bundle/README.md) inserts Host rows into an existing long-running profile and mounts only the host ([`dsh-experimental-im`](../../../../packages/experimental/im/README.md)), the adapters, and [`dsh-experimental-im-session-commands`](../../../../packages/experimental/im-session-commands/README.md). It is neither in `OPTIONAL_BUNDLES` nor in the on-demand catalog, because it adds runtime dependencies and needs credentials and a patch before it does anything; an operator installs it with `dsh plugin add`. Its routing is the host's `defaultDispatch`: one session (`im:dispatcher`) serves every admitted chat, and each delivered message carries an `<im-chat …/>` header naming its chat. `session-commands` resets the `dispatcher` owner by default. Sessions publish only through `im_send`, `im_reply`, and `im_send_file`, because no renderer is mounted and `output` defaults to `none`.

The `im` message source that the host writes on delivered user messages carries only `kind: 'im'` and the `relay` context form ([record](../../../../docs/persistence-changes/2026-10-28-im-message-source.md)). It stays a separate source kind because readers treat `kind: 'user'` as owner input: skill triggering and several context plugins accept only that kind, so external chat text must not carry it. No reader used the earlier `delivery` and `trigger` fields; delivery deduplication uses the deterministic inbox message id.

The `im/message` waterfall and `ctx.im.outputs` remain host extension points, so a deployment can still mount its own routing plugin or renderer.

## Alternatives considered

**Keep a dedicated `im` profile.** A profile with a command-line entry and a startup gate made IM a separate application: it changed the launcher's profile templates and global required entries, and an IM deployment could not share a running Web Host. As Host rows, IM runs in whichever profile already hosts the Agents.

**Keep per-chat conversations as the default.** Per-chat sessions isolate history, but every chat then needs its own composition row, and the shipped profile needed two coordinated source lists. One shared session needs one composition.

**Keep task workers for long work.** A task worker is a hosted session that can publish in a chat after its owner's turn ends. A shared session already publishes in any bound chat, and `dsh-subagent` already runs background work with completion notices; the remaining difference did not justify a durable unit and four tools.

**Keep the summary renderer.** Streamed progress cards improve the chat display but require platform-neutral stream rendering, a forked model request per summary, and a durable event recording that request. Explicit tool publication covers the required behavior.

**Write IM input as `kind: 'user'`.** That avoids a persistence-type change but lets any chat member trigger behavior reserved for the owner.

## Consequences

A deployment configures `sources` and `defaultDispatch` on the `im` row; without `defaultDispatch`, admitted messages are stored and recorded as `ignored`. All chats share one history and one serialized turn queue. `/clear` and `/new` reset the shared session from its home chat, which is the first chat it heard. Users see an answer only when the agent calls a publication tool.

Reintroduce per-chat routing, task workers, or a renderer as a separate plugin on the existing waterfall or renderer registry when a deployment needs it.

Verification: `packages/experimental/im/tests/*.spec.ts`, `packages/experimental/im-session-commands/tests/commands.spec.ts`, `packages/experimental/im-bundle/tests/loader-composition.spec.ts`, and `scripts/im-persistence.spec.ts`.
