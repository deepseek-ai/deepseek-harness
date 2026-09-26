/** Persist a per-user hardware-signing interlock; failures and interrupted attempts never unlock automatically. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { failPackagingRun, recordPackagingEvent } from './packaging-run.mjs'

/**
 * Acquire the one hardware-signing attempt slot before launching SignTool.
 * @param {{runDirectory?: string, stateDirectory?: string, target: string}} options Run evidence and test-only isolated state directory.
 * @returns {{started: (pid: number|null) => void, success: () => void, failure: (code: number|string|null, diagnostic: string) => void}} Process evidence and completion callbacks; failure retains the interlock.
 */
export function beginWindowsSigningAttempt(options) {
  const runDirectory = options.runDirectory ?? process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  if (!runDirectory || !isAbsolute(runDirectory) || !existsSync(join(runDirectory, 'run.json'))) {
    throw new Error('Windows hardware signing requires a supervised packaging run with retained records')
  }
  if (existsSync(join(runDirectory, 'fatal.json'))) throw new Error('Windows signing refused: packaging run already failed')
  const root = options.stateDirectory ?? join(homedir(), '.dsh-desktop-signing')
  const lock = join(root, 'attempt.json')
  const attemptId = randomUUID()
  mkdirSync(root, { recursive: true })
  let descriptor
  try { descriptor = openSync(lock, 'wx', 0o600) }
  catch (error) {
    failPackagingRun(runDirectory, 'hardware-signing-interlock-unavailable')
    throw new Error(`Windows signing refused: interlock unavailable at ${lock}; inspect the previous attempt before administrator-approved recovery (${error.code})`)
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ attemptId, runDirectory, pid: process.pid, startedAt: new Date().toISOString(), target: options.target })}\n`, { flush: true })
  } finally { closeSync(descriptor) }
  try { recordPackagingEvent(runDirectory, { type: 'sign-start', attemptId, target: options.target }) }
  catch (error) { failPackagingRun(runDirectory, 'signing-audit-write-failed'); throw error }
  return {
    started(pid) {
      recordPackagingEvent(runDirectory, { type: 'sign-command-start', attemptId, commandPid: pid })
    },
    success() {
      recordPackagingEvent(runDirectory, { type: 'sign-success', attemptId, target: options.target })
      if (JSON.parse(readFileSync(lock, 'utf8')).attemptId !== attemptId) throw new Error('Windows signing interlock ownership changed')
      unlinkSync(lock)
    },
    failure(code, diagnostic) {
      // The attempt file stays in place even if recording the failure or notifying the parent fails.
      try { recordPackagingEvent(runDirectory, { type: 'sign-failure', attemptId, target: options.target, code, diagnostic }) }
      finally { failPackagingRun(runDirectory, 'hardware-signing-failed') }
    },
  }
}
