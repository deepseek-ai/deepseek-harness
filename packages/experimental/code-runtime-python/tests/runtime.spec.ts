import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PythonCodeRuntime, hostFrameParseCeiling, readProcessStart, resolvePythonBin } from '../src/index.ts'
import { logTruncationMarker } from '../src/protocol.ts'
import type { Config } from '../src/index.ts'

// Absolute supported interpreter path for shell wrappers. The runtime gives a
// child only TMPDIR, so a bare `python3` inside a wrapper would resolve against
// /bin/sh's default PATH rather than the caller's selected interpreter.
const PYABS = resolvePythonBin('python3') ?? 'python3'
import type { CodeBindingFunction, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/**
 * Names one `py/` script whose `copyFileSync` must fail, for the partial-staging
 * case. A real disk-full or missing-asset failure mid-copy cannot be produced
 * from a test, and the leak only shows when `mkdtempSync` has already succeeded.
 *
 * `stagedDirs` records every staging directory THIS test file creates, so the
 * leak assertions check the exact paths instead of a global tmpdir diff: a
 * parallel vitest worker running the same prefix could create or remove
 * `dsh-code-runtime-python-*` directories inside the sampling window, which a
 * readdir diff would misattribute to this test. `boot-write-failure.spec.ts`
 * records the same race and solves it with argv-based identity; recording the
 * mkdtempSync results is the fs-mock equivalent.
 */
const { failNextCopyOf, stagedDirs, tempDirs, tempFiles } = vi.hoisted(() => ({
  failNextCopyOf: { value: undefined as string | undefined },
  stagedDirs: [] as string[],
  // Test-created temp dirs/files, registered by the helpers below and removed
  // after each test: a suite run over real python3 subprocesses must not
  // permanently accumulate `dsh-*` fixtures in the shared tmpdir (the runtime
  // cleans its own per-run staging dir; these are the stubs and wrappers the
  // tests themselves build).
  tempDirs: [] as string[],
  tempFiles: [] as string[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    copyFileSync(source: string, destination: string): void {
      if (failNextCopyOf.value !== undefined && basename(source) === failNextCopyOf.value) {
        failNextCopyOf.value = undefined
        throw Object.assign(new Error('simulated ENOSPC on copy'), { code: 'ENOSPC' })
      }
      actual.copyFileSync(source, destination)
    },
    mkdtempSync(prefix: string): string {
      const dir = actual.mkdtempSync(prefix)
      if (basename(prefix).startsWith('dsh-code-runtime-python-')) stagedDirs.push(dir)
      return dir
    },
  }
})

/**
 * Integration suite over REAL python3 subprocesses (no subprocess mocks — it is
 * cheap and local, per docs/testing.md's real-over-mock policy; the only mock is
 * `node:fs.copyFileSync` for the staging-failure cases). Each test builds a fresh
 * runtime so budgets can be tuned per case.
 */
async function setup(config: Config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(PythonCodeRuntime, config)
  const runtime = ctx.codeRuntime as PythonCodeRuntime
  return { ctx, fiber, runtime }
}

/** Convenience: one namespace `tools` with the given functions. */
function tools(functions: Record<string, CodeBindingFunction>) {
  return [{ global: 'tools', functions }]
}

/** Create a test temp dir registered for afterEach removal. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Synchronous variant of {@link makeTempDir} for the PATH-stub fixtures. */
function makeTempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Remove every fixture this file created, so repeated runs do not accumulate
// `dsh-*` directories and wrappers in the shared tmpdir.
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

describe('PythonCodeRuntime — seam descriptors and misuse', () => {
  it('registers the seam descriptors', async () => {
    const { runtime } = await setup()
    expect(runtime.language).toBe('python')
    expect(runtime.isolation).toBe('process')
  })

  it('rejects non-positive config as seam misuse', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { cpuSeconds: 0 }))
      .rejects.toThrow(/cpuSeconds must be a positive number/)
    await expect(ctx.plugin(PythonCodeRuntime, { maxWallMs: -1 }))
      .rejects.toThrow(/maxWallMs must be a positive number/)
  })

  it('rejects a non-integer cpuSeconds at load (setrlimit needs an int)', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { cpuSeconds: 1.5 }))
      .rejects.toThrow(/cpuSeconds must be a positive integer, got 1.5/)
  })

  it('rejects a non-integer byte budget at load (the child int()-truncates it)', async () => {
    // maxLogBytes/maxValueBytes cross to the child, which reads them through
    // int(...): a float would floor there while the host meters the fraction, so
    // the two sides would enforce different public config. Reject at load.
    const ctxLog = new Context()
    await expect(ctxLog.plugin(PythonCodeRuntime, { maxLogBytes: 3.5 }))
      .rejects.toThrow(/maxLogBytes must be a positive integer/)
    const ctxValue = new Context()
    await expect(ctxValue.plugin(PythonCodeRuntime, { maxValueBytes: 1024.5 }))
      .rejects.toThrow(/maxValueBytes must be a positive integer/)
  })

  it('rejects finite numeric config that cannot cross as an exact rlimit integer', async () => {
    // `Number.isFinite` and `Number.isInteger` both admit values that cannot
    // round-trip. `addressSpaceMb: 1e308` overflows to `Infinity` once multiplied
    // by 1 MiB, and `encodeJsonPlain` renders that as `null`, so the child gets no
    // limit at all; `cpuSeconds: 1e100` clears `Number.isInteger` while sitting
    // far past the safe range, so `setrlimit` receives a different number than was
    // configured. Both used to end every run in a bootstrap exception instead of
    // failing at load, where a self-contained configuration error belongs.
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { addressSpaceMb: 1e308 }))
      .rejects.toThrow(/addressSpaceMb must be at most \d+ .*exact integer/)
    await expect(ctx.plugin(PythonCodeRuntime, { cpuSeconds: 1e100 }))
      .rejects.toThrow(/cpuSeconds must be at most \d+ .*exact integers/)
    // The boundary values still load: the bound rejects what cannot be encoded,
    // not everything large.
    const okMb = await ctx.plugin(PythonCodeRuntime, { addressSpaceMb: Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024)) })
    await okMb.dispose()
    const okCpu = await ctx.plugin(PythonCodeRuntime, { cpuSeconds: Number.MAX_SAFE_INTEGER - 1 })
    await okCpu.dispose()
  })

  it('rejects an output cap whose payload could not cross the frame ceiling', async () => {
    // The caps budget a payload that must arrive inside ONE fd-3 frame, and the
    // 64 MiB frame parse cap is fixed. A larger cap is unsatisfiable rather
    // than generous: a completion the cap admits arrives as an over-ceiling
    // frame and fails the run as `worker-exit`, inverting the `output-limit`
    // the cap describes. Both budgets are metered in already-escaped serialized
    // bytes, so a payload occupies at most `cap + envelope` on the wire; the
    // bound is `parse-cap - envelope`, not `(ceiling - envelope) / 6` (that
    // divided in escape expansion the charge already counts). The receive path
    // rejects raw frames past the 64 MiB parse cap (the run settles as a
    // worker-exit), so a budget above it would admit a config whose honest
    // child frames the host then rejects.
    const admissible = 64 * 1024 * 1024 - 64
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { maxLogBytes: admissible + 1 }))
      .rejects.toThrow(/maxLogBytes must not exceed 67108800/)
    await expect(ctx.plugin(PythonCodeRuntime, { maxValueBytes: admissible + 1 }))
      .rejects.toThrow(/maxValueBytes must not exceed 67108800/)
    // The boundary value itself loads: the bound is the largest cap a frame can
    // still carry, not one below it. It needs an address space large enough to
    // clear the separate maxValueBytes/addressSpaceMb worst-case gate (the cap
    // times the 12x Unicode expansion must fit), so this pairs it with a 4 GiB
    // addressSpaceMb — the two load-time bounds are independent.
    const boundary = await ctx.plugin(PythonCodeRuntime, { maxValueBytes: admissible, addressSpaceMb: 4096 })
    await boundary.dispose()
  })

  it('rejects a completion budget whose frame a constrained host heap cannot safely parse', async () => {
    // The load gate bounds the CHILD's build-and-encode under RLIMIT_AS; it
    // does not bound the HOST's JSON.parse, which materializes several times a
    // wide frame's raw bytes in property storage. In a child node with a
    // 128 MiB old space the heap-derived frame cap is ~7 MiB, so a 50 MiB
    // budget is rejected at load even though the address-space gate alone
    // would admit it (50 MiB * 12 = 600 MiB < 1 GiB - 64 MiB).
    const script = [
      "import { Context } from '@deepseek-ai/cordis'",
      "import { PythonCodeRuntime } from './packages/experimental/code-runtime-python/src/index.ts'",
      'const ctx = new Context()',
      'try {',
      '  await ctx.plugin(PythonCodeRuntime, { maxValueBytes: 50 * 1024 * 1024, addressSpaceMb: 1024 })',
      "  console.log('LOADED')",
      '  process.exit(1)',
      '} catch (error) {',
      "  console.log('REJECTED:' + (error instanceof Error ? error.message : String(error)))",
      '  process.exit(0)',
      '}',
    ].join('\n')
    const out = execFileSync(process.execPath, ['--max-old-space-size=128', '--import', 'tsx', '-e', script], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../../../../tsconfig.json') },
    })
    expect(out).toContain('REJECTED:')
    expect(out).toContain('must not exceed')
  }, 60_000)

  it('parses a worst-shape frame at the derived cap on a constrained heap', async () => {
    // The host-heap frame cap must be measured against the WORST parse shape —
    // a dict of many short unique keys, which forces dictionary-mode property
    // storage plus interned keys (~6.4x at 3M keys, trending up), not the ~3x
    // of a repeated-key dict. A child node with a 128 MiB old space (~176 MiB
    // heap limit) derives a cap of floor((176 - 64) / 16) = 7 MiB; the
    // subprocess builds a unique-key dict whose frame is AT that cap and
    // parses it, which must survive. Verified fail-before: with the multiple
    // at 8 the derived cap doubles to 14 MiB and the same subprocess OOMs
    // during the parse (plain JS, no tsx — the frame and parse are builtins).
    const cap = hostFrameParseCeiling(176 * 1024 * 1024)
    const script = [
      `const cap = ${cap}`,
      // Each entry "k<base36>:1," is ~9-12 raw bytes; a few hundred thousand
      // unique keys put the frame just at the cap.
      'const count = Math.floor(cap / 12)',
      'const obj = {}',
      'for (let i = 0; i < count; i++) obj[`k${i.toString(36)}`] = 1',
      'const frame = JSON.stringify(obj)',
      "if (Buffer.byteLength(frame, 'utf8') > cap) throw new Error('frame over cap: ' + frame.length)",
      'JSON.parse(frame)',
      "console.log('SURVIVED:' + Buffer.byteLength(frame, 'utf8'))",
    ].join('\n')
    const out = execFileSync(process.execPath, ['--max-old-space-size=128', '-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(out).toContain('SURVIVED:')
  }, 60_000)

  it('rejects a pythonBin that spawn() would throw on, at load', async () => {
    // Both values pass the string schema and both make `spawn` throw
    // SYNCHRONOUSLY from inside run() — ERR_INVALID_ARG_VALUE for the empty
    // path, ERR_INVALID_ARG_TYPE for the NUL — so run() would REJECT instead of
    // resolving the worker-exit the seam promises for a child that cannot
    // start. Both are self-contained configuration errors, so they fail here.
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { pythonBin: '' }))
      .rejects.toThrow(/pythonBin must be a non-empty path without NUL bytes/)
    await expect(ctx.plugin(PythonCodeRuntime, { pythonBin: 'py\u0000thon3' }))
      .rejects.toThrow(/pythonBin must be a non-empty path without NUL bytes/)
  })

  it('rejects an explicit pythonBin that is not an executable regular file, at load', async () => {
    // An explicit path (absolute, or containing a slash) bypasses PATH lookup,
    // so it must be validated directly: missing, non-executable, or directory
    // paths are self-contained configuration errors that used to slip through
    // load and surface only at the first run() as a misleading worker-exit.
    // The message distinguishes the explicit-path failure from a basename that
    // simply does not resolve on PATH.
    const nodePath = await import('node:path')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const dir = makeTempDirSync('dsh-bad-bin-')
    const notExecutable = nodePath.join(dir, 'not-executable')
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n') // Regular file, but no X bit.
    const directory = nodePath.join(dir, 'is-a-directory')
    mkdirSync(directory)
    try {
      const missing = new Context()
      await expect(missing.plugin(PythonCodeRuntime, { pythonBin: nodePath.join(dir, 'missing') }))
        .rejects.toThrow(/is not an executable regular file/)
      const noX = new Context()
      await expect(noX.plugin(PythonCodeRuntime, { pythonBin: notExecutable }))
        .rejects.toThrow(/is not an executable regular file/)
      const isDir = new Context()
      await expect(isDir.plugin(PythonCodeRuntime, { pythonBin: directory }))
        .rejects.toThrow(/is not an executable regular file/)
      // A relative explicit path fails the same way, resolved against the host
      // CWD: `dir` is absolute, so a slash-containing relative form of it is
      // the dirname prefix plus the file, which does not exist as such.
      const rel = new Context()
      await expect(rel.plugin(PythonCodeRuntime, { pythonBin: './definitely-not-there-python' }))
        .rejects.toThrow(/is not an executable regular file/)
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-CPython, outdated, or probe-failing interpreter at load', async () => {
    const nonPython = new Context()
    await expect(nonPython.plugin(PythonCodeRuntime, { pythonBin: '/bin/echo' }))
      .rejects.toThrow(/did not report a CPython version/)

    const dir = await mkdtemp(join(tmpdir(), 'dsh-python-probe-'))
    const oldMajor = join(dir, 'python-old-major')
    const old = join(dir, 'python-old')
    const future = join(dir, 'python-future')
    const pypy = join(dir, 'pypy')
    const failed = join(dir, 'python-failed')
    await writeFile(oldMajor, '#!/bin/sh\nprintf \'cpython 2 99 0\\n\'\n', { mode: 0o755 })
    await writeFile(old, '#!/bin/sh\nprintf \'cpython 3 9 6\\n\'\n', { mode: 0o755 })
    await writeFile(future, '#!/bin/sh\nprintf \'cpython 4 0 0\\n\'\n', { mode: 0o755 })
    await writeFile(pypy, '#!/bin/sh\nprintf \'pypy 3 10 0\\n\'\n', { mode: 0o755 })
    await writeFile(failed, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
    try {
      expect(resolvePythonBin(relative(process.cwd(), old))).toBe(old)
      const obsolete = new Context()
      await expect(obsolete.plugin(PythonCodeRuntime, { pythonBin: oldMajor }))
        .rejects.toThrow(/must be CPython 3\.10 or newer, got cpython 2\.99\.0/)
      const outdated = new Context()
      await expect(outdated.plugin(PythonCodeRuntime, { pythonBin: old }))
        .rejects.toThrow(/must be CPython 3\.10 or newer, got cpython 3\.9\.6/)
      const forwardCompatible = new Context()
      const fiber = await forwardCompatible.plugin(PythonCodeRuntime, { pythonBin: future })
      await fiber.dispose()
      const alternative = new Context()
      await expect(alternative.plugin(PythonCodeRuntime, { pythonBin: pypy }))
        .rejects.toThrow(/must be CPython, got pypy/)
      const probeFailure = new Context()
      await expect(probeFailure.plugin(PythonCodeRuntime, { pythonBin: failed }))
        .rejects.toThrow(/failed the CPython version probe/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an explicit executable pythonBin working through load and run', async () => {
    // The same validation that rejects bad explicit paths must admit a good
    // one: an absolute path to the real interpreter (or a wrapper around it)
    // is the deployment form the validation exists to serve.
    const pyAbs = resolvePythonBin('python3') ?? 'python3'
    const { runtime, fiber } = await setup({ pythonBin: pyAbs, maxWallMs: 30_000 })
    const result = await runtime.run({ program: 'return 1', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1)
    await fiber.dispose()
  })

  it('rejects a binding member accessor that throws, as seam misuse', async () => {
    // `namespace.functions` is caller-supplied, so its members may come from a
    // getter or Proxy. Reading one of them inside the fd-3 `data` callback used
    // to throw OUTSIDE the dispatcher's try and terminate the host; the
    // validation now snapshots the callables synchronously, so the throw
    // surfaces as the seam-misuse rejection run() reserves for malformed
    // bindings — the child is never spawned.
    const { runtime } = await setup()
    const exploding = {
      get explode(): CodeBindingFunction {
        throw new Error('getter blew up')
      },
    }
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: exploding }],
    })).rejects.toThrow(/getter blew up/)
  })

  it('snapshots binding callables once, so a getter is read exactly once', async () => {
    // The snapshot also fixes the key set the boot frame advertises: the child
    // learns the namespace names from the SAME record dispatch reads, so a
    // getter whose keys differ between reads cannot desynchronize the two.
    let reads = 0
    const countReads = {
      get first(): CodeBindingFunction {
        reads += 1
        return async () => 1
      },
    }
    const { runtime, fiber } = await setup()
    const result = await runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: countReads }],
    })
    expect(result.error).toBeUndefined()
    // One read for the validation snapshot; the boot frame and every dispatch
    // read the snapshot, not the getter.
    expect(reads).toBe(1)
    await fiber.dispose()
  })

  it('keeps a __proto__ binding member dispatchable', async () => {
    // The seam contract treats member names like `__proto__` or `constructor`
    // as ordinary own properties (null-prototype construction). The binding
    // snapshot must preserve that: a plain `{}` record would hit the prototype
    // setter on assignment and drop the member, so the child would never learn
    // the name and a call to it would fail with KeyError.
    const { runtime, fiber } = await setup()
    const result = await runtime.run({
      program: 'return await tools["__proto__"]({})',
      bindings: [{
        global: 'tools',
        functions: { ['__proto__']: async () => 'proto-callable' },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('proto-callable')
    await fiber.dispose()
  })

  it('resolves pythonBin once so a later PATH change cannot switch interpreters', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'dsh-python-first-'))
    const secondDir = await mkdtemp(join(tmpdir(), 'dsh-python-second-'))
    const wrapper = (marker: string): string => `#!/bin/sh\nDSH_TEST_PYTHON=${marker}\nexport DSH_TEST_PYTHON\nexec "${PYABS}" "$@"\n`
    await writeFile(join(firstDir, 'python3'), wrapper('first'), { mode: 0o755 })
    await writeFile(join(secondDir, 'python3'), wrapper('second'), { mode: 0o755 })
    vi.stubEnv('PATH', firstDir)
    let fiber: Awaited<ReturnType<typeof setup>>['fiber'] | undefined
    try {
      const mounted = await setup({ pythonBin: 'python3' })
      fiber = mounted.fiber
      vi.stubEnv('PATH', secondDir)
      const result = await mounted.runtime.run({
        program: 'import os\nreturn os.environ.get("DSH_TEST_PYTHON")',
        bindings: [],
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe('first')
    } finally {
      await fiber?.dispose()
      vi.unstubAllEnvs()
      rmSync(firstDir, { recursive: true, force: true })
      rmSync(secondDir, { recursive: true, force: true })
    }
  })

  it('skips relative PATH entries when resolving a basename pythonBin', async () => {
    // resolvePythonBin must return an absolute path: a RELATIVE PATH entry
    // ('.' here) would otherwise resolve the basename against the host CWD.
    // This run's CWD holds no executable named python3, so both the relative
    // skip and the accessSync-miss fall through to the absolute entry — the
    // case pins the contract (absolute candidate wins over a relative PATH
    // prefix), not a worker-exit distinction, which would need an executable
    // named python3 in the test CWD.
    const cp = await import('node:child_process')
    const nodePath = await import('node:path')
    const pythonDir = nodePath.dirname(cp.execFileSync('which', ['python3'], { encoding: 'utf8' }).trim())
    vi.stubEnv('PATH', `.:${pythonDir}`)
    try {
      const { runtime, fiber } = await setup({ pythonBin: 'python3', maxWallMs: 30_000 })
      const result = await runtime.run({ program: 'return 1', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(1)
      await fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  }, 45_000)

  it('ignores a forged second boot-ack without re-sending the run frame', async () => {
    // The run frame is sent once, from the first boot-ack; a program that
    // forges an extra boot-ack frame on fd 3 must not re-enter the gate (a
    // second run frame would confuse the child's frame reader). The honest
    // child sends exactly one ack; the forged one exercises the re-entry
    // guard.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        // One forged boot-ack after the program starts; the run already went
        // out on the real ack.
        "os.write(3, b'{\"type\":\"boot-ack\"}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
  }, 15_000)

  it('skips a PATH entry that is an executable DIRECTORY named like the interpreter', async () => {
    // accessSync(X_OK) succeeds on directories, so without the isFile guard a
    // PATH entry like a `python3` directory would be chosen over a later real
    // interpreter. The stub PATH puts such a directory first and asserts the
    // real interpreter is used.
    const cp = await import('node:child_process')
    const nodePath = await import('node:path')
    const { mkdirSync } = await import('node:fs')
    const realPythonDir = nodePath.dirname(cp.execFileSync('which', ['python3'], { encoding: 'utf8' }).trim())
    const fakeDir = makeTempDirSync('dsh-fake-bin-')
    mkdirSync(nodePath.join(fakeDir, 'python3')) // A directory named python3, executable by default.
    vi.stubEnv('PATH', `${fakeDir}:${realPythonDir}`)
    try {
      const { runtime, fiber } = await setup({ pythonBin: 'python3', maxWallMs: 30_000 })
      const result = await runtime.run({ program: 'return 1', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(1)
      await fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  }, 45_000)

  it('rejects a timer budget setTimeout would silently clamp to 1 ms', async () => {
    // Node stores a setTimeout delay as a signed 32-bit value and substitutes
    // 1 ms for anything larger, inverting the knob's meaning: a huge maxWallMs
    // would time every run out at once, and a huge graceMs would SIGKILL one
    // millisecond after SIGTERM. Both must fail at load instead.
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { maxWallMs: 2_147_483_648 }))
      .rejects.toThrow(/maxWallMs must not exceed 2147483647/)
    // graceMs is bounded by the close deadline's added margin, not by the raw
    // timer maximum, because that sum is what gets armed.
    await expect(ctx.plugin(PythonCodeRuntime, { graceMs: 2_147_481_648 }))
      .rejects.toThrow(/graceMs must not exceed 2147481647/)
    // The exact maxima still load.
    await expect(ctx.plugin(PythonCodeRuntime, { maxWallMs: 2_147_483_647, graceMs: 2_147_481_647 }))
      .resolves.toBeDefined()
  })

  it('rejects loading this Unix-only backend on Windows', async () => {
    // The bootstrap needs the POSIX `resource` module, a positional fd 3, and
    // negative-PID process-group signals — none on Windows. The constructor
    // must throw at load rather than register ctx.codeRuntime and defer the
    // failure to the first run.
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const ctx = new Context()
      await expect(ctx.plugin(PythonCodeRuntime, {})).rejects.toThrow(/requires a Unix platform/)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('rejects a binding global that is not a Python identifier or is reserved', async () => {
    const { runtime } = await setup()
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: '1bad', functions: {} }],
    })).rejects.toThrow(/is not a usable Python identifier/)
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: 'class', functions: {} }],
    })).rejects.toThrow(/is not a usable Python identifier/)
  })

  it('rejects duplicate binding namespaces', async () => {
    const { runtime } = await setup()
    await expect(runtime.run({
      program: 'return 1',
      bindings: [
        { global: 'tools', functions: {} },
        { global: 'tools', functions: {} },
      ],
    })).rejects.toThrow(/duplicate binding global/)
  })

  it('rejects run() after disposal, and unregisters ctx.codeRuntime', async () => {
    const { ctx, fiber, runtime } = await setup()
    await fiber.dispose()
    await expect(runtime.run({ program: 'return 1', bindings: [] }))
      .rejects.toThrow(/after disposal/)
    expect(ctx.get('codeRuntime')).toBeUndefined()
  })

  it('short-circuits when the request signal is already aborted', async () => {
    const { runtime } = await setup()
    const signal = AbortSignal.abort('already-cancelled')
    const result = await runtime.run({ program: 'return 1', bindings: [], signal })
    expect(result.error?.kind).toBe('abort')
    expect(result.error?.message).toContain('already-cancelled')
    expect(result.logs).toEqual([])
  })

  it('short-circuits on an already-aborted signal whose reason cannot be converted', async () => {
    // The pre-flight arm converted the reason with a bare `String()`, so a
    // hostile reason threw out of `run()` — the seam promises to reject only for
    // misuse, and a caller's cancellation token is not misuse.
    const { runtime } = await setup()
    const signal = AbortSignal.abort({
      [Symbol.toPrimitive]() { throw new Error('reason blew up') },
    })
    const result = await runtime.run({ program: 'return 1', bindings: [], signal })
    expect(result.error?.kind).toBe('abort')
    expect(result.error?.message).toBe('<unrenderable rejection value>')
    expect(result.logs).toEqual([])
  })

  it('runs the interpreter from materialized scripts outside the package, and removes them per run', async () => {
    // The interpreter is an EXTERNAL process, so it can only open paths the OS
    // resolves. Inside the single-file Python-SDK executable the packaged `py/`
    // directory lives in pkg's virtual filesystem, which Node reads through its
    // patched `fs` but `python3` cannot see, so spawning from that path fails
    // with ENOENT. The scripts are therefore copied to a real directory first.
    //
    // The path is read from the child's own `__main__` module, so it proves
    // where the interpreter actually loaded the entry script — asserting on a
    // host-side constant would only restate the source. The program namespace
    // seeds `__name__` but no `__file__`, hence the module lookup.
    // `protocol.py` must land in the SAME directory, since `bootstrap.py` puts
    // its own directory on `sys.path` to import it; the run completing at all
    // already exercises that import.
    const { runtime } = await setup()
    const entryOf = async (): Promise<string> => {
      const result = await runtime.run({ program: 'import sys\nreturn sys.modules["__main__"].__file__', bindings: [] })
      expect(result.error).toBeUndefined()
      return result.value as string
    }
    const entry = await entryOf()
    expect(entry.endsWith('/bootstrap.py')).toBe(true)
    const dir = dirname(entry)
    expect(realpathSync(dirname(dir))).toBe(realpathSync(tmpdir()))
    expect(basename(dir)).toMatch(/^dsh-code-runtime-python-/)
    expect(dir).not.toContain('/packages/')
    // Staging is per RUN and removed at settlement, so by the time `run()`
    // resolved the directory is already gone — nothing survives to be rewritten
    // by a later run. `protocol.py` had to be beside the entry script for the run
    // to complete at all, since `bootstrap.py` imports it off `sys.path`.
    expect(existsSync(dir)).toBe(false)
    // A second run stages its own copy rather than reusing the first.
    expect(dirname(await entryOf())).not.toBe(dir)
  })

  it('contains a program that rewrites its own bootstrap to the run that did it', async () => {
    // The child runs as the same UID as the host, so `0o700` does not stop model
    // code from rewriting the scripts it was started from —
    // `sys.modules['__main__'].__file__` names them. While all runs shared one
    // staged copy, a program that overwrote `bootstrap.py` broke the NEXT run
    // (measured: it settled as `worker-exit`), and substituted code would have
    // run before the resource limits were applied.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const sabotage = await runtime.run({
      program: [
        'import sys',
        'path = sys.modules["__main__"].__file__',
        'open(path, "w").write("raise SystemExit(1)\\n")',
        'return path',
      ].join('\n'),
      bindings: [],
    })
    expect(sabotage.error).toBeUndefined()
    // The damage stayed inside the run that caused it.
    const after = await runtime.run({ program: 'return 1 + 1', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.value).toBe(2)
  }, 20_000)

  it('leaves no subprocess or scripts behind when disposal races the first run', async () => {
    // Staging runs SYNCHRONOUSLY so no async boundary opens between `run()` and
    // the point where `execute` registers the run in `live` and installs the
    // abort listener. With an `await` there, a disposal landing in that window
    // saw an empty `live`, returned, removed the script directory, and let the
    // continuation spawn a subprocess after the fiber was gone.
    //
    // `dispose()` is called in the same synchronous turn as `run()`, with no
    // `await` between them, so it lands exactly in that window.
    //
    // The leak assertion checks the EXACT paths this test file staged (recorded
    // by the mocked mkdtempSync) rather than diffing a global tmpdir: a
    // parallel vitest worker can create or remove same-prefix directories
    // inside the sampling window, which a readdir diff would misattribute to
    // this test (boot-write-failure.spec.ts records the same race).
    const stagedBefore = stagedDirs.length
    const { fiber, runtime } = await setup({ maxWallMs: 8_000 })
    const pending = runtime.run({ program: 'import time\nwhile True: time.sleep(0.1)', bindings: [] })
    const disposed = fiber.dispose()
    const result = await pending
    await disposed
    // Whatever the run reports, it must be terminal and must not be a success.
    expect(result.value).toBeUndefined()
    expect(['abort', 'worker-exit', 'timeout']).toContain(result.error?.kind)
    // Disposal is to quiescence, so every directory this run staged is gone.
    const created = stagedDirs.slice(stagedBefore)
    for (const dir of created) expect(existsSync(dir)).toBe(false)
  }, 15_000)

  it('settles as abort when the signal fires in the same turn as the first run', async () => {
    // Same window, the other listener. `addEventListener('abort')` does not
    // replay an event that already fired, so an abort landing before the
    // listener was installed used to be missed entirely and the program ran to
    // success or the wall ceiling instead of resolving as `abort`. Synchronous
    // staging keeps the pre-flight check and the listener in one turn, leaving
    // no gap for the signal to slip through.
    const { runtime } = await setup({ maxWallMs: 4_000, graceMs: 200 })
    const controller = new AbortController()
    const pending = runtime.run({
      program: 'import time\nwhile True: time.sleep(0.1)',
      bindings: [],
      signal: controller.signal,
    })
    controller.abort('same-turn-abort')
    const result = await pending
    expect(result.error?.kind).toBe('abort')
    expect(result.error?.message).toContain('same-turn-abort')
  }, 15_000)

  it('reports a staging failure as worker-exit instead of rejecting run()', async () => {
    // Staging touches the filesystem, so it can fail for reasons that are not
    // the caller's doing: a full or read-only temp filesystem, or a deployment
    // that failed to ship the packaged scripts. Those are SUBSTRATE failures,
    // the same class as a child that cannot start, and the seam reserves
    // rejection for misuse — so `run()` must resolve, not throw.
    //
    // `TMPDIR` is the honest lever: `mkdtempSync` builds its path from
    // `os.tmpdir()`, so pointing it at a path that is not a directory makes the
    // real call fail without stubbing the module under test.
    const previous = process.env.TMPDIR
    const notADirectory = join(await makeTempDir('dsh-staging-'), 'file')
    await writeFile(notADirectory, '')
    process.env.TMPDIR = notADirectory
    try {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'return 1', bindings: [] })
      expect(result.error?.kind).toBe('worker-exit')
      expect(result.error?.message).toContain('failed to stage the python bootstrap')
      expect(result.logs).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('leaves no staging directory behind when a script copy fails', async () => {
    // `mkdtempSync` succeeding and a later `copyFileSync` failing is its own
    // case: the directory exists but is only partially populated. Recording it
    // before the copies would leak it, because `run` retries staging on the next
    // call and overwrites the single recorded path — teardown could then remove
    // only the newest attempt. Staging must clean up its own partial directory.
    //
    // Only `copyFileSync` is stubbed, and only for the second script, so
    // `mkdtempSync` really runs and the directory under assertion is real.
    // The assertion checks the exact paths this test staged (see the sibling
    // disposal-race test for why a global tmpdir diff races parallel workers).
    const stagedBefore = stagedDirs.length
    failNextCopyOf.value = 'protocol.py'
    try {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'return 1', bindings: [] })
      expect(result.error?.kind).toBe('worker-exit')
      expect(result.error?.message).toContain('failed to stage the python bootstrap')
      // The partial directory is gone, so nothing accumulates across retries.
      for (const dir of stagedDirs.slice(stagedBefore)) expect(existsSync(dir)).toBe(false)
    } finally {
      failNextCopyOf.value = undefined
    }
  }, 15_000)
})

