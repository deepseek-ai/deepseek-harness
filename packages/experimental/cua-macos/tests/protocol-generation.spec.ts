/** Native admission artifacts follow the model schema without exposing Host-only operations. */
import { readFile } from 'node:fs/promises'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { renderNativeProtocol } from '../native/generate-protocol.ts'
import { Request } from '@deepseek-ai/dsh-cua/protocol'

describe('native protocol generation', () => {
  it('keeps native JSON Schema and Swift admission tables current', async () => {
    const generated = renderNativeProtocol()
    expect(await readFile(new URL('../native/protocol.schema.json', import.meta.url), 'utf8')).toBe(generated.json)
    expect(await readFile(new URL('../native/Sources/CuaNative/NativeProtocol.generated.swift', import.meta.url), 'utf8')).toBe(generated.swift)
  })

  it('resolves recursive JSON arguments in the complete native request schema', () => {
    const validate = new Ajv2020().compile(JSON.parse(renderNativeProtocol().json))
    const target = { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' }
    const value = { values: [null, { nested: [false, 7] }] }
    expect(validate({ id: 'value', method: 'setValue', params: { ...target, value } })).toBe(true)
    expect(validate({ id: 'action', method: 'performAction', params: { ...target, action: 'AXTextArea.AXValue.Set', argument: value } })).toBe(true)
    expect(validate({ id: 'invalid', method: 'setValue', params: target })).toBe(false)
  })

  it('enforces macOS tree budgets at native admission', () => {
    const validate = new Ajv2020().compile(JSON.parse(renderNativeProtocol().json))
    const read = (maxElements: number, maxDepth: number) => ({
      id: 'tree', method: 'getState', params: { appHandle: 'app', maxElements, maxDepth },
    })
    expect(validate(read(100000, 512))).toBe(true)
    expect(validate(read(100001, 512))).toBe(false)
    expect(validate(read(100000, 513))).toBe(false)
  })

  it('rejects a key array at both model and native pressKey admission', () => {
    const request = { method: 'pressKey', params: { appHandle: 'app', key: ['w', 'd'] } }
    expect(Request.safeParse(request).success).toBe(false)
    const validate = new Ajv2020().compile(JSON.parse(renderNativeProtocol().json))
    expect(validate({ id: 'shortcut', ...request })).toBe(false)
  })

  it.each([
    { method: 'drag', params: { appHandle: 'app', windowId: '1', fromX: 1, fromY: 1, toX: 2, toY: 2, steps: 1 } },
    { method: 'paste', params: { appHandle: 'app', text: 'text', maxClipboardBytes: 1024 } },
    { method: 'paste', params: { appHandle: 'app', text: 'text', pasteReadTimeoutMs: 1000 } },
    { method: 'mouseMove', params: { appHandle: 'app', windowId: '1', x: 0, y: 0, allowSystemPointer: true } },
    { method: 'findApps', params: { query: 'Editor', maxAppMatches: 1 } },
    { method: 'releaseHeldKeys', params: { runId: 'execution' } },
    { method: 'launchApp', params: { appHandle: 'pending' } },
    { method: 'applicationIcons', params: { paths: ['/Applications/Fixture.app'] } },
    { method: 'permissionStatus', params: {} },
    { method: 'requestPermission', params: { permission: 'accessibility' } },
    { method: 'openPermissionSettings', params: { permission: 'screenRecording' } },
  ])('rejects Host-only request data at model admission: $method', (request) => {
    expect(Request.safeParse(request).success).toBe(false)
  })
})
