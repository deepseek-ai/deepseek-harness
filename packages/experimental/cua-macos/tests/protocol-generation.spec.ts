/** Native admission artifacts follow the model schema without exposing Host-only operations. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { renderNativeProtocol } from '../native/generate-protocol.ts'
import { Request } from '@deepseek-ai/dsh-cua/protocol'

describe('native protocol generation', () => {
  it('keeps native JSON Schema and Swift admission tables current', async () => {
    const generated = renderNativeProtocol()
    expect(await readFile(new URL('../native/protocol.schema.json', import.meta.url), 'utf8')).toBe(generated.json)
    expect(await readFile(new URL('../native/Sources/CuaNative/NativeProtocol.generated.swift', import.meta.url), 'utf8')).toBe(generated.swift)
  })

  it.each([
    { method: 'getState', params: { appHandle: 'app', maxElements: 1 } },
    { method: 'drag', params: { appHandle: 'app', windowId: 1, fromX: 1, fromY: 1, toX: 2, toY: 2, steps: 1 } },
    { method: 'paste', params: { appHandle: 'app', text: 'text', maxClipboardBytes: 1024 } },
    { method: 'paste', params: { appHandle: 'app', text: 'text', pasteReadTimeoutMs: 1000 } },
    { method: 'findApps', params: { query: 'Editor', maxAppMatches: 1 } },
    { method: 'launchApp', params: { appHandle: 'pending' } },
  ])('rejects Host-only request data at model admission: $method', (request) => {
    expect(Request.safeParse(request).success).toBe(false)
  })
})
