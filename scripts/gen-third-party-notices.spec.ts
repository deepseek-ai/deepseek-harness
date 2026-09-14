import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  assertRuntimeLicenses,
  claudeDistributionFromManifest,
  collectPythonDependencies,
  isOwnerAuthorizedRuntime,
  isPermissive,
  type Manifest,
  manifestPatterns,
  parsePyprojectRequirements,
  parseVendoredRows,
  render,
  tierExternalDeps,
  virtualManifest,
} from './gen-third-party-notices.ts'

const root = resolve(import.meta.dirname, '..')

describe('THIRD_PARTY_NOTICES.md', () => {
  // Freshness lives here rather than in its own doc-sync gate: this spec file
  // already runs in the test lane, so the check costs no extra CI process.
  // Pre-commit regenerates the file whenever a manifest is staged, so reaching
  // this assertion means the notices were committed without that hook.
  // This case resolves all browser build graphs as well as installed license metadata.
  it('matches what the generator produces from the current manifests', {
    timeout: 120_000,
  }, async () => {
    const generated = await render()
    expect(generated).toContain('It depends on the third-party software listed below.')
    expect(readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), 'stale notices — run `pnpm run gen-third-party-notices`').toBe(generated)
  })
})

/** Build the (manifests, names) pair `tierExternalDeps` consumes. */
function workspace(entries: Record<string, Manifest>): { manifests: Map<string, Manifest>; names: Set<string> } {
  const manifests = new Map(Object.entries(entries))
  const names = new Set<string>()
  for (const manifest of manifests.values()) {
    if (manifest.name !== undefined) names.add(manifest.name)
  }
  return { manifests, names }
}

describe('tierExternalDeps', () => {
  it('keeps license rejection active when a browser library is declared for development', () => {
    const { manifests, names } = workspace({
      'packages/client/ui/package.json': { devDependencies: { 'browser-lib': '^1', 'test-tool': '^1' } },
    })
    const tiers = tierExternalDeps(manifests, names, new Set(['browser-lib']))
    const dependencies = [{ name: 'browser-lib', license: 'GPL-3.0-only' }, { name: 'test-tool', license: 'GPL-3.0-only' }]
      .filter(dep => tiers.get(dep.name))
    expect(dependencies.map(dep => dep.name)).toEqual(['browser-lib'])
    expect(() => { assertRuntimeLicenses(dependencies) }).toThrow('browser-lib (GPL-3.0-only)')
    expect(() => { assertRuntimeLicenses([{ name: 'browser-lib', license: 'MIT' }]) }).not.toThrow()
    expect(() => { assertRuntimeLicenses([{ name: CLAUDE_AGENT_SDK_PACKAGE, license: 'SEE LICENSE IN README.md' }]) })
      .not.toThrow()
  })

  it('keeps browser-bundled development dependencies in runtime disclosures', () => {
    const { manifests, names } = workspace({
      'packages/client/ui/package.json': {
        name: '@fixture/ui', devDependencies: { react: '^18', 'browser-lib': '^1', 'type-only': '^1' },
      },
    })
    expect(tierExternalDeps(manifests, names, new Set(['react', 'browser-lib']))).toEqual(new Map([
      ['tsx', true], ['react', true], ['browser-lib', true], ['type-only', false],
    ]))
  })

  it('rejects a browser library missing from the disclosed declarations', () => {
    const { manifests, names } = workspace({})
    expect(() => tierExternalDeps(manifests, names, new Set(['missing-lib'])))
      .toThrow('browser package missing-lib has no workspace dependency declaration')
  })

  it('tiers by declaring area, not by the declaring section name', () => {
    const { manifests, names } = workspace({
      // Root tooling and test infrastructure never ship, whichever section declares them.
      'package.json': { dependencies: { 'root-runtime-looking': '^1' }, devDependencies: { 'lint-tool': '^1' } },
      'packages/test-support/loader-smoke/package.json': { name: '@deepseek-ai/dsh-loader-smoke', dependencies: { 'smoke-helper': '^1' } },
      'packages/test-support/client-runtime/package.json': { name: '@deepseek-ai/dsh-client-test-runtime', dependencies: { 'test-lib': '^1' } },
      'website/package.json': { devDependencies: { 'site-tool': '^1' } },
      // A plugin package's runtime dependency ships even when no app mounts it by default.
      'packages/mcp/mcp-client/package.json': { name: '@deepseek-ai/dsh-mcp-client', dependencies: { 'protocol-sdk': '^1' }, devDependencies: { 'protocol-fixture-server': '^1' } },
      'apps/cli/package.json': { name: '@deepseek-ai/dsh-cli', dependencies: { 'cli-lib': '^1', '@deepseek-ai/dsh-mcp-client': 'workspace:^' } },
    })

    expect(tierExternalDeps(manifests, names)).toEqual(new Map([
      ['tsx', true],
      ['root-runtime-looking', false],
      ['lint-tool', false],
      ['smoke-helper', false],
      ['test-lib', false],
      ['site-tool', false],
      ['protocol-sdk', true],
      ['protocol-fixture-server', false],
      ['cli-lib', true],
    ]))
  })

  it('keeps a package runtime when any shipping area declares it, and excludes workspace links', () => {
    const { manifests, names } = workspace({
      'package.json': { devDependencies: { shared: '^1' } },
      'packages/interaction/tui/package.json': { name: '@deepseek-ai/dsh-tui', dependencies: { shared: '^1', '@deepseek-ai/dsh-cli': 'workspace:^' } },
      'apps/cli/package.json': { name: '@deepseek-ai/dsh-cli' },
    })

    expect(tierExternalDeps(manifests, names).get('shared')).toBe(true)
    expect(tierExternalDeps(manifests, names).has('@deepseek-ai/dsh-cli')).toBe(false)
  })
})

