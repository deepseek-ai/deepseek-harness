---
description: "The connector group map: application plugins that connect a third-party service to agents through existing Skill, Shell, and subprocess capabilities, and the CLI account and upstream skills Services they register with."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each application plugin in this group is installed into a profile to use one third-party service in conversations. A plugin composes existing capabilities, such as skills, runtime context, and subprocesses, and keeps application-specific configuration and model guidance in its own package. Plugins whose vendor CLI keeps the user's account register that CLI and account with the CLI account Service, which runs their commands and account operations, and plugins whose upstream skills exist only in the vendor's GitHub repository register their entry skill with the upstream skills Service, which downloads them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cli-account/`](cli-account/README.md) | Holds the vendor CLIs and accounts CLI app plugins register: gives the model each CLI's absolute path in runtime context, runs each plugin's account operations one at a time, and shows the account on the Plugins page | `ctx.cliAccounts` |
| [`upstream-skills/`](upstream-skills/README.md) | Holds the entry skills CLI app plugins register: downloads the upstream files each entry indexes from a pinned commit of the vendor's GitHub repository, verifies and caches them, and lists the entry skill over them | `ctx.upstreamSkills` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Skill subsystem reference](../../docs/subsystems/skills.md) — the registry and provider contract that connector skills use.
- [System prompt](../core/system-prompt/README.md) — the registry that orders and renders runtime context.
- [Connector account surfaces](../client/ui-connector-account/README.md) — the Plugins page registry where CLI app plugins show their accounts.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
