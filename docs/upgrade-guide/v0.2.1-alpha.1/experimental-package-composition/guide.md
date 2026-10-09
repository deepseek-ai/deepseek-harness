---
kind: upgrade-guide
description: "Explicit installation, peer dependencies, and configuration for optional hooks, webhooks, tools, and skills."
---

# Explicit installation and composition for optional capabilities

English | [中文](guide.zh.md)

## Change

The CLI and Python runtime omit the hook bridges from their installation dependencies, and the CLI omits the webhook pair. Base and the full Web presets omit dormant Ralph rows, and base omits its dormant badge row. A patch that only enables a removed row does not insert its plugin. Default active behavior, plugin registration names, tool names, and recorded Session event names remain unchanged.

Package ownership and naming follow the [experimental package policy](../../../../scripts/experimental-package-policy.ts). Installation and composition are separate: installing a plugin package does not mount it, and a bundle must be selected before its contributed rows can be configured.

## Migration

1. Install any packages missing from the target profile together with their required peers. Profiles disable automatic peer installation. For example, run `dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol`. The Codex bridge needs the same protocol peer; the GitHub adapter needs `@deepseek-ai/dsh-webhook` alongside `@deepseek-ai/dsh-webhook-github`.
2. Select an available bundle before overriding its rows. For a capability composed manually, replace an override of a removed row with a complete insertion. Add preset-local tools inside that preset's `config.plugins`, including the services they require. A Host badge insertion is:

   ```yaml
   - insert:
       - id: skill-badge
         name: '@deepseek-ai/dsh-skill-badge'
   ```

3. For GitHub review, use the example distributed with the adapter instead of the removed CLI example. Follow the [installed-profile instructions](../../../user/guide/github-review.md); keep customized rule modules inside the profile so their imports resolve its installed packages.
4. Start the profile and confirm that its configured plugins activate without missing-package, missing-peer, or missing-row errors. Confirm the expected tool or skill is available in the intended Agent preset.
