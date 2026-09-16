import { describe, expect, it } from 'vitest'
import {
  createProcessInspector,
  linuxProcessGroupHasLiveMembers,
  parseProcStat,
} from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import type { ProcessInspectorInternals } from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import { WindowsProcessInspector } from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'

function stat(
  pid: number,
  pgrp: number,
  session: number,
  tpgid: number,
  started: string,
  parentPid = 1,
  state = 'S',
  ttyDevice = 99,
): string {
  const rest = [state, String(parentPid), String(pgrp), String(session), String(ttyDevice), String(tpgid)]
  while (rest.length < 19) rest.push('0')
  rest.push(started)
  return `${pid} (command with space) ${rest.join(' ')}`
}

function syscall(number: number, ...args: number[]): string {
  const six = [...args]
  while (six.length < 6) six.push(0)
  return `${number} ${six.slice(0, 6).map(value => `0x${value.toString(16)}`).join(' ')}`
}

function fakeInternals() {
  const files = new Map<string, string>()
  const dirs = new Map<string, string[]>()
  const links = new Map<string, string>()
  const devices = new Map<string, { character: boolean; rdev: number }>()
  const memories = new Map<string, Buffer>()
  const fds = new Map<number, string>()
  const kills: Array<[number, NodeJS.Signals]> = []
  let nextFd = 10
  let ps = ''
  let tpgid = '0'
  const internals: ProcessInspectorInternals = {
    readFile(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    readDir(path) {
      const value = dirs.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    readLink(path) {
      const value = links.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return value
    },
    stat(path) {
      const value = devices.get(path)
      if (value === undefined) throw new Error(`missing ${path}`)
      return { rdev: value.rdev, isCharacterDevice: () => value.character }
    },
    open(path) {
      if (!memories.has(path)) throw new Error(`missing ${path}`)
      const fd = nextFd++
      fds.set(fd, path)
      return fd
    },
    read(fd, buffer, length, position) {
      const path = fds.get(fd)
      if (path === undefined) throw new Error('bad fd')
      const source = memories.get(path)
      if (source === undefined) throw new Error('missing memory')
      return source.copy(buffer, 0, position, Math.min(source.length, position + length))
    },
    close(fd) { fds.delete(fd) },
    exec(_file, args) {
      if (args.includes('tpgid=')) return tpgid
      return ps
    },
    kill(pid, signal) { kills.push([pid, signal]) },
  }
  return {
    internals, files, dirs, links, devices, memories, kills,
    setPs(value: string) { ps = value },
    setTpgid(value: string) { tpgid = value },
  }
}

describe('Linux process inspector', () => {
  it.each(['EACCES', 'EMFILE'])('refuses to publish an empty snapshot when /proc enumeration fails with %s', (code) => {
    const fake = fakeInternals()
    const readDir = fake.internals.readDir.bind(fake.internals)
    fake.internals.readDir = () => { throw Object.assign(new Error('Enumeration failed'), { code }) }
    const inspector = createProcessInspector('linux', 'x64', fake.internals)
    expect(() => inspector.snapshot()).toThrow('/proc directory is unreadable')
    fake.internals.readDir = readDir
    fake.dirs.set('/proc', ['10'])
    fake.files.set('/proc/10/stat', stat(10, 10, 10, 10, '500'))
    expect(inspector.snapshot().complete).toBe(true)
    expect(inspector.snapshot().tree(10)).toEqual([{ pid: 10, started: '500' }])
  })

  it('makes no stdin-wait claim when process or task directories cannot be enumerated', () => {
    const fake = fakeInternals()
    fake.files.set('/proc/10/stat', stat(10, 10, 10, 10, '500'))
    fake.links.set('/proc/10/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/10/fd/0', { character: true, rdev: 99 })
    const inspector = createProcessInspector('linux', 'x64', fake.internals)
    expect(inspector.isStdinWaiting(10, 10)).toBe(false)
    fake.dirs.set('/proc', ['10'])
    expect(inspector.isStdinWaiting(10, 10)).toBe(false)
  })

  it('treats zombie-only process groups as quiescent and fails closed when unobservable', () => {
    const fake = fakeInternals()
    expect(linuxProcessGroupHasLiveMembers(77, fake.internals)).toBeUndefined()

    fake.dirs.set('/proc', ['self', '10', '11', '12'])
    fake.files.set('/proc/10/stat', stat(10, 77, 10, -1, '500', 1, 'Z'))
    fake.files.set('/proc/11/stat', stat(11, 77, 10, -1, '501', 1, 'X'))
    fake.files.set('/proc/12/stat', stat(12, 88, 12, -1, '502'))
    expect(linuxProcessGroupHasLiveMembers(77, fake.internals)).toBe(false)
    expect(linuxProcessGroupHasLiveMembers(99, fake.internals)).toBeUndefined()

    fake.files.set('/proc/11/stat', stat(11, 77, 10, -1, '501'))
    expect(linuxProcessGroupHasLiveMembers(77, fake.internals)).toBe(true)
  })

  it('parses stat safely, captures only the rooted process tree, and signals identities', () => {
    expect(parseProcStat('bad')).toBeUndefined()
    expect(parseProcStat('1 () ')).toBeUndefined()
    expect(parseProcStat('1 () S')).toBeUndefined()
    expect(parseProcStat(stat(10, 20, 30, 40, '500', 1, 'SS'))).toBeUndefined()
    expect(parseProcStat(stat(10, 20, 30, 40, '500'))).toEqual({ pid: 10, parentPid: 1, pgrp: 20, session: 30, state: 'S', ttyDevice: 99, tpgid: 40, started: '500' })

    const fake = fakeInternals()
    fake.dirs.set('/proc', ['x', '10', '11', '12', '13', '14'])
    fake.files.set('/proc/10/stat', stat(10, 20, 30, 40, '500'))
    fake.files.set('/proc/11/stat', stat(11, 21, 30, -1, '501'))
    fake.files.set('/proc/12/stat', stat(12, 22, 30, -1, '502', 10))
    fake.files.set('/proc/13/stat', stat(13, 23, 30, -1, '503', 12))
    const inspector = createProcessInspector('linux', 'x64', fake.internals)
    expect(inspector.foregroundPgid(10)).toBe(40)
    expect(inspector.foregroundPgid(11)).toBeUndefined()
    expect(inspector.foregroundPgid(99)).toBeUndefined()
    const observed = inspector.snapshot()
    expect(observed.tree(10)).toEqual([
      { pid: 13, started: '503' },
      { pid: 12, started: '502' },
      { pid: 10, started: '500' },
    ])
    expect(observed.tree(99)).toEqual([])
    expect(observed.session(30)).toEqual([
      { pid: 10, started: '500' },
      { pid: 11, started: '501' },
      { pid: 12, started: '502' },
      { pid: 13, started: '503' },
    ])
    expect(observed.session(99)).toEqual([])
    expect(observed.alive({ pid: 10, started: '500' })).toBe(true)
    expect(observed.alive({ pid: 10, started: 'old' })).toBe(false)
    inspector.signalGroup(40, 'SIGINT')
    inspector.signalProcess({ pid: 10, started: '500' }, 'SIGTERM')
    inspector.signalProcess({ pid: 10, started: 'old' }, 'SIGKILL')
    expect(fake.kills).toEqual([[-40, 'SIGINT'], [10, 'SIGTERM']])
    fake.files.set('/proc/10/stat', stat(10, 20, 30, 40, '500', 1, 'Z'))
    // A zombie is present in the table but never signallable; both the batch
    // view and the signal fence report it quiescent once the state changes.
    expect(inspector.snapshot().alive({ pid: 10, started: '500' })).toBe(false)
    expect(inspector.isAlive({ pid: 10, started: '500' })).toBe(false)
    inspector.signalProcess({ pid: 10, started: '500' }, 'SIGKILL')
    expect(fake.kills).toEqual([[-40, 'SIGINT'], [10, 'SIGTERM']])
  })

  it('detects supported kernel ABI waits across non-leader threads', () => {
    const fake = fakeInternals()
    fake.dirs.set('/proc', ['100', '101'])
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1'))
    fake.files.set('/proc/101/stat', stat(101, 77, 100, 77, '2'))
    fake.dirs.set('/proc/100/task', ['100'])
    fake.dirs.set('/proc/101/task', ['101', '102'])
    fake.links.set('/proc/100/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/100/fd/0', { character: true, rdev: 99 })
    fake.links.set('/proc/101/task/102/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/101/task/102/fd/0', { character: true, rdev: 99 })
    const inspector = createProcessInspector('linux', 'x64', fake.internals)

    fake.files.set('/proc/100/task/100/syscall', 'running')
    fake.files.set('/proc/101/task/101/syscall', '-1 0x0')
    fake.files.set('/proc/101/task/102/syscall', syscall(0, 0))
    expect(inspector.isStdinWaiting(77, 100)).toBe(true)
    fake.files.set('/proc/101/task/102/syscall', syscall(63, 0))
    expect(inspector.isStdinWaiting(77, 100)).toBe(true)

    fake.files.set('/proc/101/task/102/syscall', syscall(270, 1, 0x10))
    const fdSet = Buffer.alloc(0x11)
    fdSet[0x10] = 1
    fake.memories.set('/proc/101/mem', fdSet)
    expect(inspector.isStdinWaiting(77, 100)).toBe(true)

    const poll = Buffer.alloc(8)
    poll.writeInt32LE(0, 0)
    poll.writeInt16LE(1, 4)
    fake.files.set('/proc/101/task/102/syscall', syscall(7, 0x20, 1))
    fake.memories.set('/proc/101/mem', Buffer.concat([Buffer.alloc(0x20), poll]))
    expect(inspector.isStdinWaiting(77, 100)).toBe(true)

    fake.files.set('/proc/101/task/102/syscall', syscall(232, 5, 0, 1))
    fake.files.set('/proc/101/task/102/fdinfo/5', 'pos: 0\ntfd: 0 events: 19\n')
    expect(inspector.isStdinWaiting(77, 100)).toBe(true)
  })

  it('uses the waiting thread fd table and recognizes the controlling-terminal alias', () => {
    const fake = fakeInternals()
    fake.dirs.set('/proc', ['100'])
    fake.files.set('/proc/99/stat', stat(99, 99, 99, 77, '0'))
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1'))
    fake.dirs.set('/proc/100/task', ['100'])
    fake.files.set('/proc/100/task/100/syscall', syscall(0, 0))
    fake.links.set('/proc/99/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/99/fd/0', { character: true, rdev: 99 })
    fake.links.set('/proc/100/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/100/fd/0', { character: true, rdev: 99 })
    fake.links.set('/proc/100/task/100/fd/0', 'pipe:[123]')
    fake.devices.set('/proc/100/task/100/fd/0', { character: false, rdev: 0 })
    const inspector = createProcessInspector('linux', 'x64', fake.internals)

    expect(inspector.isStdinWaiting(77, 99)).toBe(false)
    fake.links.delete('/proc/100/task/100/fd/0')
    expect(inspector.isStdinWaiting(77, 99)).toBe(false)
    fake.links.set('/proc/100/task/100/fd/0', '/dev/tty')
    expect(inspector.isStdinWaiting(77, 99)).toBe(true)
    fake.links.set('/proc/100/task/100/fd/0', '/dev/pts/2')
    fake.devices.set('/proc/100/task/100/fd/0', { character: true, rdev: 100 })
    expect(inspector.isStdinWaiting(77, 99)).toBe(false)
  })

  it('fails closed on unsupported, malformed, unreadable, or non-stdin waits', () => {
    const fake = fakeInternals()
    fake.dirs.set('/proc', ['100'])
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1'))
    fake.dirs.set('/proc/100/task', ['100'])
    fake.links.set('/proc/100/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/100/fd/0', { character: true, rdev: 99 })
    fake.links.set('/proc/100/task/100/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/100/task/100/fd/0', { character: true, rdev: 99 })
    fake.files.set('/proc/100/task/100/syscall', syscall(0, 2))
    expect(createProcessInspector('linux', 'mips', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)

    fake.files.set('/proc/100/task/100/syscall', syscall(270, 1, 0))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(7, 0, 0))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(7, 0, 1))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(7, 0x20, 1))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(232, 9, 0, 1))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(999))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)

    fake.files.set('/proc/100/task/100/syscall', 'not-a-number 0x0')
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.dirs.delete('/proc/100/task')
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
    fake.dirs.set('/proc', ['100', '200'])
    fake.files.set('/proc/200/stat', stat(200, 88, 200, 88, '2'))
    expect(createProcessInspector('linux', 'x64', fake.internals).isStdinWaiting(77, 100)).toBe(false)
  })

  it('contains unreadable syscall, memory, and fdinfo boundaries', () => {
    const fake = fakeInternals()
    fake.dirs.set('/proc', ['100'])
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1'))
    fake.dirs.set('/proc/100/task', ['100'])
    const inspector = createProcessInspector('linux', 'x64', fake.internals)
    fake.files.delete('/proc/100/stat')
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1', 1, 'S', 0))
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/stat', stat(100, 77, 100, 77, '1'))
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
    fake.links.set('/proc/100/fd/0', '/dev/pts/1')
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
    fake.devices.set('/proc/100/fd/0', { character: true, rdev: 99 })
    fake.links.set('/proc/100/task/100/fd/0', '/dev/pts/1')
    fake.devices.set('/proc/100/task/100/fd/0', { character: true, rdev: 99 })
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)

    fake.files.set('/proc/100/task/100/syscall', syscall(270, 1, 0x10))
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
    fake.files.set('/proc/100/task/100/syscall', syscall(232, 5, 0, 1))
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)

    const noStdinPoll = Buffer.alloc(0x28)
    noStdinPoll.writeInt32LE(2, 0x20)
    noStdinPoll.writeInt16LE(1, 0x24)
    fake.memories.set('/proc/100/mem', noStdinPoll)
    fake.files.set('/proc/100/task/100/syscall', syscall(7, 0x20, 1))
    expect(inspector.isStdinWaiting(77, 100)).toBe(false)
  })
})

