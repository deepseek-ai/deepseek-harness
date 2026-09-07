import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import wineVmModule from 'app-builder-lib/out/vm/WineVm.js'

const execFileAsync = promisify(execFile)
const { WineVmManager } = wineVmModule
const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3'
const NSIS_RUN_AS_INVOKER = 'RunAsInvoker'
const NSIS_BOOTSTRAP_PATCH = Symbol.for('@deepseek-ai/dsh-desktop/nsis-bootstrap-signing')
const WINDOWS_SIGN_SCRIPT = 'windows-sign.cmd'
const WINDOWS_SIGN_SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PE_HEADER_READ_SIZE = 4096
const PE32_MAGIC = 0x10B
const PE32_PLUS_MAGIC = 0x20B
const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD)/iu
const WINDOWS_SIGNING_ENVIRONMENT_PREFIX = 'DSH_DESKTOP_WINDOWS_'

/**
 * Remove inherited credentials before starting a signing-related subprocess.
 *
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {NodeJS.ProcessEnv} Environment without credential-shaped names.
 */
export function scrubWindowsSigningEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)
      && !name.startsWith(WINDOWS_SIGNING_ENVIRONMENT_PREFIX)))
}

function resolveTokenIdentity(input) {
  const keyContainer = input.keyContainer?.trim()
  if (!keyContainer) {
    throw new Error('DSH_DESKTOP_WINDOWS_KEY_CONTAINER must contain the SafeNet private-key container name')
  }
  if (/["\r\n]/u.test(keyContainer)) {
    throw new Error('DSH_DESKTOP_WINDOWS_KEY_CONTAINER cannot contain quotes or line breaks')
  }
  const tokenPin = input.tokenPin
  if (tokenPin === undefined || tokenPin.length === 0) {
    throw new Error('DSH_DESKTOP_WINDOWS_TOKEN_PIN must contain the SafeNet Token Password')
  }
  if (/[\]"\r\n]/u.test(tokenPin)) {
    throw new Error('DSH_DESKTOP_WINDOWS_TOKEN_PIN cannot contain "]", quotes, or line breaks because the SafeNet key-container syntax uses them as delimiters')
  }
  return { keyContainer, tokenPin }
}

function resolveCertificateFile(value) {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error('DSH_DESKTOP_WINDOWS_CER_FILE must identify the public X.509 leaf certificate file')
  }
  let path
  let certificate
  try {
    path = realpathSync(candidate)
    certificate = new X509Certificate(readFileSync(path))
  }
  catch {
    throw new Error(`Windows code-signing certificate file is missing or invalid: ${candidate}`)
  }
  if (certificate.ca || !certificate.keyUsage?.includes(CODE_SIGNING_EKU)) {
    throw new Error(`Windows code-signing certificate file must contain a non-CA Code Signing certificate: ${path}`)
  }
  return path
}

function resolveSignTool(value) {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error('DSH_DESKTOP_WINDOWS_SIGNTOOL must identify the SafeNet-compatible SignTool executable')
  }
  let path
  try {
    path = realpathSync(candidate)
    if (!statSync(path).isFile() || !path.toLowerCase().endsWith('.exe')) throw new Error('not an executable file')
  }
  catch {
    throw new Error(`DSH_DESKTOP_WINDOWS_SIGNTOOL is missing or is not an executable file: ${candidate}`)
  }
  return path
}

function redactedSigningOutput(value, secrets) {
  let output = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''
  for (const secret of secrets) {
    if (secret !== '') output = output.replaceAll(secret, '<redacted>')
  }
  return output
}

/**
 * Replace a SignTool failure with a diagnostic that cannot retain its command line.
 *
 * @param {unknown} error SignTool process failure.
 * @param {string} path Artifact that failed signing.
 * @param {readonly string[]} secrets Values that must not appear in the diagnostic.
 * @returns {Error} Sanitized signing failure without the original error as its cause.
 */
export function createRedactedWindowsSigningError(error, path, secrets) {
  const record = error !== null && typeof error === 'object' ? error : undefined
  const code = record !== undefined && 'code' in record
    && (typeof record.code === 'number' || typeof record.code === 'string')
    ? ` (exit ${String(record.code)})`
    : ''
  const stderr = record !== undefined && 'stderr' in record
    ? redactedSigningOutput(record.stderr, secrets).trim()
    : ''
  return new Error(`Windows release signing failed for ${path}${code}${stderr === '' ? '' : `: ${stderr}`}`)
}

/**
 * Build the minimal CMD environment for one Electron artifact.
 *
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @param {{ certificateFile: string, signTool: string, path: string, isNest: boolean, tokenPin: string, keyContainer: string }} input Validated signing identity and task.
 * @returns {NodeJS.ProcessEnv} Scrubbed environment plus fields consumed and cleared by the signing CMD.
 */
export function buildWindowsSigningEnvironment(environment, input) {
  return {
    ...scrubWindowsSigningEnvironment(environment),
    DSH_DESKTOP_WINDOWS_SIGNTOOL: input.signTool,
    DSH_DESKTOP_WINDOWS_CER_FILE: input.certificateFile,
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: input.tokenPin,
    DSH_DESKTOP_WINDOWS_KEY_CONTAINER: input.keyContainer,
    DSH_DESKTOP_WINDOWS_SIGN_TARGET: input.path,
    DSH_DESKTOP_WINDOWS_SIGN_APPEND: input.isNest ? '1' : '',
  }
}

