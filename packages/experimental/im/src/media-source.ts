/**
 * Which media sources a received message may make this host fetch.
 *
 * Inbound media is chosen by whoever wrote the message, not by the session that reads it, so the two sources that reach
 * something other than the platform are refused by default: `file:` names a path of this host, and an http(s) host that
 * is (or resolves to) a loopback, private, link-local or multicast address reaches this host's network. Both refusals
 * are switchable in the deployment configuration (`media.source.file`, `media.source.internal`). A `satori:` source is a
 * platform resource the adapter downloads with the application's own credentials, so it is admitted only under the
 * route of the bot that received the message.
 *
 * Limitations:
 * - The address rule classifies the addresses one lookup returns, and the fetch it guards follows no redirect (see
 *   `ImMediaStore.fetch`), but it does not pin the connection to those addresses: the fetch resolves the name again,
 *   so a name whose answer changes between the two lookups (DNS rebinding, a zero TTL) can still reach an address this
 *   rule would have refused. A name the resolver cannot answer for within `media.timeoutMs` is refused rather than
 *   left to the fetch.
 * - Inside the receiving bot's route, a `satori:` source names any message id and resource key the application can
 *   see, including those of a chat no source admits; reaching one requires knowing both ids.
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

/** How one source is admitted. */
export interface ImMediaSourceOptions {
  /** Deadline of the address lookup of an http(s) host, in milliseconds. */
  timeout: number
  /** Address lookup of an http(s) host; the system resolver by default. */
  resolve?: HostResolver
  /**
   * The bot that received the message, whose `satori:<platform>/<selfId>/` route is the only one a `satori:` source may
   * name; without it every `satori:` source is refused.
   */
  receiver?: { platform: string; selfId: string } | undefined
  /** Cancellation of the caller; aborts an in-flight address lookup immediately instead of waiting for `timeout`. */
  signal?: AbortSignal | undefined
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

/**
 * Address ranges an http(s) source may not reach: loopback, private, link-local, carrier-grade NAT, multicast, and
 * the deprecated IPv6 site-local range. An IPv6 address that carries an IPv4 one is judged by that IPv4 address too
 * ({@link embeddedIPv4}).
 */
const NON_PUBLIC = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/**
 * Whether an address is outside every range {@link RefusedSourceError} protects.
 * @param address - an IPv4 or IPv6 address. Local-use ranges (including RFC 8215 NAT64 `64:ff9b:1::/48`) are refused
 *   directly; an IPv4-mapped address is judged by its IPv4 part, and so are the IPv6 forms that route to an embedded
 *   IPv4 address (NAT64 `64:ff9b::/96`, Teredo `2001::/32`, 6to4 `2002::/16`, IPv4-compatible `::/96`).
 * @returns false for a non-public address, and for a value that is not an address at all.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4')
  if (NON_PUBLIC.check(address, 'ipv6')) return false
  const embedded = embeddedIPv4(address)
  return embedded === undefined || !NON_PUBLIC.check(embedded, 'ipv4')
}

/**
 * The IPv4 address an IPv6 one routes to, for the forms that carry one at fixed bit positions: well-known NAT64
 * `64:ff9b::/96`, Teredo `2001::/32` (whose client IPv4 in bits 96-127 is bitwise-inverted), IPv4-compatible `::/96`
 * (`::127.0.0.1`), and 6to4 `2002::/16` (bits 16-47).
 * @param address - a valid IPv6 address.
 * @returns the embedded IPv4 address in dotted form, or undefined for an address that carries none.
 */
function embeddedIPv4(address: string): string | undefined {
  const groups = ipv6Groups(address)
  const [first = 0, second = 0, third = 0] = groups
  const [high = 0, low = 0] = groups.slice(6)
  const dotted = (a: number, b: number) => `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`
  if (first === 0x2002) return dotted(second, third)
  if (first === 0x2001 && second === 0) return dotted(high ^ 0xffff, low ^ 0xffff)
  const middle = groups.slice(2, 6).every(group => group === 0)
  if (first === 0x64 && second === 0xff9b && middle) return dotted(high, low)
  if (first === 0 && second === 0 && middle) return dotted(high, low)
  return undefined
}

/**
 * The eight 16-bit groups of a valid IPv6 address, with `::` expanded and a trailing dotted IPv4 part folded in.
 * @param address - a valid IPv6 address (as {@link isIP} reports).
 * @returns the groups, most significant first.
 */
function ipv6Groups(address: string): number[] {
  let text = address
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const parse = (part: string) => part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16))
  const front = parse(head)
  if (tail === undefined) return front
  const back = parse(tail)
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back]
}

