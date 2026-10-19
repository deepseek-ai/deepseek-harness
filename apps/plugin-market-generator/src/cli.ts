/**
 * Reference plugin market index generator.
 *
 * Usage: plugin-market-generator --input <list> --output <index.json> --title <text> [options]
 *
 * The list holds one npm package name or https Git repository URL per line. The generator lists every npm bundle
 * version that is neither deprecated nor private, and the versions at Git release tags and the default branch of
 * packages that are not private, never runs package code, and writes a validated format-1 index. Unchanged releases
 * and commits are read from the cache directory, and the index file is rewritten only when its content changes.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { MAX_INLINE_ICON_BYTES } from '@deepseek-ai/dsh-plugin-market-index'
import { writeIfChanged } from './files.ts'
import { generate } from './generate.ts'
import { GENERATED_ICON } from './metadata.ts'
import { parseSources } from './sources.ts'

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

/** Parsed command-line options. */
interface Options {
  readonly input: string
  readonly output: string
  readonly title: string
  readonly description?: string
  readonly cache?: string
  readonly registry: string
  readonly inlineIconBytes: number
  readonly concurrency: number
  readonly timeoutMs: number
}

/** A positive integer option value, at most `max` when one is given. */
function integer(max?: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
      throw new InvalidArgumentError(`must be a positive integer${max === undefined ? '' : ` up to ${String(max)}`}`)
    }
    return parsed
  }
}

function program(): Command {
  return new Command('plugin-market-generator')
    .description('Write a plugin market index from a list of npm packages and Git repositories.')
    .requiredOption('--input <file>', 'source list: one npm package name or https Git URL per line; lines starting with # are comments')
    .requiredOption('--output <file>', 'index file to write; large icons go to icons/ beside it, and stale generated icons there are removed')
    .requiredOption('--title <text>', 'market title')
    .option('--description <text>', 'market description')
    .option('--cache <dir>', 'cache directory (default: .plugin-market-cache beside the input list)')
    .option('--registry <url>', 'npm registry', PUBLIC_REGISTRY)
    .addOption(new Option('--inline-icon-bytes <n>', `largest icon embedded as a data URL, at most ${String(MAX_INLINE_ICON_BYTES)}`)
      .argParser(integer(MAX_INLINE_ICON_BYTES)).default(16384))
    .addOption(new Option('--concurrency <n>', 'sources read at once').argParser(integer()).default(4))
    .addOption(new Option('--timeout-ms <n>', 'deadline for one request or git command').argParser(integer()).default(60000))
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', '\nExit status: 0 when every source was read, 1 when some source fell back to its cached result or was omitted,\n2 for invalid arguments or input.')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
}

async function run(options: Options): Promise<number> {
  // `pnpm --filter … start` runs in the package directory; paths are relative to where the user ran pnpm.
  const base = process.env.INIT_CWD ?? process.cwd()
  const input = resolve(base, options.input)
  const output = resolve(base, options.output)
  const registry = new URL(options.registry).href.replace(/\/?$/u, '/')
  const result = await generate({
    sources: parseSources(readFileSync(input, 'utf8')),
    cacheDir: options.cache === undefined ? join(dirname(input), '.plugin-market-cache') : resolve(base, options.cache),
    registry,
    recordRegistry: registry !== PUBLIC_REGISTRY,
    title: options.title,
    ...options.description === undefined ? {} : { description: options.description },
    inlineIconBytes: options.inlineIconBytes,
    limits: { timeoutMs: options.timeoutMs, maxTarballBytes: 64 * 1024 * 1024 },
    concurrency: options.concurrency,
    warn: (message) => { console.error(`warning: ${message}`) },
  })
  for (const [path, cached] of result.icons) writeIfChanged(join(dirname(output), path), readFileSync(cached))
  const iconDir = join(dirname(output), 'icons')
  for (const name of existsSync(iconDir) ? readdirSync(iconDir) : []) {
    const file = join(iconDir, name)
    if (GENERATED_ICON.test(name) && !result.icons.has(`icons/${name}`) && lstatSync(file).isFile()) rmSync(file, { force: true })
  }
  const changed = writeIfChanged(output, `${JSON.stringify(result.index, null, 2)}\n`)
  const plugins = result.index.plugins.length
  console.log(`${changed ? 'wrote' : 'unchanged'} ${output}: ${plugins} plugin(s), ${result.failures.length} failed source(s)`)
  return result.failures.length === 0 ? 0 : 1
}

/**
 * Run the generator.
 * @param argv - command-line arguments after the program name.
 * @returns the process exit status.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: Options
  try {
    options = program().parse([...argv], { from: 'user' }).opts<Options>()
  } catch (error) {
    // Commander has already printed the help or the parse error.
    if (!(error instanceof CommanderError)) throw error
    return error.code === 'commander.helpDisplayed' ? 0 : 2
  }
  try {
    return await run(options)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
}
