/** Pack and install a source-independent product for idle Web-profile integration tests. */
import { createRequire } from 'node:module'
import { existsSync, globSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { expect, onTestFinished } from 'vitest'
import { pnpmCommand } from '../../../../scripts/release/process.ts'
import { packedWorkspaceClosure, type WorkspacePackage } from '../../../../packages/sandbox/sandbox-local/tests/packed-workspace-closure.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/** Capture workspace dependency links without following their targets. */
async function workspaceLinks(directories: string[]): Promise<Record<string, string>> {
  const links: Record<string, string> = {}
  for (const directory of directories) {
    const modules = join(directory, 'node_modules')
    links[modules] = existsSync(modules) ? 'directory' : 'absent'
    if (!existsSync(modules)) continue
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      const path = join(modules, entry.name)
      const paths = entry.name.startsWith('@') && entry.isDirectory()
        ? (await readdir(path)).map(name => join(path, name)) : [path]
      for (const dependency of paths) {
        const stat = await lstat(dependency)
        links[dependency] = stat.isSymbolicLink() ? await readlink(dependency) : stat.isDirectory() ? 'directory' : 'file'
      }
    }
  }
  return links
}

/** Reject workspace links throughout an installed dependency tree.
 * @param directory - Installation or profile whose links must remain inside its own tree.
 */
export async function assertInstalledTree(directory: string): Promise<void> {
  const installedRoot = await realpath(directory)
  const visited = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    const resolved = await realpath(path)
    expect(resolved === installedRoot || resolved.startsWith(installedRoot + sep), `${path} escapes its installation`).toBe(true)
    if (visited.has(resolved)) return
    visited.add(resolved)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        // Removed packages can leave dangling .bin shims; those links must also stay inside the profile.
        const target = existsSync(child) ? await realpath(child) : resolve(dirname(child), await readlink(child))
        expect(target.startsWith(installedRoot + sep), `${child} escapes its installation`).toBe(true)
      } else if (entry.isDirectory()) await visit(child)
    }
  }
  await visit(directory)
}

/** Actual tarballs and an isolated installed CLI, with an initially empty Web profile. */
export interface PackedInstallation {
  temporary: string
  installation: string
  home: string
  profile: string
  archives: string
  environment: NodeJS.ProcessEnv
  tarballs: Map<string, string>
  members: Map<string, WorkspacePackage>
  externalVersions: Record<string, string>
  packageCommand: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
}

/** Build the packed product closure and additional packages without changing workspace dependency links.
 * Native confinement and Session-writing operations are outside this idle-profile fixture.
 * @param temporaryPrefix - Unique temporary-directory prefix identifying the owning test.
 * @param extraPackages - Additional workspace packages to pack without installing in the product.
 * @returns Isolated installation paths, tarballs, environment, and checked pnpm invocation.
 */
