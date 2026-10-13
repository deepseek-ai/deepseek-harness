/** Prepare private machine directories and templates without registering a runner or overwriting configuration. */
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const [root, mode] = process.argv.slice(2)
if (process.platform !== 'darwin') throw new Error('Run macOS packaging setup on a Mac')
if (!root || !isAbsolute(root) || (mode !== undefined && mode !== '--check') || process.argv.length > 4) {
  throw new Error('Usage: node setup-macos-packaging.mjs ABSOLUTE_ROOT [--check]')
}
if (/[\r\n']/u.test(root)) throw new Error('Packaging root cannot contain single quotes or newlines')
for (let path = resolve(root); ; path = dirname(path)) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Packaging root ancestors cannot be links')
  if (path === dirname(path)) break
}
for (const relative of ['', 'packaging', 'packaging/presets', 'packaging/secrets', 'packaging/certificates', 'runner', 'cache', 'cache/macos-signatures']) {
  const path = join(root, relative)
  if (!existsSync(path) && mode !== '--check') mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Packaging directories must be real, private and owned by the current account: ${path}`)
  }
}
if (mode !== '--check') {
  for (const [name, directory] of [['test', 'presets'], ['production', 'presets'], ['macos-signing', 'secrets']]) {
    const destination = join(root, 'packaging', directory, `${name}.env.example`)
    if (!existsSync(destination)) {
      const template = readFileSync(resolve(import.meta.dirname, '../config/macos-packaging', `${name}.env.example`), 'utf8')
      const cache = join(root, 'cache/macos-signatures')
      writeFileSync(destination, template.replace('# DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR=',
        `DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR='${cache}'`), { flag: 'wx', mode: 0o600 })
    }
  }
}
process.stdout.write(`Private packaging directories verified: ${resolve(root)}\n`)
