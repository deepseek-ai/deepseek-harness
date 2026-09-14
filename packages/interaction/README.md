---
description: "Package map for the human-collaboration capability family: slash commands, one-shot approvals, permission presets, and the question/answer seam that lets a running agent pause for a human decision."
kind: "package-group"
---

# interaction/ — the human-collaboration plane

English | [中文](README.zh.md)

## Summary

The `interaction/` group covers the ways a person can guide a running agent. Use slash commands for immediate actions that do not require a model round trip, one-shot approvals for sensitive operations, permission presets to choose sandbox and approval behavior together, and questions when the agent needs information or a decision. Interactive applications expose these capabilities to people; automation handles its own approvals through ACP. The package map below distinguishes each capability and links to its full behavior and configuration.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README and its subsystem reference own the exhaustive contracts.

| Package | Role | ctx key |
|---|---|---|
| [`commands/`](commands/README.md) | Lets users type slash commands that run directly against an agent without a model round trip | `ctx.commands` |
| [`user-approval/`](user-approval/README.md) | Asks composed answerers for one-shot allow/reject decisions and fails closed without one | `ctx.approval` |
| [`permission-presets/`](permission-presets/README.md) | Bundles sandbox mode with an approval policy into one user-facing Permissions selector | `ctx.permissionPresets` |
| [`user-questions/`](user-questions/README.md) | Defines the validated question schema and scoped answerer waterfall an agent pauses on | `ctx.userQuestions` |
| [`tool-ask-user/`](tool-ask-user/README.md) | Exposes the `ask_user_question` tool so the model can ask the human for a decision | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the shared vocabularies, then the neighboring automation and composition surfaces.

- [Commands subsystem](../../docs/subsystems/commands.md) — command registry semantics and the `ctx.commands` Cordis surface.
- [Approval subsystem](../../docs/subsystems/approval.md) — request/outcome vocabulary, the answerer waterfall, and per-session policy.
- [Permission presets subsystem](../../docs/subsystems/permission-presets.md) — the preset table and the knob write-through.
- [User interaction subsystem](../../docs/subsystems/user-questions.md) — question vocabulary, answerer waterfall, and presentation intent.
- [ACP group](../acp/README.md) — the automation-only transport that answers approval requests for its own agents.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
