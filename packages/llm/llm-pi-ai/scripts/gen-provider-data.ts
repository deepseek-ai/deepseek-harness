/** Generate display metadata through pi-ai's public catalog and auth context. */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

interface ProviderData {
  env: readonly string[]
  defaultBaseURL?: string
  baseURLEnv?: readonly string[]
}

const printer = ts.createPrinter()
const sourceFile = ts.createSourceFile('provider-data.ts', '', ts.ScriptTarget.Latest)
const quote = (value: string): string => printer.printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(value, true), sourceFile)

// Endpoint variables read by API implementations, outside AuthContext and
// uppercase catalog URL placeholders. Keep exceptions here, not in the UI.
const SUPPLEMENTS: Readonly<Record<string, { baseURLEnv: readonly string[] }>> = {
  azure: { baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'] },
  'amazon-bedrock': { baseURLEnv: ['AWS_REGION', 'AWS_DEFAULT_REGION'] },
  'google-vertex': { baseURLEnv: ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'] },
}

/** Insert newly discovered names after their predecessor in the resolver. */
function merge(into: string[], sequence: readonly string[]): void {
  for (const [index, name] of sequence.entries()) {
    if (into.includes(name)) continue
    into.splice(index === 0 ? 0 : into.indexOf(sequence[index - 1]!) + 1, 0, name)
  }
}

/**
 * Discover resolver reads using only synthetic environment and file answers.
 * @param provider - Installed provider; no credential or login flow is used.
 * @returns Names observed across empty, individual and suffix configurations.
 */
export async function resolverEnv(provider: Provider): Promise<string[]> {
  const names: string[] = []
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${provider.id}: auth metadata probe timed out`)
      controller.abort(error)
      reject(error)
    }, 2000)
  })
  const reads = async (set: ReadonlySet<string>): Promise<string[]> => {
    const read: string[] = []
    await Promise.race([provider.auth.apiKey?.resolve({
      ctx: {
        env: (name) => {
          controller.signal.throwIfAborted()
          if (read.length >= 128) throw new Error(`${provider.id}: auth metadata probe exceeded its read limit`)
          read.push(name)
          return Promise.resolve(set.has(name) ? 'probe-value' : undefined)
        },
        fileExists: () => Promise.resolve(false),
      },
      signal: controller.signal,
    }), timedOut])
    controller.signal.throwIfAborted()
    return read
  }
  try {
    merge(names, await reads(new Set()))
    let previousLength: number
    do {
      previousLength = names.length
      if (names.length > 64) throw new Error(`${provider.id}: auth metadata probe exceeded its name limit`)
      for (let index = 0; index < previousLength; index++) {
        merge(names, await reads(new Set([names[index]!])))
        merge(names, await reads(new Set(names.slice(index))))
      }
    } while (names.length !== previousLength)
    return names
  } finally {
    clearTimeout(timeout!)
  }
}

/**
 * Generate metadata without resolving real credentials or streaming a request.
 * @param providers - Public installed catalog, or isolated providers for verification.
 * @returns Display metadata keyed by provider id.
 */
export async function generateProviderData(providers: readonly Provider[] = builtinProviders()): Promise<Record<string, ProviderData>> {
  const data: Record<string, ProviderData> = {}
  for (const provider of providers) {
    let env: readonly string[]
    try { env = await resolverEnv(provider) }
    catch (error) {
      // compat is a temporary upstream surface. Import it only as a last
      // resort, with a synthetic dictionary that never reads process.env.
      const fallback = (await import('@earendil-works/pi-ai/compat')).findEnvKeys(
        provider.id, new Proxy<Record<string, string>>({}, { get: () => 'probe-value' }),
      )
      if (fallback === undefined || fallback.length === 0) throw new Error(`${provider.id}: no auth metadata fallback`, { cause: error })
      console.warn(`${provider.id}: using findEnvKeys auth metadata fallback`, error)
      env = fallback
    }
    const urls = provider.getModels().map(model => model.baseUrl)
    const fixed = provider.baseUrl || (urls.length > 0 && urls.every(url => url === urls[0]) ? urls[0] : undefined)
    const baseURLEnv = [...new Set([
      ...(SUPPLEMENTS[provider.id]?.baseURLEnv ?? []),
      ...[provider.baseUrl ?? '', ...urls].flatMap(url => [...url.matchAll(/\{([A-Z][A-Z0-9_]+)\}/g)].map(match => match[1]!)),
    ])]
    data[provider.id] = {
      env,
      ...fixed && !fixed.includes('{') ? { defaultBaseURL: fixed } : {},
      ...baseURLEnv.length === 0 ? {} : { baseURLEnv },
    }
  }
  return data
}

/**
 * Write the deterministic catalog, or reject stale data without changing it.
 * @param check - Validate the working file instead of writing it.
 * @param cached - Validate the staged file instead; never write or stage files.
 */
export async function syncProviderData(check: boolean, cached = false): Promise<void> {
  const source = '/** Generated from the installed pi-ai catalog. Run pnpm gen-provider-data; do not edit. */\n\n'
    + "import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'\n"
    + "import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'\n\n"
    + "type ProviderData = Pick<LlmConfigurableProvider, 'defaultBaseURL' | 'baseURLEnv'> & { env: readonly string[] }\n\n"
    + '/** Catalog endpoints and environment names; no credentials are evaluated at runtime. */\n'
    + 'export const PROVIDER_DATA: Record<BuiltinProvider, ProviderData> & Partial<Record<string, ProviderData>> = {\n'
    + Object.entries(await generateProviderData()).map(([id, data]) => {
      const fields = [`env: [${data.env.map(quote).join(', ')}]`,
        ...data.defaultBaseURL === undefined ? [] : [`defaultBaseURL: ${quote(data.defaultBaseURL)}`],
        ...data.baseURLEnv === undefined ? [] : [`baseURLEnv: [${data.baseURLEnv.map(quote).join(', ')}]`],
      ]
      return `  ${quote(id)}: { ${fields.join(', ')} },\n`
    }).join('') + '}\n'
  const path = new URL('../src/provider-data.generated.ts', import.meta.url)
  let current: string | undefined
  try {
    current = cached ? execFileSync('git', ['show', ':packages/llm/llm-pi-ai/src/provider-data.generated.ts'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', stdio: 'pipe',
    }) : readFileSync(path, 'utf8')
  }
  catch (error) {
    if (cached) throw new Error('Cannot read staged provider metadata; run pnpm gen-provider-data and stage provider-data.generated.ts', { cause: error })
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current === source) return
  if (check || cached) throw new Error(`Provider metadata is stale; run pnpm gen-provider-data${cached ? ' and stage provider-data.generated.ts' : ''}`)
  writeFileSync(path, source)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncProviderData(process.argv.includes('--check'), process.argv.includes('--cached'))
  console.log('Provider metadata matches the installed pi-ai catalog.')
}
