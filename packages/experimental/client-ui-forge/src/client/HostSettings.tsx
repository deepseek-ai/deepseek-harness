/** A provider row's page on the Plugins page: the hosts the provider serves, each with its sign-in state. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconRefreshOutlineRegular, IconTrashOutlineRegular, SettingsForm, StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ForgePanelKey, NS } from './locales.ts'
import type { HostFormActions, HostFormState, HostProblem } from './host-settings-form.ts'
import type { HostSignIn } from './host-sign-in.ts'
import { rowFormLabels } from './row-form-labels.ts'
import css from './HostSettings.module.css'

/** The forge family of a provider row that has a host page. */
export type HostForge = 'github' | 'gitlab'

/** Registration-side face of a provider row's host page. */
export interface HostSettingsInjected extends HostFormActions {
  readonly hooks: {
    /** The saved and staged host lists. */
    readonly hostForm: SnapshotStore<HostFormState>
    /** Sign-in state by saved host. */
    readonly signIn: SnapshotStore<ReadonlyMap<string, HostSignIn>>
  }
  /** Which provider the row mounts. */
  readonly forge: HostForge
  /** Read the sign-in state of the saved hosts; `visibly` shows each host as being checked until its read answers. */
  readonly checkSignIn: (hosts: readonly string[], visibly: boolean) => void
  /** Copy a sign-in command and report the outcome. */
  readonly copyCommand: (command: string) => void
}

export type HostSettingsProps = PropsRuntime<'plugins.row.config'> & PropsLocale<typeof NS> & InjectFace<HostSettingsInjected>

type Translate = HostSettingsProps['t']

/** What differs between the two rows' pages. */
interface ForgeCopy {
  /** Key of what the provider's hosts call a change request. */
  readonly noun: ForgePanelKey
  /** The CLI the provider signs in with. */
  readonly cli: string
  /** A host name the field shows as its placeholder and a refusal names as an example. */
  readonly example: string
  /** Key of the refusal of a host the other provider serves. */
  readonly taken: ForgePanelKey
}

const FORGES: Record<HostForge, ForgeCopy> = {
  github: { noun: 'noun.pullRequest', cli: 'gh', example: 'github.example.com', taken: 'hosts.taken.gitlab' },
  gitlab: { noun: 'noun.mergeRequest', cli: 'glab', example: 'gitlab.example.com', taken: 'hosts.taken.github' },
}

const STATES: Record<HostSignIn['state'], { readonly dot: StateDotState; readonly key: ForgePanelKey }> = {
  ready: { dot: 'done', key: 'hosts.state.ready' },
  unauthenticated: { dot: 'warning', key: 'hosts.state.unauthenticated' },
  unavailable: { dot: 'error', key: 'hosts.state.unavailable' },
  checking: { dot: 'ongoing', key: 'hosts.state.checking' },
}

const CHECKING: HostSignIn = { state: 'checking' }

function problemText(problem: HostProblem, forge: HostForge, t: Translate): string {
  switch (problem.kind) {
    case 'invalid': return t('hosts.invalid', { example: FORGES[forge].example })
    case 'duplicate': return t('hosts.duplicate', { host: problem.host })
    case 'taken': return t(FORGES[forge].taken, { host: problem.host })
    /* v8 ignore next -- closed union. */
    default: return assertNever(problem, 'HostProblem')
  }
}

/**
 * One host of the list: its name, its sign-in state once saved, and its removal. A host that needs sign-in shows the
 * provider's command to copy; a host that could not be checked shows why.
 */
