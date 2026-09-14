/** bundleRoster: the real web profile read from its bundles, and every reader decision on a scratch installation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStaticModules } from '@deepseek-ai/dsh-client-web/src/seed.ts'
import { afterAll, describe, expect, it } from 'vitest'
import { MODULES_PACKAGE } from '../src/assembly/modules.ts'
import { WEB_PROFILE_BUNDLES, bundleRoster, webApp } from '../src/assembly/bundle-roster.ts'

describe('webApp (the real web profile)', () => {
  it('composes dsh-base then dsh-web-app: unique names, inject edges on roster rows or platform seed words', () => {
    expect(WEB_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const names = webApp.rows.map(row => row.name)
    expect(new Set(names).size).toBe(names.length)
    const known = new Set([...names, ...Object.keys(getStaticModules())])
    const dangling = webApp.rows.flatMap(row => row.inject.filter(target => !known.has(target)).map(target => `${row.name} -> ${target}`))
    expect(dangling).toEqual([])
    expect(bundleRoster(WEB_PROFILE_BUNDLES).rows).toEqual(webApp.rows)
  })

  it('keeps browser rows with their declarations and drops Host-only, disabled, and subpath rows', () => {
    const immediate = new Set(webApp.rows.filter(row => row.immediately).map(row => row.name))
    expect(immediate.has(MODULES_PACKAGE)).toBe(true)
    expect(immediate.has('@deepseek-ai/dsh-client-connection')).toBe(true)
    expect(webApp.rows.find(row => row.name === '@deepseek-ai/dsh-api-gateway')?.inject)
      .toEqual(['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-client-connection'])
    const names = webApp.rows.map(row => row.name)
    expect(names).toContain('@deepseek-ai/dsh-client-ui-settings-general')
    expect(names).not.toContain('@deepseek-ai/dsh-llm') // Host only
    expect(names).not.toContain('@deepseek-ai/dsh-client-ui-schedule') // inserted disabled
    expect(names).not.toContain('@deepseek-ai/dsh-web-app') // Host runtime glue, its `/startup` row is a subpath
  })
})

/** A scratch installation: an anchor package, bundles under its node_modules, plugin packages beside them. */
class Scratch {
  readonly root = mkdtempSync(join(tmpdir(), 'bundle-roster-'))
  readonly anchor = join(this.root, 'app', 'package.json')

  constructor() {
    mkdirSync(join(this.root, 'app'), { recursive: true })
    writeFileSync(this.anchor, JSON.stringify({ name: 'app' }))
  }

  pkg(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
    const dir = join(this.root, 'app', 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }))
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
  }

  bundle(name: string, patch: string): void {
    this.pkg(name, { dsh: { bundle: { patch: './cordis.patch.yml' } } }, { 'cordis.patch.yml': patch })
  }

  web(name: string, client: Record<string, unknown> = {}): void {
    this.pkg(name, { dsh: { client: { platform: 'web', ...client } } })
  }

  roster(bundles: readonly string[]): readonly string[] {
    return bundleRoster(bundles, this.anchor).rows.map(row => row.name)
  }
}

describe('bundleRoster on a scratch installation', () => {
  const scratch = new Scratch()
  afterAll(() => { rmSync(scratch.root, { recursive: true, force: true }) })

  it('applies the layers in order and keeps enabled browser rows once, with their dsh.client declaration', () => {
    scratch.web('@t/a', { inject: ['@t/b'], immediately: true })
    scratch.web('@t/b')
    scratch.web('@t/c')
    scratch.web('plain')
    scratch.pkg('@t/host', { dsh: {} })
    scratch.pkg('@t/node', { dsh: { client: { platform: 'node' } } })
    scratch.bundle('@t/base', `
- insert:
    - id: a
      name: '@t/a'
      config:
        root: !!js process.cwd()
    - id: host
      name: '@t/host'
      disabled: !!js process.platform === 'win32'
    - id: node
      name: '@t/node'
    - id: c
      name: '@t/c'
    - id: sub
      name: '@t/a/extra'
    - id: builtin
      name: 'cordis:group'
`)
    scratch.bundle('@t/web', `
- id: c
  disabled: true
- insert:
    - id: b
      name: '@t/b'
    - id: b-again
      name: '@t/b'
    - id: plain
      name: plain
    - id: off
      name: '@t/off'
      disabled: true
`)
    const roster = bundleRoster(['@t/base', '@t/web'], scratch.anchor)
    expect(roster.rows).toEqual([
      { name: '@t/a', inject: ['@t/b'], immediately: true },
      { name: '@t/b', inject: [], immediately: false },
      { name: 'plain', inject: [], immediately: false },
    ])
    expect(scratch.roster(['@t/base'])).toEqual(['@t/a', '@t/c'])
  })

  it('descends into Loader groups and lets a disabled group disable every row beneath it', () => {
    scratch.web('@t/grouped')
    scratch.web('@t/grouped-off')
    scratch.web('@t/nested')
    scratch.bundle('@t/groups', `
- insert:
    - id: on
      name: cordis:group
      group: true
      config:
        - id: grouped
          name: '@t/grouped'
        - id: inner
          name: cordis:group
          group: true
          config:
            - id: nested
              name: '@t/nested'
    - id: off
      name: cordis:group
      group: true
      disabled: true
      config:
        - id: grouped-off
          name: '@t/grouped-off'
`)
    expect(scratch.roster(['@t/groups'])).toEqual(['@t/grouped', '@t/nested'])
  })

  it('refuses a browser row whose disabled value is a !!js expression', () => {
    scratch.web('@t/maybe')
    scratch.bundle('@t/maybe-bundle', `
- insert:
    - id: maybe
      name: '@t/maybe'
      disabled: !!js process.platform === 'win32'
`)
    expect(() => scratch.roster(['@t/maybe-bundle'])).toThrow('browser row @t/maybe has a `disabled` value this reader cannot evaluate')
  })

  it('fails loud on a bundle that does not resolve, declares no patch, or whose patch is not a list', () => {
    expect(() => scratch.roster(['@t/missing'])).toThrow('cannot resolve bundle @t/missing from')
    scratch.pkg('@t/no-patch', { dsh: {} })
    expect(() => scratch.roster(['@t/no-patch'])).toThrow('bundle @t/no-patch declares no dsh.bundle.patch in')
    scratch.bundle('@t/not-a-list', 'insert: []\n')
    expect(() => scratch.roster(['@t/not-a-list'])).toThrow('must be a top-level list of patches')
  })

  it('fails loud on a patch that does not apply as written', () => {
    scratch.bundle('@t/dangling', `
- id: nowhere
  disabled: true
`)
    expect(() => scratch.roster(['@t/dangling'])).toThrow('bundle patch patch: entry "nowhere" not found')
  })

  it('fails loud on an enabled row whose package does not resolve or names another package', () => {
    scratch.bundle('@t/unresolved', `
- insert:
    - id: ghost
      name: '@t/ghost'
`)
    expect(() => scratch.roster(['@t/unresolved'])).toThrow('cannot resolve plugin package @t/ghost from @t/unresolved')
    scratch.bundle('@t/builtin', `
- insert:
    - id: fs
      name: fs
`)
    // A Node builtin name has no resolution paths at all.
    expect(() => scratch.roster(['@t/builtin'])).toThrow('cannot resolve plugin package fs from @t/builtin')
    scratch.pkg('@t/alias', { name: '@t/real' })
    scratch.bundle('@t/misnamed', `
- insert:
    - id: alias
      name: '@t/alias'
`)
    expect(() => scratch.roster(['@t/misnamed'])).toThrow('names "@t/real", expected @t/alias')
  })
})
