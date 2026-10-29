import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview', {
    'runs-on': string
    steps: Array<{ name?: string; uses?: string; run?: string; if?: string; 'continue-on-error'?: boolean; with?: Record<string, unknown>; env?: Record<string, string> }>
  }>
}
const preview = workflow.jobs.preview

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview'])
    // The required outcome is the build, so the lane runs on four vCPUs; the
    // hosted label stays as the fallback when the Blacksmith pool is not chosen.
    expect(preview['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    expect(preview['runs-on']).toContain("'ubuntu-24.04'")
    expect(preview['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v7.0.1')?.with).toEqual({ 'persist-credentials': false })
  })

  it('fails the check only for build failures and warns about publication', () => {
    const byName = (name: string) => preview.steps.find(step => step.name === name)
    for (const name of ['Build workspace and check aggregate programs', 'Build the preview page and pack the VFS image', 'Shape the upload']) {
      expect(byName(name)?.['continue-on-error'], `${name} must stay blocking`).toBeUndefined()
    }
    for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) {
      expect(byName(name)?.['continue-on-error'], `${name} must warn instead of failing`).toBe(true)
    }
    const report = byName('Report preview publication failures')
    expect(report?.if).toBe("steps.upload.outcome == 'failure' || steps.verify.outcome == 'failure' || steps.comment.outcome == 'failure'")
    expect(report?.run).toContain('::warning::')
  })

  it('keeps the immutable complete artifact build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    // The complete build also runs the aggregate type checks the required
    // consumers dropped.
    expect(commands).not.toContain('pnpm run build:check')
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v6.1.0')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('retains per-PR deployment, protected image verification, and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const deploy = preview.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = preview.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = preview.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
  })
})
