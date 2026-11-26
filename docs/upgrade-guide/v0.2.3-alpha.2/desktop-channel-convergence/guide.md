---
kind: upgrade-guide
description: "Desktop upgrades migrate unversioned settings.json files to version 1, reset unversioned nightly preferences to stable while hiding Update channel until unlocked, and switch packaging and publication workflows to stable defaults and explicit channel checkboxes."
---
# Desktop update channels default to stable and require explicit unlock

English | [中文](guide.zh.md)

## Change

Desktop local settings at `<userData>/desktop/settings.json` previously had no schema `version`, exposed **Update channel** directly in **Settings → General**, and defaulted `DSH_DESKTOP_UPDATE_CHANNEL` and packaging workflow `update_channel` inputs to `nightly`. Upgrading now migrates valid unversioned `settings.json` files in place to `"version": "1"`, removes unversioned `updates.channelUnlocked` fields, and resets unversioned `"nightly"` preferences to `"stable"`. Until `"version": "1"` and `updates.channelUnlocked: true` are both present, Desktop hides **Update channel** and checks `stable` regardless of packaged `dshDesktopUpdateChannel`. Local packaging scripts and `Package Desktop` workflows now default `DSH_DESKTOP_UPDATE_CHANNEL` and `update_channel` to `stable`, while `Publish Desktop · COS` (`desktop-publish.yml`) and `Publish Desktop · Rollout & Website` (`desktop-rollout.yml`) require explicit boolean target flags (`publish_stable`, `publish_nightly`, `rollout_stable`, `rollout_nightly`, `upload_website`). This affects Desktop users who previously selected the development channel and operators who dispatch Desktop packaging or publication workflows.

## Migration

1. To opt back into the development (`nightly`) update channel on an upgraded Desktop installation, open **Settings → General**, click **Current version** five times, and confirm **Switch to development**. Confirm that **Update channel** appears set to **Development** and `<userData>/desktop/settings.json` contains `"version": "1"`, `"channel": "nightly"`, and `"channelUnlocked": true`.
2. Update any scripted `Package Desktop` dispatches that relied on the implicit `nightly` default to pass `-f update_channel=nightly` (or `DSH_DESKTOP_UPDATE_CHANNEL=nightly` locally) when an embedded `nightly` marker is required.
3. Update `desktop-publish.yml` and `desktop-rollout.yml` dispatches to pass explicit target flags (`-f publish_stable=true`, `-f publish_nightly=true`, `-f rollout_stable=true`, `-f rollout_nightly=true`, or `-f upload_website=true`), and verify the target channels in the workflow approval summary before approving deployment.
