/**
 * Preview acceptance: the browser-only worker deployment boots the real Cordis
 * tree out of the packed VFS image and reaches an interactive page.
 *
 * `dist/preview.html` is the served page plus one bootstrap script tag, so this
 * run exercises the shipped startup chain: the worker mounts the image,
 * activates the tree, and answers the page's tunnel until the client settles.
 * Two milestones prove that happened — the host's `tree active` boot line,
 * whose lowering contract must be the one this checkout's packer emits, and the
 * workspace hero, which paints only after the client tree comes up over the
 * tunnel. The same page opens the seeded Workspace and showcase Session,
 * verifies its tool/subagent/history examples, then writes through the
 * settings and credentials providers. That keeps the upstream Chokidar
 * instances exercised over the Worker filesystem implementation.
 *
 * The site is served the way a static host serves it: bytes from `dist/` with
 * no rewrite rules, so a missing file is a 404 rather than the index page.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { expect, it } from 'vitest'
import {
  composeProfile, configTrees, indexWorkspacePackages, packVfsImage, packVfsOverlay,
  previewFixtures, WRAPPER_CONTRACT,
} from '@deepseek-ai/dsh-experimental-webworker-packer'
import {
  IMAGE_FILE_NAME, PREVIEW_FIXTURE_MANIFEST_FILE, PREVIEW_FIXTURE_MANIFEST_VERSION,
  type PreviewFixtureManifest,
} from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { buildVfsExampleFiles } from '../../../packages/experimental/webworker-runtime/tests/vfs-example-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

/** Where the client looks for the image: the runtime's own name, beside the page. */
const IMAGE_FILE = join(DIST_ROOT, 'preview', IMAGE_FILE_NAME)

/** Keyless browser golden for the pre-Worker source chooser. */
const SOURCE_CHOOSER_EXPECTED = fileURLToPath(new URL('./snapshots/preview-boot/source-chooser.expected.md', import.meta.url))

const SNAPSHOT_MODE = webSnapshotMode()

/** Profile the preview deployment composes; `build:preview` packs the same one. */
const PROFILE = 'web'

/** Stable labels authored by the deterministic VFS example fixture. */
const SHOWCASE_TITLE = 'WebWorker Preview Showcase'
const SHOWCASE_TAIL = 'Preview tour complete'
const SHOWCASE_OLDEST = 'History checkpoint 01: verify deterministic preview state.'

/** Pages the preview needs; the Vite build emits both. */
const PAGES = ['index.html', 'preview.html']

/**
 * Content types the preview loads. Anything else is served as opaque bytes.
 *
 * The image goes out as `application/gzip` with no `content-encoding`: the
 * worker inflates the gzip member itself, so a transport-decoded body would
 * leave its `DecompressionStream('gzip')` with plain tar bytes to inflate.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Boot line the worker host writes once its tree finished activating. */
const TREE_ACTIVE = 'webworker host: tree active'

/** Image fetch, mount, and tree activation on a loaded machine. */
const BOOT_TIMEOUT_MS = 240_000

/** Client tree settle after the tunnel starts answering. */
const HERO_TIMEOUT_MS = 240_000

/** One served origin over `dist/`. */
interface Site {
  readonly origin: string
  /** Release the port; call after the browser is gone. */
  close(): Promise<void>
}

interface PreviewAssets {
  /** Static-host-relative path to a generated file outside `dist/`. */
  readonly overrides: ReadonlyMap<string, string>
  cleanup(): void
}

/**
 * Fail before the browser opens a page the build never produced.
 * @throws When either preview page is missing from `dist/`.
 */
function requirePreviewPages(): void {
  for (const page of PAGES) {
    if (existsSync(join(DIST_ROOT, page))) continue
    throw new Error(`preview boot needs apps/web/dist/${page} — run \`pnpm run build\` from the repository root`)
  }
}

/**
 * The base image, fixture manifest, and overlays to serve. `pnpm run build`
 * emits the pages but only `build:preview` packs the image, so this lane packs
 * a missing image rather than skipping the deployment it accepts. The example
 * overlay pairs its committed Session generations with the generator-owned
 * current projection cache. The worker therefore exercises historical reads
 * without relying on a stale cache schema. Generated files land in a temp
 * directory, never in `dist/`: the
 * client-artifact digest record treats `dist/` as build-owned, so a test write
 * there fails the record check for every later consumer.
 * @returns Static-path overrides and their teardown.
 * @throws When the closure leaves dependencies unresolved, which would pack an
 * incomplete image the tree fails on later and further from the cause.
 */
