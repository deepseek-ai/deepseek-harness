/** Composer model selection injection and inline label extension. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from './directory.ts'

/** Catalog data for a model name inside the composer's existing controls. */
export interface ModelLabelOwner {
  /** Provider identity and localized display name; contains no connection configuration. */
  provider: Pick<ModelProviderGroup, 'id' | 'name'>
  /** The exact provider's model catalog entry. */
  model: ModelCatalogModel
  /** Trigger caption, root-menu current value, or selectable model row. */
  placement: 'trigger' | 'menu' | 'option'
  /** Whether this provider/model pair is the current selection. */
  selected: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Non-interactive inline model label; selection controls remain owner-managed.
     * Without a contribution, the composer displays the catalog name.
     * @example
     * return {
     *   inject: ['slots'],
     *   apply(ctx) {
     *     ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register(
     *       { name: 'conversation.input.model.label' },
     *       ({ provider, model }) => React.createElement('span', { title: provider.name }, model.name),
     *     ))
     *   },
     * }
     */
    'conversation.input.model.label': {
      kind: 'single'
      scope: 'session'
      inline: true
      owner: ModelLabelOwner
    }
  }
}

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns the Host outcome, or undefined when this Session cannot select a model.
   */
  select: (selection: ModelSelection) => Promise<RemoteResult<void> | undefined>
}
