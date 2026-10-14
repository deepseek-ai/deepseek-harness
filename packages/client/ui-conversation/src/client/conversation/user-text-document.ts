/** Per-document candidate reconciliation, query coverage, tracked Facts and JSON identity reuse. */
import type { UserTextFacts } from '../index.ts'
import type {
  UserTextDocumentInput, UserTextNode, UserTextRule, UserTextTransformContext,
} from '../contract/user-text.ts'

type FactKey = keyof UserTextFacts

class UserTextTransformError extends Error {
  constructor(readonly ruleId: string, cause: unknown) {
    super(`user-text rule "${ruleId}" failed to evaluate`, { cause })
    this.name = 'UserTextTransformError'
  }
}

interface Query {
  readonly from: number
  readonly node: UserTextNode | undefined
  readonly error: UserTextTransformError | undefined
}

interface Matcher {
  readonly definition: UserTextRule
  readonly reads: Map<FactKey, unknown>
  queries: readonly Query[]
}

interface Traversal {
  readonly matcher: Matcher
  readonly added: Query[]
  index: number
  head: Query | undefined
}

/** Data-layer cache owned by one caller; initialization and refresh share one reconciliation. */
export class UserTextDocument {
  private text: string | undefined
  private rules: readonly UserTextRule[] | undefined
  private initial: readonly UserTextNode[] = []
  private output: readonly UserTextNode[] = []
  private readonly matchers = new Map<string, Matcher>()
  private complete = false
  private evaluating = false

  /**
   * Reconcile original text using current rule definitions and valid query records.
   * @param input - original text and readonly Facts, compared by fields actually read.
   * @param rules - unique definitions ordered by ascending order and stable ID.
   * @returns complete readonly nodes; failures retain caches but publish no partial result.
   */
  evaluate(input: UserTextDocumentInput, rules: readonly UserTextRule[]): readonly UserTextNode[] {
    if (this.evaluating) throw new Error('user-text document evaluation cannot be reentrant')
    this.evaluating = true
    try {
      const { changed, matchers } = this.prepare(input, rules)
      if (!changed && this.complete) return this.output
      this.complete = false
      this.output = alignNodes(this.reconcile(input, matchers), this.output, this.initial)
      this.complete = true
      return this.output
    } finally {
      this.evaluating = false
    }
  }

  private prepare(input: UserTextDocumentInput, rules: readonly UserTextRule[]): { changed: boolean; matchers: Matcher[] } {
    let changed = this.rules !== rules
    if (this.text !== input.text) {
      changed = true
      this.text = input.text
      this.matchers.clear()
      this.initial = input.text.length === 0 ? [] : [textNode(input.text, 0, input.text.length)]
      this.output = this.initial
    }
    const ids = new Set(rules.map(rule => rule.id))
    const matchers: Matcher[] = []
    for (const definition of rules) {
      let matcher = this.matchers.get(definition.id)
      if (matcher === undefined || matcher.definition !== definition || factsChanged(matcher.reads, input)) {
        matcher = { definition, queries: [], reads: new Map() }
        this.matchers.set(definition.id, matcher)
        changed = true
      }
      matchers.push(matcher)
    }
    for (const id of this.matchers.keys()) if (!ids.has(id)) this.matchers.delete(id)
    this.rules = rules
    return { changed, matchers }
  }

  private reconcile(input: UserTextDocumentInput, matchers: readonly Matcher[]): readonly UserTextNode[] {
    const traversals: Traversal[] = matchers.map(matcher => ({ matcher, added: [], index: -1, head: undefined }))
    const nodes: UserTextNode[] = []
    let cursor = 0
    try {
      while (true) {
        let winner: UserTextNode | undefined
        for (const traversal of traversals) {
          const node = nextCandidate(traversal, input, cursor)
          // Definitions arrive in stable priority order; earlier starts always take precedence.
          if (node !== undefined && (winner === undefined || node.start < winner.start)) winner = node
        }
        if (winner === undefined) {
          if (cursor < input.text.length) nodes.push(textNode(input.text, cursor, input.text.length))
          return nodes
        }
        if (cursor < winner.start) nodes.push(textNode(input.text, cursor, winner.start))
        nodes.push(winner)
        cursor = winner.end
      }
    } finally {
      for (const { matcher, added } of traversals) {
        if (added.length > 0) matcher.queries = mergeQueries(matcher.queries, added)
      }
    }
  }

}

function factsChanged(reads: ReadonlyMap<FactKey, unknown>, input: UserTextDocumentInput): boolean {
  for (const [key, value] of reads) if (!Object.is(value, input.facts[key])) return true
  return false
}

