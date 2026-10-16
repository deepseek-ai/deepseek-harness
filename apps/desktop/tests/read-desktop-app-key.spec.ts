import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('masks multiline key bytes and passes the exact fixture to the token action without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-app-key-'))
  try {
    const path = join(root, 'fixture.pem')
    const output = join(root, 'output')
    const key = 'fixture%key\r\nsecond-line\n'
    await writeFile(path, key)
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../scripts/read-desktop-app-key.mjs', import.meta.url))], {
        env: { ...process.env, APP_KEY_FILE: path, GITHUB_OUTPUT: output }, encoding: 'utf8',
      })
    expect(result.stdout).toBe('::add-mask::fixture%25key%0D%0Asecond-line%0A\n')
    expect(result.stderr).toBe('')
    const contents = await readFile(output, 'utf8')
    const delimiter = contents.slice('private-key<<'.length, contents.indexOf('\n'))
    expect(contents).toBe(`private-key<<${delimiter}\n${key}\n${delimiter}\n`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
