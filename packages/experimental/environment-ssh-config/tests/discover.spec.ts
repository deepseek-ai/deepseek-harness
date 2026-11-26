import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverHosts } from '../src/discover.ts'

const fakeHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => fakeHome.path,
}))
/** Makes every path look missing to discovery's `stat`, as on an absent drive. */
const absentVolume = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (path: string) => {
      if (absentVolume.enabled) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' })
      return await actual.stat(path)
    },
  }
})
let directory: string | undefined
afterEach(async () => {
  absentVolume.enabled = false
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  fakeHome.path = ''
})

async function source(text: string): Promise<string> {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-aliases-')))
  fakeHome.path = directory
  const file = join(directory, 'config')
  await writeFile(file, text)
  return file
}

/** Discover aliases and the directories to watch. */
async function discover(file: string, optional = false): Promise<{ aliases: readonly string[]; directories: Set<string> }> {
  const directories = new Set<string>()
  return { aliases: await discoverHosts(file, { optional, directories }), directories }
}

describe('SSH environment discovery', () => {
  it('enumerates concrete aliases, includes and declaration order without evaluating Match exec', async () => {
    const file = await source('')
    const included = join(directory!, 'hosts')
    await mkdir(included)
    await writeFile(join(included, 'a.conf'), 'Host included duplicate\n  HostName box.example\n')
    await writeFile(join(included, 'b.conf'), 'Host last\n')
    await writeFile(file, [
      '# comment', `Include ${included}/*.conf`, 'Host first duplicate *.example !refused host? [ab]',
      '  HostName first.example',
      'Match exec "touch should-not-run"', '  User nobody', 'Host first final',
    ].join('\n'))
    expect(await discover(file)).toEqual({
      aliases: ['included', 'duplicate', 'last', 'first', 'final'], directories: new Set([directory, included]),
    })
  })

  it('ignores unmatched Include patterns and repeated completed includes', async () => {
    const file = await source('')
    const child = join(directory!, 'child')
    await writeFile(child, 'Host child\n')
    await writeFile(file, `Include ${child}\nInclude ${child}\nInclude ${directory}/absent-*\n`)
    expect((await discover(file)).aliases).toEqual(['child'])
  })

  it('follows Host * includes but excludes conditional Host and Match includes', async () => {
    const file = await source('')
    const allowed = join(directory!, 'allowed')
    const conditional = join(directory!, 'conditional')
    await writeFile(allowed, 'Host shared\n  HostName 127.0.0.99\n')
    await writeFile(conditional, 'Host hidden\n  HostName 127.0.0.88\n')
    await writeFile(file, `Host gate\n Include ${conditional}\nMatch exec "false"\n Include ${conditional}\nHost *\n Include ${allowed}\n`)
    expect((await discover(file)).aliases).toEqual(['gate', 'shared'])
  })

  it('resolves relative Include paths from the user SSH directory', async () => {
    const file = await source('Include relative.conf\n')
    await mkdir(join(directory!, '.ssh'))
    await writeFile(join(directory!, '.ssh', 'relative.conf'), 'Host relative\n')
    expect(await discover(file)).toEqual({ aliases: ['relative'], directories: new Set([directory, join(directory!, '.ssh')]) })
  })

  it('rejects Include cycles, missing source files and unparsable files, naming the file', async () => {
    const file = await source('')
    await writeFile(file, `Include ${file}\n`)
    await expect(discoverHosts(file, { optional: false, directories: new Set() })).rejects.toThrow('Include cycle')
    await expect(discoverHosts(join(directory!, 'missing'), { optional: false, directories: new Set() })).rejects.toThrow('ENOENT')
    await writeFile(file, 'Host "unterminated\n')
    await expect(discoverHosts(file, { optional: false, directories: new Set() }))
      .rejects.toThrow(`Cannot parse SSH configuration ${file}: Unexpected line break at unterminated`)
  })

  it('watches the directories of symbolic links and their targets, and where missing files can appear', async () => {
    const file = await source('')
    const target = join(directory!, 'dotfiles')
    const links = join(directory!, 'links')
    await mkdir(target)
    await mkdir(links)
    await writeFile(join(target, 'work.conf'), 'Host work\n')
    await symlink(join(target, 'work.conf'), join(links, 'work.conf'))
    await writeFile(file, `Include ${links}/work.conf ${directory}/later/hosts.d/*.conf\n`)
    expect(await discover(file)).toEqual({ aliases: ['work'], directories: new Set([directory, links, target]) })
  })

  it('watches every directory a wildcard directory segment can match', async () => {
    const file = await source('')
    const nested = join(directory!, 'teams')
    await mkdir(join(nested, 'a', 'ssh'), { recursive: true })
    await mkdir(join(nested, 'b'), { recursive: true })
    await writeFile(join(nested, 'note'), '')
    await writeFile(join(nested, 'a', 'ssh', 'config'), 'Host team-a\n')
    await writeFile(file, `Include ${nested}/*/ssh/config\n`)
    expect(await discover(file)).toEqual({
      aliases: ['team-a'], directories: new Set([directory, join(nested, 'a', 'ssh'), join(nested, 'a'), join(nested, 'b'), nested]),
    })
  })

  it('treats an absent optional file as declaring no aliases and watches its nearest existing directory', async () => {
    await source('')
    expect(await discover(join(directory!, '.ssh', 'config'), true)).toEqual({ aliases: [], directories: new Set([directory]) })
    await mkdir(join(directory!, '.ssh'))
    expect(await discover(join(directory!, '.ssh', 'config'), true)).toEqual({ aliases: [], directories: new Set([join(directory!, '.ssh')]) })
    await writeFile(join(directory!, '.ssh', 'config'), 'Host home\n')
    expect((await discover(join(directory!, '.ssh', 'config'), true)).aliases).toEqual(['home'])
    await rm(join(directory!, '.ssh'), { recursive: true })
    await writeFile(join(directory!, '.ssh'), '')
    await expect(discover(join(directory!, '.ssh', 'config'), true)).rejects.toThrow('ENOTDIR')
  })

  it('watches the nearest existing directory below a file or a symbolic link loop', async () => {
    const file = await source('')
    await writeFile(file, `Include ${file}/sub/*.conf\n`)
    expect(await discover(file)).toEqual({ aliases: [], directories: new Set([directory]) })
    await symlink(join(directory!, 'b'), join(directory!, 'a'))
    await symlink(join(directory!, 'a'), join(directory!, 'b'))
    await writeFile(file, `Include ${directory}/a/*.conf\n`)
    await expect(discover(file)).rejects.toThrow('ELOOP')
  })

  it('stops at a file system root that does not exist either, and watches it', async () => {
    await source('')
    absentVolume.enabled = true
    const file = join(directory!, 'absent', 'config')
    const { aliases, directories } = await discover(file, true)
    expect(aliases).toEqual([])
    expect([...directories]).toEqual([parse(file).root])
  })

  it('reports the directories reached before a failure', async () => {
    const file = await source('')
    const broken = join(directory!, 'broken')
    await mkdir(broken)
    await writeFile(join(broken, 'hosts.conf'), 'Host "unterminated\n')
    await writeFile(file, `Include ${broken}/*.conf\n`)
    const directories = new Set<string>()
    await expect(discoverHosts(file, { optional: false, directories })).rejects.toThrow('Cannot parse SSH configuration')
    expect(directories).toEqual(new Set([directory, broken]))
  })
})