describe('macOS process inspector', () => {
  it('reads tpgid and process trees, contains cycles, and identity-fences signals', () => {
    const fake = fakeInternals()
    fake.setTpgid('55\n')
    fake.setPs(' 10 1 Mon Jul 21 10:00:00 2026\n 11 10 Mon Jul 21 10:00:01 2026\n 12 11 Mon Jul 21 10:00:02 2026\n 13 99 Mon Jul 21 10:00:03 2026\nmalformed\n')
    const inspector = createProcessInspector('darwin', 'arm64', fake.internals)
    expect(inspector.foregroundPgid(10)).toBe(55)
    expect(inspector.isStdinWaiting(55, 10)).toBe(false)
    const observed = inspector.snapshot()
    expect(observed.tree(10)).toEqual([
      { pid: 12, started: 'Mon Jul 21 10:00:02 2026' },
      { pid: 11, started: 'Mon Jul 21 10:00:01 2026' },
      { pid: 10, started: 'Mon Jul 21 10:00:00 2026' },
    ])
    expect(observed.tree(99)).toEqual([])
    expect(observed.session(10)).toEqual([])
    expect(observed.alive({ pid: 11, started: 'Mon Jul 21 10:00:01 2026' })).toBe(true)
    inspector.signalGroup(55, 'SIGTSTP')
    inspector.signalProcess({ pid: 11, started: 'Mon Jul 21 10:00:01 2026' }, 'SIGKILL')
    inspector.signalProcess({ pid: 12, started: 'missing' }, 'SIGTERM')
    expect(fake.kills).toEqual([[-55, 'SIGTSTP'], [11, 'SIGKILL']])

    fake.setPs(' 10 11 Mon Jul 21 10:00:00 2026\n 11 10 Mon Jul 21 10:00:01 2026\n')
    expect(inspector.snapshot().tree(10)).toEqual([
      { pid: 11, started: 'Mon Jul 21 10:00:01 2026' },
      { pid: 10, started: 'Mon Jul 21 10:00:00 2026' },
    ])
  })

  it('re-reads the process table before signalling instead of trusting an earlier observation', () => {
    const fake = fakeInternals()
    fake.setPs(' 11 10 Mon Jul 21 10:00:01 2026\n')
    const inspector = createProcessInspector('darwin', 'arm64', fake.internals)
    inspector.snapshot()
    // The member exits after that observation; a recycled pid would otherwise
    // inherit the observed identity and take the signal meant for the original.
    fake.setPs('')

    inspector.signalProcess({ pid: 11, started: 'Mon Jul 21 10:00:01 2026' }, 'SIGKILL')

    expect(fake.kills).toEqual([])
  })

  it('returns undefined for missing or invalid foreground groups and dispatches platform inspectors', () => {
    const fake = fakeInternals()
    fake.setTpgid('-1')
    expect(createProcessInspector('darwin', 'arm64', fake.internals).foregroundPgid(1)).toBeUndefined()
    fake.internals.exec = () => { throw new Error('gone') }
    expect(createProcessInspector('darwin', 'arm64', fake.internals).foregroundPgid(1)).toBeUndefined()
    expect(createProcessInspector('win32', 'x64', fake.internals)).toBeInstanceOf(WindowsProcessInspector)
    expect(() => createProcessInspector('freebsd', 'x64', fake.internals)).toThrow('unsupported on platform freebsd')
  })
})
