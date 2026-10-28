/** Static Desktop environment fields, independent of account and credential availability. */
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { queryEnvironment, type MissingReason, type QueryOptions, type QueryResult } from './environment-query.ts'

/** Approved scalar attributes; missing fields carry fixed reasons. */
export interface EnvironmentAttributes {
  /** Platform name: windows, macos, or the unsupported Node platform. */
  os_name: string
  /** Legacy platform and kernel release string. */
  os_version?: string
  /** Windows major.minor.build.revision or macOS product version. */
  os_version_full?: string
  /** Windows build or macOS product build. */
  os_build?: string
  /** Native system architecture, independent of process emulation. */
  os_arch?: string
  /** Architecture of the running application binary. */
  app_arch: string
  /** Model reported by the first logical processor. */
  cpu_model?: string
  /** System-reported logical processor count, not available parallelism. */
  cpu_logical_count?: number
  /** Total physical cores across CPU sockets; never inferred from logical processors. */
  cpu_physical_core_count?: number
  /** Total physical memory in bytes. */
  memory_total_bytes?: number
  /** Only failed fields, with no raw commands, output, or errors. */
  missing_fields: Partial<Record<EnvironmentField, MissingReason>>
}

type EnvironmentField = Exclude<keyof EnvironmentAttributes, 'missing_fields' | 'os_name' | 'app_arch'>

const windowsVersion = z.object({
  major: z.number().int().nonnegative().nullable(), minor: z.number().int().nonnegative().nullable(),
  build: z.string().regex(/^\d+$/).nullable(), revision: z.number().int().nonnegative().nullable(),
})
const windowsCpu = z.array(z.object({ cores: z.number().int().positive().nullable(), architecture: z.number().int().nullable() })).min(1)

const VERSION_QUERY = `
$ErrorActionPreference = 'Stop'
$r = Get-Item -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
@{ major = $r.GetValue('CurrentMajorVersionNumber'); minor = $r.GetValue('CurrentMinorVersionNumber'); build = $r.GetValue('CurrentBuildNumber'); revision = $r.GetValue('UBR') } | ConvertTo-Json -Compress
`
const CPU_QUERY = `
$ErrorActionPreference = 'Stop'
ConvertTo-Json -Compress -InputObject @(Get-CimInstance -ClassName Win32_Processor -Property NumberOfCores,Architecture | ForEach-Object { @{ cores = $_.NumberOfCores; architecture = $_.Architecture } })
`

/**
 * Collect only approved metadata; a failed source leaves its dependent fields missing.
 * @param options - per-command bounds and analytics disposal signal.
 * @returns a snapshot for reuse throughout this analytics instance, including failed fields.
 */
