/** Real Host environment collection through the shipped profile and isolated OTLP receiver. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { totalmem, cpus, platform } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-client-product-analytics'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('environment fixture requires its overlay')
const captures: unknown[] = []
const receiver = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  req.on('end', () => { captures.push(JSON.parse(Buffer.concat(chunks).toString())); res.end('{}') })
})
const run = promisify(execFile)
const reference: Record<string, string | number> = { memory_total_bytes: totalmem(), cpu_logical_count: cpus().length }
try {
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const address = receiver.address()
  if (address === null || typeof address === 'string') throw new Error('environment collector has no port')
  process.env.DSH_PRODUCT_TELEMETRY_TEST_ENDPOINT = `http://127.0.0.1:${address.port}/logs`
  const ctx = await bootProductionProfile({ binName: 'environment-test', profile: 'headless', overlayPaths: [overlay],
    prepare: (root) => { root.provide('deepseekAccount', { getDeviceIdentity: async () => undefined } as never) },
  })
  try {
    const analytics = ctx.get('productAnalytics')
    if (analytics === undefined) throw new Error('environment analytics did not mount')
    await analytics.report({ eventName: 'desktop_app_launch', timestamp: 1_800_000_000_000, attributes: {} })
  } finally { await ctx.fiber.dispose() }
  if (platform() === 'darwin') {
    const productVersion = (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()
    const { stdout: productInfo } = await run('/usr/bin/sw_vers', [])
    const extra = productInfo.match(/^ProductVersionExtra:\s*(\([a-z]\))/m)?.[1]
    reference.os_version_full = extra === undefined || productVersion.endsWith(extra)
      ? productVersion : `${productVersion} ${extra}`
    reference.os_build = (await run('/usr/bin/sw_vers', ['-buildVersion'])).stdout.trim()
    reference.cpu_physical_core_count = Number((await run('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu'])).stdout.trim())
    reference.os_arch = (await run('/usr/sbin/sysctl', ['-i', '-n', 'hw.optional.arm64'])).stdout.trim() === '1' ? 'arm64' : 'x64'
  } else if (platform() === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) throw new Error('Windows fixture requires SystemRoot')
    const script = `
$r = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name CurrentMajorVersionNumber,CurrentMinorVersionNumber,CurrentBuildNumber,UBR
Write-Output "$($r.CurrentMajorVersionNumber).$($r.CurrentMinorVersionNumber).$($r.CurrentBuildNumber).$($r.UBR)"
Write-Output $r.CurrentBuildNumber
Write-Output ((Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum)
Write-Output (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Architecture)
`
    const { stdout } = await run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    const [version, build, cores, architecture] = stdout.trim().split(/\r?\n/)
    if (version === undefined || build === undefined) throw new Error('Windows fixture returned no version')
    reference.os_version_full = version
    reference.os_build = build
    reference.cpu_physical_core_count = Number(cores)
    reference.os_arch = ({ 0: 'ia32', 5: 'arm', 9: 'x64', 12: 'arm64' } as Record<number, string>)[Number(architecture)]!
  }
  await writeFile('captures.json', JSON.stringify({ captures, reference }))
} finally {
  const closed = once(receiver, 'close')
  receiver.close()
  receiver.closeAllConnections()
  await closed
}
