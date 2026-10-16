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
 * instances exercised over the Worker filesystem implementation. The same
 * page then proves the boot is the served profile boot: the Plugins page lists
 * the installation's optional bundles, enabling one applies its patch layer
 * after the base layers, and a page chunk's lazy archive is fetched only when
 * that chunk is requested.
 *
 * The site is served the way a static host serves it: bytes from `dist/` with
 * no rewrite rules, so a missing file is a 404 rather than the index page.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { expect, it } from 'vitest'
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import {
  packPreviewFixture, packRepositoryImage, previewFixtures, WRAPPER_CONTRACT,
} from '@deepseek-ai/dsh-experimental-webworker-packer'
import {
  IMAGE_FILE_NAME, IMAGE_MANIFEST_PATH, parseImageManifest, parseTar, PREVIEW_FIXTURE_MANIFEST_FILE,
  PREVIEW_FIXTURE_MANIFEST_VERSION, type ImageManifest, type PreviewFixtureManifest,
} from '@deepseek-ai/dsh-experimental-webworker-runtime'
import {
  VFS_EXAMPLE_SESSION_IDS,
  VFS_EXAMPLE_REASONING,
  VFS_EXAMPLE_WRAPPED_COMMAND,
  buildVfsExampleFiles,
} from '../../../packages/experimental/webworker-runtime/tests/vfs-example-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

/** Where the client looks for the image: the runtime's own name, beside the page. */
const IMAGE_FILE = join(DIST_ROOT, 'preview', IMAGE_FILE_NAME)

/** Keyless browser golden for the pre-Worker source chooser. */
const SOURCE_CHOOSER_EXPECTED = fileURLToPath(new URL('./snapshots/preview-boot/source-chooser.expected.md', import.meta.url))

const SNAPSHOT_MODE = webSnapshotMode()

/** Profile the preview deployment composes; `build:preview` packs the same one. */
const PROFILE = 'web'

/** Optional bundle whose patch layer disables a base row and inserts its replacement. */
const SESSION_TITLES_BUNDLE = '@deepseek-ai/dsh-experimental-session-titles-bundle'
const BASE_TITLE_MODULE = '@deepseek-ai/dsh-session-title-first-prompt-llm'
const BUNDLE_TITLE_MODULE = '@deepseek-ai/dsh-session-title-all-prompts-llm'
const INSPECTOR_BUNDLE = '@deepseek-ai/dsh-experimental-inspector-profile'
const INSPECTOR_MODULE = '@deepseek-ai/dsh-experimental-inspector'
const SESSION_INSPECTOR_MODULE = '@deepseek-ai/dsh-experimental-session-inspector'

/** Package whose terminal chunk the page requests through `require.async`. */
const TERMINAL_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
const TERMINAL_CHUNK = `node_modules/${TERMINAL_PACKAGE}/lib/client.terminal.js`

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
  /** Every static-host-relative path requested so far, page and Worker alike. */
  readonly served: readonly string[]
  /** Release the port; call after the browser is gone. */
  close(): Promise<void>
}

interface PreviewAssets {
  /** Static-host-relative path to a generated file outside `dist/`. */
  readonly overrides: ReadonlyMap<string, string>
  /** Manifest of the base image the site serves. */
  readonly manifest: ImageManifest
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
 * overlay retains its committed Session generations, prepares current successors
 * through the Node catalog, and supplies the generator-owned current projection cache.
 * Generated files land in a temp
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
  let image: Uint8Array
  if (existsSync(IMAGE_FILE)) {
    image = readFileSync(IMAGE_FILE)
  } else {
    const packed = packRepositoryImage(REPO_ROOT, PROFILE)
    if (packed.missing.length > 0) {
      throw new Error(`preview boot: ${String(packed.missing.length)} dependencies did not resolve: ${packed.missing.join(', ')}`)
    }
    image = packed.image
    writeAsset(`preview/${IMAGE_FILE_NAME}`, packed.image)
    for (const archive of packed.lazyArchives) writeAsset(`preview/${archive.name}`, archive.image)
  }
  const manifestEntry = parseTar(gunzipSync(image)).find(entry => entry.name === IMAGE_MANIFEST_PATH)
  if (manifestEntry === undefined) throw new Error('preview boot: the base image carries no manifest')
  const manifest = parseImageManifest(JSON.parse(new TextDecoder().decode(manifestEntry.bytes)), IMAGE_MANIFEST_PATH)
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
    writeAsset(relativePath, packPreviewFixture(trees).image)
    return {
      id: fixture.id,
      label: fixture.label,
      description: fixture.description,
      overlays: [`fixtures/${fixture.id}.tar.gz`],
    }
  })
  const fixtureManifest: PreviewFixtureManifest = {
    version: PREVIEW_FIXTURE_MANIFEST_VERSION,
    defaultFixture: fixtures[0]?.id ?? null,
    fixtures,
  }
  writeAsset(`preview/${PREVIEW_FIXTURE_MANIFEST_FILE}`, `${JSON.stringify(fixtureManifest, null, 2)}\n`)
  return { overrides, manifest, cleanup: () => { rmSync(directory, { recursive: true, force: true }) } }
}