function HostRow({ host, signIn, removable, disabled, onRemove, onCopy, t }: {
  readonly host: string
  /** The sign-in state of a saved host, or undefined for a host a save would add. */
  readonly signIn: HostSignIn | undefined
  /** Whether another host would remain. */
  readonly removable: boolean
  readonly disabled: boolean
  readonly onRemove: (host: string) => void
  readonly onCopy: (command: string) => void
  readonly t: Translate
}): ReactNode {
  const command = signIn?.state === 'unauthenticated' ? signIn.signIn?.command : undefined
  const reason = signIn !== undefined && signIn.state !== 'checking' && signIn.state !== 'ready' && command === undefined ? signIn.message : null
  return (
    <li className={css.host} data-forge-host={host}>
      <div className={css.row}>
        <span className={css.name}>{host}</span>
        {signIn === undefined
          ? <span className={css.unsaved}>{t('hosts.state.unsaved')}</span>
          : (
            <span className={css.state} data-state={signIn.state}>
              <StateDot state={STATES[signIn.state].dot} />
              {t(STATES[signIn.state].key)}
            </span>
          )}
        <Tooltip label={removable ? t('hosts.remove', { host }) : t('hosts.keepOne')} side="bottom" delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={t('hosts.remove', { host })} aria-disabled={removable ? undefined : true}
            disabled={disabled} onClick={() => { if (removable) onRemove(host) }}>
            <IconTrashOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
      {command !== undefined && (
        <div className={css.command}>
          <code className={css.commandText}>{command}</code>
          <Button size="sm" aria-label={t('signin.copy')} onClick={() => { onCopy(command) }}>{t('signin.copyShort')}</Button>
        </div>
      )}
      {reason !== null && reason !== '' && <p className={css.reason}>{reason}</p>}
    </li>
  )
}

/**
 * Render a provider row's configuration: the hosts it serves, staged until one save, and the sign-in state of each
 * saved host, read when the page shows, after a save, and when the window regains focus. The summary view names the list.
 * @param props - the Plugins page view, the staged list with its actions, the sign-in states, and copy.
 * @returns the row page's form, or the summary line.
 */
export function HostSettings(props: HostSettingsProps): ReactNode {
  const { t, forge, view } = props
  const labelId = useId()
  const messageId = useId()
  const state = props.useHostForm(value => value)
  const signIn = props.useSignIn(value => value)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<HostProblem>()
  // The effect reads the latest list and check through refs, so it runs again only when the saved hosts change.
  const saved = useRef(state.saved)
  saved.current = state.saved
  const checkSignIn = useRef(props.checkSignIn)
  checkSignIn.current = props.checkSignIn
  const shown = view === 'page' && state.available
  const savedKey = state.saved.join('\n')
  useEffect(() => {
    if (!shown) return
    const again = (): void => { checkSignIn.current(saved.current, false) }
    again()
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [shown, savedKey])
  if (view === 'summary') return t('hosts.title')
  const disabled = !state.writable || state.saving
  const add = (): void => {
    const refused = props.add(text)
    setProblem(refused)
    if (refused === undefined) setText('')
  }
  return (
    <SettingsForm labels={rowFormLabels(t, 'hosts.unavailable')} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.field}>
        <div className={css.head}>
          <span className={css.label} id={labelId}>{t('hosts.title')}</span>
          <Tooltip label={t('hosts.recheck')} side="bottom" delayMs={500}>
            <button type="button" className={css.iconButton} aria-label={t('hosts.recheck')} onClick={() => { props.checkSignIn(state.saved, true) }}>
              <IconRefreshOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
        <ul className={css.hosts} aria-labelledby={labelId}>
          {state.draft.map(host => (
            <HostRow key={host} host={host} signIn={state.saved.includes(host) ? signIn.get(host) ?? CHECKING : undefined}
              removable={state.draft.length > 1} disabled={disabled} onRemove={props.remove} onCopy={props.copyCommand} t={t} />
          ))}
        </ul>
        <div className={css.addRow}>
          <input className={css.input} type="text" value={text} placeholder={FORGES[forge].example} aria-label={t('hosts.addLabel')}
            aria-invalid={problem === undefined ? undefined : true} aria-describedby={messageId} disabled={disabled}
            autoComplete="off" autoCapitalize="none" spellCheck={false}
            onChange={(event) => { setText(event.target.value); setProblem(undefined) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              add()
            }} />
          <Button variant="outline" className={css.add} disabled={disabled || text.trim() === ''} onClick={add}>{t('hosts.add')}</Button>
        </div>
        {problem === undefined
          ? <p id={messageId} className={css.hint}>{t('hosts.hint', { noun: t(FORGES[forge].noun), cli: FORGES[forge].cli })}</p>
          : <p id={messageId} className={css.invalid} role="alert">{problemText(problem, forge, t)}</p>}
      </div>
    </SettingsForm>
  )
}
