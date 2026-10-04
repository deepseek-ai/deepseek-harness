import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { APP_LABEL_KEY } from './applications.ts'
import type { OpenInAppLaunchState } from './controller.ts'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { NS } from './locales.ts'
import { OpenTargetButton } from './OpenTargetButton.tsx'

/** Browser operations and state shared by the Session header and file tree contributions. */
export interface OpenInAppActionInjected {
  hooks: {
    openInAppApps: ObservableSnapshot<readonly string[] | null>
    openInAppChoice: ObservableSnapshot<string>
    openInAppLaunch: ObservableSnapshot<OpenInAppLaunchState>
    shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
  }
  launch: (appId: string, path: string) => Promise<void>
  choose: (appId: string) => void
  iconUrl: (appId: string) => string
}

/** Directory path, installed applications, and launch operations for the split button. */
export type OpenInAppActionProps =
  PropsLocale<typeof NS>
  & InjectFace<OpenInAppActionInjected>
  & { absolutePath: string }

/**
 * Adapt the installed directory catalog to the shared opening control.
 * @param props - displayed directory, installed catalog, and launch operations.
 * @returns the shared control, or null without an eligible application.
 */
export function OpenInAppAction(props: OpenInAppActionProps): React.JSX.Element | null {
  const { absolutePath, useOpenInAppApps, useOpenInAppChoice, t } = props
  const available = useOpenInAppApps(apps => apps)
  const choice = useOpenInAppChoice(id => id)
  const operation = props.useOpenInAppLaunch(value => value)
  const shortcut = props.useShortcuts(rows => rows.find(row => row.id === 'workspace.openLocal'))
  const apps = (available ?? []).flatMap((id) => {
    const key = APP_LABEL_KEY[id]
    return key === undefined ? [] : [{ id, name: t(key), icon: props.iconUrl(id) }]
  })
  const preferred = apps.find(app => app.id === choice) ?? apps[0]
  if (preferred === undefined) return null
  return (
    <OpenTargetButton
      key={absolutePath} kind="directory" applications={apps} defaultId={preferred.id} failed={false} t={t}
      busy={operation.phase === 'busy'} shortcut={shortcut}
      execute={async (operation) => {
        const id = operation.kind === 'application' ? operation.id : preferred.id
        try {
          await props.launch(id, absolutePath)
        } catch (_error) {
          // Native launch failure is announced by the shared control.
          return 'openError'
        }
        if (operation.kind === 'application') props.choose(id)
        return null
      }}
    />
  )
}
