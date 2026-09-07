---
description: "The skill group map: reusable agent instructions discovered from providers and loaded through the session catalog and skill tool, for users and maintainers navigating the group."
kind: "package-group"
---

# skill/ — skill capability family

English | [中文](README.zh.md)

## Summary

The skill group gives agents and users access to reusable, task-specific instructions on demand. Providers contribute skills — from local project or user directories, bundled packages, or remote services — and the registry merges their catalogs and resolves the winning skill for each name. A consumer publishes the available skills as a durable session catalog and exposes a model-facing `skill` loader tool, so the model sees sorted skill names and descriptions and can load the full instructions of any listed skill; users can also invoke a skill directly with `/name`. Provider type does not change what the model sees, because all model-facing rendering lives in one consumer package. Mount the packages you need: the registry plus at least one provider, and the consumer for model access.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`skill/`](skill/README.md) | Registry that merges skill catalogs from any provider and resolves the winning skill for a name | `ctx.skills` |
| [`skill-filesystem/`](skill-filesystem/README.md) | Discovers skills from project, custom, and user directories and watches them for changes | registers on `ctx.skills` |
| [`skill-badge/`](skill-badge/README.md) | Bundles the official "powered by dsh" badge skill, disabled by default | registers on `ctx.skills` |
| [`tool-skill/`](tool-skill/README.md) | Publishes the session skill catalog and the model-facing `skill` loader tool | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then read the Agent Notes for the design rationale.

- [Skill subsystem reference](../../docs/subsystems/skills.md) — the registry, provider contract, local discovery priority, and the catalog and tool.
- [Skill invocation policy Agent Note](../../.agents/notes/implemented/feature/2026-07-28-skill-invocation-policy.md) — the model and user invocation controls.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
