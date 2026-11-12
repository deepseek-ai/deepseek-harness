/** Host-owned reading record, reset when the service is reloaded. */
import type { SessionReadState } from './types.ts'

/** Reading fields stored per Session, without the map key. */
export type SessionReadRecord = Omit<SessionReadState, 'sessionId'>
