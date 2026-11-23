---
kind: upgrade-guide
description: "The @deepseek-ai/dsh-tool-cordis/host plugin entry is removed; cordis-host-runner registers the Host inspect providers."
---

# Host inspect providers move into `cordis-host-runner`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-cordis/host` no longer exists. `@deepseek-ai/dsh-cordis-host-runner` now registers the Host inspect providers (`Service`, `Event`, `Config`, `Runtime`, and `Tool`) when it mounts, so a composition no longer mounts a separate providers row. The `@deepseek-ai/dsh-tool-cordis` row in each agent preset still registers `cordis_inspect`. Shipped profiles are already updated. A custom `cordis.yml`, patch, or overlay that names `@deepseek-ai/dsh-tool-cordis/host` fails to load that row after the upgrade, and code that imports the subpath fails to resolve it.

## Migration

1. Delete every Loader row whose `name` is `@deepseek-ai/dsh-tool-cordis/host`, usually with `id: cordis-inspect-providers`. Keep the `@deepseek-ai/dsh-cordis-host-runner` row in the host composition.
2. Remove imports of `@deepseek-ai/dsh-tool-cordis/host`; mounting `@deepseek-ai/dsh-cordis-host-runner` registers the same providers.
3. Confirm that `cordis_inspect` called without `query` lists the Host providers `Service`, `Event`, `Config`, `Runtime`, and `Tool`.