describe('PythonCodeRuntime — process identity', () => {
  it('reads a live process start time and distinguishes it from an absent pid', () => {
    // The teardown guard signals `-child.pid` with a RAW `process.kill`, which
    // (unlike `child.kill()`) has no handle check, so it would reach a recycled
    // pgid during the window between the leader being reaped and `close` firing.
    // A pid alone cannot separate the original from its replacement -- both
    // answer `kill(pid, 0)` -- so the guard compares START TIME, and this pins
    // that the reading is stable for one process and absent for a pid that
    // cannot be read.
    const own = readProcessStart(process.pid)
    if (process.platform === 'linux') {
      // Same process, two reads: the identity must be stable, or the guard would
      // refuse to signal its own live group.
      expect(own).toBeDefined()
      expect(readProcessStart(process.pid)).toBe(own)
      // Pid 0 is never a readable /proc entry, so the guard degrades to
      // undefined rather than throwing on a teardown path. This is also the
      // reading a REAPED leader produces -- its /proc entry is gone while the
      // group it led can still hold survivors -- so `undefined` must NOT be
      // treated as an identity mismatch. Reading it as one refused the SIGKILL
      // that the same-group survivor tests depend on, which is why they went red
      // on Linux while passing on Darwin (where the reader always returns
      // undefined and the guard is inert).
      expect(readProcessStart(0)).toBeUndefined()
    } else {
      // Darwin has no /proc: the reader reports undefined, and `killGroup`
      // signals the pgid without the identity re-check instead of paying a `ps`
      // fork per signal.
      expect(own).toBeUndefined()
    }
  })
})

