/** A plain Node child that echoes binary control bytes independently of stdio. */

import { pathToFileURL } from 'node:url'
import type { Duplex } from 'node:stream'

const helper = await import(pathToFileURL(process.argv[2] as string).href) as { openInheritedControlChannel(): Duplex }
const channel = helper.openInheritedControlChannel()
const size = Number(process.argv[3])
process.stdout.write('ordinary stdout\n')
process.stderr.write('ordinary stderr\n')
const chunks: Buffer[] = []
let received = 0
channel.on('error', (error) => { throw error })
channel.on('data', (chunk: Buffer) => {
  chunks.push(chunk)
  received += chunk.length
  if (received === size) {
    channel.removeAllListeners('data')
    channel.write(Buffer.concat(chunks), () => { channel.destroy() })
  }
})
