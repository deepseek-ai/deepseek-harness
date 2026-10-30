---
kind: upgrade-guide
description: "Source-built Computer Use helpers use a separate development bundle identifier and need one new macOS permission grant."
---

# Source-built Computer Use helper identity

English | [中文](guide.zh.md)

## Change

Source checkouts previously built `DSH Computer Use.app` with the release bundle identifier `com.deepseek.harness.computer-use` and an ad-hoc signature. They now build `DSH Computer Use Dev.app` with bundle identifier `com.deepseek.harness.computer-use.dev`. Accessibility and Screen Recording grants for the old entry do not apply to it. Desktop and npm installations are unchanged. Source builds now generate a fixed signing identity under `$DSH_HOME/computer-use-dev-signing` by default and reuse it; an unset `DSH_HOME` uses `~/.dsh`.

## Migration

1. Default `sourceSigning: local-identity` needs no manual setup; use the same DSH home across worktrees to share the identity. For ad-hoc signing, set `config.sourceSigning: ad-hoc` on `id: cua` in `cordis.patch.yml`. For an existing certificate, use the [user-signing configuration](../../../../packages/experimental/cua-macos/README.md#use-this-package).
2. Start DSH from the source checkout, call Computer Use, and grant Accessibility and Screen Recording to `DSH Computer Use Dev` in System Settings.
3. Confirm that `getCapabilities` reports both permissions as `true`. Remove an old `DSH Computer Use` entry only when no installed DSH uses it.
4. To stop using the generated identity, select ad-hoc or user-certificate signing, then run `pnpm --dir packages/experimental/cua-macos run dev-signing:remove`. Select a custom home with the same `DSH_HOME` or `--dsh-home <path>`. Deleting DSH home causes a new certificate on the next build and requires new grants.
