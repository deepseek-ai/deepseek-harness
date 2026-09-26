/** Regression coverage for the browser app-route guard. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserFaceSources, findRouteResolutionViolations, type RouteGateFace } from './verify-client-route-resolution.ts'

function patterns(file: string, source: string, face?: RouteGateFace): string[] {
  return findRouteResolutionViolations(file, source, face).map(violation => violation.pattern)
}

function rules(file: string, source: string, face?: RouteGateFace): string[] {
  return findRouteResolutionViolations(file, source, face).map(violation => violation.rule)
}

const CLIENT_FILE = 'packages/client/ui-example/src/client/View.tsx'
const PRODUCER_FILE = 'packages/client/modules/src/index.ts'

describe('browser app-route guard', () => {
  it('accepts document-relative request targets and routes that are not targets', () => {
    expect(patterns(CLIENT_FILE, `
      export const PRESENT_OPEN_PATH = '/api/present.open'
      const CHANNEL = '/api'
      export async function load(id: string) {
        const bundle = 'plugins/local.js'
        const icon = \`open-in-app/icon/\${id}\`
        const file = new URL(\`api/file?path=\${id}\`, document.baseURI)
        await customFetch('api/session.export?sessionId=s1')
        await connection.rpc.call('/api', 'goals/create', {})
        webserver.register({ path: '/plugins' })
        const identity = window.location.hostname
        const foreign = 'https://cdn.example/app.js'
        const asset = '/assets/app.js'
        return [bundle, icon, file.href, CHANNEL, identity, foreign, asset]
      }
    `)).toEqual([])
  })

  it('rejects every request target that binds a route to one mount', () => {
    expect(findRouteResolutionViolations(CLIENT_FILE, `
      export async function load(id: string) {
        const origin = window.location.origin
        await fetch('/api/remote.mux')
        await fetch(\`/plugins/\${id}/client.js\`)
        await fetch(\`\${origin}/api/file?path=\${id}\`)
        await this.fetcher('/api/custom')
        new EventSource('/plugins/events')
        new WebSocket('wss://harness.example/api/remote.mux')
        document.querySelector('script').src = '//harness.example/api/file'
        return id
      }
    `).map(violation => [violation.line, violation.rule])).toEqual([
      [4, 'request-target'], [5, 'request-target'], [6, 'request-target'], [7, 'request-target'],
      [8, 'request-target'], [9, 'request-target'], [10, 'request-target'],
    ])
  })

  it('rejects a root-absolute app route in a JSX resource attribute', () => {
    expect(findRouteResolutionViolations(CLIENT_FILE, `
      export function View({ id }: { id: string }) {
        return <div>
          <img src="/api/file?path=x" />
          <img src={\`\${window.location.origin}/api/file?path=\${id}\`} />
          <img src={\`/plugins/\${id}/preview.png\`} />
          <a href="open-in-app/apps">apps</a>
          <a href="https://cdn.example/app.js">cdn</a>
        </div>
      }
    `).map(violation => violation.line)).toEqual([4, 5, 6])
  })

  it('rejects a shared host route key used without stripping its leading slash', () => {
    const source = `
      import { PRESENT_OPEN_PATH, EVENTS_ENDPOINT } from '../presented.ts'
      await fetch(PRESENT_OPEN_PATH)
      await fetch(\`\${EVENTS_ENDPOINT}?since=1\`)
      await fetch(PRESENT_OPEN_PATH.slice(1))
    `
    expect(findRouteResolutionViolations(CLIENT_FILE, source).map(violation => violation.line)).toEqual([3, 4])
    expect(rules(CLIENT_FILE, source)).toEqual(['host-route-key', 'host-route-key'])
  })

  it('rejects a relative app route resolved against a location read', () => {
    expect(findRouteResolutionViolations(CLIENT_FILE, `
      const url = new URL('api/session.export?sessionId=s1', window.location.origin)
      const ok = new URL('api/session.export?sessionId=s1', document.baseURI)
      const mapped = new URL(input, globalThis.location.origin)
      return [url, ok, mapped]
    `).map(violation => [violation.line, violation.rule])).toEqual([[2, 'location-base']])
  })

  it('leaves identity and transport reads of location alone', () => {
    expect(patterns(CLIENT_FILE, `
      const trusted = window.location.hostname === 'localhost'
      const requested = new URL(location.href).searchParams.get('source')
      const { origin } = document.location
      return [trusted, requested, origin]
    `)).toEqual([])
  })
})

describe('browser-reference producers', () => {
  it('rejects a root-absolute app route stamped into a field the browser resolves', () => {
    expect(findRouteResolutionViolations(PRODUCER_FILE, `
      const bootstrap = { phase: 'bootstrap', url: \`/plugins/??\${resources}&rev=\${rev}\`, rev, entries }
      const row = { id, url: 'plugins/boot.js', initialUrl: '/plugins/all.js', rev }
      const map = { src: 'https://harness.example/plugins/??a/client.js.map&rev=r' }
      const link = { href: '/open-in-app/apps' }
      const script = { src: '//harness.example/plugins/a.js' }
      const key = \`/plugins/\${comboSearch(ids, rev)}\`
      return [bootstrap, row, map, link, script, key]
    `, 'reference-producer').map(violation => [violation.line, violation.rule])).toEqual(
      [2, 3, 4, 5, 6].map(line => [line, 'reference-producer']),
    )
  })

  it('leaves internal route keys and generated source names alone', () => {
    expect(patterns(PRODUCER_FILE, `
      const PLUGIN_ROUTE = '/plugins'
      const key = \`\${PLUGIN_ROUTE}/\${comboSearch(ids, rev)}\`
      const section = { map: { sources: [\`/plugins/\${record.entry.id}/client.js\`] } }
      return [key, section]
    `, 'reference-producer')).toEqual([])
  })

})

/**
 * Write one fixture project: its config, its source files, and its declared
 * libraries. The `src` tree the discovery anchors on always exists.
 */
