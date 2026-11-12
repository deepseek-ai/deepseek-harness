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
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
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

  it('accepts the sources whose bytes come from this deployment', async () => {
    for (const src of [
      'satori:attachment/1',
      'data:image/png;base64,iVBORw0KGgo=',
      'base64://iVBORw0KGgo=',
      `https://${PUBLIC_MEDIA_HOST}/a.png`,
    ]) {
      await expect(admitMediaSource(src, REFUSING, resolve), src).resolves.toBeUndefined()
    }
  })

  it('refuses a file: source a chat member named, naming the switch that would accept it', async () => {
    const src = 'file:///home/u/.ssh/id_rsa'
    await expect(admitMediaSource(src, REFUSING, resolve)).rejects.toThrow(RefusedSourceError)
    await expect(admitMediaSource(src, REFUSING, resolve)).rejects.toThrow('media.source.file')
    await expect(admitMediaSource(src, ACCEPTING, resolve)).resolves.toBeUndefined()
  })

  it('refuses a non-public address a chat member named', async () => {
    for (const src of [
      'http://127.0.0.1:8080/status',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x.png',
      'http://[::1]/x.png',
      'http://[::ffff:127.0.0.1]/x.png',
    ]) {
      await expect(admitMediaSource(src, REFUSING, resolve), src).rejects.toThrow(RefusedSourceError)
    }
  })

  it('refuses a name that resolves to a non-public address, and accepts it once internal is on', async () => {
    const src = 'http://metadata/computeMetadata/v1/'
    await expect(admitMediaSource(src, REFUSING, resolve)).rejects.toThrow('non-public address')
    await expect(admitMediaSource(src, ACCEPTING, resolve)).resolves.toBeUndefined()
  })

  it('refuses a name when any of its addresses is non-public', async () => {
    const split = resolving({ mixed: ['93.184.216.34', '10.0.0.5'] })
    await expect(admitMediaSource('https://mixed/x.png', REFUSING, split)).rejects.toThrow('10.0.0.5')
  })

  it('refuses localhost through the system resolver', async () => {
    // The default resolver, not a stub: a name that only ever points at this host is refused like the literal address.
    await expect(admitMediaSource('http://localhost/x.png', REFUSING)).rejects.toThrow('non-public address')
    await expect(admitMediaSource('http://localhost/x.png', ACCEPTING)).resolves.toBeUndefined()
  })

  it('refuses a name it cannot classify instead of leaving the decision to the fetch', async () => {
    // The fetch resolves the name again; a resolver that answers differently then is the case this rule cannot judge.
    await expect(admitMediaSource('https://nowhere.example/x.png', REFUSING, resolve)).rejects.toThrow('did not resolve')
  })

  it('refuses a host whose lookup outlives the deadline', async () => {
    const hanging: HostResolver = () => new Promise(() => {})
    await expect(admitMediaSource('https://slow.example/x.png', REFUSING, hanging, 10)).rejects.toThrow('did not resolve')
  })

  it('refuses a scheme and a source it cannot parse', async () => {
    await expect(admitMediaSource('ftp://files.example/x.png', REFUSING, resolve)).rejects.toThrow('scheme')
    await expect(admitMediaSource('', REFUSING, resolve)).rejects.toThrow('is not a URL')
    await expect(admitMediaSource('not a url', REFUSING, resolve)).rejects.toThrow('is not a URL')
  })

  it('keeps a diagnostic short for a source that carries megabytes', async () => {
    const src = `data:image/png;base64,${'A'.repeat(4096)}`
    await expect(admitMediaSource(src, REFUSING, resolve)).resolves.toBeUndefined()
    await expect(admitMediaSource('file:///' + 'a'.repeat(4096), REFUSING, resolve))
      .rejects.toThrow(/^file:\/\/\/a+… names a path/)
  })
})
