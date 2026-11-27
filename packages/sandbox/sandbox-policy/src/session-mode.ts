/**
 * Per-session sandbox-mode override: the session log as the store. A runtime
 * switch (a UI policy control or test scenario) is recorded as one
 * `sandbox/mode` event on the session it applies to;
 * `effective = projection state ?? the deployment default`, so an override
 * survives restart by replay, two sessions can never see each other's state,
 * and there is no external config store. The event is log-only (the
 * `approval/*` precedent): the policy owner projects the fold into each model
 * request, while enforcing tools report operation-specific boundary markers.
 * EXECUTION honors the same fold through `ctx.sandboxPolicy.resolve()` — it
 * stamps the mode together with the calling session's workspace root onto each
 * capability call, weakest-precedence beneath an escalation grant.
 *
 * The override is policy state shared by every enforcing family (bash and
 * filesystem alike), so it lives here in the policy package rather than in any
 * one capability's seam.
 *
 * @module dsh-sandbox-policy/session-mode
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox mode was switched — log-only (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`): durable and replayable,
     * never in the model transcript. The LAST such event is the session's
     * override (folded by the sandboxMode projection unit). `source: 'delegation'` marks
     * an override seeded into a child; an absent source is a runtime switch.
     */
    'sandbox/mode': {
      mode: SandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * THE write path for a session's sandbox-mode override: appends exactly one
 * `sandbox/mode` event — the switch IS its event; nothing mutates mode state
 * out of band. Takes effect on the session's next confined call (bash or fs)
 * — consumers read the shared projection state.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent confined call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('sandbox/mode', { mode })
}
