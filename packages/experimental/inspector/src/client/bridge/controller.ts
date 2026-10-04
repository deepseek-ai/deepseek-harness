/** Browser Client bridge construction for the Cordis plugin entry. */

import type { InspectorClientBootstrap } from '../../shared/bridge/messages/control.ts'
import { ClientInspectorSource } from './transport.ts'
import { ClientRealmSource } from '../inspection/realm.ts'
import { untitledClientLabel } from './locales.ts'

/**
 * Start the browser source transport for one validated Host bootstrap.
 * @param bootstrap - Host-injected endpoint and resource limits.
 * @returns The active reconnecting Client source after its tab identity is claimed.
 */
export async function startInspectorClient(bootstrap: InspectorClientBootstrap): Promise<ClientInspectorSource> {
  const label = document.title || untitledClientLabel
  const realmSource = await ClientRealmSource.claim(label)
  try {
    return new ClientInspectorSource(bootstrap, label, undefined, realmSource)
  } catch (error) {
    realmSource.close()
    throw error
  }
}
