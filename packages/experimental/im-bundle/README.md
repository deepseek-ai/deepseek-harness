---
description: "Connect Feishu/Lark chats to one persistent agent session shared by every admitted chat, with chat slash commands."
kind: "package-bundle"
---

# @deepseek-ai/dsh-im-bundle

English | [中文](README.zh.md)

## Summary

Add experimental IM automation to an existing profile such as `web`. This bundle inserts Host rows for the Satori IM core, the Feishu/Lark and QQ adapters, the IM host (`@deepseek-ai/dsh-im`), and slash commands. Operators configure admitted chats, sender allowlists, write permissions, and the model route of the shared session through a profile patch. A Feishu application and durable local storage are required; the QQ adapter is included but disabled by default. The installation does not ship this bundle; install it explicitly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle into a long-running profile with `dsh plugin --profile web add @deepseek-ai/dsh-im-bundle`. The IM rows run while that profile's process runs and stop with it.

### Configure a deployment

Create a Feishu application with bot capability, enable WebSocket long-connection event delivery, and subscribe to `im.message.receive_v1`. Grant permissions for reading and sending messages, uploading and downloading resources, and creating and updating interactive cards, then publish the application version and add the bot to the target chats.

Use a dedicated Feishu application with a single active consumer process. Feishu [delivers each event to one connected client](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md), so running multiple consumers with the same credentials splits events across processes.

Set `DSH_FEISHU_APP_ID` and `DSH_FEISHU_APP_SECRET` in the environment, and create a profile patch with your deployment's bot id, chat ids, sender allowlists, model route, and absolute working directory. The `im` row defines the admission rules (`sources`) and the shared session (`defaultDispatch`): every admitted message that addresses the bot reaches one session that serves every admitted chat. Omitting `chats` admits every chat that reaches the bot; when doing so, restrict `users`. Setting `writable: false` makes the admitted chats read-only. By default `sources` is empty and `defaultDispatch` is unset, so no message reaches an agent.

```yaml
- id: im
  config:
    sources:
      - id: team
        bot: lark:cli_example
        chats: [oc_example]
        users: [ou_operator]
        writable: true
    defaultDispatch:
      agentPreset: standard
      provider: deepseek-official
      model: deepseek-flash
      cwd: /absolute/workspace
```

The Feishu adapter row (`im-feishu`) configures connection settings and tenant capabilities. Outbound messages automatically use the mode (`card` or `post`) with the lowest degradation cost for the content, preferring `card` on a tie. `cardStreaming: true` edits the card message in place as states stream (`false` buffers the states and sends one final `PATCH`, and a stream then uses `post` mode instead); `callbacks: true` enables `card.action.trigger` events for card action buttons (such as the stop button); leaving `allowAtAll` unset already declares `@all` mentions, and `allowAtAll: false` renders them as text for a tenant that forbids @all. Set `platform: lark` to use the international Lark OpenAPI domain instead of `feishu`.

```yaml
- id: im-feishu
  config:
    platform: feishu
    appId: !!js process.env.DSH_FEISHU_APP_ID
    appSecret: !!js process.env.DSH_FEISHU_APP_SECRET
    cardStreaming: true
    callbacks: true
```

The QQ adapter row (`im-qq`) is disabled by default. To use QQ, set `DSH_QQ_APP_ID` and `DSH_QQ_APP_SECRET`, enable the `im-qq` row (`disabled: false`), and add a matching `qq:<appId>` source in `im`.

Put these rows in the profile's own `cordis.patch.yml`, or pass the file with `--patch`. Keep `$DSH_HOME` on persistent storage across restarts so Session logs and the `im_*` storage domains recover together. The profile's sandbox and approval policies apply to the shared session; an approval request waits for the profile's own approval surface.

Each message delivered to the shared session carries an `<im-chat key="…" />` header naming its chat, and the session answers in that chat with `im_reply` or `im_send`. The session publishes nothing else: no turn renderer is mounted, so a user sees an answer only when the agent calls `im_send`, `im_reply`, or `im_send_file`. `delivery: steer` (the default) delivers messages that arrive during a running turn into that turn's next step, `followup` queues a new turn, and `inject` adds context without waking an idle session. Users in the chat can send `/stop` to cancel the running turn, `/clear` or `/new` to reset the shared session from its home chat, `/status` to inspect session state, `/help` to list commands, and `/compact` to compact the session history (all handled by [`session-commands`](../im-session-commands/README.md)).

When the `im` row activates, it holds both persisted delivery recovery and new message dispatch until the Loader settles so `im_*` tools and `im-session-commands` finish mounting first. Disposing the profile shuts down the adapters, agents, and storage domains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) inserts HTTP (`im-http`), Satori core (`im-core`), the plugin that renders the `<markdown>` element every answer is written as (`im-markdown`), the Feishu adapter (`im-feishu`), the QQ adapter (`im-qq`, disabled), the IM host (`im`), and slash commands (`im-session-commands`). `im-http` and the IM rows isolate `http` under `isolate: { http: im }` so the bundle's transport does not collide with another `http` service on the profile. Both adapter rows declare `inject: [im]` so neither opens a platform connection or acknowledges events before `ctx.im` is active. It declares no application entry and overrides no row of the profile. Because `dsh-im` registers the `im_*` tools globally, the shared session's preset needs no plugin rows of its own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [IM host service](../im/README.md) — admission rules, hosted sessions, default dispatcher, and `im_*` tools.
- [IM subsystem](../../../docs/subsystems/im.md) — public types, storage domains, and Cordis API catalog.
- [Experimental group](../README.md) — experimental status and the other experimental packages.
- [Architecture](../../../docs/architecture.md) — profile composition and agent lifecycle.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [IM service](../../../docs/subsystems/im.md) and the `im_*` tools it mounts.

#### KV Cache effect

The bundle adds no text of its own; the mounted services and preset own request content and prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The following constraints apply to this bundle:

- **Manual setup** — the bundle has no Plugins page entry or configuration form: credentials come from environment variables and sources from a profile patch.
- **WebSocket long connections only** — the bundle does not include an incoming webhook server or automatic history backfill.
- **QQ adapter ships disabled** — enabling `im-qq` requires QQ bot credentials, gateway intent permissions, and a single active gateway session per QQ application.
- **Single-process ownership** — each `$DSH_HOME` and its IM storage domains must be used by one process at a time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
