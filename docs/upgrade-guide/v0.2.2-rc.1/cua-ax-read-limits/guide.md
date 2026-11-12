---
kind: upgrade-guide
description: "macOS reads more AX nodes by default and accepts per-read overrides of configured traversal budgets."
---

# macOS AX tree read limits

English | [中文](guide.zh.md)

## Change

The default macOS node count rises from 2000 to 5000 and the default depth from 25 to 50. Reading a large window can take longer and emit more text to the model.

Configured `maxElements` and `maxDepth` now supply defaults independently for omitted arguments. Callers can request larger or smaller values for one read. Paste menu discovery continues to use the configured limits.

## Migration

1. To keep the previous budgets for ordinary reads, find the `@deepseek-ai/dsh-experimental-cua-macos` entry in your `cordis.yml` or profile patch. Set `maxElements: 2000` and `maxDepth: 25` in its existing `config`.
2. Restart the profile and confirm both defaults in the Computer Use model instructions.
3. If a script depends on specific traversal budgets, pass them explicitly to `getAccessibilityTree()`. An override applies only to that call.
