---
kind: upgrade-guide
description: "Source-built Computer Use helpers use a separate development bundle identifier and need one new macOS permission grant."
---

# Source-built Computer Use helper identity

English | [中文](guide.zh.md)

## Change

Source checkouts previously built `DSH Computer Use.app` with the release bundle identifier `com.deepseek.harness.computer-use` and an ad-hoc signature. They now build `DSH Computer Use Dev.app` with bundle identifier `com.deepseek.harness.computer-use.dev`. Accessibility and Screen Recording grants for the old entry do not apply to it. Desktop and npm installations are unchanged.

## Migration

1. Source builds default to ad-hoc signing; changed binaries can require new grants. For a fixed identity, set `config.sourceSigning: local-identity` on `id: cua` in the profile’s `cordis.patch.yml`. The first build creates or reuses the identity automatically. Use the same configuration in each worktree.
2. Start DSH from the source checkout, call Computer Use, and grant Accessibility and Screen Recording to `DSH Computer Use Dev` in System Settings.
3. Confirm that `getCapabilities` reports both permissions as `true`. Remove an old `DSH Computer Use` entry only when no installed DSH uses it.
4. To remove fixed signing, first select `sourceSigning: ad-hoc`, then run `pnpm --dir packages/experimental/cua-macos run dev-signing:remove` and remove the development grants in System Settings.
