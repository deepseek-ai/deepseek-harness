/** A Windows model shell must read installed documentation inside the Desktop archive through Electron's Node mode. */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { WriteStream } from 'node:fs'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: object) => Promise<WriteStream>
}

/** Reads a bounded line range below `DSH_INSTALL_DIR`; a missing file prints its code and exits 1. */
const READ_SCRIPT = `
const fs = require("node:fs"), path = require("node:path")
const [target, first = "1", count = "200"] = process.argv.slice(1)
const file = path.resolve(process.env.DSH_INSTALL_DIR, target)
try {
  const lines = fs.readFileSync(file, "utf8").split("\\n")
  const start = Math.max(1, Number(first)), end = Math.min(lines.length, start + Number(count) - 1)
  for (let n = start; n <= end; n++) console.log(\`\${n}\\t\${lines[n - 1].slice(0, 2000)}\`)
  if (end < lines.length) console.log(\`[\${lines.length - end} more lines]\`)
} catch (error) { console.error(\`\${error.code ?? "ERROR"}: \${file}\`); process.exitCode = 1 }
`

/**
 * The Electron executable is a GUI-subsystem program: PowerShell's call operator does not wait for it, so
 * captured output arrives empty and the exit code is not its own. The Windows form starts it as a .NET
 * process with redirected streams and waits for its exit code; the console encoding only lets this test
 * decode what the probe relays.
 */
const POWERSHELL_PROBE = `param([string]$Target, [string]$First, [string]$Count)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script = @'
${READ_SCRIPT}
'@
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
foreach ($argument in @('-e', $script, '--', $Target, $First, $Count)) { $start.ArgumentList.Add($argument) }
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
`

// macOS packaged-application coverage is manual; the POSIX form needs no output capture workaround.
it.skipIf(process.platform !== 'win32' || process.env.DSH_EXAMPLE_MODE !== 'lib')('reads archived documentation through the PowerShell form', { retry: 0 }, async () => {
  const electron = require('electron') as string
  const root = await mkdtemp(join(tmpdir(), 'dsh 文档 asar-'))
  try {
    const source = join(root, 'source')
    await mkdir(join(source, 'docs', 'upgrade-guide'), { recursive: true })
    await writeFile(join(source, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
    await writeFile(join(source, 'docs', 'upgrade-guide', 'README.md'), '# 升级指南\n\n第二行\n第三行\n')
    const archive = join(root, '安装 目录', 'app.asar')
    await mkdir(join(archive, '..'))
    await finished(await createPackageWithOptions(source, archive, {}))
    const probe = join(root, 'probe.ps1')
    await writeFile(probe, POWERSHELL_PROBE)
    const run = (target: string, first: string, count: string) => {
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', probe, target, first, count], {
        env: { ...process.env, DSH_NODE_EXECUTABLE: electron, DSH_INSTALL_DIR: archive },
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      return { status: result.status, stdout: result.stdout.replaceAll('\r\n', '\n'), stderr: result.stderr }
    }

    const read = run('docs/upgrade-guide/README.md', '1', '2')
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toBe('1\t# 升级指南\n2\t\n[3 more lines]\n')

    const missing = run('docs/upgrade-guide/missing.md', '1', '2')
    expect(missing.status).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain(`ENOENT: ${join(archive, 'docs', 'upgrade-guide', 'missing.md')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
