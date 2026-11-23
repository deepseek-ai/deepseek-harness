---
kind: upgrade-guide
description: The SDK profile adds the cordis_inspect runtime inspection tool.
---

# SDK runtime inspection tool

English | [中文](guide.zh.md)

## Change

The `sdk` profile now mounts `cordis-host-runner`, which provides the inspection registry and its Host providers, and `tool-cordis`, so the model receives `cordis_inspect` as the Desktop standard and Creator presets provide it. Host queries read Service, Event, Config, Runtime, and Tool data; the directory lists no Client providers because the SDK serves no browser. `sdk-minimal` is unchanged.

## Migration

1. Review pinned prompts, tool schemas, and tool-name allowlists for the added `cordis_inspect` definition.
2. To keep the previous tool roster, disable the `tool-cordis` row in a profile patch:

   ```yaml
   - id: tool-cordis
     disabled: true
   ```

   This removes only the tool. To also remove the inspection registry and Host providers from the process, disable the `cordis-host-runner` row as well.

3. Run a task and confirm that the first model request lists `cordis_inspect` exactly when the row is enabled.
