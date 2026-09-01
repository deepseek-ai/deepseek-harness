import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = resolve(root, 'scripts/build-exe-for-python-sdk.ts')

describe('Python runtime executable assets', () => {
  it('packages the dynamically resolved web frontend distribution', () => {
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      script,
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: 'C:\\tools\\pnpm.cjs' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*')
    expect(result.stdout).toContain('node_modules/@deepseek-ai/dsh-skill-badge/assets/**/*')
    expect(result.stdout).not.toContain('node_modules/**/*.py')
  })
})
