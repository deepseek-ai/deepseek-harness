/** Generate paired CLI references by invoking the shipped launcher and profile help. */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  computeTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'
import { parseTranslationPairingManifest, translationPairSourcePredicate } from './translation-pairing.ts'

const root = resolve(import.meta.dirname, '..')
const paths = translationPairPaths('docs/cli-help.md')
const execFileAsync = promisify(execFile)

/** Complete help text and the immediate subcommands it advertises. */
export interface CliHelp {
  /** Complete help text with LF line endings. */
  output: string
  /** Immediate command names and aliases listed in the `Commands:` section, in their displayed order. */
  commands: string[]
}

interface HelpPage {
  help: CliHelp
  invocations: [string, ...string[]]
  children: Map<string, HelpPage>
}

/**
 * Discover commands from actual text help while preserving every displayed line.
 * @param stdout - Successful CLI help output.
 * @returns Help text with LF line endings and the command names and aliases (`serve|s`) listed in its `Commands:` section.
 * @throws When the output is empty.
 */
export function parseCliHelp(stdout: string): CliHelp {
  const output = stdout.replaceAll('\r\n', '\n')
  if (output.trim() === '') throw new Error('CLI help returned empty output')
  const section = /^Commands:\n((?:[ \t][^\n]*\n|\n)*)/mu.exec(output)?.[1] ?? ''
  const commands = [...section.matchAll(/^ {2}\S+/gmu)].flatMap(match => match[0].slice(2).split('|'))
  return { output, commands }
}

// A `help [command]` row prints its parent's help, so a page can list itself as a child.
// An invocation that reaches a page already on the current path joins that page without
// extending its children, which keeps alias propagation finite.
function addAlias(page: HelpPage, invocation: string, path: ReadonlySet<HelpPage>): void {
  if (page.invocations.includes(invocation)) return
  page.invocations.push(invocation)
  if (path.has(page)) return
  const childPath = new Set([...path, page])
  for (const [name, child] of page.children) addAlias(child, `${invocation} ${name}`, childPath)
}

/**
 * Collect launcher, plugin, and profile help even when root help lists no commands.
 * @param readHelp - run one help invocation and return its complete stdout.
 * @param profiles - shipped profile names whose explicit and shorthand forms must be documented.
 * @returns distinct help pages with every discovered invocation and nested command.
 */
export async function collectCliHelp(
  readHelp: (args: readonly string[]) => Promise<string>, profiles: readonly string[],
): Promise<HelpPage[]> {
  const pages = new Map<string, HelpPage>()
  const visit = async (args: string[], path: ReadonlySet<HelpPage>): Promise<HelpPage> => {
    const invocation = ['dsh', ...args].join(' ')
    const help = parseCliHelp(await readHelp(args))
    const existing = pages.get(help.output)
    if (existing !== undefined) {
      addAlias(existing, invocation, path)
      return existing
    }
    const page: HelpPage = { help, invocations: [invocation], children: new Map() }
    pages.set(help.output, page)
    const childPath = new Set([...path, page])
    for (const name of help.commands) page.children.set(name, await visit([...args, name], childPath))
    return page
  }
  const top = new Set<HelpPage>()
  await visit([], top)
  await visit(['plugin'], top)
  for (const profile of [...profiles].sort()) {
    await visit([profile], top)
    await visit(['--profile', profile], top)
  }
  return [...pages.values()]
}

async function collectHelp(): Promise<HelpPage[]> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cli-help-'))
  const environment = {
    ...process.env,
    DSH_HOME: join(directory, 'harness'),
    DSH_AGENTS_HOME: join(directory, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  }
  for (const name of ['NODE_OPTIONS', 'FORCE_COLOR']) Reflect.deleteProperty(environment, name)
  try {
    return await collectCliHelp(async (args) => {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        '--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args, '--help',
      ], {
        cwd: root, env: environment, encoding: 'utf8', timeout: 30_000,
        killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      })
      if (stderr !== '') throw new Error(`${['dsh', ...args].join(' ')} --help wrote diagnostics: ${stderr}`)
      return stdout
    }, Object.keys(PROFILE_TEMPLATES))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function anchor(page: HelpPage): string {
  return page.invocations[0].replaceAll(/[^a-zA-Z0-9]+/gu, '-').replace(/-$/u, '').toLowerCase()
}

function renderHelp(pages: readonly HelpPage[], chinese: boolean): string {
  const lines = [
    '<!-- Generated by scripts/gen-cli-help.ts — do not edit by hand.',
    '     Run `pnpm run gen-cli-help` to regenerate. -->',
    '',
    chinese ? '# dsh 命令行帮助' : '# dsh CLI help',
    '',
    ...(chinese ? ['[English](cli-help.md) | 中文', ''] : []),
    chinese
      ? '此参考收录启动器、子命令和随附 profile 的完整帮助。同一份帮助只展示一次，并列出所有调用方式。帮助输出保留原文。'
      : 'This reference contains complete help for the launcher, subcommands, and shipped profiles. Identical help appears once with every invocation listed. Help output retains its original language.',
    '',
    chinese
      ? '运行 `pnpm run gen-cli-help` 重新生成；运行 `pnpm run verify-cli-help` 检查是否与当前命令一致。'
      : 'Run `pnpm run gen-cli-help` to regenerate; run `pnpm run verify-cli-help` to check freshness.',
    '',
    chinese ? '## 目录' : '## Contents',
    '',
    ...pages.map(page => `- [\`${page.invocations[0]}\`](#${anchor(page)})`),
    '',
  ]
  for (const page of pages) {
    lines.push(
      `<a id="${anchor(page)}"></a>`,
      `## \`${page.invocations[0]}\``,
      '',
      `${chinese ? '调用方式' : 'Invocations'}: ${page.invocations.map(invocation => `\`${invocation} --help\``).join(', ')}`,
      '',
      `\`\`\`text\n${page.help.output}${page.help.output.endsWith('\n') ? '' : '\n'}\`\`\``,
      '',
    )
  }
  return lines.join('\n')
}

/** Regenerate both CLI reference pages, or check their bytes with --check. @returns Nothing. */
export async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const pages = await collectHelp()
  const source = renderHelp(pages, false)
  const zh = renderHelp(pages, true)
  const written = new Set([paths.source, paths.zh])
  const context = {
    repoRoot: root,
    isTranslationPairSource: translationPairSourcePredicate(parseTranslationPairingManifest(
      readFileSync(resolve(root, 'scripts/translation-pairing.manifest.json'), 'utf8'),
    )),
    // Resolve links between the two pages as this run writes them, so a first run
    // records the same hashes that verify-translation-pairing computes afterward.
    repositoryFileExists: (path: string) => written.has(path)
      || existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile(),
  }
  const outputs = new Map([
    [paths.source, source],
    [paths.zh, zh],
    [paths.meta, renderTranslationPairingRecord(paths, computeTranslationPairingRecord(paths, source, zh, context))],
  ])
  const changed: string[] = []
  for (const [path, content] of outputs) {
    const destination = resolve(root, path)
    if (existsSync(destination) && readFileSync(destination, 'utf8') === content) continue
    changed.push(path)
    if (!check) writeFileSync(destination, content)
  }
  if (check && changed.length > 0) {
    console.error(`gen-cli-help: stale — ${changed.join(', ')}. Run pnpm run gen-cli-help.`)
    process.exitCode = 1
  } else {
    console.log(`gen-cli-help: ${pages.length} help pages; ${check ? 'all outputs are current' : `${changed.length} files written`}.`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
