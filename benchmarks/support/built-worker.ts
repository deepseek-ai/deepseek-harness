/** Plain-Node launcher for compiled benchmark workers. */

import { spawn } from 'node:child_process'

/** Process outcome and optional JSON report from one compiled benchmark worker. */
export interface BuiltBenchmarkWorkerRun<Report> {
  readonly report: Report | undefined
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly stderr: string
}

/** Options for one isolated compiled benchmark process. */
export interface BuiltBenchmarkWorkerOptions {
  readonly worker: string
  readonly args?: readonly string[]
  readonly timeoutMs: number
  readonly exposeGc?: boolean
  readonly heapLimitMb?: number
}

/**
 * Run one built JavaScript worker without a TypeScript runtime loader.
 * @param options - worker path, arguments, deadline, and optional V8 limits.
 * @returns child exit details and its final JSON-line report when successful.
 */
export function runBuiltBenchmarkWorker<Report>(
  options: BuiltBenchmarkWorkerOptions,
): Promise<BuiltBenchmarkWorkerRun<Report>> {
  if (!options.worker.endsWith('.js') && !options.worker.endsWith('.cjs')) {
    throw new Error(`benchmark worker must be compiled JavaScript: ${options.worker}`)
  }
  const env = { ...process.env }
  delete env['NODE_OPTIONS']
  delete env['TSX_TSCONFIG_PATH']
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...options.exposeGc === true ? ['--expose-gc'] : [],
      ...options.heapLimitMb === undefined
        ? []
        : [`--max-old-space-size=${String(options.heapLimitMb)}`],
      options.worker,
      ...options.args ?? [],
    ], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      const line = stdout.trim().split('\n').findLast(candidate => candidate.startsWith('{'))
      try {
        const report = exitCode === 0 && line !== undefined
          ? JSON.parse(line) as Report
          : undefined
        resolve({ report, exitCode, signal, timedOut, stderr })
      } catch (error: unknown) {
        reject(error)
      }
    })
  })
}

/**
 * Reject a benchmark worker reached through source execution or a TypeScript loader.
 * @param moduleUrl - `import.meta.url` from the worker entry.
 * @param packageEntries - resolved production package entries used by the measured path.
 */
export function assertBuiltBenchmarkRuntime(
  moduleUrl: string,
  packageEntries: Readonly<Record<string, string>>,
): void {
  if (!moduleUrl.endsWith('.js') || !moduleUrl.includes('/benchmarks/.dsh-build/')) {
    throw new Error(`benchmark worker is not running from benchmarks/.dsh-build: ${moduleUrl}`)
  }
  const tsRuntime = process.execArgv.find(argument => /(?:^|[/\\])tsx(?:[/\\]|$)|tsx\/esm|tsx\/cjs/.test(argument))
  if (tsRuntime !== undefined) throw new Error(`benchmark worker received a TypeScript loader: ${tsRuntime}`)
  for (const [specifier, entry] of Object.entries(packageEntries)) {
    if (!/\/lib\/(?:[^/]+\/)*[^/]+\.js$/.test(entry)) {
      throw new Error(`benchmark package ${specifier} did not resolve to lib JavaScript: ${entry}`)
    }
  }
}
