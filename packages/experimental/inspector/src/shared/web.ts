/** Authenticated browser bootstrap route; the debugging URL stays on the Host. */

import { inspectorId, type InspectorSourceId } from './bridge/ids.ts'

/** Read the current browser-source connection parameters. */
export const INSPECTOR_BOOTSTRAP_PATH = '/api/experimental-inspector/bootstrap'

/** Document-relative browser route for the authenticated source bootstrap. */
export const INSPECTOR_BOOTSTRAP_ROUTE = INSPECTOR_BOOTSTRAP_PATH.slice(1)

/** Query parameter selecting the Client visible beside Host in one DevTools connection. */
export const INSPECTOR_CLIENT_QUERY = 'clientSourceId'

/**
 * Read an optional Client selection from a DevTools WebSocket URL.
 * @param url - Untrusted upgrade URL.
 * @returns The selected logical Client id, or undefined for all Clients.
 * @throws If the selection is repeated or is not a valid source id.
 */
export function readInspectorClientSelection(url: URL): InspectorSourceId | undefined {
  const values = url.searchParams.getAll(INSPECTOR_CLIENT_QUERY)
  const selected = values[0]
  if (selected === undefined) return undefined
  if (values.length !== 1) throw new Error('Inspector Client selection must occur once')
  return inspectorId<'InspectorSourceId'>(selected, INSPECTOR_CLIENT_QUERY)
}