describe('PythonCodeRuntime — inherited resource limits', () => {
  // Darwin deliberately does not apply RLIMIT_AS, and its shell rejects `ulimit -v`.
  it.skipIf(process.platform === 'darwin')('runs under an inherited hard limit tighter than addressSpaceMb', async () => {
    // An unprivileged process may lower a hard rlimit but never raise it. Under
    // a harness started with `ulimit -v` below `addressSpaceBytes`, requesting
    // the configured cap made `setrlimit` raise `ValueError` and every run
    // returned a bootstrap exception — even though the inherited limit is
    // STRONGER than the one asked for. The bootstrap clamps to the inherited
    // hard limit instead, so the run proceeds under the stricter bound.
    //
    // `pythonBin` is the honest lever: a wrapper that lowers RLIMIT_AS and then
    // execs the real interpreter reproduces the inherited-limit condition
    // without touching this test process's own limits.
    const dir = await makeTempDir('dsh-rlimit-')
    const wrapper = join(dir, 'python3-capped')
    // 256 MiB, half the 512 MiB addressSpaceMb default, so the requested cap is
    // unambiguously above the inherited ceiling.
    await writeFile(wrapper, `#!/bin/sh\nulimit -v 262144\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime } = await setup({ pythonBin: wrapper })
    const result = await runtime.run({
      program: 'import resource\nreturn resource.getrlimit(resource.RLIMIT_AS)[1]',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    // The applied hard limit is the inherited one, not the configured 512 MiB.
    expect(result.value).toBe(256 * 1024 * 1024)
  }, 15_000)

  it('rejects at boot when an inherited RLIMIT_AS is too tight for the output budgets', async () => {
    // The host gate validates the output budgets against the CONFIGURED
    // addressSpaceMb, but a launch environment can inherit a STRICTER RLIMIT_AS
    // (a `ulimit -v` wrapper below addressSpaceMb), which the bootstrap clamps the
    // effective limit down to — leaving the budgets sized for a ceiling the child
    // never gets, so a near-budget output would OOM mid-run as an opaque
    // worker-exit. The bootstrap re-checks both budgets against the EFFECTIVE
    // clamped limit and fails loud at boot instead. A 128 MiB inherited limit
    // leaves 64 MiB budgetable (~5 MiB admissible under the 12x multiple), under
    // which a 32 MiB maxLogBytes — admitted by the 512 MiB configured default — is
    // rejected. The rejection surfaces as an 'exception' (bootstrap's
    // setrlimit-phase failure class), not a mid-run OOM. The repro is Linux-only
    // (macOS ignores `ulimit -v`); there the run proceeds.
    const dir = await makeTempDir('dsh-rlimit-')
    const wrapper = join(dir, 'python3-tight')
    await writeFile(wrapper, `#!/bin/sh\nulimit -v 131072\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime } = await setup({ pythonBin: wrapper, maxLogBytes: 32 * 1024 * 1024, addressSpaceMb: 512 })
    const result = await runtime.run({ program: 'return 1', bindings: [] })
    if (process.platform === 'darwin') {
      expect(result.error).toBeUndefined()
    } else {
      // The re-check raises inside bootstrap's resource-limit block, which
      // reports every setrlimit-phase failure as kind 'exception'; the message
      // discriminates this config rejection from a generic setrlimit error.
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain('too large for the inherited RLIMIT_AS')
    }
  }, 15_000)

  // The expected tuple includes RLIMIT_AS, which the backend deliberately skips on Darwin.
  it.skipIf(process.platform === 'darwin')('applies the configured limits when nothing tighter is inherited', async () => {
    // The clamp must not weaken the normal path: with an infinite inherited hard
    // limit there is nothing to clamp against, and RLIM_INFINITY compares as -1,
    // so treating it as a numeric bound would collapse every limit to -1.
    const { runtime } = await setup({ cpuSeconds: 42, addressSpaceMb: 400 })
    const result = await runtime.run({
      // `getrlimit` returns a tuple, which the lossless-JSON completion check
      // rejects; the pair is listed explicitly rather than converted.
      program: [
        'import resource, sys',
        'cpu = resource.getrlimit(resource.RLIMIT_CPU)',
        'address_space = None if sys.platform == "darwin" else resource.getrlimit(resource.RLIMIT_AS)[1]',
        'return {"cpu": [cpu[0], cpu[1]], "addressSpace": address_space}',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    // Darwin deliberately skips RLIMIT_AS; every other Unix host applies the
    // configured bytes alongside the CPU soft/hard pair.
    expect(result.value).toEqual({
      cpu: [42, 43],
      addressSpace: process.platform === 'darwin' ? null : 400 * 1024 * 1024,
    })
  }, 15_000)

  it('preserves an inherited soft limit stricter than the configured cap', async () => {
    // Clamping reads BOTH inherited bounds, not just the hard one. A deployment
    // that inherited a soft rlimit below the configured cap must keep that
    // stricter soft: returning the configured value would RAISE the effective
    // soft limit, loosening containment. The wrapper lowers only the SOFT CPU
    // limit (`ulimit -S -t`) and leaves the hard limit unlimited, so the
    // requested soft (`cpuSeconds`) sits above the inherited soft — the case that
    // exposed the bug. RLIMIT_CPU is used because macOS ignores `ulimit -v`
    // (RLIMIT_AS), which is exactly why the backend skips address space there.
    const dir = await makeTempDir('dsh-rlimit-soft-')
    const wrapper = join(dir, 'python3-soft-capped')
    // Soft CPU 5 s, well below the configured 30 s, hard left unlimited.
    await writeFile(wrapper, `#!/bin/sh\nulimit -S -t 5\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime } = await setup({ pythonBin: wrapper, cpuSeconds: 30 })
    const result = await runtime.run({
      program: 'import resource\nreturn resource.getrlimit(resource.RLIMIT_CPU)[0]',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    // The applied SOFT limit is the inherited 5 s, not the configured 30 s.
    expect(result.value).toBe(5)
  }, 15_000)

  it('reports a CPU overrun under a dual-limit ulimit as a timeout, not a worker-exit', async () => {
    // `ulimit -t N` sets BOTH the soft and hard CPU limit to N. The kernel
    // checks the hard limit and SIGKILLs a busy loop directly, so with
    // soft == hard the SIGXCPU signal is never delivered — and the host
    // classifies a CPU overrun ONLY on `signal === 'SIGXCPU'`, so the overrun
    // would be misreported as a `worker-exit` instead of a timeout. `_clamped`
    // now lowers a clamped soft==hard result by one unit (when hard >= 2), so
    // the SIGXCPU signal fires at the softer limit and the run reports a
    // timeout. This uses `ulimit -t 2` (hard == 2, so the soft is lowered to 1)
    // and leaves SIGXCPU unhandled, so the kernel terminates the busy loop at
    // 1 s with SIGXCPU and the host classifies it as a timeout.
    const dir = await makeTempDir('dsh-rlimit-dual-')
    const wrapper = join(dir, 'python3-dual-capped')
    // Both soft and hard CPU 2 s; configured cpuSeconds 30 s.
    await writeFile(wrapper, `#!/bin/sh\nulimit -t 2\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime } = await setup({ pythonBin: wrapper, cpuSeconds: 30, maxWallMs: 12_000 })
    const result = await runtime.run({
      program: [
        'while True:',
        '    pass',
        'return "unreachable"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('CPU time exhausted')
  }, 15_000)

  it('reports a timeout when a program masks SIGXCPU and returns past the soft limit', async () => {
    // A program can mask SIGXCPU (pthread_sigmask SIG_BLOCK), burn past the
    // soft CPU limit, and return during the soft-to-hard gap. The settlement
    // recheck (`die_if_cpu_exhausted`) must UNBLOCK the signal before
    // re-delivering it, or the SIGXCPU stays pending and the child exits
    // normally with a success result. With the unblock, the re-delivered
    // SIGXCPU (default disposition) terminates the child and the host
    // classifies the run as a timeout. Fail-before: without the unblock the
    // run reports `value: "escaped"` and no error. The masking is guarded by
    // hasattr so the case is a no-op on platforms without pthread_sigmask.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 12_000 })
    const result = await runtime.run({
      program: [
        'import signal, time',
        'if hasattr(signal, "pthread_sigmask"):',
        '    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGXCPU})',
        'end = time.process_time() + 1.05',
        'while time.process_time() < end:',
        '    pass',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.value).toBeUndefined()
  }, 20_000)

  it('reports a timeout when the interpreter was started with SIGXCPU ignored (inherited state)', async () => {
    // The child inherits the host's SIGXCPU disposition: a wrapper that
    // ignores SIGXCPU before exec'ing python3 hands the child a soft
    // RLIMIT_CPU that cannot stop it. The bootstrap resets SIGXCPU to SIG_DFL
    // before model code runs, so a busy loop still ends as a timeout rather
    // than running to the hard limit and being misclassified as worker-exit.
    const wrapper = join(tmpdir(), `dsh-xcpu-ignore-${process.pid}.sh`)
    tempFiles.push(wrapper)
    writeFileSync(wrapper, `#!/bin/sh\ntrap "" XCPU\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    try {
      const { runtime } = await setup({ maxWallMs: 30_000, cpuSeconds: 1, pythonBin: wrapper })
      const result = await runtime.run({
        program: ['while True: pass'].join('\n'),
        bindings: [],
      })
      expect(result.error?.kind).toBe('timeout')
    } finally {
      rmSync(wrapper, { force: true })
    }
  }, 20_000)

  it('reports a timeout when a program traps AND masks SIGXCPU and returns past the soft limit', async () => {
    // The mask-only case exercises the unblock; the trap+mask combination is
    // the harder one: a program that installed a custom handler AND masked the
    // signal has that PENDING handler run the moment the signal is unblocked
    // (CPython delivers it at the next eval-breaker checkpoint in model code),
    // and the handler re-masks — so the settlement recheck must restore the
    // default disposition BEFORE unblocking. With SIG_DFL restored first, the
    // pending signal kills the process inside the kernel with no bytecode
    // window; without it, the handler re-blocks and the child exits normally
    // with a success value. Fail-before: the run reports `value: "escaped"`.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 12_000 })
    const result = await runtime.run({
      program: [
        'import signal, time',
        'if hasattr(signal, "pthread_sigmask"):',
        '    def h(signum, frame):',
        '        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGXCPU})',
        '    signal.signal(signal.SIGXCPU, h)',
        '    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGXCPU})',
        '    end = time.process_time() + 1.05',
        '    while time.process_time() < end:',
        '        pass',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.value).toBeUndefined()
  }, 20_000)

  it('rechecks CPU at settlement against the effective inherited soft limit', async () => {
    // The settlement-time CPU recheck must compare against the EFFECTIVE soft
    // limit (`_clamped` may have lowered it to a stricter inherited value), not
    // the configured `cpuSeconds`. A program that traps SIGXCPU, burns past the
    // inherited soft, and returns inside the soft-to-hard gap would otherwise be
    // compared to the configured value and falsely reported successful, bypassing
    // the inherited limit. The wrapper sets a 1 s soft CPU limit; the program
    // traps SIGXCPU and busy-loops past it, then returns — the recheck must
    // re-deliver SIGXCPU so the host classifies the run as a timeout.
    const dir = await makeTempDir('dsh-cpu-recheck-')
    const wrapper = join(dir, 'python3-cpu-capped')
    await writeFile(wrapper, `#!/bin/sh\nulimit -S -t 1\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime } = await setup({ pythonBin: wrapper, cpuSeconds: 30, maxWallMs: 12_000 })
    const result = await runtime.run({
      program: [
        'import signal, time',
        // Trap SIGXCPU so the soft limit does not terminate the program; burn
        // CPU well past the inherited 1 s soft, then return normally.
        'signal.signal(signal.SIGXCPU, lambda *a: None)',
        'end = time.process_time() + 2.5',
        'while time.process_time() < end:',
        '    pass',
        'return "returned"',
      ].join('\n'),
      bindings: [],
    })
    // The recheck compares spent CPU against the effective 1 s soft, not 30 s, so
    // the run is a timeout rather than a false success.
    expect(result.error?.kind).toBe('timeout')
  }, 20_000)
})

describe('PythonCodeRuntime — programs and bindings', () => {
  it('runs a top-level script, captures print output, and returns `result`', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'x = 40',
        'y = 2',
        'print("hello", x + y)',
        'return {"answer": x + y}',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ answer: 42 })
    // `print` in Python emits: text, ' ', text, '\n'. Concat the captured
    // fragments and assert the model-visible message survives.
    expect(result.logs.join('')).toContain('hello 42')
    // 15s: this is usually the suite's first real subprocess — a cold python3
    // start (interpreter + asyncio import) on a loaded CI runner can exceed
    // the 5s default alone; later tests reuse the warm page cache.
  }, 15_000)

  it('exposes only the platform temp directory from the host environment', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        'return {',
        '    "tmpdir": os.environ.get("TMPDIR"),',
        '    "path": os.environ.get("PATH"),',
        '    "home": os.environ.get("HOME"),',
        '    "token": os.environ.get("DEEPSEEK_API_KEY"),',
        '}',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ tmpdir: tmpdir(), path: null, home: null, token: null })
    expect(result.logs).toEqual([])
  })

  it('bridges binding calls both ways and rejects the program-side call on a host rejection', async () => {
    const { runtime } = await setup()
    const calls: unknown[] = []
    const result = await runtime.run({
      program: [
        'first = await tools.echo({"n": 1})',
        'caught = ""',
        'try:',
        '    await tools.fail({})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'return {"first": first, "caught": caught}',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { calls.push(args); return { echoed: args as CodeJsonValue } },
        fail: async () => { throw new Error('nope') },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ first: { echoed: { n: 1 } }, caught: 'nope' })
    expect(calls).toEqual([{ n: 1 }])
  })

  it('keeps decoding binding replies when _decode_json_plain is rebound', async () => {
    // read_frame_async resolves _decode_json_plain at call time; a program that
    // rebinds __main__._decode_json_plain would otherwise kill the reply pump
    // (a broken decode strands every pending Future to the wall clock). The
    // decode primitives are def-time captures on the channel methods, so a
    // rebind cannot break reply delivery.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import __main__',
        '__main__._decode_json_plain = None',
        'first = await tools.echo({"n": 1})',
        'return first',
      ].join('\n'),
      bindings: tools({
        echo: async args => ({ echoed: args as CodeJsonValue }),
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ echoed: { n: 1 } })
  }, 15_000)

  it('keeps dispatch working when _lossless_json_violation, asyncio, and send_sync are rebound', async () => {
    // dispatch binds _lossless_json_violation, asyncio.get_event_loop, and the
    // channel's send method into _run locals before the program runs, so a
    // rebind of __main__._lossless_json_violation/__main__.asyncio/
    // __main__.ProtocolChannel.send_sync cannot turn a legitimate binding call
    // into an exception or a wall-clock timeout.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__._lossless_json_violation = boom',
        '__main__.asyncio = boom',
        '__main__.ProtocolChannel.send_sync = boom',
        '__main__._encode_json_plain = boom',
        '__main__.ProtocolChannel.write_encoded = boom',
        'first = await tools.echo({"n": 1})',
        'return first',
      ].join('\n'),
      bindings: tools({
        echo: async args => ({ echoed: args as CodeJsonValue }),
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ echoed: { n: 1 } })
  }, 15_000)

  it('keeps the reply pump reading when the read_frame_async class attribute is rebound', async () => {
    // _pump_replies' frame reader is a bound method captured by _run before the
    // program runs and passed in as an explicit argument, so a program rebinding
    // `__main__.ProtocolChannel.read_frame_async` cannot redirect the pump (a
    // body-local `channel.read_frame_async` lookup would resolve the rebound
    // class attribute, since the pump starts after the program's top-level
    // statements).
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import __main__',
        'async def boom(*a, **k):',
        '    raise RuntimeError("hijacked reader")',
        '__main__.ProtocolChannel.read_frame_async = boom',
        'first = await tools.echo({"n": 1})',
        'return first',
      ].join('\n'),
      bindings: tools({
        echo: async args => ({ echoed: args as CodeJsonValue }),
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ echoed: { n: 1 } })
  }, 15_000)

  it('keeps the rejection contract when _BindingRejection is rebound', async () => {
    // `dispatch`'s except clause resolves `_BindingRejection` at call time; a
    // program that rebinds `__main__._BindingRejection = ValueError` would
    // otherwise let the internal marker type leak into model code (the program
    // would catch a `ValueError` for a host rejection). The class is now bound
    // into `_run` locals before the program runs, so a host rejection still
    // surfaces as the declared `RuntimeError`.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import __main__',
        '__main__._BindingRejection = ValueError',
        'caught = ""',
        'try:',
        '    await tools.fail({})',
        'except RuntimeError as e:',
        '    caught = e.args[0] if e.args else ""',
        'except Exception as e:',
        '    caught = "WRONG TYPE: " + type(e).__name__',
        'return caught',
      ].join('\n'),
      bindings: tools({
        fail: async () => { throw new Error('nope') },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('nope')
  }, 15_000)

  it('still answers the call when the rejection value cannot be converted to a string', async () => {
    // `messageOf` calls `String(error)`, which runs the value's own conversion,
    // and this call site is a DETACHED async reply callback. A rejection whose
    // `Symbol.toPrimitive` throws therefore escaped as an unhandled rejection:
    // the reply frame was never written, the program stayed blocked on `await`,
    // and the run degraded to a `maxWallMs` timeout (observed) — a host with no
    // `unhandledRejection` listener would exit instead. The rejection must reach
    // the program as an ordinary error carrying a fixed placeholder.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const result = await runtime.run({
      program: [
        'try:',
        '    await tools.hostile({})',
        'except RuntimeError as e:',
        '    return "rejected: " + str(e)',
        'return "no rejection"',
      ].join('\n'),
      bindings: tools({
        hostile: async () => {
          throw { [Symbol.toPrimitive]() { throw new Error('toPrimitive blew up') } }
        },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('rejected: <unrenderable rejection value>')
  }, 15_000)

  it('still answers the call when an Error carries a cyclic value in place of its message', async () => {
    // `Error.message` is typed `string` but is a plain writable property, so a
    // rejection can carry any value there. Returning it verbatim handed a
    // non-string to `sendReply`, breaching `encodeJsonPlain`'s JSON-plain
    // precondition: a cyclic object grew the encoder stack until the host threw
    // RangeError from the detached reply callback, so no reply frame was written
    // and the run degraded to a `maxWallMs` timeout (observed). The conversion
    // must contain it — `String()` on a cycle throws inside the guard and lands
    // on the placeholder, so the program sees an ordinary error.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const result = await runtime.run({
      program: [
        'try:',
        '    await tools.hostile({})',
        'except RuntimeError as e:',
        '    return "rejected: " + str(e)',
        'return "no rejection"',
      ].join('\n'),
      bindings: tools({
        hostile: async () => {
          const cyclic: { self?: unknown; [Symbol.toPrimitive]: () => string } = {
            // A cycle alone is inert for `String()`; the throwing conversion is
            // what proves the guard runs rather than the encoder.
            [Symbol.toPrimitive]: () => { throw new Error('cyclic message') },
          }
          cyclic.self = cyclic
          const error = new Error('placeholder')
          // Writable per spec, so no cast is needed to install a non-string.
          ;(error as unknown as { message: unknown }).message = cyclic
          throw error
        },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('rejected: <unrenderable rejection value>')
  }, 15_000)

  it('renders an Error whose message is a value with no JSON form', async () => {
    // The non-cyclic arm. A number would not discriminate: `scalarJson` renders
    // it as digits and the child `str()`s the field back, so it survives the
    // wire either way. `undefined` is the value that separates the two orders —
    // `scalarJson` emits a bare `undefined` token, so the reply line is not JSON
    // at all, the child's parse drops the frame, and the program stays blocked
    // on `await` until the wall ceiling (observed). Converting first sends the
    // string "undefined", which the program receives as an ordinary rejection.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const result = await runtime.run({
      program: [
        'try:',
        '    await tools.absent({})',
        'except RuntimeError as e:',
        '    return "rejected: " + str(e)',
        'return "no rejection"',
      ].join('\n'),
      bindings: tools({
        absent: async () => {
          const error = new Error('placeholder')
          ;(error as unknown as { message: unknown }).message = undefined
          throw error
        },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('rejected: undefined')
  }, 15_000)

  it('runs a program with no await', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return 2 + 2',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(4)
  })

  it('returns JSON null whether the program returns None or falls off the end', async () => {
    // Python has no `undefined`: an async body that returns None and one that
    // never returns both yield None, so both complete as an exact JSON null.
    // (The worker/TS backend can tell `return undefined` from `return null`;
    // Python cannot, and reporting null for both is the honest rendering.)
    const { runtime } = await setup()
    const explicit = await runtime.run({ program: 'return None', bindings: [] })
    expect(explicit.error).toBeUndefined()
    expect(explicit.value).toBeNull()
    const noReturn = await runtime.run({ program: 'x = 1', bindings: [] })
    expect(noReturn.error).toBeUndefined()
    expect(noReturn.value).toBeNull()
  })

  it('settles with no value on a forged valueless done frame', async () => {
    // The child always sends a value now (return None → JSON null), so a done
    // frame with no value key can only be forged; the host settles it as a
    // value-less completion rather than crashing on the absent field.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(3, b\'{"type":"done"}\\n\')',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBeUndefined()
  })

  it('coalesces print arguments into one log line, not per-write fragments', async () => {
    // print("a","b") calls write() per arg/sep/newline; the stream must emit
    // one logical line "a b" so PTC mode's join(newline) does not insert
    // spurious blank lines. Two prints → exactly two entries, no empties.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: ['print("a", "b")', 'print("c")', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a b', 'c'])
  })

  it('flushes a print with no trailing newline', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: ['print("partial", end="")', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['partial'])
  })

  it('aggregates a large newline-free native write into one log entry, not one per pipe chunk', async () => {
    // A single `os.write` larger than one pipe read arrives as several Node
    // `data` chunks. `logs` entries are joined with `\n` downstream, so pushing
    // one entry per transport chunk would insert model-visible newlines at
    // arbitrary pipe boundaries inside one native write. Stray capture holds a
    // per-stream residual and admits only on a real `\n`, so a 200 KiB blast
    // with no newline reads back as exactly one entry with no interior breaks.
    const { runtime } = await setup({ maxLogBytes: 300_000 })
    const size = 200_000
    const result = await runtime.run({
      program: ['import os', `os.write(1, b"A" * ${size})`, 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['A'.repeat(size)])
  })

  it('splits native output on its own newlines, one entry per line', async () => {
    // The complement of the aggregation case: real newlines in a native write
    // still delimit entries, matching the child's line-granular `log` frames.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: ['import os', 'os.write(1, b"one\\ntwo\\nthree")', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['one', 'two', 'three'])
  })

  it('preserves each native stream order while allowing backend-dependent interleaving', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(1, b"stdout-one\\n")',
        'os.write(2, b"stderr-one\\n")',
        'os.write(1, b"stdout-two\\n")',
        'os.write(2, b"stderr-two\\n")',
        'return None',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.indexOf('stdout-one')).toBeLessThan(result.logs.indexOf('stdout-two'))
    expect(result.logs.indexOf('stderr-one')).toBeLessThan(result.logs.indexOf('stderr-two'))
  })

  it('bounds a newline-free native flood by the ledger instead of buffering it whole', async () => {
    // A newline-free write far larger than maxLogBytes must not accumulate in
    // the host-side residual: when the pending residual would cross the budget
    // it is admitted (and truncated) immediately, and once the ledger has
    // truncated, later chunks stop buffering entirely. The run still completes
    // and the captured output ends at the truncation marker rather than
    // retaining the whole flood.
    const { runtime } = await setup({ maxLogBytes: 4096 })
    const result = await runtime.run({
      program: ['import os', 'os.write(1, b"A" * 2_000_000)', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(4096))
    // The retained output is bounded by the budget, not the 2 MB flood.
    expect(result.logs.join('').length).toBeLessThan(4096)
  })

  it('bounds a newline-free single-character Python write drip by the fragment cap, not OOM', async () => {
    // The child-side `_LogStream` buffers one fragment per `write` (so
    // `print("x", end="")` does not concatenate quadratically). A newline-free
    // drip of one character per call past a large `maxLogBytes` would otherwise
    // accumulate one list slot (and one str object) per call — 25 M calls =
    // ~25 M slots, which OOMs the host on its own accounting before the byte
    // budget is reached. The stream seals the fragment list past
    // `_PENDING_MAX_CHUNKS` into one joined block (character count unchanged),
    // bounding the live fragment count exactly as the host-side `captureStray`
    // seal does. This drives well past the cap and asserts the run still
    // completes with a truncation marker rather than a MemoryError.
    const { runtime } = await setup({ maxLogBytes: 4096 })
    const result = await runtime.run({
      program: [
        'import sys',
        'for _ in range(200_000):',
        '    sys.stdout.write("x")',
        'return None',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(4096))
  })

  it('bounds a control-char-dense native residual by serialized cost, not raw length', async () => {
    // A newline-free NUL flood passes the cheap `length + 3` lower bound at a
    // raw length well under the budget, but each NUL serializes to `\u0000` (6
    // bytes), so the true JSON cost is ~6x. The ledger must charge that
    // serialized cost — and `jsonStringCostUpTo` must measure it WITHOUT
    // allocating the escaped copy, so a near-budget line under a large
    // maxLogBytes cannot momentarily allocate a multi-gigabyte `JSON.stringify`
    // result. Under a small budget the residual is truncated once the serialized
    // cost crosses it.
    const { runtime } = await setup({ maxLogBytes: 4096 })
    const result = await runtime.run({
      program: ['import os', 'os.write(1, b"\\x00" * 4000)', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(4096))
  })

  it('rejects an output budget that could breach addressSpaceMb during encode at load', async () => {
    // The child builds, charges, and encodes a `maxLogBytes` log entry or a
    // `maxValueBytes` completion value under RLIMIT_AS, and both trigger on
    // character count against a serialized-byte budget — an astral character is
    // one character but ~4 bytes stored and ~4 encoded, and THREE such copies are
    // live at the peak (the caller's write argument, the slice/join handed to
    // push, and the encode copy), so a budget approaching the address space lets a
    // legitimate near-budget output breach it and die as worker-exit. The
    // incompatible pair is rejected at load: each budget times the worst-case
    // multiple (12) must fit the address space LEFT after the fixed interpreter
    // baseline. Against a 256 MiB address space that leaves 192 MiB budgetable
    // (~16 MiB admissible), so a 50 MB cap is far over; the default caps against
    // 512 MiB are not. Both budgets are gated symmetrically — the value case sets
    // a default-fitting maxLogBytes so the maxValueBytes check is what fires.
    const ctxLog = new Context()
    await expect(ctxLog.plugin(PythonCodeRuntime, { maxLogBytes: 50_000_000, addressSpaceMb: 256 }))
      .rejects.toThrow(/maxLogBytes times the 12x worst-case Unicode expansion must fit/)
    const ctxValue = new Context()
    await expect(ctxValue.plugin(PythonCodeRuntime, { maxValueBytes: 50_000_000, addressSpaceMb: 256 }))
      .rejects.toThrow(/maxValueBytes times the 12x worst-case Unicode expansion must fit/)
    // Discriminates 12 from 8: a 48 MiB maxLogBytes against a 512 MiB address
    // space leaves 448 MiB budgetable. 48*8 = 384 MiB fits (the old 8x multiple
    // wrongly ADMITTED this), but 48*12 = 576 MiB does not. The ~12x peak this
    // guards is the NEWLINE path's single near-budget write — the caller's own
    // string, the line slice, and the encode copy live at once. The settlement
    // flush is no longer the binding case: `flush_line` drops the pending chunks
    // before its push, so it holds two copies, not three.
    const ctxTwelve = new Context()
    await expect(ctxTwelve.plugin(PythonCodeRuntime, { maxLogBytes: 48 * 1024 * 1024, addressSpaceMb: 512 }))
      .rejects.toThrow(/maxLogBytes times the 12x worst-case Unicode expansion must fit/)
    // An addressSpaceMb at or below the interpreter baseline leaves nothing
    // budgetable, so no budget value can pass. It is rejected on its own terms:
    // the budget loop would otherwise report "a limit of -1" (or -2796203 at
    // 32 MiB) while naming maxLogBytes, sending the operator to the wrong knob.
    const ctxBaseline = new Context()
    await expect(ctxBaseline.plugin(PythonCodeRuntime, { addressSpaceMb: 64 }))
      .rejects.toThrow(/addressSpaceMb must exceed the 67108864-byte interpreter baseline/)
    const ctxBelow = new Context()
    await expect(ctxBelow.plugin(PythonCodeRuntime, { addressSpaceMb: 32 }))
      .rejects.toThrow(/addressSpaceMb must exceed the 67108864-byte interpreter baseline/)
    // The default caps against the default 512 MiB address space load.
    const ok = new Context()
    const fiber = await ok.plugin(PythonCodeRuntime, { maxLogBytes: 65536, maxValueBytes: 32768, addressSpaceMb: 512 })
    await fiber.dispose()
  })

  it('bounds an illegal-UTF-8 native residual by its U+FFFD-decoded cost', async () => {
    // Every 0xFF byte is illegal in any UTF-8 sequence, so `toString('utf8')`
    // renders each as U+FFFD (3 serialized bytes). `accrueStrayCost` must charge
    // that 3, not the raw 1: otherwise the newline-free residual grows to a full
    // budget's worth of RAW bytes before flushing — a ~3x undercount that near a
    // large maxLogBytes retains hundreds of MiB then expands toward a ~1 GiB peak
    // in flushStray's concat + toString. Paced single-byte writes (each its own
    // `data` chunk, like the sealing case) expose the sub-chunk accrual: charged
    // at 3 the residual crosses a 3072-byte budget after ~1024 bytes and flushes;
    // charged at 1 it would need ~3072 bytes, so the peak residual triples. The
    // largest merged buffer is the discriminator.
    const realConcat = Buffer.concat.bind(Buffer)
    let maxConcat = 0
    Buffer.concat = (list: readonly Uint8Array[], total?: number): Buffer<ArrayBuffer> => {
      const merged = realConcat(list, total)
      if (merged.length > maxConcat) maxConcat = merged.length
      return merged
    }
    let result: CodeRunResult
    try {
      const { runtime } = await setup({ maxLogBytes: 3072, maxWallMs: 30_000 })
      result = await runtime.run({
        program: [
          'import os',
          'for _ in range(6000):',
          '    os.write(1, b"\\xff")',
          '    os.sched_yield()',
          'return None',
        ].join('\n'),
        bindings: [],
      })
    } finally {
      Buffer.concat = realConcat
    }
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(3072))
    // Charged at 3, the residual flushes around 1024 raw bytes; the largest
    // merged buffer stays well under 2048. A raw-byte undercount would let it
    // reach ~3072 before flushing, so 2048 discriminates.
    expect(maxConcat).toBeLessThan(2048)
  })

  it('charges a structurally-valid but illegal UTF-8 sequence its U+FFFD-decoded cost', async () => {
    // A CESU-8 lone surrogate `ED A0 80` is structurally well-formed (a 3-byte
    // lead plus two 0x80–0xBF continuations) but ILLEGAL: `toString('utf8')`
    // renders each of the three bytes as its own U+FFFD (serialized cost 9), not
    // one width-3 character. The newline-free flush trigger weighs the residual
    // through `accrueStrayCost`, which must validate each lead's
    // first-continuation range (ED excludes A0–BF) and charge the true 9 — else a
    // CESU flood undercounts 3x and the residual grows toward a full budget's raw
    // bytes before flushing, the same peak-memory vector as the 0xFF case. The
    // bytes are written one at a time (each its own `data` chunk, no pipe
    // coalescing) and `Buffer.concat` is wrapped to measure the peak residual.
    const realConcat = Buffer.concat.bind(Buffer)
    let maxConcat = 0
    Buffer.concat = (list: readonly Uint8Array[], total?: number): Buffer<ArrayBuffer> => {
      const merged = realConcat(list, total)
      if (merged.length > maxConcat) maxConcat = merged.length
      return merged
    }
    let result: CodeRunResult
    try {
      const { runtime } = await setup({ maxLogBytes: 3072, maxWallMs: 30_000 })
      result = await runtime.run({
        program: [
          'import os',
          'seq = (0xed, 0xa0, 0x80)',
          'for _ in range(2000):',
          '    for b in seq:',
          '        os.write(1, bytes((b,)))',
          '        os.sched_yield()',
          'return None',
        ].join('\n'),
        bindings: [],
      })
    } finally {
      Buffer.concat = realConcat
    }
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(3072))
    // Each 3-byte sequence costs 9 (three U+FFFD), so single-byte-paced the
    // residual crosses the 3072 budget after ~342 raw bytes and flushes; the
    // largest merged buffer stays well under 2048. Charging the structural width
    // 3 would need ~1024 raw bytes, tripling the peak past 2048.
    expect(maxConcat).toBeLessThan(2048)
  })

  it('charges a lone surrogate its full six escaped bytes, not three', async () => {
    // A forged `log` frame carrying `\ud800` escapes materializes lone
    // surrogates after JSON.parse. `Buffer.byteLength` of U+FFFD is 3, but
    // ES2019 well-formed `JSON.stringify` emits `\ud800` at 6 bytes, so charging
    // the raw width would admit ~2x the configured budget of serialized bytes
    // (the same family as the NUL-flood undercount, at 2x rather than 6x). The
    // cost walker charges surrogates the full 6, so a flood truncates at budget.
    // Forged on fd 3 because Python stdout will not emit lone surrogates.
    const { runtime } = await setup({ maxLogBytes: 4096 })
    const result = await runtime.run({
      program: [
        'import os',
        // 1000 \ud800 escapes: charged at the buggy raw width 1000 * 3 = 3000
        // bytes fits under 4096 (wrongly admitted), but the correct serialized
        // width 1000 * 6 = 6000 bytes is over budget — so the ledger must
        // truncate. The count sits in the 683..1365 window where the two
        // chargings disagree, making the test discriminate.
        String.raw`frame = b'{"type":"log","text":"' + b'\\ud800' * 1000 + b'"}\n'`,
        'os.write(3, frame)',
        'return None',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(4096))
  })

  it('drops a second stray line in the same chunk once the first truncated the ledger', async () => {
    // One `os.write` carrying two newline-terminated lines where the first
    // exhausts maxLogBytes: the first line's admit truncates and marks the
    // ledger, and the second line's admit — reached in the same `data` callback
    // — must be the post-truncation no-op. Proves that branch is exercised, so
    // it carries no v8-ignore. Kept to 108 bytes (< the smallest PIPE_BUF, 512 on
    // macOS) so the whole payload lands in ONE atomic write and one `data`
    // callback — the two newlines cannot split across callbacks and leave the
    // branch un-exercised, which would be a hard-to-attribute per-file coverage
    // flake. The first line's 100 bytes already exceed the 64-byte budget, so it truncates.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: ['import os', 'os.write(1, b"A" * 100 + b"\\nSECOND\\n")', 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(64))
    expect(result.logs.join('\n')).not.toContain('SECOND')
  })

  it('charges a broken multibyte sequence its U+FFFD bytes, split across pipe chunks', async () => {
    // A 3-byte lead (0xE4) whose continuation never arrives — the next byte is a
    // fresh ASCII 'A' — must be costed as U+FFFD (3) for the orphaned lead, not
    // folded into a phantom character. Driven byte-by-byte so the lead and the
    // breaking byte land in separate `data` chunks, exercising accrueStrayCost's
    // cross-chunk broken-sequence branch. The run completes and the bytes are
    // captured (rendered U+FFFD by toString), proving the walk resynchronizes.
    const { runtime } = await setup({ maxLogBytes: 1024 })
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(1, b"\\xe4")',
        'os.sched_yield()',
        'os.write(1, b"A\\n")',
        'return None',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.join('')).toContain('A')
    expect(result.logs.join('')).toContain('�')
  })

  it('charges the exact serialized cost of short-escape and quote/backslash characters', async () => {
    // Exercises every branch of jsonStringCostUpTo's per-character cost: a tab
    // and other C0 controls with short JSON forms (\t etc., 2 bytes), a quote
    // and backslash (2 bytes each), a `\uXXXX` control (6 bytes), a multibyte
    // BMP character (raw UTF-8 width), and plain ASCII. Under a budget large
    // enough to admit it, the line survives verbatim — proving the cost walker
    // does not over- or under-charge and the string round-trips unescaped.
    const { runtime } = await setup({ maxLogBytes: 4096 })
    const result = await runtime.run({
      program: ['import os', String.raw`os.write(1, "\ta\"b\\c\x01é\n".encode("utf-8"))`, 'return None'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['\ta"b\\c\x01é'])
  })

  it('fails a completion dict with a non-string key as invalid-output (no key coercion)', async () => {
    // json.dumps would coerce {1: "a", "1": "b"} to a single "1" key, silently
    // dropping data. The shape validator rejects it before encoding.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return {1: "first", "1": "second"}',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.error?.message).toContain('non-string dict key')
  })

  it('rejects a binding argument with a non-string dict key before dispatch', async () => {
    const { runtime } = await setup()
    let called = false
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.sink({1: "x"})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({ sink: async () => { called = true; return null } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('lossless JSON')
    expect(called).toBe(false)
  })

  it('fails a non-JSON completion value as invalid-output (no repr substitution)', async () => {
    // A set is not lossless JSON. The old draft substituted repr(); the seam
    // now requires refusing the run instead.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return {1, 2, 3}',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.error?.message).toContain('lossless JSON')
    expect(result.error?.message).toContain('set')
  })

  it('fails a negative-zero completion value as invalid-output (sign bit is lossy over JSON)', async () => {
    // JSON serialization turns -0.0 into 0 (or JS -0), silently changing the
    // sign bit; the canonical lossless-JSON boundary rejects it, so the
    // Python side must too — as a completion and as a binding argument.
    const { runtime } = await setup()
    const completion = await runtime.run({
      program: 'return -0.0',
      bindings: [],
    })
    expect(completion.error?.kind).toBe('invalid-output')
    expect(completion.error?.message).toContain('negative zero')
    const argument = await runtime.run({
      program: [
        'try:',
        '    await tools.echo(-0.0)',
        '    return "accepted"',
        'except RuntimeError as e:',
        '    return str(e)',
      ].join('\n'),
      bindings: tools({ echo: async args => args as never }),
    })
    expect(argument.error).toBeUndefined()
    expect(argument.value).toContain('negative zero')
  })

  it('fails a NaN completion value as invalid-output (allow_nan=False)', async () => {
    // json.dumps would happily emit NaN by default, but NaN is not JSON; the
    // bootstrap passes allow_nan=False so it fails as invalid-output.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return float("nan")',
      bindings: [],
    })
    expect(result.error?.kind).toBe('invalid-output')
  })

  it('fails an over-budget completion value as output-limit (child-side check)', async () => {
    const { runtime } = await setup({ maxValueBytes: 64 })
    const result = await runtime.run({
      program: 'return "V" * 5000',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 64 bytes')
  })

  it('meters a control-heavy completion value without materializing its escaped form', async () => {
    // The child's lower bound admits a string by CHARACTER count, then the meter
    // charged what `_dump_string(current).encode()` returned -- building the
    // escaped copy plus its encode. Each NUL escapes to six bytes, so metering a
    // value the budget then REJECTS allocated ~6x the original twice over:
    // measured at 228.9 MiB of peak for a 20M-NUL string, against 19.1 MiB for
    // the counting path that returns the identical 120,000,002 bytes. Past
    // RLIMIT_AS the meter died as `exception: MemoryError`, inverting the
    // `output-limit` this seam promises for an over-budget value.
    //
    // 8M NULs is 8,000,002 raw but 48,000,002 escaped: over the 16 MiB budget
    // only when charged the escaped cost, so this also pins that the cheap
    // character bound alone does not decide the verdict.
    const { runtime } = await setup({ maxValueBytes: 16 * 1024 * 1024, maxWallMs: 60_000 })
    const result = await runtime.run({
      program: 'return "\\x00" * 8_000_000',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
  }, 90_000)

  it('rejects a wide completion as output-limit before materializing its traversal state', async () => {
    // `[0] * 2000000` sits far above maxValueBytes but well below the frame
    // ceiling. The folded checker must reject it via the pre-enqueue bound —
    // BEFORE pushing two million elements onto the walk — so a small
    // addressSpaceMb does not turn the check itself into an RLIMIT_AS death.
    const { runtime } = await setup({ maxValueBytes: 64, addressSpaceMb: 256, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: 'return [0] * 2000000',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 64 bytes')
  }, 20_000)

  it('rejects a wide dict as output-limit without materializing its items list', async () => {
    // Same pre-enqueue bound on the dict branch: `len(current)` replaces
    // `list(current.items())`, which allocated one tuple per member before the
    // bound could reject the value. Two million entries under a 64-byte cap
    // fits the 256 MiB address space as a dict but not as a dict PLUS a
    // two-million-tuple list.
    const { runtime } = await setup({ maxValueBytes: 64, addressSpaceMb: 256, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: 'return {str(i): 0 for i in range(2000000)}',
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 64 bytes')
  }, 20_000)

  it('meters a float completion in the host\'s number spelling', async () => {
    // CPython's repr disagrees with the host's String(number): `1.0` is three
    // bytes here and one there, `1e-07` pads the exponent the host writes as
    // `1e-7`. Both sides meter the SAME budget, so the child must count the
    // bytes the host will receive — otherwise a boundary-sized value is
    // falsely reported as output-limit.
    const { runtime } = await setup({ maxValueBytes: 1 })
    const integral = await runtime.run({ program: 'return 1.0', bindings: [] })
    expect(integral.error).toBeUndefined()
    expect(integral.value).toBe(1)

    const exponent = await setup({ maxValueBytes: 4 })
    const small = await exponent.runtime.run({ program: 'return 1e-7', bindings: [] })
    expect(small.error).toBeUndefined()
    expect(small.value).toBe(1e-7)

    // The spelling is a meter input, not a licence to overshoot: `1.5` is three
    // bytes on both sides and still fails a two-byte budget.
    const tight = await setup({ maxValueBytes: 2 })
    const over = await tight.runtime.run({ program: 'return 1.5', bindings: [] })
    expect(over.error?.kind).toBe('output-limit')
  })

  it('carries floats across the wire in the host\'s number spelling', async () => {
    // The child ENCODES with the same speller it meters with, so the frame the
    // host parses must reproduce every double exactly — including the branches
    // where CPython and ECMAScript disagree (integral floats, sub-1e-6
    // exponents, >= 1e21, and beyond-safe-range integral doubles whose exact
    // digits differ from the shortest round-trip form).
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return [1.0, 100.0, 1.5, 0.1, 1e-7, 1e-6, 1e-5, 123.456, -2.5e-8, 1e21, float(2**60), 5e-324, 1.7976931348623157e308]',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([1, 100, 1.5, 0.1, 1e-7, 1e-6, 1e-5, 123.456, -2.5e-8, 1e21, 2 ** 60, 5e-324, 1.7976931348623157e308])
  })

  it('rejects a forged non-lossless done value host-side as invalid-output', async () => {
    // A forged done frame bypasses the child's _check_done_value. JSON.parse
    // turns 1e400 into Infinity; validateChildFrame no longer scans done.value,
    // so the host's own checkDoneValue must catch the non-lossless number.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        String.raw`os.write(3, b'{"type":"done","value":1e400}' + b'\n')`,
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.error?.message).toContain('non-lossless number')
  })

  it('reports a syntax error as an exception without settling with a value', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: '$$invalid python$$',
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('SyntaxError')
    // The parse-time diagnostic must carry the same source label as compile and
    // runtime tracebacks (ast.parse passes filename="<model>"); a stale
    // "<unknown>" label would leak an inconsistent origin to the model.
    expect(result.error?.message).toContain('File \"<model>\"')
    expect(result.value).toBeUndefined()
  })

  it('reports a runtime raise as an exception with the traceback', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'raise ValueError("intentional")',
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ValueError')
    expect(result.error?.message).toContain('intentional')
  })

  it('bounds a deep exception cause chain instead of burning the wall budget formatting it', async () => {
    // A chain thousands of links deep would make the rendering walk and
    // format() linear in its length, consuming maxWallMs. Rendering is capped
    // at 100 links with a marker; the run reports the exception well within
    // budget rather than timing out.
    const { runtime } = await setup({ maxValueBytes: 1024 * 1024, maxWallMs: 20_000 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'err = None',
        'for i in range(3000):',
        '    try:',
        '        raise ValueError(i) from err',
        '    except ValueError as e:',
        '        err = e',
        'raise err',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('exception chain truncated at 100 links')
    expect(Date.now() - start).toBeLessThan(15_000)
  }, 25_000)

  it('bounds an over-cap chain without assigning to the live exception', async () => {
    // The cap used to be applied by severing the over-cap link ON the live
    // exception. An exception class overriding __setattr__ to raise turned that
    // assignment into model code running inside the bootstrap's failure
    // handler; the throw skipped the `done` send that sits after the handler,
    // so the host blocked on fd 3 and reported a maxWallMs timeout instead of
    // the model's own exception. Cutting the chain on the TracebackException
    // COPY touches no model hook, so the marker still appears and the run
    // reports `exception`.
    const { runtime } = await setup({ maxValueBytes: 1024 * 1024, maxWallMs: 15_000 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'class Sealed(Exception):',
        '    def __setattr__(self, name, value):',
        '        raise RuntimeError("live mutation refused")',
        'err = None',
        'for i in range(150):',
        '    try:',
        '        raise Sealed(i) from err',
        '    except Sealed as e:',
        '        err = e',
        'raise err',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Sealed')
    expect(result.error?.message).toContain('exception chain truncated at 100 links')
    // The sever attempt is what used to leak: its message must not appear, and
    // the run must settle well inside the wall budget rather than timing out.
    expect(result.error?.message).not.toContain('live mutation refused')
    expect(Date.now() - start).toBeLessThan(10_000)
  }, 20_000)

  it('still sends done when rendering the diagnostic itself raises', async () => {
    // format() reaches the exception's own __str__, so a model class whose
    // __str__ raises can throw from inside the failure handler. CPython's
    // _safe_string absorbs a raising __str__ during formatting, but the
    // fallback must hold for any throw on that path (a raising __repr__ of an
    // argument, a MemoryError under RLIMIT_AS), so the assertion is the
    // invariant that matters: a `done` frame carrying `exception`, never a
    // timeout, and never the failing renderer's own message.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'class Unprintable(Exception):',
        '    def __str__(self):',
        '        raise RuntimeError("str refused")',
        '    def __repr__(self):',
        '        raise RuntimeError("repr refused")',
        'raise Unprintable()',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Unprintable')
    expect(result.error?.message).not.toContain('str refused')
    expect(result.error?.message).not.toContain('repr refused')
  }, 15_000)

  it('sends done with an inert diagnostic when the whole rendering path raises', async () => {
    // Drive the fallback itself. `TracebackException.format` reads the
    // exception class's `__module__` to decide whether to qualify the name, and
    // a metaclass property can raise there — a throw INSIDE the formatter,
    // reached with no rebinding of anything the bootstrap owns. Without the
    // wrapper it escapes the handler, the `done` send never runs, and the host
    // times out at maxWallMs.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'class Meta(type):',
        '    @property',
        '    def __module__(cls):',
        '        raise RuntimeError("renderer refused")',
        'class Hostile(ValueError, metaclass=Meta):',
        '    pass',
        'raise Hostile("original failure")',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    // The inert fallback names the class and a fixed literal; it must not carry
    // the renderer's message, and must not have become a timeout. `__name__` is
    // still a plain str here, so the class name survives.
    expect(result.error?.message).toBe('Hostile: <diagnostic rendering failed>')
  }, 15_000)

  it('falls back to a placeholder class name when __name__ itself raises', async () => {
    // The fallback reads type(exc).__name__, which a metaclass property can
    // hijack. It must neither run that override's failure into the handler nor
    // format a non-str __name__ into the message. The hostile `__module__` is
    // what drives execution into the fallback in the first place.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'class Meta(type):',
        '    @property',
        '    def __module__(cls):',
        '        raise RuntimeError("renderer refused")',
        '    @property',
        '    def __name__(cls):',
        '        raise RuntimeError("name refused")',
        'class Nameless(Exception, metaclass=Meta):',
        '    pass',
        'raise Nameless()',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toBe('<unknown>: <diagnostic rendering failed>')
  }, 15_000)

  it('reports the real exception when the program rebinds every name the failure path uses', async () => {
    // The bootstrap IS __main__, so `import __main__; __main__._X = ...` reaches
    // any module global a call-time lookup would read. The failure path is the
    // worst place for that: the reporter, the byte cap, the traceback formatter,
    // the settlement flush and the `done` send all run AFTER the `except` block,
    // so a replacement that raises skips the send, leaves the host blocked on
    // fd 3, and the run reports a maxWallMs timeout instead of the model's own
    // exception. Rebind all of them at once; the run must still carry the real
    // ValueError.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__._SAFE_MODEL_TRACEBACK = boom',
        '__main__._cap_message = boom',
        '__main__._model_traceback = boom',
        '__main__._UNRENDERABLE_DIAGNOSTIC = boom',
        '__main__._LogStream.flush_line = boom',
        // `send_done` writes via LOCALLY-BOUND `_encode_json_plain` +
        // `ProtocolChannel.write_encoded`; rebinding these at call time must not
        // redirect the done frame (a late lookup would be `boom` -> worker-exit).
        '__main__.ProtocolChannel.send_sync = boom',
        '__main__.ProtocolChannel.write_encoded = boom',
        '__main__._encode_json_plain = boom',
        'raise ValueError("real failure")',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ValueError: real failure')
    expect(result.error?.message).not.toContain('hijacked')
  }, 15_000)

  it('still delivers a done frame when a transitive encode name is rebound', async () => {
    // `send_done` binds `_encode_json_plain` and `ProtocolChannel.write_encoded`
    // into locals, but those callables' BODIES still resolve transitive module
    // globals at call time: `_encode_json_plain` reaches `_dump_scalar`/`_dump_string`/
    // `json.dumps`, and `write_encoded` reaches `os.write`. This bootstrap is
    // `__main__`, so rebinding `__main__._dump_scalar` to a raising function makes
    // the error-frame encode throw AFTER the `except` block. `send_done` catches
    // that and writes a fixed literal done frame (kind `exception`) with the
    // LOCALLY-BOUND `_os_write`/`_memoryview`/`_FALLBACK_DONE_FRAME` captured
    // before the program runs, so the host still gets a verdict — the run must be an
    // `exception`, never a `worker-exit`. The real message is lost (the literal
    // carries a fixed `<unrenderable>` text), which is acceptable: the verdict
    // outranks the diagnostic detail.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__._dump_scalar = boom',
        '__main__.os = boom',
        // The fallback must also survive a rebind of its own primitives.
        '__main__._os_write = boom',
        '__main__._memoryview = boom',
        '__main__._FALLBACK_DONE_FRAME = boom',
        'raise ValueError("real failure")',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.kind).not.toBe('worker-exit')
  }, 15_000)

  it('still reports a model exception when the program rebinds BaseException', async () => {
    // `_run`'s outer try/except catches the program's failure and builds a
    // `done` frame. The clause previously used the module-global `BaseException`,
    // which the program (running as `__main__`) can rebind: `__main__.BaseException
    // = RuntimeError` makes the `except BaseException` resolve to `RuntimeError`,
    // so a subsequent `ValueError` does not match and escapes `_run` with no
    // `done` frame — misreporting the run as a `worker-exit`. The exception class
    // is now bound into a `_run` LOCAL before the program runs, so the rebind
    // cannot change which class the clause catches; the run must still report an
    // `exception`, not a `worker-exit`.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        '__main__.BaseException = RuntimeError',
        'raise ValueError("real failure")',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.kind).not.toBe('worker-exit')
  }, 15_000)

  it('still reports the exception when BaseException and the traceback reporter are rebound together', async () => {
    // The two rebind families compose: `__main__.BaseException = ValueError`
    // must not change which class the `_run` catch resolves (it is a pre-program
    // local), and a rebound reporter (`_SAFE_MODEL_TRACEBACK`/`_cap_message`/
    // `_model_traceback`/`_UNRENDERABLE_DIAGNOSTIC`) must not break the done
    // frame — `safe_model_traceback` holds its primitives as import-time closure
    // cells. A `KeyError` (not a `ValueError` subclass) escapes a catch that
    // resolves to the rebound class, so without the local binding the run would
    // misreport as `worker-exit`; with it, the run reports the exception and the
    // fallback reporter still produces the fixed literal.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__.BaseException = ValueError',
        '__main__._SAFE_MODEL_TRACEBACK = boom',
        '__main__._cap_message = boom',
        '__main__._model_traceback = boom',
        '__main__._UNRENDERABLE_DIAGNOSTIC = boom',
        'raise KeyError("real failure")',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.kind).not.toBe('worker-exit')
  }, 15_000)

  it('rejects an fd-3 frame whose raw length exceeds the parse cap before joining it', async () => {
    // The 64 MiB frame parse cap bounds the RAW frame bytes, not the decoded
    // structure; a compact wide frame near that ceiling could decode to far
    // more host memory. The unframed-buffer counter is checked against
    // FRAME_PARSE_CAP_BYTES BEFORE the Buffer.concat join, so an oversized
    // frame is dropped at one copy of its wire bytes instead of being fully
    // joined (a second copy) and only then discarded in the line loop — the
    // peak-memory doubling the pre-join check exists to prevent. Fail-before:
    // without the check the frame is joined whole and parsed (its log text
    // admitted, truncating the ledger), and the run completes normally.
    const { runtime } = await setup({ maxWallMs: 60_000 })
    const result = await runtime.run({
      program: [
        'import os',
        // One frame just past the 64 MiB parse cap.
        'os.write(3, b"{\\"type\\":\\"log\\",\\"text\\":\\"" + b"a" * (65 * 1024 * 1024) + b"\\"}\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('protocol frame exceeded')
  }, 90_000)

  it('caps an oversized rejection diagnostic so an invalid completion stays invalid-output', async () => {
    // _done_with_value caps its rejection diagnostic through _cap_message: a
    // hostile class name (huge type(value).__name__) would otherwise push the
    // done frame past the host's 64 MiB parse cap, misreporting an
    // invalid-output run as a worker-exit. The diagnostic is capped to the
    // value budget, so the frame always crosses the parser.
    const { runtime } = await setup({ maxWallMs: 60_000 })
    const result = await runtime.run({
      program: [
        'return type("N" * (70 * 1024 * 1024), (), {})()',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.error?.kind).not.toBe('worker-exit')
  }, 90_000)

  it('appends a flushed unterminated line to the next entry without a fake newline', async () => {
    // An explicit flush of an unterminated line (print(..., end='', flush=True))
    // used to push a full log frame, so the following print() landed in a
    // SECOND entry and logs.join('\n') rendered 'a\nb' for what the program
    // printed as one line. The flush frame now carries `open: true` and the
    // host appends the next frame to the same entry.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        "print('a', end='', flush=True)",
        "print('b')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['ab'])
  }, 15_000)

  it('keeps a SEALED open hold when the run ends with it still open', async () => {
    // The finish-residual's sealed side: an open hold past MAX_PENDING_CHUNKS
    // lands in openSealed, and the run ends without a closing frame — finish()
    // must commit the SEALED prefix, not only the current fragments.
    const { runtime } = await setup({ maxLogBytes: 65536 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, b'{\"type\":\"log\",\"text\":\"x\",\"open\":true}\\n')",
        'for _ in range(3000):',
        "    os.write(3, b'{\"type\":\"log\",\"text\":\"a\",\"open\":true}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['x' + 'a'.repeat(3000)])
  }, 15_000)

  it('keeps a flushed unterminated line when the run ends with it still open', async () => {
    // The settlement flush pushes the residual with `open: true`; finish()
    // admits it so a program that commits a partial line and returns does not
    // lose it from logs.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        "print('committed', end='', flush=True)",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['committed'])
  }, 15_000)

  it('skips the hold for a zero-content open continuation', async () => {
    // An empty open continuation bills 0 and is NOT pushed into the held
    // fragment array (an empty fragment contributes nothing to the merged
    // entry, and holding it would let a forged empty-open flood grow host
    // memory without touching the ledger).
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, b'{\"type\":\"log\",\"text\":\"x\",\"open\":true}\\n')",
        "os.write(3, b'{\"type\":\"log\",\"text\":\"\",\"open\":true}\\n')",
        "os.write(3, b'{\"type\":\"log\",\"text\":\"y\"}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['xy'])
  }, 15_000)

  it('seals the open hold past MAX_PENDING_CHUNKS without changing the merged entry', async () => {
    // A budget-sized single-character open flood would otherwise accumulate
    // thousands of fragment array slots (each a slot plus string header, ~30x
    // overhead the byte cap cannot see). The hold seals into one block past
    // MAX_PENDING_CHUNKS; the merged entry is byte-identical.
    const { runtime } = await setup({ maxLogBytes: 65536 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, b'{\"type\":\"log\",\"text\":\"x\",\"open\":true}\\n')",
        // 3000 single-character open continuations (over MAX_PENDING_CHUNKS).
        'for _ in range(3000):',
        "    os.write(3, b'{\"type\":\"log\",\"text\":\"a\",\"open\":true}\\n')",
        "os.write(3, b'{\"type\":\"log\",\"text\":\"y\"}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['x' + 'a'.repeat(3000) + 'y'])
  }, 15_000)

  it('bounds a forged open-frame flood against the log budget', async () => {
    // The open hold must be bounded by the ledger: without the exact-cost check
    // a forged open flood would grow the held fragment without touching
    // logBudget — unbounded host retention under a small budget. The flood now
    // truncates to the marker like any over-budget log traffic.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        // 2000 forged open frames, each under the frame parse cap.
        'for _ in range(2000):',
        "    os.write(3, b'{\"type\":\"log\",\"text\":\"a\",\"open\":true}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(60), logTruncationMarker(64)])
  }, 15_000)

  it('commits a sealed open hold before the truncation marker', async () => {
    // The sealed variant of the prefix-commit case: an open flood past
    // MAX_PENDING_CHUNKS lands in openSealed, then an over-budget line
    // truncates — truncateLogs must commit the SEALED prefix (not only the
    // current fragments) before the marker.
    const { runtime } = await setup({ maxLogBytes: 65536 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, b'{\"type\":\"log\",\"text\":\"x\",\"open\":true}\\n')",
        // 3000 single-character open continuations seal the hold, then a
        // forged over-budget open frame trips the ledger: truncateLogs must
        // commit the SEALED prefix before the marker.
        'for _ in range(3000):',
        "    os.write(3, b'{\"type\":\"log\",\"text\":\"a\",\"open\":true}\\n')",
        "os.write(3, ('{\"type\":\"log\",\"text\":\"' + 'z' * 70000 + '\",\"open\":true}\\n').encode())",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs[0]).toBe('x' + 'a'.repeat(3000))
    expect(result.logs[result.logs.length - 1]).toBe(logTruncationMarker(65536))
  }, 15_000)

  it('commits a flushed open prefix before the truncation marker', async () => {
    // A flushed unterminated line is billed and committed; when a later
    // over-budget write truncates, the committed prefix must appear BEFORE the
    // marker — the ledger charged for it, so it cannot vanish.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        "print('committed', end='', flush=True)",
        "print('x' * 100)",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['committed', logTruncationMarker(64)])
  }, 15_000)

  it('drops a forged fd-3 frame with illegal UTF-8 instead of accepting a mangled value', async () => {
    // toString('utf8') would replace the illegal 0xFF with U+FFFD, so a forged
    // done frame could land a corrupted completion value; the fatal decode
    // throws and the frame is dropped. The program's real return still settles
    // the run with the honest value.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, b'{\"type\":\"done\",\"value\":\"bad' + bytes([0xFF]) + b'\"}\\n')",
        'return "ok"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ok')
  }, 15_000)

  it('no-ops a closing frame once an open flood already truncated the ledger', async () => {
    // The closing-frame branch's post-truncation arm: an open flood exhausts
    // the ledger (logsTruncated set, marker pushed), then a closing frame
    // arrives — it must be a no-op, not append content past the marker.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        'for _ in range(2000):',
        "    os.write(3, b'{\"type\":\"log\",\"text\":\"a\",\"open\":true}\\n')",
        "os.write(3, b'{\"type\":\"log\",\"text\":\"b\"}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(60), logTruncationMarker(64)])
  }, 15_000)

  it('bills a merged open entry once, not per fragment', async () => {
    // A merged entry's wire cost is billed ONCE, split across its fragments
    // (first fragment pays quotes+separator, continuations pay only content).
    // Under maxLogBytes: 64, 16 single-character flushes merge to one 16-char
    // entry (2 quotes + 16 content + 1 separator = 19), which fits; per-
    // fragment billing (each charged quotes+separator, ~4 bytes) would truncate
    // at 16 x 4 = 64.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'for _ in range(16):',
        "    print('x', end='', flush=True)",
        "print('')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['x'.repeat(16)])
  }, 15_000)

  it('admits a compliant merged entry whose closing frame fits the remaining budget', async () => {
    // The review's arithmetic check: print('a'*30, flush); print('b'*25) under
    // maxLogBytes: 64 has a merged wire cost of 2 quotes + 55 content + 1
    // separator = 58 <= 63, so it MUST be admitted as one entry. The earlier
    // cap math (logBudget - openCost) made the closing frame's walk see a
    // negative cap and truncate a compliant entry.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        "print('a' * 30, end='', flush=True)",
        "print('b' * 25)",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(30) + 'b'.repeat(25)])
  }, 15_000)

  it('rejects an open frame that would overflow the ledger by one byte', async () => {
    // The review's arithmetic check: an open frame whose full JSON cost is 63
    // (maxLogBytes: 64 -> ledger 63) must be rejected by the first-fragment
    // cap logBudget - 1 (62), not admitted with a bill of 64 that pushes the
    // ledger negative. The frame is FORGED on fd 3 so the child ledger cannot
    // truncate first: a reverted cap of logBudget (63) would admit the frame,
    // hold it, and flush it at settlement, so the marker assertion fails.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, ('{\"type\":\"log\",\"text\":\"' + 'x' * 61 + '\",\"open\":true}\\n').encode())",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual([logTruncationMarker(64)])
  }, 15_000)

  it('bills the closing frame as the merged tail under an exact-fit budget', async () => {
    // The child's split billing: a 30-char open + a 30-char closing frame cost
    // 2 + 60 + 1 = 63 = ledger 63 exactly; the closing frame must be billed as
    // the merged tail (content only), not as a fresh entry (which would
    // double-charge the quotes+separator and truncate an exact-fit entry).
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        "print('a' * 30, end='', flush=True)",
        "print('b' * 30)",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(30) + 'b'.repeat(30)])
  }, 15_000)

  it('does not over-reject an exact-fit closing line while an open entry accumulates', async () => {
    // The write-path pre-check's cheap bound used +3 (quotes + separator) even
    // while an open entry was accumulating, so an exact-fit merged TAIL was
    // truncated. The recipe below goes through the SCAN pre-check (the
    // newline-terminated write arrives with an empty pending buffer, so the
    // buffered-chunks branch is skipped): 'a'*29 flush bills 32 (ledger 31
    // left), then one write of 'b'*30 + newline merges 30 more chars whose
    // cheap bound is 30, not 33 — the +3 form saw 30 + 3 = 33 > 31, sliced to
    // a budget prefix, and pushed past the ledger, emitting the marker for a
    // line that fits (merged cost 2 + 59 + 1 = 62 <= 63).
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import sys',
        "sys.stdout.write('a' * 29)",
        'sys.stdout.flush()',
        "sys.stdout.write('b' * 30 + chr(10))",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(29) + 'b'.repeat(30)])
  }, 15_000)


  it('rejects a new open entry once the ledger has only two bytes left', async () => {
    // The jsonStringCostUpTo sub-2-byte guard: forged open frames drive the
    // host ledger down to 1 byte, then a new open entry's first-fragment cap
    // (logBudget - 1 = 0) trips the guard and truncates.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        "os.write(3, ('{\"type\":\"log\",\"text\":\"' + 'a' * 28 + '\",\"open\":true}\\n').encode())",
        "os.write(3, ('{\"type\":\"log\",\"text\":\"' + 'a' * 31 + '\"}\\n').encode())",
        "os.write(3, b'{\"type\":\"log\",\"text\":\"x\",\"open\":true}\\n')",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['a'.repeat(59), logTruncationMarker(64)])
  }, 15_000)

  it('truncates when the closing frame of a merged entry overflows the budget', async () => {
    // The merged entry's billed-once cost: an open fragment that nearly
    // exhausts the budget, then a closing frame whose content no longer fits —
    // the closing frame's exact-cost walk trips and the marker replaces the
    // entry, exactly like any other over-budget log traffic.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        "print('x' * 40, end='', flush=True)",
        "print('y' * 40)",
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['x'.repeat(40), logTruncationMarker(64)])
  }, 15_000)

  it('keeps a float completion exact when the program mutates the decimal context', async () => {
    // The float encoder's Decimal(repr(value)).normalize() used the process
    // GLOBAL decimal context: a legitimate program setting
    // `getcontext().prec = 2` silently rounded the completion value's digits,
    // and `traps[Inexact] = True` made the encode raise, misclassifying a
    // successful run as an exception. A fixed module-level Context(prec=28)
    // makes the spelling decision context-independent.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'from decimal import getcontext',
        'getcontext().prec = 2',
        'getcontext().traps[__import__("decimal").Inexact] = True',
        'return 1.2345678901234567',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1.2345678901234567)
  }, 15_000)

  it('bounds an over-cap exception-group nesting on the copy', async () => {
    // Exception groups link through `exceptions`, not the cause/context
    // dunders, so the cap has to count that edge too — otherwise a deeply
    // nested group walks past the bound the marker claims to enforce.
    const { runtime } = await setup({ maxValueBytes: 1024 * 1024, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        // ExceptionGroup is a 3.11+ builtin; on 3.10 the NameError is the
        // failure mode being probed, so skip to keep the assertion meaningful.
        'if sys.version_info < (3, 11):',
        '    raise ValueError("skip-old <model>")',
        'group = ValueError("leaf")',
        'for i in range(150):',
        '    group = ExceptionGroup(f"g{i}", [group])',
        'raise group',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    // The version guard skips on Python < 3.11 (ExceptionGroup is a 3.11+
    // builtin) with a distinct message; the truncation assertion applies on
    // 3.11+ where the group nesting is what is being probed.
    expect(result.error?.message).toMatch(/exception chain truncated at 100 links|skip-old/)
  }, 20_000)

  it('filters every bootstrap frame from the traceback of an uncaught binding rejection', async () => {
    // A rejection re-raised by the bootstrap's dispatch adds bootstrap frames
    // AFTER the model's own; only <model> frames may reach model-visible,
    // durable output — a bootstrap.py path would leak host absolutes and make
    // transcripts machine-dependent.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'await tools.boom({})',
      bindings: tools({ boom: async () => { throw new Error('exploded') } }),
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('exploded')
    expect(result.error?.message).toContain('<model>')
    expect(result.error?.message).not.toContain('bootstrap.py')
  })

  it('renders a non-Error thrown value from a host binding as its String form', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.failRaw({})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({
        failRaw: async () => { throw 'raw-nope' },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('raw-nope')
  })

  it('reassembles a frame split across writes behind a completed one', async () => {
    // One os.write carrying "<frame>\n<partial...>" leaves a non-empty
    // residual after the newline loop; the tail must survive until its own
    // newline arrives and then parse as a normal frame.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os, json',
        'head = json.dumps({"type":"log","text":"first"}).encode()',
        'tail = json.dumps({"type":"log","text":"second"}).encode()',
        'import time',
        'os.write(3, head + b"\\n" + tail[:5])',
        'time.sleep(0.2)',
        'os.write(3, tail[5:] + b"\\n")',
        'return "ok"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ok')
    expect(result.logs).toContain('first')
    expect(result.logs).toContain('second')
  })

  it('raises the declared errorClass with the member name on rejection', async () => {
    // PTC mode declares { name: ToolCallError, memberNameProperty: toolName };
    // a host rejection must surface as that class, carrying the failed tool.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.fail({})',
        'except ToolCallError as e:',
        '    caught = f"{type(e).__name__}:{e.toolName}:{e}"',
        'return caught',
      ].join('\n'),
      bindings: [{
        global: 'tools',
        functions: { fail: async () => { throw new Error('typed-nope') } },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ToolCallError:fail:typed-nope')
  })

  it('keeps the declared error class catching when Exception and setattr are rebound', async () => {
    // _make_error_class's minted __init__ def-time captures Exception and
    // setattr, so a program rebinding __main__.Exception/__main__.setattr
    // cannot break the rejection constructor: `except ToolCallError` must still
    // catch and read the member property.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__.Exception = boom',
        '__main__.setattr = boom',
        'caught = ""',
        'try:',
        '    await tools.fail({})',
        'except ToolCallError as e:',
        '    caught = f"{type(e).__name__}:{e.toolName}"',
        'return caught',
      ].join('\n'),
      bindings: [{
        global: 'tools',
        functions: { fail: async () => { throw new Error('typed-nope') } },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ToolCallError:fail')
  }, 15_000)

  it('runs when errorClass metadata is exposed through one-read getters', async () => {
    // Validation reads errorClass.name and errorClass.memberNameProperty, and
    // the ORIGINAL object used to ride along to the boot frame, whose
    // JSON.stringify re-read it after validation: a getter that throws or
    // changes on a second read turned the seam-misuse rejection into a
    // worker-exit (or injected a different name than validation approved).
    // The snapshot reads each field exactly once into a plain copy, so a
    // getter that only tolerates one read must boot and run cleanly.
    let nameReads = 0
    let memberReads = 0
    const errorClass = {
      get name(): string {
        nameReads += 1
        if (nameReads > 1) throw new Error(`errorClass.name read ${nameReads} times`)
        return 'ToolCallError'
      },
      get memberNameProperty(): string {
        memberReads += 1
        if (memberReads > 1) throw new Error(`errorClass.memberNameProperty read ${memberReads} times`)
        return 'toolName'
      },
    }
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return "ok"',
      bindings: [{ global: 'tools', functions: {}, errorClass }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('ok')
    expect(nameReads).toBe(1)
    expect(memberReads).toBe(1)
  }, 15_000)

  it('runs when the binding global is exposed through a one-read getter', async () => {
    // Validation reads namespace.global several times (identifier check, map
    // key, claim, boot frame), and the map key came from a fresh read each
    // time: a getter returning a different name on a later read injected a
    // global validation never approved, and the program referencing the
    // approved name died with NameError. Snapshotting reads it exactly once,
    // so the child must receive the name the program was written against.
    let globalReads = 0
    const namespace = {
      get global(): string {
        globalReads += 1
        return globalReads === 1 ? 'tools' : 'evil'
      },
      functions: { echo: async (args: unknown) => args as CodeJsonValue },
    }
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return await tools.echo(41)',
      bindings: [namespace],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(41)
    expect(globalReads).toBe(1)
  }, 15_000)

  it('rejects an errorClass name colliding with its namespace global at the seam', async () => {
    const { runtime } = await setup()
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'tools', memberNameProperty: 'toolName' } }],
    })).rejects.toThrow(/collides with another injected global/)
  })

  it('rejects a namespace global colliding with a runtime-owned name at the seam', async () => {
    // `__dsh_main__` passes the identifier check, but exec()ing the generated
    // wrapper would silently overwrite the binding after injection. `console`
    // is the WORKER backend's slot — refused here too so a namespace list
    // valid on one backend is valid on all.
    const { runtime } = await setup()
    // `__debug__` is refused for a different reason than a collision: CPython
    // compiles a bare `__debug__` reference to the constant True and refuses to
    // assign the name at compile time, so an injected global under it is
    // unreachable from the program — accepted by the seam, unusable here.
    for (const global of ['__dsh_main__', 'console', '__debug__']) {
      await expect(runtime.run({
        program: 'x = 1',
        bindings: [{ global, functions: {} }],
      })).rejects.toThrow(/collides with a runtime-owned global/)
    }
  })

  it('accepts a non-identifier memberNameProperty and rejects only an empty one', async () => {
    // The seam permits any non-empty own property except the reserved
    // members; Python setattr/getattr carry exotic names like `tool-name`,
    // and the worker backend accepts them, so this backend must too.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'try:',
        '    await tools.boom({})',
        'except ToolCallError as e:',
        '    return getattr(e, "tool-name")',
      ].join('\n'),
      bindings: [{
        global: 'tools',
        functions: { boom: async () => { throw new Error('nope') } },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'tool-name' },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('boom')
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: '' } }],
    })).rejects.toThrow(/memberNameProperty must be a non-empty attribute name/)
  })

  it('resolves a basename pythonBin to an absolute path (runs a real program)', async () => {
    // A bare `python3` basename must resolve against PATH and actually launch
    // under the empty-env spawn — exercises the accessSync success branch.
    const { runtime } = await setup({ pythonBin: 'python3' })
    const result = await runtime.run({ program: 'return 7', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(7)
  })

  it('rejects at load a basename pythonBin with no PATH match', async () => {
    // resolvePythonBin turns a basename into an absolute path before the
    // empty-env spawn; a basename with no PATH match must fail at load (like an
    // empty or NUL pythonBin) rather than silently falling to execvp's
    // platform default PATH and starting a system interpreter the caller never
    // asked for.
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { pythonBin: 'definitely-no-such-python-xyz' }))
      .rejects.toThrow(/does not resolve on PATH/)
  })

  it('rejects a memberNameProperty naming a constrained BaseException attribute', async () => {
    // `__dict__`/`__class__` are constrained descriptors alongside
    // `__traceback__` — setattr of a string raises TypeError while
    // constructing the rejection — so every dunder is refused at the seam.
    const { runtime } = await setup()
    // name/message/stack are the seam's own exclusions (CodeBindingErrorClass
    // forbids replacing them; the worker backend rejects them identically).
    for (const member of ['__traceback__', '__dict__', '__class__', 'args', 'name', 'message', 'stack']) {
      await expect(runtime.run({
        program: 'return 1',
        bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: member } }],
      })).rejects.toThrow(/reserved error member/)
    }
  })

  it('rejects a lossy binding resolution (NaN) instead of coercing it to null', async () => {
    // JSON.stringify would turn NaN into null and drop undefined fields; the
    // seam requires a descriptive rejection so data cannot silently corrupt.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.bad({})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({ bad: async () => Number.NaN }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('lossless JSON')
  })

  it('contains a forged pathological done value without crashing the host', async () => {
    // A ~20k-deep nested array forged onto fd 3 would overflow a recursive
    // JSON.stringify; the host's iterative encoder measures it stack-safely
    // and fails it deterministically on the byte budget (40 kB > 32 KiB).
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os, json',
        'depth = 20000',
        'payload = "[" * depth + "]" * depth',
        'os.write(3, b\'{"type":"done","value":\' + payload.encode() + b\'}\\n\')',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
  })

  it('preserves a deeply nested completion value below the byte budget', async () => {
    // CodeJsonValue has no depth limit: a 10000-deep nested list is only
    // ~20 kB — under maxValueBytes — and must cross intact. That depth
    // overflows BOTH recursive serializers the pipeline used to rely on
    // (CPython's json.dumps recursion limit ~1000s, V8's JSON.stringify), so
    // it proves the child-side _encode_json_plain and the host-side
    // encodeJsonPlain together. The host JSON.parse of the frame is iterative
    // in V8 for arrays, so only the two encoders were at risk.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'v = None',
        'for _ in range(10000):',
        '    v = [v]',
        'return v',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    // Walk down iteratively (a recursive toEqual would itself overflow).
    let depth = 0
    let cursor: unknown = result.value
    while (Array.isArray(cursor)) {
      expect(cursor).toHaveLength(1)
      cursor = cursor[0]
      depth++
    }
    expect(depth).toBe(10000)
    expect(cursor).toBeNull()
  })

  it('bridges a deeply nested binding resolution back into the program stack-safely', async () => {
    // A binding resolution has no seam-level depth or byte cap; neither the
    // host's reply serialization nor the CHILD's reply decode may die on
    // recursion (json.loads raises RecursionError ~10k levels deep; the
    // bootstrap decodes frames iteratively). 12000 levels sits past that
    // limit while staying tiny in bytes.
    const { runtime } = await setup()
    const deep = ((): unknown => {
      let v: unknown = null
      for (let i = 0; i < 12000; i++) v = [v]
      return v
    })()
    const result = await runtime.run({
      program: [
        'v = await tools.deep({})',
        'depth = 0',
        'while isinstance(v, list):',
        '    v = v[0]',
        '    depth += 1',
        'return depth',
      ].join('\n'),
      bindings: tools({ deep: async () => deep as never }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(12000)
  })

  it('rejects a reserved errorClass name at the seam', async () => {
    const { runtime } = await setup()
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{
        global: 'tools',
        functions: {},
        errorClass: { name: 'class', memberNameProperty: 'toolName' },
      }],
    })).rejects.toThrow(/errorClass.name "class" is not a usable Python identifier/)
  })

  it('routes a declared inherited-attribute name through the bridge via subscript', async () => {
    // __class__ resolves on `object` before any fallback hook; the proxy's
    // __getattribute__ intercepts declared names first, and subscript access
    // is the SDK-advertised route for underscore names.
    const { runtime } = await setup()
    const seen: string[] = []
    const result = await runtime.run({
      program: [
        'a = await tools["__class__"]({"via": "subscript"})',
        'b = await tools.__class__({"via": "dot"})',
        'return [a, b]',
      ].join('\n'),
      bindings: tools({
        '__class__': async () => { seen.push('called'); return 'bridged' },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual(['bridged', 'bridged'])
    expect(seen).toEqual(['called', 'called'])
  })

  it('rejects NaN binding arguments immediately instead of hanging', async () => {
    // Default json.dumps would emit a non-standard NaN token that the host
    // JSON.parse drops silently, hanging the call until the wall clock;
    // allow_nan=False raises in-program right away.
    const { runtime } = await setup({ maxWallMs: 8000 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.echo({"x": float("nan")})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({ echo: async args => args as CodeJsonValue }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('lossless JSON')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('carries large binding arguments well past maxValueBytes', async () => {
    // Binding traffic has no seam byte cap: a call frame far larger than the
    // completion budget must reach the host intact (the fd-3 ceiling is a
    // fixed memory-safety bound, not an output budget).
    const maxValueBytes = 4096
    const { runtime } = await setup({ maxValueBytes })
    let receivedLength = 0
    const result = await runtime.run({
      program: [
        `big = "B" * ${maxValueBytes * 50}`,
        'r = await tools.measure({"payload": big})',
        'return r',
      ].join('\n'),
      bindings: tools({
        measure: async (args) => {
          receivedLength = ((args as { payload: string }).payload).length
          return receivedLength
        },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(receivedLength).toBe(maxValueBytes * 50)
    expect(result.value).toBe(maxValueBytes * 50)
  })

  it('rejects an unknown binding name inside the program with a matching error', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.nope({})',
        'except (AttributeError, RuntimeError) as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({ known: async () => 'ok' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('nope')
  })

  it('bounds an unknown-binding diagnostic built from a forged call frame', async () => {
    // `call.global` and `call.name` carry no byte cap of their own, only the
    // 64 MiB fd-3 frame parse cap, and the reply interpolated them raw: one copy
    // into the template result, one into the `JSON.stringify` escape, one into
    // the `encodeJsonPlain` frame, one into the pipe write. Slicing each field
    // to `maxValueBytes` code units first makes an 8 MiB forged name a
    // 128-byte reply. The observable effect is the reply the child then has to
    // READ: its fd-3 reader is unbuffered, so `readline` consumes an oversized
    // reply one `read(2)` per byte and the run's own legitimate call never gets
    // answered — measured under a 60 s ceiling, the 8 MiB case timed out and a
    // 64 MiB case cost the host 509.9 MiB of heap against 120.3 MiB with the
    // slices in place. The child's address space stays generous enough to BUILD
    // the forgery, which is not what is under test.
    const { runtime } = await setup({ maxValueBytes: 128, addressSpaceMb: 1024, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'import os',
        'frame = b\'{"type":"call","id":9001,"global":"tools","name":"\' + b"n" * (8 * 1024 * 1024) + b\'","args":{}}\\n\'',
        // One os.write returns short past the pipe buffer, and a partial frame
        // would glue itself to the next one and be dropped as malformed, so the
        // forgery goes out through a drain loop.
        'view = memoryview(frame)',
        'while view:',
        '    view = view[os.write(3, view):]',
        // A legitimate call after the forgery: its reply can only arrive once
        // the child has read past whatever the forged frame was answered with.
        'await tools.known({})',
        'return "settled"',
      ].join('\n'),
      bindings: tools({ known: async () => 'ok' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('settled')
  }, 40_000)

  it('bridges a binding call reached via subscript access (tools["name"])', async () => {
    // The SDK tells the model `await tools["my-tool"](args)` works for exotic
    // names; the proxy's __getitem__ must route it through the bridge.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'r = await tools["my-tool"]({"n": 7})',
        'return r',
      ].join('\n'),
      bindings: tools({ 'my-tool': async args => ({ got: args as CodeJsonValue }) }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ got: { n: 7 } })
  })

  it('raises KeyError for an undeclared subscript name', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools["absent"]({})',
        'except KeyError as e:',
        '    caught = str(e)',
        'return caught',
      ].join('\n'),
      bindings: tools({ known: async () => 'ok' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('absent')
  })
})

describe('PythonCodeRuntime — budgets, termination, disposal', () => {
  it('kills a wall-clock runaway program via SIGTERM/SIGKILL and reports timeout', async () => {
    const { runtime } = await setup({ maxWallMs: 500, graceMs: 200 })
    const start = Date.now()
    const result = await runtime.run({
      program: 'import time\nwhile True: time.sleep(1)',
      bindings: [],
    })
    const elapsed = Date.now() - start
    // The wall timer may fire first or the exit-after-signal may resolve; both are ok.
    expect(['timeout', 'worker-exit']).toContain(result.error?.kind)
    // We got somewhere in the neighborhood of maxWallMs, not the underlying `sleep(1)`.
    expect(elapsed).toBeLessThan(2000)
  }, 5000)

  it('aborts a run when the outer signal fires mid-flight', async () => {
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const controller = new AbortController()
    const settled: Promise<CodeRunResult> = runtime.run({
      program: 'import time\nwhile True: time.sleep(0.1)',
      bindings: [],
      signal: controller.signal,
    })
    setTimeout(() => { controller.abort('outer-abort') }, 200)
    const result = await settled
    expect(['abort', 'worker-exit']).toContain(result.error?.kind)
  }, 5000)

  it('settles the run when a mid-flight abort reason cannot be converted', async () => {
    // The listener converted the reason before calling `finish()`, so a hostile
    // reason threw from inside an `AbortSignal` listener. Node reports that as an
    // uncaught exception — it can terminate the host — and `finish()` never ran,
    // so the run stayed live until the wall ceiling and misreported as `timeout`
    // (observed) instead of the caller's cancellation. `maxWallMs` is short so
    // that misreport is a fast assertion failure rather than a suite timeout.
    const uncaught: unknown[] = []
    const record = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', record)
    try {
      const { runtime } = await setup({ maxWallMs: 4_000, graceMs: 200 })
      const controller = new AbortController()
      const settled: Promise<CodeRunResult> = runtime.run({
        program: 'import time\nwhile True: time.sleep(0.1)',
        bindings: [],
        signal: controller.signal,
      })
      setTimeout(() => {
        controller.abort({ [Symbol.toPrimitive]() { throw new Error('reason blew up') } })
      }, 200)
      const result = await settled
      expect(result.error?.kind).toBe('abort')
      expect(result.error?.message).toBe('<unrenderable rejection value>')
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  }, 15_000)

  it('disposes to quiescence: an in-flight run resolves as abort and the child exits', async () => {
    const { fiber, runtime } = await setup({ maxWallMs: 10_000 })
    const pending = runtime.run({
      program: 'import time\nwhile True: time.sleep(0.1)',
      bindings: [],
    })
    // Give the process time to spawn and start running.
    await new Promise(resolve => setTimeout(resolve, 200))
    await fiber.dispose()
    const result = await pending
    expect(['abort', 'worker-exit']).toContain(result.error?.kind)
  }, 5000)

  it('reports an interpreter removed after load as worker-exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-python-removed-'))
    const pythonBin = join(dir, 'python3')
    await writeFile(pythonBin, `#!/bin/sh\nexec "${PYABS}" "$@"\n`, { mode: 0o755 })
    const { runtime, fiber } = await setup({ pythonBin, maxWallMs: 3000 })
    rmSync(pythonBin)
    try {
      const result = await runtime.run({ program: 'return 1', bindings: [] })
      expect(result.error?.kind).toBe('worker-exit')
    } finally {
      await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 8000)

  it('applies the strictest of the configured and inherited resource limits', async () => {
    // This case used to drive the bootstrap's `applying resource limits failed`
    // handler with `cpuSeconds: 2 ** 63`, asserting that a cap the child cannot
    // apply fails the run rather than running it uncapped. That premise no longer
    // holds, for two independent reasons, so the test now pins what is actually
    // guaranteed instead of a path no admissible input reaches.
    //
    // First, `2 ** 63` is not a safe integer, so it is now rejected at LOAD as a
    // configuration error — it can never reach the child at all. Second, even the
    // largest admissible values are applied successfully, because `_clamped`
    // bounds every requested pair by the inherited hard limit: an unprivileged
    // process may lower a hard limit but never raise one, so the child keeps the
    // stricter of the two rather than asking for something `setrlimit` refuses.
    // The failure handler remains as a substrate guard (a platform whose kernel
    // refuses the call for its own reasons), but it is no longer reachable from
    // configuration, and a test that pretends otherwise documents a contract the
    // code does not have.
    //
    // What is observable: a very large cap still yields a working run, and the
    // containment it promises is met by the inherited ceiling.
    const { runtime } = await setup({ cpuSeconds: Number.MAX_SAFE_INTEGER - 1, maxWallMs: 10_000 })
    const result = await runtime.run({ program: 'return 1', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1)
  }, 20_000)

  it('settles as worker-exit when the child exits before sending done (no hang)', async () => {
    // Regression: settlement must key off `close` (process reaped AND stdio
    // drained), not `exit`. With `exit`, finish() re-armed a second exit
    // listener that never fired — run() hung forever whenever the exit event
    // beat the final fd-3 data (deterministic on macOS, a lost race elsewhere).
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: 'import os\nos._exit(7)',
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('code=7')
  }, 5000)

  it('classifies RLIMIT_CPU soft-limit expiry (SIGXCPU) as a timeout', async () => {
    // A CPU hot loop burns the soft limit; the kernel delivers SIGXCPU, whose
    // close signal the host maps to `timeout`. macOS re-delivers SIGXCPU
    // differently, so we assert only kind/message here — CI's darwin leg
    // validates real delivery. cpuSeconds must be an integer for setrlimit.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: 'while True: pass',
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('CPU time exhausted')
  }, 8000)

  it('keeps an early self-inflicted SIGKILL a worker-exit, not a CPU timeout', async () => {
    // The unsolicited-SIGKILL-as-timeout classification applies only when the
    // CPU budget could have expired (wall time >= cpuSeconds). A SIGKILL
    // seconds before that (cgroup OOM, an operator, os.kill) is substrate
    // death and stays worker-exit per the orthogonal taxonomy.
    const { runtime } = await setup({ cpuSeconds: 60, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import os, signal',
        'os.kill(os.getpid(), signal.SIGKILL)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('SIGKILL')
  })

  it('charges a forked descendant against the run CPU budget', async () => {
    // RLIMIT_CPU is per-process and every child inherits a FRESH budget, so a
    // program that shells out multiplies `cpuSeconds` by the number of
    // descendants it starts. Measured before the aggregate meter existed: with
    // cpuSeconds 1, two sequential busy children burned 2.0 CPU-seconds
    // (RUSAGE_CHILDREN) and the run still returned a SUCCESS completion. The
    // settle-time check meters RUSAGE_SELF + RUSAGE_CHILDREN and converts the
    // overrun into the same SIGXCPU the untrapped soft limit sends.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import subprocess, sys',
        'for _ in range(2):',
        '    subprocess.run([sys.executable, "-c", "import time\\nt=time.time()\\nwhile time.time()-t<1.2: pass"])',
        'return "escaped the cpu budget"',
      ].join('\n'),
      bindings: [],
    })
    // Darwin's SIGXCPU re-delivery differs, so accept either terminal
    // classification; what must NOT happen is the completion crossing.
    expect(['timeout', 'worker-exit']).toContain(result.error?.kind)
    expect(result.value).toBeUndefined()
  }, 40_000)

  it('does not charge wall time or a cheap descendant against the CPU budget', async () => {
    // The meter is CPU, not wall clock, and it must not fire on a child that
    // burns almost nothing: a sleeping program and a trivial subprocess both
    // have to complete normally, or the check would reject every program that
    // shells out.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 30_000 })
    const slept = await runtime.run({
      program: 'import time\ntime.sleep(1.5)\nreturn "slept"',
      bindings: [],
    })
    expect(slept.error).toBeUndefined()
    expect(slept.value).toBe('slept')
    const cheap = await runtime.run({
      program: [
        'import subprocess, sys',
        'subprocess.run([sys.executable, "-c", "pass"])',
        'return "cheap child"',
      ].join('\n'),
      bindings: [],
    })
    expect(cheap.error).toBeUndefined()
    expect(cheap.value).toBe('cheap child')
  }, 40_000)

  it('spends no part of addressSpaceMb on bootstrap machinery', async () => {
    // RLIMIT_AS counts RESERVED address space, so anything the bootstrap maps
    // for its own accounting is subtracted from the program's `addressSpaceMb`.
    // A sampling thread for the descendant-CPU meter cost 72 MiB here (an 8 MiB
    // stack plus a 64 MiB glibc per-thread malloc arena reservation) and turned
    // the 2-million-entry dict rejection below into a MemoryError under a
    // 256 MiB cap on a slower runner. Assert the child's own mappings directly
    // rather than inferring the budget from a near-cap allocation, so the bound
    // is read from /proc instead of from how much headroom one machine happens
    // to have; 48 MiB is well above the ~30 MiB a bare interpreter maps and
    // well below the 102 MiB the thread produced. `addressSpaceMb` itself is
    // skipped on darwin (the dyld shared cache makes any practical cap
    // unsettable) and /proc/self/maps does not exist there, so the mapping
    // assertion is Linux-only; the completion path is checked everywhere.
    const { runtime } = await setup({ maxValueBytes: 4096, addressSpaceMb: 256 })
    const mapped = await runtime.run({
      program: [
        'import sys',
        'if sys.platform != "linux":',
        '    return 0',
        'total = 0',
        'with open("/proc/self/maps") as handle:',
        '    for line in handle:',
        '        low, high = (int(part, 16) for part in line.split(" ", 1)[0].split("-"))',
        '        total += high - low',
        'return total // (1024 * 1024)',
      ].join('\n'),
      bindings: [],
    })
    expect(mapped.error).toBeUndefined()
    expect(mapped.value).toBeLessThan(48)
  }, 20_000)

  it('spends no part of addressSpaceMb on the reply pump, across a binding await', async () => {
    // The test above measures BEFORE the program yields, so it could not see the
    // reply pump's cost: `loop.run_in_executor(None, read_frame)` created the
    // default executor's first thread on the first `await tools.*`, and that
    // thread's 8 MiB stack plus a 64 MiB glibc per-thread malloc arena are
    // charged to RLIMIT_AS while the limit is already in force — measured, the
    // child went from 30.34 MiB to 102.39 MiB across one binding call. Under a
    // small `addressSpaceMb` the thread cannot start and a legitimate call hangs
    // to `maxWallMs`; under a larger one an allocation that should have fit dies
    // as MemoryError. `loop.add_reader` watches the fd with no thread at all.
    //
    // Measuring both sides inside one run is what discriminates: a single
    // after-the-fact number cannot separate the pump's cost from the
    // interpreter's own footprint. Linux-only for the same reason as above.
    const { runtime } = await setup({ addressSpaceMb: 256, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'def mapped():',
        '    if sys.platform != "linux":',
        '        return 0',
        '    total = 0',
        '    with open("/proc/self/maps") as handle:',
        '        for line in handle:',
        '            low, high = (int(part, 16) for part in line.split(" ", 1)[0].split("-"))',
        '            total += high - low',
        '    return total // (1024 * 1024)',
        'before = mapped()',
        'echoed = await tools.echo({"ping": True})',
        'return {"before": before, "after": mapped(), "echoed": echoed}',
      ].join('\n'),
      bindings: tools({ echo: async args => args as CodeJsonValue }),
    })
    expect(result.error).toBeUndefined()
    const value = result.value as { before: number; after: number; echoed: unknown }
    // The binding call really happened, so the pump really ran.
    expect(value.echoed).toEqual({ ping: true })
    // Awaiting a binding maps nothing extra. The 8 MiB allowance absorbs ordinary
    // heap growth while staying far below the 72 MiB a pump thread cost.
    expect(value.after - value.before).toBeLessThan(8)
  }, 30_000)

  it('still terminates a program that ignores SIGXCPU (hard-limit backstop)', async () => {
    // A hot loop under SIG_IGN burns through the soft limit; the kernel's
    // hard limit (cpuSeconds + 1) SIGKILLs it. Only a kernel-authoritative
    // SIGXCPU close classifies as the CPU timeout — a bare SIGKILL is
    // indistinguishable from a cgroup OOM kill, so it reports worker-exit
    // (Darwin re-delivers SIGXCPU instead, where the wall clock settles it
    // as timeout). Either way the run TERMINATES within the budget — the
    // backstop holds even when the classification is the opaque one.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 6_000 })
    const result = await runtime.run({
      program: [
        'import signal',
        'signal.signal(signal.SIGXCPU, signal.SIG_IGN)',
        'while True: pass',
      ].join('\n'),
      bindings: [],
    })
    expect(['timeout', 'worker-exit']).toContain(result.error?.kind)
  }, 12_000)

  it('enforces the CPU budget even when the program monkeypatches the enforcement primitives', async () => {
    // The check uses import-time-captured references, so replacing
    // resource.getrusage / signal.signal / os.kill on the modules cannot
    // defang it: a trapping program that also swaps the callables and burns
    // past the budget still dies by the authoritative SIGXCPU.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'import signal, os, resource, time',
        'signal.signal(signal.SIGXCPU, lambda *a: None)',
        'resource.getrusage = lambda *a: (_ for _ in ()).throw(RuntimeError("nope"))',
        'os.kill = lambda *a: None',
        'signal.signal = lambda *a: None',
        'deadline = time.process_time() + 1.05',
        'while time.process_time() < deadline: pass',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.value).toBeUndefined()
  }, 15_000)

  it('re-delivers SIGXCPU when a trapping program returns inside the soft-to-hard gap', async () => {
    // A program can trap SIGXCPU and settle during the one-second gap; the
    // bootstrap re-checks the kernel CPU meter (getrusage) after settlement
    // and dies by SIGXCPU with the default disposition restored, so the host
    // still classifies the exhausted budget as a timeout instead of success.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'import signal, time',
        'fired = []',
        'signal.signal(signal.SIGXCPU, lambda *a: fired.append(1))',
        'deadline = time.process_time() + 1.05',
        'while time.process_time() < deadline: pass',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('CPU time exhausted')
    expect(result.value).toBeUndefined()
  }, 15_000)

  it('enforces the CPU budget when the program rebinds the enforcer on __main__', async () => {
    // The bootstrap IS `__main__`, so `import __main__` reaches its globals.
    // The enforcement callable holds its primitives in closure cells (not
    // module attributes) and `_run` reads the callable into a frame local
    // before the program starts, so neither replacing the global nor swapping
    // the module's captured names changes what runs after settlement.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'import signal, time, __main__',
        'signal.signal(signal.SIGXCPU, lambda *a: None)',
        '__main__._DIE_IF_CPU_EXHAUSTED = lambda *_: None',
        'deadline = time.process_time() + 1.05',
        'while time.process_time() < deadline: pass',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.value).toBeUndefined()
  }, 15_000)

  it('bounds a program that defeats the post-check by writing its closure cell', async () => {
    // The closure-cell capture raises the cost of defeating the post-check; it
    // does NOT make it unreachable, and nothing in-process could: a cell is
    // writable through `fn.__closure__[i].cell_contents`, and `sys._getframe`
    // reads _run's frame locals. This program does exactly that — walks to
    // _run's frame, takes the enforcement callable, and replaces its captured
    // `getrusage` with one reporting zero CPU used — then burns past cpuSeconds
    // with SIGXCPU trapped. The run must still fail, because the bound that
    // model code cannot forge is outside the interpreter: the RLIMIT_CPU HARD
    // limit at cpuSeconds + 1, whose SIGKILL admits no handler. No success is
    // reportable either way.
    const { runtime } = await setup({ cpuSeconds: 1, maxWallMs: 20_000 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'import signal, sys, time',
        'signal.signal(signal.SIGXCPU, lambda *a: None)',
        // Walk out of __dsh_main__ to _run's frame and take its local.
        'die = None',
        'depth = 1',
        'while depth < 12:',
        '    frame = sys._getframe(depth)',
        '    if "die_if_cpu_exhausted" in frame.f_locals:',
        '        die = frame.f_locals["die_if_cpu_exhausted"]',
        '        break',
        '    depth += 1',
        'assert die is not None, "enforcer not reachable from the frame chain"',
        'class Zero:',
        '    ru_utime = 0.0',
        '    ru_stime = 0.0',
        'names = die.__code__.co_freevars',
        'die.__closure__[names.index("getrusage")].cell_contents = lambda *a: Zero()',
        // Burn well past the soft limit into the hard limit's SIGKILL.
        'while True: pass',
      ].join('\n'),
      bindings: [],
    })
    // What holds on EVERY platform: the tampering bought no success. The run
    // failed, carried no value, and the reported kind is one of the two
    // kernel-level outcomes — never a completion.
    expect(result.value).toBeUndefined()
    expect(result.error?.kind === 'worker-exit' || result.error?.kind === 'timeout').toBe(true)
    if (process.platform === 'linux') {
      // Linux enforces the RLIMIT_CPU HARD limit at cpuSeconds + 1 promptly, so
      // the CPU bound — not the 20 s wall ceiling — is what stops the program.
      // Its SIGKILL is not SIGXCPU, so the orthogonal-failure taxonomy reports
      // `worker-exit`: a bare SIGKILL is not evidence of CPU burn.
      expect(result.error?.kind).toBe('worker-exit')
      expect(Date.now() - start).toBeLessThan(15_000)
    } else {
      // Darwin does not deliver the hard limit's SIGKILL on the same schedule;
      // observed on the macOS lane, a program that patches the post-check runs
      // to the WALL ceiling instead. The CPU budget is therefore not the
      // binding constraint against a tampering program there — the wall clock
      // is. Asserted rather than skipped so the difference stays visible.
      expect(result.error?.kind).toBe('timeout')
    }
  }, 30_000)

  it('keeps a finished-but-not-closed run live so dispose awaits the child\'s death', async () => {
    // finish() no longer drops the run from `live`; settle() (at close) does.
    // A SIGTERM-trapping program with a small graceMs sits in the grace window
    // after finish() fires — dispose() must not resolve until the SIGKILL
    // backstop actually reaps the child. The program prints its pid (captured
    // as a log even on abort); once dispose() resolves, that pid must be dead
    // (process.kill(pid, 0) throws ESRCH).
    const { fiber, runtime } = await setup({ maxWallMs: 10_000, graceMs: 400 })
    // Deterministic readiness: the program reports its pid through a binding
    // AFTER installing the trap, so dispose cannot race the spawn (a fixed
    // sleep lost that race on slow CI runners — SIGTERM landed pre-trap).
    let reportedPid!: (pid: number) => void
    const trapReady = new Promise<number>((resolve) => { reportedPid = resolve })
    const pending = runtime.run({
      program: [
        'import signal, time, os',
        'signal.signal(signal.SIGTERM, lambda *a: None)',
        'await tools.ready({"pid": os.getpid()})',
        'while True: time.sleep(0.05)',
      ].join('\n'),
      bindings: tools({
        ready: async (args) => {
          reportedPid((args as { pid: number }).pid)
          return 'ok'
        },
      }),
    })
    const pid = await trapReady
    const start = Date.now()
    await fiber.dispose()
    const elapsed = Date.now() - start
    const result = await pending
    expect(['abort', 'worker-exit', 'timeout']).toContain(result.error?.kind)
    // dispose() returned only after the grace window elapsed (the SIGTERM trap
    // forces the SIGKILL backstop path), proving the run stayed live past finish().
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    // The child is fully reaped by the time dispose() resolved.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
  }, 8000)

  it('settles on the decided result even when a setsid-escaped orphan holds stdio open past close', async () => {
    // `close` only fires once every inherited stdio stream drains. A descendant
    // started with start_new_session=True escapes the child's process group, so
    // the SIGTERM/SIGKILL aimed at that group never reaches it; if it inherited
    // our stdout/stderr/fd 3 and outlives the run, `close` would never fire and
    // run() would hang forever. The close-deadline backstop (graceMs + margin)
    // must force settlement on the value the `done` frame already decided.
    const { runtime } = await setup({ graceMs: 100 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'import subprocess, sys',
        // Orphan in a fresh session, inheriting our stdout/stderr/fd 3, alive
        // past the close-deadline so `close` cannot fire on its own. Its own
        // 5 s self-exit is the leak ceiling AND the discriminator: it must stay
        // ABOVE the < 4000 ms upper-bound assertion below, so if the deadline
        // backstop failed to settle, settlement could only come from this
        // self-exit at ~5 s and blow the bound — a sharper signal than the wall
        // ceiling would give.
        'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"],',
        '                 start_new_session=True)',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    const elapsed = Date.now() - start
    // The done frame decided the value; the deadline settled it despite the
    // orphan pinning the pipes open.
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('escaped')
    // Settlement waited for the backstop (graceMs + CLOSE_REAP_MARGIN_MS ≈ 2.1s),
    // not the orphan's 5 s self-exit — proving the deadline, not a fallback, fired.
    expect(elapsed).toBeGreaterThanOrEqual(1_500)
    expect(elapsed).toBeLessThan(4_000)
  }, 8000)

  it('flushes a newline-free diagnostic when the closeDeadline forces settlement', async () => {
    // A leader that writes an unterminated diagnostic via `os.write(1, ...)` and
    // then exits, leaving a setsid orphan holding the pipes open, settles through
    // the closeDeadline destroy() path — which fires no `end`. The residual must
    // be flushed before destroy() drops it, or the diagnostic is lost from
    // `logs`. The value is decided by the done frame; the diagnostic must survive.
    const { runtime } = await setup({ graceMs: 100 })
    const result = await runtime.run({
      program: [
        'import os, subprocess, sys',
        'os.write(1, b"leader-diagnostic-no-newline")',
        'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"],',
        '                 start_new_session=True)',
        'return "escaped"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('escaped')
    expect(result.logs).toContain('leader-diagnostic-no-newline')
  }, 8000)

  it('closes the child stdin so a program read sees EOF instead of blocking', async () => {
    // The host closes the child's stdin write handle immediately after spawn
    // (the program is an async body that reads nothing from fd 0; a live pipe
    // would hold a host-side handle open past the run). A program that DOES
    // read fd 0 therefore sees EOF at once. Fail-before: with the handle left
    // open and no data written, `sys.stdin.read()` blocks and the run would
    // hang to maxWallMs as a timeout.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'data = sys.stdin.read()',
        'return "read: " + repr(data)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe("read: ''")
  }, 15_000)

  it('keeps runtime type annotations as live classes, not PEP 563 strings, when the program reads them', async () => {
    // bootstrap.py imports `from __future__ import annotations`; without
    // dont_inherit=True on compile(), that PEP 563 flag leaks into the program's
    // compiled code and stringifies its type annotations, changing the semantics
    // of a legal program that reads `f.__annotations__` at runtime.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'def f(x: int) -> int:',
        '    return x',
        'return f.__annotations__["x"].__name__',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('int')
  }, 15_000)

  it('reaps a same-group child that ignores SIGTERM and releases the pipes before close', async () => {
    // The same-group counterpart to the setsid-orphan case above. A descendant
    // left in the child's OWN process group (no setsid, so `kill(-pid)` reaches
    // it) can ignore SIGTERM yet still release the inherited stdout/stderr/fd 3
    // it does not hold — here by giving the Popen child DEVNULL streams and
    // letting close_fds drop fd 3. The leader then writes `done` and exits, its
    // `close` fires because the pipes drained, and settle() runs while that
    // descendant is still alive. settle() then keeps a REF'd poll alive until the
    // grace-window SIGKILL has emptied the whole process group, so the host cannot
    // exit and reparent the survivor to init: no subprocess outlives the fiber.
    //
    // The descendant must have SIG_IGN installed BEFORE the host sends SIGTERM,
    // or it dies from the default SIGTERM whether the fix is present or not — so
    // it writes a readiness marker after trapping and the leader waits for that
    // marker before returning. While alive it bumps a heartbeat file every 50 ms;
    // the test asserts the heartbeat STOPS, which is what "no longer executing"
    // means whether the killed descendant is reaped or lingers as a zombie (a
    // SIGKILL'd process runs no more code either way). It sleeps 30 s as a safety
    // net so a broken fix cannot leak it forever.
    const handoff = await makeTempDir('dsh-samegroup-')
    const readyMarker = join(handoff, 'ready')
    const heartbeat = join(handoff, 'heartbeat')
    const { runtime } = await setup({ maxWallMs: 10_000, graceMs: 300 })
    const result = await runtime.run({
      program: [
        'import subprocess, sys, os, time',
        `marker = ${JSON.stringify(readyMarker)}`,
        `heartbeat = ${JSON.stringify(heartbeat)}`,
        // Same group (no start_new_session); ignores SIGTERM; holds none of the
        // leader's pipes (DEVNULL std streams, close_fds drops fd 3). It writes
        // the marker (argv[1]) only AFTER the trap is installed — so the leader
        // cannot return, and the host cannot send SIGTERM, before it is ignored —
        // then rewrites the heartbeat (argv[2]) every 50 ms for up to 30 s.
        'code = ("import signal, sys, time\\n"',
        '        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"',
        '        "open(sys.argv[1], \'w\').close()\\n"',
        '        "end = time.time() + 30\\n"',
        '        "while time.time() < end:\\n"',
        '        "    open(sys.argv[2], \'w\').close()\\n"',
        '        "    time.sleep(0.05)\\n")',
        'child = subprocess.Popen([sys.executable, "-c", code, marker, heartbeat],',
        '                         stdin=subprocess.DEVNULL,',
        '                         stdout=subprocess.DEVNULL,',
        '                         stderr=subprocess.DEVNULL)',
        'deadline = time.time() + 5',
        'while not os.path.exists(marker) and time.time() < deadline:',
        '    time.sleep(0.02)',
        'return "spawned"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('spawned')
    // The trap really installed before the leader returned, so this is the
    // SIGTERM-ignoring descendant, not one that would have died to the default.
    expect(existsSync(readyMarker)).toBe(true)
    // The grace-window SIGKILL (graceMs 300 + reap margin) empties the group. Once
    // it has, the descendant stops bumping the heartbeat. Poll the heartbeat's
    // mtime: two consecutive reads far enough apart with no change means it is no
    // longer executing — true whether it was reaped or lingers as a zombie, so
    // the assertion holds in a container whose init does not wait() orphans. The
    // window (well under the 30 s self-timeout) proves the SIGKILL did the work.
    const mtime = (): number => { try { return statSync(heartbeat).mtimeMs } catch { return 0 } }
    const stopDeadline = Date.now() + 8_000
    let last = mtime()
    let still = false
    while (Date.now() < stopDeadline) {
      await new Promise(resolve => setTimeout(resolve, 400))
      const now = mtime()
      if (now === last && now !== 0) { still = true; break }
      last = now
    }
    expect(still).toBe(true)
  }, 20_000)

  it('dispose awaits reaping of a same-group survivor from a completed run', async () => {
    // The quiescence contract also holds for a run that ALREADY resolved: the run
    // stays tracked in `live` until its process group is reaped, so a `dispose()`
    // that races a just-returned run() still awaits the survivor rather than
    // snapshotting an empty `live` and returning while it lives. Here the run
    // completes (leaving a SIGTERM-ignoring same-group descendant), then dispose()
    // is called; the heartbeat must be stale BY THE TIME dispose() resolves —
    // proving teardown waited for the reap, not merely that the reap eventually
    // happened.
    const handoff = await makeTempDir('dsh-dispose-quiesce-')
    const readyMarker = join(handoff, 'ready')
    const heartbeat = join(handoff, 'heartbeat')
    const { runtime, fiber } = await setup({ maxWallMs: 10_000, graceMs: 300 })
    const result = await runtime.run({
      program: [
        'import subprocess, sys, os, time',
        `marker = ${JSON.stringify(readyMarker)}`,
        `heartbeat = ${JSON.stringify(heartbeat)}`,
        'code = ("import signal, sys, time\\n"',
        '        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"',
        '        "open(sys.argv[1], \'w\').close()\\n"',
        '        "end = time.time() + 30\\n"',
        '        "while time.time() < end:\\n"',
        '        "    open(sys.argv[2], \'w\').close()\\n"',
        '        "    time.sleep(0.05)\\n")',
        'child = subprocess.Popen([sys.executable, "-c", code, marker, heartbeat],',
        '                         stdin=subprocess.DEVNULL,',
        '                         stdout=subprocess.DEVNULL,',
        '                         stderr=subprocess.DEVNULL)',
        'deadline = time.time() + 5',
        'while not os.path.exists(marker) and time.time() < deadline:',
        '    time.sleep(0.02)',
        'return "spawned"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(existsSync(readyMarker)).toBe(true)
    // dispose() must not return until the group is reaped. After it resolves, the
    // heartbeat must already be stale: read its mtime, wait past the heartbeat
    // interval, and confirm it did not advance — the descendant is no longer
    // executing (reaped or zombie), so teardown was genuinely quiescent.
    await fiber.dispose()
    const mtime = (): number => { try { return statSync(heartbeat).mtimeMs } catch { return 0 } }
    const afterDispose = mtime()
    // Pin the assertion to a heartbeat that actually ran: mtime() returns 0 when
    // the file never existed, so without this the `toBe` below would pass
    // vacuously (0 === 0) if the survivor never wrote a heartbeat at all.
    expect(afterDispose).toBeGreaterThan(0)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(mtime()).toBe(afterDispose)
  }, 20_000)

  it('sends SIGKILL at the poll deadline when the event loop was blocked past both timers', async () => {
    // If the host event loop is blocked (a big synchronous computation) from
    // before the group-reap poll was scheduled until after the deadline, both the
    // poll timer and the grace-window SIGKILL timer are overdue when the loop
    // resumes. Node runs the earlier-scheduled poll first, so the SIGKILL timer
    // may not have fired yet. The deadline arm must then send SIGKILL ITSELF
    // rather than cancel the unfired escalation — otherwise a SIGTERM-ignoring
    // same-group survivor is released for good. A synchronous busy-loop after
    // run() resolves reproduces the block deterministically.
    const handoff = await makeTempDir('dsh-deadline-')
    const readyMarker = join(handoff, 'ready')
    const heartbeat = join(handoff, 'heartbeat')
    const graceMs = 300
    const { runtime } = await setup({ maxWallMs: 10_000, graceMs })
    const result = await runtime.run({
      program: [
        'import subprocess, sys, os, time',
        `marker = ${JSON.stringify(readyMarker)}`,
        `heartbeat = ${JSON.stringify(heartbeat)}`,
        'code = ("import signal, sys, time\\n"',
        '        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"',
        '        "open(sys.argv[1], \'w\').close()\\n"',
        '        "end = time.time() + 30\\n"',
        '        "while time.time() < end:\\n"',
        '        "    open(sys.argv[2], \'w\').close()\\n"',
        '        "    time.sleep(0.05)\\n")',
        'child = subprocess.Popen([sys.executable, "-c", code, marker, heartbeat],',
        '                         stdin=subprocess.DEVNULL,',
        '                         stdout=subprocess.DEVNULL,',
        '                         stderr=subprocess.DEVNULL)',
        'deadline = time.time() + 5',
        'while not os.path.exists(marker) and time.time() < deadline:',
        '    time.sleep(0.02)',
        'return "spawned"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(existsSync(readyMarker)).toBe(true)
    // Block the event loop synchronously past graceMs + CLOSE_REAP_MARGIN_MS
    // (2000) with margin, so both timers are overdue when the loop resumes.
    const blockUntil = Date.now() + graceMs + 2_000 + 800
    while (Date.now() < blockUntil) { /* busy-wait, no yield */ }
    // Yield: the overdue poll runs (group still non-empty, deadline passed) and
    // must send SIGKILL itself. The survivor then stops bumping the heartbeat.
    const mtime = (): number => { try { return statSync(heartbeat).mtimeMs } catch { return 0 } }
    const stopDeadline = Date.now() + 5_000
    let last = mtime()
    let stopped = false
    while (Date.now() < stopDeadline) {
      await new Promise(resolve => setTimeout(resolve, 400))
      const now = mtime()
      if (now === last && now !== 0) { stopped = true; break }
      last = now
    }
    expect(stopped).toBe(true)
  }, 20_000)
})

describe('PythonCodeRuntime — hostile peer', () => {
  it('drops garbage bytes and unknown-shape frames posted directly to fd 3', async () => {
    // The model program can reach fd 3 and write anything. We inject a
    // non-JSON line, a valid JSON but unknown-shape frame, and a broken done
    // frame; the host must not crash, and the real `done` still settles the run.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(3, b"not-json\\n")',
        'os.write(3, b\'{"type":"unknown"}\\n\')',
        'os.write(3, b\'{"type":"done","error":{"message":42}}\\n\')',
        'return "survived"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('survived')
  })

  it('answers a forged call frame for an unknown binding and never crashes', async () => {
    // The unknown-binding reply path, driven through the id the host expects:
    // the program lets its own first call claim id 0 and forges id 1, which the
    // host answers with the `unknown binding` rejection the honest call would
    // have received. A forged id out of sequence is dropped instead — that is
    // the id-bound test below, not this one.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    let seenLegitCall = false
    const result = await runtime.run({
      program: [
        'import os, json',
        'x = await tools.echo({"ping": True})',
        'os.write(3, json.dumps({"type":"call","id":1,"global":"tools","name":"forged","args":{}}).encode() + b"\\n")',
        // The forged frame is answered, but nothing in the child awaits id 1, so
        // the reply is ignored and the run completes on its own value.
        'return x',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { seenLegitCall = true; return args as CodeJsonValue },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ ping: true })
    expect(seenLegitCall).toBe(true)
  }, 15_000)

  it('caps the unknown-binding preview for a huge forged name', async () => {
    // The unknown-binding reply's JSON.stringify ran on the WHOLE capped
    // target, allocating the escaped form — up to ~6x under control-heavy
    // input. The preview is now built from a 1 KiB prefix, so a forged call
    // with a huge global/name cannot spike host memory near the value ceiling;
    // the reply still identifies the binding.
    const { runtime } = await setup({ maxWallMs: 8_000, maxValueBytes: 1024 * 1024 })
    const result = await runtime.run({
      program: [
        'import os, json',
        'x = await tools.echo({"ping": True})',
        'name = "n" * 100000',
        'os.write(3, json.dumps({"type":"call","id":1,"global":"tools","name":name,"args":{}}).encode() + b"\\n")',
        'return x',
      ].join('\n'),
      bindings: tools({
        echo: async args => args as CodeJsonValue,
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ ping: true })
  }, 15_000)

  it('drops forged call frames whose ids are not the next in sequence, retaining no per-id state', async () => {
    // The host used to remember every answered id in a Set, so a program could
    // write an unbounded run of unique forged ids — each frame far below the
    // 64 MiB cap, so nothing rejected them — and grow host memory for the
    // whole run. Ids are consecutive from 0, so one counter replaces the set.
    //
    // The discriminator is that the forgeries must not be answered. Each names a
    // binding that does exist, so a host answering them would run `echo` once
    // per forgery; the count proves only the legitimate call was dispatched.
    // Ids also run DESCENDING, so a high-water-mark test would drop the honest
    // call that follows rather than the forgeries.
    const { runtime } = await setup()
    let echoCalls = 0
    const result = await runtime.run({
      program: [
        'import os, json',
        'for i in range(2000, 0, -1):',
        '    os.write(3, json.dumps({"type":"call","id":i,"global":"tools","name":"echo","args":{"forged":i}}).encode() + b"\\n")',
        'x = await tools.echo({"ping": True})',
        'return x',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { echoCalls += 1; return args as CodeJsonValue },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ ping: true })
    expect(echoCalls).toBe(1)
  }, 15_000)

  it('keeps answering calls a program makes after one with unserializable arguments', async () => {
    // The child claims an id only once its write succeeds, so a call rejected
    // child-side for non-lossless arguments leaves no gap. Were a gap possible,
    // the host's exact-successor test would drop every later call and the run
    // would hang to the wall ceiling instead of completing.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const seen: unknown[] = []
    const result = await runtime.run({
      program: [
        'caught = ""',
        'try:',
        '    await tools.echo({"bad": float("inf")})',
        'except RuntimeError as e:',
        '    caught = str(e)',
        'after = await tools.echo({"ok": True})',
        'return {"caught": caught, "after": after}',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { seen.push(args); return args as CodeJsonValue },
      }),
    })
    expect(result.error).toBeUndefined()
    const value = result.value as { caught: string; after: unknown }
    expect(value.caught).toContain('lossless JSON')
    expect(value.after).toEqual({ ok: true })
    // The rejected call never reached the host; the one after it did.
    expect(seen).toEqual([{ ok: true }])
  }, 15_000)

  it('drops a forged frame carrying an integer outside JavaScript safe range', async () => {
    // JSON.parse would silently round 9007199254740993 to ...992 BEFORE any
    // validation, corrupting a dispatched argument or completion. The host
    // scans the raw line and drops such frames as hostile traffic; the honest
    // child cannot produce one (its validator rejects unsafe ints).
    const { runtime } = await setup()
    let dispatched: unknown
    const result = await runtime.run({
      program: [
        'import os',
        // Forged call frame with an unsafe int argument, then a forged done
        // frame with an unsafe int value — both must be dropped whole.
        'os.write(3, b\'{"type":"call","id":7,"global":"tools","name":"echo","args":9007199254740993}\\n\')',
        'os.write(3, b\'{"type":"done","value":9007199254740993}\\n\')',
        'x = await tools.echo({"ok": True})',
        'return x',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { dispatched = args; return args as CodeJsonValue },
      }),
    })
    expect(result.error).toBeUndefined()
    // The forged done did not settle the run; the legit call and completion did.
    expect(result.value).toEqual({ ok: true })
    expect(dispatched).toEqual({ ok: true })
  })

  it('truncates host-side logs once the budget is exhausted and emits the marker', async () => {
    // Set a tiny host-side budget; the Python side has a much larger one, so
    // its LogBuffer will not truncate — the host ledger fires first.
    const { runtime } = await setup({ maxLogBytes: 128 })
    const result = await runtime.run({
      program: [
        'for _ in range(50):',
        '    print("aaaaaaaaaa")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    const markers = result.logs.filter(line => line.includes('log capture truncated at 128 bytes'))
    expect(markers.length).toBeGreaterThanOrEqual(1)
  })

  it('reports an exception whose message holds an unpaired surrogate instead of stranding to the wall clock', async () => {
    // A strict UTF-8 encode of "\ud800" throws while BUILDING the failure
    // frame; the run would then hang to maxWallMs and misreport as timeout.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const result = await runtime.run({
      program: String.raw`raise Exception("bad \ud800 surrogate")`,
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('bad')
    expect(result.error?.message).toContain('surrogate')
  })

  it('carries a lone-surrogate completion string across the wire as its JSON escape', async () => {
    // UTF-8 has no encoding for a lone surrogate, but JSON does: the ASCII
    // `\ud800` escape, which JSON.parse reads back as the same UTF-16 code
    // unit. `CodeJsonValue`, `snapshotJsonValue`, and the worker backend all
    // accept such a string, so this backend must not narrow the shared seam.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: String.raw`return {"lone": "a\ud800b", "spelled": "😀"}`,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    // The lone half survives as the code unit itself; a spelled-out high-low
    // PAIR folds into the astral character the host would hold for it.
    expect(result.value).toEqual({ lone: 'a\ud800b', spelled: '\u{1f600}' })
  })

  it('meters a lone surrogate at its six escaped bytes, matching the host', async () => {
    // The child and the host share maxValueBytes, so the child must charge the
    // escape's six ASCII bytes (plus two quotes): eight fits, nine does not.
    const { runtime } = await setup({ maxValueBytes: 8 })
    const ok = await runtime.run({ program: String.raw`return "\ud800"`, bindings: [] })
    expect(ok.error).toBeUndefined()
    expect(ok.value).toBe('\ud800')
    const over = await setup({ maxValueBytes: 7 })
    const result = await over.runtime.run({ program: String.raw`return "\ud800"`, bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
  })

  it('meters a surrogate-dense completion by counting, not by materializing a match list', async () => {
    // `_json_str_cost` counted lone surrogates with `_SURROGATE.findall`,
    // which materializes one single-character string PER surrogate: a
    // surrogate-dense value near the budget (each surrogate serializes to six
    // bytes, so a budget-sized value holds millions of them) would allocate
    // millions of objects before the meter returned — an O(N)-objects spike
    // that defeats the meter's documented contract of counting without
    // building. The count is now a length difference over the removal `sub`
    // already performs. Three million lone surrogates pin the boundary at
    // scale: 18,000,002 serialized bytes succeed at an 18,000,002 budget and
    // report output-limit one byte under, proving the meter counts every
    // surrogate exactly rather than dropping or over-charging any.
    const { runtime } = await setup({ maxValueBytes: 18_000_002 })
    const ok = await runtime.run({ program: 'return "\\ud800" * 3000000', bindings: [] })
    expect(ok.error).toBeUndefined()
    expect(ok.value).toBe('\ud800'.repeat(3_000_000))
    const over = await setup({ maxValueBytes: 18_000_001 })
    const result = await over.runtime.run({ program: 'return "\\ud800" * 3000000', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
  }, 60_000)

  it('passes a lone-surrogate binding argument through instead of failing the call', async () => {
    // The argument validator shared the same over-narrow rejection; a host
    // binding must receive the code unit the program passed.
    const seen: unknown[] = []
    const { runtime } = await setup()
    const result = await runtime.run({
      program: String.raw`return await tools.echo({"text": "x\udfff"})`,
      bindings: tools({ echo: async (args: unknown) => { seen.push(args); return args as CodeJsonValue } }),
    })
    expect(result.error).toBeUndefined()
    expect(seen).toEqual([{ text: 'x\udfff' }])
    expect(result.value).toEqual({ text: 'x\udfff' })
  })

  it('meters a non-ASCII completion in UTF-8 JSON bytes, matching the host', async () => {
    // json.dumps' default \uXXXX escaping would count "é" as 8 bytes while
    // the host meter counts its UTF-8 JSON form (4); the shared budget must
    // agree, so a 4-byte-fitting value passes a maxValueBytes of 4.
    const { runtime } = await setup({ maxValueBytes: 4 })
    const ok = await runtime.run({ program: 'return "é"', bindings: [] })
    expect(ok.error).toBeUndefined()
    expect(ok.value).toBe('é')
    const over = await runtime.run({ program: 'return "éx"', bindings: [] })
    expect(over.error?.kind).toBe('output-limit')
  })

  it('filters bootstrap frames from exception-group members (TaskGroup)', async () => {
    // Python 3.11+ stores member stacks under TracebackException.exceptions;
    // the <model>-frame filter must recurse into them too.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import asyncio, sys',
        'if sys.version_info < (3, 11):',
        '    raise ValueError("skip-old <model>")',
        'async def boom():',
        '    raise ValueError("group-member")',
        'async with asyncio.TaskGroup() as tg:',
        '    tg.create_task(boom())',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('<model>')
    expect(result.error?.message).not.toContain('bootstrap.py')
  })

  it('keeps frames intact when a model thread floods logs while a large frame drains', async () => {
    // os.write releases the GIL and a frame beyond PIPE_BUF is not atomic:
    // without the writer lock + full-write loop, the printing thread could
    // interleave bytes mid-frame and the host would drop the malformed JSON,
    // hanging the run to the wall clock (or losing the completion).
    const { runtime } = await setup({ maxValueBytes: 1024 * 1024, maxLogBytes: 4 * 1024 * 1024, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'import threading',
        'stop = False',
        'def spam():',
        '    while not stop:',
        '        print("spam-line-" + "y" * 100)',
        't = threading.Thread(target=spam)',
        't.start()',
        // A ~300 KiB completion — several PIPE_BUF units — while spam runs.
        'big = "x" * (300 * 1024)',
        'stop = True',
        't.join()',
        'return big',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('x'.repeat(300 * 1024))
  }, 20_000)

  it('settles cleanly while a daemon thread keeps writing unterminated log text', async () => {
    // WARNING regression: the settlement `flush_out()/flush_err()` on the main
    // coroutine read and clear `_LogStream._pending` and the shared LogBuffer
    // ledger with NO lock, while a model daemon thread's `print`/`write` mutate
    // the same state. Capturing the bound method (`out_stream.flush_line`) only
    // fixes WHICH callable runs, not what it reads mid-flight: the flush could
    // interleave with a concurrent write and join a `_pending` list being
    // mutated under it, corrupting the ledger and costing the `done` frame — the
    // run would then strand to the wall clock instead of completing. The shared
    // re-entrant lock serializes them.
    //
    // A pure data race has no single bad input to reject deterministically, so
    // this maximizes overlap: daemon threads emit UNTERMINATED writes (which
    // pile into `_pending` rather than flushing per line) right up to the moment
    // the body returns and settlement flushes. Repeated so the interleave lands.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { runtime, fiber } = await setup({ maxLogBytes: 4 * 1024 * 1024, maxWallMs: 15_000 })
      const result = await runtime.run({
        program: [
          'import sys, threading',
          'stop = False',
          'def spam():',
          '    while not stop:',
          // No newline: the text accumulates in the stream's `_pending`, which is
          // exactly the state the settlement flush also touches.
          '        sys.stdout.write("tail-fragment-" + "z" * 64)',
          'workers = [threading.Thread(target=spam, daemon=True) for _ in range(4)]',
          'for t in workers: t.start()',
          // Let the daemons build up pending writes, then return so settlement
          // flushes while they are still mid-write.
          'import time; time.sleep(0.05)',
          'return "settled"',
        ].join('\n'),
        bindings: [],
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe('settled')
      await fiber.dispose()
    }
  }, 30_000)

  it('completes a binding called from a worker thread on its own event loop', async () => {
    // A binding reply Future is created on the loop that ran `dispatch`. When the
    // model calls a binding from a worker THREAD via `asyncio.run(tools.x(...))`,
    // that Future belongs to the thread's loop, not the main loop where
    // `_pump_replies` reads the reply. `asyncio.Future` is not thread-safe:
    // completing it from another thread does not wake its own loop, so a direct
    // `set_result` would strand the awaiting thread and the run would degrade to a
    // wall-clock timeout. The pump must schedule completion on the Future's own
    // loop via `call_soon_threadsafe`. The tight maxWallMs makes the pre-fix
    // failure a fast timeout rather than a hang.
    //
    // The main coroutine yields with `await asyncio.sleep` while the worker runs,
    // rather than a synchronous `t.join()`: joining would block the main thread,
    // so the main loop could not run `_pump_replies` and the call would deadlock
    // regardless of the fix — that blocks the pump, not the cross-loop delivery
    // this test pins.
    const { runtime } = await setup({ maxWallMs: 8_000 })
    const seen: unknown[] = []
    const result = await runtime.run({
      program: [
        'import asyncio, threading',
        'result = {}',
        'def worker():',
        // A fresh loop in this thread; the binding Future is created here.
        '    result["value"] = asyncio.run(tools.echo({"from": "thread"}))',
        't = threading.Thread(target=worker)',
        't.start()',
        'while t.is_alive():',
        '    await asyncio.sleep(0.02)',
        'return result["value"]',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { seen.push(args); return args as CodeJsonValue },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ from: 'thread' })
    // The host binding actually ran (the reply round-tripped), not a timeout.
    expect(seen).toEqual([{ from: 'thread' }])
  }, 15_000)

  it('keeps the reply pump alive when a late reply targets a closed thread loop', async () => {
    // A binding called from a worker thread that ABANDONS the call (its
    // `asyncio.run` is cancelled) leaves the pending entry holding that thread's
    // loop, which `asyncio.run` closes on return. When the host later answers
    // that call, `_pump_replies` schedules the completion onto the closed loop —
    // `call_soon_threadsafe` raises `RuntimeError('Event loop is closed')`.
    // Unguarded, that RuntimeError ends the pump task and strands every later
    // reply; the guard drops the moot reply and keeps the pump serving.
    //
    // The ordering is a STRUCTURAL guarantee, not a timing window: the worker
    // closes its loop before the main coroutine signals `closed`; the host
    // answers the abandoned `slow` call (hitting the closed loop) before it
    // answers `release`, because `release`'s handler only resolves `slow` first
    // and then yields a microtask. So the pump provably meets the closed loop on
    // `slow`'s reply before it must deliver `release`'s. Fail-before: the pump
    // dies on `slow`, `release`'s reply is never read, and `await tools.release`
    // hangs to the (small) maxWallMs as a timeout.
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const { runtime } = await setup({ maxWallMs: 6_000 })
    const result = await runtime.run({
      program: [
        'import asyncio, threading',
        'closed = threading.Event()',
        'def worker():',
        '    async def body():',
        // Abandon the call: wait_for cancels it, but the pending host-side entry
        // survives (dispatch does not pop on cancellation), holding this loop.
        '        try:',
        '            await asyncio.wait_for(tools.slow({}), timeout=0.1)',
        '        except asyncio.TimeoutError:',
        '            pass',
        '    asyncio.run(body())',  // closes the thread's loop on return
        '    closed.set()',
        't = threading.Thread(target=worker)',
        't.start()',
        'while not closed.is_set():',
        '    await asyncio.sleep(0.02)',
        // The loop is closed. Now the host answers slow (dead-loop reply) then
        // release; the pump must survive the first to deliver the second.
        'after = await tools.release({})',
        'return after',
      ].join('\n'),
      bindings: tools({
        slow: async () => {
          // Answer only once the worker has closed its loop AND the main
          // coroutine is awaiting release, so this reply reaches the pump against
          // the closed loop.
          await slowGate
          return 'late'
        },
        release: async () => {
          // Let slow's reply be written first, then yield a microtask so the
          // pump processes the dead-loop reply before release's own reply lands.
          releaseSlow()
          await new Promise(resolve => setImmediate(resolve))
          return 'released'
        },
      }),
    })
    expect(result.error).toBeUndefined()
    // The pump survived the closed-loop reply and delivered the later binding.
    expect(result.value).toBe('released')
  }, 15_000)

  it('keeps the reply pump alive when RuntimeError is rebound before the program runs', async () => {
    // `_pump_replies` catches a closed-loop scheduling failure with `except
    // _RuntimeError`. If that name were bound as a pump BODY local, it would be
    // captured at pump-start — but `_run` reaches the model's top-level
    // statements (which run before the pump's first step, since there is no
    // suspension point between `create_task` and `await __dsh_main__`) with the
    // rebind already applied, so `_RuntimeError` would capture the REBOUND class
    // and the closed-loop `RuntimeError` would escape, killing the pump. Binding
    // it as a DEF-TIME default argument captures the original before any model
    // code runs. This rebinds `__main__.RuntimeError` as the very first program
    // statement and drives the closed-loop worker pattern: the pump must survive
    // the dead-loop reply and deliver the later binding.
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const { runtime } = await setup({ maxWallMs: 6_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        '__main__.RuntimeError = ValueError',
        'import asyncio, threading',
        'closed = threading.Event()',
        'def worker():',
        '    async def body():',
        '        try:',
        '            await asyncio.wait_for(tools.slow({}), timeout=0.1)',
        '        except asyncio.TimeoutError:',
        '            pass',
        '    asyncio.run(body())',
        '    closed.set()',
        't = threading.Thread(target=worker)',
        't.start()',
        'while not closed.is_set():',
        '    await asyncio.sleep(0.02)',
        'after = await tools.release({})',
        'return after',
      ].join('\n'),
      bindings: tools({
        slow: async () => { await slowGate; return 'late' },
        release: async () => { releaseSlow(); await new Promise(resolve => setImmediate(resolve)); return 'released' },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('released')
  }, 15_000)

  it('keeps a successful completion when _done_with_value is rebound', async () => {
    // `_run` calls `_done_with_value(value, max_value_bytes)` after the program
    // returns. The name is a module global, and this bootstrap IS `__main__`, so
    // `__main__._done_with_value = boom` as a program statement would otherwise
    // be resolved at call time and a legitimate success would be rewritten into
    // an `exception`. `_run` now binds `done_with_value_bound = _done_with_value`
    // before the program runs, so the entry name is immune; the run must still
    // report the success value.
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import __main__',
        'def boom(*a, **k):',
        '    raise RuntimeError("hijacked")',
        '__main__._done_with_value = boom',
        'return 1',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1)
  }, 15_000)

  it('round-trips an exactly representable large integer through a binding echo', async () => {
    // The reply serializer must print BigInt digits for a beyond-safe
    // integral double: String(2**60) emits a rounded form, and the child
    // would receive a DIFFERENT integer than the binding resolved.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'v = await tools.echo(2**60)',
        'return v == 2**60',
      ].join('\n'),
      bindings: tools({ echo: async args => args as never }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(true)
  })

  it('preserves an exactly representable large integer and rejects a rounding one', async () => {
    // The canonical boundary accepts every JS-double-exact value: 2**53 and
    // 2**60 round-trip exactly and must cross (matching the worker backend);
    // 2**53+1 rounds and must fail as invalid-output.
    const { runtime } = await setup()
    const exact = await runtime.run({ program: 'return [2**53, 2**60]', bindings: [] })
    expect(exact.error).toBeUndefined()
    expect(exact.value).toEqual([2 ** 53, 2 ** 60])
    const lossy = await runtime.run({ program: 'return 2**53 + 1', bindings: [] })
    expect(lossy.error?.kind).toBe('invalid-output')
    expect(lossy.error?.message).toContain('not exactly representable')
  })

  it('rejects a container subclass whose overridden methods hide its contents', async () => {
    // A dict subclass returning [] from items() passes an isinstance check but
    // serializes as {}, so the host would receive a value the program did not
    // compute. Exact-type matching fails it as invalid-output instead. The
    // worker backend rejects the prototype-equivalent shapes the same way.
    const { runtime } = await setup()
    const hidden = await runtime.run({
      program: [
        'class Sneaky(dict):',
        '    def items(self): return []',
        '    def keys(self): return []',
        '    def __iter__(self): return iter([])',
        '    def __len__(self): return 0',
        'return Sneaky(secret="kept")',
      ].join('\n'),
      bindings: [],
    })
    expect(hidden.error?.kind).toBe('invalid-output')
    expect(hidden.error?.message).toContain('unsupported type (Sneaky)')
    // A list subclass is refused on the same rule.
    const listish = await runtime.run({
      program: ['class L(list):', '    def __iter__(self): return iter([])', 'return L([1, 2, 3])'].join('\n'),
      bindings: [],
    })
    expect(listish.error?.kind).toBe('invalid-output')
    expect(listish.error?.message).toContain('unsupported type (L)')
    // The exact built-in containers still cross unchanged.
    const plain = await runtime.run({ program: 'return {"secret": [1, 2]}', bindings: [] })
    expect(plain.error).toBeUndefined()
    expect(plain.value).toEqual({ secret: [1, 2] })
  })

  it('rejects a scalar subclass whose overrides disagree with what gets serialized', async () => {
    // The validators checked scalars with isinstance, so a subclass passed
    // every check by its real value while the ENCODER read an override — the
    // host then received a value the walk never approved. Each case below is a
    // distinct override reaching a distinct reader.
    const { runtime } = await setup()
    // _dump_float spells a float from repr(value), so an overridden __repr__
    // decides the digits: F(2.5) serialized as 1.
    const floated = await runtime.run({
      program: [
        'class F(float):',
        '    def __repr__(self): return "1.0"',
        'return F(2.5)',
      ].join('\n'),
      bindings: [],
    })
    expect(floated.error?.kind).toBe('invalid-output')
    expect(floated.error?.message).toContain('unsupported type (F)')
    // The JS-safe-range bound is two comparisons, so overriding them admits an
    // int whose true digits (json.dumps reads the C-level value) the host's
    // JSON.parse rounds: 9007199254740993 arrives as ...992.
    const inted = await runtime.run({
      program: [
        'class I(int):',
        '    def __gt__(self, other): return False',
        '    def __lt__(self, other): return False',
        'return I(2 ** 53 + 1)',
      ].join('\n'),
      bindings: [],
    })
    expect(inted.error?.kind).toBe('invalid-output')
    expect(inted.error?.message).toContain('unsupported type (I)')
    // The pre-encode size bound reads len(), so overriding it to 0 admits a
    // string of any length past maxValueBytes.
    const stringed = await runtime.run({
      program: [
        'class S(str):',
        '    def __len__(self): return 0',
        'return S("Q" * 100000)',
      ].join('\n'),
      bindings: [],
    })
    expect(stringed.error?.kind).toBe('invalid-output')
    expect(stringed.error?.message).toContain('unsupported type (S)')
    // A str-subclass dict KEY reaches the same len() bound.
    const keyed = await runtime.run({
      program: [
        'class S(str):',
        '    def __len__(self): return 0',
        'return {S("Q" * 100000): 1}',
      ].join('\n'),
      bindings: [],
    })
    expect(keyed.error?.kind).toBe('invalid-output')
    expect(keyed.error?.message).toContain('non-string dict key (S)')
    // bool is an int subclass that IS lossless JSON, and the exact scalars all
    // still cross unchanged.
    const plain = await runtime.run({
      program: 'return {"t": True, "f": False, "n": None, "i": 7, "d": 2.5, "s": "ok"}',
      bindings: [],
    })
    expect(plain.error).toBeUndefined()
    expect(plain.value).toEqual({ t: true, f: false, n: null, i: 7, d: 2.5, s: 'ok' })
  })

  it('rejects a scalar subclass passed as a binding argument', async () => {
    // The uncapped binding-argument validator shares the exact-type rule, so
    // the call fails through its rejection contract instead of dispatching a
    // float whose digits come from an override.
    const { runtime } = await setup()
    const seen: CodeJsonValue[] = []
    const result = await runtime.run({
      program: [
        'class F(float):',
        '    def __repr__(self): return "1.0"',
        'try:',
        '    await tools.echo({"v": F(2.5)})',
        'except Exception as exc:',
        '    return str(exc)',
      ].join('\n'),
      bindings: tools({ echo: async (args) => {
        seen.push(args as CodeJsonValue)
        return null
      } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('unsupported type (F)')
    expect(seen).toEqual([])
  })

  it('rejects a container subclass passed as a binding argument', async () => {
    // Binding arguments run the uncapped validator, which must apply the same
    // exact-type rule: the call fails descriptively instead of dispatching a
    // value whose serialization disagrees with what was validated.
    const { runtime } = await setup()
    const seen: CodeJsonValue[] = []
    const result = await runtime.run({
      program: [
        'class Sneaky(dict):',
        '    def items(self): return []',
        'try:',
        '    await tools.echo(Sneaky(secret="kept"))',
        'except Exception as exc:',
        '    return str(exc)',
      ].join('\n'),
      bindings: tools({ echo: async (args) => {
        seen.push(args as CodeJsonValue)
        return null
      } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('unsupported type (Sneaky)')
    expect(seen).toEqual([])
  })

  it('fails an oversized completion as output-limit without materializing its encoding', async () => {
    // A 100 MiB string under maxValueBytes: 1024 must fail as output-limit.
    // The address-space cap leaves room for the program to BUILD the string
    // (one copy + interpreter) but not for the old full pre-check encode,
    // which materialized chunk fragments plus the joined copy (~2 more
    // copies) and died on RLIMIT_AS as MemoryError/worker-exit.
    const { runtime } = await setup({ maxValueBytes: 1024, addressSpaceMb: 384, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: 'return "x" * (100 * 1024 * 1024)',
      bindings: [],
    })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 1024 bytes')
  }, 20_000)

  it('rejects a control-heavy oversized completion on its length, not its escaped copy', async () => {
    // Every "\x00" escapes to the six bytes "\u0000", so the escaped form of a
    // 40 MB string is ~240 MB. The walk must refuse on the cheap
    // `len(current) + 2` lower bound; the 384 MiB address space holds the raw
    // string but not its escaped expansion, so a pre-escape check dies on
    // RLIMIT_AS instead of returning output-limit.
    const { runtime } = await setup({ maxValueBytes: 1024, addressSpaceMb: 384, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: 'return "\\x00" * (40 * 1024 * 1024)',
      bindings: [],
    })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 1024 bytes')
  }, 20_000)

  it('truncates a single print far above maxLogBytes instead of dying on the encode', async () => {
    // LogBuffer must reject via the cheap char-count lower bound BEFORE
    // UTF-8-encoding the whole string: the full encode of a ~100 MB line
    // would double the allocation and can breach RLIMIT_AS. 256 MiB
    // address space comfortably holds one copy of the 100 MB string but
    // not the pre-fix double allocation plus interpreter overhead spikes.
    const { runtime } = await setup({ maxLogBytes: 1024, addressSpaceMb: 256, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'print("x" * (100 * 1024 * 1024))',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
  }, 20_000)

  it('stops host capture at the child ledger truncation, keeping exactly one marker', async () => {
    // The two ledgers exhaust independently. One child entry larger than
    // `maxLogBytes` sends ONLY the marker, so the host budget is still nearly
    // untouched — and the marker used to arrive as an ordinary `log` frame the
    // host could not tell from program output. Text written afterwards was
    // therefore retained AFTER the marker, contradicting the stop-after-
    // truncation contract, and a later host-side exhaustion could append a
    // second marker. The frame now carries `truncated: true`.
    //
    // `os.write(1, ...)` bypasses the child's own stream, so those bytes reach
    // the host as stray stdout and take the host ledger path rather than the
    // child's — which is exactly the route that leaked past the marker.
    const { runtime } = await setup({ maxLogBytes: 64, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import os',
        'print("y" * 70000)',
        'os.write(1, b"AFTER")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    const markers = result.logs.filter(line => line.includes('log capture truncated'))
    expect(markers).toHaveLength(1)
    // The marker is the LAST entry: nothing was retained after truncation.
    expect(result.logs.at(-1)).toBe(markers[0])
    expect(result.logs.join('\n')).not.toContain('AFTER')
  }, 20_000)

  it('keeps one marker when a program forges repeated truncation frames', async () => {
    // `truncated` is attacker-reachable: the program owns fd 3 and can write the
    // flag itself, so the field is a hostile input rather than a trusted signal.
    // Repeats must collapse to the single marker the contract promises, and only
    // the literal `true` counts — a forged `"yes"` is rebuilt away by
    // validateChildFrame, so that frame stays ordinary text.
    const { runtime } = await setup({ maxLogBytes: 4096, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import os, json',
        'os.write(3, json.dumps({"type":"log","text":"first","truncated":"yes"}).encode() + b"\\n")',
        'os.write(3, json.dumps({"type":"log","text":"MARK-A","truncated":True}).encode() + b"\\n")',
        'os.write(3, json.dumps({"type":"log","text":"MARK-B","truncated":True}).encode() + b"\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    // The non-boolean flag did not truncate, so its text was captured normally.
    expect(result.logs).toContain('first')
    // The first genuine flag stopped capture and emitted the HOST's own marker;
    // the frame's own text is discarded, so neither payload appears.
    expect(result.logs).not.toContain('MARK-A')
    expect(result.logs).not.toContain('MARK-B')
    expect(result.logs.at(-1)).toBe(logTruncationMarker(4096))
    expect(result.logs.filter(line => line.includes('log capture truncated'))).toHaveLength(1)
  }, 20_000)

  it('discards the text of a forged truncation frame instead of retaining it', async () => {
    // The marker branch bypasses `admit`, so retaining the frame's own text put
    // attacker-controlled bytes into `logs` with no cap at all: measured, a 1 MiB
    // forged text was retained whole under `maxLogBytes: 64`, and the only bound
    // left was the 64 MiB frame parse cap. The host emits its own marker instead,
    // so the retained size is fixed regardless of what the program sent.
    const forgedBytes = 1024 * 1024
    const { runtime } = await setup({ maxLogBytes: 64, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'import os, json',
        `big = "A" * ${forgedBytes}`,
        'os.write(3, json.dumps({"type":"log","truncated":True,"text":big}).encode() + b"\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    // Only the host marker is kept, so the total stays orders of magnitude below
    // what the forgery carried — and below the cap it was trying to escape.
    expect(result.logs).toEqual([logTruncationMarker(64)])
    expect(result.logs.join('').length).toBeLessThan(forgedBytes / 1000)
  }, 30_000)

  it('coalesces unframed fd-3 fragments without recopying the sealed prefix', async () => {
    // The frame ceiling meters payload BYTES, but each retained chunk is its own
    // Buffer with object and backing-store overhead the byte count cannot see:
    // 5000 single-byte newline-free writes produced 5000 chunks holding 5031
    // bytes, so a program pacing such writes could accumulate millions of objects
    // inside the wall budget and exhaust the host heap far below 256 MiB.
    //
    // The observable behavior is that the run still completes normally: the
    // fragments are coalesced rather than rejected, since a slow trickle of bytes
    // is not itself a protocol violation.
    //
    // `Buffer.concat` is wrapped for the duration so the cumulative copy volume
    // is measured rather than inferred: that total is what separates sealing into
    // blocks from re-merging the whole buffer, and both shapes pass every
    // behavioral assertion below.
    //
    // The trickle is terminated with its own newline before the real frame is
    // written. Without that, those 5000 bytes prefix the frame on the SAME line,
    // which then parses as junk and is dropped — correct framing behavior, but it
    // would leave this test asserting the wrong thing.
    // Bound at capture: `Buffer.concat` is a static method, and taking a bare
    // reference to one trips no-unbound-method.
    const realConcat = Buffer.concat.bind(Buffer)
    let copied = 0
    Buffer.concat = (list: readonly Uint8Array[], total?: number): Buffer<ArrayBuffer> => {
      for (const part of list) copied += part.length
      return realConcat(list, total)
    }
    const program = [
      'import os',
      // Newline-free single-byte writes, spaced so each lands as its own read.
      // 60000 rather than 5000: the trickle has to cross the seal threshold
      // enough times for the two shapes to separate. At 5000 writes there are
      // only four seals, so even the quadratic form copies well under a
      // megabyte and the budget below could not tell them apart.
      'for _ in range(60000):',
      '    os.write(3, b"x")',
      '    os.sched_yield()',
      'os.write(3, b"\\n")',
      // A real frame after the trickle proves framing still works on the
      // coalesced residual.
      'print("after-trickle")',
      'return "done"',
    ].join('\n')
    let result: CodeRunResult
    try {
      const { runtime } = await setup({ maxWallMs: 30_000 })
      result = await runtime.run({ program, bindings: [] })
    } finally {
      Buffer.concat = realConcat
    }
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toContain('after-trickle')
    // Sealing appends a finished block rather than re-merging everything held, so
    // each byte is copied once. Re-concatenating the whole buffer at every
    // threshold made the cumulative copy volume quadratic — 10 MiB trickled a
    // byte at a time copies 53.7 GB that way. A per-byte-copied budget is the
    // discriminator, and it is measured rather than reasoned about: this shape
    // copies about 119 KB for 60000 trickled bytes, the re-merging shape about
    // 540 KB. 256 KiB sits between them with margin on both sides — most writes
    // are coalesced by the pipe before they reach us, so the observed ratio is
    // smaller than the asymptotic one, and the threshold has to sit where a real
    // measurement lands rather than where the asymptote suggests.
    expect(copied).toBeLessThan(256 * 1024)
  }, 40_000)

  it('seals trickled stray fragments into blocks without recopying the sealed prefix', async () => {
    // The stray-capture buffer has the same object-overhead exposure as the fd-3
    // reader above: each newline-free `data` chunk is its own Buffer, so a
    // program pacing single-byte `os.write(1, ...)` accumulates one object per
    // write, which the serialized-cost counter cannot see. Past MAX_PENDING_CHUNKS
    // the fragments seal into a finished block; re-merging the whole residual at
    // each threshold instead would copy the sealed prefix again and again, making
    // the cumulative copy volume quadratic. `Buffer.concat` is wrapped to measure
    // that volume — both shapes admit the same final log entry, so the copy total
    // is the discriminator. maxLogBytes is raised so the trickle is retained,
    // not truncated, which is what forces the fragments to accumulate and seal.
    const realConcat = Buffer.concat.bind(Buffer)
    let copied = 0
    Buffer.concat = (list: readonly Uint8Array[], total?: number): Buffer<ArrayBuffer> => {
      for (const part of list) copied += part.length
      return realConcat(list, total)
    }
    let result: CodeRunResult
    try {
      const { runtime } = await setup({ maxLogBytes: 200_000, maxWallMs: 30_000 })
      result = await runtime.run({
        program: [
          'import os',
          'for _ in range(60000):',
          '    os.write(1, b"x")',
          '    os.sched_yield()',
          'os.write(1, b"\\n")',
          'return "done"',
        ].join('\n'),
        bindings: [],
      })
    } finally {
      Buffer.concat = realConcat
    }
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    // The trickle coalesces into one log line (no interior newlines). Its exact
    // length depends on pipe coalescing, but it is one entry and non-empty.
    expect(result.logs.length).toBe(1)
    expect((result.logs[0] as string).length).toBeGreaterThan(0)
    // Sealing appends a finished block rather than re-merging everything held, so
    // each byte is copied a bounded number of times. Re-merging the whole
    // residual at every seal threshold instead makes the cumulative copy volume
    // quadratic. Measured like the fd-3 sibling above rather than reasoned about:
    // this sealed shape copies about 120 KB for 60000 trickled bytes, the
    // re-merging shape about 538 KB (the stray path adds one whole-residual
    // concat at the terminating newline over the fd-3 sibling's 119/540, landing
    // at the same order). 256 KiB sits between them with margin on both sides, so
    // reverting the seal to a re-merge turns this assertion red.
    expect(copied).toBeLessThan(256 * 1024)
  }, 40_000)

  it('caps a huge exception diagnostic child-side before it crosses the wire', async () => {
    // A program can raise with a multi-megabyte message; the child must cap
    // it at maxValueBytes before formatting/sending, not ship the whole
    // payload for the host to truncate after parsing.
    const { runtime } = await setup({ maxValueBytes: 1024 })
    const result = await runtime.run({
      program: 'raise ValueError("boom-" + "x" * (8 * 1024 * 1024))',
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('boom-')
    expect(result.error?.message.endsWith('… [truncated]')).toBe(true)
    expect(Buffer.byteLength(result.error?.message ?? '', 'utf8')).toBeLessThan(2048)
  })

  it('caps a control-heavy exception diagnostic by its serialized cost, not raw bytes', async () => {
    // The diagnostic crosses fd 3 inside a JSON frame where a control character
    // escapes sixfold (a NUL is one raw byte, six as `\u0000`). Capping by raw
    // UTF-8 length would let a NUL-heavy message near maxValueBytes serialize to
    // ~6x that and breach the frame ceiling — the silent worker-exit inversion
    // the load-time cap check exists to prevent. The child meters the diagnostic
    // by its serialized cost, so a NUL flood is truncated to fit the frame and
    // the run still reports the exception rather than a worker-exit.
    const { runtime } = await setup({ maxValueBytes: 4096 })
    const result = await runtime.run({
      // 512 KiB of NUL: ~3 MiB once escaped, far past the 4 KiB cap.
      program: 'raise ValueError("\\x00" * (512 * 1024))',
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message.endsWith('… [truncated]')).toBe(true)
    // The SERIALIZED form (what the frame carried) fits the budget, so its raw
    // length is well under it too — a raw-byte cap would have admitted ~4 KiB of
    // NULs that serialize to ~24 KiB.
    const serialized = JSON.stringify(result.error?.message ?? '')
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(4096 + 8)
  })

  it('bounds a newline-free partial-line flood while the program is still running', async () => {
    // print("x", end="") never completes a line, so nothing reaches the
    // Python LogBuffer until settlement — the buffered tail must still hit
    // the budget mid-run instead of growing without bound to RLIMIT/timeout.
    const { runtime } = await setup({ maxLogBytes: 1024, maxWallMs: 15_000 })
    const result = await runtime.run({
      program: [
        'for _ in range(100000):',
        '    print("xxxxxxxxxx", end="")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
    // The retained text is bounded by the budget, not the 1 MB the program wrote.
    expect(result.logs.join('\n').length).toBeLessThan(4096)
  }, 20_000)

  it('discards empty writes instead of buffering one list slot each', async () => {
    // An empty chunk adds no character, so the mid-run budget check (which
    // compares buffered CHARS against the remaining ledger) can never fire on
    // it. Buffering empty strings therefore grew `_pending` without bound —
    // millions of slots per CPU second — until RLIMIT_AS turned an append into
    // a MemoryError, long after the log ledger was exhausted. Two million
    // empty writes must instead settle normally and contribute NO log entry,
    // proving the chunk was dropped rather than joined at flush_line.
    const { runtime } = await setup({ maxLogBytes: 256, addressSpaceMb: 256, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'for _ in range(2000000):',
        '    sys.stdout.write("")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toEqual([])
  }, 30_000)

  it('stops scanning a single-write newline flood once the log ledger truncates', async () => {
    // One write carrying half a million newlines: the offset scan must exit the
    // instant LogBuffer truncates rather than re-slicing and pushing every
    // remaining line. If it kept scanning it would exhaust the CPU/wall budget;
    // the run instead settles quickly with exactly one truncation marker.
    const { runtime } = await setup({ maxLogBytes: 256, maxWallMs: 10_000 })
    const start = Date.now()
    const result = await runtime.run({
      program: ['print("x\\n" * 500000, end="")', 'return "done"'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.filter(line => line.includes('log capture truncated'))).toHaveLength(1)
    expect(Date.now() - start).toBeLessThan(8_000)
  }, 15_000)

  it('bounds an oversized newline-terminated write before joining and slicing it', async () => {
    // The newline branch slices the first line out of the write before
    // `LogBuffer.push` can apply its cheap budget rejection, so a single
    // over-budget write cost a full extra copy of itself in peak address space —
    // the amplification that bound exists to avoid, applied one layer too late.
    // Measured under a 400 MiB addressSpaceMb with the slice unbounded: writes
    // of 200 MiB and up died on MemoryError inside `sys.stdout.write`, reported
    // as the PROGRAM's own exception rather than the promised truncation marker.
    // `"\\n".rjust(n, "A")` is a single allocation ending in the newline, so the
    // payload itself fits and the only remaining allocation is the stream's own
    // slice; 340 MiB of a 400 MiB cap cannot survive one more copy of it.
    const { runtime } = await setup({ maxLogBytes: 256, addressSpaceMb: 400, maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'payload = "\\n".rjust(340 * 1024 * 1024, "A")',
        'sys.stdout.write(payload)',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toEqual([logTruncationMarker(256)])
  }, 40_000)

  it('bounds a newline-free write against the already-buffered chunks before joining them', async () => {
    // The newline-free arm buffers the write and then compared the buffered
    // CHARACTER COUNT against the ledger — correct — but paid for the comparison
    // with `"".join(self._pending)`, a second full copy of everything held. One
    // buffered character is enough to make that join a copy of the whole
    // following write. Measured under a 400 MiB addressSpaceMb with a 340 MiB
    // second write: the join raised MemoryError inside `sys.stdout.write`, and
    // because the oversized chunks stayed in `_pending` the settlement
    // `flush_line` raised it again — that throw sits after the `except
    // BaseException` block, so it costs the `done` frame and the run came back
    // `timeout: wall-clock ceiling reached (30000ms)` with no logs at all. The
    // bound must be applied BEFORE the join and the chunks dropped on that path,
    // so the run settles with the truncation marker it promises.
    const { runtime } = await setup({ maxLogBytes: 256, addressSpaceMb: 400, maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        // One unterminated character first, so `_pending` is non-empty and the
        // large write cannot take the "buffered text IS the write" shortcut.
        'sys.stdout.write("x")',
        'payload = "A" * (340 * 1024 * 1024)',
        'sys.stdout.write(payload)',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toEqual([logTruncationMarker(256)])
  }, 40_000)

  it('bounds a newline-terminated write against the already-buffered chunks before joining them', async () => {
    // Same allocation, reached through the newline arm: with chunks pending, the
    // whole write used to be appended and joined so the offset scan could run
    // over one string. Only the FIRST line needs those chunks, so a pending
    // chunk plus a 340 MiB newline-terminated write under a 400 MiB
    // addressSpaceMb died on MemoryError in the join before the per-line bound
    // could reject anything, and the retained chunks made the settlement flush
    // die the same way: measured, `timeout: wall-clock ceiling reached
    // (30000ms)`. The reconstructed first line is now checked against the ledger
    // and only a budget-sized prefix of it is copied; the rest of the write is
    // scanned in place.
    const { runtime } = await setup({ maxLogBytes: 256, addressSpaceMb: 400, maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'sys.stdout.write("x")',
        'payload = "\\n".rjust(340 * 1024 * 1024, "A")',
        'sys.stdout.write(payload)',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toEqual([logTruncationMarker(256)])
  }, 40_000)

  it('emits pending text on an explicit flush, before the run can be killed', async () => {
    // `_LogStream` inherits TextIOBase's no-op `flush()`, so an explicit
    // `print(..., flush=True)` or `sys.stdout.flush()` left the text in
    // `_pending` with nothing to drain it but `flush_line` after settlement — a
    // call a hanging or killed run never reaches. Measured: printing
    // "before hang" with flush=True ahead of an infinite loop returned
    // `logs: []`, losing the one diagnostic the program deliberately committed.
    const { runtime } = await setup({ maxWallMs: 4_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'print("before hang", end="", flush=True)',
        'while True: pass',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.logs).toContain('before hang')
  }, 15_000)

  it('marks a dropped tail when the ledger lands on exactly zero remaining', async () => {
    // One 100-character line costs 103 serialized bytes (quotes + separator),
    // consuming a 104-byte budget minus the 1-byte array-envelope reservation
    // (104 - 1 = 103) EXACTLY. Landing on zero never trips
    // LogBuffer's "cost > remaining" branch, so `_truncated` stays unset and the
    // stream's own `remaining > 0` guard silently discarded the unscanned tail —
    // the run reported a complete log while dropping text. The tail must be
    // pushed so the marker is emitted. (This surfaced only after empty writes
    // stopped being buffered: `print` issues a trailing `write("")` whose
    // buffered-empty path used to force the marker out incidentally.) A single
    // wide line is used rather than many narrow ones so the CHILD ledger is the
    // one that lands on zero: the host's identical ledger truncates first when
    // many small entries precede the long marker text. `["y"*100]` serializes to
    // exactly 104 bytes (103 payload + 1 envelope), so 104 is the smallest
    // budget that admits the entry.
    const { runtime } = await setup({ maxLogBytes: 104, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: ['print("y" * 100 + "\\n" + "z" * 10, end="")', 'return "done"'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toContain('y'.repeat(100))
    expect(result.logs.filter(line => line.includes('log capture truncated'))).toHaveLength(1)
    // The dropped tail is not retained, but its loss is now reported.
    expect(result.logs.some(line => line.includes('z'))).toBe(false)
  }, 15_000)

  it('keeps an admitted log within the serialized array envelope at the exact limit', async () => {
    // Each entry is charged its JSON-string cost plus one separator byte, and
    // the serialized outer logs array adds one more byte of envelope (two
    // brackets and n-1 commas). The ledgers reserve that byte, so a result that
    // exactly exhausts the ledger still serializes within the configured cap.
    // At the 64-byte floor (the smallest admissible maxLogBytes): ledger 63,
    // a 60-character line serializes as `"aaa...a"` (62 bytes) + 1 separator
    // = 63, exactly exhausting the ledger and serializing as `["aaa...a"]`
    // = 64 = the cap; a 61-character line costs 64 > 63 and truncates. The
    // marker rides envelope, so the serialized logs run to cap + marker.
    const { runtime } = await setup({ maxLogBytes: 64, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: ['print("a" * 60 + "\\n" + "b" * 61, end="")', 'return "done"'].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    // The 60-character line was admitted; the 61-character line was not (a
    // single 'b' would also match the marker's "bytes", so check for the line).
    expect(result.logs).toContain('a'.repeat(60))
    expect(result.logs.some(line => line.includes('b'.repeat(61)))).toBe(false)
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
  }, 15_000)

  it('rejects a log budget too small to serialize the truncation marker', async () => {
    // A maxLogBytes below 64 cannot serialize the truncation marker itself;
    // it is rejected at construction so a marker-only truncated run cannot
    // report more than the public cap. maxValueBytes keeps no floor beyond the
    // positive-integer requirement (a completion can be 1 byte).
    await expect(setup({ maxLogBytes: 63, maxWallMs: 10_000 })).rejects.toThrow(/must be at least 64/)
  }, 15_000)

  it('charges the JSON-escaped cost of control characters against the log ledger', async () => {
    // A NUL renders as \u0000 (6 bytes) in the serialized outer logs; the
    // ledger must charge that expansion, or a control-character flood admits
    // 6x the configured cap.
    const { runtime } = await setup({ maxLogBytes: 256 })
    const result = await runtime.run({
      program: [
        'for _ in range(500):',
        '    print("\\x00" * 10)',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
    // Serialized (escaped) size of retained entries stays in the budget's
    // neighborhood: well under the ~30 kB an uncharged flood would retain.
    const serialized = Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
    expect(serialized).toBeLessThan(1024)
  })

  it('charges the serialized cost child-side, so a control-heavy line truncates instead of being admitted whole', async () => {
    // The child's ledger must charge what the entry costs on the wire, not its
    // raw UTF-8 length: a NUL is one raw byte but six as its escape. A 24 MiB NUL
    // line clears the cheap char-count lower bound (24 MiB < 32 MiB budget), so
    // charging raw bytes would ADMIT it and emit a ~144 MiB escaped entry;
    // charging the serialized cost (~144 MiB > the 32 MiB budget) rejects it
    // before any encode and emits the marker instead. The address space (512 MiB,
    // clearing the 12x load gate for a 32 MiB budget) is sized so the run loads;
    // the gate separately guarantees a correctly-charged near-budget entry fits.
    const { runtime } = await setup({ maxLogBytes: 32 * 1024 * 1024, addressSpaceMb: 512, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'print("\\x00" * (24 * 1024 * 1024))',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.filter(line => line.includes('log capture truncated'))).toHaveLength(1)
    // Nothing of the line itself was retained: the ledger refused the whole entry.
    expect(result.logs.every(line => !line.includes(String.fromCharCode(0)))).toBe(true)
  }, 30_000)

  it('bounds a huge unterminated tail after an early newline without copying it whole', async () => {
    // The newline branch of _LogStream.write buffered the whole unterminated
    // tail after the last newline into `_pending` before the flush trigger could
    // bound it, so an early newline followed by a huge tail made a second full
    // copy of the model's own string — a MemoryError the config gate cannot
    // catch (the tail far exceeds maxLogBytes). The tail is now sliced to a
    // budget-sized prefix, so the run truncates and completes. Linux-only RLIMIT_AS
    // repro (Darwin skips the limit); on macOS this asserts the happy path.
    //
    // Sizing: the model builds `tail` (N) then the `"\n" + tail` write argument
    // (another ~N), so construction peaks at ~2N — kept under the 384 MiB address
    // space at N = 150 MiB (~300 MiB). The pre-fix code then buffered the whole
    // ~150 MiB tail again, pushing past 384 MiB; the sliced prefix does not.
    const { runtime } = await setup({ maxLogBytes: 256, addressSpaceMb: 384, maxWallMs: 20_000 })
    const result = await runtime.run({
      program: [
        'import sys',
        'tail = "A" * (150 * 1024 * 1024)',
        'sys.stdout.write("\\n" + tail)',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
  }, 30_000)

  it('flushes logs before framing the value so their peaks do not add against RLIMIT_AS', async () => {
    // The load gate bounds maxLogBytes and maxValueBytes INDEPENDENTLY against the
    // address space, each at the 12x worst case. But the child framed the
    // completion value (materializing its escaped form to meter it, then encoding
    // the frame) while a newline-free log tail still sat unflushed in _pending.
    // Those two peaks added: two budgets each admitted alone could together breach
    // RLIMIT_AS, dying as worker-exit instead of settling. The flush now runs
    // before the value is framed, so the log pending is freed first.
    //
    // Config: 32 MiB each against 512 MiB (each 32*12 = 384 MiB < 448 MiB
    // budgetable, so both load). The program writes ~33M astral chars with no
    // newline (buffered ~132 MB, under the char-count flush trigger) then returns
    // ~33M astral chars — a ~132 MB serialized value that is itself OVER the 32 MiB
    // maxValueBytes, so the correct outcome is `output-limit`. Pre-fix the
    // unflushed 132 MB plus the value's build-and-encode (~396 MB) exceeded 512 MiB
    // and OOM'd (reported as exception/worker-exit); flushing first lets the value
    // check complete (~460 MB alone) and report output-limit. On Darwin (no
    // RLIMIT_AS) the value is over budget too, so output-limit holds either way;
    // the OOM the reorder prevents is the Linux-only failure.
    const { runtime } = await setup({
      maxLogBytes: 32 * 1024 * 1024,
      maxValueBytes: 32 * 1024 * 1024,
      addressSpaceMb: 512,
      maxWallMs: 20_000,
    })
    const result = await runtime.run({
      program: [
        'import sys',
        'sys.stdout.write("\\U0001F600" * 33_000_000)',
        'return "\\U0001F600" * 33_000_000',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('output-limit')
  }, 30_000)

  it('checks and encodes a wide completion value in O(depth), not O(width)', async () => {
    // A wide flat list serializes to ~2 bytes per element but the pre-fix walk
    // enqueued one traversal tuple per element (_check_done_value) and one stack
    // entry plus a separator marker per element (_encode_json_plain) — ~56 bytes
    // per element, ~28x the serialized size. A value the byte meter admits could
    // therefore OOM on the checker's or encoder's own bookkeeping, the inversion
    // the load gate exists to prevent (the gate reserves 12x, not 28x). Both now
    // walk with an O(depth) cursor that pulls one child at a time, so the only
    // width-proportional allocation is the output string the meter bounded.
    //
    // Config: maxValueBytes 20 MiB against 384 MiB (20*12 = 240 MiB < 320 MiB
    // budgetable, so it loads). `[0] * 6_000_000` is ~12 MB of JSON, under the
    // 20 MiB budget, so it must round-trip. Pre-fix the ~400 MB of per-element
    // frames plus the interpreter exceeded 384 MiB and returned MemoryError as an
    // exception. Linux-only RLIMIT_AS repro; on macOS the value round-trips
    // either way, but the fixture stays within the address space so it is honest.
    //
    // `maxWallMs` is 60s, not the 20s the memory assertion alone needs: the O(depth)
    // cursor pulls 6M elements one at a time through Python-level frames, which costs
    // ~11s on an idle machine and more under the coverage lane's V8 instrumentation
    // with several workers sharing a box. This budget bounds the run without letting a
    // loaded runner's scheduling latency read as a `timeout` — what this test asserts
    // is the O(depth) memory shape, not a speed claim.
    const { runtime } = await setup({ maxValueBytes: 20 * 1024 * 1024, addressSpaceMb: 384, maxWallMs: 60_000 })
    const result = await runtime.run({ program: 'return [0] * 6_000_000', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.value)).toBe(true)
    expect((result.value as number[]).length).toBe(6_000_000)
  }, 90_000)

  it('validates wide binding arguments in O(depth), not O(width)', async () => {
    // The completion-value walks are budgeted; this one is not. `dispatch` runs
    // `_lossless_json_violation` on the arguments the MODEL built, and no
    // child-side byte budget bounds them first: the frame ceiling is the host's
    // and applies only after this validation returns. A per-member traversal
    // frame therefore turned a legitimate call into the program's own
    // MemoryError. Measured with tracemalloc on the two walk shapes over this
    // exact argument (JSON ~17 MB): the cursor peaks at 0.0 MiB of auxiliary
    // state, the pre-fix `stack.extend` at 459.1 MiB -- past the 384 MiB
    // configured below, so the discriminating failure is real. It is Linux-only:
    // Darwin skips RLIMIT_AS, so this case round-trips there either way.
    //
    // The binding echoes its argument's length back, so the assertion proves the
    // call actually round-tripped rather than merely avoiding a crash.
    const { runtime } = await setup({ addressSpaceMb: 384, maxWallMs: 60_000 })
    const result = await runtime.run({
      program: 'return await tools.width([0] * 6_000_000)',
      bindings: [{
        global: 'tools',
        functions: { width: async (items: unknown) => (items as number[]).length },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(6_000_000)
  }, 90_000)

  it('decodes a multi-megabyte binding reply without regex backtracking state', async () => {
    // The child parses every host reply with `_decode_json_plain`. Its scalar
    // regex matched strings with a `(?:[^"\\]|\\.)*` repetition, which makes
    // CPython's backtracking engine retain state proportional to the string's
    // WIDTH -- measured at ~146 MiB of engine state for a 1 MiB string and
    // ~558 MiB for 4 MiB. A legitimate multi-megabyte reply therefore raised
    // MemoryError inside `_pump_replies`; because that pump is the only settler
    // of the call's future, the run stranded until the wall clock reported a
    // `timeout` instead of returning the value the binding produced.
    //
    // Strings now scan chunk-to-chunk over a character class (no backtracking
    // state). Measured on this exact 4 MiB reply: the pre-fix regex peaks at
    // 557.8 MiB, past the default 512 MiB address space, while the scanner peaks
    // at the 4.0 MiB result itself. Linux-only, like the other RLIMIT_AS repros:
    // Darwin does not apply the limit, so the spike is merely allocated there.
    const reply = 'A'.repeat(4 * 1024 * 1024)
    const { runtime } = await setup({ maxWallMs: 60_000 })
    const result = await runtime.run({
      program: 'value = await tools.big({})\nreturn len(value)',
      bindings: [{ global: 'tools', functions: { big: async () => reply } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(reply.length)
  }, 90_000)

  it('drops a late binding resolution before snapshotting it', async () => {
    // `sendReply` checks `settled`, but only after the resolution has been walked
    // and copied by `snapshotJsonValue`. Binding resolution carries no seam-level
    // byte cap, so a binding that resolves a wide value AFTER the run already
    // settled (here on `maxWallMs`) spent host heap building a frame that is then
    // discarded. The check now runs before the snapshot.
    //
    // The binding resolves well after the 1s wall clock with a 2M-element array;
    // the run must still report `timeout`, and the late value must not appear.
    let resolvedLate = false
    const { runtime } = await setup({ maxWallMs: 1_000 })
    const result = await runtime.run({
      program: 'return await tools.slow({})',
      bindings: [{
        global: 'tools',
        functions: {
          slow: async () => {
            await new Promise(resolve => setTimeout(resolve, 2_500))
            resolvedLate = true
            return Array.from({ length: 2_000_000 }, () => 0)
          },
        },
      }],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.value).toBeUndefined()
    // Pin that the late path actually ran, so the assertion above is not vacuous.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    expect(resolvedLate).toBe(true)
  }, 90_000)

  it('paces concurrent binding replies instead of queueing every frame at once', async () => {
    // Binding resolution carries no seam-level byte cap. Before pacing, a program
    // resolving several large values in one `asyncio.gather` round encoded them
    // all in the same turn and queued every frame in fd 3's writable buffer,
    // which exhausted the host heap and killed the whole process rather than
    // failing the run. Replies are now encoded one at a time, waiting for
    // `drain` when the pipe is full.
    //
    // Eight concurrent 4 MiB replies (32 MiB of frames) must all round-trip. The
    // program sums the lengths, so the assertion proves every reply arrived and
    // was matched to its own call -- pacing must not drop or misroute any. What
    // this case cannot show is the peak itself, which lives in the stream's
    // buffer: measured directly on a 64 KiB-highWaterMark pipe with this same
    // 8x4 MiB shape, the unpaced writes buffered 32.0 MiB while the paced ones
    // peaked at 0.0 MiB.
    const chunk = 'A'.repeat(4 * 1024 * 1024)
    const { runtime } = await setup({ maxWallMs: 60_000 })
    const result = await runtime.run({
      program: [
        'import asyncio',
        'parts = await asyncio.gather(*[tools.chunk({}) for _ in range(8)])',
        'return sum(len(p) for p in parts)',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { chunk: async () => chunk } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(8 * chunk.length)
  }, 90_000)

  it('drops queued binding replies when the child dies mid-drain, without hanging', async () => {
    // drainReplies waits for `drain` when fd 3's buffer is full. If the child
    // exits while a reply is queued, the pipe never emits `drain` again — the
    // wait must also settle on `close`/`error`/destroyed, or `draining` stays
    // true and the queue is pinned with the closure forever. The program fills
    // the pipe with a wide binding reply and then exits without reading it, so
    // the host is blocked mid-drain when the child dies; the run must still
    // settle promptly (worker-exit from the close) rather than hanging on the
    // drain wait.
    const chunk = 'A'.repeat(4 * 1024 * 1024)
    const { runtime } = await setup({ maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'import asyncio',
        // Resolve a reply big enough to backpressure fd 3, then exit without
        // reading it: the child's `close` lands while the host still waits for
        // `drain`, exercising the destroyed-pipe branch of the reply drain.
        'pending = asyncio.create_task(tools.chunk({}))',
        'await asyncio.sleep(0.05)',
        'return "done"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { chunk: async () => chunk } }],
    })
    // The program returned, so the completion wins over the mid-flight reply;
    // whatever the result, the run must settle (no hang on the drain wait).
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
  }, 30_000)

  it('caps the pending reply backlog when a child floods calls without reading its replies', async () => {
    // drainReplies writes one reply at a time and waits for `drain` when fd 3's
    // buffer is full. A child that never reads its replies (it only writes
    // call frames, never draining the reply side) leaves the pipe full, so
    // every call frame it keeps sending resolves a binding and adds a reply the
    // drain cannot write: without a bound, the backlog grows until the wall
    // clock, pinning each binding result in host memory. The cap settles the
    // run as worker-exit instead, mirroring the frame cap's treatment of an
    // oversized frame. The child floods 5000 sequential valid calls and never
    // reads fd 3 (its reply pump is starved by the synchronous write loop and
    // the blocking sleep); the pipe buffer absorbs ~1600 tiny replies, so the
    // pending backlog crosses MAX_PENDING_REPLIES long before maxWallMs, and
    // the run must settle worker-exit with the reply-queue message, not a
    // wall-clock timeout.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import os, time',
        'frame = b\'{"type":"call","id":%d,"global":"tools","name":"echo","args":{}}\\n\'',
        'for i in range(5000):',
        '    view = memoryview(frame % i)',
        '    while view:',
        '        view = view[os.write(3, view):]',
        // Keep the child alive without reading fd 3: the run must settle via
        // the reply-backlog cap, not by the child finishing or exiting.
        'time.sleep(30)',
        'return "unreachable"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { echo: async (args: unknown) => args as CodeJsonValue } }],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('reply queue exceeded')
  }, 30_000)

  it('caps the outstanding binding-call backlog when a child floods calls against a binding that never settles', async () => {
    // The reply backlog cap only counts RESOLVED calls (`pendingReplies` grows
    // after the await), so a child flooding calls against a binding whose
    // promise never settles would accumulate one async closure per frame until
    // the wall clock without tripping it. The outstanding-call counter bounds
    // the in-flight closures to MAX_PENDING_REPLIES and settles the run as
    // worker-exit, mirroring the reply cap. The binding below never resolves,
    // so no reply is ever produced; the flood of 5000 sequential calls must
    // cross the in-flight bound long before maxWallMs.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import os, time',
        'frame = b\'{"type":"call","id":%d,"global":"tools","name":"hang","args":{}}\\n\'',
        'for i in range(5000):',
        '    view = memoryview(frame % i)',
        '    while view:',
        '        view = view[os.write(3, view):]',
        'time.sleep(30)',
        'return "unreachable"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { hang: async () => await new Promise<never>(() => {}) } }],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('call backlog exceeded')
  }, 30_000)

  it('runs a legitimate gather of more than 1024 concurrent binding calls', async () => {
    // The in-flight call cap must not count a synchronous batch of instant
    // calls: the async bodies' finallys run on the microtask queue, which
    // drains only between 'data' events, so a per-frame check would trip on
    // the 1025th frame of a single event even though every binding settled
    // immediately — killing a valid large concurrent gather as worker-exit.
    // The cap is checked at event boundaries (after the microtask queue
    // drained), so this gather of 1025 instant calls completes.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import asyncio',
        'return len(await asyncio.gather(*[tools.echo(i) for i in range(1025)]))',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { echo: async (args: unknown) => args as CodeJsonValue } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1025)
  }, 30_000)

  it('completes normally when a program returns with binding calls still outstanding', async () => {
    // The in-flight call cap refuses to admit NEW calls past the bound; it must
    // not reclassify a `done` frame as worker-exit just because the program
    // returned with calls it started but never awaited. The child schedules
    // exactly 1024 slow bindings (still pending when the program returns), so
    // the done frame arrives with the outstanding count AT the cap — the event
    // must complete with its value, not settle as `call backlog exceeded`.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import asyncio',
        'for i in range(1024):',
        '    asyncio.create_task(tools.slow(i))',
        'await asyncio.sleep(0.2)',
        'return "done"',
      ].join('\n'),
      bindings: [{
        global: 'tools',
        functions: { slow: async () => { await new Promise((resolve) => { setTimeout(resolve, 5_000) }); return 1 } },
      }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
  }, 30_000)

  it('settles a single-batch never-settling flood as worker-exit without further frames', async () => {
    // The outstanding-call cap must take effect even when the whole flood fits
    // in ONE data event: a per-event admission snapshot never re-checks once no
    // further frames arrive, so a single 62 KiB write of 1025 compact calls
    // against a never-settling binding would otherwise wait out the full wall
    // clock instead of tripping the cap. The post-macrotask check runs after
    // the batch's finallys (which never run for this binding) and settles the
    // run as worker-exit long before maxWallMs.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import os, time',
        'frame = b\'{"type":"call","id":%d,"global":"tools","name":"hang","args":{}}\\n\'',
        'payload = b"".join(frame % i for i in range(1025))',
        'view = memoryview(payload)',
        'while view:',
        '    view = view[os.write(3, view):]',
        'time.sleep(30)',
        'return "unreachable"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { hang: async () => await new Promise<never>(() => {}) } }],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('call backlog exceeded')
  }, 30_000)

  it('runs a burst of 1300 instant calls whose frames split across pipe reads', async () => {
    // Flowing mode can fire several 'data' events within one macrotask, before
    // any microtask drains, so a per-event snapshot of the outstanding count
    // could see the first chunk's in-flight calls in the second chunk's check
    // and false-positive on a legitimate burst. The post-macrotask check always
    // sees the true count (all finallys have run), so this burst of compact
    // frames — sized so the pipe read splits it — completes with all results.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import asyncio',
        'return len(await asyncio.gather(*[t.e(i) for i in range(1300)]))',
      ].join('\n'),
      bindings: [{ global: 't', functions: { e: async (args: unknown) => args as CodeJsonValue } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(1300)
  }, 30_000)

  it('settles as worker-exit when a done frame lands in the same batch as a call flood', async () => {
    // A done frame processed in the SAME data event as more than 1024 call
    // frames settles the run before the post-macrotask check runs (which no-ops
    // once settled), so a child could finish "successfully" while leaving the
    // outstanding closures behind — one sub-64 KiB write carries 1025 compact
    // calls plus a done. The done handler re-checks the count before accepting
    // the frame, so the run settles as worker-exit with the call-backlog
    // message instead.
    const { runtime } = await setup({ maxWallMs: 30_000 })
    const result = await runtime.run({
      program: [
        'import os, time',
        'frame = b\'{"type":"call","id":%d,"global":"tools","name":"hang","args":{}}\\n\'',
        'payload = b"".join(frame % i for i in range(1025)) + b\'{"type":"done","value":1}\\n\'',
        'view = memoryview(payload)',
        'while view:',
        '    view = view[os.write(3, view):]',
        'time.sleep(30)',
        'return "unreachable"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { hang: async () => await new Promise<never>(() => {}) } }],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('call backlog exceeded')
  }, 30_000)

  it('rejects a completion whose dict keys fold to one JSON member', async () => {
    // `_dump_string` folds a spelled-out surrogate pair into its astral code
    // point, so `"\ud83d\ude00"` and `"\U0001f600"` are DIFFERENT Python keys
    // that encode to the SAME JSON member — the host's JSON.parse would
    // silently drop one of them, violating the lossless-JSON completion
    // contract. The child's meter rejects the collision before encoding.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return {"\\ud83d\\ude00": 1, "\\U0001f600": 2}',
      bindings: [],
    })
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.error?.message).toContain('duplicate dict key')
  }, 30_000)

  it('rejects binding arguments whose dict keys fold to one JSON member', async () => {
    // The same collision on the binding-argument path: the call is rejected as
    // not lossless JSON, so the program's `await` raises and the program
    // surfaces the rejection message.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'try:',
        '    await tools.echo({"\\ud83d\\ude00": 1, "\\U0001f600": 2})',
        '    return "no-error"',
        'except Exception as e:',
        '    return str(e)',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { echo: async (args: unknown) => args as CodeJsonValue } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('duplicate dict key')
  }, 30_000)

  it('compacts the reply queue mid-drain without dropping pending frames', async () => {
    // A reply larger than the writable high-water mark makes the FIRST write
    // return false, suspending the drain loop; the frames queued behind it
    // push the drain's consumed head past MAX_PENDING_REPLIES, so the resumed
    // drain compacts the queue mid-run. The child reads fd 3 itself (blocking
    // the asyncio pump, so its reads cannot race the host's pushes) and sends
    // a second wave of calls AFTER reading part of the first wave's replies —
    // those replies are still pending when the drain's head crosses the
    // compaction bound, so a compaction that dropped pending frames would
    // leave the child's reply count short and the read loop spinning to the
    // wall clock. No fixed sleep: the child's reads pace at the drain's
    // delivery rate (each write blocks until the child reads), and the host
    // finishes pushing all of a wave within milliseconds — orders of magnitude
    // before the head crosses the bound — so the queue is always full at the
    // splice. Newlines are counted per chunk (each reply carries exactly one),
    // never by re-scanning the accumulated total, which would be O(n²).
    const { runtime } = await setup({ maxWallMs: 60_000 })
    const result = await runtime.run({
      program: [
        'import os',
        'frame = b\'{"type":"call","id":%d,"global":"tools","name":"big","args":{}}\\n\'',
        'for i in range(1024):',
        '    view = memoryview(frame % i)',
        '    while view:',
        '        view = view[os.write(3, view):]',
        'seen = 0',
        'while seen < 500:',
        '    chunk = os.read(3, 65536)',
        '    if not chunk:',
        '        break',
        '    seen += chunk.count(b"\\n")',
        'for i in range(500):',
        '    view = memoryview(frame % (1024 + i))',
        '    while view:',
        '        view = view[os.write(3, view):]',
        'while seen < 1524:',
        '    chunk = os.read(3, 65536)',
        '    if not chunk:',
        '        break',
        '    seen += chunk.count(b"\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: { big: async () => 'x'.repeat(65 * 1024) } }],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
  }, 60_000)

  it('bounds a flood of zero-byte log lines through the per-entry separator charge', async () => {
    // Blank print() lines carry zero content bytes; without the +1 separator
    // charge they would bypass maxLogBytes entirely and grow the retained
    // array without bound. Each empty entry costs one byte, so a 64-byte
    // budget retains at most 64 entries before the marker.
    const { runtime } = await setup({ maxLogBytes: 64, maxWallMs: 10_000 })
    const result = await runtime.run({
      program: [
        'for _ in range(10000):',
        '    print()',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.length).toBeLessThanOrEqual(65)
    expect(result.logs.some(line => line.includes('log capture truncated'))).toBe(true)
  })

  it('reassembles multibyte UTF-8 split across stray-output pipe chunks', async () => {
    // A single os.write far past the 64 KiB pipe buffer forces multiple
    // 'data' chunks; when the boundary lands inside a multibyte sequence,
    // per-chunk decoding would corrupt it into replacement characters. Raw bytes
    // are buffered and only decoded once a complete line (or the whole tail at
    // flush) is assembled, so the split sequence is whole by the time it is
    // decoded. The payload spans every valid multibyte lead class so
    // accrueStrayCost's per-lead continuation ranges are all exercised: U+0900
    // (E0 A4 80, the range-restricted E0 lead), U+4F60 and U+597D (E4/E5, plain
    // 3-byte), U+1F600 (F0, the range-restricted F0 lead), and U+10FFFF (F4 8F
    // BF BF, the range-restricted F4 lead).
    const { runtime } = await setup({ maxLogBytes: 1024 * 1024 })
    const result = await runtime.run({
      program: [
        'import os',
        // os.write is one syscall and returns a partial count on a full
        // pipe, so loop until the whole payload (odd prefix -> a chunk
        // boundary lands inside a multibyte sequence) is out.
        String.raw`payload = b"a" * 65535 + "\u0900\u4f60\u597d\U0001f600\U0010ffff".encode("utf-8")`,
        'view = memoryview(payload)',
        'while view:',
        '    view = view[os.write(1, view):]',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    const text = result.logs.join('')
    expect(text).toContain('\u0900\u4f60\u597d\u{1f600}\u{10ffff}')
    expect(text).not.toContain('\ufffd')
  })

  it('flushes a stray-output byte sequence left incomplete when the pipe ends', async () => {
    // The child writes the first two bytes of a 3-byte UTF-8 character to fd 1
    // and exits, so the pipe closes with the sequence unfinished in the raw
    // residual. The 'end' flush decodes the residual with `toString('utf8')`,
    // which renders the stranded bytes as U+FFFD instead of dropping them.
    const { runtime } = await setup({ maxLogBytes: 1024 * 1024 })
    const result = await runtime.run({
      program: [
        'import os',
        // b"\xe4\xbd" is the leading two bytes of U+4F60; no continuation byte
        // follows before exit.
        String.raw`os.write(1, b"\xe4\xbd")`,
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.join('')).toContain('�')
  })

  it('rejects reserved words of EITHER backend language as binding globals', async () => {
    // The seam's portable contract: `lambda` (Python keyword, legal JS name)
    // and `typeof` (JS keyword, legal Python name) are both refused, so a
    // namespace list valid on one backend is valid on every backend.
    const { runtime } = await setup()
    for (const global of ['lambda', 'typeof']) {
      await expect(runtime.run({
        program: 'return 1',
        bindings: [{ global, functions: {} }],
      })).rejects.toThrow(/is not a usable Python identifier/)
    }
  })

  it('captures stray stdout bytes the child writes bypassing sys.stdout', async () => {
    // Model code that writes to fd 1 via os.write() bypasses the Python-side
    // LogBuffer, so the host's stray-byte capture on child.stdout is what
    // records it.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(1, b"stray stdout\\n")',
        'os.write(2, b"stray stderr\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs.join('')).toContain('stray stdout')
    expect(result.logs.join('')).toContain('stray stderr')
  })

  it('flushes bytes written through sys.__stdout__/sys.__stderr__ before the done frame', async () => {
    // The bootstrap only replaces sys.stdout/sys.stderr with the _LogStream;
    // sys.__stdout__/sys.__stderr__ are the original block-buffered wrappers
    // over fd 1/2. A program that writes through them without an explicit flush
    // would lose those bytes when the host SIGTERMs the child right after the
    // done frame (the default SIGTERM disposition terminates without
    // interpreter finalization). The settlement flush now drains the original
    // std streams before sending the done frame, so the bytes land in the
    // kernel pipe buffer and the host's stray capture records them.
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'import sys',
        // `-u` makes the streams write-through; re-enable block buffering so
        // the bytes sit in the wrapper until the SETTLEMENT drain flushes them
        // — the drain path, not the -u immediate write, is what this case pins.
        'if hasattr(sys.__stdout__, "reconfigure"):',
        '    sys.__stdout__.reconfigure(write_through=False)',
        '    sys.__stderr__.reconfigure(write_through=False)',
        'sys.__stdout__.write("orig stdout\\n")',
        'sys.__stderr__.write("orig stderr\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs.join('')).toContain('orig stdout')
    expect(result.logs.join('')).toContain('orig stderr')
  }, 15_000)

  it('escalates to SIGKILL when the program traps SIGTERM and ignores the grace period', async () => {
    // A program that traps SIGTERM should still die: the kill() escalation
    // fires SIGKILL after graceMs. The full run reports either timeout (wall)
    // or worker-exit depending on which finish reason wins the race.
    const { runtime } = await setup({ maxWallMs: 400, graceMs: 200 })
    const result = await runtime.run({
      program: [
        'import signal, time',
        'signal.signal(signal.SIGTERM, lambda *a: None)',
        'while True: time.sleep(1)',
      ].join('\n'),
      bindings: [],
    })
    expect(['timeout', 'worker-exit']).toContain(result.error?.kind)
  }, 6000)

  it('bounds the fd-3 receive buffer against a newline-free flood', async () => {
    // A program looping os.write(3, ...) with no newline would grow the host
    // accumulator unbounded (the child's RLIMIT_AS does not cover the host
    // string). The frame cap is a fixed 64 MiB memory-safety invariant —
    // deliberately NOT derived from maxValueBytes, because legitimate binding
    // call frames may be large. We flood slightly past it in 8 MiB writes so
    // the test terminates promptly once the guard trips.
    const ceiling = 64 * 1024 * 1024
    const { runtime } = await setup({ maxWallMs: 60_000, addressSpaceMb: 2048 })
    const start = Date.now()
    const result = await runtime.run({
      program: [
        'import os',
        `for _ in range(${Math.ceil((ceiling * 1.1) / (8 * 1024 * 1024))}):`,
        '    os.write(3, b"A" * (8 * 1024 * 1024))',
        'return "never"',
      ].join('\n'),
      bindings: [],
    })
    const elapsed = Date.now() - start
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain(`protocol frame exceeded ${ceiling} bytes`)
    // The breach ends the run before the wall ceiling (the run did not idle
    // out); absolute pipe throughput varies too much under parallel suites
    // for a tight bound.
    expect(elapsed).toBeLessThan(30_000)
  }, 45_000)

  it('fails a forged oversized done value host-side as output-limit', async () => {
    // The Python-side _done_with_value check is bypassable by writing a done
    // frame straight to fd 3. The host re-enforces maxValueBytes; the seam
    // forbids substituting a truncated value, so the run FAILS as output-limit
    // instead of returning a lie.
    const maxValueBytes = 64
    const { runtime } = await setup({ maxValueBytes })
    const result = await runtime.run({
      program: [
        'import os, json',
        'big = "B" * 5000',
        'os.write(3, json.dumps({"type":"done","value":big}).encode() + b"\\n")',
        // The real done never sends; the forged one settles the run.
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('exceeded 64 bytes')
  }, 8000)

  it('drops a forged oversized log frame on its code-unit lower bound, before escaping it', async () => {
    // A forged `log` frame carrying a control-heavy string: NULs escape
    // several-fold (one NUL -> six bytes `\u0000`). The raw frame stays under
    // the host's 64 MiB parse cap (4 MiB of `\u0000` text = 24 MiB raw) while
    // the escaped form would be ~24 MiB. Charging it required building that
    // escaped copy first, so a 32-byte maxLogBytes could still force a large
    // host allocation. The cheap `length + 3` lower bound truncates it instead.
    // The host's own heap is what is under test, so keep the child's address
    // space generous enough to BUILD the frame.
    const { runtime } = await setup({ maxLogBytes: 128, addressSpaceMb: 1024, maxWallMs: 60_000 })
    const before = process.memoryUsage().heapUsed
    const result = await runtime.run({
      program: [
        'import os',
        // Written as a raw frame so the child's own ledger never sees it.
        'os.write(3, b\'{"type":"log","text":"\' + b"\\\\u0000" * (4 * 1024 * 1024) + b\'"}\\n\')',
        'return "settled"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('settled')
    // The frame was dropped as one truncation marker, not retained.
    expect(result.logs).toEqual([logTruncationMarker(128)])
    // The escaped copy (~144 MiB) was never materialized.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
  }, 90_000)

  it('charges a forged log frame its escaped cost once past the code-unit lower bound', async () => {
    // The cheap lower bound only rejects what cannot possibly fit; a SHORT
    // control-heavy frame clears it and must still be charged what it costs on
    // the wire. Eleven NULs are 14 against the 64-byte ledger's cheap bound
    // (six bytes each, two quotes, one separator), so the full charge truncates.
    const { runtime } = await setup({ maxLogBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(3, b\'{"type":"log","text":"\' + b"\\\\u0000" * 11 + b\'"}\\n\')',
        'return "settled"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('settled')
    expect(result.logs).toEqual([logTruncationMarker(64)])
  }, 8000)

  it('caps a forged done error.message from its code-unit prefix, never encoding the whole message', async () => {
    // `Buffer.from(message)` on a message near the frame ceiling allocates a
    // full UTF-8 copy before maxValueBytes applies. Only the first
    // maxValueBytes code units can fit the cap, so only that prefix is encoded
    // — at most 3x the cap in bytes. The message here is 48 MiB of ASCII: its
    // full encode would be another 48 MiB in the host.
    const maxValueBytes = 64
    const { runtime } = await setup({ maxValueBytes, addressSpaceMb: 1024, maxWallMs: 60_000 })
    const before = process.memoryUsage().heapUsed
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(3, b\'{"type":"done","error":{"kind":"exception","message":"\' + b"E" * (48 * 1024 * 1024) + b\'"}}\\n\')',
        'import time',
        'time.sleep(30)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    const message = result.error?.message ?? ''
    // The marker's 15 bytes come OUT of the 64-byte cap, so 49 E's precede it
    // and the whole string is exactly 64 bytes — not 64 plus the marker.
    expect(message).toBe(`${'E'.repeat(maxValueBytes - 15)}… [truncated]`)
    expect(Buffer.byteLength(message, 'utf8')).toBe(maxValueBytes)
    // JSON.parse already holds the 48 MiB string; the cap must not add a
    // second full-length copy on top of it.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
  }, 90_000)

  it('keeps a capped diagnostic within maxValueBytes, marker included', async () => {
    // The marker is part of the emitted diagnostic, so its bytes are reserved
    // from the cap rather than appended past it — the host meters this same
    // field downstream. Checked on BOTH producers: the child's own _cap_message
    // (a raised exception) and the host's capMessage (a forged done frame).
    const maxValueBytes = 40
    const { runtime } = await setup({ maxValueBytes })
    const raised = await runtime.run({
      program: 'raise ValueError("R" * 100000)',
      bindings: [],
    })
    expect(raised.error?.kind).toBe('exception')
    const raisedMessage = raised.error?.message ?? ''
    expect(raisedMessage.endsWith('… [truncated]')).toBe(true)
    expect(Buffer.byteLength(raisedMessage, 'utf8')).toBeLessThanOrEqual(maxValueBytes)
    const forged = await runtime.run({
      program: [
        'import os, json',
        'msg = "F" * 100000',
        'os.write(3, json.dumps({"type":"done","error":{"kind":"exception","message":msg}}).encode() + b"\\n")',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(forged.error?.kind).toBe('exception')
    const forgedMessage = forged.error?.message ?? ''
    expect(forgedMessage.endsWith('… [truncated]')).toBe(true)
    expect(Buffer.byteLength(forgedMessage, 'utf8')).toBe(maxValueBytes)
  }, 15_000)

  it('emits the marker alone when the cap is smaller than the marker itself', async () => {
    // With maxValueBytes below the marker's own 15 bytes there is no room for
    // message text; the marker still goes out, so the truncation stays reported
    // instead of the diagnostic silently becoming empty. Both producers agree.
    const { runtime } = await setup({ maxValueBytes: 4 })
    const raised = await runtime.run({ program: 'raise ValueError("R" * 500)', bindings: [] })
    expect(raised.error?.kind).toBe('exception')
    expect(raised.error?.message).toBe('… [truncated]')
    const forged = await runtime.run({
      program: [
        'import os, json',
        'os.write(3, json.dumps({"type":"done","error":{"kind":"exception","message":"F" * 500}}).encode() + b"\\n")',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(forged.error?.kind).toBe('exception')
    expect(forged.error?.message).toBe('… [truncated]')
  }, 15_000)

  it('caps a forged done error.message without splitting a surrogate pair', async () => {
    // At exactly maxValueBytes code units the prefix can end on a high
    // surrogate whose low half sits just outside it. `Buffer.from` encodes that
    // orphan as U+FFFD — the same corruption a mid-sequence byte cut causes —
    // and those three replacement bytes sit past the marker-reserved budget, so
    // the byte trim-back drops them.
    const maxValueBytes = 32
    const { runtime } = await setup({ maxValueBytes })
    const result = await runtime.run({
      program: [
        'import os, json',
        // 32 ASCII chars then astral characters: code unit 32 is the first
        // character's high surrogate (Python spells it as one code point, so
        // json.dumps emits the raw 4 bytes the host reads back as a pair).
        'msg = "A" * 32 + "\\U0001f600" * 4',
        'os.write(3, json.dumps({"type":"done","error":{"kind":"exception","message":msg}}).encode() + b"\\n")',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    // 17 A's fill the marker-reserved budget; no orphaned half, no U+FFFD.
    expect(result.error?.message).toBe(`${'A'.repeat(17)}… [truncated]`)
    expect(Buffer.byteLength(result.error?.message ?? '', 'utf8')).toBe(maxValueBytes)
  }, 8000)

  it('returns a diagnostic under a third of the cap untouched, skipping the encode', async () => {
    // Under maxValueBytes/3 code units a message cannot overflow the cap
    // whatever it holds (3 bytes is the per-code-unit maximum), so the fast
    // path returns it without encoding anything. Non-ASCII proves the bound is
    // the code-unit count, not a byte assumption: 6 characters at 3 bytes each
    // is 18 bytes, inside the 64-byte cap.
    const { runtime } = await setup({ maxValueBytes: 64 })
    const result = await runtime.run({
      program: [
        'import os, json',
        'os.write(3, json.dumps({"type":"done","error":{"kind":"exception","message":"中文中文中文"}}).encode() + b"\\n")',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toBe('中文中文中文')
  }, 8000)

  it('re-caps a forged done error.message host-side on a UTF-8 boundary', async () => {
    // A forged done frame can carry an arbitrarily long error message; the
    // host caps it to maxValueBytes and appends the shared marker. The
    // message is emoji-dense and the cap is chosen so the marker-reserved
    // 51-byte cut lands INSIDE a 4-byte sequence (one ASCII byte then 4-byte
    // runs, so only a cut at 1 + 4k is aligned) — the cap must trim back to a
    // code-point boundary rather than decode a replacement character, which
    // would also exceed the cap.
    const maxValueBytes = 66
    const { runtime } = await setup({ maxValueBytes })
    const result = await runtime.run({
      program: [
        'import os, json',
        'msg = "E" + "\\U0001f600" * 2000',
        'os.write(3, json.dumps({"type":"done","error":{"kind":"exception","message":msg}}).encode() + b"\\n")',
        'import time',
        'time.sleep(5)',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    const message = result.error?.message ?? ''
    expect(message.endsWith('… [truncated]')).toBe(true)
    const marker = '… [truncated]'
    const body = message.slice(0, message.length - marker.length)
    // The WHOLE message, marker included, honors the cap.
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(maxValueBytes)
    // 'E' plus 12 emoji is 49 bytes: the trim-back walked the 51-byte budget
    // down past two continuation bytes rather than splitting the 13th.
    expect(body).toBe(`E${'\u{1f600}'.repeat(12)}`)
    // The cut landed on a code-point boundary — no replacement character.
    expect(body).not.toContain('\ufffd')
  }, 8000)

  it('bounds a single oversized newline-terminated line on fd 3', async () => {
    // The same cap applies to one giant framed line. Write EXACTLY the
    // cap with no newline — at the limit, not past it, so nothing trips —
    // then a small newline tail, which is the chunk that crosses.
    const ceiling = 64 * 1024 * 1024
    const { runtime } = await setup({ maxWallMs: 60_000, addressSpaceMb: 2048 })
    const result = await runtime.run({
      program: [
        'import os',
        'chunk = b"A" * (8 * 1024 * 1024)',
        `for _ in range(${ceiling / (8 * 1024 * 1024)}):`,
        '    os.write(3, chunk)',
        'os.write(3, b"AAAA\\n")',
        'return "never"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain(`protocol frame exceeded ${ceiling} bytes`)
  }, 90_000)

  it('rejects an over-cap newline-free fd-3 buffer without first joining it into one line', async () => {
    // The cap has to be enforced on the byte COUNTER before Buffer.concat,
    // not on the joined line afterwards: the join is a second copy of
    // everything held, so a program could force roughly twice the advertised
    // 64 MiB of host memory before anything rejected it.
    //
    // This program writes past the cap with no newline: the counter crosses on
    // the 9th 8 MiB write (72 MiB) while the buffer is still a single unframed
    // line, so the pre-join check rejects it without concat-ing a second copy.
    // Checking the joined line instead would have produced a 72 MiB FIRST LINE
    // that the per-line bound then dropped only after the doubling had happened.
    const ceiling = 64 * 1024 * 1024
    const { runtime } = await setup({ maxWallMs: 60_000, addressSpaceMb: 2048 })
    const result = await runtime.run({
      program: [
        'import os',
        'chunk = b"A" * (8 * 1024 * 1024)',
        `for _ in range(${ceiling / (8 * 1024 * 1024) + 1}):`,
        '    os.write(3, chunk)',
        'return "never"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain(`protocol frame exceeded ${ceiling} bytes`)
  }, 120_000)

  it('keeps two within-cap frames whose combined buffer crosses the cap', async () => {
    // The unframed byte counter charges the WHOLE buffer, which legitimately
    // holds several frames each within FRAME_PARSE_CAP_BYTES. A first frame of
    // exactly the cap followed by a second frame crosses the counter without
    // either frame exceeding the cap; the first-frame check (not the counter)
    // must let them through, or a legitimate near-cap frame plus a trailing
    // frame would be misreported as a worker-exit.
    const { runtime } = await setup({ maxWallMs: 60_000, addressSpaceMb: 2048 })
    const result = await runtime.run({
      program: [
        'import os',
        'chunk = b"A" * (8 * 1024 * 1024)',
        // Exactly the cap, no newline — at the limit, so nothing trips.
        'for _ in range(8):',
        '    os.write(3, chunk)',
        // A newline, then a small legitimate log frame.
        'os.write(3, b"\\n{\\"type\\":\\"log\\",\\"text\\":\\"after-cap-frames\\"}\\n")',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toContain('after-cap-frames')
  }, 120_000)

  it('rejects an oversized first frame that lands on the sealing threshold with a newline', async () => {
    // The fragment-count seal runs only on newline-free chunks (the ELSE half
    // of the newline branch), so a chunk that carries the first newline always
    // reaches the join and its first-frame check; sealing it into a block
    // would empty pendingChunks, leave sawNewline false, and skip that check.
    // Whether the pipe delivers exactly 1024 chunks is timing-dependent, but
    // the oversized first frame (63.9 MiB of A's + 12289 more before the
    // newline) exceeds FRAME_PARSE_CAP_BYTES no matter how it arrives — the
    // case pins the worker-exit settlement, not a pre/post copy-count
    // distinction (both orders reject an over-cap frame).
    const { runtime } = await setup({ maxWallMs: 60_000, addressSpaceMb: 2048 })
    const result = await runtime.run({
      program: [
        'import os',
        // 4 KiB writes are <= PIPE_BUF, so each os.write is atomic and the
        // host sees one chunk per write; 16384 of them accumulate 64 MiB of
        // newline-free bytes (16 fragment-count seals of 1024 chunks).
        'chunk = b"A" * 4096',
        'for _ in range(16384):',
        '    os.write(3, chunk)',
        // 12289 more A's push the first frame past 64 MiB; drain-loop so the
        // write cannot truncate, then a newline and a small legitimate frame.
        "data = b'A' * 12289 + b'\\n' + b'{\"type\":\"log\",\"text\":\"after-seal\"}\\n'",
        'view = memoryview(data)',
        'while view:',
        '    view = view[os.write(3, view):]',
        'return "done"',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('protocol frame exceeded')
  }, 120_000)

})