function requireVfsAssets(): PreviewAssets {
  const fixtureDefinitions = previewFixtures(REPO_ROOT)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-preview-boot-'))
  const overrides = new Map<string, string>()
  const writeAsset = (relativePath: string, bytes: Uint8Array | string): void => {
    const path = join(directory, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
    overrides.set(relativePath, path)
  }
  if (!existsSync(IMAGE_FILE)) {
    const packed = packVfsImage({
      config: composeProfile(REPO_ROOT, PROFILE),
      profile: PROFILE,
      workspaces: indexWorkspacePackages(REPO_ROOT),
      resolveFrom: REPO_ROOT,
      configTrees: configTrees(REPO_ROOT),
    })
    if (packed.missing.length > 0) {
      throw new Error(`preview boot: ${String(packed.missing.length)} dependencies did not resolve: ${packed.missing.join(', ')}`)
    }
    writeAsset(`preview/${IMAGE_FILE_NAME}`, packed.image)
  }
  const currentCache = buildVfsExampleFiles().get('home/storages/session_projcache.json')
  if (currentCache === undefined) throw new Error('preview boot: generated example has no projection cache')
  const cacheDirectory = join(directory, 'current-projection-cache')
  mkdirSync(cacheDirectory, { recursive: true })
  writeFileSync(join(cacheDirectory, 'session_projcache.json'), currentCache)
  const fixtures = fixtureDefinitions.map((fixture) => {
    const relativePath = `preview/fixtures/${fixture.id}.tar.gz`
    const trees = fixture.id === 'vfs-example'
      ? [...fixture.trees, { mount: 'home/storages', directory: cacheDirectory }]
      : fixture.trees
    writeAsset(relativePath, packVfsOverlay(trees).image)
    return {
      id: fixture.id,
      label: fixture.label,
      description: fixture.description,
      overlays: [`fixtures/${fixture.id}.tar.gz`],
    }
  })
  const manifest: PreviewFixtureManifest = {
    version: PREVIEW_FIXTURE_MANIFEST_VERSION,
    defaultFixture: fixtures[0]?.id ?? null,
    fixtures,
  }
  writeAsset(`preview/${PREVIEW_FIXTURE_MANIFEST_FILE}`, `${JSON.stringify(manifest, null, 2)}\n`)
  return { overrides, cleanup: () => { rmSync(directory, { recursive: true, force: true }) } }
}

/**
 * Answer one request with its generated override or the file under `dist/`.
 * @param request - Incoming request; only its path is read.
 * @param response - Response to write the bytes or the 404 to.
 * @param overrides - Generated deployment files served before `dist/`.
 */
async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  overrides: ReadonlyMap<string, string>,
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const relative = normalize(decodeURIComponent(path)).replace(/^\/+/, '')
  try {
    const body = await readFile(overrides.get(relative) ?? join(DIST_ROOT, relative))
    response.writeHead(200, { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    // A miss is a miss: the deployment has no SPA fallback, and hiding one
    // behind the index page would make a broken asset URL look like a boot
    // failure.
    response.writeHead(404)
    response.end(`not found: ${relative}`)
  }
}

/**
 * Serve `dist/` over loopback with static-host semantics.
 * @param overrides - Generated deployment files used when `dist/` has none.
 * @returns The origin to navigate, and its teardown.
 */
async function serveDist(overrides: ReadonlyMap<string, string>): Promise<Site> {
  const server = createServer((request, response) => { void respond(request, response, overrides) })
  await new Promise<void>((listening) => { server.listen(0, '127.0.0.1', listening) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('preview boot: the static server bound no port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((closed, reject) => {
        server.close((error) => {
          if (error === undefined) closed()
          else reject(error)
        })
      })
    },
  }
}

/**
 * Bound one boot milestone so a stall names the milestone instead of surfacing
 * as the lane's generic test timeout.
 * @param work - The milestone to wait for.
 * @param ms - How long it may take.
 * @param stalled - Error message when it does not arrive in time.
 * @returns What `work` resolved to.
 */
async function within<T>(work: Promise<T>, ms: number, stalled: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(stalled)) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

it('boots the packed worker deployment to an interactive page', async () => {
  requirePreviewPages()
  const assets = requireVfsAssets()
  try {
    const site = await serveDist(assets.overrides)
    try {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      try {
        await bootEmptyPreview(site.origin, browser)
        await bootPreview(site.origin, browser)
      } finally {
        await browser.close()
      }
    } finally {
      await site.close()
    }
  } finally {
    assets.cleanup()
  }
}, 600_000)

/**
 * Open the preview page and hold it to both boot milestones.
 * @param origin - Origin serving `dist/`.
 * @param browser - Browser to open the page in.
 */
async function bootPreview(origin: string, browser: Browser): Promise<void> {
  const page = await newEnglishPage(browser)
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => { pageErrors.push(error) })
  // Registered before navigation: the worker reports its tree long before the
  // tunnel serves the client, so a listener added later would miss the line.
  const treeActive = new Promise<string>((reported) => {
    page.on('console', (message) => {
      const text = message.text()
      if (text.includes(TREE_ACTIVE)) reported(text)
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(text)
    })
  })
  try {
    await page.goto(`${origin}/preview.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Choose Preview data' }).waitFor()
    expect(await page.locator('input[name="preview-source"][value="vfs-example"]').isChecked()).toBe(true)
    expect(await page.getByText('Empty environment', { exact: true }).count()).toBe(1)
    expect(await page.getByText('WebFS directory', { exact: true }).count()).toBe(1)
    expect(await page.locator('input[name="preview-source"][value="webfs"]').isDisabled()).toBe(true)
    expect(await page.getByRole('textbox', { name: 'Choose workspace' }).count()).toBe(0)
    await compareOrRefreshGolden(
      SOURCE_CHOOSER_EXPECTED,
      await captureStableAria(page, '[data-preview-source-card]', '/__preview_no_workspace__'),
      SNAPSHOT_MODE,
    )
    await page.getByRole('button', { name: 'Start Preview' }).click()
    await page.getByText('Loading plugins…', { exact: true }).waitFor({ timeout: 10_000 })
    const bootLine = await within(treeActive, BOOT_TIMEOUT_MS, `preview boot: the worker never reported "${TREE_ACTIVE}"`)
    // The activated tree ran bodies lowered against the contract this
    // checkout's packer emits; a dist built before a contract change would
    // report the older one.
    expect(bootLine).toContain(`image lowering=${WRAPPER_CONTRACT}`)
    expect(bootLine).toContain('data overlays=1')
    // The versioned notice is the seeded preview's first stable interactive
    // surface after the startup chain completes over the tunnel.
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await continueButton.waitFor({ timeout: HERO_TIMEOUT_MS })
    await continueButton.click()
    const configureLater = page.getByRole('button', { name: 'Configure later' })
    await configureLater.waitFor({ timeout: 30_000 })
    await configureLater.click()
    await page.locator('[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]')
      .waitFor({ timeout: 30_000 })

    const exercised = await page.evaluate(async () => {
      type Result<T> = { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }
      interface PreviewTransport {
        fetch(input: string, init: RequestInit): Promise<Response>
      }
      const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: PreviewTransport }).__DSH_TRANSPORT__
      if (transport === undefined) throw new Error('preview transport is absent after boot')
      const response = await transport.fetch('/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'preview-session-list', method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      })
      const sessions = await response.json() as Result<{ items: Array<{ sessionId: string }> }>
      if (!sessions.result.ok) throw new Error(`session/list failed: ${sessions.result.error.message}`)
      const sessionId = sessions.result.value.items[0]?.sessionId
      if (sessionId === undefined) throw new Error('workspace adoption created no Session')

      // Remote namespaces answer over the same unary carrier; the args object
      // keys every wire parameter by its name.
      const remote = async <T>(endpoint: string, args: object): Promise<T> => {
        const answered = await transport.fetch(`/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: `preview-${endpoint.replace('/', '-')}`,
            method: endpoint, payload: { args },
          }),
        })
        const body = await answered.json() as Result<T>
        if (!body.result.ok) throw new Error(`${endpoint} failed: ${body.result.error.message}`)
        return body.result.value
      }
      const skills = await remote<{ skills: Array<{ name: string }> }>(
        'skills/list', { request: { sessionId } },
      )
      const createDirectory = async (path: string, name: string): Promise<void> => {
        await remote<string>('directoryPicker/createDirectory', { path, name })
        await new Promise((resolve) => { setTimeout(resolve, 250) })
        await remote<{ skills: Array<{ name: string }> }>(
          'skills/list', { request: { sessionId } },
        )
      }
      await createDirectory('/dsh/workspace/.agents/skills', 'runtime-created')
      // Settings and credentials both answer over the Remote carrier, so this
      // half of the sweep posts the generated endpoints directly like the
      // session read above.
      const settings = await remote<{ namespaces: { ns: string; revision: number }[] }>(
        'settings/describe', {},
      )
      const shell = settings.namespaces.find(namespace => namespace.ns === 'shell')
      if (shell === undefined) throw new Error('settings/describe omitted the shell namespace')
      await remote('settings/update', {
        ns: 'shell',
        patch: { timeoutMs: 61_000 },
        expectedRevision: shell.revision,
      })
      await remote('credentials/set', { ref: 'PREVIEW_TEST_SECRET', value: 'worker-only' })
      const credentials = await remote<Record<string, { configured: boolean }>>(
        'credentials/describe',
        { refs: ['PREVIEW_TEST_SECRET'] },
      )
      await remote('credentials/unset', { ref: 'PREVIEW_TEST_SECRET' })
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      return {
        skillCount: skills.skills.length,
        credentialConfigured: credentials.PREVIEW_TEST_SECRET?.configured,
      }
    })
    expect(exercised.skillCount).toBeGreaterThan(0)
    expect(exercised.credentialConfigured).toBe(true)

    const sessions = page.getByRole('tree', { name: 'Sessions' })
    const showcase = sessions.getByRole('treeitem').filter({ hasText: SHOWCASE_TITLE })
    await expect.poll(() => showcase.count(), { timeout: 15_000 }).toBe(1)
    await showcase.click()
    await page.getByText(SHOWCASE_TAIL, { exact: true }).waitFor({ timeout: 30_000 })

    expect(await page.getByText(SHOWCASE_OLDEST, { exact: true }).count()).toBe(0)
    await page.getByText('PREVIEW.md', { exact: true }).waitFor()
    await page.getByText('src/preview.ts', { exact: true }).waitFor()
    await page.getByText('Update to-do list', { exact: true }).waitFor()
    await page.getByText('Error: ENOENT: no such file, open missing.txt', { exact: true }).waitFor()

    const subagents = page.getByRole('button', { name: '2 subagents' })
    await subagents.waitFor({ timeout: 15_000 })
    await subagents.hover()
    const catalog = page.getByRole('tree', { name: 'Subagent sessions' })
    await catalog.getByRole('treeitem', { name: /Review preview architecture/ }).waitFor()
    await catalog.getByRole('treeitem', { name: /Continue preview verification/ }).waitFor()
    await catalog.press('Escape')

    await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await page.getByText(SHOWCASE_OLDEST, { exact: true }).waitFor({ timeout: 15_000 })
    expect(pageErrors.map(error => error.message)).toEqual([])
    expect(consoleErrors.filter(line =>
      /watchFile|failed to watch|node-addon-landlock-run\.probe|sandbox backend is usable|SANDBOX_UNAVAILABLE/i.test(line))).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'preview-boot')
    throw pageErrors.length === 0
      ? error
      : new AggregateError([error, ...pageErrors], 'preview boot failed, with uncaught page errors')
  }
}

