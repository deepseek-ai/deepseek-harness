/** Contribute SSH-config aliases through the single-destination SSH provider and follow changes to the configuration. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-environment'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import * as SshEnvironment from '@deepseek-ai/dsh-environment-ssh'
import { discoverHosts } from './discover.ts'
import { DirectoryWatch } from './watch.ts'

/** Cordis plugin name. */
export const name = 'environment-ssh-config'
/** Registry populated by the SSH child providers. */
export const inject = ['environments']

/** Discovery source and common SSH-provider configuration. */
export interface Config {
  /** User SSH configuration; Include paths follow OpenSSH's user-directory rules. */
  file: string
  /** Stable prefix used before each declared Host alias. */
  handlePrefix?: string
  /** Optional alias allowlist; an empty list selects all concrete aliases. */
  hosts: string[]
  /** Milliseconds without further changes to the watched files and directories before discovery runs again. */
  debounceMs: number
  /** Common daemon and transport settings; each alias supplies host, handle, displayName and configFile. */
  ssh: Omit<Partial<SshEnvironment.Config>, 'host' | 'handle' | 'displayName' | 'configFile'>
}

/* v8 ignore next 3 -- the SSH Config object is enforced by the config-catalog gate. */
if (SshEnvironment.Config.dict === undefined) {
  throw new Error('SSH provider does not expose an object configuration schema')
}
const sharedSshFields = Object.fromEntries(
  Object.entries(SshEnvironment.Config.dict).filter(([field]) => !['host', 'handle', 'displayName', 'configFile'].includes(field)),
)
// The dictionary projection preserves the SSH schema's validation and defaults.
const sharedSshConfig = schema.object(sharedSshFields) as schema<Config['ssh']>

/** Loader configuration and defaults. */
export const Config: schema<Config> = schema.object({
  file: schema.string().default(join(homedir(), '.ssh', 'config')),
  handlePrefix: schema.string().default('ssh-'),
  hosts: schema.array(schema.string()).default([]),
  debounceMs: schema.natural().max(2_147_483_647).default(100),
  ssh: sharedSshConfig.default({}),
})
const configSchema = z.object({
  file: z.string().min(1), handlePrefix: z.string().min(1).default('ssh-'), hosts: z.array(z.string().min(1)),
  debounceMs: z.number().int().nonnegative().max(2_147_483_647),
  ssh: z.looseObject({ daemonPath: z.string().startsWith('/', 'daemonPath must be an absolute path on the destination').optional() }).default({}),
}).strict()

/**
 * Register configured aliases without connecting to their destinations, then follow changes to the configuration
 * files until the provider is disposed.
 * @param ctx - owns the SSH child providers, their registrations and the file watchers.
 * @param config - local discovery source and common SSH settings.
 * @returns when all alias configurations have been admitted and watching has started.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const parsed = configSchema.parse(config)
  for (const field of ['host', 'handle', 'displayName', 'configFile']) {
    if (field in parsed.ssh) throw new Error(`ssh.${field} is supplied by the SSH configuration provider`)
  }
  for (const field of Object.keys(parsed.ssh)) {
    if (!Object.hasOwn(sharedSshFields, field)) throw new Error(`Unknown SSH configuration field: ${field}`)
  }
  // Validate shared settings even when discovery contributes no environments.
  const { daemonPath, ...settings } = parsed.ssh
  const common = SshEnvironment.Config({ ...settings, ...daemonPath === undefined ? {} : { daemonPath }, host: 'configuration-validation' })
  const file = resolve(expandHomePath(parsed.file))
  // OpenSSH reads no user configuration when ~/.ssh/config is absent; any other configured file must exist.
  const optional = file === join(homedir(), '.ssh', 'config')
  const select = (aliases: readonly string[]): readonly string[] =>
    parsed.hosts.length === 0 ? aliases : parsed.hosts.filter(host => aliases.includes(host))
  const children = new Map<string, Fiber & PromiseLike<Fiber>>()
  let disposed = false

  /** Remove the children of unselected aliases, then add children for selected aliases whose handles are free. */
  async function reconcile(selected: readonly string[], loading: boolean): Promise<void> {
    for (const [host, child] of children) {
      if (selected.includes(host)) continue
      children.delete(host)
      if (parsed.hosts.includes(host)) ctx.logger.warn('SSH Host alias "%s" is no longer declared in %s; its environment is removed', host, file)
      await child.dispose()
    }
    for (const host of selected) {
      if (disposed) return
      const handle = ctx.environments.handle(`${parsed.handlePrefix}${host}`)
      // A handle registered by another provider stays with that provider.
      if (children.has(host) || ctx.environments.list().some(environment => environment.handle === handle)) continue
      try {
        const child = ctx.plugin(SshEnvironment, SshEnvironment.Config(Object.assign({}, common, {
          host, handle, displayName: host, configFile: file,
        })))
        children.set(host, child)
        await child
      } catch (error) {
        if (loading) throw error
        await children.get(host)?.dispose()
        children.delete(host)
        ctx.logger.warn('Cannot add SSH Host alias "%s" from %s: %s', host, file, error)
      }
    }
  }

  let watched = new Set<string>()
  const aliases = await discoverHosts(file, { optional, directories: watched })
  for (const requested of parsed.hosts) {
    if (!aliases.includes(requested)) throw new Error(`SSH Host alias "${requested}" is not declared in ${file}`)
  }
  await reconcile(select(aliases), true)

  /** Discover again; a failure keeps the current aliases and adds the directories it reached to the watched set. */
  async function reload(): Promise<void> {
    const found = new Set<string>()
    let current: readonly string[] | undefined
    let failure: unknown
    try {
      current = await discoverHosts(file, { optional, directories: found })
    } catch (error) {
      failure = error
    }
    if (disposed) return
    if (current === undefined) ctx.logger.warn('Keeping the SSH Host aliases discovered before the last change: %s', failure)
    watched = current === undefined ? new Set([...watched, ...found]) : found
    const rewatched = await watches.update(watched)
    try {
      if (current !== undefined) await reconcile(select(current), false)
    } finally {
      // A new watcher can miss a change made while it starts, so rediscover once more even when reconciling failed.
      if (rewatched) schedule()
    }
  }

  let work: Promise<unknown> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  const schedule = (): void => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      work = work.then(reload).catch((error: unknown) => {
        // The next change starts another rediscovery.
        ctx.logger.warn('SSH configuration rediscovery failed: %s', error)
      })
    }, parsed.debounceMs)
  }
  const watches = new DirectoryWatch(schedule, (directory, error) => {
    ctx.logger.warn('Cannot watch %s for SSH configuration changes: %s', directory, error)
  })
  ctx.effect(() => async () => {
    disposed = true
    clearTimeout(timer)
    try {
      await work
    } finally {
      watches.close()
    }
  }, 'environment-ssh-config.watch')
  work = watches.update(watched)
  await work
  // A change made before a new watcher started reporting, which on macOS is shortly after it is created, is read by one
  // more discovery after the debounce time; reloads that change the watched directories do the same.
  schedule()
}
