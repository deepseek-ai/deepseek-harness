/** Hand a machine App key to the token action after Environment approval, masking before output. */
import { readFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

try {
  if (!process.env.APP_KEY_FILE || !process.env.GITHUB_OUTPUT) throw new Error('Actions key file and output are required')
  const key = readFileSync(process.env.APP_KEY_FILE, 'utf8')
  console.log('::add-mask::' + key.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'))
  const delimiter = randomUUID()
  appendFileSync(process.env.GITHUB_OUTPUT, `private-key<<${delimiter}\n${key}\n${delimiter}\n`)
} catch {
  process.stderr.write('Desktop publication: cannot hand the configured App key to the token action.\n')
  process.exitCode = 1
}
