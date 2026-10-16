import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { DesktopCosOperationError, desktopPublicationFailure } from '../scripts/desktop-publication-failure.ts'
import { DesktopPublishError } from '../scripts/desktop-publish.ts'

it('preserves actionable validation and filesystem diagnostics', () => {
  expect(desktopPublicationFailure(new DesktopPublishError('conflict', 'desktop publish: object differs: bin/app.exe'), 'upload'))
    .toMatchObject({ code: 'conflict', message: 'desktop publish: object differs: bin/app.exe' })
  expect(desktopPublicationFailure(new Error('Usage: rollback-desktop-channel.ts --record <directory>'), 'arguments').message).toContain('Usage:')
  expect(desktopPublicationFailure(Object.assign(new Error('raw'), { code: 'ENOENT', path: '/fixture/config.json' }), 'config').message)
    .toContain('/fixture/config.json')
})

it('does not retain provider bodies, unknown messages, JSON input or invalid field contents', () => {
  const result = z.object({ preset: z.enum(['test', 'production']) }).safeParse({ preset: 'fixture-secret' })
  if (result.success) throw new Error('fixture must reject')
  for (const error of [result.error, new SyntaxError('fixture-secret'), new Error('fixture-secret'),
    { code: 'AccessDenied', statusCode: 403, body: 'fixture-secret', message: 'fixture-secret' }]) {
    expect(JSON.stringify(desktopPublicationFailure(error, 'fixture'))).not.toContain('fixture-secret')
  }
  expect(desktopPublicationFailure(result.error, 'config').message).toContain('preset')
  expect(desktopPublicationFailure({ code: 'AccessDenied', statusCode: 403 }, 'upload').message).toContain('HTTP 403')
})

it('prints rollback usage through the real CLI before any audit or remote operation', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm',
    fileURLToPath(new URL('../scripts/rollback-desktop-channel.ts', import.meta.url))], { encoding: 'utf8', timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  const diagnostic = z.object({ code: z.string(), message: z.string() }).parse(JSON.parse(result.stderr))
  expect(diagnostic.code).toBe('validation')
  expect(diagnostic.message).toContain('Usage: rollback-desktop-channel.ts')
})

it('omits malformed provider receipt fields and never copies raw errors into COS diagnostics', () => {
  const error = new DesktopCosOperationError('PutObject', { code: 'AccessDenied', statusCode: 'fixture-secret',
    RequestId: 'Authorization: fixture-secret', body: 'fixture-secret', message: 'fixture-secret' })
  const failure = desktopPublicationFailure(error, 'publication')
  expect(failure).toMatchObject({ code: 'AccessDenied', operation: 'PutObject' })
  expect(failure).not.toHaveProperty('requestId')
  expect(failure).not.toHaveProperty('httpStatus')
  expect(JSON.stringify(failure)).not.toContain('fixture-secret')
})
