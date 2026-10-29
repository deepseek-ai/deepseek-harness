/**
 * Test-only assembled viewer page: the owner's Web shell booted in-process with the Relay's carrier.
 *
 * A served viewer page is the owner's own `apps/web` document with the carrier script placed first.
 * This helper reproduces that page in jsdom without a build: it installs the carrier through
 * {@link installViewerCarrier}, then a module-loader facade, a test-local roster
 * ({@link VIEWER_PAGE_ROSTER}) registered as module-table factories, a forged `__DSH_BOOT__` graph
 * naming exactly those rows, and runs {@link AppWebEntry}. The forged boot graph and roster are test
 * infrastructure only: production pages receive the owner's real boot graph from the owner's Host.
 *
 * Generated `<package>/remote` faces exist only in built `lib/` output, so they are generated from
 * source here, and the Client entries that import them (the Remote assembly and the remote-access
 * plugin) are answered through `vi.doMock` before the roster is first imported.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/tests/viewer-page
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { installViewerCarrier } from '../../liveshare-protocol/src/viewer-carrier.ts'
import { act } from '@testing-library/react'
import { afterAll, vi } from 'vitest'
import type { ViewerPageRosterRow } from './viewer-page-roster.client.ts'
import { allocateViewerStaging, disposeViewerStaging } from './viewer-staging.client.ts'

const testsDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(testsDir, '../../../..')
/** Staging parent for generated faces; inside the workspace so their `zod` import resolves. */
const stagingParent = resolve(testsDir, '../lib')
/** Package whose Client plugin mounts its own generated Remote face rather than the assembly's. */
const REMOTE_ACCESS_PACKAGE = '@deepseek-ai/dsh-api-remote-access'
/** Read budget the carrier receives; production pages receive the Relay's configured value. */
const READ_TIMEOUT_MS = 30_000

/** Host-face module that writes the generated Remote faces; see viewer-remote-faces.ts. */
interface RemoteFaceGenerator {
  readonly generateViewerRemoteFaces: (workspaceRoot: string, dir: string) => ReadonlyMap<string, string>
}

let preparing: Promise<void> | undefined
let stagingDir: string | undefined

afterAll(() => {
  disposeViewerStaging(stagingDir, stagingParent)
  stagingDir = undefined
})

/**
 * Generate every Host package's `./remote` face from source, then answer the Remote assembly
 * (`@deepseek-ai/dsh-api-remotes/client`) and the self-mounting remote-access Client plugin
 * (`@deepseek-ai/dsh-api-remote-access/client`) with their own sources whose `/remote` imports name
 * the generated faces.
 * @returns Resolves once the faces are mocked for later dynamic imports.
 */
async function generateRemoteFaces(): Promise<void> {
  const dir = allocateViewerStaging(stagingParent, 'viewer-remote-faces-')
  stagingDir = dir
  // The generator is Host-face Node code, so this jsdom module loads it by path rather than by a
  // static import the client program would have to type.
  const generatorModule = join(testsDir, 'viewer-remote-faces.ts')
  const { generateViewerRemoteFaces } = await import(/* @vite-ignore */ generatorModule) as RemoteFaceGenerator
  const faces = generateViewerRemoteFaces(workspaceRoot, dir)
  const assembly = readFileSync(join(workspaceRoot, 'packages/api/remotes/src/client/index.ts'), 'utf8')
    .replace(/^(import \w+ from )'(@deepseek-ai\/[^']+)\/remote'$/gmu, (_line, head: string, name: string) => {
      const file = faces.get(name)
      if (file === undefined) throw new Error(`viewer page: no generated Remote face for ${name}`)
      return `${head}${JSON.stringify(file)}`
    })
  const assemblyFile = join(dir, 'api-remotes-client.ts')
  writeFileSync(assemblyFile, assembly)
  vi.doMock('@deepseek-ai/dsh-api-remotes/client', () => import(/* @vite-ignore */ assemblyFile))
  const accessFace = faces.get(REMOTE_ACCESS_PACKAGE)
  if (accessFace === undefined) throw new Error(`viewer page: no generated Remote face for ${REMOTE_ACCESS_PACKAGE}`)
  // The plugin's own `/remote` import must name the generated face in its source: module resolution
  // runs while the entry is transformed, before a mock of that specifier could answer it. The staged
  // copy keeps its relative imports on the plugin's own modules.
  const accessClientDir = join(workspaceRoot, 'packages/api/remote-access/src/client')
  const accessClientSource = readFileSync(join(accessClientDir, 'index.ts'), 'utf8')
  const accessRemoteImport = `from '${REMOTE_ACCESS_PACKAGE}/remote'`
  if (!accessClientSource.includes(accessRemoteImport)) {
    throw new Error(`viewer page: ${REMOTE_ACCESS_PACKAGE}/client no longer imports its Remote face`)
  }
  const accessClient = accessClientSource
    .replace(accessRemoteImport, `from ${JSON.stringify(accessFace)}`)
    .replace(/from '(\.\.?\/[^']+)'/gu, (_clause, path: string) => `from ${JSON.stringify(resolve(accessClientDir, path))}`)
  const accessClientFile = join(dir, 'api-remote-access-client.ts')
  writeFileSync(accessClientFile, accessClient)
  vi.doMock(`${REMOTE_ACCESS_PACKAGE}/client`, () => import(/* @vite-ignore */ accessClientFile))
}

