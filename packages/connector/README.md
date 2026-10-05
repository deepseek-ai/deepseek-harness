---
description: "The connector group map: application plugins that connect a third-party service to agents through existing Skill, Shell, and subprocess capabilities, and the CLI account library they share."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each application plugin in this group is installed into a profile to use one third-party service in conversations. A plugin composes existing capabilities, such as skills, runtime context, and subprocesses, and keeps application-specific configuration and model guidance in its own package. Plugins whose vendor CLI keeps the user's account share the CLI account library for running commands and account operations.

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
| [`feishu/`](feishu/README.md) | Installs the official Feishu `lark-cli` on the private Shell PATH and registers its embedded skills | registers on `ctx.skills` and `ctx.shellEnv` |

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
