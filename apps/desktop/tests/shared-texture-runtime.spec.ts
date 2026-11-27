/** Desktop verifies the macOS and Windows texture-transport addons against their build records. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifySharedTextureAddons } from '../scripts/verify-shared-texture.mjs'

const roots: string[] = []
const targets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'] as const
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function binaryFor(platform: string, arch: string) {
  const binary = Buffer.alloc(80)
  if (platform === 'darwin') {
    binary.writeUInt32LE(0xfeedfacf, 0)
    binary.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
  } else {
    binary.writeUInt16LE(0x5a4d, 0)
    binary.writeUInt32LE(64, 0x3c)
    binary.writeUInt32LE(0x4550, 64)
    binary.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  }
  return binary
}
function split(name: typeof targets[number]): { platform: string; arch: string } {
  const [platform, arch] = name.split('-') as [string, string]
  return { platform, arch }
}

describe('Desktop shared-texture addons', () => {
  async function fixture(name: typeof targets[number] = 'darwin-arm64', binaries: Partial<Record<'shared-texture-hop' | 'shared-texture-ingress' | 'frame-forwarding', Buffer>> = {}) {
    const appDir = await mkdtemp(join(tmpdir(), 'shared-texture-addons-'))
    roots.push(appDir)
    const target = split(name)
    const directory = join(appDir, 'lib', 'native', name)
    await mkdir(directory, { recursive: true })
    const records: Record<string, { platform: string; sha256: string }> = {}
    for (const addon of ['shared-texture-hop', 'shared-texture-ingress', 'frame-forwarding'] as const) {
      const bytes = binaries[addon] ?? binaryFor(target.platform, target.arch)
      await writeFile(join(directory, `${addon}.node`), bytes)
      records[addon] = { platform: name, sha256: createHash('sha256').update(bytes).digest('hex') }
      await writeFile(join(directory, `${addon}.json`), JSON.stringify(records[addon]))
    }
    return { appDir, directory, records, target }
  }

  it.each(targets)('accepts the built %s addons', async (name) => {
    const f = await fixture(name)
    await expect(verifySharedTextureAddons(f.appDir, f.target)).resolves.toBeUndefined()
  })
  it('requires the addons of the packaged target', async () => {
    const f = await fixture('darwin-arm64')
    await expect(verifySharedTextureAddons(f.appDir, { platform: 'darwin', arch: 'x64' })).rejects.toThrow('build:native --arch x64')
  })
  it.each([['darwin-arm64', 'shared-texture-ingress'], ['win32-x64', 'shared-texture-hop'], ['win32-x64', 'frame-forwarding']] as const)('requires each addon on %s', async (name, addon) => {
    const f = await fixture(name)
    await rm(join(f.directory, `${addon}.node`))
    await expect(verifySharedTextureAddons(f.appDir, f.target)).rejects.toThrow(`${addon}.node is missing`)
  })
  it('requires no addon where Desktop has no texture transport', async () => {
    const appDir = await mkdtemp(join(tmpdir(), 'shared-texture-addons-'))
    roots.push(appDir)
    await expect(verifySharedTextureAddons(appDir, { platform: 'linux', arch: 'x64' })).resolves.toBeUndefined()
  })
  it.each([
    ['a stale hash', { sha256: '0'.repeat(64) }],
    ['another platform', { platform: 'darwin-x64' }],
  ] as const)('rejects a build record from %s', async (_name, override) => {
    const f = await fixture()
    await writeFile(join(f.directory, 'shared-texture-hop.json'), JSON.stringify({ ...f.records['shared-texture-hop'], ...override }))
    await expect(verifySharedTextureAddons(f.appDir, f.target)).rejects.toThrow('differs from its build record')
  })
  it.each([['darwin-arm64', 'darwin', 'x64'], ['win32-x64', 'win32', 'arm64']] as const)(
    'rejects a %s addon for another CPU even when its directory and record name the target', async (name, platform, arch) => {
      const f = await fixture(name, { 'shared-texture-ingress': binaryFor(platform, arch) })
      await expect(verifySharedTextureAddons(f.appDir, f.target)).rejects.toThrow(`ingress addon is not ${name}`)
    })
})
