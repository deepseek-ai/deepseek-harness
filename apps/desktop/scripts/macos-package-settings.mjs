/** Resolve file-owned macOS packaging concurrency and stage-specific proxies. */

function proxy(environment, name, protocols) {
  const value = environment[name]?.trim()
  if (!value) return undefined
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`desktop package: ${name} must be a proxy URL`) }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`desktop package: ${name} requires an unauthenticated ${protocols.join('/')} proxy origin`)
  }
  return parsed.origin
}

/**
 * Validate tuning before any build or network operation.
 * @param {NodeJS.ProcessEnv} environment File-owned packaging settings.
 * @returns {{packConcurrency: number, downloadProxy?: string, notarizationProxy?: string}} Resolved settings; empty proxy fields preserve inherited networking.
 */
export function resolveMacOSPackageSettings(environment) {
  const concurrency = environment.DSH_DESKTOP_MACOS_PACK_CONCURRENCY ?? '4'
  if (!/^[1-9]\d*$/u.test(concurrency) || !Number.isSafeInteger(Number(concurrency))) {
    throw new Error('desktop package: DSH_DESKTOP_MACOS_PACK_CONCURRENCY must be a positive integer')
  }
  return {
    packConcurrency: Number(concurrency),
    downloadProxy: proxy(environment, 'DSH_DESKTOP_MACOS_DOWNLOAD_PROXY', ['http:', 'https:']),
    notarizationProxy: proxy(environment, 'DSH_DESKTOP_MACOS_NOTARIZATION_PROXY', ['http:']),
  }
}

/**
 * Override proxy routing only in download-capable subprocesses, including Electron and pnpm.
 * @param {NodeJS.ProcessEnv} environment Parent environment, never mutated.
 * @param {string | undefined} proxyUrl Validated download proxy, or undefined to preserve inherited settings.
 * @returns {NodeJS.ProcessEnv} Child environment; explicit routing bypasses only local hosts.
 */
export function macOSDownloadEnvironment(environment, proxyUrl) {
  if (proxyUrl === undefined) return { ...environment }
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) =>
      !/^(?:(?:https?|all|no)_proxy|npm_config_(?:https?_proxy|proxy|noproxy)|ELECTRON_GET_USE_PROXY)$/iu.test(name))),
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    ELECTRON_GET_USE_PROXY: '1',
  }
}