export async function collectEnvironment(options: QueryOptions): Promise<EnvironmentAttributes> {
  const hostPlatform = platform()
  const fields: EnvironmentAttributes = {
    os_name: hostPlatform === 'darwin' ? 'macos' : hostPlatform === 'win32' ? 'windows' : hostPlatform,
    app_arch: process.arch, missing_fields: {},
  }
  const missing = (keys: readonly EnvironmentField[], reason: MissingReason): void => {
    for (const key of keys) fields.missing_fields[key] = reason
  }
  const read = <K extends EnvironmentField>(key: K, source: () => EnvironmentAttributes[K]): void => {
    let value: EnvironmentAttributes[K]
    try { value = source() } catch (_error) {
      // The failed OS source cannot invalidate independently collected fields.
      missing([key], 'unavailable'); return
    }
    if (value === undefined || value === '' || (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))) {
      missing([key], 'unavailable'); return
    }
    Object.assign(fields, { [key]: value })
  }
  read('os_version', () => `${hostPlatform} ${release()}`)
  read('memory_total_bytes', totalmem)
  let processors: ReturnType<typeof cpus> = []
  try { processors = cpus() } catch (_error) {
    // CPU metadata is optional; memory and OS collection remain usable.
  }
  read('cpu_model', () => processors[0]?.model.trim())
  read('cpu_logical_count', () => processors.length)

  if (hostPlatform === 'win32') {
    const root = process.env.SystemRoot
    if (root === undefined || root === '') {
      missing(['os_version_full', 'os_build', 'os_arch', 'cpu_physical_core_count'], 'unavailable')
      return fields
    }
    const command = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const query = (script: string): Promise<QueryResult> => queryEnvironment(command,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options)
    const [version, cpu] = await Promise.all([query(VERSION_QUERY), query(CPU_QUERY)])
    if (version.kind === 'missing') missing(['os_version_full', 'os_build'], version.reason)
    else {
      const parsed = decode(version.stdout, windowsVersion)
      if (parsed === undefined) missing(['os_version_full', 'os_build'], 'invalid-value')
      else {
        if (parsed.build === null) missing(['os_build'], 'unavailable')
        else fields.os_build = parsed.build
        if (parsed.major === null || parsed.minor === null || parsed.build === null || parsed.revision === null) missing(['os_version_full'], 'unavailable')
        else fields.os_version_full = `${parsed.major}.${parsed.minor}.${parsed.build}.${parsed.revision}`
      }
    }
    if (cpu.kind === 'missing') missing(['os_arch', 'cpu_physical_core_count'], cpu.reason)
    else {
      const parsed = decode(cpu.stdout, windowsCpu)
      if (parsed === undefined) missing(['os_arch', 'cpu_physical_core_count'], 'invalid-value')
      else {
        const counts = parsed.map(value => value.cores)
        if (counts.every((count): count is number => count !== null)) read('cpu_physical_core_count', () => counts.reduce((sum, count) => sum + count, 0))
        else missing(['cpu_physical_core_count'], 'unavailable')
        const architectures: Record<number, string> = { 0: 'ia32', 5: 'arm', 9: 'x64', 12: 'arm64' }
        const arch = parsed[0]?.architecture
        if (arch == null || !parsed.every(value => value.architecture === arch) || architectures[arch] === undefined) missing(['os_arch'], 'unavailable')
        else fields.os_arch = architectures[arch]
      }
    }
  } else if (hostPlatform === 'darwin') {
    const [version, cpu] = await Promise.all([
      queryEnvironment('/usr/bin/sw_vers', [], options),
      queryEnvironment('/usr/sbin/sysctl', ['-i', 'hw.physicalcpu', 'hw.optional.arm64'], options),
    ])
    if (version.kind === 'missing') missing(['os_version_full', 'os_build'], version.reason)
    else {
      const values = lines(version.stdout)
      const product = values.get('ProductVersion')
      const extra = values.get('ProductVersionExtra') || undefined
      const match = product?.match(/^(\d+(?:\.\d+){1,2})(?: (\([a-z]\)))?$/)
      if (product !== undefined && match !== undefined && match !== null && (extra === undefined || /^\([a-z]\)$/.test(extra))
        && (match[2] === undefined || extra === undefined || match[2] === extra)) {
        const suffix = match[2] ?? extra
        fields.os_version_full = suffix === undefined ? product : `${match[1]} ${suffix}`
      } else missing(['os_version_full'], 'invalid-value')
      const build = values.get('BuildVersion')
      if (build !== undefined && /^\d+[A-Za-z]\d+[a-z]?$/.test(build)) fields.os_build = build
      else missing(['os_build'], 'invalid-value')
    }
    if (cpu.kind === 'missing') missing(['os_arch', 'cpu_physical_core_count'], cpu.reason)
    else {
      const values = lines(cpu.stdout)
      const cores = values.get('hw.physicalcpu')
      if (cores !== undefined && /^\d+$/.test(cores) && Number.isSafeInteger(Number(cores)) && Number(cores) > 0) {
        fields.cpu_physical_core_count = Number(cores)
      }
      else missing(['cpu_physical_core_count'], 'invalid-value')
      const arm = values.get('hw.optional.arm64')
      if (arm === '1') fields.os_arch = 'arm64'
      else if (arm === undefined || arm === '0') fields.os_arch = 'x64'
      else missing(['os_arch'], 'invalid-value')
    }
  } else {
    missing(['os_version_full', 'os_build', 'os_arch', 'cpu_physical_core_count'], 'unsupported')
  }
  return fields
}

function lines(stdout: string): Map<string, string> {
  return new Map(stdout.trim().split(/\r?\n/).map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  }))
}

function decode<T>(stdout: string, schema: z.ZodType<T>): T | undefined {
  let value: unknown
  try { value = JSON.parse(stdout) } catch (_error) {
    // Malformed command JSON supplies no validated metadata.
    return undefined
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
