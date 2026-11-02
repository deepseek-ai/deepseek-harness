---
description: "The team package group: shared task coordination for subagent trees and its model-facing tools."
kind: "package-group"
---

# team/ — shared task coordination

English | [中文](README.zh.md)

## Summary

The Team packages let agents in a subagent tree share task ownership and dependencies. The service saves each root Session’s Team selection and task board. The tool plugin exposes task operations and collaboration guidance to the model. Subagent creation, discovery, messaging, and interruption remain in the subagent package family.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`agent-team/`](agent-team/README.md) | Shared task board and saved Team mode for a subagent tree | `ctx.agentTeams` |
| [`tool-agent-team/`](tool-agent-team/README.md) | Exposes shared task tools while Team mode is enabled | registers on `ctx.tools` |

<a id="related-documentation"></a>
## Related documentation

- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — task types, events, and the service API.
- [Subagent packages](../subagent/README.md) — delegation, discovery, and communication.

<a id="dev-note"></a>
## Dev Note

None.
