/**
 * Lark / Feishu adapter: rich-text `post` and interactive `card` modes, the OpenAPI client, the tenant token, the
 * WebSocket long connection (including `card.action.trigger`), and the error taxonomy.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark
 */

import { LarkBot } from './bot.ts'
import * as Lark from './types/index.ts'

export * from './config.ts'
export * from './errors.ts'
export * from './api/index.ts'
export * from './bot.ts'
export * from './ws.ts'
export * from './decode.ts'
export * from './prepare.ts'
export * from './send.ts'
export { Internal, type BaseResponse, type InternalRoute, type Paginated, type Pagination } from './internal.ts'

/** The generated OpenAPI subset (`types/`), exported as a type namespace: `Lark.Message`, `Lark.Im.Message.CreateRequest`. */
export { Lark, Lark as Feishu }

export default LarkBot
