/** Tests for client package modes and module requests. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectClientPackageViolations,
  collectModuleReferences,
  collectLocalSourceSpecifiers,
  collectRuntimeLocalSourceSpecifiers,
  collectRuntimeSourcePackageUses,
  collectRuntimeSourceSpecifiers,
  collectSourceAssetSpecifiers,
  collectSourcePackageUses,
  collectStylesheetAssetUrls,
  fixClientPackageManifests,
  readClientDeclarations,
  readStylesheetAssetReferences,
  reusesClientTypes,
  type ClientDeclaration,
  type ClientPackage,
  type ClientPackageFacts,
  type ModuleReference,
} from './verify-client-packages.ts'

const CORDIS = '@deepseek-ai/cordis'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function declaration(
  short: string,
  fields: Partial<Omit<ClientDeclaration, 'name' | 'manifest'>> = {},
): ClientDeclaration {
  return {
    name: short.startsWith('@') ? short : '@deepseek-ai/dsh-client-' + short,
    manifest: 'packages/client/' + short.replace(/^.*\//, '') + '/package.json',
    dynamic: true,
    platform: 'web',
    immediately: false,
    external: [],
    inject: [],
    runtimeSourceUses: {},
    runtimeSourceSpecifiers: {},
    assetExport: undefined,
    assetReferences: [],
    ...fields,
  }
}

function pkg(
  short: string,
  fields: Partial<Omit<ClientPackage, 'name' | 'manifest'>> = {},
): ClientPackage {
  return {
    ...declaration(short),
    staticLinked: false,
    sourceUses: {},
    runtimeSourceUses: {},
    dependencies: {},
    peerDependencies: { [CORDIS]: 'workspace:^' },
    devDependencies: { [CORDIS]: 'workspace:^' },
    ...fields,
  }
}

function facts(
  packages: readonly ClientPackage[],
  options: Partial<Omit<ClientPackageFacts, 'packages'>> = {},
): ClientPackageFacts {
  return {
    packages,
    declarations: options.declarations ?? packages,
    staticLinkedPackages: options.staticLinkedPackages ?? new Set(
      packages.filter(item => item.staticLinked).map(item => item.name),
    ),
    platformModules: options.platformModules ?? [],
    preloadedExternals: options.preloadedExternals ?? [],
    parserPreloadIds: options.parserPreloadIds
      ?? (options.preloadedExternals ?? []).map(value => value.replace(/\/client$/, '')),
    clientTypedRoots: options.clientTypedRoots ?? new Set(),
    clientTypedRootReferences: options.clientTypedRootReferences ?? [],
    malformed: options.malformed ?? [],
  }
}

describe('source package uses', () => {
  it('includes root-relative runtime requests only when explicitly requested', () => {
    const source = [
      "import './local.ts'",
      "import '/src/value.ts'",
      "export * from '/src/export.ts'",
      "const load = () => import('/src/lazy.ts')",
      "const legacy = require('/src/legacy.ts')",
      "import type { A } from '/src/import-type.ts'",
      "import { type B } from '/src/import-type-only.ts'",
      "export type { A } from '/src/export-type.ts'",
      "export { type B } from '/src/export-type-only.ts'",
    ].join('\n')
    expect([...collectRuntimeLocalSourceSpecifiers('feature.ts', source)]).toEqual(['./local.ts'])
    expect([...collectRuntimeLocalSourceSpecifiers('feature.ts', source, true)]).toEqual([
      './local.ts', '/src/value.ts', '/src/export.ts', '/src/lazy.ts', '/src/legacy.ts',
    ])
  })

  it('counts type imports, module augmentations, dynamic imports, and JSX', () => {
    const uses = collectSourcePackageUses('feature.tsx', [
      "import type { A } from '@deepseek-ai/dsh-a/subpath'",
      "declare module '@deepseek-ai/dsh-client-ui-slots' {}",
      "const load = () => import('@deepseek-ai/dsh-b/remote')",
      'export const view = <div />',
      "export type { Local } from './local.ts'",
    ].join('\n'))

    expect([...uses].sort()).toEqual([
      '@deepseek-ai/dsh-a',
      '@deepseek-ai/dsh-b',
      '@deepseek-ai/dsh-client-ui-slots',
      'react',
    ])
    expect([...collectRuntimeSourcePackageUses('feature.tsx', [
      "import type { A } from '@deepseek-ai/dsh-a/subpath'",
      "declare module '@deepseek-ai/dsh-client-ui-slots' {}",
      "const load = () => import('@deepseek-ai/dsh-b')",
      'export const view = <div />',
    ].join('\n'))].sort()).toEqual([
      '@deepseek-ai/dsh-b',
      'react',
    ])
    expect([...collectRuntimeSourceSpecifiers('feature.tsx', [
      "import type { A } from '@deepseek-ai/dsh-a/subpath'",
      "const load = () => import('@deepseek-ai/dsh-b/remote')",
      'export const view = <div />',
    ].join('\n'))].sort()).toEqual([
      '@deepseek-ai/dsh-b/remote',
      'react',
    ])
    expect([...collectLocalSourceSpecifiers('feature.ts', [
      "import type { A } from './types.ts'",
      "export { value } from './value.ts'",
      "const load = () => import('./lazy.ts')",
      "const legacy = require('./legacy.ts')",
      "declare module './augmentation.ts' {}",
      "import '@deepseek-ai/dsh-a'",
    ].join('\n'))].sort()).toEqual([
      './lazy.ts',
      './legacy.ts',
      './types.ts',
      './value.ts',
    ])
  })
})

describe('package modes', () => {
  it('accepts one dynamic package and one statically linked package', () => {
    const dynamic = pkg('feature')
    const shell = pkg('ui-slots', { dynamic: false, staticLinked: true })
    expect(collectClientPackageViolations(facts([dynamic, shell]))).toEqual([])
  })

  it('rejects a package with both modes or neither mode', () => {
    const both = pkg('both', { staticLinked: true })
    const neither = pkg('neither', { dynamic: false })
    const found = collectClientPackageViolations(facts([both, neither]))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain('must be dynamic or statically linked, not both')
    expect(found.join('\n')).toContain('has no supported client package mode')
  })

  it('accepts a workspace platform module supplied by an immediately row of the same name', () => {
    const slots = declaration('ui-slots', { immediately: true })
    expect(collectClientPackageViolations(facts([], {
      declarations: [slots, declaration(CORDIS, { dynamic: false })],
      platformModules: ['react', CORDIS, slots.name],
    }))).toEqual([])
  })

  it('accepts a workspace platform module that a statically linked package supplies', () => {
    const store = declaration('store', { dynamic: false })
    expect(collectClientPackageViolations(facts([], {
      declarations: [store],
      staticLinkedPackages: new Set([store.name]),
      platformModules: [store.name],
    }))).toEqual([])
  })

  it('requires seeded workspace modules to be statically linked or immediately rows, and preloads to name dynamic rows', () => {
    const slots = declaration('ui-slots', { dynamic: false })
    const store = declaration('store')
    const bootstrap = declaration('bootstrap', { dynamic: false })
    const found = collectClientPackageViolations(facts([], {
      declarations: [slots, store, bootstrap],
      platformModules: [slots.name, store.name],
      preloadedExternals: [bootstrap.name + '/client'],
    }))
    expect(found).toEqual([
      'packages/client/web/src/platform.ts: parser-preloaded external "@deepseek-ai/dsh-client-bootstrap/client"'
      + ' has no dynamic dsh.client row',
      'packages/client/web/src/platform.ts: workspace platform module "@deepseek-ai/dsh-client-store"'
      + ' belongs to @deepseek-ai/dsh-client-store, whose build does not use the staticLinked preset,'
      + ' and has no dsh.client row of the same package name with immediately: true',
      'packages/client/web/src/platform.ts: workspace platform module "@deepseek-ai/dsh-client-ui-slots"'
      + ' belongs to @deepseek-ai/dsh-client-ui-slots, whose build does not use the staticLinked preset,'
      + ' and has no dsh.client row of the same package name with immediately: true',
    ])
  })

  it('requires every preloaded external to have a parser preload row', () => {
    const bootstrap = declaration('bootstrap')
    expect(collectClientPackageViolations(facts([], {
      declarations: [bootstrap],
      preloadedExternals: [bootstrap.name + '/client'],
      parserPreloadIds: [],
    }))).toEqual([
      'packages/client/web/src/platform.ts: parser-preloaded external '
      + '"@deepseek-ai/dsh-client-bootstrap/client" has no matching PARSER_PRELOAD_IDS row in '
      + 'packages/client/modules/src/index.ts',
    ])
  })
})

describe('module requests', () => {
  it('accepts the iframe provider registry edge without allowing other client feature edges', () => {
    const registry = declaration('script-realm')
    const specifier = registry.name + '/client'
    const provider = declaration('script-realm-iframe', {
      external: [specifier],
      runtimeSourceSpecifiers: { [specifier]: ['packages/client/script-realm-iframe/src/client/iframe.ts'] },
    })
    expect(collectClientPackageViolations(facts([], { declarations: [provider, registry] }))).toEqual([])
    const feature = declaration('feature', {
      external: [specifier],
      runtimeSourceSpecifiers: { [specifier]: ['packages/client/feature/src/client/index.ts'] },
    })
    expect(collectClientPackageViolations(facts([], { declarations: [feature, registry] })))
      .toContain(feature.manifest + ': client feature package requests runtime external '
        + JSON.stringify(specifier) + '; request only rows under packages/api/'
        + ', import shared types only, or call an injected Cordis service')
    const stale = { ...provider, runtimeSourceSpecifiers: {} }
    expect(collectClientPackageViolations(facts([], { declarations: [stale, registry] })))
      .toContain(provider.manifest + ': dsh.client.external ' + JSON.stringify(specifier)
        + ' has no runtime import or re-export in production source; remove the stale declaration')
    const other = declaration('other')
    const unrelated = { ...provider, external: [other.name + '/client'] }
    expect(collectClientPackageViolations(facts([], { declarations: [unrelated, registry, other] })))
      .toContain(provider.manifest + ': client feature package requests runtime external '
        + JSON.stringify(other.name + '/client') + '; request only rows under packages/api/'
        + ', import shared types only, or call an injected Cordis service')
  })

  it('rejects runtime requests from one client feature package to another dynamic row', () => {
    const ui = declaration('ui', {
      external: ['@deepseek-ai/dsh-client-slots/client'],
      runtimeSourceUses: {
        '@deepseek-ai/dsh-client-slots': ['packages/client/ui/src/client/index.ts'],
      },
    })
    const slots = declaration('slots')
    expect(collectClientPackageViolations(facts([], { declarations: [ui, slots] }))).toEqual([
      ui.manifest + ': client feature package requests runtime external '
      + '"@deepseek-ai/dsh-client-slots/client"; request only rows under packages/api/, import shared types only,'
      + ' or call an injected Cordis service',
    ])
  })

  it('accepts a client feature runtime request to an infrastructure row and still rejects a stale one', () => {
    const gateway = {
      ...declaration('@deepseek-ai/dsh-api-gateway'), manifest: 'packages/api/gateway/package.json',
    }
    const live = declaration('live', {
      external: ['@deepseek-ai/dsh-api-gateway/client'],
      runtimeSourceUses: {
        '@deepseek-ai/dsh-api-gateway': ['packages/client/live/src/client/index.ts'],
      },
      runtimeSourceSpecifiers: {
        '@deepseek-ai/dsh-api-gateway/client': ['packages/client/live/src/client/index.ts'],
      },
    })
    const stale = declaration('stale', { external: ['@deepseek-ai/dsh-api-gateway/client'] })
    expect(collectClientPackageViolations(facts([], { declarations: [gateway, live, stale] }))).toEqual([
      stale.manifest + ': dsh.client.external "@deepseek-ai/dsh-api-gateway/client"'
      + ' has no runtime import or re-export in production source; remove the stale declaration',
    ])
  })

  it('rejects stale externals and accepts a runtime import outside client feature packages', () => {
    const gateway = {
      ...declaration('@deepseek-ai/dsh-api-gateway'), manifest: 'packages/api/gateway/package.json',
    }
    const stale = { ...declaration('@deepseek-ai/dsh-api-stale', {
      external: ['@deepseek-ai/dsh-api-gateway/client'],
    }), manifest: 'packages/api/stale/package.json' }
    const live = { ...declaration('@deepseek-ai/dsh-api-live', {
      external: ['@deepseek-ai/dsh-api-gateway/client'],
      runtimeSourceUses: {
        '@deepseek-ai/dsh-api-gateway': ['packages/api/live/src/client/index.ts'],
      },
      runtimeSourceSpecifiers: {
        '@deepseek-ai/dsh-api-gateway/client': ['packages/api/live/src/client/index.ts'],
      },
    }), manifest: 'packages/api/live/package.json' }
    expect(collectClientPackageViolations(facts([], {
      declarations: [gateway, stale, live],
    }))).toEqual([
      stale.manifest + ': dsh.client.external "@deepseek-ai/dsh-api-gateway/client"'
      + ' has no runtime import or re-export in production source; remove the stale declaration',
    ])
  })

  it('requires the exact external subpath to be imported at runtime', () => {
    const gateway = {
      ...declaration('@deepseek-ai/dsh-api-gateway'), manifest: 'packages/api/gateway/package.json',
    }
    const subject = { ...declaration('@deepseek-ai/dsh-api-session-controller', {
      external: ['@deepseek-ai/dsh-api-gateway/client'],
      runtimeSourceUses: {
        '@deepseek-ai/dsh-api-gateway': ['packages/api/session-controller/src/client/index.ts'],
      },
      runtimeSourceSpecifiers: {
        '@deepseek-ai/dsh-api-gateway/remote': ['packages/api/session-controller/src/client/index.ts'],
      },
    }), manifest: 'packages/api/session-controller/package.json' }
    expect(collectClientPackageViolations(facts([], { declarations: [gateway, subject] }))).toEqual([
      subject.manifest + ': dsh.client.external "@deepseek-ai/dsh-api-gateway/client"'
      + ' has no runtime import or re-export in production source; remove the stale declaration',
    ])
  })

  it('rejects an explicit baseline request', () => {
    const ui = declaration('ui', { external: ['react'] })
    expect(collectClientPackageViolations(facts([], {
      declarations: [ui],
      platformModules: ['react'],
    }))).toEqual([
      ui.manifest + ': dsh.client.external repeats baseline module "react"; remove the explicit declaration',
    ])
  })

  it('rejects the /client subpath of a baseline module as a repeated baseline request', () => {
    const store = declaration('store', { dynamic: false })
    const ui = declaration('ui', { external: [store.name + '/client'] })
    expect(collectClientPackageViolations(facts([], {
      declarations: [store, ui],
      staticLinkedPackages: new Set([store.name]),
      platformModules: [store.name],
    }))).toEqual([
      ui.manifest + ': dsh.client.external repeats baseline module "' + store.name
      + '/client"; remove the explicit declaration',
    ])
  })

  it('accepts a request for a package root that production source imports through its /client subpath', () => {
    const gateway = {
      ...declaration('@deepseek-ai/dsh-api-gateway'), manifest: 'packages/api/gateway/package.json',
    }
    const subject = { ...declaration('@deepseek-ai/dsh-api-session-controller', {
      external: ['@deepseek-ai/dsh-api-gateway'],
      runtimeSourceSpecifiers: {
        '@deepseek-ai/dsh-api-gateway/client': ['packages/api/session-controller/src/client/index.ts'],
      },
    }), manifest: 'packages/api/session-controller/package.json' }
    expect(collectClientPackageViolations(facts([], { declarations: [gateway, subject] }))).toEqual([])
  })

  it('rejects duplicates, empty values, self-requests, and missing suppliers', () => {
    const ui = declaration('ui', {
      external: ['', '@deepseek-ai/dsh-client-ui', '@deepseek-ai/dsh-missing', '@deepseek-ai/dsh-missing'],
      inject: ['', '@deepseek-ai/dsh-a', '@deepseek-ai/dsh-a'],
    })
    const found = collectClientPackageViolations(facts([], { declarations: [ui] }))
    expect(found).toHaveLength(6)
    expect(found.join('\n')).toContain('dsh.client.external contains an empty value')
    expect(found.join('\n')).toContain('dsh.client.inject contains an empty value')
    expect(found.join('\n')).toContain('names its own row')
    expect(found.join('\n')).toContain('has no supplier')
  })

  it('rejects synchronous module-request cycles but ignores inject cycles', () => {
    const a = { ...declaration('@deepseek-ai/dsh-api-a', {
      external: ['@deepseek-ai/dsh-api-b'],
      inject: ['@deepseek-ai/dsh-api-b'],
      runtimeSourceUses: { '@deepseek-ai/dsh-api-b': ['packages/api/a/src/client.ts'] },
      runtimeSourceSpecifiers: { '@deepseek-ai/dsh-api-b': ['packages/api/a/src/client.ts'] },
    }), manifest: 'packages/api/a/package.json' }
    const b = { ...declaration('@deepseek-ai/dsh-api-b', {
      external: ['@deepseek-ai/dsh-api-a'],
      inject: ['@deepseek-ai/dsh-api-a'],
      runtimeSourceUses: { '@deepseek-ai/dsh-api-a': ['packages/client/b/src/client.ts'] },
      runtimeSourceSpecifiers: { '@deepseek-ai/dsh-api-a': ['packages/client/b/src/client.ts'] },
    }), manifest: 'packages/api/b/package.json' }
    const found = collectClientPackageViolations(facts([], { declarations: [a, b] }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('synchronous dsh.client.external cycle')
  })
})

describe('package assets', () => {
  const art = { file: 'packages/client/ui/src/client/View.tsx', reference: '"./assets/art.webp"' }
  const mask = { file: 'packages/client/ui/src/client/View.module.css', reference: 'url("../assets/mask.png")' }

  it('collects relative runtime module specifiers with a package-asset extension', () => {
    expect([...collectSourceAssetSpecifiers('View.tsx', [
      "import art from './assets/art.webp'",
      "import back from '../assets/icons/back.SVG'",
      "import './assets/side-effect.png'",
      "export { default as photo } from './assets/photo.jpeg'",
      "const lazy = () => import('./assets/lazy.jpg')",
      "const legacy = require('./assets/legacy.svg')",
      "import type Art from './assets/type-only.webp'",
      "import styles from './View.module.css'",
      "import font from './assets/font.eot'",
      "import raw from './assets/raw.svg?raw'",
      "import shared from '@deepseek-ai/dsh-client-other/assets/shared.svg'",
      "import rooted from '/assets/rooted.svg'",
    ].join('\n'))]).toEqual([
      './assets/art.webp',
      '../assets/icons/back.SVG',
      './assets/side-effect.png',
      './assets/photo.jpeg',
      './assets/lazy.jpg',
      './assets/legacy.svg',
    ])
  })

  it.each(['View.module.css', 'global.css'])('collects relative url() values from %s', (path) => {
    expect(collectStylesheetAssetUrls(path, [
      ".plain { background: url('./x.png'); }",
      '.parent { mask: url("../assets/x.png") center / 100% no-repeat; }',
      '.bare { background: url(./bare.svg); }',
      ".empty { background: url(''); }",
      '.inline { background: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }',
      ".fragment { filter: url('#frag'); }",
      ".rooted { background: url('/abs/x.png'); }",
      '.network { background: url(//cdn.example.com/x.png); }',
      ".remote { background: url('https://example.com/x.png'); }",
      "@supports (mask-image: url('')) { .nested { mask: url(./nested.svg); } }",
      ".set { background-image: image-set(url('./set@1x.png') 1x, url('data:image/png;base64,AA==') 2x); }",
    ].join('\n'))).toEqual(['./x.png', '../assets/x.png', './bare.svg', './nested.svg', './set@1x.png'])
  })

  it('rejects an unparsable stylesheet with its path', () => {
    expect(() => collectStylesheetAssetUrls('src/View.module.css', '.a { composes: b; } .c .d { composes: a; }'))
      .toThrow('verify-client-packages: cannot parse stylesheet src/View.module.css: The `composes` property')
  })

  it('reads url() references only from package and dependency stylesheets that Client sources import', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-package-assets-'))
    roots.push(root)
    const files: Record<string, string> = {
      'packages/client/ui/src/client/View.module.css': ".view { mask: url('../assets/mask.png'); background: url(data:,x); }",
      'packages/client/ui/src/client/global.css': '.global { background: url(./assets/global.svg); }',
      'packages/client/ui/src/client/text.css': '.text { background: url("./assets/text.webp"); }',
      'packages/client/ui/src/styles/static.css': '@font-face { src: url(./static.woff2); }',
      'packages/client/ui/styles/outside.css': '.outside { background: url(./outside.png); }',
      'packages/client/ui/package.json': '{"name":"@f/ui"}',
      'node_modules/katex/package.json': '{"name":"katex"}',
      'node_modules/katex/dist/katex.css': '@font-face { src: url(fonts/a.woff2) format("woff2"), url(fonts/a.woff) format("woff"); }',
    }
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), value)
    }

    expect(readStylesheetAssetReferences(root, 'packages/client/ui', new Map([
      ['packages/client/ui/src/client/View.tsx', ['./View.module.css', './global.css', './assets/art.webp']],
      ['packages/client/ui/src/client/lazy.ts', ['./text.css?inline', '../../styles/outside.css', './View.module.css']],
      ['packages/client/ui/src/index.ts', ['katex/dist/katex.css', './client/missing.css.ts']],
    ]))).toEqual({
      stylesheets: [
        'packages/client/ui/src/client/View.module.css',
        'packages/client/ui/src/client/global.css',
        'packages/client/ui/src/client/text.css',
      ],
      references: [
        { file: 'packages/client/ui/src/client/View.module.css', reference: 'url("../assets/mask.png")' },
        { file: 'packages/client/ui/src/client/global.css', reference: 'url("./assets/global.svg")' },
        { file: 'packages/client/ui/src/client/text.css', reference: 'url("./assets/text.webp")' },
        { file: 'node_modules/katex/dist/katex.css', reference: 'url("fonts/a.woff2")' },
        { file: 'node_modules/katex/dist/katex.css', reference: 'url("fonts/a.woff")' },
      ],
    })
  })

  it('rejects a bare stylesheet import that does not resolve from the package', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-package-missing-stylesheet-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/client/ui'), { recursive: true })
    writeFileSync(join(root, 'packages/client/ui/package.json'), '{"name":"@f/ui"}')
    expect(() => readStylesheetAssetReferences(root, 'packages/client/ui', new Map([
      ['packages/client/ui/src/client/View.tsx', ['missing-package/style.css?inline']],
    ]))).toThrow('verify-client-packages: packages/client/ui/src/client/View.tsx imports stylesheet '
      + '"missing-package/style.css?inline", which does not resolve from packages/client/ui')
  })

  it('reads the Web platform and the raw asset export from manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-package-asset-manifests-'))
    roots.push(root)
    const files: Record<string, unknown> = {
      'packages/g/web/package.json': {
        name: '@f/web', dsh: { client: { platform: 'web' } }, exports: { './assets/*': './lib/assets/*' },
      },
      'packages/g/conditional/package.json': {
        name: '@f/conditional', exports: { './assets/*': { default: './lib/assets/*' } },
      },
      'packages/g/none/package.json': { name: '@f/none', dsh: { client: { platform: 1 } }, exports: './lib/index.js' },
    }
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(value))
    }

    expect(readClientDeclarations(root).declarations.map(entry => [entry.name, entry.platform, entry.assetExport]))
      .toEqual([
        ['@f/conditional', undefined, { default: './lib/assets/*' }],
        ['@f/none', undefined, undefined],
        ['@f/web', 'web', './lib/assets/*'],
      ])
  })

  it('accepts referenced assets with the export and unreferenced packages without it', () => {
    expect(collectClientPackageViolations(facts([], {
      declarations: [
        declaration('ui', { assetExport: './lib/assets/*', assetReferences: [mask, art] }),
        declaration('plain'),
        declaration('shell', { dynamic: false, platform: undefined }),
      ],
    }))).toEqual([])
  })

  it.each([
    ['./lib/assets/**', '"./lib/assets/**"'],
    [{ default: './lib/assets/*' }, '{"default":"./lib/assets/*"}'],
    [null, 'null'],
  ])('rejects the asset export target %j', (target, shown) => {
    const ui = declaration('ui', { assetExport: target, assetReferences: [art] })
    expect(collectClientPackageViolations(facts([], { declarations: [ui] }))).toEqual([
      ui.manifest + ': exports["./assets/*"] is ' + shown + '; it must be exactly "./lib/assets/*"',
    ])
  })

  it.each([
    ['a statically linked package', { dynamic: false, platform: undefined }],
    ['a row for another platform', { platform: 'desktop' }],
    ['a row without a platform', { platform: undefined }],
  ] as const)('rejects the asset export on %s', (_label, fields) => {
    const ui = declaration('ui', { ...fields, assetExport: './lib/assets/*', assetReferences: [art] })
    expect(collectClientPackageViolations(facts([], { declarations: [ui] }))).toEqual([
      ui.manifest + ': ' + ui.name + ' declares exports["./assets/*"] without a dsh.client row for platform "web";'
      + ' only dynamic Web Client packages publish package assets',
    ])
  })

  it('rejects a referenced asset without the export and names the first reference', () => {
    const ui = declaration('ui', { assetReferences: [mask, art] })
    expect(collectClientPackageViolations(facts([], { declarations: [ui] }))).toEqual([
      ui.manifest + ': ' + ui.name + ' references package asset url("../assets/mask.png") in '
      + 'packages/client/ui/src/client/View.module.css but declares no exports["./assets/*"];'
      + ' add "./assets/*": "./lib/assets/*" and publish "lib/assets"',
    ])
  })

  it('rejects an unused asset export', () => {
    const ui = declaration('ui', { assetExport: './lib/assets/*' })
    expect(collectClientPackageViolations(facts([], { declarations: [ui] }))).toEqual([
      ui.manifest + ': ' + ui.name + ' declares an unused ./assets/* export;'
      + ' no Client source or stylesheet it imports references a package asset',
    ])
  })
})

describe('manifest declarations', () => {
  it('reports malformed arrays without hiding other packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-packages-'))
    roots.push(root)
    const files: Record<string, unknown> = {
      'packages/g/a/package.json': {
        name: '@f/a', dsh: { client: { external: 'react', inject: ['@f/b', 1] } },
      },
      'packages/g/b/package.json': { name: '@f/b', dsh: { client: {} } },
    }
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(value))
    }

    const result = readClientDeclarations(root)
    expect(result.declarations).toHaveLength(2)
    expect(result.malformed).toEqual([
      'packages/g/a/package.json: @f/a dsh.client.external must be a string array',
      'packages/g/a/package.json: @f/a dsh.client.inject must be a string array',
    ])
  })

  it('fixes malformed declaration entries without changing dependency sections', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-packages-fix-'))
    roots.push(root)
    const subject = pkg('feature', {
      external: ['', 'react', '@deepseek-ai/dsh-client-ui-slots/client', '@deepseek-ai/dsh-client-feature', '@deepseek-ai/dsh-missing'],
      inject: ['', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent'],
      sourceUses: {
        '@deepseek-ai/dsh-agent': ['packages/client/feature/src/index.ts'],
        '@deepseek-ai/dsh-client-ui-slots': ['packages/client/feature/src/view.tsx'],
      },
      dependencies: {
        [CORDIS]: 'workspace:^',
        '@deepseek-ai/dsh-agent': 'workspace:*',
      },
      peerDependencies: {
        '@deepseek-ai/dsh-client-ui-slots': 'workspace:^',
        '@deepseek-ai/cordis-plugin-loader': 'workspace:^',
      },
      devDependencies: {},
    })
    const slots = declaration('ui-slots', { dynamic: false })
    const manifest = {
      name: subject.name,
      dsh: { client: { external: subject.external, inject: subject.inject, platform: 'web' } },
      dependencies: subject.dependencies,
      peerDependencies: subject.peerDependencies,
      devDependencies: subject.devDependencies,
    }
    mkdirSync(dirname(join(root, subject.manifest)), { recursive: true })
    writeFileSync(join(root, subject.manifest), JSON.stringify(manifest))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }))

    expect(fixClientPackageManifests(root, facts([subject], {
      declarations: [subject, slots],
      staticLinkedPackages: new Set([slots.name]),
      platformModules: ['react', slots.name],
    }))).toEqual([subject.manifest])

    const fixed = JSON.parse(readFileSync(join(root, subject.manifest), 'utf8')) as {
      dsh: { client: { external: string[]; inject: string[] } }
      dependencies?: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(fixed.dsh.client).toMatchObject({
      external: ['@deepseek-ai/dsh-missing'],
      inject: ['@deepseek-ai/dsh-agent'],
    })
    expect(fixed.dependencies).toEqual(subject.dependencies)
    expect(fixed.peerDependencies).toEqual(subject.peerDependencies)
    expect(fixed.devDependencies).toEqual(subject.devDependencies)
  })
})

describe('client-typed package root spelling', () => {
  const slots = declaration('ui-slots', { immediately: true })
  const settings = declaration('ui-settings')
  const roots = { declarations: [slots, settings], clientTypedRoots: new Set([slots.name]) }
  const reference = (module: string, kind: ModuleReference['kind'] = 'import'): ModuleReference =>
    ({ file: 'packages/client/ui-x/src/client/index.ts', line: 3, module, kind })

  it('reads every module-specifier position and no other string', () => {
    const source = [
      "import { a } from 'x/import'",
      "import type { B } from 'x/type-import'",
      "export * from 'x/export'",
      "import legacy = require('x/import-equals')",
      "type Q = typeof import('x/type-query')",
      "const lazy = () => import('x/dynamic')",
      "const loaded = require('x/require')",
      "vi.mock('x/mock', () => ({}))",
      "declare module 'x/augmented' { interface M { k: 1 } }",
      "declare global { namespace N { const s: 'x/not-a-reference' } }",
      "// import { c } from 'x/comment'",
      "const text = \"from 'x/string'\"",
    ].join('\n')
    expect(collectModuleReferences('fixture.ts', source).map(found => [found.line, found.module, found.kind])).toEqual([
      [1, 'x/import', 'import'], [2, 'x/type-import', 'import'], [3, 'x/export', 'import'],
      [4, 'x/import-equals', 'import'], [5, 'x/type-query', 'import'], [6, 'x/dynamic', 'import'],
      [7, 'x/require', 'import'], [8, 'x/mock', 'import'], [9, 'x/augmented', 'augmentation'],
    ])
  })

  it('selects a package whose root types are its ./client declarations', () => {
    const client = { types: './lib/types/client/index.d.ts', default: './lib/client.js' }
    expect(reusesClientTypes({ exports: { '.': { types: client.types, default: './lib/index.js' }, './client': client } }))
      .toBe(true)
    expect(reusesClientTypes({ exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './client': client } }))
      .toBe(false)
    expect(reusesClientTypes({ exports: { '.': { types: client.types } } })).toBe(false)
    expect(reusesClientTypes({})).toBe(false)
  })

  it('accepts /client references to a client-typed root and root references to other packages', () => {
    expect(collectClientPackageViolations(facts([], {
      ...roots,
      clientTypedRootReferences: [
        reference(slots.name + '/client'), reference(slots.name + '/client', 'augmentation'),
        reference(settings.name), reference('react'),
      ],
    }))).toEqual([])
  })

  it('rejects package-root imports and augmentations of a client-typed root', () => {
    const references = [reference(slots.name), reference(slots.name, 'augmentation')]
    const found = collectClientPackageViolations(facts([], { ...roots, clientTypedRootReferences: references }))
    expect(found).toHaveLength(2)
    expect(found[0]).toBe(
      'packages/client/ui-x/src/client/index.ts:3: declare module "@deepseek-ai/dsh-client-ui-slots" names the package root;'
      + ' repository code names "@deepseek-ai/dsh-client-ui-slots/client" for values, types, and augmentations. The package'
      + ' publishes its ./client declarations as the root types for code outside the repository, but in this repository'
      + ' the package root resolves to the Host entry under src/, which carries neither the /client exports nor their'
      + ' declarations.',
    )
    expect(found[1]).toMatch(/: module reference "@deepseek-ai\/dsh-client-ui-slots" names the package root;/u)
    // Negative control: the same references pass when the package root carries its own declarations.
    expect(collectClientPackageViolations(facts([], {
      ...roots, clientTypedRoots: new Set(), clientTypedRootReferences: references,
    }))).toEqual([])
  })
})
