---
kind: upgrade-guide
description: "The PTC executor overlay no longer exposes the workflow tool or loads its workflow engine."
---

# PTC overlay removes the workflow tool

English | [中文](guide.zh.md)

## Change

In earlier releases, [`apps/cli/config/examples/ptc.yml`](../../../../apps/cli/config/examples/ptc.yml) only switched tool execution to PTC, so a headless or SDK run with this overlay still listed the `workflow` tool, its `tool:workflow` system prompt section, and its `run_code` binding. The overlay now also disables the `workflow-ptc` engine and `tool-workflow` rows, as the Web `ptc` agent preset does: `run_code` orchestrates tool calls in code, and the model no longer sees or can call `workflow`. Native execution, which is the default without the overlay, keeps the workflow tool.

This affects TypeScript and Python SDK applications and headless runs that pass the overlay, and any prompt, evaluation, or recorded transcript that expects `workflow` in PTC mode.

## Migration

1. To keep the workflow tool in PTC mode, apply one more patch after the overlay that turns both rows back on:

   ```yaml
   - id: workflow-ptc
     disabled: false

   - id: tool-workflow
     disabled: false
   ```

   Pass it through `--patch` after `ptc.yml`, or after the overlay in the TypeScript or Python SDK `patches` option.
2. Otherwise, move orchestration that called `workflow` into `run_code` programs or `subagent` calls.
3. Confirm with a PTC run: without the extra patch the first model request has no `tool:workflow` section and its `run_code` bindings declare no `workflow` function; with the patch both return.