describe('virtualManifest', () => {
  it('resolves a manifest from an ordinary prefix-matching store directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-notices-prefix-'))
    try {
      const name = '@scope/pkg'
      const version = '1.0.0'
      const store = join(root, 'store')
      const manifestDir = join(store, `${name.replace('/', '+')}@${version}`, 'node_modules', name)
      mkdirSync(manifestDir, { recursive: true })
      writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }))

      expect(virtualManifest(store, name)).toMatchObject({ name, version, license: 'MIT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a content scan when pnpm 11 truncates the store directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-notices-truncated-'))
    try {
      const name = '@scope/pkg'
      const version = '2.0.0'
      const store = join(root, 'store')
      // The truncated name no longer starts with `@scope+pkg@`, so only the
      // whole-store content scan can find the package.
      const manifestDir = join(store, '@scope+pkg_9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f', 'node_modules', name)
      mkdirSync(manifestDir, { recursive: true })
      writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({ name, version, license: 'Apache-2.0' }))

      expect(virtualManifest(store, name)).toMatchObject({ name, version, license: 'Apache-2.0' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects the requested version when the store retains historical copies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-notices-version-'))
    try {
      const name = '@scope/pkg'
      const store = join(root, 'store')
      for (const version of ['1.0.0', '2.0.0']) {
        const manifestDir = join(store, `${name.replace('/', '+')}@${version}`, 'node_modules', name)
        mkdirSync(manifestDir, { recursive: true })
        writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }))
      }

      expect(virtualManifest(store, name, '2.0.0')).toMatchObject({ name, version: '2.0.0' })
      expect(virtualManifest(store, name, '3.0.0')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when neither the prefix nor the content scan finds the package', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-notices-miss-'))
    try {
      const store = join(root, 'store')
      const other = join(store, 'other-pkg@1.0.0', 'node_modules', 'other-pkg')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other-pkg', version: '1.0.0' }))

      expect(virtualManifest(store, '@scope/missing')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('parseVendoredRows', () => {
  it('reads the committed vendor manifest table', () => {
    const rows = parseVendoredRows(readFileSync(resolve(root, 'vendor/README.md'), 'utf8'))

    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toContainEqual({
      npmName: '@deepseek-ai/cordis',
      upstreamName: 'cordis',
      upstream: 'https://github.com/cordiverse/cordis',
    })
    // The upstream column carries a trailing package path for some rows; it is not part of the URL.
    expect(rows.every(row => /^https:\/\/\S+$/.test(row.upstream))).toBe(true)
  })

  it('yields nothing when the table columns change, so the generator fails loud', () => {
    expect(parseVendoredRows('| `cordis/` | `@deepseek-ai/cordis` | cordis | 4.0.0 | https://example.com | `abc123` |\n')).toEqual([])
  })

  it('covers every vendored directory, so no package can drop out of the notices', () => {
    const parsed = new Set(parseVendoredRows(readFileSync(resolve(root, 'vendor/README.md'), 'utf8')).map(row => row.npmName))
    const onDisk = readdirSync(resolve(root, 'vendor'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => (JSON.parse(readFileSync(resolve(root, 'vendor', entry.name, 'package.json'), 'utf8')) as Manifest).name)

    expect([...onDisk].sort()).toEqual([...parsed].sort())
  })
})

describe('parsePyprojectRequirements', () => {
  it('reads the committed manifests', () => {
    expect(parsePyprojectRequirements(readFileSync(resolve(root, 'python/sdk/pyproject.toml'), 'utf8'))).toContain('pydantic')
  })

  it('locates requirement arrays by TOML table, so author-named groups are not missed', () => {
    expect(parsePyprojectRequirements([
      '[build-system]',
      'requires = ["hatchling>=1.24.0"]',
      '',
      '[project]',
      'name = "not-a-requirement"',
      'dependencies = ["pydantic>=2.12"]',
      '',
      '[project.optional-dependencies]',
      'cli = ["click"]',
      '',
      '[dependency-groups]',
      'docs = ["sphinx>=7"]',
      '',
      '[tool.hatch.build.targets.wheel]',
      'packages = ["src/deepseek_harness"]',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'))).toEqual(['hatchling', 'pydantic', 'click', 'sphinx'])
  })

  it('does not truncate an array at a bracket inside extras', () => {
    expect(parsePyprojectRequirements('[project]\ndependencies = ["httpx[http2]", "requests"]\n'))
      .toEqual(['httpx', 'requests'])
  })

  it('reads names whether or not requirements carry versions, extras, or markers', () => {
    expect(parsePyprojectRequirements("[project]\ndependencies = [\"pydantic>=2.12\", \"requests\", \"httpx[http2]\", \"tomli ; python_version < '3.11'\", \"hatchling >= 1.24.0\"]\n"))
      .toEqual(['pydantic', 'requests', 'httpx', 'tomli', 'hatchling'])
  })

  it('reads single-quoted TOML literals and rejects an unreadable requirement', () => {
    expect(parsePyprojectRequirements("[project]\ndependencies = ['requests', \"pydantic>=2\"]\n")).toEqual(['requests', 'pydantic'])
    expect(() => parsePyprojectRequirements('[project]\ndependencies = ["!!broken"]\n')).toThrow(/cannot read a distribution name/)
  })

  it('reads a multi-line array', () => {
    expect(parsePyprojectRequirements('[project]\ndependencies = [\n  "pydantic>=2.12",\n  "typing-extensions",\n]\n'))
      .toEqual(['pydantic', 'typing-extensions'])
  })

  it('obeys TOML comments, quoted keys, and escaped strings', () => {
    expect(parsePyprojectRequirements([
      '[project] # a legal header comment',
      'dependencies = [',
      '  "pydantic", # ] does not close the array',
      '  # "old-package" is not a dependency',
      '  "tomli; python_version < \'3.11\'",',
      ']',
      '',
      '[dependency-groups]',
      '"test.docs" = ["pytest"]',
    ].join('\n'))).toEqual(['pydantic', 'tomli', 'pytest'])
  })

  it('accepts dependency-group includes and rejects unsupported requirement forms', () => {
    expect(parsePyprojectRequirements('[dependency-groups]\nbase = ["pytest"]\nall = [{ include-group = "base" }]\n'))
      .toEqual(['pytest'])
    expect(() => parsePyprojectRequirements('[project]\ndependencies = "pytest"\n')).toThrow(/must be an array/)
    expect(() => parsePyprojectRequirements('[dependency-groups]\ntest = [{ unknown = "pytest" }]\n')).toThrow(/unsupported requirement entry/)
  })
})

describe('collectPythonDependencies', () => {
  it('excludes normalized local project names without exempting a third-party prefix', () => {
    const pyprojects = [
      '[project]\nname = "deepseek-harness-runtime-bin"\ndependencies = ["pydantic"]\n',
      '[project]\nname = "deepseek-harness-sdk"\ndependencies = ["DeepSeek.Harness_Runtime-Bin", "deepseek-unrelated"]\n',
    ]
    expect(() => collectPythonDependencies(pyprojects)).toThrow(
      'python dependency deepseek-unrelated is missing from PYTHON_METADATA',
    )
  })
})

describe('isPermissive', () => {
  it('accepts the licenses this project ships and rejects copyleft or unknown ones', () => {
    expect(['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0', 'MIT / Apache-2.0', '(MIT OR CC0-1.0)'].every(isPermissive)).toBe(true)
    expect([
      'LGPL-3.0-only',
      'MPL-2.0',
      'GPL-3.0-or-later',
      'SEE LICENSE IN LICENSE',
      'SEE LICENSE IN README.md',
      'SEE LICENSE IN LICENSE.md',
    ].some(isPermissive)).toBe(false)
  })

  it('requires every operand of an AND, so a copyleft conjunct cannot ride along', () => {
    expect(isPermissive('(MIT OR Apache-2.0) AND GPL-3.0-only')).toBe(false)
    expect(isPermissive('MIT AND ISC')).toBe(true)
    // An exception clause is not a recognized identifier, so it fails closed.
    expect(isPermissive('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false)
  })

  it('honors grouping and SPDX precedence', () => {
    expect(isPermissive('MIT OR (GPL-3.0-only AND GPL-2.0-only)')).toBe(true)
    expect(isPermissive('(MIT OR Apache-2.0) AND ISC')).toBe(true)
  })

  it('fails closed for malformed expressions, additions, and exceptions', () => {
    expect(['MIT)', '((MIT', '(MIT OR GPL-3.0-only', 'MIT OR OR GPL-3.0-only'].some(isPermissive)).toBe(false)
    expect(isPermissive('MIT+')).toBe(false)
    expect(isPermissive('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false)
  })
})

describe('official Claude distribution authorization', () => {
  it('authorizes only the direct SDK identity without relabeling its license', () => {
    expect(isOwnerAuthorizedRuntime(CLAUDE_AGENT_SDK_PACKAGE)).toBe(true)
    expect(isOwnerAuthorizedRuntime(`${CLAUDE_AGENT_SDK_PACKAGE}-linux-x64`))
      .toBe(false)
    expect(isOwnerAuthorizedRuntime('@anthropic-ai/unrelated')).toBe(false)
    expect(isPermissive('SEE LICENSE IN README.md')).toBe(false)
  })

  it('derives version-independent platform payloads from the official SDK manifest', () => {
    expect(claudeDistributionFromManifest({
      name: CLAUDE_AGENT_SDK_PACKAGE,
      version: '9.8.7',
      license: 'future declared terms',
      claudeCodeVersion: '6.5.4',
      optionalDependencies: {
        [`${CLAUDE_AGENT_SDK_PACKAGE}-linux-x64`]: '9.8.7',
        [`${CLAUDE_AGENT_SDK_PACKAGE}-darwin-arm64`]: '9.8.7',
      },
    })).toEqual({
      sdkVersion: '9.8.7',
      claudeCodeVersion: '6.5.4',
      payloads: [
        {
          name: `${CLAUDE_AGENT_SDK_PACKAGE}-darwin-arm64`,
          version: '9.8.7',
        },
        {
          name: `${CLAUDE_AGENT_SDK_PACKAGE}-linux-x64`,
          version: '9.8.7',
        },
      ],
    })
  })

  it('rejects a wrong SDK identity, missing payloads, and unrelated optionals', () => {
    expect(() => claudeDistributionFromManifest({
      name: '@anthropic-ai/unrelated',
      version: '1.0.0',
      claudeCodeVersion: '1.0.0',
      optionalDependencies: {
        [`${CLAUDE_AGENT_SDK_PACKAGE}-linux-x64`]: '1.0.0',
      },
    })).toThrow(`expected ${CLAUDE_AGENT_SDK_PACKAGE} manifest`)
    expect(() => claudeDistributionFromManifest({
      name: CLAUDE_AGENT_SDK_PACKAGE,
      version: '1.0.0',
      claudeCodeVersion: '1.0.0',
    })).toThrow('declares no optional platform payloads')
    expect(() => claudeDistributionFromManifest({
      name: CLAUDE_AGENT_SDK_PACKAGE,
      version: '1.0.0',
      claudeCodeVersion: '1.0.0',
      optionalDependencies: {
        '@anthropic-ai/unrelated': '1.0.0',
      },
    })).toThrow('outside its authorized platform-payload identity')
  })
})

describe('manifestPatterns', () => {
  it('derives globs from the declared members, so a new member area is read', () => {
    expect(manifestPatterns(['packages/*/*', 'tools/*', 'native/system', 'native/system/packages/*'])).toEqual([
      'package.json',
      'packages/*/*/package.json',
      'tools/*/package.json',
      'native/system/package.json',
      'native/system/packages/*/package.json',
    ])
  })
})
