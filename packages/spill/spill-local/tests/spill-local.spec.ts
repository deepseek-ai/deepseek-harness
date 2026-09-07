/**
 * Tests for the LOCAL spill backend: `saveText` writes a session-scoped file and
 * returns a locator + byte length + retrieval hint, filename sanitization
 * neutralizes traversal, the configured `root` is honored (and the private
 * default when omitted), and a storage failure rejects. The startup cleanup
 * sweep expires old files, prunes stale roots, skips symlinks/unknown entries,
 * discovers prior default roots, contains filesystem failures, and is awaited on
 * disposal without blocking activation. The Cordis-free store and cleanup
 * helpers are exercised directly for their edge cases.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import LocalSpillStore, {
  DEFAULT_ROOT_PREFIX,
  discoverDefaultRoots,
  encodeSegment,
  isErrno,
  privateRoot,
  saveTextFile,
  sessionDir,
  sweepSpillRoots,
} from '@deepseek-ai/dsh-spill-local'
import type { SweepRoot } from '@deepseek-ai/dsh-spill-local'
import { gatherSweepRoots } from '../src/cleanup.ts'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-spill-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file with an mtime `ageDays` in the past (fractional allowed). */
function writeAged(path: string, content: string, ageDays: number): void {
  writeFileSync(path, content)
  const when = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(path, when, when)
}

function request(overrides: Partial<SaveTextSpill> = {}): SaveTextSpill {
  return {
    owner: { sessionId: SessionId('sess-1') },
    source: { kind: 'tool', toolName: 'web_fetch', callId: ToolCallId('call-1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content: 'the full body',
    ...overrides,
  }
}

describe('encodeSegment', () => {
  it('keeps the safe set literal', () => {
    expect(encodeSegment('web_fetch.txt')).toBe('web_fetch.txt')
    expect(encodeSegment('a-B_9.z')).toBe('a-B_9.z')
  })

  it('escapes separators and tilde (dots are literal except as whole-segment tokens)', () => {
    // `.` is in the safe set, so `..` inside a longer string stays literal; the
    // traversal defense is that separators escape, keeping the result ONE segment.
    expect(encodeSegment('../etc/passwd')).toBe('..~002Fetc~002Fpasswd')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('~')).toBe('~007E')
  })

  it('escapes the whole-segment dot tokens', () => {
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })

  it('encodes the empty string to a non-empty segment', () => {
    expect(encodeSegment('')).toBe('~')
  })
})

describe('sessionDir', () => {
  it('is a stable per-session hash under the root', () => {
    const dir = sessionDir('/spill', 'sess-1')
    expect(dir).toBe(sessionDir('/spill', 'sess-1'))
    expect(dirname(dir)).toBe(normalize('/spill'))
    expect(basename(dir)).toMatch(/^session-[0-9a-f]{12}$/)
    expect(sessionDir('/spill', 'sess-2')).not.toBe(dir)
  })
})

describe('saveTextFile', () => {
  it('writes the content under the session dir and reports bytes', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'héllo' })
    expect(readFileSync(saved.path, 'utf8')).toBe('héllo')
    expect(saved.bytes).toBe(Buffer.byteLength('héllo', 'utf8'))
    expect(dirname(saved.path)).toBe(sessionDir(root, 'sess-1'))
    expect(basename(saved.path)).toMatch(/^[0-9a-f]{12}-r\.txt$/)
  })

  it('sanitizes a traversal-shaped suggested name into one segment', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: '../../evil', content: 'x' })
    // The separators escaped, so the whole name is one leaf under the session dir.
    expect(dirname(saved.path)).toBe(sessionDir(root, 'sess-1'))
    expect(saved.path.includes('/..')).toBe(false)
  })

  it('creates the session directory and file with owner-only POSIX permissions', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' })
    const directory = statSync(dirname(saved.path))
    const file = statSync(saved.path)
    expect(directory.isDirectory()).toBe(true)
    expect(file.isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(directory.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
    }
  })

  it('gives distinct paths to two saves of the same name', async () => {
    const a = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'a' })
    const b = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'b' })
    expect(a.path).not.toBe(b.path)
  })
})

