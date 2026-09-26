/** Independent process exercising stage ownership and cache reuse with a hardware-free signer. */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withWindowsSigningStage } from '../../scripts/windows-signing-stage.mjs'
import { createCachedSigner, maintainSignatureCache } from '../../scripts/windows-signature-cache.mjs'

const [root, input, mode] = process.argv.slice(2)
const release = new Promise(resolve => process.once('message', resolve))
await withWindowsSigningStage({ stateDirectory: join(root, 'state'), stage: 'fixture', record: event => process.send(event) }, async () => {
  process.send({ type: 'entered' })
  await release
  if (mode === 'clear') {
    await maintainSignatureCache(join(root, 'cache'), true)
    return
  }
  const thumbprint = 'A'.repeat(40)
  const signer = createCachedSigner({ root: join(root, 'cache'), identity: 'fixture', thumbprint,
    record: event => process.send(event),
    inspect: async path => ({ status: (await readFile(path, 'utf8')).startsWith('signed:') ? 'Valid' : 'NotSigned', timestamped: true, thumbprint }),
    sign: async ({ path }) => {
      await appendFile(join(root, 'hardware-calls'), 'call\n')
      await writeFile(path, `signed:${await readFile(path, 'utf8')}`)
    },
  })
  await signer({ path: input, hash: 'sha256', isNest: false })
})
process.disconnect()
