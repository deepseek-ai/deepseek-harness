/** Cordis-owned file transfers and localized feedback shared across independent entries. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopFileDrag } from '@deepseek-ai/dsh-util-file-drag'
import type { FileDragActions } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { FileDragFeedback, type FileDragFailure, type FileDragFeedbackInjected } from './feedback.tsx'
import { FileTransfers } from './transfers.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

/** Application-local file preparation and drop resolution. */
export interface FileDragService {
  readonly actions: FileDragActions
  /** @param transfer - browser drop payload. @returns original file for a matching application-local token. */
  readonly read: (transfer: DataTransfer) => File | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** File transfer ownership scoped to this plugin's lifetime. */
    fileDrag: FileDragService
  }
}

/** Registry and locale used by the independent feedback overlay. */
export const inject = ['slots', 'locale']

/** @param ctx - client plugin context carrying slots and locale. */
export function apply(ctx: Context): void {
  const bridge = (globalThis as typeof globalThis & { dshDesktop?: { protocolVersion: number; fileDrag?: DesktopFileDrag } }).dshDesktop
  const desktop = bridge?.protocolVersion === 1 ? bridge.fileDrag : undefined
  const failure = createSnapshotStore<FileDragFailure | null>(null)
  const t = ctx.locale.bind('fileDrag')
  ctx.effect(() => ctx.locale.register('fileDrag', { zh, en, ja, es, fr, de, ru, pt }))
  let sequence = 0
  const reportFailure = (): void => { failure.set({ text: t('failed'), sequence: ++sequence }) }
  const transfers = new FileTransfers(desktop, reportFailure)
  const dismiss = (): void => { failure.set(null) }
  ctx.provide('fileDrag', {
    actions: { prepare: (source, signal) => transfers.prepare(source, signal), reportFailure },
    read: transfer => transfers.read(transfer),
  })
  ctx.effect(() => () => { transfers.dispose(); dismiss() })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'file-drag.feedback',
    inject: (): FileDragFeedbackInjected => ({ hooks: { failure }, dismiss }),
  }, FileDragFeedback))
}
