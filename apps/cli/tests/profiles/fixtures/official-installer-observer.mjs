/** Observe ordinary manager operations in an installed Web profile without starting native agents. */
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const name = 'official-installer-observer'
export const inject = ['pluginManager', 'agentPresets', 'subagents', 'sessions', 'appReady']

let lastStage = 'none'

/** Report one stage on the child's stdout, which the test forwards when it fails. */
function note(stage) {
  lastStage = stage
  process.stdout.write(`PACKED_OFFICIAL_STEP=${stage} ${String(Date.now())}\n`)
}

// A run that never finishes must name its stage in the parent's log even when the child is killed at its deadline.
setInterval(() => { note(`stalled-at ${lastStage}`) }, 30_000).unref()

export function apply(ctx, config) {
  let active = true
  note('applied')
  const stop = ctx.appReady.onReady(() => {
    note('ready')
    void exercise(ctx, config).then(
      value => { if (active) process.stdout.write(`PACKED_OFFICIAL_RESULT=${JSON.stringify({ value })}\n`) },
      error => { if (active) process.stdout.write(`PACKED_OFFICIAL_RESULT=${JSON.stringify({ error: String(error) })}\n`) },
    )
  })
  ctx.effect(() => () => { active = false; stop() }, 'packed-official-observer')
}

function applied(stage, result) {
  if (result.application !== 'applied') throw new Error(`${stage}: ${JSON.stringify(result)}`)
}

/**
 * Run one operation under a bound, so a stalled manager operation reports what it waits for instead of
 * holding the whole child until its timeout. pnpm 11.7.0 can print its result and never exit
 * (pnpm#12297, fixed in 11.23.0); the run record names the process that stayed alive.
 * @param label - the operation being run.
 * @param operation - the manager call to await.
 * @param boundMs - the time the operation may take.
 * @param profile - the isolated profile directory the operation writes.
 * @returns The operation's own result.
 */
async function bounded(label, operation, boundMs, profile) {
  let timer
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} did not settle within ${String(boundMs)}ms`)) }, boundMs)
  })
  try {
    return await Promise.race([operation(), expiry])
  } catch (error) {
    if (!String(error).includes('did not settle')) throw error
    const locks = await readdir(profile).then(files => files.filter(file => file.endsWith('.lock')).join(',') || 'none', () => 'none')
    const record = await readFile(join(profile, '.plugin-manager', 'run.json'), 'utf8')
      .then(text => JSON.parse(text), () => undefined)
    const pid = record?.pid
    const alive = pid === undefined ? false : (() => { try { process.kill(pid, 0); return true } catch { return false } })()
    const state = alive && existsSync(`/proc/${String(pid)}/status`)
      ? await readFile(`/proc/${String(pid)}/status`, 'utf8').then(text => text.split('\n').filter(line => /^(State|Threads):/u.test(line)).join(' '), () => '')
      : ''
    const cmdline = alive && existsSync(`/proc/${String(pid)}/cmdline`)
      ? await readFile(`/proc/${String(pid)}/cmdline`, 'utf8').then(text => text.replaceAll('\0', ' ').trim().slice(0, 120), () => '')
      : ''
    throw new Error(`${String(error)}\nprofile-locks=${locks}\npnpm-run pid=${String(pid)} alive=${String(alive)} ${state} ${cmdline}`)
  } finally { clearTimeout(timer) }
}

async function exercise(ctx, config) {
  note('list-initial')
  const initial = await ctx.pluginManager.listBundles()
  note('listed-initial')
  const steps = []
  for (const name of config.packages) {
    const spec = initial.find(bundle => bundle.name === name)?.installTarget?.spec
    if (spec === undefined) throw new Error(`No catalog installation target for ${name}`)
    const options = { enabled: true, saveExact: true, registry: config.registry }
    note(`install ${name}`)
    let install = await ctx.pluginManager.installBundle(spec, options)
    const approval = install.pendingBuilds
    if (approval?.length) install = await ctx.pluginManager.installBundle(spec, { ...options, approvedBuilds: approval })
    note(`installed ${name}`)
    applied(`install ${name}`, install)
    const manifest = JSON.parse(await readFile(join(config.profile, 'package.json'), 'utf8'))
    const installed = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)
    // A transitive repository package the registry served, absent from npm at this version.
    const localDependency = JSON.parse(await readFile(join(config.profile, 'node_modules', config.localDependency, 'package.json'), 'utf8')).version
    const provider = name.endsWith('-codex') ? 'codex' : 'claude-code'
    const providerEnabled = ctx.subagents.list().includes(provider)
    const nativeDir = join(config.profile, 'node_modules', config.nativePackages[name])
    const binaryName = `${provider === 'codex' ? 'codex' : 'claude'}${process.platform === 'win32' ? '.exe' : ''}`
    const nativeBinary = (await readdir(nativeDir, { recursive: true })).find(path => basename(path) === binaryName)
    const nativeArtifact = nativeBinary !== undefined && (await stat(join(nativeDir, nativeBinary))).size > 0
    const presets = await ctx.agentPresets.list()
    const beforeUnavailable = await readFile(join(config.profile, 'package.json'), 'utf8')
    note(`unavailable ${name}`)
    const unavailable = await ctx.pluginManager.installBundle(`${name}@9999.0.0`, options)
    note(`unavailable-done ${name}`)
    const unchangedAfterUnavailable = beforeUnavailable === await readFile(join(config.profile, 'package.json'), 'utf8')
    const off = await ctx.pluginManager.setBundleEnabled(name, false)
    applied(`disable ${name}`, off)
    const disabled = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)
    const on = await ctx.pluginManager.setBundleEnabled(name, true)
    applied(`enable ${name}`, on)
    const enabled = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)
    note(`remove ${name}`)
    const removed = await bounded(`remove ${name}`, () => ctx.pluginManager.removeBundle(name), 90_000, config.profile)
    note(`removed ${name}`)
    applied(`remove ${name}`, removed)
    const absent = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)
    steps.push({ name, install, savedVersion: manifest.dependencies?.[name], installed, localDependency, providerEnabled, nativeArtifact,
      presets, unavailable, unchangedAfterUnavailable, off, disabled, on, enabled, removed, absent })
  }
  return { initial, steps, sessionCount: ctx.sessions.list().length }
}
