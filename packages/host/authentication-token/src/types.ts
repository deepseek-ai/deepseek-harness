/** Internal HTTP facts consumed by the default token and cookie implementation. */
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

/** Request metadata accepted by the token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Response operations used by the token implementation. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

export type { ConnectionTrustRequest }
/** Forwarded interaction participation for one API connection. */
export type ConnectionInteractions = 'answer' | 'none'
