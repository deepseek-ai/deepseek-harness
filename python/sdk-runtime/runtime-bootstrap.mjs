#!/usr/bin/env node
/** Private entry owned by the Python single-file runtime packaging. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath, pathToFileURL } from 'node:url'

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : process.platform
const resourceDirectory = join(isSea() ? dirname(process.execPath) : dirname(dirname(fileURLToPath(import.meta.url))), `${platform}-${process.arch}`)
let downloads
let cache
if (existsSync(join(resourceDirectory, 'downloads.json'))) {
  downloads = JSON.parse(await readFile(join(resourceDirectory, 'downloads.json'), 'utf8'))
  const root = process.env.DSH_RESOURCE_CACHE ?? join(homedir(), '.cache', 'deepseek-harness', 'resources')
  if (!isAbsolute(root)) throw new Error('DSH_RESOURCE_CACHE must be an absolute directory')
  if (!/^[a-f0-9]{64}$/u.test(downloads.identity)) throw new Error('runtime download manifest has an invalid cache identity')
  cache = join(root, downloads.identity)
}

/** Publish a complete immutable resource directory; overlapping downloads may share the winner. */
async function downloadResource(kind) {
  if (downloads === undefined) throw new Error('runtime download manifest is missing; rebuild or reinstall the runtime wheel')
  const destination = join(cache, kind)
  if (!existsSync(join(destination, 'complete'))) {
    await mkdir(cache, { recursive: true })
    const staging = await mkdtemp(join(cache, `.${kind}-`))
    let disposeProxy
    try {
      const { installProxyFromEnvironment } = await import('@deepseek-ai/dsh-http-proxy')
      disposeProxy = await installProxyFromEnvironment({ get(name) {
        const value = process.env[name]
        return value === undefined ? undefined : { value }
      } }, message => console.error(message))
      const { downloadNodeRuntime, preparePrimaryRuntime } = await import('./primary-runtime.mjs')
      const archives = join(cache, 'archives')
      if (kind === 'office') {
        const { downloadOfficeSidecar } = await import('./office-sidecar.mjs')
        await downloadNodeRuntime(downloads.target, join(staging, 'node'), archives)
        await downloadOfficeSidecar(downloads.office, staging, archives)
      } else {
        await preparePrimaryRuntime({ target: downloads.target, output: staging, cache: archives,
          version: downloads.version, pnpmArchive: downloads.pnpm, skillSource: join(resourceDirectory, 'office-skills') })
      }
      await writeFile(join(staging, 'complete'), downloads.identity)
      try { await rename(staging, destination) } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)
          || await readFile(join(destination, 'complete'), 'utf8') !== downloads.identity) throw error
      }
    } finally {
      try { await disposeProxy?.() } finally { await rm(staging, { recursive: true, force: true }) }
    }
  }
  if (await readFile(join(destination, 'complete'), 'utf8') !== downloads.identity) throw new Error(`runtime cache identity mismatch: ${destination}`)
  return kind === 'primary' ? join(destination, 'primary-runtime') : destination
}

const office = process.env.DSH_OFFICE_SIDECAR ?? (cache !== undefined && existsSync(join(cache, 'office', 'complete')) ? join(cache, 'office') : undefined)
if (office !== undefined) {
  if (!isAbsolute(office)) throw new Error('DSH_OFFICE_SIDECAR must be an absolute directory')
  const parentURL = pathToFileURL(join(office, 'package.json')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const kit = specifier === '@deepseek-ai/libreoffice-kit' || specifier === '@deepseek-ai/libreoffice-kit/package.json'
      return nextResolve(specifier, kit ? { ...context, parentURL } : context)
    },
  })
  process.env.DSH_BUNDLED_OFFICE_NODE = join(office, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  process.env.DSH_BUNDLED_OFFICE_CLI = join(office, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
} else if (isSea()) {
  process.env.DSH_BUNDLED_OFFICE_CLI = ''
}
if (downloads !== undefined) process.env.DSH_BUNDLED_OFFICE_SKILLS = join(resourceDirectory, 'office-skills')

const selectorName = 'DSH_SUBPROCESS_RUNNER'
const selection = process.env[selectorName]
const aclRunner = process.platform === 'win32'
  ? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  : undefined

const resource = process.env.DSH_RUNTIME_DOWNLOAD
if (resource !== undefined) {
  Reflect.deleteProperty(process.env, 'DSH_RUNTIME_DOWNLOAD')
  if (resource !== 'office' && resource !== 'primary') throw new Error('DSH_RUNTIME_DOWNLOAD must select office or primary')
  const path = await downloadResource(resource)
  console.log(JSON.stringify(path))
} else if (aclRunner !== undefined && process.argv[2] === aclRunner) {
  process.argv.splice(1, 1)
  await import('@deepseek-ai/dsh-sandbox-windows-acl/runner')
} else if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
  await import('@deepseek-ai/dsh-ptc-runtime-node/process')
} else if (selection === undefined) {
  if (cache !== undefined && existsSync(join(cache, 'primary', 'complete'))) {
    process.env.DSH_BUNDLED_PRIMARY_RUNTIME = join(cache, 'primary', 'primary-runtime')
  }
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
} else {
  Reflect.deleteProperty(process.env, selectorName)
  const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(selection)
}
