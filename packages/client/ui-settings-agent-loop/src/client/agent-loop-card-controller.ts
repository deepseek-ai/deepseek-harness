/** The agent-loop page's staged form over the `agent-loop` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the agent loop's user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const AGENT_LOOP_NS = 'agent-loop'

/**
 * The agent-loop fields this page edits. The Host section carries only this
 * field — the composed `agents` array is deliberately not part of it.
 */
export interface AgentLoopSettings {
  /** Upper bound on parallel-safe tool calls in flight per step. */
  maxParallelToolCalls?: number
}

/** What the agent-loop page renders. */
export interface AgentLoopCardState extends SettingsFormShell {
  /** Parallel tool-call cap. */
  maxParallelToolCalls: SettingsFieldState
}

/** The registration-side face the agent-loop page's slot entry injects. */
export interface AgentLoopCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useAgentLoopCard. */
    agentLoopCard: SnapshotStore<AgentLoopCardState>
  }
}

/** Bridges the `agent-loop` scope onto the page's staged form. */
export class AgentLoopCardController {
  private readonly form: SettingsFormModel<AgentLoopSettings>
  private readonly store: SnapshotStore<AgentLoopCardState>

  /** @param scope - the bound settings scope for the `agent-loop` namespace. */
  constructor(scope: SettingsFormScope<AgentLoopSettings>) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('maxParallelToolCalls')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): AgentLoopCardState {
    return { ...this.form.shell(), maxParallelToolCalls: this.form.field('maxParallelToolCalls') }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): AgentLoopCardFace {
    return { hooks: { agentLoopCard: this.store }, ...this.form.actions() }
  }
  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }

}
