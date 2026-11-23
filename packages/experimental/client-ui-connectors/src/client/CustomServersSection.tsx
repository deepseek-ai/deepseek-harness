/** The custom servers section: the manager's Settings servers in a list, and one server's page with its form. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account/client'
import type { CustomServer, CustomServersFace } from './custom-servers-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import { ServerDetail } from './ServerDetail.tsx'
import { draftFromEntry, emptyDraft, type ServerDraft } from '../server-form.ts'
import css from './CustomServers.module.css'

/** What the section shows: its list, the form of a new server, or one server's page. */
export type CustomServersView =
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  | { readonly kind: 'server'; readonly name: string }

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
 * List the servers with their target, an OAuth server's account status, settings, and switch, below the button that
 * opens a new server's form; or show the page the tab's view names.
 * @param props - the view, the face, the dictionary, and the Factory renderer.
 * @returns the section, or null while the manager is unavailable or a named server is not listed.
 */
export function CustomServersSection(props: CustomServersSectionProps): ReactNode {
  const { t, view, setView, ensure, retry, save, remove, setEnabled, probe, dismissFailure, renderFactorySlot } = props
  const state = props.useCustomServers(snapshot => snapshot)
  const [removing, setRemoving] = useState<string | null>(null)
  useEffect(() => { ensure() }, [ensure])
  const open = view.kind === 'server' ? state.servers.find(server => server.name === view.name) : undefined
  // A server removed elsewhere, or one the form cannot read, closes its page.
  const gone = view.kind === 'server' && state.status === 'ready' && open?.raw === undefined
  useEffect(() => { if (gone) setView({ kind: 'list' }) }, [gone, setView])
  if (state.status === 'unavailable') return null
  const notices = (
    <>
      {state.status === 'error'
        ? (
          <p className={css.notice} role="alert">
            {t('custom.loadFailed')}
            <Button variant="ghost" size="sm" onClick={retry}>{t('retry')}</Button>
          </p>
        )
        : null}
      {state.failure === undefined
        ? null
        : (
          <p className={css.notice} role="alert">
            {state.failure.kind === 'conflict' ? t('custom.conflict') : t('custom.refused', { message: state.failure.message })}
            <Button variant="ghost" size="sm" onClick={dismissFailure}>{t('close')}</Button>
          </p>
        )}
    </>
  )
  if (view.kind !== 'list') {
    // `open` is undefined on the form of a new server.
    const raw = open?.raw
    if (view.kind === 'server' && raw === undefined) return null
    const onSave = (draft: ServerDraft): void => {
      void save(draft).then((saved) => { if (saved) setView({ kind: 'list' }) })
    }
    return (
      <section className={css.section} data-custom-servers>
        {notices}
        <ServerDetail key={open?.name ?? ''} initial={open === undefined || raw === undefined ? emptyDraft() : draftFromEntry(open.name, raw)}
          isNew={open === undefined} taken={state.servers.map(server => server.name)} saving={state.saving} t={t}
          account={open !== undefined && raw?.oauth !== undefined && raw.enabled !== false
            ? renderFactorySlot('connector.account', { account: `mcp:${open.name}`, presentation: 'section' })
            : null}
          probe={open === undefined ? undefined : state.probes[open.name]}
          onProbe={open === undefined ? undefined : () => { probe(open.name) }}
          onDelete={open === undefined || open.inherited || !state.writable ? undefined : () => { setRemoving(open.name) }}
          onSave={onSave} />
        {removing === null
          ? null
          : (
            <Modal open title={t('custom.removeTitle', { name: removing })} closeLabel={t('close')} onClose={() => { setRemoving(null) }}
              footer={<>
                <Button variant="ghost" onClick={() => { setRemoving(null) }}>{t('form.cancel')}</Button>
                <Button variant="primary" data-modal-autofocus onClick={() => { remove(removing); setRemoving(null); setView({ kind: 'list' }) }}>
                  {t('custom.remove')}
                </Button>
              </>}>
              <p>{t('custom.removeBody')}</p>
            </Modal>
          )}
      </section>
    )
  }
  return (
    <section className={css.section} data-custom-servers>
      <div className={css.headingRow}>
        <h3 className={css.heading}>{t('custom.title')}</h3>
        <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} disabled={!state.writable}
          onClick={() => { setView({ kind: 'new' }) }}>
          {t('custom.add')}
        </Button>
      </div>
      {notices}
      {state.status === 'ready' && state.servers.length === 0 ? <p className={css.empty}>{t('custom.empty')}</p> : null}
      <ul className={css.list}>
        {state.servers.map((server) => {
          const { raw } = server
          const enabled = raw?.enabled !== false
          return (
            <li key={server.name} className={css.server} data-custom-server={server.name}>
              <div className={css.main}>
                <span className={css.name}>{server.name}</span>
                <span className={css.summary}>{summary(server, t)}</span>
              </div>
              <div className={css.actions}>
                {raw?.oauth === undefined || !enabled
                  ? null
                  : renderFactorySlot('connector.account', { account: `mcp:${server.name}`, presentation: 'status' })}
                <Button variant="ghost" size="sm" aria-label={t('custom.settingsLabel', { name: server.name })}
                  disabled={raw === undefined || !state.writable} onClick={() => { setView({ kind: 'server', name: server.name }) }}>
                  {t('custom.settings')}
                </Button>
                <Switch checked={enabled} disabled={!state.writable || raw === undefined} label={t('custom.enableLabel', { name: server.name })}
                  onChange={(next) => { setEnabled(server.name, next) }} />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
