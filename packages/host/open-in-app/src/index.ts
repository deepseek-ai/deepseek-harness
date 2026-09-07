/**
 * Host half of open-in-app: three routes on the composition's `webServer`
 * serving the resolved application catalog, per-application icons, and the
 * launch endpoint the browser split button
 * (`@deepseek-ai/dsh-client-ui-open-in-app`) posts to.
 *
 * Security has one home, here. Every route asks the composition's
 * `connection` service for a rejection first (`requestRejection`): its
 * Host/Origin fence defeats DNS rebinding and cross-site calls, and its
 * browser authentication (the login-token cookie) gates every caller before
 * any resolution result, icon, or launch is reachable. On top of that fence
 * the open route validates its body at the wire: an `application/json` media
 * type, a 64 KiB ceiling, string `app`/`path` fields, a resolved-available
 * catalog id, and an absolute path naming an existing directory.
 *
 * The catalog resolves lazily, once per plugin life, on the first request
 * that needs it, into one map of verified launchers: the apps route serves
 * its keys and the open route launches its values, so a click, menu open, or
 * page reload never re-runs detection. A launch that finds its executable
 * gone (`ENOENT`) invalidates that one entry and re-resolves it once.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from './catalog.ts'
import {
  launchResolved, resolveLaunch, resolveOpenInAppApps,
  type OpenInAppInternals, type OpenInAppResolvedLaunch,
} from './resolver.ts'
import { extractAppIcon, type OpenInAppIcon } from './icons.ts'
import { internals } from './internals.ts'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_ICON_PREFIX, OPEN_IN_APP_OPEN_ROUTE,
} from './shared.ts'

export type * from './shared.ts'

/** Cordis function-plugin name. */
export const name = 'open-in-app'
/** The route carrier, the trust fence guarding every route, and the PATH resolver. */
export const inject = ['webServer', 'connection', 'subprocess']

/** Open-in-app host configuration. */
export interface Config {
  /**
   * Per-command deadline in milliseconds for catalog-resolution host
   * commands (`xcode-select`, the Windows registry reads).
   */
  readonly probeTimeoutMs: number
  /**
   * Per-command deadline in milliseconds for icon-extraction host commands
   * (`plutil`/`sips` on macOS, the PowerShell extraction on Windows).
   */
  readonly iconTimeoutMs: number
  /**
   * Early-failure watch window per launch, in milliseconds: a launcher still
   * running when the window closes counts as launched and keeps running, so
   * this bounds how long the open route holds a successful launch, not how
   * long an application may live.
   */
  readonly launchWatchMs: number
}

const boundedMs = (): z<number> => z.number().step(1).min(1).max(600_000).required()

export const Config: z<Config> = z.object({
  probeTimeoutMs: boundedMs(),
  iconTimeoutMs: boundedMs(),
  launchWatchMs: boundedMs(),
})

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface OpenInAppConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The composition's connection service (typed locally: its package is browser-side). */
function connectionOf(ctx: Context): OpenInAppConnection {
  return Reflect.get(ctx, 'connection') as OpenInAppConnection
}

/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** JSON response (no-store: availability and launch outcomes are live facts). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Validate one open-route body at the wire: JSON object with string app/path. */
function parseOpenBody(text: string): { app: string; path: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is exactly the null case.
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { app, path } = body as { app?: unknown; path?: unknown }
  return typeof app === 'string' && typeof path === 'string' ? { app, path } : null
}

