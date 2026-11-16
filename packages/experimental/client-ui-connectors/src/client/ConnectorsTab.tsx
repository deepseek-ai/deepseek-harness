/** The Connectors tab: the official connectors with their brand icons and the Installed list's switch each. */
import { useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
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
  'feishu': feishu, 'wecom': wecom, 'dingtalk': dingtalk, 'tencent-meeting': tencentMeeting,
  'notion': notion, 'tencent-docs': tencentDocs, 'linear': linear,
}

/** Tab props: the Plugins page's callbacks and switch Factory, the dictionary, and the injected face. */
export type ConnectorsTabProps = PropsRuntime<'plugins.tab'> & PropsRenderFactories & PropsLocale<'connectors'> & InjectFace<ConnectorsFace>

/**
 * List every official connector with the Installed list's switch; a missing one's switch installs it at the running
 * release and switches it on, and an installed one's name opens its page.
 * @param props - the owner's callbacks and switch Factory, the dictionary, and the connectors' states.
 * @returns the tab's content.
 */
export function ConnectorsTab(props: ConnectorsTabProps): ReactNode {
  const { t, openPackage, renderFactorySlot, ensure, retry, version } = props
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
            version={version} t={t} openPackage={openPackage} renderFactorySlot={renderFactorySlot} />
        ))}
      </ul>
    </section>
  )
}

function ConnectorRow({ connector, status, version, t, openPackage, renderFactorySlot }: {
  readonly connector: Connector
  readonly status: ConnectorStatus | undefined
  readonly version: string | undefined
  readonly t: Translate<ConnectorsLocaleKey>
  readonly openPackage: PluginTabProps['openPackage']
  readonly renderFactorySlot: PropsRenderFactories['renderFactorySlot']
}): ReactNode {
  const { id, packageName } = connector
  const title = t(`${id}.title`)
  const installed = status === 'installed' || status === 'enabled'
  const install = status === 'missing' && version !== undefined ? { spec: `${packageName}@${version}`, title, version } : undefined
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
        {status === undefined ? null : renderFactorySlot('plugins.bundle.switch', { packageName, ...install === undefined ? {} : { install } })}
      </div>
    </li>
  )
}