/**
 * Create the electron-builder hook for a SafeNet-backed Windows code-signing certificate.
 *
 * @param {{ certificateFile?: string, signTool?: string, tokenPin?: string, keyContainer?: string, commandInterpreter?: string }} options Release signing configuration.
 * @returns {(configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>} The signing hook.
 */
export function createWindowsTokenSigner(options) {
  const certificateFile = resolveCertificateFile(options.certificateFile)
  const signTool = resolveSignTool(options.signTool)
  const { keyContainer, tokenPin } = resolveTokenIdentity(options)
  const commandInterpreter = options.commandInterpreter
    ?? process.env.ComSpec
    ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return async (configuration) => {
    if (configuration.hash !== 'sha256') {
      throw new Error(`Windows release signing requires SHA-256, received ${configuration.hash}`)
    }
    await repairDanglingAuthenticodeDirectory(configuration.path)
    const secrets = [tokenPin]
    let result
    try {
      result = await execFileAsync(commandInterpreter, [
        '/d',
        '/v:off',
        '/c',
        WINDOWS_SIGN_SCRIPT,
      ], {
        cwd: WINDOWS_SIGN_SCRIPT_DIRECTORY,
        env: buildWindowsSigningEnvironment(process.env, {
          certificateFile,
          signTool,
          path: configuration.path,
          isNest: configuration.isNest,
          tokenPin,
          keyContainer,
        }),
        windowsHide: false,
      })
    }
    catch (error) {
      throw createRedactedWindowsSigningError(error, configuration.path, secrets)
    }
    const stdout = redactedSigningOutput(result.stdout, secrets)
    const stderr = redactedSigningOutput(result.stderr, secrets)
    if (stdout !== '') process.stdout.write(stdout)
    if (stderr !== '') process.stderr.write(stderr)
  }
}

/**
 * Clear a certificate-table entry that points beyond the end of a generated executable.
 *
 * @param {string} path Executable to inspect.
 * @returns {Promise<boolean>} Whether an invalid certificate-table entry was cleared.
 */
export async function repairDanglingAuthenticodeDirectory(path) {
  const file = await open(path, 'r+')
  try {
    const { size } = await file.stat()
    const header = Buffer.alloc(Math.min(PE_HEADER_READ_SIZE, size))
    await file.read(header, 0, header.length, 0)
    const directoryOffset = findDanglingAuthenticodeDirectory(header, size)
    if (directoryOffset === undefined) return false
    await file.write(Buffer.alloc(8), 0, 8, directoryOffset)
    return true
  }
  finally {
    await file.close()
  }
}

/**
 * Locate an Authenticode certificate-table entry whose declared bytes are outside the file.
 *
 * @param {Buffer} header Initial executable bytes.
 * @param {number} fileSize Complete file size.
 * @returns {number | undefined} File offset of the invalid data-directory entry.
 */
function findDanglingAuthenticodeDirectory(header, fileSize) {
  if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') return undefined
  const peOffset = header.readUInt32LE(60)
  const optionalHeaderOffset = peOffset + 24
  if (optionalHeaderOffset + 2 > header.length
    || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return undefined
  const magic = header.readUInt16LE(optionalHeaderOffset)
  const dataDirectoryOffset = magic === PE32_MAGIC
    ? optionalHeaderOffset + 96
    : magic === PE32_PLUS_MAGIC
      ? optionalHeaderOffset + 112
      : undefined
  if (dataDirectoryOffset === undefined) return undefined
  const certificateDirectoryOffset = dataDirectoryOffset + (4 * 8)
  if (certificateDirectoryOffset + 8 > header.length) return undefined
  const certificateOffset = header.readUInt32LE(certificateDirectoryOffset)
  const certificateSize = header.readUInt32LE(certificateDirectoryOffset + 4)
  if (certificateOffset === 0 && certificateSize === 0) return undefined
  return certificateOffset > 0
    && certificateSize > 0
    && certificateOffset + certificateSize <= fileSize
    ? undefined
    : certificateDirectoryOffset
}

/**
 * Sign electron-builder's temporary NSIS executable before enterprise code integrity evaluates it.
 *
 * @param {{ sign: (configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>, wineVmManager?: typeof WineVmManager, platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv }} options Signing hook and injectable host values.
 * @returns {void}
 */
export function installWindowsNsisBootstrapSigner(options) {
  if ((options.platform ?? process.platform) !== 'win32') return
  const prototype = (options.wineVmManager ?? WineVmManager).prototype
  if (prototype[NSIS_BOOTSTRAP_PATCH] === true) return
  const originalExec = prototype.exec
  prototype.exec = async function (file, args, execOptions, isLogOutIfDebug) {
    const isNsisBootstrap = file.toLowerCase().endsWith('.exe')
      && execOptions?.env?.__COMPAT_LAYER === NSIS_RUN_AS_INVOKER
    if (!isNsisBootstrap) {
      return originalExec.call(this, file, args, execOptions, isLogOutIfDebug)
    }
    await options.sign({ path: file, hash: 'sha256', isNest: false })
    return originalExec.call(this, file, args, {
      ...execOptions,
      env: scrubWindowsSigningEnvironment({
        ...(options.environment ?? process.env),
        ...execOptions.env,
      }),
    }, isLogOutIfDebug)
  }
  Object.defineProperty(prototype, NSIS_BOOTSTRAP_PATCH, { value: true })
}
