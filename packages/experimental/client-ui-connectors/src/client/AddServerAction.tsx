/** The Connectors tab action that opens the form of a new custom MCP server. */
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { CustomServersFace } from './custom-servers-store.ts'
import css from './CustomServers.module.css'

/** Action props: the tab's view change, the dictionary, and the injected face. */
export type AddServerActionProps = PropsRuntime<'connectors.actions'> & PropsLocale<'connectors'> & InjectFace<CustomServersFace>

/**
 * Offer the form of a new custom MCP server among the tab's actions.
 * @param props - the view change, the dictionary, and the custom servers' state.
 * @returns the button, or null while the profile cannot keep custom servers.
 */
export function AddServerAction(props: AddServerActionProps): ReactNode {
  const { t, setView } = props
  const unavailable = props.useCustomServers(state => state.status === 'unavailable')
  if (unavailable) return null
  return (
    <Button variant="primary" size="sm" className={css.addServer} icon={<IconPlusOutlineRegular size={13} />}
      onClick={() => { setView({ kind: 'new' }) }}>
      {t('custom.add')}
    </Button>
  )
}
