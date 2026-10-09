/** Runtime evidence keeps retained experimental names visible through installed aliases. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS } from '../../../../../../scripts/experimental-package-policy.ts'
import { experimentalRuntimeReferences } from './runtime-roster-isolation.ts'
import type { RuntimeRoster } from './runtime-roster.ts'

it.each(Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('finds retained experimental package %s in real roster fields', (name) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-roster-policy-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const directory = join(root, 'node_modules/ordinary-alias')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name }))
  const module = pathToFileURL(join(directory, 'index.js')).href
  const subpath = `${name}/client`
  const external = `${name}/external`
  const injected = `${name}/injected`
  const batched = `${name}/batch`
  const roster: RuntimeRoster = {
    entries: [{ id: 'entry', name, state: 1 }],
    plugins: [{ name: 'plugin', owner: subpath, state: 1, modules: [module] }],
    modules: [module],
    client: {
      rev: 'fixture',
      entries: [{ id: 'ordinary-client', url: '/client.js', rev: 'fixture', inject: [injected], external: [external] }],
      batches: [{ phase: 'application', url: '/batch.js', rev: 'fixture', entries: [batched] }],
    },
  }
  expect(experimentalRuntimeReferences(roster)).toEqual([name, subpath, module, external, injected, batched].sort())
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `${name}-unrelated` }))
  expect(experimentalRuntimeReferences({
    entries: [], plugins: [], modules: [module], client: { rev: 'fixture', entries: [], batches: [] },
  })).toEqual([])
})
