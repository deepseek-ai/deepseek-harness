/** Check the production signing path with one private probe before preparing release artifacts. */
import { execFile } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createWindowsTokenSigner, scrubWindowsSigningEnvironment } from './windows-sign.mjs'
import { inspectWindowsRuntimeSignature, type WindowsRuntimeSignature } from './windows-runtime-signature.mjs'
import { failPackagingRun, recordPackagingEvent } from './packaging-run.mjs'

const PROBE_SOURCE = 'internal static class SigningProbe { private static int Main() { return 0; } }\n'

interface SigningPreflightOptions {
  runDirectory: string
  environment: NodeJS.ProcessEnv
  stateDirectory?: string
  compile?: (compiler: string, source: string, output: string, environment: NodeJS.ProcessEnv) => Promise<void>
  sign?: ReturnType<typeof createWindowsTokenSigner>
  inspect?: (path: string) => Promise<WindowsRuntimeSignature>
}

async function compileProbe(compiler: string, source: string, output: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, ...safeEnvironment } = scrubWindowsSigningEnvironment(environment)
  await promisify(execFile)(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${output}`, source], {
    env: safeEnvironment, windowsHide: true, timeout: 30_000,
  })
}

/**
 * Sign one newly compiled, never-executed probe and verify its timestamp and configured certificate.
 * @param options Supervised evidence directory, file-owned settings and isolated test adapters.
 * @returns Resolves after one signature and verification; failures retain evidence; timestamp attempts never repeat hardware signing.
 */
export async function preflightWindowsSigning(options: SigningPreflightOptions): Promise<void> {
  const { environment, runDirectory } = options
  const record = (event: object): void => { recordPackagingEvent(runDirectory, event) }
  const signer = createWindowsTokenSigner({
    certificateFile: environment.DSH_DESKTOP_WINDOWS_CER_FILE,
    signTool: environment.DSH_DESKTOP_WINDOWS_SIGNTOOL,
    keyContainer: environment.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
    tokenPin: environment.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
    runDirectory,
    stateDirectory: options.stateDirectory,
  })
  const state = options.stateDirectory ?? join(homedir(), '.dsh-desktop-signing')
  const lock = join(state, 'attempt.json')
  const compiler = join(environment.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  await access(join(runDirectory, 'run.json'))
  for (const path of [join(runDirectory, 'fatal.json'), lock]) {
    try { await lstat(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(`Windows signing preflight refused: inspect retained failure or interlock at ${path}; no automatic recovery`)
  }
  if (!(await lstat(compiler)).isFile()) throw new Error('Windows signing preflight requires the local .NET Framework C# compiler')
  const certificate = await readFile(environment.DSH_DESKTOP_WINDOWS_CER_FILE!)
  const leaf = new X509Certificate(certificate)
  if (Date.now() < Date.parse(leaf.validFrom) || Date.now() > Date.parse(leaf.validTo)) {
    throw new Error('Windows signing preflight requires a currently valid public certificate')
  }
  const thumbprint = leaf.fingerprint.replaceAll(':', '')
  const directory = join(runDirectory, 'signing-preflight')
  await mkdir(directory)
  const source = join(directory, 'probe.cs')
  const output = join(directory, 'probe.exe')
  await writeFile(source, PROBE_SOURCE, { flag: 'wx', flush: true })
  record({ type: 'signing-preflight-static', compiler,
    compilerSha256: createHash('sha256').update(await readFile(compiler)).digest('hex'),
    signToolSha256: createHash('sha256').update(await readFile(environment.DSH_DESKTOP_WINDOWS_SIGNTOOL!)).digest('hex'),
    certificateSha256: createHash('sha256').update(certificate).digest('hex') })
  await (options.compile ?? compileProbe)(compiler, source, output, environment)
  const inspect = options.inspect ?? inspectWindowsRuntimeSignature
  if ((await inspect(output)).status !== 'NotSigned') throw new Error('Windows signing preflight requires a new unsigned probe')
  record({ type: 'signing-preflight-probe', path: output, sha256: createHash('sha256').update(await readFile(output)).digest('hex') })
  await (options.sign ?? signer)({ path: output, hash: 'sha256', isNest: false })
  const signature = await inspect(output)
  if (signature.status !== 'Valid' || !signature.timestamped || signature.thumbprint?.toUpperCase() !== thumbprint.toUpperCase()) {
    throw new Error('Windows signing preflight verification failed: expected the configured certificate and a valid timestamp')
  }
  record({ type: 'signing-preflight-success', ...signature,
    sha256: createHash('sha256').update(await readFile(output)).digest('hex'), probeExecuted: false })
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows signing preflight requires Windows')
  const runDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  if (!runDirectory) throw new Error('Windows signing preflight requires a supervised packaging run')
  try { await preflightWindowsSigning({ runDirectory, environment: process.env }) }
  catch (error) {
    failPackagingRun(runDirectory, 'windows-signing-preflight-failed')
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main()
