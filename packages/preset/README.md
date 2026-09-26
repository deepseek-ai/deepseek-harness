---
description: "This group declares Agent capabilities through ordinary Cordis configuration and manages selection and runtime revisions. The Host shares the Agent loop; each Agent sees the tools, prompts and skills of its selected revision."
kind: "package-group"
---

# packages/preset

English | [中文](README.zh.md)

## Summary

This group declares Agent capabilities through ordinary Cordis configuration and manages selection and runtime revisions. The Host shares the Agent loop; each Agent sees the tools, prompts and skills of its selected revision.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [agent-preset-registry](agent-preset-registry/README.md) | Selection, revision retention and profile editing | `ctx.agentPresets` |
| [agent-preset](agent-preset/README.md) | Declarative child plugins and metadata | — |
| [persona](persona/README.md) | Composable Agent persona | — |

<a id="related-documentation"></a>
## Related documentation

- [Scope](../../docs/subsystems/scope.md)
- [Cordis](../../docs/cordis-primer.md)
- [Agent preset](../../.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md)

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