export async function createPackedInstallation(temporaryPrefix: string, extraPackages: readonly string[]): Promise<PackedInstallation> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), temporaryPrefix)))
  onTestFinished(() => rm(temporary, { recursive: true, force: true }))
  const installation = join(temporary, 'installation')
  const home = join(temporary, 'home')
  const profile = join(home, 'profiles', 'web')
  const archives = join(temporary, 'archives')
  await mkdir(profile, { recursive: true })
  await mkdir(archives)
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/KEY|SECRET|TOKEN|PASSWORD/.test(key) && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'
  )))
  Object.assign(environment, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(temporary, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    CI: 'true',
  })
  const [pnpm, ...prefix] = pnpmCommand()
  const packageCommand = async (args: string[], cwd: string) => {
    const result = await execa(pnpm, [...prefix, ...args], {
      cwd, env: environment, extendEnv: false, timeout: 180_000, reject: false,
    })
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
    return result
  }
  const packages = new Map<string, WorkspacePackage>()
  for (const path of globSync([
    'apps/*/package.json', 'packages/*/*/package.json', 'vendor/*/package.json', 'native/system/packages/*/package.json',
  ], { cwd: root })) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>
    if (typeof manifest.name !== 'string') throw new Error(`${path} has no package name`)
    packages.set(manifest.name, { name: manifest.name, manifest, directory: dirname(join(root, path)) })
  }
  const sourceDirectories = [root, ...[...packages.values()].map(member => member.directory)]
  const initialLinks = await workspaceLinks(sourceDirectories)
  onTestFinished(async () => { expect(await workspaceLinks(sourceDirectories)).toEqual(initialLinks) })
  const closure = packedWorkspaceClosure('@deepseek-ai/dsh', packages)
  // These idle-profile tests create no Session or confined process. The native
  // platform packages load lazily for those operations and have separate smokes.
  const supportsIdleProfile = (member: WorkspacePackage) => (
    !member.name.startsWith('@deepseek-ai/node-addon-system-')
    && (!Array.isArray(member.manifest.os) || member.manifest.os.includes(process.platform))
    && (!Array.isArray(member.manifest.cpu) || member.manifest.cpu.includes(process.arch))
  )
  const runtimeMembers = closure.filter(supportsIdleProfile)
  const members = new Map(runtimeMembers.map(member => [member.name, member]))
  for (const name of extraPackages) {
    for (const member of packedWorkspaceClosure(name, packages).filter(supportsIdleProfile)) members.set(member.name, member)
  }
  // Packing reads package-owned files; installation never runs in the workspace.
  await packageCommand([
    'pack', '--recursive', '--workspace-concurrency=4',
    ...[...members.keys()].map(name => `--filter=${name}`), '--pack-destination', archives,
  ], root)
  const tarballs = new Map([...members.values()].map((member) => {
    if (typeof member.manifest.version !== 'string') throw new Error(`${member.name} has no version`)
    const name = member.name.replaceAll('/', '-').replace('@', '')
    const archive = join(archives, `${name}-${member.manifest.version}.tgz`)
    expect(existsSync(archive), `missing packed payload for ${member.name}`).toBe(true)
    return [member.name, archive]
  }))
  const workspaceSettings = yaml.load(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')) as {
    allowBuilds: Record<string, boolean>
    patchedDependencies: Record<string, string>
    minimumReleaseAgeExclude: string[]
    overrides: Record<string, string>
  }
  const externalVersions: Record<string, string> = {}
  for (const member of members.values()) {
    const require = createRequire(join(member.directory, 'package.json'))
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = member.manifest[section] as Record<string, string> | undefined
      for (const [name, range] of Object.entries(dependencies ?? {})) {
        if (range.startsWith('workspace:')) continue
        const manifest = require.resolve.paths(name)?.map(path => join(path, name, 'package.json')).find(path => existsSync(path))
        if (manifest === undefined) continue
        const installed = JSON.parse(await readFile(manifest, 'utf8')) as { version: string }
        externalVersions[`${name}@${range}`] = installed.version
      }
    }
  }
  await mkdir(installation)
  for (const path of Object.values(workspaceSettings.patchedDependencies)) {
    await mkdir(dirname(join(installation, path)), { recursive: true })
    await writeFile(join(installation, path), await readFile(join(root, path)))
  }
  await writeFile(join(installation, 'package.json'), JSON.stringify({
    name: 'packed-product-installation', private: true,
    dependencies: Object.fromEntries(runtimeMembers.map(member => [member.name, `file:${tarballs.get(member.name)!}`])),
  }))
  await writeFile(join(installation, 'pnpm-workspace.yaml'), yaml.dump({
    packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, allowUnusedPatches: true,
    ignoredOptionalDependencies: closure.filter(member => !members.has(member.name)).map(member => member.name),
    allowBuilds: {
      ...workspaceSettings.allowBuilds,
      [`@deepseek-ai/dsh-subprocess-local@file:${relative(installation, tarballs.get('@deepseek-ai/dsh-subprocess-local')!).split(sep).join('/')}`]: true,
    },
    patchedDependencies: workspaceSettings.patchedDependencies,
    minimumReleaseAgeExclude: workspaceSettings.minimumReleaseAgeExclude,
    overrides: {
      ...workspaceSettings.overrides,
      ...externalVersions,
      ...Object.fromEntries(runtimeMembers.map(member => [member.name, `file:${tarballs.get(member.name)!}`])),
    },
  }))
  await packageCommand(['install', '--prefer-offline', '--no-frozen-lockfile'], installation)
  await assertInstalledTree(installation)
  return { temporary, installation, home, profile, archives, environment, tarballs, members, externalVersions, packageCommand }
}
