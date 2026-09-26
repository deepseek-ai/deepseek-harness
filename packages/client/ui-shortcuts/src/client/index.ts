/** Shortcut reference plugin; commands and entry points share one declared store. */
import type { Context } from '@deepseek-ai/cordis'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createShortcutsStore } from './store.ts'
import { ShortcutReference, ShortcutsRow } from './Reference.tsx'
import { en, zh } from './locales.ts'
import { fixedCommands } from './fixed.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shortcut reference and settings entry copy. */
    shortcuts: keyof typeof zh
  }
}

/** Required command, locale, and slot services. */
export const inject = ['shortcuts', 'locale', 'slots']

/**
 * Register the reference command, settings row, and single shell overlay.
 * @param ctx - plugin-owned client context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('shortcuts', { zh, en }), 'shortcuts: dictionaries')
  const t = ctx.locale.bind('shortcuts')
  const handle = createShortcutsStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  const edit: typeof ctx.shortcuts.edit = (...args) => ctx.shortcuts.edit(...args)
  const recording = (active: boolean) => ctx.shortcuts.recording(active)
  const describeBinding: typeof ctx.shortcuts.describeBinding = binding => ctx.shortcuts.describeBinding(binding)
  for (const command of fixedCommands(t)) {
    ctx.effect(() => ctx.shortcuts.registerFixed(command), `shortcuts: ${command.id}`)
  }
  const injected = () => ({ platform: ctx.shortcuts.platform, runtime: ctx.shortcuts.runtime, edit, recording, describeBinding,
    hooks: { catalog: ctx.shortcuts.catalog, config: ctx.shortcuts.config, fixedCatalog: ctx.shortcuts.fixedCatalog } })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'shortcuts', order: 20, locale: 'shortcuts', store,
    inject: injected,
  }, ShortcutsRow))
  ctx.slots.inject('shell.overlay', () => {
    const disposeCommand = ctx.shortcuts.register({
      id: 'shortcuts.open' as ShortcutCommandId, label: () => t('open'), aliases: ['shortcuts', 'keyboard shortcuts'],
      defaults: {
        'desktop:macos': { code: 'Slash', modifiers: ['primary'] },
        'desktop:windows': { code: 'Slash', modifiers: ['primary'] },
        'desktop:linux': { code: 'Slash', modifiers: ['primary'] },
        'web:macos': { code: 'Slash', modifiers: ['primary'] },
        'web:windows': { code: 'Slash', modifiers: ['primary'] },
        'web:linux': { code: 'Slash', modifiers: ['primary'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: ['settings', 'shortcuts'],
      resolve: ({ modal }) => {
        if (modal !== null && modal !== 'settings' && modal !== 'shortcuts') return { status: 'blocked', reason: 'modal' }
        return { status: 'handled', run: () => {
          if (modal === 'shortcuts') closeTopModal(document)
          else instance.actions.open()
        } }
      },
    })
    const disposeSlot = ctx.slots.register({
      name: 'shell.overlay', id: 'shortcuts', locale: 'shortcuts', store,
      inject: injected,
    }, ShortcutReference)
    return () => { disposeCommand(); disposeSlot() }
  })
}
