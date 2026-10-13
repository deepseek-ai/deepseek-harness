---
kind: upgrade-guide
description: "Python runtime wheels require explicit downloads for Office conversion and bundled authoring environments."
---

# Download optional Python runtime resources explicitly

English | [中文](guide.zh.md)

## Change

Python runtime wheels omit the Office sidecar and authoring interpreters and libraries. SDK startup does not download them. Office operations require an explicit download; the authoring environment and conversion engine can be selected independently. The SDK still packages the normal `dsh` CLI and requires no system Node.js.

## Migration

1. Before processing Office files, call `deepseek_harness_runtime.download_office()`. Before using the bundled authoring environment, call `deepseek_harness_runtime.download_primary_runtime()`. Both reuse completed caches and return absolute paths.
2. For offline deployment, prepare the cache with the matching runtime release on the target platform and copy it to that platform's deployment. Set `DSH_RESOURCE_CACHE` to its absolute root before downloads and SDK startup. See the [runtime reference](../../../../python/sdk-runtime/README.md).
3. Start the SDK and confirm the required resources are available. `deepseek_harness_runtime.resolve_office_launch_args()` checks the Office CLI paths without downloading. Existing `DSH_PRIMARY_RUNTIME` paths remain supported; an empty value disables the authoring query. Profile patches can independently disable `skill-office`.
