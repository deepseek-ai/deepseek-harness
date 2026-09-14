/**
 * InputTriggerService (`ctx.inputTriggers`): the root half of the trigger pipeline — the
 * stateless source registry plus the per-session controller map. Every piece
 * of mutable interaction state (hit, menu, fetch) lives on the
 * {@link InputTriggerController}; the service only registers sources, resolves
 * controllers by session scope, and relays roster changes.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '../types.ts'
import { InputTriggerController } from './controller.ts'
import type { InputTriggerServiceContract } from './contract.ts'

/**
 * All mutable service state in one holder: cordis service methods run behind
 * the caller-ctx tracker, so mutation goes through one property read — never
 * field assignment on `this`.
 */
interface LiveState {
  /** Registration order = menu group order = matchSpace/matchEnter poll order. */
  readonly sources: InputTriggerSource[]
  /** Per-session controllers; entries are deleted by their scope disposer. */
  readonly controllers: Map<SessionId, InputTriggerController>
}

/** The `ctx.inputTriggers` trigger pipeline service (root registry + controller resolution). */
export class InputTriggerService extends Service implements InputTriggerServiceContract {
  static inject = ['sessions']

  private readonly live: LiveState = { sources: [], controllers: new Map() }

  /**
   * @param ctx - owning root context (the service registers itself as `slash`).
   */
  constructor(ctx: Context) {
    super(ctx, 'inputTriggers')
    ctx.on('locale/change', () => {
      for (const controller of this.live.controllers.values()) controller.refreshOpenMenu()
    })
  }

  /**
   * Register one trigger source. Live session controllers are notified so a
   * source arriving after scope birth still warms and joins the lexicon.
   * @param src - the source; (trigger, name) must be unique — duplicates throw.
   * @returns the disposer (callers wrap registration in ctx.effect). Disposal
   * while a controller shows the source's menu group drops that group.
   */
  registerSource(src: InputTriggerSource): () => void {
    const { live } = this
    if (live.sources.some(s => s.trigger === src.trigger && s.name === src.name)) {
      throw new Error(`slash source "${src.trigger}${src.name}" is already registered`)
    }
    live.sources.push(src)
    for (const controller of live.controllers.values()) {
      try {
        controller.sourceAdded(src)
      } catch (error) {
        // Contain faulty source callbacks (warm/subscribeLexicon): the
        // registration must stand with a usable disposer and the remaining
        // controllers must still be notified.
        console.error(`[ui-input-trigger] source "${src.trigger}${src.name}" late-registration setup failed:`, error)
      }
    }
    return () => {
      const at = live.sources.indexOf(src)
      if (at < 0) return
      live.sources.splice(at, 1)
      for (const controller of live.controllers.values()) controller.sourceRemoved(src)
    }
  }

  /**
   * Resolve the per-session controller for one session scope (lazy; the
   * scope disposer removes and disposes it). Construction warms the source
   * roster once — sessions are always agent-backed, so scope birth is the
   * single prewarm moment.
   * @param actx - session-scope ctx.
   * @returns the resident controller.
   */
  sessionOf(actx: ClientContext): InputTriggerController {
    const sessions = this.sessions()
    const id = sessions.scopeOf(actx)
    if (id === undefined) throw new Error('slash.sessionOf requires a session scope')
    const { live } = this
    const existing = live.controllers.get(id)
    if (existing !== undefined) return existing
    const controller = new InputTriggerController({
      actx,
      sessionId: id,
      roster: {
        sources: trigger => live.sources.filter(s => s.trigger === trigger).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        all: () => live.sources,
      },
    })
    live.controllers.set(id, controller)
    actx.effect(() => () => {
      controller.dispose()
      live.controllers.delete(id)
    }, 'slash: session controller')
    return controller
  }

  private sessions(): ISessions {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('ui-input-trigger: sessions service unavailable')
    return sessions
  }
}
