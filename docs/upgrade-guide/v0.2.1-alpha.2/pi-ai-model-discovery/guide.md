---
kind: upgrade-guide
description: "pi-ai routes that name a credential hide their models until the credential is configured."
---

# pi-ai model visibility without a credential

English | [中文](guide.zh.md)

## Change

A pi-ai route that names a credential through `apiKeyEnv` previously listed its configured models while that credential was missing, and requests then failed with `MISSING_CREDENTIAL`. Model discovery now returns an empty catalog for such a route until the credential resolves, so Desktop and Web hide its group. Other credential errors, such as a malformed key, still fail model discovery. Routes that use the provider's native authentication or name no credential keep their configured catalog. A saved or default selection absent from the catalog displays “Select model” without changing the stored selection.

## Migration

1. To use such a route, configure its key in Settings → Models, or supply the reference its `apiKeyEnv` names through the launch environment.
2. Reopen the model selector and confirm that the route's group appears. Custom model discovery consumers must handle an empty catalog before the credential is configured; a listed catalog does not mean that the remote API accepts the key.