describe('privateRoot', () => {
  it('is a stable absolute directory under the temp dir', () => {
    const first = privateRoot()
    expect(isAbsolute(first)).toBe(true)
    expect(privateRoot()).toBe(first)
  })
})

describe('LocalSpillStore service', () => {
  // These tests exercise save/root resolution, not cleanup; disabling the sweep
  // (cleanupPeriodDays: 0) keeps them from scanning/sweeping the real tmpdir.
  it('registers as ctx.spillStore and saves under the configured root', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
    const ref = await ctx.spillStore.saveText(request())
    expect(dirname(ref.locator)).toBe(sessionDir(root, 'sess-1'))
    expect(readFileSync(ref.locator, 'utf8')).toBe('the full body')
    expect(ref.bytes).toBe(Buffer.byteLength('the full body', 'utf8'))
    expect(ref.retrievalHint).toBe('Use read with offset/limit, or grep this path to search within it.')
  })

  it('resolves a relative configured root to absolute', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { root: '.', cleanupPeriodDays: 0 })
    expect(isAbsolute((ctx.spillStore as LocalSpillStore).root)).toBe(true)
  })

  it('falls back to the private root when none is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { cleanupPeriodDays: 0 })
    expect((ctx.spillStore as LocalSpillStore).root).toBe(privateRoot())
  })

  it('rejects when the root is not writable (missing parent, exclusive open)', async () => {
    const ctx = new Context()
    // A file (not a dir) as the root makes mkdir under it fail — a real storage error.
    const filePath = (await saveTextFile({ root, sessionId: 's', suggestedName: 'f', content: 'x' })).path
    await ctx.plugin(LocalSpillStore, { root: filePath, cleanupPeriodDays: 0 })
    await expect(ctx.spillStore.saveText(request())).rejects.toThrow()
  })

  it('rejects a negative or fractional cleanupPeriodDays at load', async () => {
    await expect(new Context().plugin(LocalSpillStore, { root, cleanupPeriodDays: -1 }))
      .rejects.toThrow()
    await expect(new Context().plugin(LocalSpillStore, { root, cleanupPeriodDays: 1.5 }))
      .rejects.toThrow()
  })

  it('defaults cleanupPeriodDays to 30', async () => {
    const ctx = new Context()
    // Point discovery at an empty isolated base so the default sweep does not
    // touch the real tmpdir; assert only that the default landed on config.
    const emptyBase = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    class Isolated extends LocalSpillStore {
      protected override defaultRootsBase(): string { return emptyBase }
    }
    try {
      const fiber = await ctx.plugin(Isolated, { root })
      const store = ctx.spillStore as LocalSpillStore
      await fiber.dispose()
      expect(store.config.cleanupPeriodDays).toBe(30)
    } finally {
      rmSync(emptyBase, { recursive: true, force: true })
    }
  })

  it('the default discovery base is the OS tmpdir', async () => {
    // Every hermetic sweep test overrides defaultRootsBase(); pin its production
    // default here (scan the OS tmpdir) without letting the sweep touch tmpdir.
    class Exposed extends LocalSpillStore {
      base(): string { return this.defaultRootsBase() }
      protected override async gatherRoots(): Promise<SweepRoot[]> { return [] }
    }
    const ctx = new Context()
    const fiber = await ctx.plugin(Exposed, { root, cleanupPeriodDays: 30 })
    const store = ctx.spillStore as Exposed
    await fiber.dispose()
    expect(store.base()).toBe(tmpdir())
  })

  it('routes a sweep filesystem failure to ctx.logger.warn (service warn wiring)', async () => {
    // A root that is a FILE, not a directory, is rejected by the real sweep.
    // The service's warn closure must forward that failure to
    // ctx.logger.warn, and disposal must still settle cleanly.
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    class Discovering extends LocalSpillStore {
      protected override async gatherRoots(): Promise<SweepRoot[]> { return [{ path: this.root, pruneWhenEmpty: false }] }
    }
    const fiber = await ctx.plugin(Discovering, { root: filePath, cleanupPeriodDays: 30 })
    await fiber.dispose()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe root'))
  })
})

