/** DevTools sources are fixed npm inputs; package installation starts no external resource download. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

interface Manifest {
  scripts?: Record<string, string>
  files?: string[]
  devDependencies?: Record<string, string>
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Manifest
}

it('installs workspace Git hooks without prefetching DevTools', () => {
  const root = manifest('../../../../package.json')
  expect(root.scripts?.postinstall).toBe('node scripts/install-lefthook.mjs')
  expect(root.scripts?.['prefetch:devtools']).toBeUndefined()
})

it('pins the npm source and uses workspace Vite without a webpack dependency', () => {
  const dependencies = manifest('../package.json').devDependencies
  expect(dependencies?.['chrome-devtools-frontend']).toBe('1.0.1638082')
  expect(dependencies?.vite).toBeUndefined()
  expect(manifest('../../../../package.json').devDependencies?.vite).toBe('8.0.16')
  expect(Object.keys(dependencies ?? {}).some(name => name.includes('webpack'))).toBe(false)
})

it.each(['../../../../apps/cli/package.json', '../../inspector-profile/package.json', '../package.json'])(
  'keeps download lifecycle hooks out of the published package %s', (path) => {
    const { scripts = {} } = manifest(path)
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(scripts[hook]).toBeUndefined()
  },
)

it('publishes the built frontend without its download tooling or cache', () => {
  const { files } = manifest('../package.json')
  expect(files).toContain('lib/devtools/**')
  expect(files?.some(path => /^(?:scripts|\.cache)(?:\/|$)/u.test(path))).toBe(false)
})
