/**
 * Route paths and wire payloads shared verbatim by the host routes and the
 * browser package (`@deepseek-ai/dsh-client-ui-open-in-app`), published as
 * the `./shared` subpath. Browser-safe: constants and types only. Each route
 * carries the absolute pathname the Host registers beside the
 * document-relative form the browser addresses; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */

/** GET route path serving the probed application ids. */
export const OPEN_IN_APP_APPS_PATH = '/open-in-app/apps'

/** Browser-relative form of {@link OPEN_IN_APP_APPS_PATH}. */
export const OPEN_IN_APP_APPS_ROUTE = OPEN_IN_APP_APPS_PATH.slice(1)

/** GET prefix path serving one PNG bundle icon per application id. */
export const OPEN_IN_APP_ICON_PREFIX_PATH = '/open-in-app/icon'

/** Browser-relative form of {@link OPEN_IN_APP_ICON_PREFIX_PATH}. */
export const OPEN_IN_APP_ICON_PREFIX_ROUTE = OPEN_IN_APP_ICON_PREFIX_PATH.slice(1)

/** POST route path launching one application on one workspace directory. */
export const OPEN_IN_APP_OPEN_PATH = '/open-in-app/open'

/** Browser-relative form of {@link OPEN_IN_APP_OPEN_PATH}. */
export const OPEN_IN_APP_OPEN_ROUTE = OPEN_IN_APP_OPEN_PATH.slice(1)

/** Apps-route response: catalog ids probed as installed, in menu order. */
export interface OpenInAppAppsPayload {
  readonly apps: readonly string[]
}

/** Open-route request body. */
export interface OpenInAppOpenPayload {
  readonly app: string
  readonly path: string
}
