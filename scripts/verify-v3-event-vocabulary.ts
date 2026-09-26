/** Compare the V3 migration vocabulary with an explicitly pinned local V3 writer. */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { isEntry } from './release/process.ts'

const WRITER_PATH = 'packages/core/session/src/types.ts'
const EVENTS_PATH = 'packages/core/session/src/known-event-types.ts'
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

function sourceAt(root: string, sourceRef: string, path: string): string {
  try {
    return execFileSync('git', ['show', `${sourceRef}:${path}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    })
  } catch (error) {
    throw new Error(`V3 source ${sourceRef}:${path} is not available locally; prepare the verified source pin before running this check`, { cause: error })
  }
}

function initializer(source: string, path: string, name: string): ts.Expression {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = file.statements.flatMap(statement =>
    ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
      : [])
  let value = declarations.length === 1 ? declarations[0]?.initializer : undefined
  if (value === undefined) throw new Error(`${path}: expected one initialized export ${name}`)
  while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression
  return value
}

function sourceEventTypes(source: string): ReadonlySet<string> {
  const value = initializer(source, EVENTS_PATH, 'KNOWN_SESSION_EVENT_TYPES')
  const entries = ts.isNewExpression(value) && value.arguments?.length === 1 ? value.arguments[0] : undefined
  if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== 'Set'
    || entries === undefined || !ts.isArrayLiteralExpression(entries)) {
    throw new Error(`${EVENTS_PATH}: KNOWN_SESSION_EVENT_TYPES must be a literal Set`)
  }
  const names = entries.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error(`${EVENTS_PATH}: event names must be string literals`)
    return element.text
  })
  const result = new Set(names)
  if (result.size !== names.length) throw new Error(`${EVENTS_PATH}: duplicate event name`)
  return result
}

/** Result tied to the exact historical commit that was inspected. */
export interface V3EventVocabularyCheck {
  readonly sourceRef: string
  readonly eventCount: number
}

/**
 * Verify the complete source vocabulary without consulting remote or current-writer event lists.
 * @param root - Git checkout containing the already available source commit.
 * @param sourceRef - full immutable commit id for the V3 writer used by the release integration.
 * @param expected - migration-owned V3 event names to check.
 * @returns the checked source pin and event count; does not establish remote freshness.
 * @throws when the pin is missing, does not write V3, or its event names differ.
 */
export function verifyV3EventVocabulary(
  root: string, sourceRef: string, expected: ReadonlySet<string> = RELEASED_V3_EVENT_TYPES,
): V3EventVocabularyCheck {
  if (!COMMIT_ID.test(sourceRef)) throw new Error('--source-ref requires a full immutable commit id, not a branch, tag, or abbreviated id')
  let objectType: string
  try {
    objectType = execFileSync('git', ['cat-file', '-t', sourceRef], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    }).trim()
  } catch (error) {
    throw new Error(`V3 source commit ${sourceRef} is not available locally; prepare the verified source pin before running this check`, { cause: error })
  }
  if (objectType !== 'commit') throw new Error('--source-ref must name a commit object')
  const writer = initializer(sourceAt(root, sourceRef, WRITER_PATH), WRITER_PATH, 'SESSION_FORMAT_VERSION')
  if (!ts.isNumericLiteral(writer) || Number(writer.text) !== 3) {
    throw new Error(`source ${sourceRef} must be a V3 writer; keep V4-only events out of RELEASED_V3_EVENT_TYPES`)
  }
  const actual = sourceEventTypes(sourceAt(root, sourceRef, EVENTS_PATH))
  const missing = [...actual].filter(name => !expected.has(name)).sort()
  const extra = [...expected].filter(name => !actual.has(name)).sort()
  if (missing.length > 0 || extra.length > 0) {
    throw new Error([
      `V3 event vocabulary differs from source ${sourceRef}; review source payload conversion before updating the migration-owned set.`,
      `Missing V3 names: ${missing.join(', ') || '(none)'}`,
      `Extra migration names: ${extra.join(', ') || '(none)'}`,
    ].join('\n'))
  }
  return { sourceRef, eventCount: actual.size }
}

function main(): void {
  const { values } = parseArgs({ options: { 'source-ref': { type: 'string' } }, allowPositionals: false })
  if (values['source-ref'] === undefined) throw new Error('usage: verify-v3-event-vocabulary --source-ref <full-V3-writer-commit-id>')
  const result = verifyV3EventVocabulary(resolve(process.cwd()), values['source-ref'])
  console.log(`verify-v3-event-vocabulary: ${result.eventCount} names match V3 writer ${result.sourceRef}; remote freshness was not checked.`)
}

if (isEntry(import.meta.url)) main()
