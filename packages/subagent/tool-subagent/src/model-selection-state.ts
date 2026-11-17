/** Session event type retained from the earlier durable model-selection policy. */

import type { AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Child provider/model routes recorded by earlier releases. Current
     * releases neither append nor read it: delegation reads the Host setting
     * at each call. Log-only: it carries no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes the Session could select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
  }
}
