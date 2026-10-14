/**
 * Credential recognition, masking forms, and forward-query behavior through the
 * production UserText evaluator.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextNode, UserTextRule, UserTextTransformContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '@deepseek-ai/dsh-client-ui-conversation/src/client/user-text/whitespace-rules.ts'
import { formatTables } from '../src/client/format-tables.ts'
import { createSecretRule } from '../src/client/secret-rule.ts'

// Samples are assembled at run time so the repository holds no literal in a credential format.
const hex = (length: number): string => '0123456789abcdef'.repeat(8).slice(0, length)
const mixed = (length: number): string => 'a1B2c3D4e5F6g7H8i9J0'.repeat(8).slice(0, length)
const stars = (length: number): string => '*'.repeat(length)
const join = (...parts: string[]): string => parts.join('')

function setup(rules: readonly UserTextRule[] = [createSecretRule()]) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry.createEvaluator()
}

const context: UserTextTransformContext = { read: () => undefined }
const isSecret = (node: UserTextNode): node is UserTextNode<'secret'> => node.id === 'secret'
const secrets = (text: string): UserTextNode<'secret'>[] => setup()({ text, facts: {} }).filter(isSecret)
const found = (text: string): string[] => secrets(text).map(node => text.slice(node.start, node.end))
const masks = (text: string): string[] => secrets(text).map(node => node.data.masked)

describe('secretRule recognition', () => {
  it.each([
    ['a model-service key', join('sk', '-', hex(32))],
    ['a project-scoped model-service key', join('sk', '-proj-', mixed(48))],
    ['a Google API key', join('AI', 'za', mixed(35))],
    ['a GitHub classic token', join('gh', 'p_', mixed(36))],
    ['a GitHub fine-grained token', join('github', '_pat_', mixed(22), '_', mixed(59))],
    ['a GitLab token', join('gl', 'pat-', mixed(20))],
    ['an npm token', join('np', 'm_', mixed(36))],
    ['a Hugging Face token', join('h', 'f_', mixed(34))],
    ['an AWS access key ID', join('AK', 'IA', 'ABCDEFGHIJ234567')],
    ['a temporary AWS access key ID', join('AS', 'IA', 'ABCDEFGHIJ234567')],
    ['an Alibaba Cloud AccessKey ID', join('LT', 'AI', mixed(20))],
    ['a Tencent Cloud SecretId', join('AK', 'ID', mixed(32))],
    ['a Slack token', join('xo', 'xb-', '1234567890-', mixed(24))],
    ['a Stripe secret key', join('sk', '_live_', mixed(24))],
    ['a Stripe restricted key', join('rk', '_test_', mixed(24))],
    ['a Stripe webhook secret', join('wh', 'sec_', mixed(32))],
    ['a JSON Web Token', join('ey', 'J', mixed(17), '.', 'ey', 'J', mixed(30), '.', mixed(43))],
  ])('recognizes %s inside a sentence', (_name, sample) => {
    expect(found(`用 ${sample} 试试`)).toEqual([sample])
  })

  it.each([
    ['ordinary prose', '把密码改一下，token 用量也看看，password=hunter2'],
    ['a hyphenated identifier without digits', 'sk-button-primary-large-rounded'],
    ['a key prefix that is too short', 'sk-12345'],
    ['a key prefix inside a longer word', join('task', '-', hex(32))],
    ['a commit hash', hex(40)],
    ['a UUID', '123e4567-e89b-12d3-a456-426614174000'],
  ])('leaves %s alone', (_name, text) => {
    expect(found(text)).toEqual([])
  })

  it('leaves addresses without a password alone', () => {
    expect(found('https://example.com:8080/a@b https://user@example.com/x git@github.com:o/r.git')).toEqual([])
    expect(found('https://example.com:8443?email=alice@example.org https://example.com:8443#alice@example.org')).toEqual([])
  })
})

describe('secretRule masking', () => {
  it('keeps the first eight characters of a key and masks every other character', () => {
    const key = join('sk', '-', hex(32))
    expect(masks(`${key}用这个`)).toEqual([key.slice(0, 8) + stars(27)])
  })

  it('masks only the password of an address that carries credentials', () => {
    const text = join('postgres://admin:', 'p4ss-W0rd', '@db.internal:5432/app')
    expect(found(text)).toEqual(['p4ss-W0rd'])
    expect(masks(text)).toEqual([stars(9)])
  })

  it('masks a key used as an address user name and the password after it separately', () => {
    const key = join('sk', '-', hex(32))
    const text = `https://${key}:p4ss-W0rd@api.example.com/v1`
    expect(found(text)).toEqual([key, 'p4ss-W0rd'])
    expect(masks(text)).toEqual([key.slice(0, 8) + stars(27), stars(9)])
  })

  it('masks one character per code point, so an emoji or a lone surrogate in a password is one mark', () => {
    expect(masks('postgres://u:p\u{1F642}\ud83dx@db')).toEqual([stars(4)])
  })

  it('ends a key in an address user name before the password, which a later query finds', () => {
    const key = join('sk', '-', hex(32))
    const token = join('gh', 'p_', mixed(36))
    const text = `https://${key}:p4ss-W0rd@api.example.com ${token}`
    expect(found(text)).toEqual([key, 'p4ss-W0rd', token])
  })

  it('masks an address password that has no user name', () => {
    expect(found('redis://:p4ss-W0rd@cache:6379/0')).toEqual(['p4ss-W0rd'])
  })

  it('masks a token used as an address password completely', () => {
    const token = join('gh', 'p_', mixed(36))
    const text = `git clone https://x-access-token:${token}@github.com/o/r.git`
    expect(found(text)).toEqual([token])
    expect(masks(text)).toEqual([stars(token.length)])
  })

  it('joins an overlapping later match to the earliest one and keeps its mask', () => {
    const slack = join('xo', 'xb-', '1234567890-')
    const key = join('sk', '-abc_', mixed(20))
    const text = `${slack}${key} 完`
    expect(found(text)).toEqual([slack + key])
    expect(masks(text)).toEqual([(slack + key).slice(0, 8) + stars(slack.length + key.length - 8)])
  })

  it('masks the body of a private key block and keeps its first and last lines', () => {
    const begin = join('-----BEGIN', ' OPENSSH PRIVATE KEY-----')
    const end = join('-----END', ' OPENSSH PRIVATE KEY-----')
    const block = [begin, 'b3BlbnNzaC1rZXk', 'AAAAB3NzaC1yc2E=', end].join('\n')
    const text = `私钥在这\n${block}\n帮我配一下`
    expect(found(text)).toEqual([block])
    expect(masks(text)).toEqual([[begin, stars(15), stars(16), end].join('\n')])
  })

  it('keeps carriage returns of a private key block with CRLF line endings', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = [begin, 'MIIEvQIBADANBgkq', end].join('\r\n')
    expect(masks(text)).toEqual([[begin, stars(16), end].join('\r\n')])
  })

  it('masks a private key block that is cut off before its last line', () => {
    const begin = join('-----BEGIN', ' RSA PRIVATE KEY-----')
    const text = `${begin}\nMIIEowIBAAKCAQEA`
    expect(found(text)).toEqual([text])
    expect(masks(text)).toEqual([`${begin}\n${stars(16)}`])
  })

  it.each([join('s', 'k-'), join('gl', 'pat-'), join('xo', 'xb-')])('finds a private key block whose first dash ends the key prefix %s', (prefix) => {
    const block = [join('-----BEGIN', ' RSA PRIVATE KEY-----'), 'MIIEowIBAAKCAQEA', join('-----END', ' RSA PRIVATE KEY-----')].join('\n')
    const text = `x${prefix.slice(0, -1)}${block}`
    expect(found(text)).toEqual([block])
  })

  it('masks a key longer than four thousand characters one mark per character', () => {
    const key = join('sk', '-', hex(16), 'a'.repeat(5_000))
    expect(masks(`${key} 完`)).toEqual([key.slice(0, 8) + stars(key.length - 8)])
  })

  it('joins a private key block that starts inside a key and keeps the line breaks of both', () => {
    const key = join('sk', '-', hex(20))
    const block = [join('-----BEGIN', ' RSA PRIVATE KEY-----'), 'MIIE', join('-----END', ' RSA PRIVATE KEY-----')].join('\r\n')
    const text = `${key}${block}`
    expect(found(text)).toEqual([text])
    const tail = text.slice(8).split('\r\n').map(line => stars(line.length)).join('\r\n')
    expect(masks(text)).toEqual([text.slice(0, 8) + tail])
  })

  it('masks a private key body one mark per code point, including lone and cut surrogates', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = [begin, 'a\u{1F642}b\udc00c\ud83dx\ud83d', end].join('\n')
    expect(masks(text)).toEqual([[begin, stars(8), end].join('\n')])
  })

  it('masks private key body lines longer than four thousand characters, before either line break', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = `${begin}\n${'A'.repeat(5_000)}\r\n${'B'.repeat(5_000)}\nC\n${end}`
    expect(masks(text)).toEqual([`${begin}\n${stars(5_000)}\r\n${stars(5_000)}\n${stars(1)}\n${end}`])
  })

  it('masks an address inside a private key block as part of the block', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const key = join('sk', '-', hex(32))
    const block = [begin, 'https://u:p4ss@host', key, end].join('\n')
    expect(found(`${block}\n用这个`)).toEqual([block])
  })

  it('masks each of many one-line private key blocks whole, with text after the last', () => {
    const block = join('-----BEGIN', ' PRIVATE KEY-----', 'abcd', '-----END', ' PRIVATE KEY-----')
    expect(masks(`${block} ${block} 完`)).toEqual([stars(block.length), stars(block.length)])
  })

  it('masks a private key block written on one line whole', () => {
    const text = join('-----BEGIN', ' PRIVATE KEY-----', 'MIIEvQIBADANBgkq', '-----END', ' PRIVATE KEY-----')
    expect(masks(text)).toEqual([stars(text.length)])
  })
})

describe('secretRule scheduling', () => {
  it('finds format starts through grouped literals only, so scanning cannot backtrack', () => {
    const literals = formatTables().prefixSource.replace(/\\./gu, '').replaceAll('(?:', '').replaceAll(')', '')
    expect(literals.split('|').length).toBeGreaterThan(20)
    expect(literals).not.toMatch(/[*+?{}()[\].^$]/u)
  })

  it('reads no Facts, queries forward once per credential, and reuses the result across Facts updates', () => {
    const read = vi.fn()
    const rule = createSecretRule()
    const match = vi.fn<UserTextRule<'secret'>['match']>((text, from, context) => rule.match(text, from, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const evaluate = setup([{ ...rule, match }])
    const first = join('gh', 'p_', mixed(36))
    const second = join('sk', '-', hex(32))
    const text = `${first} 和 ${second}`
    const before = evaluate({ text, facts: {} })
    expect(before.filter(isSecret).map(node => text.slice(node.start, node.end))).toEqual([first, second])
    expect(before.map(node => [node.start, node.end])).toEqual([
      [0, first.length], [first.length, first.length + 3], [first.length + 3, text.length],
    ])
    expect(match.mock.calls.map(([, from]) => from)).toEqual([0, first.length, text.length])
    expect(evaluate({ text, facts: { collapseWhitespace: true } })).toBe(before)
    expect(match).toHaveBeenCalledTimes(3)
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['postgres://admin:p4ss@db', 'redis://:p4ss@cache'])('finds the same address password in %s from any cursor before it', (text) => {
    const start = text.indexOf('p4ss')
    for (let from = 0; from <= start; from++) {
      // A fresh instance per cursor: no query earlier in the text warms its memo.
      expect(createSecretRule().match(text, from, context), `from ${String(from)}`).toEqual({ id: 'secret', start, end: start + 4, data: { masked: stars(4) } })
    }
    expect(createSecretRule().match(text, start + 1, context)).toBeUndefined()
  })

  it('keeps line breaks of a private key block when queue whitespace transforms run beside it', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const block = [begin, 'MIIEvQIBADANBgkq', end].join('\n')
    const evaluate = setup([createSecretRule(), collapseWhitespaceRule, trimWhitespaceRule])
    const nodes = evaluate({ text: `  私钥：\n${block}\n  `, facts: { collapseWhitespace: true, trimWhitespace: true } })
    const display = (node: UserTextNode): string =>
      isSecret(node) ? node.data.masked : node.id === 'text' ? node.data.display ?? node.data.text : ''
    expect(nodes.map(display).join('')).toBe(`私钥： ${[begin, stars(16), end].join('\n')}`)
  })
})
