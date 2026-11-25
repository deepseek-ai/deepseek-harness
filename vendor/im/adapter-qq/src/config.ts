/**
 * Configuration of the QQ official-bot adapter.
 *
 * Group (群聊) and C2C (单聊) only:
 * - `transport: 'ws' | 'none'` — `'none'` runs the adapter as a REST-only client without opening a gateway session.
 * - `passive.seqBase` defaults to **2**, not 1: `msg_seq` is deduplicated server-side per `(msg_id, msg_seq)`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/config
 */

import z from '@deepseek-ai/schemastery'
import { WsClientConfig } from '@deepseek-ai/cordis-plugin-im-core'

/** Gateway intents this adapter needs; the platform's other families are 频道/论坛-only. */
export const Intents = {
  /** `GROUP_AT_MESSAGE_CREATE` (群 @机器人) and `C2C_MESSAGE_CREATE` (单聊). */
  USER_MESSAGE: 1 << 25,
  /** `INTERACTION_CREATE` (button clicks). */
  INTERACTIONS: 1 << 26,
} as const

/** Default `intents`: `USER_MESSAGE | INTERACTIONS`. */
export const DEFAULT_INTENTS = Intents.USER_MESSAGE | Intents.INTERACTIONS

/** Production REST host; `sandbox` prefixes `sandbox.` onto it. */
export const DEFAULT_BASE_URL = 'https://api.sgroup.qq.com/'

/**
 * Access-token endpoint; `config.tokenUrl` overrides it.
 */
export const DEFAULT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** Passive-reply windows and budgets per chat type. */
export interface PassiveConfig {
  /** Passive reply window of a group message: 5 minutes from `GROUP_AT_MESSAGE_CREATE`. */
  groupWindowMs: number
  /** Passive reply window of a C2C message: 60 minutes from `C2C_MESSAGE_CREATE`. */
  c2cWindowMs: number
  /** Replies the platform accepts per group message. */
  groupReplies: number
  /** Replies the platform accepts per C2C message. */
  c2cReplies: number
  /** First `msg_seq` of a passive reply; 2 by default. */
  seqBase: number
}

export const PassiveConfig: z<PassiveConfig> = z.object({
  groupWindowMs: z.natural().role('ms').default(5 * 60 * 1000).description('群聊被动回复的有效期。'),
  c2cWindowMs: z.natural().role('ms').default(60 * 60 * 1000).description('单聊被动回复的有效期。'),
  groupReplies: z.natural().default(5).description('同一条群聊消息最多被动回复的次数。'),
  c2cReplies: z.natural().default(4).description('同一条单聊消息最多被动回复的次数。'),
  seqBase: z.natural().default(2).description('被动回复 msg_seq 的起始值。'),
}).description('被动回复设置')

/** Adapter configuration. */
export interface QQConfig {
  /** Bot AppID; also the `qq:<appId>` bot id and the `X-Union-Appid` header. */
  appId: string
  /** Bot AppSecret (token endpoint only). */
  secret: string
  /** Talk to `sandbox.api.sgroup.qq.com` instead of the production host. */
  sandbox: boolean
  /** REST base URL; `sandbox` rewrites its host prefix. */
  baseUrl: string
  /** Access-token endpoint. */
  tokenUrl: string
  /** Gateway intents; default `USER_MESSAGE | INTERACTIONS`. */
  intents: number
  /** Send markdown (`msg_type: 2`) instead of plain text (`msg_type: 0`); selects the `markdown` mode. */
  markdown: boolean
  /**
 * Send a custom keyboard with markdown messages (needs the platform permission). Markdown only: with
 * `markdown: false` the flag has no effect (`QQBot.keyboardEnabled`).
 */
  keyboard: boolean
  /**
 * Enable the C2C `stream_messages` driver; groups always use the buffered `final` strategy.
 *
 * **`false` by default**, because a desktop QQNT client renders a streamed message as
 * `[暂不支持该消息类型，请用最新版手机 QQ 查看]`. The leftover room of a streamed message is also small and each
 * chunk spends a passive reply of the same event.
 */
  stream: boolean
  /** How `<a>` is rendered: `'text'` drops non-whitelisted URLs to their label, `'keep'` keeps them. */
  linkPolicy: 'text' | 'keep'
  /** Passive-reply windows, budgets and `msg_seq` base. */
  passive: PassiveConfig
  /** `'ws'` runs the gateway; `'none'` is REST-only. */
  transport: 'ws' | 'none'
  /** Gateway client retry policy (core `WsClientConfig`). */
  ws: WsClientConfig
}

export const Config: z<QQConfig> = z.object({
  appId: z.string().required().description('机器人 AppID。'),
  secret: z.string().role('secret').required().description('机器人 AppSecret。'),
  sandbox: z.boolean().default(false).description('是否使用沙箱环境。'),
  baseUrl: z.string().role('url').default(DEFAULT_BASE_URL).description('REST 服务器地址。'),
  tokenUrl: z.string().role('url').default(DEFAULT_TOKEN_URL).description('获取 access_token 的地址。'),
  intents: z.bitset(Intents).default(DEFAULT_INTENTS).description('需要订阅的网关事件。'),
  markdown: z.boolean().default(false).description('使用 markdown 消息（msg_type 2）。'),
  keyboard: z.boolean().default(false).description('在 markdown 消息中携带自定义键盘（需要平台权限）。'),
  stream: z.boolean().default(false).description('为单聊启用 stream_messages 流式消息（桌面 QQNT 无法显示流式消息，默认关闭）。'),
  linkPolicy: z.union(['text', 'keep'] as const).default('text').description('链接元素的渲染方式。'),
  passive: PassiveConfig,
  transport: z.union(['ws', 'none'] as const).default('ws').description('入站传输方式。'),
  ws: WsClientConfig,
}).description('QQ 机器人适配器设置')

/**
 * REST host actually used, with the trailing slash `serialize`/`resolveBaseUrl` rely on and the sandbox prefix applied.
 *
 * @param config - adapter configuration.
 * @returns base URL ending in `/`.
 */
export function resolveBaseUrl(config: Pick<QQConfig, 'baseUrl' | 'sandbox'>) {
  const baseUrl = config.baseUrl.replace(/\/?$/, '/')
  return config.sandbox ? baseUrl.replace(/^(https?:\/\/)/, '$1sandbox.') : baseUrl
}
