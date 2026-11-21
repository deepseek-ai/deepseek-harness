import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey, ImSourceId, splitKey,
  type ImActivity, type ImConfig, type ImOutcome, type ImOutputRenderer,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { sessionIdOf } from '../src/hosting.ts'
import { IM_TOOLS } from '../src/tools.ts'
import { errorValue, imReadFileParameters, imReadImageParameters, imSendParameters } from '../src/schema.ts'

const root = join(import.meta.dirname, '..')
/** Raw operator input (schemastery types its input as the resolved config). */
const parse = (value: unknown): ImConfig => Config(value as ImConfig)

/** Every file under one directory of the package, recursively (test helpers live in subdirectories). */
function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

describe('dsh-im contracts', () => {
  it('resolves the configuration defaults', () => {
    const config = parse({ sources: [{ id: 'main', bot: 'qq:1' }] })
    expect(config.sources).toEqual([{ id: 'main', bot: 'qq:1', chats: [], users: [], writable: false, store: 'all' }])
    // A received message fetches what the platform hands it: a chat member's `file:` source and an internal address
    // are both off unless the deployment turns them on.
    expect(config.media).toEqual({
      download: true, maxBytes: 10485760, maxItems: 9, timeoutMs: 30000, source: { file: false, internal: false },
    })
    expect(config.send).toEqual({ maxMediaBytes: 10485760, operationTimeoutMs: 30000 })
    expect(config.tools).toEqual({
      readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im',
    })
    expect(config.retentionMs).toBe(30 * 86400000)
    expect(config.compositionWarnMs).toBe(30000)
    expect(parse({}).sources).toEqual([])
    expect(() => parse({ sources: [{ id: 'x' }] })).toThrow()
  })

  it('derives chat and message keys', () => {
    const chat = ImChatKey('lark:cli_a', 'oc_1')
    expect(chat).toBe('lark:cli_a|oc_1')
    expect(splitKey(chat)).toEqual({ bot: 'lark:cli_a', id: 'oc_1' })
    expect(splitKey(ImMessageKey('qq:1', 'group:a|b'))).toEqual({ bot: 'qq:1', id: 'group:a|b' })
    expect(splitKey('m' as ImMessageKey)).toEqual({ bot: '', id: 'm' })
    expect(ImSourceId('s')).toBe('s')
  })

  it('derives session ids from key and generation', () => {
    const a = sessionIdOf('conv:x', 0)
    expect(a).toMatch(/^im-[0-9a-f]{32}$/)
    expect(sessionIdOf('conv:x', 0)).toBe(a)
    expect(sessionIdOf('conv:x', 1)).not.toBe(a)
  })

  it('exposes the constants plugins rely on', () => {
    expect(IM_TOOLS).toEqual([
      'im_read', 'im_history', 'im_members', 'im_send', 'im_reply', 'im_send_file', 'im_read_image', 'im_read_file',
    ])
    expect(imSendParameters.text).toMatchObject({ type: 'string', required: true })
    expect(imReadImageParameters.id).toMatchObject({ type: 'string', required: true })
    expect(imReadFileParameters.id).toMatchObject({ type: 'string', required: true })
    expect(errorValue.properties.status).toMatchObject({ type: 'string', const: 'error', required: true })
  })

  it('type contracts compose', () => {
    const outcome: ImOutcome = { kind: 'handled', by: 'test', sessions: [SessionId('s')] }
    const renderer: ImOutputRenderer = {
      id: 'probe',
      begin: (activity: ImActivity) => ({ update: () => {}, end: async () => { void activity } }),
    }
    expect(outcome.kind).toBe('handled')
    expect(Object.keys(renderer.begin({} as ImActivity, {} as never))).toEqual(['update', 'end'])
  })

  it('imports no platform adapter', () => {
    const targets = ['package.json', 'tsconfig.json', ...['src', 'tests'].flatMap(dir => files(dir))]
    const adapter = new RegExp(['cordis-plugin-im', 'adapter-'].join('-'))
    for (const file of targets) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(adapter)
    }
  })
})
