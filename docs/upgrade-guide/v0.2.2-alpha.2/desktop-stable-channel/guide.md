---
kind: upgrade-guide
description: "The Desktop stable update channel is named stable instead of latest."
---

# Desktop stable channel name

English | [中文](guide.zh.md)

## Change

Desktop packages, update feeds, and channel configuration use `stable` instead of `latest`. The `nightly` channel is unchanged. The old channel value is rejected; there is no alias. Fixed website downloads named `dsh-latest-*` are unchanged.

## Migration

1. Select `stable` in packaging workflows or set `DSH_DESKTOP_UPDATE_CHANNEL=stable` when building a stable-channel package. Build a stable version, without a prerelease suffix.
2. If a local Desktop settings file contains `updates.channel: "latest"`, change the value to `"stable"` and restart Desktop. Omitting the field uses the package default.
3. Publish with the updated tooling: it writes `stable.yml` on Windows and `stable-mac.yml` on macOS within each architecture's feed directory, with stable-channel binaries under `stable/`. Verify the selected channel and requested feed in the test deployment before production publication. Old packages still requesting `latest` feeds do not migrate automatically.