/**
 * Answer one request with its generated override or the file under `dist/`.
 * @param request - Incoming request; only its path is read.
 * @param response - Response to write the bytes or the 404 to.
 * @param overrides - Generated deployment files served before `dist/`.
 * @param served - Request log the site appends every static-host-relative path to.
 */
async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  overrides: ReadonlyMap<string, string>,
  served: string[],
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const relative = normalize(decodeURIComponent(path)).replace(/^\/+/, '')
  served.push(relative)
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
  const served: string[] = []
  const server = createServer((request, response) => { void respond(request, response, overrides, served) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('preview boot: the static server bound no port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    served,
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
        await bootPreview(site, assets.manifest, browser)
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
 * @param site - Site serving `dist/`, with its request log.
 * @param manifest - Manifest of the base image the site serves.
 * @param browser - Browser to open the page in.
 */
async function bootPreview(site: Site, manifest: ImageManifest, browser: Browser): Promise<void> {
  const { origin } = site
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
    await page.getByRole('button', { name: 'Add API Key', exact: true }).click()
    const configureLater = page.getByRole('button', { name: 'Configure later' })
    await configureLater.waitFor({ timeout: 30_000 })
    await configureLater.click()
    await page.locator('[data-composer-input][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]')
      .waitFor({ timeout: 30_000 })

    const exercised = await page.evaluate(async ({ seededSessionId, seededSessionTitle }) => {
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
      // Keep the fixture title stable for later UI assertions; increasing seqs
      // prove that the cold Session acquired its write lease and appended.
      const firstRename = await remote<{ title: string; seq: number }>('session/rename', {
        request: { sessionId: seededSessionId, title: seededSessionTitle },
      })
      const secondRename = await remote<{ title: string; seq: number }>('session/rename', {
        request: { sessionId: seededSessionId, title: seededSessionTitle },
      })
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
      interface Setting { ns: string; revision: number; value: Record<string, unknown>; user: Record<string, unknown> }
      const settings = await remote<{ writable: boolean; namespaces: Setting[] }>(
        'settings/describe', {},
      )
      const shell = settings.namespaces.find(namespace => namespace.ns === 'bash-sandbox')
      if (shell === undefined) throw new Error('settings/describe omitted the bash-sandbox namespace')
      const saved = await remote<Setting>('settings/update', {
        ns: 'bash-sandbox',
        patch: { timeoutMs: 61_000 },
        expectedRevision: shell.revision,
      })
      const reread = await remote<{ namespaces: Setting[] }>('settings/describe', {})
      const reset = await remote<Setting>('settings/mutate', {
        ns: 'bash-sandbox', ops: [{ op: 'unset', path: ['timeoutMs'] }], expectedRevision: saved.revision,
      })
      await remote('settings/update', { ns: 'ui-theme', patch: { fontSize: 17 } })
      await remote('credentials/set', { ref: 'PREVIEW_TEST_SECRET', value: 'worker-only' })
      const credentials = await remote<Record<string, { configured: boolean }>>(
        'credentials/describe',
        { refs: ['PREVIEW_TEST_SECRET'] },
      )
      await remote('credentials/unset', { ref: 'PREVIEW_TEST_SECRET' })
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      return {
        settingsWritable: settings.writable,
        settingIds: settings.namespaces.map(namespace => namespace.ns),
        savedTimeout: saved.value.timeoutMs,
        rereadTimeout: reread.namespaces.find(namespace => namespace.ns === 'bash-sandbox')?.value.timeoutMs,
        resetTimeout: reset.value.timeoutMs,
        initialTimeout: shell.value.timeoutMs,
        resetOverrides: reset.user,
        renamedTitle: secondRename.title,
        renameAdvanced: secondRename.seq > firstRename.seq,
        skillCount: skills.skills.length,
        credentialConfigured: credentials.PREVIEW_TEST_SECRET?.configured,
      }
    }, {
      seededSessionId: VFS_EXAMPLE_SESSION_IDS.main,
      seededSessionTitle: SHOWCASE_TITLE,
    })
    expect(exercised.settingsWritable).toBe(true)
    expect(exercised.settingIds).toEqual(expect.arrayContaining([
      'bash-sandbox', 'locale', 'ui-theme', 'ui-chat', 'ui-conversation', 'ui-settings', 'ui-settings-general',
    ]))
    expect(exercised.savedTimeout).toBe(61_000)
    expect(exercised.rereadTimeout).toBe(61_000)
    expect(exercised.resetTimeout).toBe(exercised.initialTimeout)
    expect(exercised.resetOverrides).not.toHaveProperty('timeoutMs')
    await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
      .toBe('17px')
    expect(exercised.renamedTitle).toBe(SHOWCASE_TITLE)
    expect(exercised.renameAdvanced).toBe(true)
    expect(exercised.skillCount).toBeGreaterThan(0)
    expect(exercised.credentialConfigured).toBe(true)

    const sessions = page.getByRole('tree', { name: 'Sessions' })
    const showcase = sessions.getByRole('treeitem').filter({ hasText: SHOWCASE_TITLE })
    await expect.poll(() => showcase.count(), { timeout: 15_000 }).toBe(1)
    // The packed deployment ships the Schedule rows, and the preview storage
    // seeds the showcase Session with active tasks.
    expect(await showcase.locator('[data-session-schedule-mark]').count()).toBe(1)
    await showcase.click()
    await page.getByText(SHOWCASE_TAIL, { exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-schedule-reminder-entry]').count()).toBe(1)

    expect(await page.getByText(SHOWCASE_OLDEST, { exact: true }).count()).toBe(0)
    // Complete Turns can fold while earlier history is still unloaded.
    const readTool = page.locator('[data-chat-call-id="preview-read"]')
    await readTool.waitFor({ state: 'attached' })
    expect(await readTool.isVisible()).toBe(false)
    await expandOwningTurnProcess(page, readTool)
    await page.getByRole('button', { name: 'PREVIEW.md', exact: true }).waitFor()
    await page.getByRole('button', { name: 'src/preview.ts', exact: true }).waitFor()
    await page.getByText('Update to-do list', { exact: true }).waitFor()
    await page.getByText('Error: ENOENT: no such file, open missing.txt', { exact: true }).waitFor()

    const reasoning = page.locator('[data-variant="think"]')
    await expect.poll(() => reasoning.count()).toBe(VFS_EXAMPLE_REASONING.length)
    for (const [index, text] of VFS_EXAMPLE_REASONING.entries()) {
      const row = reasoning.nth(index)
      await row.getByRole('button').click()
      await row.getByText(text.split('\n\n').at(-1)!, { exact: true }).waitFor({ state: 'visible' })
    }

    const wrappedCall = page.locator('[data-chat-call-id="preview-wrapped-bash"]')
    await wrappedCall.locator('[data-sample="bash"]').click()
    const terminal = wrappedCall.locator('[data-terminal]')
    const originalWidth = await terminal.evaluate(element => element.style.width)
    try {
      await terminal.evaluate((element) => { element.style.width = '380px' })
      const commands = terminal.locator('[data-command-text]')
      expect(await commands.allTextContents()).toEqual(VFS_EXAMPLE_WRAPPED_COMMAND.slice(0, -1).split('\n'))
      await commands.first().scrollIntoViewIfNeeded()
      const geometry = await commands.first().evaluate((element) => {
        const prompt = element.parentElement!
        const header = element.closest('[class*="_header_"]')!
        header.scrollTop = 0
        const dot = prompt.querySelector('[data-state="done"]')
        if (dot === null) throw new Error('wrapped preview command has no successful status dot')
        const range = document.createRange()
        range.selectNodeContents(element)
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
        const marker = dot.getBoundingClientRect()
        const viewport = header.getBoundingClientRect()
        return {
          wrapped: new Set(lines.map(rect => Math.round(rect.top))).size > 1,
          whitespace: getComputedStyle(element).whiteSpace,
          alignmentError: Math.abs(marker.top + marker.height / 2
            - (prompt.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(prompt).lineHeight) / 2)),
          visible: marker.top >= viewport.top && marker.bottom <= viewport.bottom,
        }
      })
      expect(geometry.wrapped).toBe(true)
      expect(geometry.whitespace).toBe('pre-wrap')
      expect(geometry.alignmentError).toBeLessThanOrEqual(1)
      expect(geometry.visible).toBe(true)
      expect(await terminal.locator('[data-state="done"]').count()).toBe(1)
    } finally {
      await terminal.evaluate((element, width) => { element.style.width = width }, originalWidth)
    }

    await page.getByRole('button', { name: 'Parent workspace guide:1–8', exact: true }).click()
    const preview = page.locator('[data-rightbar-col]')
    await expect.poll(() => preview.locator('[data-textpreview-path]').textContent()).toBe('/dsh/workspace/PREVIEW.md')
    await preview.getByRole('heading', { name: 'Preview Workspace', exact: true }).waitFor({ state: 'visible' })
    expect(await preview.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['PREVIEW.md'])

    const subagents = page.getByRole('button', { name: '2 subagents', exact: true })
    await subagents.waitFor({ timeout: 15_000 })
    await subagents.hover()
    const catalog = page.getByRole('tree', { name: 'Subagent sessions' })
    await catalog.getByRole('treeitem', { name: /Review preview architecture/ }).waitFor()
    await catalog.getByRole('treeitem', { name: /Continue preview verification/ }).waitFor()
    await catalog.press('Escape')

    await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await page.getByText(SHOWCASE_OLDEST, { exact: true }).waitFor({ timeout: 15_000 })

    await requestLazyChunk(page, site, manifest)
    await toggleOptionalBundles(page)
    await openSessionInspector(page)
    expect(pageErrors.map(error => error.message)).toEqual([])
    expect(consoleErrors.filter(line =>
      /watchFile|failed to watch|node-addon-system\.probe|sandbox backend is usable|SANDBOX_UNAVAILABLE|cannot be nested|config reload at/i
        .test(line))).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'preview-boot')
    throw pageErrors.length === 0
      ? error
      : new AggregateError([error, ...pageErrors], 'preview boot failed, with uncaught page errors')
  }
}

/**
 * Request the terminal chunk through the page's tunnel and prove its lazy
 * archive is fetched then, once, and not before.
 * @param page - Booted preview page.
 * @param site - Site whose request log records Worker fetches too.
 * @param manifest - Manifest naming the chunk's archive.
 */
async function requestLazyChunk(page: Page, site: Site, manifest: ImageManifest): Promise<void> {
  const archive = manifest.lazy.find(entry => entry.files.some(file => file.path === TERMINAL_CHUNK))?.archive
  if (archive === undefined) throw new Error(`preview boot: the image registers no lazy archive for ${TERMINAL_CHUNK}`)
  const fetched = (): number => site.served.filter(path => path === `preview/${archive}`).length
  expect(fetched()).toBe(0)
  const chunk = await page.evaluate(async ({ id }) => {
    const transport = (globalThis as typeof globalThis & {
      __DSH_TRANSPORT__?: { fetch(input: string, init: RequestInit): Promise<Response> }
      __DSH_BOOT__?: { entries: Array<{ id: string; rev: string }> }
    })
    const row = transport.__DSH_BOOT__?.entries.find(entry => entry.id === id)
    if (transport.__DSH_TRANSPORT__ === undefined || row === undefined) throw new Error(`no boot graph row for ${id}`)
    const results: Array<{ status: number; size: number }> = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await transport.__DSH_TRANSPORT__.fetch(`/plugins/${id}/client.terminal.js?rev=${row.rev}`, { method: 'GET' })
      results.push({ status: response.status, size: (await response.text()).length })
    }
    return results
  }, { id: TERMINAL_PACKAGE })
  expect(chunk.map(result => result.status)).toEqual([200, 200])
  expect(chunk[0]!.size).toBeGreaterThan(0)
  // Two chunk requests, one archive fetch: the Worker filesystem keeps what arrived.
  expect(fetched()).toBe(1)
}

