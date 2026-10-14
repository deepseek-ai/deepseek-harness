---
description: "The connector group map: application plugins that connect a third-party service to agents through existing Skill, Shell, and subprocess capabilities, and the CLI account library they share."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each application plugin in this group is installed into a profile to use one third-party service in conversations. A plugin composes existing capabilities, such as skills, private Shell PATH entries, and subprocesses, and keeps application-specific configuration and model guidance in its own package. Plugins whose vendor CLI keeps the user's account share the CLI account library for running commands and account operations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cli-account/`](cli-account/README.md) | Runs a vendor CLI on the private Shell PATH and one Host-owned account operation at a time for CLI app plugins | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [Skill subsystem reference](../../docs/subsystems/skills.md) — the registry and provider contract that connector skills use.
- [Shell environment](../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [CLI plugin page pieces](../client/ui-cli-account/README.md) — the Plugins page half of the CLI account library.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
