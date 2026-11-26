/** Validates and atomically installs the bundled execution daemon on an SSH destination. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { lt, satisfies, valid } from 'semver'
import { shellQuote, type SshCommandResult } from './openssh.ts'
import { SshEnvironmentError } from './errors.ts'

export { SshEnvironmentError } from './errors.ts'

const metadataPrefix = '// dsh-environment-daemon '
const metadataSchema = z.object({ version: z.string().min(1), protocol: z.number().int().positive(), node: z.string().min(1) }).strict()
const errorCodes = [
  'ENVIRONMENT_SSH_NODE_NOT_FOUND', 'ENVIRONMENT_SSH_DEPENDENCY_MISSING', 'ENVIRONMENT_SSH_NODE_UNSUPPORTED',
  'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE', 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED',
] as const

/** Installed daemon source and the metadata required for remote verification. */
export interface DaemonBundle {
  /** Complete UTF-8 JavaScript artifact, including its first-line metadata. */
  readonly source: string
  /** Exact package version. */
  readonly version: string
  /** Wire protocol version. */
  readonly protocol: number
  /** Required Node engine range. */
  readonly node: string
  /** Lowercase SHA-256 digest of the complete UTF-8 source. */
  readonly digest: string
}

/**
 * Read the installed environment package's daemon artifact without executing it.
 * @returns source, validated first-line metadata, and its SHA-256 digest.
 * @throws SshEnvironmentError when the artifact is unavailable or its banner is invalid.
 */
export async function loadDaemon(): Promise<DaemonBundle> {
  try {
    const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-environment/daemon.js')), 'utf8')
    const newline = source.indexOf('\n')
    const line = source.slice(0, newline)
    if (newline < 0 || !line.startsWith(metadataPrefix) || Buffer.byteLength(line) > 4096) throw new Error('missing or oversized daemon metadata banner')
    const metadata = metadataSchema.parse(JSON.parse(line.slice(metadataPrefix.length)))
    return { source, ...metadata, digest: createHash('sha256').update(source).digest('hex') }
  } catch (cause) {
    throw new SshEnvironmentError('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', 'Cannot read the installed environment daemon artifact. Reinstall the matching Harness package.', { cause })
  }
}

const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), daemonPath: z.string(), nodeVersion: z.string() }).strict(),
  z.object({ status: z.literal('missing'), daemonPath: z.string(), nodeVersion: z.string() }).strict(),
  z.object({ status: z.literal('existing'), daemonPath: z.string(), nodeVersion: z.string(), version: z.string(), protocol: z.number().int(), digest: z.string() }).strict(),
  z.object({ status: z.literal('error'), code: z.enum(errorCodes), message: z.string(), daemonPath: z.string().optional(), nodeVersion: z.string() }).strict(),
])

// This script runs in a separate Node process; the daemon source is only read as bytes.
const remoteScript = String.raw`
const request = JSON.parse(process.argv[1]);
let daemonPath = request.daemonPath;
const report = (value) => process.stdout.write(JSON.stringify({ ...value, daemonPath, nodeVersion: process.versions.node }) + '\n');
const fail = (code, message) => { const error = new Error(message); error.bootstrapCode = code; throw error; };
try {
  const dependencies = {};
  for (const name of ['fs', 'fs/promises', 'path', 'crypto', 'os', 'stream', 'util', 'v8', 'vm', 'child_process', 'worker_threads']) {
    try { dependencies[name] = require('node:' + name); }
    catch (error) { fail('ENVIRONMENT_SSH_DEPENDENCY_MISSING', 'Node builtin node:' + name + ' is unavailable: ' + error.message); }
  }
  const { fs, path, crypto, os } = dependencies;
  daemonPath = daemonPath || path.join(os.homedir(), '.cache', 'dsh', 'environment', 'daemon.js');
  const incompatible = (detail) => fail('ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE', daemonPath + ': ' + detail + '. Choose an absent daemon path or remove the incompatible file after inspection.');
  const inspect = () => {
    let stat;
    try { stat = fs.lstatSync(daemonPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) incompatible('expected a regular file without a symlink');
    const fd = fs.openSync(daemonPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) incompatible('expected a regular file');
      const first = Buffer.alloc(4096);
      const count = fs.readSync(fd, first, 0, first.length, 0);
      const newline = first.subarray(0, count).indexOf(10);
      const prefix = '// dsh-environment-daemon ';
      if (newline < 0) incompatible('missing or oversized daemon metadata banner');
      const line = first.subarray(0, newline).toString('utf8');
      if (!line.startsWith(prefix)) incompatible('unrecognized daemon metadata banner');
      let metadata;
      try { metadata = JSON.parse(line.slice(prefix.length)); }
      catch (error) { incompatible('invalid daemon metadata JSON: ' + error.message); }
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).sort().join(',') !== 'node,protocol,version'
        || typeof metadata.version !== 'string' || !Number.isInteger(metadata.protocol) || typeof metadata.node !== 'string') incompatible('invalid daemon metadata fields');
      const digest = crypto.createHash('sha256');
      const chunk = Buffer.alloc(65536);
      let position = 0;
      for (;;) {
        const bytes = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (bytes === 0) break;
        digest.update(chunk.subarray(0, bytes));
        position += bytes;
      }
      const actual = digest.digest('hex');
      return { version: metadata.version, protocol: metadata.protocol, digest: actual };
    } finally { fs.closeSync(fd); }
  };
  const matches = (current) => current !== null && current.version === request.version && current.protocol === request.protocol && current.digest === request.digest;
  const initial = inspect();
  if (request.mode === 'probe') {
    report(initial === null ? { status: 'missing' } : { status: 'existing', ...initial });
  } else if (matches(initial)) {
    report({ status: 'ready' });
  } else {
    const source = fs.readFileSync(0);
    const actual = crypto.createHash('sha256').update(source).digest('hex');
    if (actual !== request.digest) fail('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', 'Upload SHA-256 mismatch: expected ' + request.digest + ', found ' + actual);
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true, mode: 0o700 });
    const temporary = daemonPath + '.upload-' + crypto.randomUUID();
    const fd = fs.openSync(temporary, 'wx', 0o600);
    const lock = daemonPath + '.install-lock';
    let locked = false;
    try {
      try { fs.writeFileSync(fd, source); } finally { fs.closeSync(fd); }
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!matches(inspect())) fail('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', 'Daemon installation is busy at ' + lock + '. Retry after the installer finishes; inspect a leftover lock before removing it.');
      }
      if (locked) {
        const current = inspect();
        if (!matches(current)) {
          if (current === null) {
            try { fs.linkSync(temporary, daemonPath); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          } else if (current.version === request.previousVersion && current.digest === request.previousDigest) {
            fs.renameSync(temporary, daemonPath);
          } else incompatible('daemon changed during installation; retry to check its version');
          if (!matches(inspect())) incompatible('published daemon does not match the requested version and digest');
        }
      }
      report({ status: 'ready' });
    } finally {
      try { fs.rmSync(temporary, { force: true }); } finally { if (locked) fs.rmdirSync(lock); }
    }
  }
} catch (error) {
  report({ status: 'error', code: error.bootstrapCode || 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', message: error.message });
}
`

