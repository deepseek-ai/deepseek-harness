---
kind: upgrade-guide
description: "Update overridden macOS Computer Use helpers for activity lookback configuration."
---

# Update an overridden macOS helper

English | [中文](guide.zh.md)

## Change

The macOS connection handshake includes the field `recentActivityWindowMs`. Older helper applications reject the added field. This affects profiles overriding `helperPath` and custom clients connecting directly to the native helper; the default packaged or source-prepared helper updates with its provider.

## Migration

1. Remove `helperPath` from the affected profile patch to use the provider-owned helper, or rebuild the override from the same package version using the [native build instructions](../../../../packages/experimental/cua-macos/native/README.md#build-and-service).
2. Custom native clients must include `recentActivityWindowMs` in `hello.config`, using an integer from 1 to 2147483647 or `"off"` to disable activity tracking and notices. The default is 60000.
3. Call `cua.getCapabilities()` and confirm that the connection returns its permission state without a handshake error. Existing operating-system permissions remain required.
