import { describe, expect, it } from 'vitest'
import { parseBrowserAddress } from '../src/client/browser/url.ts'

const APP = 'https://dsh.example'

describe('Browser address policy', () => {
  it('normalizes host names and HTTPS addresses', () => {
    expect(parseBrowserAddress('example.com/path', APP)).toEqual({
      ok: true, target: { kind: 'https', url: 'https://example.com/path', title: 'example.com' },
    })
    expect(parseBrowserAddress('https://docs.example/a?q=1#x', APP)).toEqual({
      ok: true, target: { kind: 'https', url: 'https://docs.example/a?q=1#x', title: 'docs.example' },
    })
    expect(parseBrowserAddress('example.com:8443/path', APP)).toEqual({
      ok: true, target: { kind: 'https', url: 'https://example.com:8443/path', title: 'example.com' },
    })
  })

  it('accepts HTTP including loopback hosts', () => {
    expect(parseBrowserAddress('http://localhost:5173/app', APP)).toEqual({
      ok: true, target: { kind: 'http', url: 'http://localhost:5173/app', title: 'localhost' },
    })
    expect(parseBrowserAddress('http://127.42.0.9/', APP)).toMatchObject({ ok: true, target: { kind: 'http' } })
    expect(parseBrowserAddress('http://[::1]:8080/', APP)).toMatchObject({ ok: true, target: { kind: 'http' } })
    expect(parseBrowserAddress('http://example.com/', APP)).toEqual({
      ok: true, target: { kind: 'http', url: 'http://example.com/', title: 'example.com' },
    })
    expect(parseBrowserAddress('http://128.0.0.1/', APP)).toMatchObject({ ok: true, target: { kind: 'http' } })
    expect(parseBrowserAddress('http:/example.com/path', APP)).toEqual({
      ok: true, target: { kind: 'http', url: 'http://example.com/path', title: 'example.com' },
    })
    expect(parseBrowserAddress('https:/example.com/path', APP)).toEqual({
      ok: true, target: { kind: 'https', url: 'https://example.com/path', title: 'example.com' },
    })
  })

  it('rejects every undeclared or privileged form', () => {
    expect(parseBrowserAddress('', APP)).toEqual({ ok: false, reason: 'empty' })
    expect(parseBrowserAddress('javascript:alert(1)', APP)).toEqual({ ok: false, reason: 'protocol' })
    expect(parseBrowserAddress('https://user:secret@example.com', APP)).toEqual({ ok: false, reason: 'credentials' })
    expect(parseBrowserAddress(`${APP}/session`, APP)).toEqual({ ok: false, reason: 'application-origin' })
    expect(parseBrowserAddress(`https://${'a'.repeat(17_000)}.example`, APP)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserAddress('file:///work/index.html', APP)).toEqual({ ok: false, reason: 'protocol' })
    expect(parseBrowserAddress('file:////server/share/index.html', APP)).toEqual({ ok: false, reason: 'protocol' })
    expect(parseBrowserAddress('file:/work/index.html', APP)).toEqual({ ok: false, reason: 'protocol' })
    expect(parseBrowserAddress('ftp:/example.com/file', APP)).toEqual({ ok: false, reason: 'protocol' })
    expect(parseBrowserAddress(':::', APP)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserAddress('https://example.test', 'not an origin')).toMatchObject({ ok: true })
    expect(parseBrowserAddress('https://example.test')).toMatchObject({ ok: true })
    expect(parseBrowserAddress('https://example.test', 'null')).toMatchObject({ ok: true })
  })
})