/**
 * Open the Plugins page, prove every optional bundle and installed plugin reads
 * its metadata, then switch each optional bundle on and off. Both changes apply
 * live; the session-titles layer applies after the base layers, and the
 * Inspector bundle runs Session Inspector without the NodeJS Inspector Worker.
 * @param page - Booted preview page.
 */
async function toggleOptionalBundles(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const cards = panel.locator('[data-plugin-group="extensions"] [data-plugin-package]')
  await cards.first().waitFor({ timeout: 30_000 })
  const listed = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-plugin-package')))
  expect(listed.filter(name => name !== null && OPTIONAL_BUNDLES.includes(name)).length).toBeGreaterThan(0)
  const result = await page.evaluate(async () => {
    type Result<T> = { result: { ok: true; value: T } | { ok: false; error: { message: string } } }
    const transport = (globalThis as typeof globalThis & {
      __DSH_TRANSPORT__?: { fetch(input: string, init: RequestInit): Promise<Response> }
    }).__DSH_TRANSPORT__
    if (transport === undefined) throw new Error('preview transport is absent after boot')
    const remote = async <T>(endpoint: string, args: object): Promise<T> => {
      const answered = await transport.fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `preview-${endpoint.replace('/', '-')}`, method: endpoint, payload: { args } }),
      })
      const body = await answered.json() as Result<T>
      if (!body.result.ok) throw new Error(`${endpoint} failed: ${body.result.error.message}`)
      return body.result.value
    }
    interface Bundle {
      name: string
      optional: boolean
      enabled: boolean
      availability: string
      error?: unknown
      meta?: { title?: unknown; icon?: unknown; error?: unknown }
    }
    interface Plugin { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }
    interface Inventory { entries: Array<{ moduleName: string; meta?: { error?: unknown } }> }
    const bundles = await remote<Bundle[]>('pluginManager/listBundles', {})
    const inventory = await remote<Inventory>('pluginInventory/list', {})
    const stateOf = (plugin: Plugin): string => `${plugin.moduleName} ${String(plugin.enabled)} ${String(plugin.fiberPhase)}`
    const rowsOf = (plugins: Plugin[]): string[] => plugins.map(plugin => `${plugin.entryId} ${stateOf(plugin)}`).sort()
    const baseline = await remote<Plugin[]>('pluginManager/listPlugins', {})
    const before = new Map(baseline.map(plugin => [plugin.entryId, stateOf(plugin)]))
    const toggles: Array<{
      name: string
      enable: string
      disable: string
      error: unknown
      plugins: Plugin[]
      changed: number
      inactive: string[]
      restored: boolean
    }> = []
    for (const entry of bundles.filter(candidate => candidate.optional)) {
      const enable = await remote<{ application: string; error?: unknown }>('pluginManager/setBundleEnabled', { name: entry.name, enabled: true })
      const plugins = await remote<Plugin[]>('pluginManager/listPlugins', {})
      const disable = await remote<{ application: string }>('pluginManager/setBundleEnabled', { name: entry.name, enabled: false })
      const after = await remote<Plugin[]>('pluginManager/listPlugins', {})
      const changed = plugins.filter(plugin => before.get(plugin.entryId) !== stateOf(plugin))
      toggles.push({
        name: entry.name,
        enable: enable.application,
        disable: disable.application,
        error: enable.error ?? null,
        plugins,
        changed: changed.length,
        inactive: changed.filter(plugin => plugin.enabled && plugin.fiberPhase !== 'active').map(stateOf),
        restored: JSON.stringify(rowsOf(after)) === JSON.stringify(rowsOf(baseline)),
      })
    }
    return {
      optional: bundles.filter(entry => entry.optional).map(entry => ({
        name: entry.name, enabled: entry.enabled, availability: entry.availability, error: entry.error ?? null,
        title: typeof entry.meta?.title, icon: typeof entry.meta?.icon, metaError: entry.meta?.error ?? null,
      })),
      inventoryErrors: inventory.entries.filter(row => row.meta?.error !== undefined)
        .map(row => ({ moduleName: row.moduleName, error: row.meta?.error })),
      toggles,
    }
  })
  expect(result.optional.map(entry => entry.name).sort()).toEqual([...OPTIONAL_BUNDLES].sort())
  expect(result.optional.filter(entry => entry.enabled || entry.availability !== 'installation' || entry.error !== null)).toEqual([])
  // Metadata resolves through the Worker's Node internal modules: every optional bundle shows its title and icon.
  expect(result.optional.filter(entry => entry.metaError !== null || entry.title !== 'object' || entry.icon !== 'string')).toEqual([])
  expect(result.inventoryErrors).toEqual([])
  console.info(`preview boot: optional bundle toggles ${JSON.stringify(result.toggles.map(({ name, enable, disable, error }) => ({ name, enable, disable, error })))}`)
  expect(result.toggles.filter(toggle => toggle.enable !== 'applied' || toggle.disable !== 'applied')
    .map(({ name, enable, disable }) => ({ name, enable, disable }))).toEqual([])
  // Each bundle changes Loader rows, every enabled row it changes runs, and switching it off restores the prior rows.
  expect(result.toggles.filter(toggle => toggle.changed === 0 || toggle.inactive.length > 0 || !toggle.restored)
    .map(({ name, changed, inactive, restored }) => ({ name, changed, inactive, restored }))).toEqual([])
  const pluginsWith = (bundle: string): Array<{ moduleName: string; enabled: boolean; fiberPhase: string | null }> =>
    result.toggles.find(toggle => toggle.name === bundle)?.plugins ?? []
  // The bundle layer applies after the base layers: its disable of the base title row takes effect.
  expect(pluginsWith(SESSION_TITLES_BUNDLE).filter(plugin => plugin.moduleName === BASE_TITLE_MODULE).map(plugin => plugin.enabled))
    .toEqual([false])
  expect(pluginsWith(SESSION_TITLES_BUNDLE).filter(plugin => plugin.moduleName === BUNDLE_TITLE_MODULE).map(plugin => plugin.enabled))
    .toEqual([true])
  // Session Inspector runs; NodeJS Inspector starts without its Worker on this platform.
  const inspectorRows = pluginsWith(INSPECTOR_BUNDLE)
    .filter(plugin => plugin.moduleName === SESSION_INSPECTOR_MODULE || plugin.moduleName === INSPECTOR_MODULE)
    .map(({ moduleName, enabled, fiberPhase }) => ({ moduleName, enabled, fiberPhase }))
  expect(inspectorRows.sort((a, b) => a.moduleName.localeCompare(b.moduleName)))
    .toEqual([
      { moduleName: INSPECTOR_MODULE, enabled: true, fiberPhase: 'active' },
      { moduleName: SESSION_INSPECTOR_MODULE, enabled: true, fiberPhase: 'active' },
    ])
}

