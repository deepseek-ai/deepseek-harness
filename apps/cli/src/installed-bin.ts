#!/usr/bin/env node
/**
 * Installed CLI entry for disk launchers and embedded runtimes.
 * @module @deepseek-ai/dsh/installed-bin
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { RunCliOptions } from './bin.ts'

/**
 * Run the CLI in the importing carrier's module tree.
 * @param options - Installation-owned runtime options.
 * @returns Settlement of the selected command.
 */
export async function runCli(options?: RunCliOptions): Promise<void> {
  const cli = await import('./bin.ts')
  await cli.runCli(options)
}

if (import.meta.main) {
  // Windows ESM can retain an 8.3 spelling while profile resolution expands it.
  const entry = process.platform === 'win32' ? pathToFileURL(realpathSync.native(import.meta.filename)).href : import.meta.url
  if (entry === import.meta.url) await runCli()
  else {
    const canonical: typeof import('./installed-bin.ts') = await import(entry)
    await canonical.runCli()
  }
}
