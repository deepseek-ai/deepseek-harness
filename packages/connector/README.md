---
description: "The connector group map: application plugins that connect a third-party service to agents through existing Skill, Shell, and subprocess capabilities, and the libraries they share."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each application plugin in this group is installed into a profile to use one third-party service in conversations. A plugin composes existing capabilities, such as skills, runtime context, and subprocesses, and keeps application-specific configuration and model guidance in its own package. Plugins whose vendor CLI keeps the user's account share the CLI account library for running commands and account operations, and plugins whose upstream skills exist only in the vendor's GitHub repository download them through the upstream skills library.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cli-account/`](cli-account/README.md) | Runs a vendor CLI by its absolute path, gives the model that path in runtime context, and runs one Host-owned account operation at a time for CLI app plugins | — |
| [`tencent-meeting/`](tencent-meeting/README.md) | Bundles the Tencent Meeting plugin: the `tencent-meeting-cli` Host row and its Plugins page row | — |
| [`tencent-meeting-cli/`](tencent-meeting-cli/README.md) | Installs the official `tmeet` on the private Shell PATH, registers its skill, and runs the account operations the Plugins page drives | `ctx.tencentMeeting`; registers on `ctx.skills` and `ctx.shellEnv` |
| [`upstream-skills/`](upstream-skills/README.md) | Downloads the upstream files that a CLI app plugin's entry skill indexes from a pinned commit of the vendor's GitHub repository, verifies and caches them, and lists the entry skill over them | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [Skill subsystem reference](../../docs/subsystems/skills.md) — the registry and provider contract that connector skills use.
- [System prompt](../core/system-prompt/README.md) — the registry that orders and renders runtime context.
- [CLI plugin page pieces](../client/ui-cli-account/README.md) — the Plugins page half of the CLI account library.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
