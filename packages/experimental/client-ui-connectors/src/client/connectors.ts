/** The official connectors the Connectors tab offers, in the official list's order. */
import { CONNECTOR_BUNDLES } from '@deepseek-ai/dsh-official-bundles'

const SCOPE = '@deepseek-ai/dsh-'

type IdOf<Name> = Name extends `${typeof SCOPE}${infer Id}` ? Id : never

/** Dictionary prefix of one connector's title and description: its package name without the scope prefix. */
export type ConnectorId = IdOf<(typeof CONNECTOR_BUNDLES)[number]>

/** One official connector bundle. */
export interface Connector {
  /** Dictionary prefix of its title and description. */
  readonly id: ConnectorId
  /** npm package name of its bundle, released with DSH at the same version. */
  readonly packageName: string
}

/** Every official connector, in display order. */
export const CONNECTORS: readonly Connector[] = CONNECTOR_BUNDLES.map(packageName => ({
  // Every name in the list starts with the scope prefix, as `ConnectorId` requires.
  id: packageName.slice(SCOPE.length) as ConnectorId,
  packageName,
}))
