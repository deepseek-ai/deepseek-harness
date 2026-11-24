/**
 * QQ official-bot adapter: group (群聊) and C2C (单聊) only, `msg_type` text/markdown messages, passive replies and
 * the v2 gateway.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq
 */

import { QQBot } from './bot.ts'

export * from './config.ts'
export * from './token.ts'
export * from './errors.ts'
export * from './api.ts'
export * from './bot.ts'
export * from './passive.ts'
export * from './prepare.ts'
export * from './send.ts'
export * from './ws.ts'
export * from './decode.ts'
export * from './stream.ts'

export default QQBot
