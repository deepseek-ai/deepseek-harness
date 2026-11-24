/** Operator configuration of the session-commands plugin. */
import z from '@deepseek-ai/schemastery'
import type { SessionCommandsLocale } from './locale.ts'

const DAY_MS = 86_400_000

/** Who may run a privileged command (`/stop`, `/clear`, `/new`, passthrough). */
export type SessionCommandAllow = 'all' | 'admins'

/** Operator configuration of the slash commands: who may act, which names pass through, reply language, and receipt retention. */
export interface SessionCommandsConfig {
  /** `all` lets every sender act; `admins` restricts privileged commands to {@link admins}. */
  allow: SessionCommandAllow
  /**
   * Sender ids allowed to run privileged commands when `allow` is `admins`: a bare platform user id
   * (`ou_xxx`), or `botId|userId` to pin one platform.
   */
  admins: string[]
  /** Command names forwarded to the dsh command registry (`/compact` by default). */
  passthrough: string[]
  /** Session owners `/clear` and `/new` may reset (the default dispatch session is owned by `dispatcher`). */
  resettable: string[]
  /** Reply language; `zh` by default. */
  locale: SessionCommandsLocale
  /** How long recorded command receipts (`done` and `pending`) are kept before pruning (ms). */
  retentionMs: number
}

/** Validated operator configuration. */
export const Config = z.object({
  allow: z.union(['all', 'admins']).default('all'),
  admins: z.array(z.string()).default([]),
  passthrough: z.array(z.string()).default(['compact']),
  resettable: z.array(z.string()).default(['dispatcher']),
  locale: z.union(['zh', 'en']).default('zh'),
  retentionMs: z.natural().min(1).default(7 * DAY_MS),
})

/** The resolved configuration shape the validated `Config` schema produces. */
export type Config = SessionCommandsConfig
