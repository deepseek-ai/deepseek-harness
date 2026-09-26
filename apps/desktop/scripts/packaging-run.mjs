/** Persist redacted packaging evidence and terminate the owned stage tree on fatal signing failures. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const FATAL_NOTIFICATION = 'DSH_DESKTOP_PACKAGING_FATAL'

/**
 * Append one credential-free event before its corresponding operation starts.
 * @param {string} directory Private run directory.
 * @param {object} event Whitelisted event fields; never pass command arguments or environments.
 * @returns {void}
 */
export function recordPackagingEvent(directory, event) {
  appendFileSync(join(directory, 'events.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...event })}\n`, { flush: true })
}

/**
 * Publish the fatal marker before rejecting a signing operation.
 * @param {string} directory Private run directory.
 * @param {string} reason Credential-free failure category.
 * @returns {void}
 */
export function failPackagingRun(directory, reason) {
  try {
    writeFileSync(join(directory, 'fatal.json'), `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, reason })}\n`, { flush: true })
  } finally { process.stderr.write(`\n${FATAL_NOTIFICATION}\n`) }
}

/**
 * Redact complete secrets even when process output splits them across chunks.
 * @param {readonly string[]} secrets Exact inherited credential values.
 * @param {(text: string) => void} emit Redacted output sink.
 * @returns {{write: (chunk: Buffer) => void, end: () => void}} Bounded streaming redactor.
 */
export function packagingOutputRedactor(secrets, emit) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  function drain(final) {
    let output = ''
    while (buffer.length > 0) {
      const match = values.find(value => buffer.startsWith(value))
      if (match !== undefined) { output += '[REDACTED]'; buffer = buffer.slice(match.length); continue }
      if (!final && values.some(value => value.startsWith(buffer))) break
      output += buffer[0]
      buffer = buffer.slice(1)
    }
    if (output !== '') emit(output)
  }
  return {
    write(chunk) { buffer += decoder.write(chunk); drain(false) },
    end() { buffer += decoder.end(); drain(true) },
  }
}

/**
 * Allocate a run whose failures never become release completion records.
 * @param {string} root Parent for retained packaging records.
 * @param {object} metadata Public target/version metadata only.
 * @param {{parallel?: boolean, secrets?: readonly string[]}} settings Parallel stages are opt-in; secrets include credentials removed from child environments.
 * @returns {{directory: string, run: (stage: string, executable: string, args: readonly string[], options: {cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number}) => Promise<void>, finish: (success: boolean) => void}} Owned run supervisor; an optional stage deadline records timeout independently of exit status and awaits termination.
 */
export function createPackagingRun(root, metadata, settings = {}) {
  const started = performance.now()
  mkdirSync(root, { recursive: true })
  const directory = realpathSync(mkdtempSync(join(resolve(root), `${new Date().toISOString().replaceAll(':', '-')}-`)))
  for (const name of ['events.jsonl', 'stdout.log', 'stderr.log']) {
    writeFileSync(join(directory, name), '', { flag: 'wx', mode: 0o600 })
  }
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, ...metadata })}\n`, { flag: 'wx', mode: 0o600, flush: true })
  let failed = false
  let active = 0
  const fatal = join(directory, 'fatal.json')
  async function run(stage, executable, args, options) {
    if (failed || existsSync(fatal)) throw new Error(`desktop package: run is blocked; see ${directory}`)
    if (active && !settings.parallel) throw new Error('desktop package: supervised stages must run sequentially')
    active++
    const stageId = randomUUID()
    const started = performance.now()
    let child
    let fatalObserved = false
    let launchError = false
    let outputError = false
    let termination
    let terminationCode
    let terminationError = false
    let stageClosed = false
    let timedOut = false
    let deadline
    let closed
    const safeEnvironment = Object.fromEntries(Object.entries(options.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(name)))
    function stop() {
      fatalObserved = true
      failed = true
      if (termination !== undefined || child?.pid === undefined || stageClosed) return
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
          env: safeEnvironment, windowsHide: true, stdio: 'ignore',
        })
        termination = new Promise(resolveTermination => {
          killer.once('error', () => { terminationError = true })
          killer.once('close', code => {
            terminationCode = code
            if (code !== 0) { terminationError = true; child.kill() }
            resolveTermination()
          })
        })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') terminationError = true }
        termination = Promise.resolve()
      }
    }
    const interrupted = () => stop()
    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    try {
      recordPackagingEvent(directory, { type: 'stage-start', stage, stageId })
      child = spawn(executable, [...args], { cwd: options.cwd, env: { ...options.env, DSH_DESKTOP_PACKAGING_RUN_DIR: directory },
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      closed = new Promise(resolveClose => {
        child.once('error', () => { launchError = true })
        child.once('close', (code, signal) => { stageClosed = true; resolveClose({ code, signal }) })
      })
      recordPackagingEvent(directory, { type: 'stage-spawn', stage, stageId, childPid: child.pid })
      if (options.timeoutMs !== undefined) deadline = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
      const secrets = [...(settings.secrets ?? []), ...Object.entries(options.env).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|APPLE_ID/iu.test(name)).map(([, value]) => value ?? '')]
      const streams = [['stdout', child.stdout, process.stdout], ['stderr', child.stderr, process.stderr]]
      for (const [name, stream, consoleStream] of streams) {
        let notification = ''
        const redactor = packagingOutputRedactor(secrets, text => {
          try {
            appendFileSync(join(directory, `${name}.log`), text, { flush: true })
            if (settings.parallel) recordPackagingEvent(directory, { type: 'output', stage, stageId, stream: name, text })
            consoleStream.write(text)
          } catch { outputError = true; stop() }
          notification += text
          if (notification.includes(FATAL_NOTIFICATION)) stop()
          notification = notification.slice(-FATAL_NOTIFICATION.length)
        })
        stream.on('data', chunk => redactor.write(chunk))
        stream.once('end', () => redactor.end())
        stream.once('error', () => { outputError = true; stop() })
      }
      if (existsSync(fatal)) stop()
      const result = await closed
      await termination
      fatalObserved ||= existsSync(fatal)
      recordPackagingEvent(directory, { type: 'stage-end', stage, stageId, elapsedMs: performance.now() - started, ...result, timedOut, fatalObserved, launchError, outputError, terminationCode, terminationError })
      if (result.code !== 0 || result.signal !== null || fatalObserved || launchError || outputError || terminationError) {
        failed = true
        throw new Error(`desktop package: ${stage} failed; evidence: ${directory}`)
      }
    } catch (error) {
      failed = true
      stop()
      await closed
      await termination
      throw error
    } finally {
      clearTimeout(deadline)
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
      active--
    }
  }
  return {
    directory,
    run,
    finish(success) {
      if (active) throw new Error('desktop package: cannot finish an active run')
      const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const stages = events.filter(event => event.type === 'stage-end')
      const proxy = events.filter(event => event.type === 'notarization-proxy').at(-1)?.status ?? 'not-used'
      writeFileSync(join(directory, 'result.json'), `${JSON.stringify({ completedAt: new Date().toISOString(), elapsedMs: performance.now() - started, success: success && !failed && !existsSync(fatal), proxy, artifacts: events.filter(event => event.type === 'artifacts').at(-1)?.directory, stages })}\n`, { flag: 'wx', mode: 0o600, flush: true })
    },
  }
}
