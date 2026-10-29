import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe.each(['arm64', 'x64'])('macOS %s packaging', (arch) => {
  const filename = arch === 'arm64' ? 'macos-package.yml' : 'macos-intel-package.yml'
  const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, `../.github/workflows/${filename}`), 'utf8')) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    concurrency: { group: string; 'cancel-in-progress': boolean }
    jobs: Record<string, {
      'runs-on': string[]
      env: Record<string, string>
      steps: Array<{
        id?: string
        name?: string
        if?: string
        uses?: string
        run?: string
        env?: Record<string, string>
        with?: Record<string, unknown>
      }>
    }>
  }

  it('confines signed Mac packaging to manual dispatch and a dedicated Apple Silicon runner', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.jobs.package).not.toHaveProperty('name')
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { test_release_id: { type: 'string', default: '', required: false } } })
    expect(workflow.on.workflow_dispatch).not.toHaveProperty('inputs.publish')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({ group: 'macos-desktop-package', 'cancel-in-progress': false })
    expect(workflow.jobs.package!['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'dsh-mac-package-trial'])
    const steps = workflow.jobs.package!.steps
    expect(steps.find(step => step.id === 'checkout')?.with).toMatchObject({ 'persist-credentials': false, clean: true })
    for (const step of steps) expect(step.run ?? '').not.toContain('${{ inputs.')
    const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads).toHaveLength(2)
    expect(uploads[0]?.if).toBe("always() && steps.checkout.outcome == 'success'")
    expect(uploads[1]?.if).toBe('success()')
    expect(uploads[1]?.with?.path).toBe('${{ steps.retained.outputs.directory }}/*')
    expect(uploads[1]?.with?.['compression-level']).toBe(0)
  })

  it('defaults to notarization and labels the explicit debugging option', () => {
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { skip_notarization: {
      type: 'boolean', default: false,
      description: '跳过公证和 stapling：仅限内部调试，禁止发布到 test / production 或用于自动更新；需要发布请勿勾选',
    } } })
    const steps = workflow.jobs.package!.steps
    expect(steps.filter(step => step.run?.includes('args+=(--skip-notarization)'))).toHaveLength(2)
    expect(steps.find(step => step.name === 'Retain installers for the selected mode')?.with?.name).toContain('${{ steps.settings.outputs.mode }}')
  })

  it('retains build inputs outside checkout and run-specific pnpm installations', () => {
    const env = workflow.jobs.package!.env
    expect(JSON.stringify(env)).not.toContain('runner.')
    const steps = workflow.jobs.package!.steps
    const cache = steps.find(step => step.name === 'Configure persistent package caches')!
    expect(cache.env?.DSH_DESKTOP_PACKAGE_CACHE_DIR).toBe('${{ runner.tool_cache }}/dsh-desktop-package-cache')
    expect(cache.run).toContain('PNPM_CONFIG_STORE_DIR=$DSH_DESKTOP_PACKAGE_CACHE_DIR/workspace-pnpm-store')
    expect(cache.run).toContain('DSH_DESKTOP_PACKAGE_CACHE_DIR=$DSH_DESKTOP_PACKAGE_CACHE_DIR')
    expect(steps.indexOf(cache)).toBeLessThan(steps.findIndex(step => step.name === 'Install locked dependencies'))
  })

  it('offers ZIP compression choices with a fast default', () => {
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { compression_level: {
      type: 'choice', options: ['3', '7'], default: '3', required: true,
    } } })
    expect(workflow.jobs.package!.env.PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL).toBe('${{ inputs.compression_level }}')
  })

  it('passes the same target to preparation, packaging and retention', () => {
    const job = workflow.jobs.package!
    expect(job.env.DSH_DESKTOP_TARGET_PLATFORM).toBe('darwin')
    expect(job.env.DSH_DESKTOP_TARGET_ARCH).toBe(arch)
    const builds = job.steps.filter(step => step.run?.includes('pnpm run package:desktop:mac:'))
    expect(builds).toHaveLength(2)
    for (const step of builds) expect(step.run).toContain(`package:desktop:mac:${arch}`)
    expect(job.steps.find(step => step.name === 'Retain installers for the selected mode')?.with?.name).toContain(`macos-${arch}-`)
    if (arch === 'x64') {
      const rosetta = job.steps.findIndex(step => step.run === 'arch -x86_64 /usr/bin/true')
      expect(rosetta).toBeGreaterThan(-1)
      expect(rosetta).toBeLessThan(job.steps.findIndex(step => step.name === 'Install locked dependencies'))
    }
  })
})