/**
 * Switch one bundle through the page's tunnel.
 * @param page - Booted preview page.
 * @param bundle - Bundle package name.
 * @param enabled - Requested state.
 * @returns The plugin manager's application result.
 */
async function setBundle(page: Page, bundle: string, enabled: boolean): Promise<string> {
  return await page.evaluate(async ({ name, enabled }) => {
    const transport = (globalThis as typeof globalThis & {
      __DSH_TRANSPORT__?: { fetch(input: string, init: RequestInit): Promise<Response> }
    }).__DSH_TRANSPORT__
    if (transport === undefined) throw new Error('preview transport is absent after boot')
    const answered = await transport.fetch('/api/pluginManager/setBundleEnabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'preview-set-bundle', method: 'pluginManager/setBundleEnabled', payload: { args: { name, enabled } },
      }),
    })
    type Answer = { result: { ok: true; value: { application: string } } | { ok: false; error: { message: string } } }
    const body = await answered.json() as Answer
    if (!body.result.ok) throw new Error(`setBundleEnabled failed: ${body.result.error.message}`)
    return body.result.value.application
  }, { name: bundle, enabled })
}

/**
 * Enable the Inspector bundle and open Session Inspector from the right sidebar: the page learns of the new Client
 * plugin through the tunnel's event stream, without a reload.
 * @param page - Booted preview page.
 */
async function openSessionInspector(page: Page): Promise<void> {
  expect(await setBundle(page, INSPECTOR_BUNDLE, true)).toBe('applied')
  await page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').filter({ hasText: SHOWCASE_TITLE }).click()
  await page.getByText(SHOWCASE_TAIL, { exact: true }).waitFor({ timeout: 30_000 })
  // The showcase opens with a file tab in the right sidebar; a new tab shows the guide entries.
  await page.getByRole('button', { name: 'New tab', exact: true }).click()
  await page.locator('[data-sidebar-right-guide-entry="session-inspector-log"]').click({ timeout: 30_000 })
  await page.getByRole('table', { name: 'Raw Log', exact: true }).waitFor({ timeout: 15_000 })
  expect(await setBundle(page, INSPECTOR_BUNDLE, false)).toBe('applied')
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
    // One accepted static-host 404: the open-in-app availability read has no
    // host routes — the controller publishes an empty list and the header
    // renders no button, which is that surface's designed degradation. The
    // client graph event stream travels through the tunnel.
    expect([...failedResponses]).toEqual(['/open-in-app/apps'])
    // HMR recomposes configuration against the Worker's empty ES module cache without asking for a restart.
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