/** Register the apps, icon, and open routes behind the connection trust fence. */
export function apply(ctx: Context, config: Config): void {
  /** Test-seam facts completed with the composition's PATH resolver. */
  const catalogInternals = (): OpenInAppInternals => ({
    resolveExecutable: async (name) => {
      try {
        return await ctx.subprocess.resolveExecutable(name)
      } catch {
        // Swallows the provider's not-found rejection: for detection, a name
        // that does not resolve has exactly one meaning — unavailable.
        return null
      }
    },
    ...internals.catalog,
  })
  /** Lazy once-per-plugin-life resolution; the map is the mutable authority. */
  let resolutions: Promise<Map<string, OpenInAppResolvedLaunch>> | undefined
  const availability = (): Promise<Map<string, OpenInAppResolvedLaunch>> =>
    resolutions ??= resolveOpenInAppApps(config.probeTimeoutMs, catalogInternals())
  /** Per-app icon promise cache (null = resolved as unavailable). */
  const icons = new Map<string, Promise<OpenInAppIcon | null>>()
  const iconOf = (app: OpenInAppApp, resolved: OpenInAppResolvedLaunch): Promise<OpenInAppIcon | null> => {
    let cached = icons.get(app.id)
    if (cached === undefined) {
      cached = extractAppIcon(app, resolved, config.iconTimeoutMs, catalogInternals())
      icons.set(app.id, cached)
    }
    return cached
  }
  /**
   * Replace one stale resolution after a missing-executable launch: the
   * entry (and its icon) re-resolves once; an entry that no longer resolves
   * leaves the map and the next apps read no longer offers it.
   */
  const refreshResolution = async (app: OpenInAppApp): Promise<OpenInAppResolvedLaunch | undefined> => {
    const map = await availability()
    const fresh = await resolveLaunch(app, config.probeTimeoutMs, catalogInternals())
    icons.delete(app.id)
    if (fresh === null) {
      map.delete(app.id)
      return undefined
    }
    map.set(app.id, fresh)
    return fresh
  }
  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connectionOf(ctx).requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_APPS_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, { apps: [...(await availability()).keys()] })
    },
  }), `open-in-app: GET ${OPEN_IN_APP_APPS_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: OPEN_IN_APP_ICON_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      // Node always sets url on server requests; String keeps that fact local.
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      const id = pathname.slice(OPEN_IN_APP_ICON_PREFIX.length).replace(/^\//, '')
      const noIcon = (): void => { sendJson(res, 404, { code: 'not-found', message: `no icon for ${id}` }) }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === id)
      if (app === undefined) {
        noIcon()
        return
      }
      const resolved = (await availability()).get(app.id)
      if (resolved === undefined) {
        noIcon()
        return
      }
      const icon = await iconOf(app, resolved)
      if (icon === null) {
        noIcon()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', icon.contentType)
      res.setHeader('cache-control', 'public, max-age=3600')
      res.end(icon.bytes)
    },
  }), `open-in-app: GET ${OPEN_IN_APP_ICON_PREFIX}/<id>`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_OPEN_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      // Body-format validation: the essence must be exactly application/json.
      // String(undefined) is 'undefined', which never matches.
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text: string | null
      try {
        text = await readBoundedBody(req)
      } catch {
        // Swallows connection errors mid-body: there is nothing left to answer precisely.
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const parsed = parseOpenBody(text)
      if (parsed === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with string "app" and "path"' })
        return
      }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === parsed.app)
      const resolved = app === undefined ? undefined : (await availability()).get(app.id)
      if (app === undefined || resolved === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: `unknown or unavailable app: ${parsed.app}` })
        return
      }
      if (parsed.path === '' || !isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' })
        return
      }
      let directory: boolean
      try {
        directory = (await stat(parsed.path)).isDirectory()
      } catch {
        // Swallows ENOENT/EACCES: both mean there is no directory to open.
        directory = false
      }
      if (!directory) {
        sendJson(res, 404, { code: 'not-found', message: `directory does not exist: ${parsed.path}` })
        return
      }
      let outcome = await launchResolved(resolved, parsed.path, config.launchWatchMs, catalogInternals())
      if (outcome === 'missing') {
        // The verified launcher is gone (uninstalled since resolution):
        // refresh this one entry and retry once with the fresh launcher.
        const fresh = await refreshResolution(app)
        outcome = fresh === undefined
          ? 'failed'
          : await launchResolved(fresh, parsed.path, config.launchWatchMs, catalogInternals())
      }
      if (outcome === 'launched') {
        sendJson(res, 200, { ok: true })
      } else {
        sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${app.id}` })
      }
    },
  }), `open-in-app: POST ${OPEN_IN_APP_OPEN_ROUTE}`)
}
