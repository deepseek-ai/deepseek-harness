# Agent Note: Web connection recovery control

Status: implemented

English | [中文](2026-08-28-web-connection-recovery-control.zh.md)

## Problem

The Web Client automatically rebuilt its Remote event generation and physical WebSocket after a failure, but the page exposed neither the outage nor a user recovery action. Its logical-generation and physical-socket retry loops could also drift: a `retry #N` message could describe another logical generation while the browser still waited on the same physical connection candidate. The Host sent an idle WebSocket Ping only every 30 seconds, and a user could not request a fresh attempt after restoring the Host or network.

## Decision

The Host sends WebSocket Ping control frames every two seconds by default through the existing validated `websocketHeartbeatIntervalMs` configuration. Before each Ping it marks the socket as awaiting Pong; a socket still awaiting Pong at the next interval is terminated. `ConnectionController` is the sole retry scheduler. Online transport failures enter jittered exponential backoff whose cap starts at 500ms, doubles through 1s, 2s, 4s, and 8s, and stops growing at 10s; the actual delay is 50–100% of the cap. The [continuous recovery decision](../bug-fix/2026-09-05-continuous-client-recovery.md) supersedes this note's finite retry policy: attempts continue at the capped interval, and handshake readiness has a hard deadline. Each physical retry publishes `connecting`, writes one `retry #N` warning, asks Gateway mux to replace any candidate or active socket exactly once, and reopens the internal `$events` stream.

The Client Connection service exposes the identity-stable `ctx.connection.state` observable and `ctx.connection.reconnect()`. Its snapshot is undefined until the first connection outcome, then carries `disconnected`, `connecting`, or `connected`; equivalent states do not notify. Manual reconnect interrupts the current generation or retry delay, resets the attempt number, and starts retry 1 immediately through the same physical and logical path as automatic recovery. The browser's `offline` event immediately aborts active connection work, publishes `disconnected`, and suspends automatic retries. The next `online` transition publishes `connecting`, resets the attempt number, and starts again at the 500ms backoff tier; duplicate events do not create another loop. A fresh `$events` ready frame, rather than `navigator.onLine`, proves Host connectivity. Logical streams continue to own their baseline, cursor, and replay semantics after the replacement generation.

The [Web Client architecture](../architecture/2026-07-19-gui-web-client-architecture.md), [Remote event delivery](../architecture/2026-08-10-remote-event-delivery.md), and [Session event transport](../architecture/2026-08-18-session-history-and-event-transport.md) retain their broader ownership decisions; this note supersedes only their former retry timing.

The Settings shell is a recovery-specific consumer and therefore injects Connection directly; ordinary feature code continues to use `ctx.remote`. Its private hooks compartment binds the state observable and reconnect command. The expanded sidebar renders `ConnectionIndicator` immediately to the right of Settings: `disconnected` is a pale-yellow **Disconnected** action, `connecting` displays **Reconnecting** in yellow while one to three dots advance every 500ms independently of retry timing, and a recovered connection displays pale-green **Connected** for two seconds. Hover or keyboard focus on either yellow state changes only the text to **Reconnect now**; press feedback uses a small warning-color transition, and no native title tooltip is present. Every visible state reserves the widest localized label and uses fixed icon and left-aligned text columns, so state changes do not move or resize the control. Initial startup and uninterrupted healthy operation render nothing.

## Alternatives considered

**Retry every two seconds without a terminal state.** Rejected because a long outage would create continuous connection traffic. The retained exponential policy retries quickly at first, becomes progressively quieter, and retains the recovery action during retries. The continuous recovery decision governs retries after the cap is reached.

**Render a full-width `ConnectionBanner` at the top of the viewport.** Rejected because the status belongs beside the recovery action the user named, and a global overlay consumes unrelated page chrome. The primitive is the inline `ConnectionIndicator`; no `ConnectionBanner` compatibility export exists before the first tagged release.

**Expose lifecycle control through `ctx.remote.$connection`.** Rejected because retry state and commands belong to the Connection service rather than the Remote method namespace. Direct `ctx.connection` use remains exceptional and is appropriate here because the indicator itself controls reconnection.

**Retry only when the user clicks.** Rejected because recovery must remain automatic when the user is not watching the page; the button resets the backoff and bypasses its current wait.

## Consequences

Idle browser connections generate more frequent heartbeat traffic than the former default, while long outages retain capped connection attempts under the continuous recovery decision. Deployments may override the Host Ping interval. Gateway mux owns no second retry timer, so every `retry #N` warning corresponds to one Controller-requested physical attempt.

A manual reconnect intentionally disrupts every logical Remote stream sharing the physical socket. Their existing generation supervisors restore state through fresh baselines or cursors, and one-way notifications remain non-replayed.

The connection state and browser-network input stay in the React-free transport layer. The Settings component receives a framework-bound selector hook and a plain callback, so no UI store duplicates transport state; only the two-second success presentation and 500ms dot animation are presentation-local.

## Testing

Connection and Gateway tests pin the two-second heartbeat and Pong deadline, exponential retry caps and logs, browser offline suspension and online reset, manual sequence reset, one socket replacement per requested attempt, state deduplication, listener isolation, and disposal. Component tests pin healthy-state absence, hover/action copy, the independent dot animation, click behavior, and the two-second success state. The assembled Web test drives browser offline/online transitions, failed WebSocket attempts, stable indicator geometry, manual recovery, and the success confirmation through the shipped application.
