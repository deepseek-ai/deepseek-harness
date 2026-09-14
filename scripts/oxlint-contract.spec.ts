import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from 'typescript'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function runRepositoryOxlint(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, 'scripts/run-oxlint.ts', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

function runOxlint(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [oxlintCli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

function normalizedOutput(result: ReturnType<typeof runOxlint>): string {
  return `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
}

async function writeContractConfig(suffix: string): Promise<string> {
  const path = join(repositoryRoot, `.oxlintrc.contract-${suffix}.json`)
  await writeFile(path, JSON.stringify({ extends: ['./.oxlintrc.json'], ignorePatterns: [] }))
  return path
}

describe('Oxlint executable contract', () => {
  it('discovers the owning TypeScript project for every file class', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const probes = [
      ['host package source', 'packages/fs/fs-observation-policy/src', 'packages/fs/fs-observation-policy/tsconfig.json'],
      ['host package test', 'packages/fs/fs-observation-policy/tests', 'tsconfig.host.json'],
      ['client package source', 'packages/client/ui-primitives/src', 'packages/client/ui-primitives/tsconfig.json'],
      // A test under packages/client states its face in the filename, so the
      // probe carries the Client suffix to reach the Client aggregate.
      ['client package test', 'packages/client/ui-trajectory/tests', 'tsconfig.client.json', '.client.ts'],
      ['CLI profile test', 'apps/cli/tests/profiles/headless/tests', 'tsconfig.host.json'],
      ['website', 'website', 'tsconfig.host.json'],
    ] as const
    const source = `export function probePromise(): Promise<void> {
  return Promise.resolve()
}

probePromise()
`

    try {
      const paths: Array<readonly [label: string, path: string, tsconfig: string]> = []
      for (const [label, parent, tsconfig, extension = '.ts'] of probes) {
        const path = join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`)
        await writeFile(path, source)
        paths.push([label, relative(repositoryRoot, path), tsconfig])
      }
      const clientScript = 'scripts/client-bundle-purity.spec.ts'

      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        ...paths.map(([, path]) => path),
        clientScript,
      ], { OXC_LOG: 'debug' })
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      for (const [label, path, tsconfig] of paths) {
        expect(output, label).toContain(`${path.replaceAll('\\', '/')}:5:1: Promises must be awaited`)
        expect(output, `${label} project`).toContain(
          `Got tsconfig for file ${join(repositoryRoot, path).replaceAll('\\', '/')}: ${join(repositoryRoot, tsconfig).replaceAll('\\', '/')}`,
        )
      }
      expect(output.match(/typescript\(no-floating-promises\)/g)).toHaveLength(probes.length)
      expect(output, 'client aggregate script project').toContain(
        `Got tsconfig for file ${join(repositoryRoot, clientScript).replaceAll('\\', '/')}: ${join(repositoryRoot, 'tsconfig.client.json').replaceAll('\\', '/')}`,
      )
      expect(output).not.toContain('Unmatched file:')
    } finally {
      await Promise.all([
        ...probes.map(([, parent, , extension = '.ts']) =>
          rm(join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`), { force: true })),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('runs JavaScript compatibility and nursery rules', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)
    const source = `export function firstProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function secondProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function hasValue(value: string): boolean {
  return value !== undefined
}

export const longProbe = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1
`

    try {
      await writeFile(path, source)
      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      expect(output).toContain('@stylistic(max-len)')
      expect(output).toContain('sonarjs(no-identical-functions)')
      expect(output).toContain('typescript(no-unnecessary-condition)')
    } finally {
      await Promise.all([
        rm(path, { force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('keeps the complete stylistic contract in Oxlint', async () => {
    const oxlintPath = join(repositoryRoot, '.oxlintrc.json')
    const result = parseConfigFileTextToJson(oxlintPath, await readFile(oxlintPath, 'utf8'))
    if (result.error !== undefined) {
      throw new Error(flattenDiagnosticMessageText(result.error.messageText, '\n'))
    }
    const parsed = result.config as unknown
    if (!isRecord(parsed) || !isUnknownArray(parsed.overrides)) {
      throw new Error('.oxlintrc.json must contain an overrides array')
    }
    expect(parsed.ignorePatterns).toEqual(expect.arrayContaining([
      'packages/typert/generator/tests/fixtures/type-model/**',
    ]))
    const stylisticOverride = parsed.overrides.find((value: unknown) =>
      isRecord(value) && isRecord(value.rules) && '@stylistic/max-len' in value.rules)
    if (!isRecord(stylisticOverride) || !isRecord(stylisticOverride.rules)) {
      throw new Error('.oxlintrc.json must contain the @stylistic validator override')
    }
    expect(stylisticOverride.rules).toMatchObject({
      '@stylistic/indent': ['error', 2],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'as-needed', { requireForBlockBody: true }],
      '@stylistic/member-delimiter-style': ['error', {
        multiline: { delimiter: 'none' },
        singleline: { delimiter: 'semi', requireLast: false },
      }],
      '@stylistic/max-len': ['error', { code: 140, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
    })
    const typeGraphOverride = parsed.overrides.find((value: unknown) =>
      isRecord(value)
      && isUnknownArray(value.files)
      && value.files.includes('packages/typert/generator/tests/fixtures/type-model/packages/host/src/models.ts'))
    expect(typeGraphOverride).toMatchObject({
      rules: { '@stylistic/quotes': 'off' },
    })
  })

  it('checks preserved TypeGraph syntax without type-aware analysis', () => {
    const result = runOxlint([
      '--config',
      '.oxlintrc.staged.json',
      'packages/typert/generator/tests/fixtures/type-model',
    ])

    expect(result.error).toBeUndefined()
    expect(result.status, normalizedOutput(result)).toBe(0)
  })

  it('keeps repository lint workflows Oxlint-only', async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as unknown
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || !isRecord(packageJson.devDependencies)) {
      throw new Error('package.json must contain scripts and devDependencies objects')
    }

    expect(packageJson.scripts['lint:contracts-ready']).toBe('tsx scripts/run-oxlint.ts .')
    expect(packageJson.scripts['lint:fix:contracts-ready']).toBe(
      'tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json packages/typert/generator/tests/fixtures/type-model --fix && tsx scripts/run-oxlint.ts . --fix',
    )
    expect(packageJson.devDependencies).not.toHaveProperty('eslint')
    expect(packageJson.devDependencies).not.toHaveProperty('@typescript-eslint/parser')
    expect(existsSync(join(repositoryRoot, 'eslint.format.config.mjs'))).toBe(false)

    const lefthook = await readFile(join(repositoryRoot, 'lefthook.yml'), 'utf8')
    expect(lefthook).toContain('scripts/run-oxlint.ts --config .oxlintrc.staged.json --fix')
    expect(lefthook).not.toContain('node_modules/.bin/eslint')
    expect(lefthook).not.toContain('eslint.format.config.mjs')
  })

  it('reports an unused suppression', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)

    try {
      await writeFile(path, '// oxlint-disable-next-line no-console\nexport const value = 1\n')
      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(0)
      expect(output).toContain('Unused oxlint-disable directive')
    } finally {
      await Promise.all([
        rm(path, { force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('allows Session history reads only in tests or with existing-call waivers', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const exampleRoot = `examples/oxlint-contract-${suffix}`
    const examplePath = `${exampleRoot}/tests/reads.ts`
    const testPaths = [
      `packages/core/session/tests/oxlint-contract-${suffix}.ts`,
      `apps/cli/tests/oxlint-contract-${suffix}.ts`,
      examplePath,
      `scripts/oxlint-contract-${suffix}.spec.ts`,
    ]
    const productionPaths = [
      `packages/core/session/src/oxlint-contract-${suffix}.ts`,
      `scripts/oxlint-contract-${suffix}.ts`,
    ]
    const paths = [...testPaths, ...productionPaths]
    const reads = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  session.snapshotEvents()
  session.eventAt(SessionSeq(0))
  session.ownEvents()
}
`
    const existing = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.snapshotEvents()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.eventAt(SessionSeq(0))
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.ownEvents()
}
`
    const unrelated = `
/** @deprecated Use the replacement API. */
function oldApi(): void {}

export function unrelatedRead(): void {
  oldApi()
}
`

    try {
      await mkdir(join(repositoryRoot, exampleRoot, 'tests'), { recursive: true })
      await writeFile(join(repositoryRoot, exampleRoot, 'tsconfig.json'), JSON.stringify({
        extends: '../../tsconfig.base.json',
        include: ['tests/**/*.ts'],
      }))
      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), existing)),
      ])
      const args = ['--config', relative(repositoryRoot, configPath), '--format', 'unix', ...paths]
      const allowed = runRepositoryOxlint(args)
      expect(allowed.error).toBeUndefined()
      expect(allowed.signal).toBeNull()
      expect(allowed.status, normalizedOutput(allowed)).toBe(0)

      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads + unrelated)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
      ])
      const rejected = runRepositoryOxlint(args)
      const output = normalizedOutput(rejected)
      expect(rejected.error).toBeUndefined()
      expect(rejected.signal).toBeNull()
      expect(rejected.status, output).toBe(1)
      const diagnostics = output.split('\n').filter(line => /:\d+:\d+: `\w+` is deprecated\./.test(line))
      for (const path of testPaths) {
        const reported = diagnostics.filter(line => line.startsWith(`${path}:`))
        expect(reported, output).toHaveLength(1)
        expect(reported[0]).toContain('`oldApi` is deprecated')
      }
      for (const path of productionPaths) {
        expect(diagnostics.filter(line => line.startsWith(`${path}:`)), output).toHaveLength(3)
      }
      for (const method of ['snapshotEvents', 'eventAt', 'ownEvents', 'oldApi']) {
        expect(output).toContain(`\`${method}\` is deprecated`)
      }
      expect(output).toContain(
        'See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).',
      )
    } finally {
      await Promise.all([
        ...paths.filter(path => path !== examplePath).map(path => rm(join(repositoryRoot, path), { force: true })),
        rm(join(repositoryRoot, exampleRoot), { recursive: true, force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('accepts an ignored-only staged selection', () => {
    const result = runOxlint([
      '--fix',
      '--no-error-on-unmatched-pattern',
      'scripts/install-lefthook.mjs',
    ])

    expect(result.error).toBeUndefined()
    expect(result.status, normalizedOutput(result)).toBe(0)
  })

  it('keeps staged validation project-free while preserving source rules', async () => {
    const configPath = join(repositoryRoot, '.oxlintrc.staged.json')
    const result = parseConfigFileTextToJson(configPath, await readFile(configPath, 'utf8'))
    if (result.error !== undefined) {
      throw new Error(flattenDiagnosticMessageText(result.error.messageText, '\n'))
    }
    const stagedConfig = result.config as unknown
    if (!isRecord(stagedConfig)) throw new Error('.oxlintrc.staged.json must contain a config object')
    expect(stagedConfig).toMatchObject({
      extends: ['./.oxlintrc.json'],
      options: { typeAware: false },
    })
    expect(stagedConfig.ignorePatterns).not.toContain('packages/typert/generator/tests/fixtures/type-model/**')

    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)
    try {
      await writeFile(path, 'export const value={answer:1};\n')
      const lint = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(lint)

      expect(lint.error).toBeUndefined()
      expect(lint.status, output).toBe(1)
      expect(output).toContain('@stylistic')
      expect(output).not.toContain('typescript(')
    } finally {
      await rm(path, { force: true })
    }
  })

  it('preserves successful fix output channels', async () => {
    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)

    try {
      await writeFile(path, '// oxlint-disable-next-line no-console\nexport const value = 1\n')
      const result = runRepositoryOxlint([
        '--config',
        '.oxlintrc.staged.json',
        '--format',
        'unix',
        '--fix',
        relative(repositoryRoot, path),
      ])

      expect(result.error).toBeUndefined()
      expect(result.status, normalizedOutput(result)).toBe(0)
      expect(result.stdout).toContain('Unused oxlint-disable directive')
      expect(result.stderr).toBe('')
    } finally {
      await rm(path, { force: true })
    }
  })

  it('prints only the final diagnostics when a fix retry still fails', async () => {
    const suffix = randomUUID()
    const path = join(repositoryRoot, 'scripts', `staged-lint-probe-${suffix}.ts`)

    try {
      await writeFile(path, `export const longProbe = ${'1 + '.repeat(80)}1\n`)
      const result = runRepositoryOxlint([
        '--config',
        '.oxlintrc.staged.json',
        '--format',
        'unix',
        '--fix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      expect(output.match(/@stylistic\(max-len\)/g)).toHaveLength(1)
    } finally {
      await rm(path, { force: true })
    }
  })

  it.each(['--fix', '--fix-suggestions', '--fix-dangerously'])(
    'converges overlapping staged stylistic fixes through Oxlint under %s',
    async (fixFlag) => {
      const suffix = randomUUID()
      const directory = join(repositoryRoot, 'scripts', `.oxlint-contract-${suffix}`)
      const path = join(directory, 'fix.ts')

      try {
        await mkdir(directory, { recursive: true })
        await writeFile(path, 'const value={answer:1};  \nconsole.log(value)\n')

        const relativePath = relative(repositoryRoot, path)
        const lintResult = runRepositoryOxlint(['--config', '.oxlintrc.staged.json', fixFlag, relativePath])

        expect(lintResult.error).toBeUndefined()
        expect(lintResult.status, normalizedOutput(lintResult)).toBe(0)
        expect(normalizedOutput(lintResult)).not.toContain('@stylistic')
        await expect(readFile(path, 'utf8')).resolves.toBe('const value={ answer:1 }\nconsole.log(value)\n')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    90_000,
  )
})
