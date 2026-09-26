/** Run the compiled Electron main entry in a private app with local update delivery and real Host IPC. */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentProjectMetadata, createPluginProfile } from '../src/project-manager.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { desktopTargetPlatform, developmentRuntimeDirectory, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const interactive = process.argv.includes('--interactive')
if (process.argv.slice(2).some(argument => argument !== '--interactive')) throw new Error('Expected only --interactive')
const evidence = join(repo, 'apps/desktop/.desktop-build/qualification')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(evidence, 'electron-workspace-updates-'))
const application = join(root, 'app')
const project = join(application, '.desktop-build/development/project')
const profile = join(root, 'home/profiles/desktop')
const manifest = JSON.parse(await readFile(join(repo, 'apps/desktop/package.json'), 'utf8')) as { version: string }
const pnpm = JSON.parse(await readFile(join(repo, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8')) as { version: string }
try {
  const require = createRequire(import.meta.url)
  const electron = require('electron') as string
  const release = { schemaVersion: 1 as const, version: manifest.version,
    nodeVersion: execFileSync(electron, ['-p', 'process.versions.node'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }).trim(),
    pnpmVersion: pnpm.version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION }
  const target = resolveDesktopBuildTarget()
  createDevelopmentProjectMetadata(project, release)
  createPluginProfile(profile)
  await writeFile(join(project, 'desktop-runtime.json'), JSON.stringify({
    schemaVersion: 1, release, ...desktopTargetPlatform(target), files: [],
    sharedPackages: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
      .map(name => ({ name, version: manifest.version, path: `node_modules/${name}` })),
  }))
  await cp(join(repo, 'apps/desktop/lib/types'), join(application, 'lib'), { recursive: true })
  await cp(join(repo, 'apps/desktop/renderer'), join(application, 'renderer'), { recursive: true })
  for (const name of ['preload-app', 'preload-mandatory', 'preload-update-dialog']) {
    await cp(join(repo, `apps/desktop/lib/${name}.cjs`), join(application, `lib/${name}.cjs`))
  }
  await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'desktop-update-qualification', version: manifest.version, type: 'module' }))
  for (const owner of [application, project]) {
    await symlink(join(repo, 'node_modules/.pnpm/node_modules'), join(owner, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const targetRoot = join(application, '.desktop-build/targets', target)
  await mkdir(targetRoot, { recursive: true })
  await symlink(join(repo, 'apps/desktop/.desktop-build/targets', target, 'runtime'), join(targetRoot, 'runtime'),
    process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
    { insert: [{ id: 'update-control', name: new URL('../tests/fixtures/workspace-update-host.mjs', import.meta.url).href }] },
  ]))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|systemroot|windir|comspec|pathext)$/iu.test(name)))
  const child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/workspace-updates.mjs', import.meta.url)), '--lang=zh-CN',
    ...(interactive ? ['--interactive'] : [])], {
    cwd: root, env: { ...environment, DSH_HOME: join(root, 'home'), USERPROFILE: root, HOME: root,
      TEMP: root, TMP: root, TMPDIR: root, DSH_WORKSPACE_UPDATE_ROOT: root, DSH_WORKSPACE_UPDATE_TOKEN: randomUUID(),
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: developmentRuntimeDirectory(), DSH_DESKTOP_OPEN_DEVTOOLS: '0' },
    // Hiding the GUI process suppresses its first window and can suspend renderer frame callbacks.
    stdio: 'inherit', windowsHide: false,
  })
  let timedOut = false
  const timer = interactive ? undefined : setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { done({ code, signal }) })
    })
    if (timedOut || result.signal !== null || result.code !== 0) {
      throw new Error(`Workspace qualification failed: timeout=${String(timedOut)}, signal=${String(result.signal)}, exit=${String(result.code)}; evidence=${root}`)
    }
    console.log(`Electron workspace evidence: ${root}`)
  } finally { clearTimeout(timer) }
} finally { removeOwnedDirectory(application) }
