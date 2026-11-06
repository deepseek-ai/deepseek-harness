/** Host facts used to distinguish Windows interoperation from an ordinary Linux desktop. */
import { release } from 'node:os'

/** Injectable process and kernel facts; detection does not establish desktop availability. */
export interface HostEnvironmentFacts {
  platform?: string
  env?: NodeJS.ProcessEnv
  osRelease?: string
}

/**
 * Identify a Linux process running under Windows Subsystem for Linux.
 * @param facts Process and kernel facts; omitted fields use the current Host.
 * @returns Whether WSL markers are present on a Linux Host, even when interoperation is disabled.
 */
export function isWsl(facts: HostEnvironmentFacts = {}): boolean {
  if ((facts.platform ?? process.platform) !== 'linux') return false
  const env = facts.env ?? process.env
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
    || (facts.osRelease ?? release()).toLowerCase().includes('microsoft')
}
