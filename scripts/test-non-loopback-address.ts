/**
 * Address probes for concrete-bind integration cases. Interface membership
 * does not guarantee a usable address; hosts without one report why their
 * network coverage is skipped.
 */
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

/**
 * First candidate whose listener opens and closes successfully.
 * @param candidates - local IP literals to probe.
 * @param description - address category reported when no candidate can bind.
 * @returns a bindable address, or undefined when the scenario must skip.
 */
async function probeBindableAddress(candidates: string[], description: string): Promise<string | undefined> {
  const refused: string[] = []
  for (const address of candidates) {
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: address, port: 0 }, resolve)
      })
    } catch (error) {
      // A failed listen owns no socket to close.
      refused.push(`${address}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    return address
  }
  console.info(
    `${description} coverage skipped: no bindable ${description} address`
    + ` (${candidates.length === 0 ? 'this host reports none' : `refused ${refused.join('; ')}`})`,
  )
  return undefined
}

/**
 * First local non-loopback IPv4 address that really accepts a listen.
 *
 * IPv4 only: supported CI hosts need not own a non-loopback IPv6 address.
 * @returns the bindable address, or undefined when the scenario must skip.
 */
export async function probeNonLoopbackIpv4(): Promise<string | undefined> {
  const candidates: string[] = []
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry !== undefined && entry.family === 'IPv4' && !entry.internal) candidates.push(entry.address)
  }
  return probeBindableAddress(candidates, 'non-loopback IPv4')
}

/**
 * Bindable IPv6 loopback with the numeric scope reported by the OS.
 * Interface display names are not portable IPv6 zone identifiers.
 *
 * Loopback only: a link-local candidate is no substitute, because these
 * scenarios need the loopback address itself — their advertised root and Host
 * fence follow from it. A host that reports no bindable `::1` skips them.
 * @returns the zoned literal after closing its probe listener, or undefined when none can bind.
 */
export async function probeZonedLoopback(): Promise<string | undefined> {
  const candidates: string[] = []
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry !== undefined && entry.family === 'IPv6' && entry.address === '::1') {
      candidates.push(`::1%${entry.scopeid}`)
    }
  }
  return probeBindableAddress(candidates, 'zoned IPv6 loopback')
}
