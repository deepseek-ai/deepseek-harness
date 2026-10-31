/** Independent Kit installations keep their own engine resolution paths. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createEnginePackageResolver } from '../src/locate.ts'

it.each(['URL object', 'file URL string'])('resolves engines independently from two Kit installation anchors with %s', (input) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-engine-anchors-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const name = `@deepseek-ai/libreoffice-kit-${basename(root)}`
  const installs = ['first', 'second'].map((installation) => {
    const consumer = join(root, installation, 'consumer.js')
    const kitDirectory = join(dirname(consumer), 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    const kitEntry = join(kitDirectory, 'lib', 'index.js')
    const manifest = join(kitDirectory, 'node_modules', name, 'package.json')
    mkdirSync(dirname(kitEntry), { recursive: true })
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(join(kitDirectory, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(kitEntry, '')
    writeFileSync(manifest, JSON.stringify({ name }))
    return { kitEntry: createRequire(consumer).resolve('@deepseek-ai/libreoffice-kit'), manifest }
  })
  const [first, second] = installs
  if (!first || !second) throw new Error('Expected two Kit fixtures')
  const resolveFirst = createEnginePackageResolver(first.kitEntry)
  const secondUrl = pathToFileURL(second.kitEntry)
  const resolveSecond = createEnginePackageResolver(input === 'file URL string' ? secondUrl.href : secondUrl)
  expect(resolveFirst(name)).toBe(first.manifest)
  expect(resolveSecond(name)).toBe(second.manifest)
  expect(resolveFirst(name)).toBe(first.manifest)
})
