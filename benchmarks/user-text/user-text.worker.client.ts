/** Compiled worker for sent-user-text evaluation cost and allocation with and without the credential matcher. */

import { PerformanceObserver, performance } from 'node:perf_hooks'
import { getHeapSpaceStatistics } from 'node:v8'
import { Context } from '@deepseek-ai/cordis'
import type { UserTextFacts, UserTextRule, UserTextTransformContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
// These Client-only UserText modules have no plain-Node package export and are compiled into this worker.
import { UserTextRegistry } from '../../packages/client/ui-conversation/src/client/conversation/user-text-registry.ts'
import { sessionReferenceRule } from '../../packages/client/ui-conversation/src/client/user-text/session-reference-rule.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '../../packages/client/ui-conversation/src/client/user-text/whitespace-rules.ts'
import { fileReferenceRule, folderReferenceRule } from '../../packages/client/ui-reference/src/client/user-text-rules.ts'
import { skillReferenceRule } from '../../packages/client/ui-skill/src/client/user-text-rules.ts'
import { goalCommandReferenceRule } from '../../packages/client/ui-goal/src/client/user-text-rules.ts'
import { createSecretRule } from '../../packages/client/ui-secret-mask/src/client/secret-rule.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** What a workload contains: no credential, real credentials, or input shaped against one format. */
export type UserTextWorkloadGroup = 'unmatched' | 'matched' | 'adversarial'

/** Adjacent baseline and credential measurements; even-indexed pairs measure the baseline first. */
export interface UserTextTimingPair {
  readonly baseMs: number
  readonly baseCpuMs: number
  readonly withSecretMs: number
  readonly withSecretCpuMs: number
}

/** Timing of one workload evaluated by the shipped rule set with and without the credential matcher. */
export interface UserTextWorkloadTiming {
  readonly id: string
  readonly group: UserTextWorkloadGroup
  readonly documents: number
  readonly characters: number
  /** Fresh evaluations averaged into each timed sample; counts and characters describe one evaluation. */
  readonly evaluationsPerSample: number
  readonly secrets: number
  /** Characters inside credential ranges, whose masks the matcher builds. */
  readonly maskedCharacters: number
  readonly baseMs: number
  /** Mean process CPU time per evaluation in the fastest baseline sample. */
  readonly baseCpuMs: number
  readonly withSecretMs: number
  /** Mean process CPU time per evaluation in the fastest with-credential sample. */
  readonly withSecretCpuMs: number
  readonly ratio: number
  /** All measured pairs in execution order, excluding warm-up. */
  readonly samples: readonly UserTextTimingPair[]
}

/** Heap allocation of the credential matcher over one workload, with the size of what it returns. */
export interface UserTextWorkloadAllocation {
  readonly id: string
  /** Young-generation bytes the matcher allocates answering every query of every document, nodes included; no GC ran meanwhile. */
  readonly ruleAllocatedBytes: number
  readonly secrets: number
  /** Characters inside credential ranges. */
  readonly maskedCharacters: number
  /** Line breaks inside credential ranges, each of which ends one piece of a multi-line mask. */
  readonly maskedLineBreaks: number
}

/** Result of `time <attempts>`: warmed code, fresh instances, and independent minima from adjacent sample pairs. */
export interface UserTextTimeReport {
  readonly warmupPairs: number
  readonly attempts: number
  readonly workloads: readonly UserTextWorkloadTiming[]
}

/** Result of `allocation`, which needs `--expose-gc` and a young generation larger than one evaluation. */
export interface UserTextAllocationReport {
  readonly workloads: readonly UserTextWorkloadAllocation[]
}

/** Matchers the Web composition registers besides the credential matcher. */
const BASE_RULES: readonly UserTextRule[] = [
  sessionReferenceRule, fileReferenceRule, folderReferenceRule, skillReferenceRule,
  goalCommandReferenceRule, collapseWhitespaceRule, trimWhitespaceRule,
]
/** Facts a sent message bubble supplies. */
const FACTS: Readonly<Partial<UserTextFacts>> = { sessionLabels: ['会话一'], skillNames: ['plan', 'review'] }

const KIB = 1024
/** Exercise each workload's code paths before measuring sub-millisecond baseline evaluations. */
const WARMUP_PAIRS = 10
/** Batch every single-document workload to limit noise in its shortest evaluation intervals. */
const SINGLE_DOCUMENT_EVALUATIONS = 20
const PROSE = '帮我看看这个函数为什么慢，顺便把 README 也更新一下。The quick brown fox jumps over the lazy dog, 1234 times. '
const CODE = 'const value = await fetch(`https://api.example.com/v1/items?id=${id}`); if (!value.ok) throw new Error("bad: " + value.status);\n'
const BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLw'
const MARKDOWN = [
  '## 安装与配置', '', '- 运行 `pnpm install`，然后执行 `pnpm run build`。',
  '- 详见 [文档](https://example.com/docs/setup?ref=readme#install)。', '',
  '| 选项 | 默认值 | 说明 |', '|---|---|---|', '| `timeout` | 30s | 请求超时 |', '| `retries` | 3 | 失败重试次数 |', '',
  '```ts', "const client = createClient({ baseUrl: 'https://api.example.com/v1', timeout: 30_000 })", '```', '', '',
].join('\n')
const LOG = '2026-10-11T12:00:00.123Z INFO  [worker-3] GET https://api.example.com/v1/items?id=1234&page=2 200 12ms '
  + 'trace=4bf92f3577b34da6a3ce929d0e0e4736 user=alice@example.com\n'
const JSON_LINES = '{"id":"123e4567-e89b-12d3-a456-426614174000","url":"https://cdn.example.com/assets/img_0001.png",'
  + '"name":"task-runner","tags":["sk-button","api_key_name"],"created_at":"2026-10-11T12:00:00Z","size":10240},\n'
const SHELL = 'pnpm --filter @deepseek-ai/dsh-client-ui-secret-mask run test -- --coverage --reporter=verbose'
  + ' && git push origin feat/user-text-secret-mask\n'
/** Ordinary message fragments: prose, references, a slash skill, a URL without credentials, and code. */
const MESSAGE_PARTS = [
  PROSE, '参照 @src/app/main.ts 修复一下', ' /plan 先列计划', ' 见 https://example.com/docs/a?b=c#d ',
  '`const total = items.reduce((a, b) => a + b, 0)`', ' 然后跑 pnpm run test -- --watch=false。',
] as const

const fill = (unit: string, characters: number): string => unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters)
const MIXED = 'a1B2c3D4e5F6g7H8i9J0'
// Samples are assembled at run time so the repository holds no literal in a credential format.
const key = (index: number): string => ['sk', '-', `${index.toString(16).padStart(8, '0')}0123456789abcdef01234567`].join('')
const CREDENTIALS = {
  'model-key': key(7),
  'github-token': ['gh', 'p_', fill(MIXED, 36)].join(''),
  'cloud-key-id': ['AK', 'IA', 'ABCDEFGHIJ234567'].join(''),
  'json-web-token': ['ey', 'J', fill(MIXED, 17), '.', 'ey', 'J', fill(MIXED, 30), '.', fill(MIXED, 43)].join(''),
  'address-password': ['postgres://admin:', 'p4ss-W0rd', '@db.internal:5432/app'].join(''),
  'private-key-block': [
    ['-----BEGIN', ' RSA PRIVATE KEY-----'].join(''), ...Array.from({ length: 10 }, () => fill(BASE64, 64)),
    ['-----END', ' RSA PRIVATE KEY-----'].join(''),
  ].join('\n'),
} as const