/**
 * A store whose sweep covers exactly the roots handed in (no real-tmpdir scan) —
 * the hermetic seam for the cleanup tests. `barrier`, when set, holds the async
 * gather open so a test can prove disposal awaits the sweep.
 */
class SweptStore extends LocalSpillStore {
  static sweepRoots: SweepRoot[] = []
  static barrier: Promise<void> | undefined
  protected override async gatherRoots(): Promise<SweepRoot[]> {
    if (SweptStore.barrier) await SweptStore.barrier
    return SweptStore.sweepRoots
  }
}

/** Sweep the given roots via the fiber-owned startup sweep; `root` is the active (non-pruned) root. */
async function runSweep(roots: SweepRoot[], cleanupPeriodDays = 30): Promise<void> {
  SweptStore.sweepRoots = roots
  SweptStore.barrier = undefined
  const ctx = new Context()
  const fiber = await ctx.plugin(SweptStore, { root, cleanupPeriodDays })
  // Disposal awaits the fiber-owned sweep, so after this the sweep has run.
  await fiber.dispose()
}

/** The active configured root as a non-pruned sweep target (the common single-root case). */
function active(path: string): SweepRoot {
  return { path, pruneWhenEmpty: false }
}

describe('startup cleanup sweep', () => {
  it('deletes files older than the cutoff and keeps fresh ones', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    const fresh = join(dir, 'fresh.txt'); writeAged(fresh, 'y', 1)
    await runSweep([active(root)])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('keeps a file exactly at the boundary (only strictly-older expires)', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const cutoffMs = Date.now() - 30 * DAY_MS
    const boundary = join(dir, 'boundary.txt')
    writeFileSync(boundary, 'x')
    utimesSync(boundary, cutoffMs / 1000, cutoffMs / 1000)
    await sweepSpillRoots({ roots: [active(root)], cutoffMs, warn: () => {} })
    expect(existsSync(boundary)).toBe(true)
  })

  it('disabled (cleanupPeriodDays: 0) sweeps nothing', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 400)
    await runSweep([active(root)], 0)
    expect(existsSync(old)).toBe(true)
  })

  it('prunes empty active session directories after deleting expired files', async () => {
    const emptied = sessionDir(root, 'emptied')
    const kept = sessionDir(root, 'kept')
    mkdirSync(emptied, { recursive: true })
    mkdirSync(kept, { recursive: true })
    writeAged(join(emptied, 'a.txt'), 'x', 40)
    writeAged(join(kept, 'fresh.txt'), 'y', 1)
    await runSweep([active(root)])
    expect(existsSync(emptied)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })

  it('skips a symlink INSIDE a session dir and non-session siblings', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    // A symlink pointing at an old target must NOT be followed or deleted.
    const target = join(root, 'target.txt'); writeAged(target, 'keep', 40)
    const link = join(dir, 'link.txt'); symlinkSync(target, link)
    // A non-session sibling directory under a shared root is untouched.
    const unrelated = join(root, 'not-a-session'); mkdirSync(unrelated)
    const unrelatedOld = join(unrelated, 'old.txt'); writeAged(unrelatedOld, 'x', 40)
    await runSweep([active(root)])
    // The symlink itself survives (lstat sees a link, not a file), so its dir is
    // not empty and is not pruned; the link target survives too.
    expect(existsSync(link)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(unrelatedOld)).toBe(true)
  })

  it('does NOT follow a symlinked session directory (no deletion in the target)', async () => {
    // A `session-<12hex>`-NAMED symlink pointing at a directory of old files must
    // never be descended: lstat on the entry sees a link, so the target's files
    // are left intact and the link itself is not removed.
    const victimDir = join(root, 'victim'); mkdirSync(victimDir, { recursive: true })
    const victimOld = join(victimDir, 'old.txt'); writeAged(victimOld, 'x', 40)
    const linkName = `session-${'a'.repeat(12)}`
    const link = join(root, linkName); symlinkSync(victimDir, link)
    await runSweep([active(root)])
    expect(existsSync(victimOld)).toBe(true)
    expect(existsSync(link)).toBe(true)
  })

  it('skips a POSIX session directory writable by another local user', async () => {
    if (process.platform === 'win32') return
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    chmodSync(dir, 0o777)
    const warn = vi.fn()
    await sweepSpillRoots({ roots: [active(root)], cutoffMs: Date.now(), warn })
    expect(existsSync(old)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe session directory'))
  })

  it('sweeps only exact session-<12hex> names, not lookalikes', async () => {
    // `session-backup` and `session-<11hex>` match the old startsWith check but
    // are NOT backend-generated names; their old files must survive.
    const backup = join(root, 'session-backup'); mkdirSync(backup, { recursive: true })
    const backupOld = join(backup, 'old.txt'); writeAged(backupOld, 'x', 40)
    const shortHex = join(root, `session-${'a'.repeat(11)}`); mkdirSync(shortHex, { recursive: true })
    const shortOld = join(shortHex, 'old.txt'); writeAged(shortOld, 'x', 40)
    // A real session dir alongside them IS swept, proving the sweep still runs.
    const real = sessionDir(root, 'sess-1'); mkdirSync(real, { recursive: true })
    const realOld = join(real, 'old.txt'); writeAged(realOld, 'x', 40)
    await runSweep([active(root)])
    expect(existsSync(backupOld)).toBe(true)
    expect(existsSync(shortOld)).toBe(true)
    expect(existsSync(realOld)).toBe(false)
  })

  it('prunes an emptied DISCOVERED default root but never the active root', async () => {
    // A discovered prior-default root (pruneWhenEmpty) whose only session dir is
    // emptied should have its outer directory removed too; the active root, even
    // when fully emptied, must survive (the live process still writes into it).
    const prior = mkdtempSync(join(tmpdir(), 'dsh-spill-'))
    const priorDir = sessionDir(prior, 'old-sess'); mkdirSync(priorDir, { recursive: true })
    writeAged(join(priorDir, 'old.txt'), 'x', 40)
    const activeDir = sessionDir(root, 'sess-1'); mkdirSync(activeDir, { recursive: true })
    writeAged(join(activeDir, 'old.txt'), 'x', 40)
    try {
      await runSweep([{ path: prior, pruneWhenEmpty: true }, active(root)])
      expect(existsSync(prior)).toBe(false)   // discovered root pruned
      expect(existsSync(root)).toBe(true)     // active root kept
      expect(existsSync(activeDir)).toBe(false) // empty active session dirs are pruned
    } finally {
      rmSync(prior, { recursive: true, force: true })
    }
  })

  it('de-duplicates repeated roots and lets non-prunable status win', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    writeAged(join(dir, 'old.txt'), 'x', 40)
    await sweepSpillRoots({
      roots: [
        { path: root, pruneWhenEmpty: true },
        { path: root, pruneWhenEmpty: false },
        { path: root, pruneWhenEmpty: true },
      ],
      cutoffMs: Date.now() - 30 * DAY_MS,
      warn: () => {},
    })
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('does NOT prune a discovered root that still holds a fresh file', async () => {
    const prior = mkdtempSync(join(tmpdir(), 'dsh-spill-'))
    const priorDir = sessionDir(prior, 'sess'); mkdirSync(priorDir, { recursive: true })
    writeAged(join(priorDir, 'fresh.txt'), 'y', 1)
    try {
      await runSweep([{ path: prior, pruneWhenEmpty: true }])
      expect(existsSync(prior)).toBe(true)
      expect(existsSync(priorDir)).toBe(true)
    } finally {
      rmSync(prior, { recursive: true, force: true })
    }
  })

  it('covers the configured root AND discovered default roots (real gatherRoots)', async () => {
    // A prior default root under an isolated fake tmpdir + the configured root.
    // This test drives the REAL gatherRoots/discoverDefaultRoots path by seaming
    // only the tmpdir scan base, not gatherRoots itself.
    const fakeTmp = mkdtempSync(join(tmpdir(), 'dsh-faketmp-'))
    const priorDefault = mkdtempSync(join(fakeTmp, DEFAULT_ROOT_PREFIX))
    const priorDir = sessionDir(priorDefault, 'old-sess')
    mkdirSync(priorDir, { recursive: true })
    const priorOld = join(priorDir, 'old.txt'); writeAged(priorOld, 'x', 40)
    const cfgDir = sessionDir(root, 'sess-1')
    mkdirSync(cfgDir, { recursive: true })
    const cfgOld = join(cfgDir, 'old.txt'); writeAged(cfgOld, 'x', 40)
    class Discovering extends LocalSpillStore {
      protected override defaultRootsBase(): string { return fakeTmp }
    }
    try {
      const ctx = new Context()
      const fiber = await ctx.plugin(Discovering, { root, cleanupPeriodDays: 30 })
      await fiber.dispose()
      expect(existsSync(priorOld)).toBe(false)
      expect(existsSync(cfgOld)).toBe(false)
      // The discovered prior-default root is pruned; the configured root is kept.
      expect(existsSync(priorDefault)).toBe(false)
      expect(existsSync(root)).toBe(true)
    } finally {
      rmSync(fakeTmp, { recursive: true, force: true })
    }
  })

  it('de-dups when the active root is itself a discovered default (real gatherRoots)', async () => {
    // The configured root lives directly under the seamed base and matches the
    // default shape, so discovery finds it AND it is the active root — the sweep
    // must run once, not choke on the duplicate, and must NOT prune the active
    // root even though discovery would otherwise mark a default root prunable.
    const fakeTmp = mkdtempSync(join(tmpdir(), 'dsh-faketmp-'))
    const activeDefault = mkdtempSync(join(fakeTmp, DEFAULT_ROOT_PREFIX))
    const dir = sessionDir(activeDefault, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    class Discovering extends LocalSpillStore {
      protected override defaultRootsBase(): string { return fakeTmp }
    }
    try {
      const ctx = new Context()
      const fiber = await ctx.plugin(Discovering, { root: activeDefault, cleanupPeriodDays: 30 })
      await fiber.dispose()
      expect(existsSync(old)).toBe(false)
      // Active root survives even though its name matches the discovered shape.
      expect(existsSync(activeDefault)).toBe(true)
    } finally {
      rmSync(fakeTmp, { recursive: true, force: true })
    }
  })

  it('de-dups a configured symlink alias by filesystem identity and keeps its target writable', async () => {
    const fakeTmp = mkdtempSync(join(tmpdir(), 'dsh-faketmp-'))
    const activeDefault = mkdtempSync(join(fakeTmp, DEFAULT_ROOT_PREFIX))
    const alias = join(root, 'configured-root')
    symlinkSync(activeDefault, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const dir = sessionDir(activeDefault, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    try {
      const roots = await gatherSweepRoots(alias, () => {}, fakeTmp)
      expect(roots).toEqual([{ path: await realpath(activeDefault), pruneWhenEmpty: false }])
      await sweepSpillRoots({ roots, cutoffMs: Date.now() - 30 * DAY_MS, warn: () => {} })
      expect(existsSync(old)).toBe(false)
      expect(existsSync(activeDefault)).toBe(true)
      const saved = await saveTextFile({ root: alias, sessionId: 'next', suggestedName: 'ok.txt', content: 'ok' })
      expect(readFileSync(saved.path, 'utf8')).toBe('ok')
    } finally {
      rmSync(fakeTmp, { recursive: true, force: true })
    }
  })

  it('omits a missing active root', async () => {
    expect(await gatherSweepRoots(join(root, 'missing'), () => {}, root)).toEqual([])
  })

  it('skips a root that another POSIX user could replace', async () => {
    if (process.platform === 'win32') return
    const unsafeParent = join(root, 'unsafe-parent')
    const unsafeRoot = join(unsafeParent, 'configured')
    mkdirSync(unsafeRoot, { recursive: true, mode: 0o700 })
    const dir = sessionDir(unsafeRoot, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    chmodSync(unsafeParent, 0o777)
    const warn = vi.fn()
    const roots = await gatherSweepRoots(unsafeRoot, warn, join(root, 'missing-discovery-base'))
    expect(roots).toEqual([])
    expect(existsSync(old)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe root'))
  })

  it('does not block activation but is awaited on disposal (quiescence)', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)

    // Hold the sweep open behind a barrier we control.
    let release!: () => void
    SweptStore.sweepRoots = [active(root)]
    SweptStore.barrier = new Promise<void>((resolve) => { release = resolve })

    const ctx = new Context()
    const fiber = await ctx.plugin(SweptStore, { root, cleanupPeriodDays: 30 })
    // Activation returned while the sweep is still parked: service is usable and
    // the old file is untouched so far.
    expect(existsSync(old)).toBe(true)
    const ref = await ctx.spillStore.saveText(request())
    expect(readFileSync(ref.locator, 'utf8')).toBe('the full body')

    // Disposal must AWAIT the sweep: release the barrier, and dispose only
    // settles after the sweep deleted the old file.
    release()
    await fiber.dispose()
    expect(existsSync(old)).toBe(false)
  })

  it('an unsafe root is contained (logged, never thrown)', async () => {
    const warn = vi.fn()
    // A path that is a FILE, not a directory, is not a valid cleanup root. The
    // sweep must log and return, never reject.
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    await expect(sweepSpillRoots({ roots: [active(filePath)], cutoffMs: Date.now(), warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe root'))
  })

  it('contains an exception from the warning sink', async () => {
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    const warn = vi.fn(() => { throw new Error('logger failed') })
    await expect(sweepSpillRoots({ roots: [active(filePath)], cutoffMs: Date.now(), warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('a nonexistent root is silent (the common no-spill-yet case)', async () => {
    const warn = vi.fn()
    await sweepSpillRoots({ roots: [active(join(root, 'never-created'))], cutoffMs: Date.now(), warn })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('discoverDefaultRoots', () => {
  it('returns only real dsh-spill-* directories, excluding symlinks and non-matches', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-disc-'))
    try {
      // A real backend-shaped root (dsh-spill-<6>) via mkdtemp — the only match.
      const realRoot = mkdtempSync(join(base, DEFAULT_ROOT_PREFIX))
      mkdirSync(join(base, 'unrelated-dir'))
      // Names of the EXACT default shape that must still be excluded because they
      // are not real directories the backend could have created.
      writeFileSync(join(base, `${DEFAULT_ROOT_PREFIX}file01`), 'x') // matches shape but is a file
      symlinkSync(realRoot, join(base, `${DEFAULT_ROOT_PREFIX}link01`)) // matches shape but is a symlink
      const found = await discoverDefaultRoots(() => {}, base)
      expect(found).toEqual([await realpath(realRoot)])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('returns [] and warns when the base is unreadable', async () => {
    const warn = vi.fn()
    const missing = join(root, 'no-such-base')
    expect(await discoverDefaultRoots(warn, missing)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to scan'))
  })
})

describe('isErrno', () => {
  it('matches a Node system error by code and rejects non-matches', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENOENT' })
    expect(isErrno(err, 'ENOENT')).toBe(true)
    expect(isErrno(err, 'EPERM')).toBe(false)
    expect(isErrno('not an error', 'ENOENT')).toBe(false)
    expect(isErrno(new Error('no code'), 'ENOENT')).toBe(false)
  })
})