/**
 * Resolve the remote daemon path, install a missing daemon or atomically upgrade a lower version.
 * Matching releases must have the expected protocol and digest; newer and unrecognized files fail unchanged.
 * A publication lock prevents concurrent installers from downgrading a newer release.
 * @param run - strict-host-key SSH command runner; omitted input leaves stdin unused.
 * @param config - destination, Node executable, and optional absolute daemon path.
 * @param bundle - locally loaded daemon artifact.
 * @param signal - cancellation checked before each remote phase and after it settles.
 * @returns the resolved absolute destination after successful verification or installation.
 * @throws SshEnvironmentError for incompatible prerequisites, artifacts, or failed installation.
 */
export async function bootstrapDaemon(
  run: (command: string, input?: string) => Promise<SshCommandResult>,
  config: { readonly host: string; readonly node: string; readonly daemonPath?: string | undefined },
  bundle: DaemonBundle,
  signal: AbortSignal,
): Promise<string> {
  let daemonPath = config.daemonPath
  const phase = async (mode: 'probe' | 'upload', previous?: { readonly version: string; readonly digest: string }) => {
    signal.throwIfAborted()
    const request = JSON.stringify({
      mode, daemonPath, version: bundle.version, protocol: bundle.protocol, digest: bundle.digest,
      previousVersion: previous?.version, previousDigest: previous?.digest,
    })
    const executable = shellQuote(config.node)
    const command = `command -v ${executable} >/dev/null 2>&1 || { printf '%s\\n' 'DSH_NODE_NOT_FOUND' >&2; exit 127; }; exec ${executable} -e ${shellQuote(remoteScript)} ${shellQuote(request)}`
    let result: SshCommandResult
    try {
      result = await run(command, mode === 'upload' ? bundle.source : undefined)
    } catch (cause) {
      signal.throwIfAborted()
      throw new SshEnvironmentError('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', `SSH daemon bootstrap on ${config.host} failed. Check the SSH connection and destination permissions.`, { cause })
    }
    signal.throwIfAborted()
    if (result.exitCode === 127 && result.stderr.trim() === 'DSH_NODE_NOT_FOUND') {
      throw new SshEnvironmentError('ENVIRONMENT_SSH_NODE_NOT_FOUND', `Node executable ${config.node} was not found on ${config.host}. Install Node ${bundle.node} or configure its executable path.`)
    }
    try {
      if (result.exitCode !== 0) throw new Error(`SSH exited with code ${result.exitCode}: ${result.stderr}`)
      const response = responseSchema.parse(JSON.parse(result.stdout))
      if (!satisfies(response.nodeVersion, bundle.node)) {
        throw new SshEnvironmentError('ENVIRONMENT_SSH_NODE_UNSUPPORTED', `Node ${response.nodeVersion} on ${config.host} is unsupported; expected ${bundle.node}. Configure a supported Node executable.`)
      }
      if (response.status === 'error') throw new SshEnvironmentError(response.code, `SSH daemon bootstrap on ${config.host}: ${response.message}`)
      daemonPath = response.daemonPath
      return response
    } catch (cause) {
      if (cause instanceof SshEnvironmentError) throw cause
      throw new SshEnvironmentError('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', `Invalid daemon bootstrap response from ${config.host}: ${String(cause)}. Check the SSH connection and remote Node executable.`, { cause })
    }
  }
  const current = await phase('probe')
  if (current.status === 'existing') {
    if (current.version === bundle.version && current.protocol === bundle.protocol && current.digest === bundle.digest) {
      return current.daemonPath
    }
    if (valid(current.version) === null || !lt(current.version, bundle.version)) {
      throw new SshEnvironmentError('ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE', `Daemon on ${config.host} at ${current.daemonPath}: expected version ${bundle.version} protocol ${bundle.protocol}, found version ${current.version} protocol ${current.protocol}. Equal versions must match the bundle digest; newer or unrecognized files are not replaced.`)
    }
  }
  const installed = await phase('upload', current.status === 'existing' ? current : undefined)
  if (installed.status !== 'ready') {
    throw new SshEnvironmentError('ENVIRONMENT_SSH_BOOTSTRAP_FAILED', `Daemon upload to ${config.host} did not publish the daemon.`)
  }
  return installed.daemonPath
}