function messages(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const parts = Array.from({ length: 4 }, (_unused, part) => MESSAGE_PARTS[(index + part * 2) % MESSAGE_PARTS.length]!)
    return `${String(index)} ${parts.join('')}`.slice(0, 200)
  })
}

/** Ordinary 200-character messages, each carrying one credential whole. */
function credentialMessages(count: number, credential: string): string[] {
  return Array.from({ length: count }, (_, index) => {
    const head = `${String(index)} 帮我看看这个配置能不能用：`
    const tail = `，${MESSAGE_PARTS[index % MESSAGE_PARTS.length]!}${PROSE}`
    return head + credential + tail.slice(0, Math.max(0, 200 - head.length - credential.length))
  })
}

const envFile = (count: number): string =>
  Array.from({ length: count }, (_, index) => `SERVICE_${String(index)}_API_KEY=${key(index)}`).join('\n')

/** Inputs shaped against each credential format's prefix, length, and separator rules. */
const ADVERSARIAL_UNITS = {
  'digitless-sk': 'sk-',
  'jwt-header-runs': 'eyJabcdefgh-',
  'jwt-two-segments': 'eyJabcdefgh.eyJabcdefgh-',
  'unterminated-key-blocks': ['-----BEGIN', ' RSA PRIVATE KEY-----\nabc\n'].join(''),
  'address-without-at': 'a://u:',
  'colon-run': ':',
  'long-scheme-user': `abcdefghijklmnop://${'u'.repeat(250)}:`,
  'short-token-runs': `ghp_${fill('a1B2c3', 35)} `,
  // Closed one-line blocks, each its own credential: mask searches confined to each block keep them linear.
  'closed-one-line-key-blocks': ['-----BEGIN', ' PRIVATE KEY-----abcd', '-----END', ' PRIVATE KEY----- '].join(''),
  // Each query starts after an accepted digit-free token and meets a digit-free `sk-` whose digit search reaches the end.
  'tokens-between-digitless-keys': ['-', 'sk', '-', 'gh', 'p_', fill('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 36)].join(''),
} as const

interface Workload {
  readonly id: string
  readonly group: UserTextWorkloadGroup
  readonly texts: readonly string[]
}

/** Named fixed workloads; adversarial inputs appear at two sizes so their scaling is observable. */
function workloads(): readonly Workload[] {
  return [
    { id: 'typical-messages', group: 'unmatched', texts: messages(5_000) },
    ...Object.entries({ prose: PROSE, code: CODE, base64: BASE64, markdown: MARKDOWN, log: LOG, json: JSON_LINES, shell: SHELL })
      .map(([name, unit]): Workload => ({ id: `${name}-256k`, group: 'unmatched', texts: [fill(unit, 256 * KIB)] })),
    ...Object.entries(CREDENTIALS).map(([name, credential]): Workload => ({
      id: `messages-with-${name}`, group: 'matched', texts: credentialMessages(5_000, credential),
    })),
    { id: 'env-keys-1000', group: 'matched', texts: [envFile(1_000)] },
    { id: 'env-keys-2000', group: 'matched', texts: [envFile(2_000)] },
    ...Object.entries(ADVERSARIAL_UNITS).flatMap(([name, unit]): Workload[] => [
      { id: `adversarial-${name}-64k`, group: 'adversarial', texts: [fill(unit, 64 * KIB)] },
      { id: `adversarial-${name}-128k`, group: 'adversarial', texts: [fill(unit, 128 * KIB)] },
    ]),
  ]
}

interface Sample {
  readonly ms: number
  readonly cpuMs: number
  readonly secrets: number
  readonly maskedCharacters: number
}

interface SamplePair {
  readonly base: Sample
  readonly secret: Sample
}

/** Rules for one sample; a fresh credential matcher per sample carries no state from an earlier sample. */
type RuleSet = () => readonly UserTextRule[]
const withoutSecret: RuleSet = () => BASE_RULES
const withSecret: RuleSet = () => [...BASE_RULES, createSecretRule()]

/**
 * Evaluate fresh documents; await registry disposal outside the measured interval before returning.
 * @returns elapsed and CPU milliseconds, credential nodes produced, and their characters.
 */
async function evaluateAll(rules: RuleSet, texts: readonly string[]): Promise<Sample> {
  const scope = new Context()
  try {
    const registry = new UserTextRegistry(scope)
    for (const rule of rules()) registry.register(rule)
    let secrets = 0
    let maskedCharacters = 0
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    for (const text of texts) {
      for (const node of registry.createEvaluator()({ text, facts: FACTS })) {
        if (node.id !== 'secret') continue
        secrets++
        maskedCharacters += node.end - node.start
      }
    }
    const ms = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    return { ms, cpuMs: (cpu.user + cpu.system) / 1_000, secrets, maskedCharacters }
  } finally {
    await scope.fiber.dispose()
  }
}

async function sample(rules: RuleSet, texts: readonly string[], evaluations: number): Promise<Sample> {
  const first = await evaluateAll(rules, texts)
  let ms = first.ms
  let cpuMs = first.cpuMs
  for (let index = 1; index < evaluations; index++) {
    const next = await evaluateAll(rules, texts)
    ms += next.ms
    cpuMs += next.cpuMs
  }
  return { ...first, ms: ms / evaluations, cpuMs: cpuMs / evaluations }
}

async function evaluatePair(texts: readonly string[], index: number, evaluations: number): Promise<SamplePair> {
  if (index % 2 === 0) {
    const base = await sample(withoutSecret, texts, evaluations)
    return { base, secret: await sample(withSecret, texts, evaluations) }
  }
  const secret = await sample(withSecret, texts, evaluations)
  return { base: await sample(withoutSecret, texts, evaluations), secret }
}

async function measure(texts: readonly string[], attempts: number, evaluations: number): Promise<SamplePair & {
  readonly samples: readonly UserTextTimingPair[]
}> {
  for (let warm = 0; warm < WARMUP_PAIRS; warm++) await evaluatePair(texts, warm, evaluations)
  const pairs: SamplePair[] = []
  for (let attempt = 0; attempt < attempts; attempt++) {
    pairs.push(await evaluatePair(texts, attempt, evaluations))
  }
  const best = pairs.reduce((min, pair) => ({
    base: pair.base.ms < min.base.ms ? pair.base : min.base,
    secret: pair.secret.ms < min.secret.ms ? pair.secret : min.secret,
  }))
  return {
    ...best,
    samples: pairs.map(pair => ({
      baseMs: pair.base.ms, baseCpuMs: pair.base.cpuMs,
      withSecretMs: pair.secret.ms, withSecretCpuMs: pair.secret.cpuMs,
    })),
  }
}

declare const gc: (() => void) | undefined

/**
 * Young-generation bytes in use. Code and feedback that compilation allocates during a
 * measurement live in other spaces, so they do not count as allocation by the evaluation.
 */
function youngBytes(): number {
  let total = 0
  for (const space of getHeapSpaceStatistics()) {
    if (space.space_name === 'new_space' || space.space_name === 'new_large_object_space') total += space.space_used_size
  }
  return total
}

/** The credential matcher reads no Facts. */
const NO_FACTS: UserTextTransformContext = { read: () => undefined }

/**
 * Query the credential matcher over every document as the scheduler does when no other
 * matcher produces a node; an index loop, so the loop itself allocates nothing.
 */
function queryAll(rule: UserTextRule, texts: readonly string[]): void {
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!
    for (let from = 0; ;) {
      const node = rule.match(text, from, NO_FACTS)
      if (node === undefined) break
      from = node.end
    }
  }
}

/** Credential nodes the matcher returns over every document, counted outside any measured interval. */
function returned(texts: readonly string[]): Omit<UserTextWorkloadAllocation, 'id' | 'ruleAllocatedBytes'> {
  const rule = createSecretRule()
  let secrets = 0
  let maskedCharacters = 0
  let maskedLineBreaks = 0
  for (const text of texts) {
    for (let node = rule.match(text, 0, NO_FACTS); node !== undefined; node = rule.match(text, node.end, NO_FACTS)) {
      secrets++
      maskedCharacters += node.end - node.start
      for (let index = node.start; index < node.end; index++) {
        const code = text.charCodeAt(index)
        if (code === 10 || code === 13) maskedLineBreaks++
      }
    }
  }
  return { secrets, maskedCharacters, maskedLineBreaks }
}

/**
 * Bytes one warmed pass of every query allocates, measured across an interval without GC.
 * @returns young-generation growth over the interval.
 */
async function allocatedBytes(texts: readonly string[], collect: () => void): Promise<number> {
  const collections: number[] = []
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) collections.push(entry.startTime) })
  observer.observe({ entryTypes: ['gc'] })
  try {
    const rule = createSecretRule()
    for (let warm = 0; warm < 10; warm++) queryAll(rule, texts)
    collect()
    collect()
    const start = performance.now()
    const used = youngBytes()
    queryAll(rule, texts)
    const grown = youngBytes() - used
    const end = performance.now()
    // GC entries arrive on a later turn.
    await new Promise(resolve => { setTimeout(resolve, 20) })
    const inside = collections.filter(time => time >= start && time <= end).length
    if (inside > 0) throw new Error(`${String(inside)} garbage collections ran inside the allocation interval; enlarge the young generation`)
    return grown
  } finally {
    observer.disconnect()
  }
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

