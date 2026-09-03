import { describe, expect, it } from 'vitest'
import { clearedProxyEnv, installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { workerSpawnEnv } from '../src/host.ts'

/** A proxy URL carrying credentials, the shape that must never reach model-authored code. */
const CREDENTIALED_PROXY = 'http://alice:s3cret@proxy.example:8080'

/** The launch environment of a user whose proxy needs a password. */
const CREDENTIALED = {
  get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: CREDENTIALED_PROXY } : undefined),
}

describe('workflow worker egress', () => {
  it('hands the worker no proxy configuration, credentialed or not', async () => {
    const dispose = await installProxyFromEnvironment(CREDENTIALED, () => undefined)
    try {
      const env = workerSpawnEnv()
      // The worker executes the model-authored script body, so a proxy URL that may carry
      // `user:password` must not be readable from its environment.
      for (const name of Object.keys(clearedProxyEnv())) expect(env).not.toHaveProperty(name)
      expect(env).not.toHaveProperty('NODE_USE_ENV_PROXY')
      expect(JSON.stringify(env)).not.toContain('s3cret')
    } finally {
      await dispose()
    }
  })

  it('still carries the platform temp path the worker needs on Windows', () => {
    expect(workerSpawnEnv('win32')).toHaveProperty('TMP')
  })
})
