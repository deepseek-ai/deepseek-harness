/** The custom servers section: the MCP server rows in a list, and one server's page with its form. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconSettingsOutlineRegular, PluginArtworkDefault, RiskConfirmation, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account/client'
import type { CustomServer, CustomServersFace } from './custom-servers-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import { ServerDetail } from './ServerDetail.tsx'
import { draftFromEntry, emptyDraft, type ServerDraft } from '../server-form.ts'
import css from './CustomServers.module.css'

/** What the section shows: its list, the form of a new server, or the page of the server row `id` names. */
export type CustomServersView =
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  | { readonly kind: 'server'; readonly id: string }

/** What the Connectors tab passes: the view it shows, and the change the section asks for. */
export interface CustomServersOwnerProps {
  readonly view: CustomServersView
  readonly setView: (view: CustomServersView) => void
}

/** Section props: the tab's view, the Factory renderer for a server's account, the dictionary, and the injected face. */
export type CustomServersSectionProps = PropsRuntime<'connectors.custom'> & PropsRenderFactories & PropsLocale<'connectors'> & InjectFace<CustomServersFace>

type T = Translate<ConnectorsLocaleKey>

function summary(server: CustomServer, t: T): string {
  if (server.raw === undefined) return t('custom.unreadable')
  const target = server.raw.transport === 'stdio' ? server.raw.command : server.raw.url
  return typeof target === 'string' ? target : ''
}

/**
 * List the servers with their target, the reason a server did not start, the account status of an OAuth server that
 * is on, settings, and switch; or show the page the tab's view names. Once a list holds no row the form can read for
 * the named server, a notice takes the page's place. Switching a local command on asks for the risk confirmation first.
 * @param props - the view, the face, the dictionary, and the Factory renderer.
 * @returns the section, or null while the profile cannot keep custom servers.
 */
export function CustomServersSection(props: CustomServersSectionProps): ReactNode {
  const { t, view, setView, ensure, retry, save, remove, setEnabled, probe, dismissFailure, renderFactorySlot } = props
  const state = props.useCustomServers(snapshot => snapshot)
  const [enabling, setEnabling] = useState<CustomServer | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => { ensure() }, [ensure])
  const open = view.kind === 'server' ? state.servers.find(server => server.id === view.id) : undefined
  if (state.status === 'unavailable') return null
  const notices = (
    <>
      {state.status === 'error'
        ? (
          <p className={css.notice} role="alert">
            {t('custom.loadFailed')}
            <Button variant="ghost" size="sm" className={css.noticeAction} onClick={retry}>{t('retry')}</Button>
          </p>
        )
        : null}
      {state.failure === undefined
        ? null
        : (
          <p className={css.notice} role="alert">
            {state.failure.kind === 'conflict' ? t('custom.conflict') : t('custom.refused', { message: state.failure.message })}
            <Button variant="ghost" size="sm" className={css.noticeAction} onClick={dismissFailure}>{t('close')}</Button>
          </p>
        )}
    </>
  )
  if (view.kind !== 'list') {
    // `open` is undefined on the form of a new server.
    const raw = open?.raw
    if (view.kind === 'server' && raw === undefined) {
      // Once a list has arrived, a missing or unreadable row means the server was removed or changed elsewhere.
      return (
        <section className={css.page} data-custom-servers>
          {notices}
          {state.status === 'ready' ? <p className={css.notice} role="alert">{t('custom.gone')}</p> : null}
        </section>
      )
    }
    // The manager holds only a server that is on, so only that one has an account and a connection to test.
    const running = open?.state === 'on' ? open : undefined
    const onSave = (draft: ServerDraft): void => {
      void save(draft, open?.id).then((saved) => { if (saved) setView({ kind: 'list' }) })
    }
    return (
      <section className={css.page} data-custom-servers>
        {notices}
        <ServerDetail key={open?.id ?? ''} initial={open === undefined || raw === undefined ? emptyDraft() : draftFromEntry(open.name, raw)}
          status={open} entry={raw} taken={state.servers.filter(server => server !== open).map(server => server.name)}
          saving={state.saving} t={t}
          account={running === undefined || raw?.oauth === undefined
            ? null
            : renderFactorySlot('connector.account', { account: `mcp:${running.name}`, presentation: 'section' })}
          probe={running === undefined ? undefined : state.probes[running.name]}
          onProbe={running === undefined ? undefined : () => { probe(running.name) }}
          onDelete={open === undefined || open.inherited ? undefined : () => { remove(open.id); setView({ kind: 'list' }) }}
          onSave={onSave} />
      </section>
    )
  }
  const switchServer = (server: CustomServer, next: boolean): void => {
    // Switching a local command on runs it, so the switch asks first.
    if (next && server.raw?.transport === 'stdio') {
      setAcknowledged(false)
      setEnabling(server)
      return
    }
    setEnabled(server.id, next)
  }
  return (
    <section className={css.section} data-custom-servers>
      <h3 className={css.heading}>{t('custom.title')}</h3>
      {notices}
      {state.status === 'ready' && state.servers.length === 0 ? <p className={css.empty}>{t('custom.empty')}</p> : null}
      <ul className={css.list}>
        {state.servers.map((server) => {
          const { raw } = server
          return (
            <li key={server.id} className={css.server} data-custom-server={server.name}>
              <span className={css.icon} aria-hidden="true"><PluginArtworkDefault size={36} /></span>
              <div className={css.main}>
                <span className={css.name}>{server.name}</span>
                <span className={css.summary}>{summary(server, t)}</span>
                {server.state === 'failed' ? <span className={css.reason}>{t('custom.failed', { message: server.error })}</span> : null}
              </div>
              <div className={css.actions}>
                {raw?.oauth === undefined || server.state !== 'on'
                  ? null
                  : renderFactorySlot('connector.account', { account: `mcp:${server.name}`, presentation: 'status' })}
                <Tooltip label={t('custom.settings')} side="bottom" portal delayMs={300} disabled={raw === undefined}>
                  <Button variant="ghost" size="sm" icon={<IconSettingsOutlineRegular size={14} />}
                    aria-label={t('custom.settingsLabel', { name: server.name })} disabled={raw === undefined}
                    onClick={() => { setView({ kind: 'server', id: server.id }) }} />
                </Tooltip>
                <Switch checked={server.state !== 'off'} disabled={raw === undefined} label={t('custom.enableLabel', { name: server.name })}
                  onChange={(next) => { switchServer(server, next) }} />
              </div>
            </li>
          )
        })}
      </ul>
      {enabling === null
        ? null
        : (
          <RiskConfirmation open title={t('stdio.title')} description={t('stdio.enableBody', { command: summary(enabling, t) })}
            acknowledgeLabel={t('stdio.acknowledge')} cancelLabel={t('form.cancel')} closeLabel={t('close')} confirmLabel={t('stdio.enableConfirm')}
            acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} onCancel={() => { setEnabling(null) }}
            onConfirm={() => { setEnabling(null); setEnabled(enabling.id, true) }} />
        )}
    </section>
  )
}
