---
kind: upgrade-guide
description: "Automatic model switches require a valid destination pressure budget and successful compaction."
---

# Model switches check destination context pressure

English | [中文](guide.zh.md)

## Change

With `compaction-basic` automatic mode enabled, a provider/model switch now checks destination pressure before recording the new request header. Previously, proactive pressure checks used the last committed route and warned on configuration or summary failure. A switch now fails with `MODEL_SWITCH_COMPACTION_FAILED` when destination capacity cannot be resolved, its pressure budget is invalid, or compaction cannot reduce history below its threshold. This also affects short conversations with invalid destination budgets. Completed pruning and earlier checkpoints remain; the previous request header is preserved.

## Migration

1. Ensure every selectable route has a registered adapter whose `resolveModelInfo()` declares `context.contextWindow`. For middleware-owned routes without this metadata, expose the capacity through an adapter or use `auto: false` for manual-only compaction; this also disables automatic pressure and overflow recovery.

2. For small windows, configure `headroomTokens` in `cordis.yml` under the exact provider/model policy. The default is 65,536 tokens and must fit alongside the routed request's output reservation. For a 65,536-token window with a 4,096-token request output cap, this policy leaves a positive pressure budget:

   ```yaml
   - name: '@deepseek-ai/dsh-compaction-basic'
     config:
       modelPolicies:
         - provider: local
           model: small-context
           headroomTokens: 4096
           maxTokens: 4096
   ```

3. Replace `local` and `small-context` with the registered route. The policy's `maxTokens` caps summary output; the destination request's own output cap is separate. Keep the resolved retained budget below the trigger. Switch once with short history to verify configuration, then with long history to verify condensation. If the switch fails, correct the reported cause and retry, or choose a larger model. See the [package configuration reference](../../../../packages/compaction/compaction-basic/README.md#use-this-package).
