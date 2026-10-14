# Defensive patterns

English | [中文](README.zh.md)

Hard-won rules: each pattern in this directory is a requirement this repository enforces in review, stated as the rule and the defect it prevents. Every rule states what must hold, the condition a reviewer judges it by, its boundary and who approves an exception, and a correct and a wrong example. Read the page for the artifact you are about to change, before you change it.

## Why these rules

Five habits cover most of what follows, and each page is their application to one artifact:

- **Make correctness explicit.** Write it into the structure — named call points, explicit lifecycles, explicit conditions and types — rather than compensating for it afterwards with timing.
- **Keep one source of truth.** One read path for a piece of data, one home for a fact, one owner for shared state.
- **Extend through the registered seam.** A new capability registers; an existing carrier stops taking new logic instead of growing a branch inside it.
- **Keep the change face equal to the review face.** A change carries only the lines its stated behavior change needs, a migration moves code rather than rewriting it, and a performance-sensitive change carries its measurement.
- **Require evidence.** A claim is falsifiable and recomputable — measured before and after, or checked by a gate — rather than kept in sync by hand.

| Changing | Read |
|---|---|
| Package exports, package shape, build faces, dependency declarations | [package-surface.md](package-surface.md) |
| Remote services, `@Remote` methods, API dispatch, business ownership at the API layer | [remote-and-api.md](remote-and-api.md) |
| Client components, slots, stores, hooks, effects | [client-components.md](client-components.md) |
| Session reads, retention, conversation nodes, renderers | [conversation-and-session.md](conversation-and-session.md) |
| Timing, state representation, shared ownership, decentralization, refactors, migrations, performance evidence, disposal, callbacks, subprocesses | [general.md](general.md) |

Type definitions and per-subsystem semantics live in [subsystems/](../subsystems/README.md); this directory carries the rules, and the semantics pages carry what the types mean. [dsh-code-review](../../.agents/skills/dsh-code-review/SKILL.md) reads this directory when judging a pull request, and Development routes through the same table from [AGENTS.md](../../AGENTS.md).
