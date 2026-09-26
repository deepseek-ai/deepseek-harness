/** Exercise one independent signature-cache writer through native TypeScript stripping. */
import { readFileSync, writeFileSync } from 'node:fs'
import { cachedMacOSSignature } from '../../scripts/macos-signature-cache.ts'
const [file, cache] = process.argv.slice(2)
await cachedMacOSSignature(file, cache, {
  policy: 'cross-process-fixture',
  sign: async path => {
    const ready = new Promise(resolve => process.once('message', resolve))
    process.send('ready')
    await ready
    writeFileSync(path, `${readFileSync(path, 'utf8')}:signed`)
  },
  verify: path => { if (readFileSync(path, 'utf8') !== 'original:signed') throw Error('invalid signature') },
})
process.disconnect()
