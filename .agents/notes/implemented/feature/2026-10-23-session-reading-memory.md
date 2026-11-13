# Agent Note: Host-memory Session reading state

Status: implemented

English | [中文](2026-10-23-session-reading-memory.zh.md)

## Problem

Clients connected to the same Host need consistent reading reminders, including completions that end while every Client is offline. Automatic acknowledgements must not clear unseen completions or manual unread marks. Reading activity must not change model history. The reminders appear in the Client Session status table that [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.md) owns, so the reading records, their Client follower, and the table that consumes them need one owner whose Client face may follow a Host Remote stream.

## Decision

### Package structure

`@deepseek-ai/dsh-client-ui-session-status` owns the feature on both faces, following the Host-and-Client package precedent of ui-trajectory:

| Face | Service | Responsibility |
|---|---|---|
| Host (`.`) | `ctx.sessionStatus` (`SessionStatusService`) | Keeps one reading record per Session in an in-memory Map; the `sessionStatus` Remote namespace serves `mark` and `follow`; failures use `session-status/not-found` and `session-status/unavailable` |
| Client (`./client`) | `ctx.uiSession.sessionStatus` (service name `uiSession.sessionStatus`) | Follows the Host reading stream, builds the status table with `completionUnread` and `completionFailed`, exposes `mark` and `readingReady`, and acknowledges main-view reading |

The Client copy of the reading records is a package-internal module: it exports no value or type and provides no Client service of its own, so consumers such as ui-workspace and ui-conversation depend only on `ctx.uiSession.sessionStatus` and the exported status types. The Web bundle's single `ui-session-status` row loads both faces, api/remotes mounts the package's `/remote` descriptor, and the Web client lists the package among its required boot entries. ui-session, pending-interaction registration, and `ctx.uiSession.pendingInteractions` stay unchanged.

### Client dependency rules

Following the Host stream needs the Gateway's `RemoteSnapshotStream` at runtime. `verify-client-packages` lets a `packages/client` feature package request rows under `packages/api/` through `dsh.client.external`, while still rejecting requests for another feature plugin's row; the Remote API group is infrastructure, not a feature plugin. The package requests only `@deepseek-ai/dsh-api-gateway/client`. The stream runs only while `ctx.remoteAccess` allows `sessionStatus/follow`; that endpoint is owner-only for LiveShare, so a viewer page opens no stream, keeps `readingReady` false, and reports no synchronization failure.

`RemoteStream` decides reconnection by the stable error code `gateway/carrier-lost` rather than by `instanceof RemoteStreamCarrierError`. The class carries that code, so existing callers keep their behavior, and the package's `ended` callback returns a plain `Error` with the code, typed by the exported `RemoteStreamCarrierFailure` type, without importing the class. The code is produced only inside the Client process: a `RemoteError` returned by the Host terminates the stream even when it carries the same code.

### Host records

The Host service owns one in-memory record per Session and derives the latest ended turn and its failure flag from `turn/end` events itself. Mutations update the Map synchronously. Read actions carry the Client-observed completed turn; the Host advances the read position monotonically and never beyond its known completion. Automatic acknowledgements leave manual unread unchanged; explicit marks replace it in Host processing order. Only the ordered baseline and whole-record change stream updates the Client, so mutation replies need no record or revision.

Cold Session marks read metadata without opening history. A Session without a record reads as read, so history neither needs a startup scan nor distinguishes a cold Session from a live zero-turn one. Shutdown closes followers and clears records. A pending metadata lookup rejects its mark after disposal rather than delaying teardown for an in-memory write.

### Automatic acknowledgement

Only a visible, focused main view acknowledges reading, after a rendering frame and evidence that the body reached the completed turn. Window focus advances only the natural read position. A main-view switch to a different Session, including the first selection after a page load, clears that Session's existing manual reminder once its body arrives; the check waits for a ready reading baseline. Window focus, a replaced binding for the same Session, and activity in the open Session do not clear it, so a mark made in the open Session stays until the view leaves and returns. Later automatic acknowledgements preserve manual marks, including those received while the body loads. Keeping the rule inside the acknowledgement plugin avoids a cross-package reading event and changes to the Conversation body. While the visible, focused main view retains an open Session, the status table does not show that Session's unacknowledged completion, so its row does not flash unread before the acknowledgement round trip; manual marks stay visible, and the reminder returns when the window loses focus or the view moves away first. Archived rows read as read and offer no reading mark.

## Alternatives considered

- **ui-session reads reading state:** the base UI package would depend on a feature package, and every UI above it could not start without the reading plugin.
- **A separate reading package with a Client service:** consumers would see a second reading API beside `ctx.uiSession.sessionStatus`, and the status table would depend on another package's service only to fold its records.
- **An api-group reading package beside the client table:** splits one feature across two packages whose Host contract, Client follower, and table evolve together; the relaxed external rule lets the client package follow the stream itself.
- **Reimplementing the snapshot protocol over `ctx.remote.$stream`:** duplicates Gateway-owned baseline and reconnection logic in a feature package.
- **Importing `RemoteStreamCarrierError` into the client package:** a feature package would depend on a Gateway class identity for one retry decision; a stable code states the decision without class identity across separately bundled modules.
- **Host face in the shared base bundle:** profiles without a Web Client would run a reading service no Client reads, and the Host face would load from a different bundle than its Client face.
- **Frontend memory or local storage:** cannot provide one authority for browsers and Desktop clients, or collect completions while all frontends are offline.
- **Persistent Host records:** preserve reminders across Host restarts but require a separate lifecycle design for Session checkpoints, domain ownership, backend shutdown, and failed writes. This implementation deliberately limits ownership to memory; persistence is a separate change.
- **Reading events in the Session log:** mix viewer intent with model history and require loading cold histories for metadata-only actions.
- **Revision-based conditional writes:** prevent delayed explicit actions from replacing newer manual intent, but require conflict responses, revision bookkeeping and unary-result reconciliation. Session reminders accept Host processing order instead. A read-position cursor still prevents unseen completions from being acknowledged.
- **Message ID cursor:** identifies a message but does not order completed turns, including failures without a new assistant message. The existing completed-turn number directly represents this feature's unit of progress.

## Consequences

Browser refresh and temporary disconnect preserve reminders while this Host service runs. Host restart or plugin reload resets every reading record and treats existing history as read; a turn that failed before the restart leaves no outcome, so marking that Session unread shows the ordinary reminder. Profiles without the Web bundle run no reading service. There are no read-state files, storage-domain dependencies, checkpoint writes, or cross-process synchronization guarantees. Reminders remain for detached Sessions until the service stops; reclaiming records requires a Session deletion lifecycle.

Concurrent explicit actions have last-processed semantics; an entry acknowledgement can clear another manual mark that arrives before it is processed. Verification covers two followers, monotonic read positions and manual-mark preservation during automatic acknowledgements, a first completion after manual marks, access-driven rebaselines, shutdown with a pending metadata lookup, service reload, independence from Session flush, and the failure flag of a completing turn. Client tests cover the reading stream's baseline replacement and terminal failure, delayed body delivery, manual marks during loading, and manual-reminder clearing on main-view switches but not on window focus or a replaced binding. Gateway tests cover reconnection for a plain error carrying the carrier code and termination without it. Persistent restart recovery, crash consistency, storage-provider ordering, and cross-process writers require separate validation before persistence is enabled. The main-view retention signal does not distinguish every settings or auxiliary panel; that visibility refinement remains part of the notification work.
