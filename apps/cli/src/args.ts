/**
 * Commander adapter for the `dsh` command line.
 *
 * The launcher parses only what it owns — which profile to boot, which extra
 * patch overlays to apply, and the config dumps — and hands **everything after
 * its own flags** to the booted tree verbatim, where injected app plugins parse
 * their own flag families and print their own `--help` (see
 * `@deepseek-ai/dsh-cmdline`). Launcher flags therefore come first: the first
 * token this parser does not recognize starts the inner arguments, so
 * `dsh --profile tui --resume abc` boots the tui profile with `--resume abc`,
 * and `dsh --profile web -h` prints the web app's help, not this one's.
 *
 * `dsh <name>` abbreviates `dsh --profile <name>`; `plugin` manages a profile's
 * plugin dependencies by forwarding to pnpm.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
  patches: string[]
}

/** Print declared plugin schemas without mounting the profile. */
interface DumpConfigSchemaInvocation {
  mode: 'dump-config-schema'
  profile: string
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  patches: string[]
}

/** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** Raw pnpm arguments, verbatim. */
  args: string[]
}

/** The resolved `dsh` invocation. Help, version, and errors exit inside {@link parseDshArgs}. */
export type DshInvocation = ProfileInvocation | DumpConfigInvocation | DumpConfigSchemaInvocation | PluginInvocation

/** Launcher flags for profile boot and configuration dumps. */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
  dumpConfigSchema?: boolean
  fromDefaultProfile?: string
}

/**
 * Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
 * variadic — a variadic `--patch` would swallow the inner arguments.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

function selectProfile(value: string, previous?: string): string {
  if (previous !== undefined) throw new InvalidArgumentError('select a profile only once')
  return value
}

function rejectElectronProfile(program: Command, profile: string): void {
  if (profile.toLowerCase() === 'desktop') {
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
  }
}

/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
                                            create rescue from the shipped web template, then boot it
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  dsh tui --resume <session>                arguments after the launcher flags reach the app
  dsh web --help                            the web app's own flags and help
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
`

/**
 * Resolve a boot or dump invocation from the launcher flags and the leftover
 * inner arguments.
 * @param program - the command whose options were parsed.
 * @param profile - the profile these flags boot.
 * @param options - the launcher flags commander collected.
 * @param args - the leftover arguments, in argv order.
 * @returns the resolved invocation.
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.fromDefaultProfile === '') program.error('error: --from-default-profile needs a name')
  const dumps = [options.dumpConfig, options.dumpDefaultConfig, options.dumpConfigSchema].filter(Boolean)
  if (dumps.length === 0) {
    return { mode: 'profile', profile, fromDefaultProfile: options.fromDefaultProfile, patches, args }
  }
  if (dumps.length > 1) {
    program.error('error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  if (options.dumpConfigSchema === true) {
    return { mode: 'dump-config-schema', profile, fromDefaultProfile: options.fromDefaultProfile, patches }
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, fromDefaultProfile: options.fromDefaultProfile, defaultOnly, patches }
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @returns the resolved invocation.
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  const first = argv[0]
  let resolved: DshInvocation | undefined
  // Annotated, not inferred: the actions below call back into `program`, and an
  // inferred type would be circular through its own chain.
  const program: Command = new Command()
  program
    .name('dsh')
    .version(version, '-V, --version', 'output the version number')
    .usage('[--profile] <name> [options] [app-args...]\n       dsh plugin --profile <name> <pnpm-args...>')
    .description('dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // The launcher's flags come first and end at the first token it does not
    // know; everything from there on belongs to the booted app, including
    // its -h. `dsh -h` with no profile still prints this help, below.
    .helpOption(false)
    .helpCommand(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the booted profile\'s app (see: dsh --profile <name> --help)')
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot', selectProfile)
    .option('--from-default-profile <name>', 'initialize a new custom profile from a shipped profile template')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed profile tree and exit')
    .option('--dump-config-schema', 'print JSON Schema for profile entries and patches without mounting')
    .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // With the app owning -h, the launcher's own help is what a bare
      // `dsh -h` (no profile to hand it to) must print.
      if (options.profile === undefined) {
        if (args.some(argument => argument === '-h' || argument === '--help')) program.help()
        program.error('error: --profile <name> is required')
      }
      const profile = options.profile
      if (profile === '') program.error('error: --profile needs a name')
      rejectElectronProfile(program, profile)
      resolved = resolveBoot(program, profile, options, args)
    })

  if (first === 'plugin') {
    const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
    plugin
      .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)', selectProfile)
      .allowUnknownOption()
      .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
      .action((args: string[], options: { profile: string }) => {
        if (options.profile === '') program.error('error: --profile needs a name')
        rejectElectronProfile(plugin, options.profile)
        if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
        resolved = { mode: 'plugin', profile: options.profile, args }
      })
  }

  try {
    const expanded = first !== undefined && !first.startsWith('-') && first !== 'plugin'
      ? ['--profile', ...argv]
      : argv
    program.parse(expanded, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
