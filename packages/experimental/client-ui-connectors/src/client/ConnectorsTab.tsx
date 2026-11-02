/** The Connectors tab: the official connectors with an install or open action each. */
import { useEffect, type ReactNode } from 'react'
import { Button, PluginArtworkDefault } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginTabInstall } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CONNECTORS, type Connector } from './connectors.ts'
import type { ConnectorsFace, ConnectorStatus } from './connectors-store.ts'
import type { ConnectorsLocaleKey } from './locales.ts'
import css from './ConnectorsTab.module.css'

/** Tab props: the Plugins page's install and open callbacks, the dictionary, and the injected face. */
export type ConnectorsTabProps = PropsRuntime<'plugins.tab'> & PropsLocale<'connectors'> & InjectFace<ConnectorsFace>

/**
 * List every official connector; a missing one installs at the running release, an installed one opens its page.
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
  readonly install: (target: PluginTabInstall) => void
  readonly openPackage: (packageName: string) => void
}): ReactNode {
  const title = t(`${connector.id}.title`)
  const action = (): ReactNode => {
    if (status === undefined) return null
    if (status !== 'missing') {
      return (
        <Button variant="ghost" size="sm" aria-label={t('openTitle', { name: title })} onClick={() => { openPackage(connector.packageName) }}>
          {t(status)}
        </Button>
      )
    }
    if (version === undefined) return <Button variant="outline" size="sm" disabled aria-label={t('installTitle', { name: title })}>{t('install')}</Button>
    return (
      <Button variant="outline" size="sm" aria-label={t('installTitle', { name: title })}
        onClick={() => { install({ spec: `${connector.packageName}@${version}`, title, version }) }}>
        {t('install')}
      </Button>
    )
  }
  return (
    <li className={css.row} data-connector={connector.id}>
      <span className={css.icon} aria-hidden="true"><PluginArtworkDefault size={36} /></span>
      <div className={css.main}>
        <span className={css.title}>{title}</span>
        <span className={css.description}>{t(`${connector.id}.description`)}</span>
      </div>
      <div className={css.end}>{action()}</div>
    </li>
  )
}
