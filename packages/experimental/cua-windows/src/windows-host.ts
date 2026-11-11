/** Windows desktop execution from native Windows or a WSL process. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { isWsl, type HostEnvironmentFacts } from '@deepseek-ai/dsh-native-command'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { NativeError } from '@deepseek-ai/dsh-cua/native-client'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { NativeArchitecture } from './native-build.ts'

/** DSH execution environment, independently of the Windows desktop it controls. */
export type WindowsHost = 'windows' | 'wsl'

/**
 * Resolve the Host before compiling or launching native code.
 * @param facts Process and kernel facts; omitted fields use the current Host.
 * @returns Native Windows or WSL; ordinary Linux has no Windows desktop provider.
 */
export function windowsHost(facts: HostEnvironmentFacts = {}): WindowsHost {
  if ((facts.platform ?? process.platform) === 'win32') return 'windows'
  if (isWsl(facts)) return 'wsl'
  throw new NativeError('UNSUPPORTED', 'Windows Computer Use requires native Windows or WSL; ordinary Linux is unsupported')
}

/** Managed command lifetime for WSL capability and path queries. */
export interface WslPreparation {
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  signal: AbortSignal
  timeoutMs: number
  graceMs: number
  powershellPath: string
}

async function command(spec: WslPreparation, argv: string[]): Promise<string> {
  spec.signal.throwIfAborted()
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
  const handle = spec.subprocess.spawn({ argv, cwd: process.cwd(), signal, graceMs: spec.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } } })
  try {
    const outcome = await handle.done
    signal.throwIfAborted()
    if (outcome.exitCode !== 0 || outcome.signal !== null)
      throw new NativeError('WSL_INTEROP', `Windows interoperation failed: ${handle.collected.stderr?.readFrom(0).text ?? outcome.exitCode}`)
    return handle.collected.stdout?.readFrom(0).text.trim() ?? ''
  } finally {
    handle.terminate()
    if (!await handle.waitForExit()) throw new NativeError('NATIVE_CLEANUP', 'Windows preparation process did not exit')
  }
}

/**
 * Verify that WSL can start Windows programs and resolve the Windows runtime architecture.
 * @param spec Managed process policy and Windows PowerShell executable.
 * @returns Windows architecture and a WSL-visible cache directory on the Windows filesystem.
 */
export async function prepareWsl(spec: WslPreparation): Promise<{ architecture: NativeArchitecture; cacheDirectory: string }> {
  const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @{ architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant(); cache = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'DeepSeekHarness', 'cua') } | ConvertTo-Json -Compress"
  try {
    const output = await command(spec, [spec.powershellPath, '-NoProfile', '-NonInteractive', '-Command', script])
    const result = z.object({ architecture: z.enum(['x64', 'arm64']), cache: z.string().refine(value => win32.isAbsolute(value)) }).strict().parse(JSON.parse(output))
    const cacheDirectory = await command(spec, ['wslpath', '-u', result.cache])
    if (!cacheDirectory.startsWith('/')) throw new NativeError('WSL_INTEROP', 'wslpath did not return an absolute cache directory')
    return { architecture: result.architecture, cacheDirectory }
  } catch (error) {
    spec.signal.throwIfAborted()
    throw new NativeError('WSL_INTEROP', 'WSL cannot prepare Windows Computer Use; check Windows interoperation and windowsPowerShellPath', { cause: error })
  }
}

/**
 * Retain the helper on the Windows filesystem so Explorer can launch the shared desktop service.
 * @param helperPath Absolute executable path visible to WSL.
 * @param cacheDirectory Windows user cache translated to a WSL path.
 * @param signal Provider preparation lifetime.
 * @returns Content-addressed executable path, without modifying the source payload.
 */
export async function retainWslHelper(helperPath: string, cacheDirectory: string, signal: AbortSignal): Promise<string> {
  const bytes = await readFile(helperPath, { signal })
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = join(cacheDirectory, digest)
  const retained = join(directory, 'dsh-cua-windows.exe')
  await mkdir(directory, { recursive: true })
  let existing: Buffer | undefined
  try { existing = await readFile(retained, { signal }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  signal.throwIfAborted()
  if (existing && !existing.equals(bytes)) throw new NativeError('NATIVE_STARTUP', 'The cached Windows helper does not match its executable digest')
  if (!existing) await writeFileAtomic(retained, bytes, { mode: 0o755 })
  signal.throwIfAborted()
  return retained
}
