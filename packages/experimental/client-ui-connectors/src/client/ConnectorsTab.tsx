/** The Connectors tab: the official connectors with their brand icons, each with an Install action or its state. */
import { useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginTabProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import dingtalk from './assets/dingtalk.svg'
import feishu from './assets/feishu.svg'
import linear from './assets/linear.svg'
import notion from './assets/notion.svg'
import tencentDocs from './assets/tencent-docs.svg'
import tencentMeeting from './assets/tencent-meeting.svg'
import wecom from './assets/wecom.svg'
import { CONNECTORS, type Connector, type ConnectorId } from './connectors.ts'
import type { ConnectorsFace, ConnectorStatus } from './connectors-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsTab.module.css'

/** Each connector's brand icon, the same file its bundle declares. */
const ICONS: Readonly<Record<ConnectorId, string>> = {
  'feishu': feishu, 'wecom': wecom, 'dingtalk': dingtalk, 'tencent-meeting': tencentMeeting, 'notion': notion,
  'tencent-docs': tencentDocs, 'linear': linear,
}

/** Tab props: the Plugins page's install and open callbacks, the dictionary, and the injected face. */
export type ConnectorsTabProps = PropsRuntime<'plugins.tab'> & PropsLocale<'connectors'> & InjectFace<ConnectorsFace>

/**
 * List every official connector; a missing one installs at the running release through the page's install dialog, and
 * an installed one shows its state and opens its page from anywhere on its row.
 * @param props - the owner's callbacks, the dictionary, and the connectors' states.
 * @returns the tab's content.
 */
export function ConnectorsTab(props: ConnectorsTabProps): ReactNode {
  const { t, install, openPackage, ensure, retry, version } = props
  const state = props.useConnectors(snapshot => snapshot)
  useEffect(() => { ensure() }, [ensure])
  return (
    <section className={css.section} data-connectors>
      <h3 className={css.heading}>{t('official')}</h3>
      {state.status === 'error'
        ? (
          <p className={css.notice} role="alert">
            {t('loadFailed')}
            <Button variant="ghost" size="sm" onClick={retry}>{t('retry')}</Button>
          </p>
        )
        : null}
      <ul className={css.list} aria-busy={state.status === 'loading'}>
        {CONNECTORS.map(connector => (
          <ConnectorRow key={connector.id} connector={connector} status={state.connectors[connector.packageName]}
            version={version} t={t} install={install} openPackage={openPackage} />
        ))}
      </ul>
    </section>
  )
}

function ConnectorRow({ connector, status, version, t, install, openPackage }: {
  readonly connector: Connector
  readonly status: ConnectorStatus | undefined
  readonly version: string | undefined
  readonly t: Translate<ConnectorsLocaleKey>
  readonly install: PluginTabProps['install']
  readonly openPackage: PluginTabProps['openPackage']
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
        {installed ? t(status) : null}
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
