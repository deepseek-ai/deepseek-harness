/** Record in-process and Apple-tool phases in the same journal as packaging subprocesses. */
import { randomUUID } from 'node:crypto'
import { recordPackagingEvent, packagingOutputRedactor } from './packaging-run.mjs'

/**
 * Persist a phase outcome, including nested failure details, without logging arguments or environments.
 * @param {string | undefined} directory Existing run directory; undefined retains unrecorded callers.
 * @param {string} stage Public phase label, never credentials.
 * @param {() => Promise<unknown>} action Work that settles all owned activity before returning.
 * @param {readonly string[]} secrets Credential values removed from errors.
 * @returns {Promise<unknown>} Action result; logging failures also reject the phase.
 */
export async function packagingStep(directory, stage, action, secrets = Object.entries(process.env).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|APPLE_ID/iu.test(name)).map(([, value]) => value ?? '')) {
  if (directory === undefined) return action()
  const stageId = randomUUID()
  const started = performance.now()
  recordPackagingEvent(directory, { type: 'stage-start', stage, stageId })
  try {
    const result = await action()
    recordPackagingEvent(directory, { type: 'stage-end', stage, stageId, elapsedMs: performance.now() - started, success: true })
    return result
  } catch (error) {
    const message = packagingErrorDetails(error, secrets)
    recordPackagingEvent(directory, { type: 'stage-end', stage, stageId, elapsedMs: performance.now() - started, success: false, error: message })
    throw error
  }
}

/**
 * Format nested errors with credential values removed for journal and terminal output.
 * @param {unknown} error Failure including optional causes or aggregate errors.
 * @param {readonly string[]} secrets Credential values removed from output.
 * @returns {string} Redacted diagnostic including nested recovery instructions.
 */
export function packagingErrorDetails(error, secrets) {
  const seen = new Set()
  function details(value) {
    if (!(value instanceof Error)) return String(value)
    if (seen.has(value)) return '[circular error]'
    seen.add(value)
    return [value.stack ?? value.message, ...(value instanceof AggregateError ? value.errors.map(details) : []),
      ...(value.cause === undefined ? [] : [details(value.cause)])].join('\n')
  }
  let message = ''
  const redactor = packagingOutputRedactor(secrets, text => { message += text })
  redactor.write(Buffer.from(details(error)))
  redactor.end()
  return message
}
