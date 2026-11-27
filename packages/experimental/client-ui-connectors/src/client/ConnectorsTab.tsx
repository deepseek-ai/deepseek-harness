/**
 * The Connectors tab: its actions beside the first heading, and the official connectors with their brand icons, each
 * with an Install action or its enable switch, above the custom servers section.
 */
import { useEffect, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { PluginTabProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import dingtalk from './assets/dingtalk.svg'
import feishu from './assets/feishu.svg'
import linear from './assets/linear.svg'
import notion from './assets/notion.svg'
import tencentDocs from './assets/tencent-docs.svg'
import tencentMeeting from './assets/tencent-meeting.svg'
import wecom from './assets/wecom.svg'
import { CONNECTORS, type Connector, type ConnectorId } from './connectors.ts'
import type { ConnectorsFace, ConnectorStatus } from './connectors-store.ts'
import type { CustomServersView } from './CustomServersSection.tsx'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsTab.module.css'

/** Each connector's brand icon, the same file its bundle declares. */
const ICONS: Readonly<Record<ConnectorId, string>> = {
  'feishu': feishu, 'wecom': wecom, 'dingtalk': dingtalk, 'tencent-meeting': tencentMeeting, 'notion': notion,
  'tencent-docs': tencentDocs, 'linear': linear,
}

/** The tab's own pages as the Plugins page keys them: the form of a new server, and one server's page by its row id. */
const NEW_PAGE = 'new'
const SERVER_PAGE = 'server:'

/** The custom servers view a page key of the Plugins page names; no key is the lists. */
function viewOf(page: string | undefined): CustomServersView {
  if (page === undefined) return { kind: 'list' }
  return page.startsWith(SERVER_PAGE) ? { kind: 'server', id: page.slice(SERVER_PAGE.length) } : { kind: 'new' }
}

/** What the Connectors tab passes to each of its actions: the change of the view it shows. */
export interface ConnectorsActionOwnerProps {
  readonly setView: (view: CustomServersView) => void
}

/**
 * Tab props: the Plugins page's install, open, and own-page callbacks, the tab's actions and custom servers section,
 * the dictionary, and the injected face.
 */
export type ConnectorsTabProps = PropsRuntime<'plugins.tab'> & PropsRenderSlots<'connectors.actions' | 'connectors.custom'>
  & PropsLocale<'connectors'> & InjectFace<ConnectorsFace>

/**
 * List every official connector above the custom servers section, with the tab's actions at the end of the first
 * heading's row; a missing connector installs at the running release through the page's install dialog, and an
 * installed one carries its enable switch and opens its page from anywhere else on its row. A server's page is one of
 * the tab's own pages on the Plugins page: while one is open, the tab shows only the custom servers section, under the
 * crumb the Plugins page draws.
 * @param props - the owner's callbacks, the actions' and the section's slots, the dictionary, and the connectors' states.
 * @returns the tab's content.
 */
export function ConnectorsTab(props: ConnectorsTabProps): ReactNode {
  const { t, install, openPackage, page, openPage, closePage, ensure, retry, setEnabled, version } = props
  const state = props.useConnectors(snapshot => snapshot)
  useEffect(() => { ensure() }, [ensure])
  const customView = viewOf(page)
  const setCustomView = (view: CustomServersView): void => {
    switch (view.kind) {
      case 'list': closePage(); return
      case 'new': openPage(NEW_PAGE); return
      case 'server': openPage(`${SERVER_PAGE}${view.id}`); return
      /* v8 ignore next -- closed view union */
      default: assertNever(view)
    }
  }
  const custom = props.renderSlot('connectors.custom', { view: customView, setView: setCustomView })
  // A custom server's page replaces the tab's lists.
  if (customView.kind !== 'list') return <section className={css.section} data-connectors>{custom}</section>
  const failed = CONNECTORS.find(connector => connector.packageName === state.failed)
  return (
    <section className={css.section} data-connectors>
      <div className={css.headingRow}>
        <h3 className={css.heading}>{t('official')}</h3>
        <div className={css.actions}>{props.renderSlot('connectors.actions', { setView: setCustomView })}</div>
      </div>
      {state.status === 'error'
        ? (
          <p className={css.notice} role="alert">
            {t('loadFailed')}
            <Button variant="ghost" size="sm" onClick={retry}>{t('retry')}</Button>
          </p>
        )
        : null}
      {failed === undefined
        ? null
        : <p className={css.notice} role="alert">{t('switchFailed', { name: t(`${failed.id}.title`) })}</p>}
      <ul className={css.list} aria-busy={state.status === 'loading'}>
        {CONNECTORS.map(connector => (
          <ConnectorRow key={connector.id} connector={connector} status={state.connectors[connector.packageName]}
            busy={state.busy.includes(connector.packageName)} version={version} t={t} install={install}
            openPackage={openPackage} setEnabled={setEnabled} />
        ))}
      </ul>
      {custom}
    </section>
  )
}

function ConnectorRow({ connector, status, busy, version, t, install, openPackage, setEnabled }: {
  readonly connector: Connector
  readonly status: ConnectorStatus | undefined
  readonly busy: boolean
  readonly version: string | undefined
  readonly t: Translate<ConnectorsLocaleKey>
  readonly install: PluginTabProps['install']
  readonly openPackage: PluginTabProps['openPackage']
  readonly setEnabled: ConnectorsFace['setEnabled']
}): ReactNode {
  const { id, packageName } = connector
  const title = t(`${id}.title`)
  const installed = status === 'installed' || status === 'enabled'
  return (
    <li className={installed ? `${css.row} ${css.link}` : css.row} data-connector={id}>
      <span className={css.icon} aria-hidden="true"><img src={ICONS[id]} width={36} height={36} alt="" /></span>
      <div className={css.main}>
        {installed
          ? (
            <button type="button" className={`${css.title} ${css.open}`} aria-label={t('openTitle', { name: title })}
              onClick={() => { openPackage(packageName) }}>{title}</button>
          )
          : <span className={css.title}>{title}</span>}
        <span className={css.description}>{t(`${id}.description`)}</span>
      </div>
      <div className={css.end}>
        {installed
          ? (
            <Switch checked={status === 'enabled'} label={title} disabled={busy}
              onChange={(enabled) => { setEnabled(packageName, enabled) }} />
          )
          : null}
        {status === 'missing' && version !== undefined
          ? (
            <Button variant="outline" size="sm" aria-label={t('installTitle', { name: title })}
              onClick={() => { install({ spec: `${packageName}@${version}`, title, version }) }}>
              {t('install')}
            </Button>
          )
          : null}
      </div>
    </li>
  )
}
