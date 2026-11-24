/**
 * Configuration of the Lark / Feishu adapter.
 *
 * One product, two API hosts: `platform` selects the host and is also what the bot reports as its `platform`
 * (`id` is `lark:<appId>` while `platform` reports the configured `feishu` or `lark` and the adapter name is `lark`).
 *
 * `cardStreaming` decides whether the card mode edits its card message in place while states stream; `false` buffers
 * the states and sends one final `PATCH`, so a stream that needs a driver falls back to the `post` mode. Both modes are
 * always built, and core resolves one per message from what the message needs. Every mode is built from this
 * configuration, so a mode's operation table already reflects `callbacks` / `cardStreaming` and core never has to
 * consult those flags.
 *
 * The long-connection limits of the WS client live in `config.ws`, next to the core retry policy; the inbound ACK and
 * fragment rules that read them are in `ws.ts`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/config
 */

import z from '@deepseek-ai/schemastery'
import { WsClientConfig } from '@deepseek-ai/cordis-plugin-im-core'

/** OpenAPI hosts of the two products, with the trailing slash route resolution relies on. */
export const DEFAULT_BASE_URLS = {
  feishu: 'https://open.feishu.cn/open-apis/',
  lark: 'https://open.larksuite.com/open-apis/',
} as const

/** `feishu` (open.feishu.cn) or `lark` (open.larksuite.com): the same platform behind two hosts. */
export type LarkPlatform = keyof typeof DEFAULT_BASE_URLS

/**
 * Long-connection settings (`ws`).
 *
 * The retry policy is the core one (`WsClientConfig`), restated here so one `ws` object configures the whole
 * connection. The frame limits bound what a single socket may buffer before the adapter refuses work: complete
 * frames, fragments of one message, partial messages being reassembled, and events admitted but not yet accepted by
 * the intake gate.
 */
export interface LarkWsConfig extends WsClientConfig {
  /** Largest accepted frame, in bytes. */
  maxFrameBytes: number
  /** Largest number of fragments one message may be split into. */
  maxFrameParts: number
  /** Partial messages the reassembly cache keeps before refusing new ones. */
  maxPendingFrames: number
  /** Events admitted but not yet accepted by intake; exceeding it closes the socket (backpressure). */
  maxPendingEvents: number
  /** Lifetime of a partial message, in milliseconds. */
  frameTimeoutMs: number
}

export const WsConfig: z<LarkWsConfig> = z.object({
  retryTimes: z.natural().description('初次连接时的最大重试次数。').default(6),
  retryInterval: z.natural().role('ms').description('初次连接时的重试时间间隔。').default(5 * 1000),
  retryLazy: z.natural().role('ms').description('连接关闭后的重试时间间隔。').default(60 * 1000),
  maxFrameBytes: z.natural().min(1).default(1024 * 1024).description('单个长连接帧的最大字节数。'),
  maxFrameParts: z.natural().min(1).default(128).description('单条消息最多拆分的帧数。'),
  maxPendingFrames: z.natural().min(1).default(64).description('同时重组的消息上限。'),
  maxPendingEvents: z.natural().min(1).default(64).description('已接收但尚未入库的事件上限。'),
  frameTimeoutMs: z.natural().min(1).role('ms').default(30_000).description('未完成消息的重组超时。'),
}).description('长连接设置')

/** Adapter configuration. */
export interface LarkConfig {
  /** `feishu` or `lark`: selects the OpenAPI host and the platform the bot reports. */
  platform: LarkPlatform
  /** Application (bot) id; also the `lark:<appId>` bot id. */
  appId: string
  /** Application secret, used only to obtain the tenant access token. */
  appSecret: string
  /** Override for the OpenAPI root; by default {@link DEFAULT_BASE_URLS}[`platform`]. */
  baseUrl?: string
  /** Edit the card message in place as states stream; `false` buffers them and sends one final `PATCH`. */
  cardStreaming: boolean
  /** Accept `card.action.trigger` over the long connection, i.e. interactive card buttons work. */
  callbacks: boolean
  /**
   * Longest wait (ms, from arrival) for a listener's `button.respond()` before a card callback is answered `{}`; the
   * platform discards an answer later than 3 s. Intake settling earlier answers at once.
   */
  callbackAnswerMs: number
  /** Declares `@all` mentions unless this is explicitly `false`, which renders an @all mention as text instead. */
  allowAtAll?: boolean
  /** Long-connection limits and retry policy. */
  ws: LarkWsConfig
}

export const Config: z<LarkConfig> = z.object({
  platform: z.union(['feishu', 'lark'] as const).default('feishu').description('平台：feishu 或 lark。'),
  appId: z.string().required().description('机器人的应用 ID (App ID)。'),
  appSecret: z.string().role('secret').required().description('机器人的应用密钥 (App Secret)。'),
  baseUrl: z.string().role('url').description('OpenAPI 根地址；默认按平台选择。'),
  cardStreaming: z.boolean().default(true).description('卡片模式下随状态流式编辑同一条卡片消息；关闭后缓冲状态，结束只发一次 PATCH。'),
  callbacks: z.boolean().default(true).description('接收 card.action.trigger 卡片回调。'),
  callbackAnswerMs: z.natural().max(2_500).role('ms').default(1_500)
    .description('卡片回调等待监听器应答（如 toast）的最长时间；超时后回复空应答。平台要求 3 秒内应答。'),
  allowAtAll: z.boolean().description('是否声明 @所有人 提及；默认开启，显式设为 false 时 @所有人 降级为文本。'),
  ws: WsConfig,
}).description('飞书 / Lark 适配器设置')

/**
 * OpenAPI root actually used, ending in `/`.
 *
 * @param config - adapter configuration (or the platform/baseUrl pair).
 * @returns the base URL every route is resolved against.
 */
export function resolveBaseUrl(config: Pick<LarkConfig, 'platform' | 'baseUrl'>): string {
  return (config.baseUrl ?? DEFAULT_BASE_URLS[config.platform]).replace(/\/?$/, '/')
}
