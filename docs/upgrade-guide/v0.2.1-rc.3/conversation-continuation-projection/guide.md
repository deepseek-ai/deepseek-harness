---
kind: upgrade-guide
description: "Custom Conversation compositions must provide sessionProjections to activate the Host plugin."
---
# Provide Session projections for Conversation

English | [中文](guide.zh.md)

## Change

The Host entry of `@deepseek-ai/dsh-client-ui-conversation` requires the `sessionProjections` service to publish manual continuation eligibility. Custom compositions that mounted Conversation without a projection provider must add one. The shipped Web and Desktop compositions already provide it. Session logs do not require migration.

## Migration

1. Check the custom profile's bundles and `cordis.patch.yml` for an existing `@deepseek-ai/dsh-session-projection` entry. Keep that provider when present.
2. If the composition has none, add this row to the profile's `cordis.patch.yml`:

   ```yaml
   - id: session-projection
     name: '@deepseek-ai/dsh-session-projection'
   ```

3. Restart the profile and verify that the Conversation Host entry activates. After a supported model-request failure, an empty, idle ordinary composer must offer the play action.

See the [Conversation reference](../../../../packages/client/ui-conversation/README.md#shell-and-standard-props) for the supported failures and submission behavior.