/**
 * Refuse a media source a received message may not make this host fetch.
 * @param src - the source of one inbound media element.
 * @param policy - the deployment's switches, from `config.media.source`.
 * @param options - the lookup deadline, the resolver, the receiving bot, and optional caller cancellation (`signal`).
 * @returns a promise that resolves when the source may be fetched.
 * @throws RefusedSourceError naming the source and the switch that would accept it; rejects with `signal.reason` when
 *   caller cancellation fires (which does not mean the source was refused).
 */
export async function admitMediaSource(
  src: string,
  policy: ImMediaSourcePolicy,
  options: ImMediaSourceOptions,
): Promise<void> {
  const url = parseSource(src)
  switch (url.protocol) {
    case 'data:':
    case 'base64:':
      // The bytes travel inside the source: nothing is opened or reached.
      return
    case 'satori:':
      admitInternal(src, url, options.receiver)
      return
    case 'file:':
      if (policy.file) return
      throw new RefusedSourceError(
        `${preview(src)} names a path of this host, and a received message cannot make the host read one (media.source.file is off)`,
      )
    case 'http:':
    case 'https:':
      if (policy.internal) return
      await refuseInternal(url, options.resolve ?? systemHostResolver, options.timeout, options.signal)
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
 * Refuse a `satori:` source outside the route of the bot that received the message. The adapter downloads such a
 * resource with its application's credentials, so the route of another bot would read with that bot's.
 * @param src - the source as written, for the diagnostic.
 * @param url - the parsed source; its path starts with `<platform>/<selfId>/`.
 * @param receiver - the bot that received the message, when it is still mounted.
 */
function admitInternal(src: string, url: URL, receiver: ImMediaSourceOptions['receiver']): void {
  if (receiver !== undefined && url.pathname.startsWith(`${receiver.platform}/${receiver.selfId}/`)) return
  throw new RefusedSourceError(
    `${preview(src)} is not a resource of the bot that received this message, and a received message cannot make another bot read one`,
  )
}

/**
 * Refuse an http(s) source whose host is a non-public address, or whose addresses include one.
 * @param url - the parsed source.
 * @param resolve - address lookup of the host.
 * @param timeout - deadline of that lookup in milliseconds.
 * @returns a promise that resolves when every address the host has is public.
 */
async function refuseInternal(
  url: URL,
  resolve: HostResolver,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) === 0 ? await resolveAddresses(hostname, resolve, timeout, signal) : [hostname]
  // The fetch resolves the name again, and a resolver that answers this lookup differently then is exactly the case
  // this rule cannot classify: an unresolved name is refused rather than handed over to the fetch.
  if (addresses === undefined) {
    throw new RefusedSourceError(
      `${preview(url.href)} did not resolve, and a received message cannot make this host fetch a source it cannot classify (media.source.internal is off)`,
    )
  }
  for (const address of addresses) {
    if (isPublicAddress(address)) continue
    throw new RefusedSourceError(
      `${preview(url.href)} reaches ${address}, a non-public address, and a received message cannot make this host reach one (media.source.internal is off)`,
    )
  }
}

/**
 * Every address one host name has, or undefined when the resolver cannot name any within the deadline.
 * @param hostname - host name of the source.
 * @param resolve - the resolver to ask.
 * @param timeout - deadline of that lookup in milliseconds.
 * @returns the addresses, or undefined for a name that does not resolve in time.
 */
async function resolveAddresses(
  hostname: string,
  resolve: HostResolver,
  timeout: number,
  signal?: AbortSignal,
): Promise<readonly string[] | undefined> {
  if (signal?.aborted) throw signal.reason
  // `lookup` takes no cancellation, so the deadline and caller signal settle this call: a resolver that hangs must not
  // hold the admission (and the chat's arrival order or tool cancellation behind it) open.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((settle) => {
    timer = setTimeout(() => { settle(undefined) }, timeout)
    timer.unref()
  })
  let onAbort: (() => void) | undefined
  let aborted: Promise<never> | undefined
  if (signal !== undefined) {
    const abort = Promise.withResolvers<never>()
    onAbort = () => { abort.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    aborted = abort.promise
  }
  try {
    const racers: Promise<readonly string[] | undefined>[] = [resolve(hostname), deadline]
    if (aborted !== undefined) racers.push(aborted)
    return await Promise.race(racers)
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    // A failed lookup (no such name, a resolver error) is the same outcome as one that never answers: a name this rule
    // cannot classify, which the caller refuses whatever the cause was.
    void error
    return undefined
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/** One src shortened to fit a diagnostic (a `data:` URL can be megabytes long). */
function preview(src: string): string {
  const trimmed = src.trim()
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 120)}…`
}
