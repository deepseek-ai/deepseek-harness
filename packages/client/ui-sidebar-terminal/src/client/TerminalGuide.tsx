/** Shell launch menu owned by the terminal provider's guide entry. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalLaunchShells } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import { TerminalGuideIcon } from './TerminalIcon.tsx'
import css from './TerminalGuide.module.css'

/** Provider-owned discovery and browser preference writes. */
export interface TerminalGuideInjected {
  /** @param signal - open menu lifetime. @returns current Host choices and browser preference. */
  readonly loadShells: (signal: AbortSignal) => Promise<TerminalLaunchShells>
  /** @param path - Host-discovered shell selected for the next terminal. */
  readonly selectShell: (path: string) => void
}

/** Session guide owner props, framework hooks and terminal actions. */
export type TerminalGuideProps = PropsRuntime<'sidebar.right.tab.guide.entry'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalGuideInjected>

type MenuState = { phase: 'loading' } | { phase: 'ready'; choices: TerminalLaunchShells } | { phase: 'failed'; message: string }

/**
 * Open the remembered shell from the card or choose another shell from its menu.
 * @param props - guide copy, enclosing tab actions and cancellable discovery.
 * @returns separate launch and menu buttons within one guide card.
 */
export function TerminalGuide({ title, description, kind, useTabInfo, loadShells, selectShell, t }: TerminalGuideProps): ReactNode {
  const { tab } = useTabInfo()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<MenuState>({ phase: 'loading' })
  useEffect(() => {
    if (!open) return
    const lifetime = new AbortController()
    void loadShells(lifetime.signal).then((choices) => {
      if (!lifetime.signal.aborted) setState({ phase: 'ready', choices })
    }, (error: unknown) => {
      if (!lifetime.signal.aborted) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { lifetime.abort() }
  }, [open, attempt, loadShells])
  const items = state.phase === 'ready'
    ? state.choices.shells.map(shell => ({ id: shell.path, label: shell.name }))
    : state.phase === 'loading'
      ? [{ id: 'loading', label: t('shellLoading'), disabled: true }]
      : [{ id: 'error', label: t('failed', { message: state.message }), disabled: true }, { id: 'retry', label: t('retry') }]
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <Button variant="ghost" className={css.main} onClick={() => { tab.actions.openTab('terminal', { replaceTab: true }) }}>
      <TerminalGuideIcon size={description === undefined ? 22 : 26} className={css.icon} />
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
    </Button>
    <Menu
      open={open} portal autoFocus align="end" className={css.menu}
      items={items.length === 0 ? [{ id: 'empty', label: t('shellEmpty'), disabled: true }] : items}
      selectedId={state.phase === 'ready' ? state.choices.selectedShell : undefined}
      onClose={() => { setOpen(false) }}
      onSelect={(path) => {
        if (state.phase === 'failed') { setState({ phase: 'loading' }); setAttempt(value => value + 1); return }
        selectShell(path)
        setOpen(false)
        tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: path } })
      }}
      anchor={<Button variant="ghost" className={css.trigger} aria-label={t('shell')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setState({ phase: 'loading' }); setOpen(value => !value) }}>
        <IconChevronDownOutline14 />
      </Button>}
    />
  </div>
}
