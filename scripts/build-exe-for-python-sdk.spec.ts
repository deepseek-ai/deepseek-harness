import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = resolve(root, 'scripts/build-exe-for-python-sdk.ts')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedPnpmEnvironment(env),
  })
}

describe('Python runtime executable builder CLI', () => {
  it('keeps the single-file dispatcher on the Python packaging surface', () => {
    const bootstrapPath = resolve(root, 'python/sdk-runtime/runtime-bootstrap.mjs')
    const bootstrap = readFileSync(bootstrapPath, 'utf8')
    const cliConfig = readFileSync(resolve(root, 'apps/cli/tsdown.config.ts'), 'utf8')
    const cliTsconfig = readFileSync(resolve(root, 'apps/cli/tsconfig.json'), 'utf8')
    const cliManifest = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const runtimeManifest = JSON.parse(readFileSync(resolve(root, 'python/sdk-runtime/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(existsSync(resolve(root, 'apps/cli/src/runtime-bootstrap.ts'))).toBe(false)
    expect(cliConfig).not.toContain('runtime-bootstrap')
    expect(cliConfig).toContain("clean: ['lib/*.js']")
    expect(cliTsconfig).not.toContain('packages/subprocess/subprocess-local')
    expect(cliManifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subprocess-local')
    expect(cliManifest.devDependencies).toHaveProperty('@deepseek-ai/dsh-subprocess-local')
    expect(runtimeManifest.dependencies).toHaveProperty('@deepseek-ai/dsh-subprocess-local')
    expect(bootstrap).toContain("import('@deepseek-ai/dsh/lib/bin.js')")
    expect(bootstrap).toContain('await runCli()')
    expect(bootstrap).toContain("import('@deepseek-ai/dsh-subprocess-local/runner')")
    expect(bootstrap).toContain('await runSelectedSubprocessRunner(selection)')
  })

  it('runs pnpm through its JavaScript entrypoint without a command shell', () => {
    const result = run(
      { npm_execpath: 'C:\\tools\\pnpm.cjs' },
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${process.execPath} C:\\tools\\pnpm.cjs run verify-runtime-closure`)
    expect(result.stdout).toContain(`${process.execPath} C:\\tools\\pnpm.cjs --filter dsh-python-runtime-closure deploy`)
    expect(result.stdout).not.toContain(resolve(root, 'python/sdk-runtime/runtime-bootstrap.mjs'))
    expect(result.stdout).toContain('"bin":"runtime-bootstrap.mjs"')
    expect(result.stdout).toContain(`${process.execPath} C:\\tools\\pnpm.cjs exec pkg`)
    expect(result.stdout).not.toMatch(/pnpm\.cmd/i)
  })

  it('resolves the pnpm package behind a Windows command shim', () => {
    const setup = mkdtempSync(join(tmpdir(), 'dsh-pnpm-home-'))
    temporaryDirectories.push(setup)
    const home = join(setup, 'node_modules', '.bin')
    const entrypoint = join(setup, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
    mkdirSync(home, { recursive: true })
    mkdirSync(dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '')

    const result = run(
      { npm_execpath: 'C:\\tools\\pnpm.cmd', PNPM_HOME: home },
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${process.execPath} ${entrypoint} run verify-runtime-closure`)
    expect(result.stdout).not.toMatch(/pnpm\.cmd/i)
  })

  it('accepts the macOS x64 pkg target', () => {
    const result = run(
      { npm_execpath: 'C:\\tools\\pnpm.cjs' },
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-x64',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('exec pkg')
    expect(result.stdout).toContain('--sea --targets node24-macos-x64')
  })

  it('rejects a Windows arm64 product before any build step', () => {
    const result = run(
      { npm_execpath: 'C:\\tools\\pnpm.cjs' },
      '--skip-build',
      '--dry-run',
      '--targets=node24-win-arm64',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Windows supports x64 only')
    expect(result.stdout).toBe('')
  })
})

function isolatedPnpmEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !['npm_execpath', 'pnpm_home'].includes(key.toLowerCase())),
  )
  return { ...environment, ...overrides }
}
