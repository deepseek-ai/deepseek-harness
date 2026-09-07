/** Application-entrypoint classification and dsh-launch enforcement. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applicationEntrypointViolations } from './verify-application-entrypoints.ts'

const cleanups: string[] = []

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-application-entrypoints-'))
  cleanups.push(root)
  return root
}

function write(root: string, path: string, content: string): void {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

describe('application entrypoints', () => {
  it('accepts the repository launcher inventory', () => {
    expect(applicationEntrypointViolations(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('rejects a package-level application bin', () => {
    const root = fixture()
    write(root, 'packages/example/app/package.json', JSON.stringify({ bin: { app: 'lib/bin.js' } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'packages/example/app/package.json: package bin bypasses the dsh launcher; applications use apps/cli profiles',
    ])
  })

  it('rejects an unclassified executable source', () => {
    const root = fixture()
    write(root, 'packages/example/app/src/bin.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'packages/example/app/src/bin.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects an executable at an application package root', () => {
    const root = fixture()
    write(root, 'apps/example/rogue.mjs', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/example/rogue.mjs: executable source has no application/build/test classification',
    ])
  })

  it('rejects an executable at the repository root', () => {
    const root = fixture()
    write(root, 'rogue.mjs', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'rogue.mjs: executable source has no application/build/test classification',
    ])
  })

  it('rejects an unclassified executable in an app workspace', () => {
    const root = fixture()
    write(root, 'apps/rogue/src/bin.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/rogue/src/bin.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects a packaging dispatcher owned by the CLI workspace', () => {
    const root = fixture()
    write(root, 'apps/cli/src/runtime-bootstrap.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/cli/src/runtime-bootstrap.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects a private Python application carrier outside dsh', () => {
    const root = fixture()
    write(root, 'packages/sdk/rogue-python-runtime/package.json', JSON.stringify({ private: true }))
    write(root, 'packages/sdk/rogue-python-runtime/src/bin.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'packages/sdk/rogue-python-runtime/src/bin.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects a classified demo wrapper that launches a package entry', () => {
    const root = fixture()
    write(root, 'package.json', JSON.stringify({ scripts: { 'demo:ptc': 'node scripts/demo-ptc.mjs' } }))
    write(root, 'scripts/demo-ptc.mjs', "spawn('node', ['packages/example/app/src/bin.ts'])\n")

    expect(applicationEntrypointViolations(root)).toEqual([
      'scripts/demo-ptc.mjs: application demo wrapper must launch apps/cli/src/bin.ts',
      'scripts/demo-ptc.mjs: application demo wrapper must not launch a package entry directly',
    ])
  })

  it('rejects a new root demo until its launch role is classified', () => {
    const root = fixture()
    write(root, 'package.json', JSON.stringify({ scripts: { 'demo:new-app': 'dsh --profile new-app' } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'package.json scripts.demo:new-app: demo launcher has no explicit dsh or in-process classification',
    ])
  })
})