/**
 * Prepare the generated Remote faces once per spec file.
 * @returns Resolves when the roster may be imported.
 */
export function prepareViewerRemoteFaces(): Promise<void> {
  preparing ??= generateRemoteFaces()
  return preparing
}

/** Share the assembled page presents, as the Relay names it in the carrier options. */
export interface ViewerPageTarget {
  readonly basePath?: string
  readonly shareId: string
  readonly sessionId: string
}

/** One assembled viewer page. */
export interface AssembledViewerPage {
  /** A booted client Context; services are read through `get`. */
  context(): Context
  /** Dispose the application, then remove the page globals it installed. */
  dispose(): Promise<void>
}

interface ViewerPageWindow {
  __DSH_BOOT__?: WebBootGraph
  __ModuleLoader__?: ClientModuleLoaderTarget
}

const PROBE_ID = 'test/viewer-page-probe'

/**
 * Boot the assembled viewer page into `container`.
 * @param container - Application mount point.
 * @param target - Share the carrier names.
 * @returns The page; it keeps booting after this resolves.
 */
export async function mountViewerPage(container: HTMLElement, target: ViewerPageTarget): Promise<AssembledViewerPage> {
  await prepareViewerRemoteFaces()
  const { VIEWER_PAGE_BOOTSTRAP_ID, VIEWER_PAGE_ROSTER } = await import('./viewer-page-roster.client.ts')
  let probed: Context | undefined
  const probe: ViewerPageRosterRow = {
    id: PROBE_ID,
    exports: { name: 'viewer-page-probe', apply: (ctx: Context) => { probed = ctx } },
  }
  const rows = [...VIEWER_PAGE_ROSTER, probe]
  const bootstrap = rows.find(row => row.id === VIEWER_PAGE_BOOTSTRAP_ID)
  if (bootstrap === undefined) throw new Error('viewer page: roster is missing the module-system bootstrap')
  installViewerCarrier({
    basePath: target.basePath ?? '',
    shareId: target.shareId,
    sessionId: target.sessionId,
    readTimeoutMs: READ_TIMEOUT_MS,
  })
  const page = globalThis as ViewerPageWindow
  const facade: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    load(registration: ClientBundleRegistration): void {
      facade.pendingQueue.push(registration)
    },
    create(options: ClientModuleCreateOptions) {
      return createClientModuleSystem(facade, { id: VIEWER_PAGE_BOOTSTRAP_ID, exports: bootstrap.exports }, options)
    },
  }
  page.__ModuleLoader__ = facade
  for (const row of rows) {
    // The bootstrap arrives as the module system's own materialized module; a factory would duplicate it.
    if (row.id === VIEWER_PAGE_BOOTSTRAP_ID) continue
    // A plain copy: the module table probes optional exports such as `default`, which a mocked module
    // namespace rejects.
    facade.load({ id: row.id, factory: () => ({ ...row.exports }) })
  }
  const ids = rows.map(row => row.id)
  page.__DSH_BOOT__ = {
    rev: 'viewer-page',
    entries: ids.map(id => ({ id, url: `viewer-page:${id}`, rev: 'viewer-page' })),
    batches: [{ phase: 'application', url: 'viewer-page', rev: 'viewer-page', entries: ids }],
  }
  const entry = new AppWebEntry(container)
  void entry.run()
  return {
    context() {
      if (probed === undefined) throw new Error('viewer page: application has not booted')
      return probed
    },
    async dispose() {
      await act(async () => { await entry.dispose() })
      probed = undefined
      for (const key of ['__DSH_BOOT__', '__ModuleLoader__', '__DSH_LIVESHARE_VIEWER__', '__DSH_TRANSPORT__']) {
        Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}
