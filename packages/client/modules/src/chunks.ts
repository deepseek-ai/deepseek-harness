/**
 * Package-local chunk file names shared by the client build preset, the Host
 * chunk route, the browser module system, the publication closure check, and
 * the WebWorker packer. The preset names split output files with this pattern,
 * the route serves only matching names, the module system accepts only
 * matching `chunk` registrations and `./client.<name>.js` requests, the closure
 * check accepts such a request when the entry file registers the chunk, and the
 * packer moves only matching requested chunks out of its base image, so all of
 * them read it from this one module.
 * @module @deepseek-ai/dsh-client-modules/src/chunks
 */

/** File name of one package-local chunk emitted beside a package's Client entry: `client.<name>.js`. */
export const CLIENT_CHUNK_FILE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
