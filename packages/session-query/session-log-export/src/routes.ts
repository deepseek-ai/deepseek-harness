/**
 * The absolute pathname the Host registers the export under and the
 * document-relative form the browser addresses; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */

/** Absolute registration path for the ZIP download route. */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** Browser-relative form of {@link SESSION_LOG_EXPORT_PATH}. */
export const SESSION_LOG_EXPORT_ROUTE = SESSION_LOG_EXPORT_PATH.slice(1)
