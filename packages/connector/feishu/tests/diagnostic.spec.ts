/** Safe projection of native account failures, including setup progress before the JSON envelope. */

import { describe, expect, it } from 'vitest'
import { commandFailure } from '../src/diagnostic.ts'

const failure = (stderr: string) => commandFailure('config-init', { exitCode: 5, stdout: 'stdout-secret', stderr })

describe('account command diagnostics', () => {
  it('keeps only allowlisted classifications after QR output, an authorization URL, and setup progress', () => {
    const envelope = {
      ok: false,
      identity: 'user-secret',
      error: {
        type: 'internal', subtype: 'sdk_error',
        message: 'keychain unavailable: keychain Set failed: open /private/secret-file: operation not permitted',
        hint: 'https://accounts.feishu.cn/?code=authorization-secret',
        detail: { app_secret: 'app-secret', access_token: 'token-secret' },
      },
    }
    expect(failure(`QR block\nhttps://open.feishu.cn/?user_code=code-secret\nApp created\n${JSON.stringify(envelope, null, 2)}\n`)).toEqual({
      command: 'config-init', exitCode: 5, type: 'internal', subtype: 'sdk_error',
    })
  })

  it.each(['keychain Set failed: operation not permitted', 'network failed', 'sensitive-token'])('does not infer a cause from the native message %s', (message) => {
    expect(failure(JSON.stringify({ ok: false, error: { type: 'internal', subtype: 'sdk_error', message } }))).toEqual({
      command: 'config-init', exitCode: 5, type: 'internal', subtype: 'sdk_error',
    })
  })

  it.each([
    '', 'permission denied secret', '{"ok":false,"error":',
    '{"ok":true,"error":{"type":"internal","subtype":"storage"}}',
    '{"ok":false}',
    '{"ok":false,"error":{"type":"secret-type","subtype":"secret-subtype"}}',
    '{"ok":false,"error":{"type":{"secret":"value"},"subtype":42}}',
  ])('omits classifications from unsupported output %#', (stderr) => {
    expect(failure(stderr)).toEqual({ command: 'config-init', exitCode: 5 })
  })

  it('keeps a known classification when the other field is unknown', () => {
    expect(failure('{"ok":false,"error":{"type":"internal","subtype":"unknown-secret"}}')).toEqual({
      command: 'config-init', exitCode: 5, type: 'internal',
    })
    expect(failure('{"ok":false,"error":{"type":"unknown-secret","subtype":"storage"}}')).toEqual({
      command: 'config-init', exitCode: 5, subtype: 'storage',
    })
  })
})
