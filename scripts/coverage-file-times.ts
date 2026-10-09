/** Record coverage partition file costs without retaining test results or coverage maps. */
import { writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { Reporter, ResolvedConfig, TestModule } from 'vitest/node'

/** Vitest reporter that writes repository-relative file durations to `outputFile.fileTimes`. */
export default class CoverageFileTimesReporter implements Reporter {
  private root = ''
  private outputFile = ''

  /**
   * Resolve the timing output owned by the coverage coordinator.
   * @param vitest - repository root and configured reporter output files.
   * @throws when the file-times output is absent.
   */
  public onInit(vitest: { config: Pick<ResolvedConfig, 'root' | 'outputFile'> }): void {
    const output = vitest.config.outputFile
    if (typeof output !== 'object' || typeof output.fileTimes !== 'string' || output.fileTimes === '') {
      throw new Error('coverage-file-times: outputFile.fileTimes is required.')
    }
    this.root = vitest.config.root
    this.outputFile = resolve(this.root, output.fileTimes)
  }

  /**
   * Write each file's distinct environment, preparation, setup, collection, and execution costs.
   * @param testModules - finished files, including failed and skipped files.
   * @returns after the compact timing report has been written.
   */
  public async onTestRunEnd(testModules: readonly Pick<TestModule, 'moduleId' | 'diagnostic'>[]): Promise<void> {
    const durations: Record<string, number> = {}
    for (const module of testModules) {
      const diagnostic = module.diagnostic()
      const file = relative(this.root, module.moduleId).split(sep).join('/')
      durations[file] = diagnostic.environmentSetupDuration
        + diagnostic.prepareDuration
        + diagnostic.setupDuration
        + diagnostic.collectDuration
        + diagnostic.duration
    }
    await writeFile(this.outputFile, `${JSON.stringify(durations)}\n`, 'utf8')
  }
}
