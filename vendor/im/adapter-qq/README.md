# @deepseek-ai/cordis-plugin-im-adapter-qq

QQ official-bot adapter for [Satori](https://github.com/satorijs/satori): group (群聊) and C2C (单聊) chats only, publishing `msg_type` text or markdown messages through `plugin-im-core` modes, with passive replies and the v2 gateway.

- Upstream: `@satorijs/adapter-qq`, ported in place. The platform routes, wire envelopes, gateway frames and token endpoints carry over; the rendering pipeline does not, so the `src/` here is this repository's own source rather than a copy of the upstream one.
- Pin: the upstream version and source commit are recorded in the `adapter-qq/` row of the [IM vendored-package manifest](../README.md).
- Sync: follow [the sync procedure](../README.md#sync-procedure) and port upstream changes into these modules as its I12 entry describes.
- Consumer: the [im-bundle](../../../packages/experimental/im-bundle/README.md) profile bundle mounts it as its `im-qq` row.
