/** Inert subprocess fixture for packaging supervision; no signing or executable entry runs. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const [manifest, version] = process.argv.slice(2)
const run = JSON.parse(await readFile(manifest, 'utf8'))
process.stdout.write(process.env.DSH_DESKTOP_WINDOWS_TOKEN_PIN)
if (process.env.DSH_TEST_PACKAGING_FAIL === '1') process.exitCode = 2
else {
  const directory = join(run.root, version, 'installer')
  await mkdir(directory, { recursive: true })
  const filename = `deepseek-harness-${version}-win-x64.exe`
  const bytes = Buffer.from('inert test bytes, not an installer')
  await writeFile(join(directory, filename), bytes)
  await writeFile(join(directory, `${filename}.blockmap`), 'inert test map')
  await writeFile(join(directory, 'nightly.yml'), JSON.stringify({ version, files: [{ url: filename,
    size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] }))
}
