import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

const repositoryRoot = join(import.meta.dirname, '..')

/** Names of the workspace packages under `packages/` whose manifest declares `dsh.client`. */
const DYNAMIC_CLIENT_PACKAGES: ReadonlySet<string> = new Set(
  globSync('packages/*/*/package.json', { cwd: repositoryRoot }).flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, path), 'utf8')) as {
      readonly name?: string
      readonly dsh?: { readonly client?: unknown }
    }
    return manifest.name !== undefined && manifest.dsh?.client !== undefined ? [manifest.name] : []
  }),
)

/**
 * Whether a specifier names the `/client` subpath of a workspace package that declares `dsh.client`. Workers bundle those
 * from source through the tsconfig paths: such a package builds `lib/client.js` as a registration script for the browser
 * module loader, which a Node worker does not have.
 * @param id - Module specifier.
 * @returns True for `<package>/client` of a package that declares `dsh.client`.
 */
const isDynamicClientSubpath = (id: string): boolean =>
  id.endsWith('/client') && DYNAMIC_CLIENT_PACKAGES.has(id.slice(0, -'/client'.length))

const shared = {
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: (id: string): boolean => id.startsWith('@deepseek-ai/') && !isDynamicClientSubpath(id),
    onlyBundle: false as const,
  },
}

/**
 * Compile measured benchmark workers while keeping workspace packages on their built `lib` entries, except the `/client`
 * subpaths of packages that declare `dsh.client`, which are bundled from source.
 */
export default defineConfig([
  {
    ...shared,
    entry: { 'terminal-io.worker': 'terminal-io/terminal-io.worker.ts' },
    outDir: '.dsh-build/terminal-io',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'reconnect.worker': 'active-stream-reconnect/reconnect.worker.client.ts' },
    outDir: '.dsh-build/active-stream-reconnect',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  {
    ...shared,
    entry: {
      'agent-continuation.worker': 'agent-continuation/agent-continuation.worker.ts',
      'child-catalog.worker': 'agent-continuation/child-catalog.worker.ts',
      'profile-continuation.worker': 'agent-continuation/profile-continuation.worker.ts',
      'profile-adapter': 'agent-continuation/profile-adapter.ts',
    },
    outDir: '.dsh-build/agent-continuation',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'session-open.worker': 'session-open/session-open.worker.ts' },
    outDir: '.dsh-build/session-open',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: {
      'session-corpus.worker': 'session-corpus/session-corpus.worker.ts',
      'projection-list.worker': 'session-corpus/projection-list.worker.ts',
    },
    outDir: '.dsh-build/session-corpus',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: {
      'conversation-fold.worker': 'conversation-fold/conversation-fold.worker.client.ts',
    },
    outDir: '.dsh-build/conversation-fold',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  {
    ...shared,
    entry: { 'user-text.worker': 'user-text/user-text.worker.client.ts' },
    outDir: '.dsh-build/user-text',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
])
