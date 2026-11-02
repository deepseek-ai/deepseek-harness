#!/usr/bin/env node
/** Installed CLI entry. Resolve Windows path aliases before loading runtime dependencies. */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const implementation = new URL('./cli.js', process.platform === 'win32'
  ? pathToFileURL(realpathSync.native(import.meta.filename))
  : import.meta.url)
const cli: typeof import('./bin.ts') = await import(implementation.href)

/** Run the installed CLI with the options supplied by the hosting application. */
export const runCli = cli.runCli

if (import.meta.main) await runCli()
