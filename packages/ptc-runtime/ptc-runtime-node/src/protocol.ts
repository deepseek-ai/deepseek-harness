/**
 * JSON message vocabulary carried by the bounded process channel. The host validates every
 * message because model code can write directly to the inherited descriptor.
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/protocol
 */

import type { PtcJsonWire } from './json-wire.ts'

/** What the host hands the program at spawn, after the readiness handshake. */
export interface ProgramBootData {
  /** The type-stripped (plain JS) program body. */
  code: string
  /** Binding namespaces to materialize; functions themselves stay host-side. */
  namespaces: {
    global: string
    names: string[]
    errorClass?: { name: string; memberNameProperty: string }
  }[]
  /** Hard cap for the combined serialized outer logs plus completion value or failure diagnostic. */
  maxOutputBytes: number
}

/** Program → host: one bridged binding call. */
interface CallMessage {
  type: 'call'
  /** Program-issued correlation id; the host answers each id at most once and ignores duplicates. */
  id: number
  /** The namespace global the call targets. */
  global: string
  /** The function name within the namespace. */
  name: string
  /** The single argument as a flat lossless-JSON wire value. */
  args: PtcJsonWire
}

/** Program → host: captured text, streamed eagerly so output survives a mid-run termination (timeout, abort, OOM). */
interface LogMessage {
  type: 'log'
  text: string
}

/** Program → host: program-side capture or completion measurement exceeded the outer cap. */
interface OutputLimitMessage {
  type: 'output-limit'
}

/**
 * Program → host: the program settled. `error` carries a program exception,
 * invalid completion, or output overflow (budgets, aborts, and substrate death
 * are observed host-side). `value` is present only on a clean completion that
 * produced one, as a flat wire value already lossless and admitted against
 * the remaining combined output cap. Logs are NOT carried here — they streamed
 * eagerly as {@link LogMessage}s.
 */
export interface DoneMessage {
  type: 'done'
  value?: PtcJsonWire
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/** Every message the program sends. */
export type ProgramToHost = CallMessage | LogMessage | OutputLimitMessage | DoneMessage

/** Host → program: the answer to one {@link CallMessage}. */
export type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: PtcJsonWire }
  | { type: 'reply'; id: number; ok: false; message: string }
