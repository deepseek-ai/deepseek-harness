/** Protocol fixture replacing the native recognizer, with real process and HTTP lifetimes. */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const root = JSON.parse(process.argv[2]).model
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${process.env.DSH_SPEECH_TOKEN}`) {
    response.writeHead(401).end(); return
  }
  const language = new URL(request.url, 'http://localhost').searchParams.get('language')
  appendFileSync(join(root, 'requests'), `${language}\n`)
  request.resume()
  request.on('end', () => {
    if (language === 'hold') return
    if (language === 'crash') { process.exit(1); return }
    if (language === 'invalid-input') { response.writeHead(400).end(JSON.stringify({ error: 'invalid input', code: 'invalid-input' })); return }
    if (language === 'error') { response.writeHead(400).end(JSON.stringify({ error: 'provider failed' })); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ text: language, audioSeconds: 1, inferenceSeconds: 0.1 }))
  })
})
server.listen(0, '127.0.0.1', () => { process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`) })