async function allocations(): Promise<UserTextAllocationReport> {
  if (gc === undefined) throw new Error('user-text allocation mode needs --expose-gc')
  const collect = gc
  const results: UserTextWorkloadAllocation[] = []
  for (const { id, texts } of workloads()) {
    results.push({ id, ruleAllocatedBytes: await allocatedBytes(texts, collect), ...returned(texts) })
  }
  return { workloads: results }
}

async function timings(attempts: number): Promise<UserTextTimeReport> {
  const results: UserTextWorkloadTiming[] = []
  for (const { id, group, texts } of workloads()) {
    const evaluationsPerSample = texts.length === 1 ? SINGLE_DOCUMENT_EVALUATIONS : 1
    const { base, secret, samples } = await measure(texts, attempts, evaluationsPerSample)
    results.push({
      id,
      group,
      documents: texts.length,
      characters: texts.reduce((sum, text) => sum + text.length, 0),
      evaluationsPerSample,
      secrets: secret.secrets,
      maskedCharacters: secret.maskedCharacters,
      baseMs: base.ms,
      baseCpuMs: base.cpuMs,
      withSecretMs: secret.ms,
      withSecretCpuMs: secret.cpuMs,
      ratio: secret.ms / base.ms,
      samples,
    })
  }
  return { warmupPairs: WARMUP_PAIRS, attempts, workloads: results }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/cordis': import.meta.resolve('@deepseek-ai/cordis'),
  '@deepseek-ai/dsh-client-store': import.meta.resolve('@deepseek-ai/dsh-client-store'),
})
const [mode, count] = process.argv.slice(2)
if (mode !== 'time' && mode !== 'allocation') throw new Error('usage: user-text.worker.js time <attempts> | allocation')
console.log(JSON.stringify(mode === 'time' ? await timings(positiveInteger(count, 'attempts')) : await allocations()))
