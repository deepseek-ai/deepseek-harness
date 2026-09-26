/** Adapt authorized delivery and changed-file routes to the shared opening control. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import { parseNativeFileApplications } from '@deepseek-ai/dsh-native-command/types'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import { useFileApplications } from './file-applications.ts'
import { OpenTargetButton } from './OpenTargetButton.tsx'
import type { NS } from './locales.ts'

async function queryRoute(url: string, signal: AbortSignal): Promise<readonly SessionWorkspacePathApplication[] | null> {
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    return parseNativeFileApplications(await response.json())
  } catch (_error) {
    // Unavailable routes and malformed responses leave file reveal as the fallback.
    return null
  }
}

/**
 * Render file actions without bypassing the owning Session's authorization route.
 * @param props - authenticated route, desktop availability, and native gesture callback.
 * @returns the shared compact control, or null without a desktop.
 */
export function FileRouteAction(
  props: Pick<PropsRuntime<'deliverables.file.actions'>, 'actionUrl' | 'available' | 'pending' | 'onAction'> & PropsLocale<typeof NS>,
) {
  const association = useFileApplications(props.actionUrl, queryRoute, props.available)
  if (!props.available) return null
  return <OpenTargetButton key={props.actionUrl} kind="file" applications={association.apps}
    defaultId={association.apps.find(app => app.default)?.id} failed={association.failed}
    loading={association.loading} busy={props.pending} refresh={association.refresh} t={props.t}
    execute={async (operation) => {
      return props.onAction(operation.kind === 'reveal' ? 'reveal' : 'open', operation.kind === 'application' ? operation.id : undefined)
    }} />
}
