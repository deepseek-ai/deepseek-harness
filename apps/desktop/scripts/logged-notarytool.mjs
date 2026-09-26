#!/usr/bin/env node
/** Adapt electron-notarize's combined submit/wait into separately timed Apple operations. */
import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { recordPackagingEvent, packagingOutputRedactor } from './packaging-run.mjs'
import { packagingStep } from './packaging-step.mjs'

const exec = promisify(execFile)
const AUTH_FLAGS = new Set(['--apple-id', '--password', '--team-id', '--key', '--key-id', '--issuer', '--keychain', '--keychain-profile'])

async function execute(args) {
  try {
    const { stdout } = await exec('/usr/bin/xcrun', ['notarytool', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // Apple can report rejection with a nonzero exit; electron-notarize needs its JSON ID to retrieve diagnostics.
    if (args[0] === 'wait' && typeof error.code === 'number' && typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout
    throw error
  }
}

/**
 * Return only the final JSON to electron-notarize, which owns acceptance checks and stapling retries.
 * @param {readonly string[]} args Arguments supplied by the pinned electron-notarize library.
 * @param {string | undefined} directory Existing packaging journal.
 * @param {(args: readonly string[]) => Promise<string>} invoke Apple command executor.
 * @returns {Promise<string>} Tool output; a failed upload never starts waiting.
 */
export async function runLoggedNotarytool(args, directory, invoke = execute) {
  const credentials = args.filter((_, index) => AUTH_FLAGS.has(args[index - 1]))
  if (args[0] !== 'submit' || !args.includes('--wait')) {
    return packagingStep(directory, `notarytool:${args[0]}`, async () => {
      const output = await invoke(args)
      if (directory && args[0] === 'log') {
        let text = ''
        const redactor = packagingOutputRedactor(credentials, chunk => { text += chunk })
        redactor.write(Buffer.from(output))
        redactor.end()
        recordPackagingEvent(directory, { type: 'notary-diagnostics', submissionId: args[1], text })
      }
      return output
    }, credentials)
  }
  const artifact = basename(args[1])
  const uploaded = await packagingStep(directory, `notarytool:upload:${artifact}`,
    () => invoke(args.filter(arg => arg !== '--wait').concat('--no-wait')), credentials)
  const submission = JSON.parse(uploaded)
  if (typeof submission.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(submission.id)) {
    throw new Error('desktop notarization: submit returned no valid submission ID')
  }
  if (directory) recordPackagingEvent(directory, { type: 'notary-submission', artifact, submissionId: submission.id })
  const authorization = args.flatMap((arg, index) => AUTH_FLAGS.has(arg) ? [arg, args[index + 1]] : [])
  const rejected = new Error('desktop notarization: Apple did not accept the submission')
  let rejectedOutput
  try {
    return await packagingStep(directory, `notarytool:wait:${artifact}`, async () => {
      const output = await invoke(['wait', submission.id, ...authorization, '--output-format', 'json'])
      const result = JSON.parse(output)
      if (directory) recordPackagingEvent(directory, { type: 'notary-result', artifact, submissionId: submission.id, status: result.status })
      if (result.id !== submission.id) throw new Error('desktop notarization: wait returned a different submission ID')
      if (result.status !== 'Accepted') {
        rejectedOutput = output
        throw rejected
      }
      return output
    }, credentials)
  } catch (error) {
    // Preserve rejected JSON for electron-notarize's diagnostic retrieval without marking the wait successful.
    if (error === rejected) return rejectedOutput
    throw error
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.stdout.write(await runLoggedNotarytool(process.argv.slice(2), process.env.DSH_DESKTOP_PACKAGING_RUN_DIR)) }
  catch {
    // execFile errors include credential-bearing argv; detailed failures are redacted in the journal.
    process.stderr.write('desktop notarization: Apple command failed; see packaging events.jsonl\n')
    process.exitCode = 1
  }
}
