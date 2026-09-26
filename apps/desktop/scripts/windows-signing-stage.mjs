/** Serialize complete signing and cache-maintenance stages without clearing hardware failure evidence. */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, toNamespacedPath } from 'node:path'
import { setTimeout } from 'node:timers/promises'

let bindings
async function windows() {
  if (process.platform !== 'win32') throw new Error('Windows signing stages require Windows')
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  bindings = {
    open: kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    error: kernel.func('__stdcall', 'GetLastError', 'uint', []),
  }
  return bindings
}

/**
 * Hold one account-wide exclusive file handle until a stage and its children have settled.
 * @template T
 * @param {import('./windows-signing-stage.mjs').WindowsSigningStageOptions} options Audit sink, cancellation and isolated test storage.
 * @param {() => Promise<T>} operation Entire stage, including verification and cache publication.
 * @returns {Promise<T>} Stage result; contention waits, all other acquisition errors stop before the operation.
 */
export async function withWindowsSigningStage(options, operation) {
  const api = await windows()
  const root = options.stateDirectory ?? join(homedir(), '.dsh-desktop-signing')
  await mkdir(root, { recursive: true })
  const stat = await lstat(root)
  const normalize = value => toNamespacedPath(resolve(value)).toLowerCase()
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(await realpath(root)) !== normalize(root)) {
    throw new Error('Windows signing stage requires an unlinked local state directory')
  }
  const path = join(root, 'stage.lock')
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('Windows signing stage requires a regular lock file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const start = performance.now()
  let handle
  let waiting = false
  for (;;) {
    options.signal?.throwIfAborted()
    // OPEN_ALWAYS retains the same file; denying sharing prevents concurrent holders and deletion.
    handle = api.open(toNamespacedPath(path), 0xc0000000, 0, null, 4, 0x80, 0)
    if (handle !== -1) break
    const code = api.error()
    if (code !== 32) throw new Error(`Windows signing stage cannot open its lock (Win32 ${code})`)
    if (!waiting) { options.record({ type: 'signing-stage-wait', stage: options.stage }); waiting = true }
    await setTimeout(100, undefined, { signal: options.signal })
  }
  try {
    options.record({ type: 'signing-stage-acquired', stage: options.stage, waitMs: performance.now() - start })
    return await operation()
  } finally {
    if (api.close(handle) === 0) throw new Error(`Windows signing stage cannot release its lock (Win32 ${api.error()})`)
    options.record({ type: 'signing-stage-released', stage: options.stage })
  }
}