function withFacts<T>(input: UserTextDocumentInput, reads: Map<FactKey, unknown>, run: (context: UserTextTransformContext) => T): T {
  let active = true
  try {
    return run({
      read: <K extends FactKey>(key: K): UserTextFacts[K] | undefined => {
        if (!active) throw new Error('user-text transform context is closed; read is synchronous only')
        const value = input.facts[key]
        reads.set(key, value)
        return value
      },
    })
  } finally {
    active = false
  }
}

function nextCandidate(traversal: Traversal, input: UserTextDocumentInput, cursor: number): UserTextNode | undefined {
  const { matcher } = traversal
  if (traversal.head === undefined || (traversal.head.node !== undefined && traversal.head.node.start < cursor)) {
    let next = matcher.queries[traversal.index + 1]
    while (next !== undefined && next.from <= cursor) {
      traversal.index++
      next = matcher.queries[traversal.index + 1]
    }
    const recorded = matcher.queries[traversal.index]
    if (recorded !== undefined && (recorded.error !== undefined
      ? recorded.from === cursor : recorded.node === undefined || recorded.node.start >= cursor)) {
      traversal.head = recorded
    } else {
      let node: UserTextNode | undefined
      let error: UserTextTransformError | undefined
      try {
        node = withFacts(input, matcher.reads, context => matcher.definition.match(input.text, cursor, context))
        if (node !== undefined) validateCandidate(input.text, matcher.definition.id, cursor, node)
      } catch (cause) {
        error = new UserTextTransformError(matcher.definition.id, cause)
      }
      traversal.head = { from: cursor, node, error }
      traversal.added.push(traversal.head)
    }
  }
  if (traversal.head.error !== undefined) throw traversal.head.error
  return traversal.head.node
}

function validateCandidate(text: string, ruleId: string, from: number, node: UserTextNode): void {
  if (!Number.isInteger(node.start) || !Number.isInteger(node.end)
    || node.start < from || node.end <= node.start || node.end > text.length) {
    throw new Error(`invalid candidate range [${node.start}, ${node.end}); expected a nonempty range from ${from} to ${text.length}`)
  }
  if (node.id === 'text') {
    if (node.data.text !== text.slice(node.start, node.end)) throw new Error('text candidate must preserve its original substring')
  } else if (node.id !== ruleId) {
    throw new Error(`candidate must use rule ID "${ruleId}" or text`)
  }
}

function mergeQueries(previous: readonly Query[], added: readonly Query[]): readonly Query[] {
  if (previous.length === 0) return added
  const merged: Query[] = []
  const remaining = previous.values()
  let old = remaining.next().value
  // New queries only fill offsets not covered by retained records.
  for (const query of added) {
    while (old !== undefined && old.from < query.from) {
      merged.push(old)
      old = remaining.next().value
    }
    merged.push(query)
  }
  while (old !== undefined) {
    merged.push(old)
    old = remaining.next().value
  }
  return merged
}

function textNode(text: string, start: number, end: number): UserTextNode<'text'> {
  return { id: 'text', start, end, data: { text: text.slice(start, end) } }
}

function alignNodes(
  output: readonly UserTextNode[], previous: readonly UserTextNode[], input: readonly UserTextNode[],
): readonly UserTextNode[] {
  let previousIndex = 0
  let inputIndex = 0
  let aligned: UserTextNode[] | undefined
  for (const [index, node] of output.entries()) {
    let inputNode = input[inputIndex]
    while (inputNode && inputNode.start < node.start) inputNode = input[++inputIndex]
    let previousNode = previous[previousIndex]
    while (previousNode && previousNode.start < node.start) previousNode = previous[++previousIndex]
    const reused = inputNode && equalNode(node, inputNode) ? inputNode
      : previousNode && equalNode(node, previousNode) ? previousNode : node
    if (reused !== node && !aligned) aligned = output.slice(0, index)
    aligned?.push(reused)
  }
  const nodes = aligned ?? output
  if (equalElements(nodes, previous)) return previous
  return equalElements(nodes, input) ? input : nodes
}

function equalElements(left: readonly UserTextNode[], right: readonly UserTextNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => node === right[index]))
}

function equalNode(left: UserTextNode, right: UserTextNode): boolean {
  return Object.is(left, right) || (left.id === right.id && left.start === right.start && left.end === right.end
    && equalJson(left.data, right.data))
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.hasOwn(right, key)
    && equalJson(Reflect.get(left, key), Reflect.get(right, key)))
}
