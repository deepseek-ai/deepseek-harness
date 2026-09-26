/** Bounded public-key verification batches; every output row must match its requested file. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

const command = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop; Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop; $files=[Console]::In.ReadToEnd()|ConvertFrom-Json; foreach($file in $files){ $s=Get-AuthenticodeSignature -LiteralPath $file; [pscustomobject]@{path=$file;status=[string]$s.Status;timestamped=($null -ne $s.TimeStamperCertificate);thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress }'

/**
 * Reject missing, duplicated, reordered or malformed file results.
 * @param {string} stdout Newline-delimited signature records.
 * @param {string} stderr Process diagnostics; any content rejects the batch.
 * @param {readonly string[]} files Exact requested order.
 * @returns {Array<{status: string, timestamped: boolean, thumbprint: string|null}>} Complete signature results.
 */
export function parseSignatureRows(stdout, stderr, files) {
  const rows = stdout.trim().split(/\r?\n/u)
  if (stderr || rows.length !== files.length) throw new Error('Windows signature batch: incomplete inspection output')
  return rows.map((row, index) => {
    const value = JSON.parse(row)
    if (value === null || typeof value !== 'object' || value.path !== files[index]
      || typeof value.status !== 'string' || typeof value.timestamped !== 'boolean'
      || !(value.thumbprint === null || typeof value.thumbprint === 'string' && /^[A-F\d]{40}$/iu.test(value.thumbprint))) {
      throw new Error(`Windows signature batch: invalid inspection output: ${files[index]}`)
    }
    return { status: value.status, timestamped: value.timestamped, thumbprint: value.thumbprint }
  })
}

async function inspectBatch(files) {
  const pending = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: scrubWindowsSigningEnvironment(process.env), encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 64 * 1024 * files.length,
  })
  pending.child.stdin.on('error', () => { /* Process failure is reported by the awaited execFile result. */ })
  pending.child.stdin.end(JSON.stringify(files))
  const { stdout, stderr } = await pending
  return parseSignatureRows(stdout, stderr, files)
}

/**
 * Inspect every file through at most four processes, draining failures before returning.
 * @param {readonly string[]} files Materialized PE paths in stable order.
 * @returns {Promise<Array<{status: string, timestamped: boolean, thumbprint: string|null}>>} One result per input.
 */
export async function inspectSignaturesBatched(files) {
  const signatures = []
  for (let offset = 0; offset < files.length; offset += 128) {
    const groups = []
    for (let i = offset; i < Math.min(files.length, offset + 128); i += 32) groups.push(files.slice(i, i + 32))
    const settled = await Promise.allSettled(groups.map(inspectBatch))
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason
      signatures.push(...result.value)
    }
  }
  return signatures
}
