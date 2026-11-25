# B: Backend

English | [中文](backend.zh.md)

Rules for Host-side packages: agent runtime, services, tools, and process management.

<a id="b1"></a>
## B.1: Drive plugin work from lifecycle events, not loops that poll Agent state

### Reason

- Time-of-check to time-of-use races. Input can start a turn, or disposal can begin, between the moment `whenIdle()` resolves or a state read returns and the moment the loop acts on it. Each fix adds another re-check and another `continue`.
- Duplicated state. The loop rebuilds, from status reads and sequence comparisons, a transition that the Agent loop already knows and can report exactly once.
- Unowned lifetime. A detached loop runs outside the plugin's effects, so disposal does not stop it and its failures reach no owner.
- Design signal. A plugin that needs such a loop usually lacks the lifecycle event or API it depends on.

### Example, bad

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'

declare function publishSummary(agent: Agent): Promise<void>

/** Publish a summary after each completed turn. */
export function watchSummaries(agent: Agent): void {
  void (async () => {
    let published = agent.session.seq
    while (true) {
      await agent.whenIdle()
      if (agent.session.seq !== published) {
        published = agent.session.seq
        await publishSummary(agent)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })()
}
```

A follow-up can start a turn between `whenIdle()` and the `seq` read, so the summary covers a turn that has not ended. Turns that finish within one interval produce one summary. After disposal, the loop keeps polling. A rejected `publishSummary` ends the loop with an unhandled rejection.

### Example

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

declare function publishSummary(session: Session, turn: number): void

/** Publish a summary after each completed turn. */
export function watchSummaries(agent: Agent): void {
  agent.ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      publishSummary(session, event.data.turn)
    }
  })
}
```

The `turn/end` event names the turn it ends and why. The listener is an effect of the Agent context, so it receives only that Agent's Sessions, and disposal removes it. Session event listener failures are logged and contained. A `session/event` listener cannot append to the Session that is publishing the event; the append throws.

### Alternative

- Work at a turn or message boundary: listen to the Session event that records it, such as `turn/start` or `turn/end`, on `session/event`.
- Work that appends to the Session when a turn ends: listen to `agent/turn-stopping`, which runs before `turn/end` is appended.
- Work before a model request: register an `agent/pre-step` listener.
- Work when the Agent becomes idle or starts running: listen to `agent/status`.
- Cleanup of resources owned by one Agent: register it with `agent.ctx.effect()`, which runs the disposer when the Agent scope unwinds. A listener on `agent.ctx` is removed before `agent/disposed` is emitted, so only a longer-lived context, such as the plugin context, can observe `agent/disposed`.
- Work that must run while the Agent is idle and keep new turns from starting: call `runMaintenance()` synchronously from the listener that observes idleness, such as `agent/status` with `idle`. It throws when other work already owns the Agent.
- No event reports the transition you need: add the lifecycle event or API to the package that owns the state, and update its documentation, instead of observing that state from outside.

### Exception

- A single `await agent.whenIdle()` that is not repeated, such as in a test.
- The package that implements Agent idleness itself, such as `whenIdle()` in `dsh-agent-loop`.

### Note

A loop that polls Agent state is a `while`, `for`, or self-rescheduling callback whose iterations wait for or read Agent or Session runtime state, such as `whenIdle()`, `status`, `session.seq`, or pending input, and decide from it whether to act, wait again, or stop.

### Enforcement

Review: flag a new or changed loop in package source that awaits `whenIdle()` or reads Agent or Session runtime state on each iteration to decide whether to act.
