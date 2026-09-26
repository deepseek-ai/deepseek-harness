/** Authenticated raw-byte route owned by the file-upload service. */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'

/**
 * Browser-relative form of {@link FILE_UPLOAD_PATH}; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
export const FILE_UPLOAD_ROUTE = FILE_UPLOAD_PATH.slice(1)