function writeProject(root: string, name: string, options: {
  lib: readonly string[]
  /** Project-relative source paths to write. */
  sources: readonly string[]
  /** Config `include` patterns; defaults to the `src` tree. */
  include?: readonly string[]
}): void {
  const dir = join(root, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { lib: options.lib, noEmit: true },
    include: [...options.include ?? ['src']],
  }))
  for (const source of options.sources) {
    mkdirSync(dirname(join(dir, source)), { recursive: true })
    writeFileSync(join(dir, source), 'export {}\n')
  }
}

/** Write the two face aggregates of one fixture root over the named projects. */
function writeFaceAggregates(root: string, client: readonly string[], host: readonly string[]): void {
  const references = (names: readonly string[]): { path: string }[] => names.map(name => ({ path: `./${name}` }))
  writeFileSync(join(root, 'tsconfig.client.json'), JSON.stringify({ files: [], references: references(client) }))
  writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({ files: [], references: references(host) }))
}

describe('browser face discovery', () => {
  it('takes every DOM client project, and only its src/client half when the Host aggregate also compiles it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-route-face-'))
    try {
      writeProject(root, 'packages/client/browser-package', { lib: ['ES2024', 'DOM'], sources: ['src/view.ts', 'src/globals.d.ts'] })
      // Compiles in both aggregates and keeps its browser code in plain `src`.
      writeProject(root, 'packages/client/shared-package', { lib: ['ES2024', 'DOM'], sources: ['src/both-faces.ts'] })
      // Compiles in both aggregates but has a `src/client` browser half, so its
      // plain `src` (the node half) is out of scope.
      writeProject(root, 'packages/client/dual-package', { lib: ['ES2024', 'DOM'], sources: ['src/client/View.tsx', 'src/node.ts'] })
      writeProject(root, 'packages/client/host-package', { lib: ['ES2024'], sources: ['src/host.ts'] })
      writeFaceAggregates(root, [
        'packages/client/browser-package', 'packages/client/shared-package',
        'packages/client/dual-package', 'packages/client/host-package',
      ], ['packages/client/shared-package', 'packages/client/dual-package', 'packages/client/host-package'])

      expect(browserFaceSources(root)).toEqual([
        'packages/client/browser-package/src/view.ts',
        'packages/client/dual-package/src/client/View.tsx',
        'packages/client/shared-package/src/both-faces.ts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails loud when a DOM client project compiles nothing from its source tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-route-face-moved-'))
    try {
      // The DOM face still has a `src` directory, but its config now compiles a
      // tree the discovery does not know: scanning less must not pass quietly.
      writeProject(root, 'browser-package', { lib: ['DOM'], sources: ['lib/moved.ts'], include: ['lib'] })
      writeProject(root, 'host-package', { lib: ['ES2024'], sources: ['src/host.ts'] })
      writeFaceAggregates(root, ['browser-package'], ['host-package'])

      expect(() => browserFaceSources(root)).toThrow(/contributes no source file/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
