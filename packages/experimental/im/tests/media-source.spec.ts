import { describe, expect, it } from 'vitest'
import { admitMediaSource, isPublicAddress, RefusedSourceError, type HostResolver } from '../src/media-source.ts'

/** Both switches off: a received message fetches what the platform hands it and nothing else. */
const REFUSING = { file: false, internal: false }

/** Both switches on: the deployment accepts what a chat member names. */
const ACCEPTING = { file: true, internal: true }

/** A resolver over a fixed host table; any other name fails like DNS would. */
function resolving(table: Record<string, readonly string[]>): HostResolver {
  return async (hostname) => {
    const addresses = table[hostname]
    if (addresses === undefined) throw new Error(`no such host: ${hostname}`)
    return addresses
  }
}

const PUBLIC_MEDIA_HOST = 'media.example'

describe('isPublicAddress', () => {
  it('accepts addresses that belong to nobody in particular', () => {
    for (const address of [
      '93.184.216.34',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '64:ff9b::5db8:d822',
      // Teredo `2001::/32` carrying 93.184.216.34 (`5db8:d822` XOR `ffff:ffff` = `a247:27dd`).
      '2001:0:4136:e378:8000:63bf:a247:27dd',
      '2002:5db8:d822::1',
      '::5db8:d822',
    ]) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('refuses loopback, private, link-local, carrier-grade NAT and multicast addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.100.100',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      // IPv6 forms that route to an embedded IPv4 address, plus the RFC 8215 local-use NAT64 `64:ff9b:1::/48` range
      // (which allows `/48`–`/96` translation prefixes such as `/64`-encoded 127.0.0.1 `64:ff9b:1:0:7f:0:100:0`).
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::127.0.0.1',
      '64:ff9b:1:ff::5db8:d822',
      '64:ff9b:1:ff::a9fe:a9fe',
      '64:ff9b:1::7f00:1',
      '64:ff9b:1:0:7f:0:100:0',
      // Teredo `2001::/32` carrying 10.0.2.3 (`0a00:0203` XOR `ffff:ffff` = `f5ff:fdfc`) and 127.0.0.1 (`80ff:fffe`).
      '2001:0:4136:e378:8000:63bf:f5ff:fdfc',
      '2001::ffff:ffff:80ff:fffe',
      '2002:7f00:1::',
      '2002:a9fe:a9fe:1::1',
      '::127.0.0.1',
      '::a00:1',
      'fec0::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('refuses a value that is not an address at all', () => {
    expect(isPublicAddress('media.example')).toBe(false)
  })
})

describe('admitMediaSource', () => {
  const resolve = resolving({ [PUBLIC_MEDIA_HOST]: ['93.184.216.34'], metadata: ['169.254.169.254'] })
  const receiver = { platform: 'lark', selfId: 'ou_bot' }
  const at = { timeout: 1000, resolve, receiver }

  it('accepts inline sources, a public host, and a resource of the receiving bot', async () => {
    for (const src of [
      'satori:lark/ou_bot/messages/om_1/resources/file_1?type=image',
      'data:image/png;base64,iVBORw0KGgo=',
      'base64://iVBORw0KGgo=',
      `https://${PUBLIC_MEDIA_HOST}/a.png`,
    ]) {
      await expect(admitMediaSource(src, REFUSING, at), src).resolves.toBeUndefined()
    }
  })

  it('refuses a file: source a chat member named, naming the switch that would accept it', async () => {
    const src = 'file:///home/u/.ssh/id_rsa'
    await expect(admitMediaSource(src, REFUSING, at)).rejects.toThrow(RefusedSourceError)
    await expect(admitMediaSource(src, REFUSING, at)).rejects.toThrow('media.source.file')
    await expect(admitMediaSource(src, ACCEPTING, at)).resolves.toBeUndefined()
  })

  it('refuses a non-public address a chat member named', async () => {
    for (const src of [
      'http://127.0.0.1:8080/status',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x.png',
      'http://[::1]/x.png',
      'http://[::ffff:127.0.0.1]/x.png',
    ]) {
      await expect(admitMediaSource(src, REFUSING, at), src).rejects.toThrow(RefusedSourceError)
    }
  })

  it('refuses a name that resolves to a non-public address, and accepts it once internal is on', async () => {
    const src = 'http://metadata/computeMetadata/v1/'
    await expect(admitMediaSource(src, REFUSING, at)).rejects.toThrow('non-public address')
    await expect(admitMediaSource(src, ACCEPTING, at)).resolves.toBeUndefined()
  })

  it('refuses a name when any of its addresses is non-public', async () => {
    const split = resolving({ mixed: ['93.184.216.34', '10.0.0.5'] })
    await expect(admitMediaSource('https://mixed/x.png', REFUSING, { ...at, resolve: split })).rejects.toThrow('10.0.0.5')
  })

  it('refuses localhost through the system resolver', async () => {
    // The default resolver, not a stub: a name that only ever points at this host is refused like the literal address.
    await expect(admitMediaSource('http://localhost/x.png', REFUSING, { timeout: 5000 })).rejects.toThrow('non-public address')
    await expect(admitMediaSource('http://localhost/x.png', ACCEPTING, { timeout: 5000 })).resolves.toBeUndefined()
  })

  it('refuses a name it cannot classify instead of leaving the decision to the fetch', async () => {
    // The fetch resolves the name again; a resolver that answers differently then is the case this rule cannot judge.
    await expect(admitMediaSource('https://nowhere.example/x.png', REFUSING, at)).rejects.toThrow('did not resolve')
  })

  it('refuses a host whose lookup outlives the deadline', async () => {
    const hanging: HostResolver = () => new Promise(() => {})
    await expect(admitMediaSource('https://slow.example/x.png', REFUSING, { timeout: 10, resolve: hanging })).rejects.toThrow('did not resolve')
  })

  it('aborts a hanging host lookup immediately when the caller signal fires', async () => {
    const hanging: HostResolver = () => new Promise(() => {})
    const controller = new AbortController()
    const pending = admitMediaSource('https://slow.example/x.png', REFUSING, {
      timeout: 30_000,
      resolve: hanging,
      signal: controller.signal,
    })
    controller.abort(new Error('cancelled by user'))
    await expect(pending).rejects.toThrow('cancelled by user')

    await expect(admitMediaSource('https://slow.example/x.png', REFUSING, {
      timeout: 30_000,
      resolve: hanging,
      signal: controller.signal,
    })).rejects.toThrow('cancelled by user')
  })

  it('refuses a satori: resource of another bot, and every one when the receiver is unknown', async () => {
    for (const src of [
      'satori:lark/ou_other/messages/om_1/resources/file_1?type=image',
      'satori:qq/ou_bot/messages/om_1/resources/file_1',
      'satori:lark/ou_bot_2/images/img_1',
    ]) {
      await expect(admitMediaSource(src, ACCEPTING, at), src).rejects.toThrow('not a resource of the bot that received')
    }
    const own = 'satori:lark/ou_bot/images/img_1'
    await expect(admitMediaSource(own, ACCEPTING, { timeout: 1000, resolve })).rejects.toThrow(RefusedSourceError)
  })

  it('refuses a scheme and a source it cannot parse', async () => {
    await expect(admitMediaSource('ftp://files.example/x.png', REFUSING, at)).rejects.toThrow('scheme')
    await expect(admitMediaSource('', REFUSING, at)).rejects.toThrow('is not a URL')
    await expect(admitMediaSource('not a url', REFUSING, at)).rejects.toThrow('is not a URL')
  })

  it('keeps a diagnostic short for a source that carries megabytes', async () => {
    const src = `data:image/png;base64,${'A'.repeat(4096)}`
    await expect(admitMediaSource(src, REFUSING, at)).resolves.toBeUndefined()
    await expect(admitMediaSource('file:///' + 'a'.repeat(4096), REFUSING, at))
      .rejects.toThrow(/^file:\/\/\/a+… names a path/)
  })
})
