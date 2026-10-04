/** bundleRoster: the real web profile read from its bundles, and every reader decision on a scratch installation. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStaticModules } from '@deepseek-ai/dsh-client-web/src/seed.ts'
import { afterAll, describe, expect, it, onTestFinished } from 'vitest'
import { MODULES_PACKAGE } from '../src/assembly/modules.ts'
import { WEB_PROFILE_BUNDLES, bundleRoster, webApp } from '../src/assembly/bundle-roster.ts'

function profileScope(name: string) {
  const services: Record<string, object | undefined> = { profileContext: { name } }
  return { get: (key: string) => services[key] }
}

describe('webApp (the real web profile)', () => {
  it('composes dsh-base then dsh-web-app: unique names, inject edges on roster rows or platform seed words', () => {
    expect(WEB_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const names = webApp.rows.map(row => row.name)
    expect(new Set(names).size).toBe(names.length)
    const known = new Set([...names, ...Object.keys(getStaticModules())])
    const dangling = webApp.rows.flatMap(row => row.inject.filter(target => !known.has(target)).map(target => `${row.name} -> ${target}`))
    expect(dangling).toEqual([])
    expect(bundleRoster(WEB_PROFILE_BUNDLES, undefined, profileScope('web')).rows).toEqual(webApp.rows)
    expect(names).not.toContain('@deepseek-ai/dsh-client-ui-sidebar-browser')
    expect(bundleRoster(WEB_PROFILE_BUNDLES, undefined, profileScope('desktop')).rows.map(row => row.name))
      .toContain('@deepseek-ai/dsh-client-ui-sidebar-browser')
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
    expect(names).toContain('@deepseek-ai/dsh-client-ui-schedule')
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

  it('resolves a linked bundle dependency before an unrelated ancestor package', () => {
    const linked = new Scratch()
    onTestFinished(() => { rmSync(linked.root, { recursive: true, force: true }) })
    const bundle = join(linked.root, 'workspace', 'bundle')
    const dependency = join(bundle, 'node_modules', '@t', 'theme')
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: '@t/linked', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), "- insert:\n    - id: theme\n      name: '@t/theme'\n")
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@t/theme', dsh: { client: { platform: 'web' } } }))
    linked.pkg('@t/theme', {})
    symlinkSync(bundle, join(linked.root, 'app', 'node_modules', '@t', 'linked'), 'junction')
    linked.bundle('@t/base', '- insert: []\n')
    expect(linked.roster(['@t/base', '@t/linked'])).toEqual(['@t/theme'])
  })

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

  it('concatenates a dsh.bundle.patch list in order', () => {
    scratch.web('@t/listed')
    scratch.pkg('@t/list', { dsh: { bundle: { patch: ['./first.yml', './second.yml'] } } }, {
      'first.yml': '- insert:\n    - id: listed\n      name: \'@t/listed\'\n      disabled: true\n',
      'second.yml': '- id: listed\n  disabled: false\n',
    })
    expect(scratch.roster(['@t/list'])).toEqual(['@t/listed'])
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

  it('evaluates profile conditions before deduplication and skips ignored row expressions', () => {
    scratch.web('@t/conditional')
    scratch.bundle('@t/conditional-bundle', `
- insert:
    - id: ignored
      name: ./ignored.mjs
      disabled: !!js missingIgnoredValue
    - id: first
      name: '@t/conditional'
      disabled: !!js ctx.get('profileContext').name !== 'desktop'
    - id: second
      name: '@t/conditional'
      disabled: false
`)
    expect(bundleRoster(['@t/conditional-bundle'], scratch.anchor, profileScope('web')).rows.map(row => row.name))
      .toEqual(['@t/conditional'])
  })

  it('combines ancestor and child conditions without evaluating disabled subtrees', () => {
    scratch.web('@t/conditional-on')
    scratch.web('@t/conditional-off')
    scratch.bundle('@t/conditional-groups', `
- insert:
    - id: parent-off
      name: cordis:group
      group: true
      disabled: !!js true
      config:
        - id: unreachable
          name: '@t/not-installed'
          disabled: !!js missingInactiveValue
    - id: literal-off
      name: cordis:group
      group: true
      disabled: true
      config:
        - id: also-unreachable
          name: '@t/not-installed-either'
          disabled: !!js missingInactiveValue
    - id: parent-on
      name: cordis:group
      group: true
      disabled: !!js false
      config:
        - id: child-off
          name: '@t/conditional-off'
          disabled: true
        - id: nested-on
          name: cordis:group
          group: true
          disabled: !!js false
          config:
            - id: child-on
              name: '@t/conditional-on'
              disabled: null
`)
    expect(bundleRoster(['@t/conditional-groups'], scratch.anchor, {}).rows.map(row => row.name))
      .toEqual(['@t/conditional-on'])
  })

  it('propagates evaluation failures and rejects unsupported literal flags with a scope', () => {
    scratch.web('@t/bad-condition')
    scratch.bundle('@t/bad-expression', `
- insert:
    - id: bad
      name: '@t/bad-condition'
      disabled: !!js missingConditionValue
`)
    expect(() => bundleRoster(['@t/bad-expression'], scratch.anchor, {})).toThrow('missingConditionValue')
    scratch.bundle('@t/bad-literal', `
- insert:
    - id: bad
      name: '@t/bad-condition'
      disabled: not-a-boolean
`)
    expect(() => bundleRoster(['@t/bad-literal'], scratch.anchor, {})).toThrow('disabled')
  })

  it('fails loud on a bundle that does not resolve, declares no patch, or whose patch is not a list', () => {
    expect(() => scratch.roster(['@t/missing'])).toThrow('cannot resolve bundle @t/missing from')
    scratch.pkg('@t/no-patch', { dsh: {} })
    expect(() => scratch.roster(['@t/no-patch'])).toThrow('bundle @t/no-patch declares no dsh.bundle.patch file list in')
    scratch.pkg('@t/bad-patch-list', { dsh: { bundle: { patch: [1] } } })
    expect(() => scratch.roster(['@t/bad-patch-list'])).toThrow('bundle @t/bad-patch-list declares no dsh.bundle.patch file list in')
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


it('exhausts uneven linked-bundle search paths before reporting a missing plugin', () => {
  const scratch = new Scratch()
  onTestFinished(() => { rmSync(scratch.root, { recursive: true, force: true }) })
  const bundle = join(scratch.root, 'workspace', 'nested', 'deeper', 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: '@t/deep', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), "- insert:\n    - id: missing\n      name: '@t/absent'\n")
  scratch.bundle('@t/base', '- insert: []\n')
  symlinkSync(bundle, join(scratch.root, 'app', 'node_modules', '@t', 'deep'), 'junction')
  expect(() => scratch.roster(['@t/base', '@t/deep'])).toThrow('cannot resolve plugin package @t/absent')
})
