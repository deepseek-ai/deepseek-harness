/** Exercise terminal cleanup in a child whose natural exit detects retained workers. */
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const pty = createRequire(resolve(__dirname, '../../../../packages/subprocess/subprocess-local/package.json'))('node-pty')
const killWhileRunning = process.argv[2] === 'kill'
const terminal = pty.spawn(process.env.ComSpec, ['/d', '/c', killWhileRunning ? 'echo pty-ready & pause >nul' : 'echo pty-complete'], {
  cwd: __dirname, env: process.env, cols: 80, rows: 24, useConptyDll: true,
})
let output = ''
let killed = false
terminal.onData(data => {
  output += data
  if (killWhileRunning && !killed && output.includes('pty-ready')) {
    killed = true
    terminal.kill()
  }
})
terminal.onExit(event => {
  if (!killWhileRunning) {
    assert.equal(event.exitCode, 0)
    assert.match(output, /pty-complete/u)
    terminal.kill()
  } else {
    assert.equal(killed, true)
  }
  process.once('beforeExit', () => console.log('pty-cleanup-complete'))
})
