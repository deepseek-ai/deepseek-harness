/**
 * Which media sources a received message may make this host fetch.
 *
 * Inbound media is chosen by whoever wrote the message, not by the session that reads it, so the two sources that reach
 * something other than the platform are refused by default: `file:` names a path of this host, and an http(s) host that
 * is (or resolves to) a loopback, private, link-local or multicast address reaches this host's network. Both refusals
 * are switchable in the deployment configuration (`media.source.file`, `media.source.internal`).
 *
 * The address rule classifies the addresses one lookup returns; it does not pin the connection to them, so a name whose
 * answer changes between the lookup and the fetch is not caught here.
 */
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** What a received message may make this host fetch. */
export interface ImMediaSourcePolicy {
  /** Accept a `file:` source, which names a path of this host. */
  file: boolean
  /** Accept an http(s) source whose host is, or resolves to, a loopback, private, link-local or multicast address. */
  internal: boolean
}

/** A source a received message named but this deployment does not fetch. */
export class RefusedSourceError extends Error {
  override name = 'RefusedSourceError'
}

/**
 * The addresses one host name resolves to, as the fetch itself would resolve them.
 * @param hostname - host name of the source.
 * @returns every address the resolver reports.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

/**
 * The system resolver, used unless the caller supplies its own.
 * @param hostname - host name of the source.
 * @returns every address the resolver reports, in the order it returns them.
 */
export const systemHostResolver: HostResolver = async hostname =>
  (await lookup(hostname, { all: true, order: 'verbatim' })).map(answer => answer.address)

/** Address ranges an http(s) source may not reach: loopback, private, link-local, carrier-grade NAT, multicast. */
const NON_PUBLIC = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/**
 * Whether an address is outside every range {@link RefusedSourceError} protects.
 * @param address - an IPv4 or IPv6 address (an IPv4-mapped IPv6 address is judged by its IPv4 part).
 * @returns false for a non-public address, and for a value that is not an address at all.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Refuse a media source a received message may not make this host fetch.
 * @param src - the source of one inbound media element.
 * @param policy - the deployment's switches, from `config.media.source`.
 * @param resolve - address lookup of an http(s) host; the system resolver by default.
 * @returns a promise that resolves when the source may be fetched.
 * @throws RefusedSourceError naming the source and the switch that would accept it.
 */
export async function admitMediaSource(
  src: string,
  policy: ImMediaSourcePolicy,
  resolve: HostResolver = systemHostResolver,
): Promise<void> {
  const url = parseSource(src)
  switch (url.protocol) {
    case 'data:':
    case 'base64:':
    case 'satori:':
      // The bytes travel inside the source or come from this deployment's own stores: nothing is opened or reached.
      return
    case 'file:':
      if (policy.file) return
      throw new RefusedSourceError(
        `${preview(src)} names a path of this host, and a received message cannot make the host read one (media.source.file is off)`,
      )
    case 'http:':
    case 'https:':
      if (policy.internal) return
      await refuseInternal(url, resolve)
      return
    default:
      throw new RefusedSourceError(
        `${preview(src)} uses the "${url.protocol}" scheme, which this deployment does not fetch for a received message`,
      )
  }
}

/**
 * Parse one source into a URL, failing as a refusal rather than a parse error: the caller reports it as a skipped media
 * element like any other refusal.
 * @param src - the source of one inbound media element.
 * @returns the parsed URL.
 */
function parseSource(src: string): URL {
  try {
    return new URL(src.trim())
  } catch (error: unknown) {
    throw new RefusedSourceError(`${preview(src)} is not a URL this deployment can fetch`, { cause: error })
  }
}

/**
 * Refuse an http(s) source whose host is a non-public address, or whose addresses include one.
 * @param url - the parsed source.
 * @param resolve - address lookup of the host.
 * @returns a promise that resolves when every address the host has is public.
 */
async function refuseInternal(url: URL, resolve: HostResolver): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) === 0 ? await resolveAddresses(hostname, resolve) : [hostname]
  // A name that does not resolve here cannot be connected to either: the fetch reports its own failure.
  if (addresses === undefined) return
  for (const address of addresses) {
    if (isPublicAddress(address)) continue
    throw new RefusedSourceError(
      `${preview(url.href)} reaches ${address}, a non-public address, and a received message cannot make this host reach one (media.source.internal is off)`,
    )
  }
}

/**
 * Every address one host name has, or undefined when the resolver cannot name any.
 * @param hostname - host name of the source.
 * @param resolve - the resolver to ask.
 * @returns the addresses, or undefined for a name that does not resolve.
 */
async function resolveAddresses(hostname: string, resolve: HostResolver): Promise<readonly string[] | undefined> {
  try {
    return await resolve(hostname)
  } catch {
    // An unresolvable name is not a destination this check can classify; the fetch fails on its own.
    return undefined
  }
}

/** One src shortened to fit a diagnostic (a `data:` URL can be megabytes long). */
function preview(src: string): string {
  const trimmed = src.trim()
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 120)}…`
}