/** Verify the chooser can boot the untouched base image and reach first-run UI. */
async function bootEmptyPreview(origin: string, browser: Browser): Promise<void> {
  const page = await newEnglishPage(browser)
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on('pageerror', (error) => { pageErrors.push(error) })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(new URL(response.url()).pathname)
  })
  const treeActive = new Promise<string>((reported) => {
    page.on('console', (message) => {
      const text = message.text()
      if (text.includes(TREE_ACTIVE)) reported(text)
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(text)
    })
  })
  try {
    await page.goto(`${origin}/preview.html?preview-fixture=none`, { waitUntil: 'domcontentloaded' })
    expect(await page.getByRole('heading', { name: '选择 Preview 数据源' }).count()).toBe(0)
    const bootLine = await within(
      treeActive,
      BOOT_TIMEOUT_MS,
      `empty preview boot: the worker never reported "${TREE_ACTIVE}"`,
    )
    expect(bootLine).toContain(`image lowering=${WRAPPER_CONTRACT}`)
    expect(bootLine).toContain('data overlays=0')
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: HERO_TIMEOUT_MS })
    const sessionCount = await page.evaluate(async () => {
      const transport = (globalThis as typeof globalThis & {
        __DSH_TRANSPORT__?: { fetch(input: string, init: RequestInit): Promise<Response> }
      }).__DSH_TRANSPORT__
      if (transport === undefined) throw new Error('empty preview transport is absent after boot')
      const response = await transport.fetch('/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'empty-preview-session-list', method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      })
      const body = await response.json() as {
        result: { ok: true; value: { items: unknown[] } } | { ok: false; error: { message: string } }
      }
      if (!body.result.ok) throw new Error(`empty session/list failed: ${body.result.error.message}`)
      return body.result.value.items.length
    })
    expect(sessionCount).toBe(0)
    expect(pageErrors.map(error => error.message)).toEqual([])
    expect(failedResponses).toEqual(['/plugins/events'])
    expect(consoleErrors.filter(line => !line.includes('Failed to load resource: the server responded with a status of 404')))
      .toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'preview-boot-empty')
    throw pageErrors.length === 0
      ? error
      : new AggregateError([error, ...pageErrors], 'empty preview boot failed, with uncaught page errors')
  } finally {
    await page.close()
  }
}
