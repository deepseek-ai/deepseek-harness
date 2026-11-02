---
kind: upgrade-guide
description: "Computer Use application consent moves from profile configuration to durable profile-scoped storage."
---

# Computer Use consent storage

English | [中文](guide.zh.md)

## Change

Computer Use stores application consent through `storageDomain`. With the default JSON backend, each canonical profile directory has its own `$DSH_HOME/storages/cua_permissions_<sha256>.json`. “Allow for this session” now follows the conversation ID across DSH restart and Computer Use disablement. It does not authorize another conversation. Unverifiable applications still require a matching native process identity; restarting that application may require new consent.

`allowedApps` is a legacy import source. The first store access imports it once. Subsequent configuration edits do not grant or revoke access, and a revoked grant is not restored by reloading the old configuration. The permission page remains the authoring interface for grants and refusals. macOS privileges are unchanged.

## Migration

1. Keep the profile's existing storage services mounted. Shipped profiles already include `storageDomain` and the JSON backend; custom profiles need the same services. A profile without domain storage refuses authorization operations.
2. Enable Computer Use and open its details to initialize storage. Confirm that the always-allowed applications appear.
3. Remove `allowedApps` from the CUA entry in the profile configuration and other overlays after confirmation. Keep the remaining CUA configuration.
4. Use the permission page to revoke applications or allow asking again. Existing conversation-only grants held by an older running process cannot be recovered; grant those once after upgrading. Newly granted conversation access then survives restart.
5. Keep the storage file with that profile's state. Moving the profile to a different real directory selects a different store. File locks coordinate processes on one machine, not different machines sharing a network filesystem.
