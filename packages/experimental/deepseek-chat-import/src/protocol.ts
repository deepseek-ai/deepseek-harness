/** Route constants shared by the Host route and the browser uploader. */

/** Absolute route below `/api` that receives one export archive. */
export const UPLOAD_PATH = '/api/deepseek-chat-import/archive'

/**
 * Browser-relative form of {@link UPLOAD_PATH}; the page resolves it against
 * its document base so a path-prefixing proxy keeps working.
 */
export const UPLOAD_ROUTE = UPLOAD_PATH.slice(1)
