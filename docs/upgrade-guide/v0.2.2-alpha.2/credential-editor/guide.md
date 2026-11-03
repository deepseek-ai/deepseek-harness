---
kind: upgrade-guide
description: "Saved API keys appear in masked editor fields, and clearing a saved key removes its override."
---
# Saved API keys in provider editors

English | [中文](guide.zh.md)

## Change

Provider editors show stored API keys as masked values instead of empty fields. Applying an empty field removes a previously loaded key and restores environment authentication. Cancel preserves the stored key. Environment values are never loaded into the editor.

Credential providers implement `readStored(ref): Promise<string | undefined>` to return only the managed value, without environment fallbacks. The owner-only `credentials.readStored` Remote method supplies this value to an opened editor; general metadata reads remain redacted.

## Migration

1. Keep the loaded value to retain a saved key, replace it to rotate the key, or clear it and apply to use environment authentication.
2. Implement `readStored` in custom `CredentialProvider` subclasses; return `undefined` when no non-empty value is stored.
3. Reopen the DeepSeek editor to confirm the saved key appears masked. After clearing and applying, confirm the field is empty and offers environment authentication.
