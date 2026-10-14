/** Readonly JSON candidates, forward matching, and tracked caller Facts. */
import type { UserTextDataMap, UserTextFacts } from '../index.ts'

/** Registered business IDs plus the document-owned `text` ID. */
export type UserTextId = Extract<keyof UserTextDataMap, string>

type JsonPayload<T> = T extends string | number | boolean | null ? T
  : T extends (...args: never[]) => unknown ? never
    : T extends readonly unknown[] ? { readonly [K in keyof T]: JsonPayload<T[K]> }
      : T extends object ? { readonly [K in keyof T]: JsonPayload<T[K]> }
        : never

/** Original UTF-16 text and readonly Facts; absence is observable through `context.read`. */
export interface UserTextDocumentInput {
  readonly text: string
  readonly facts: Readonly<Partial<UserTextFacts>>
}

/** Discriminated JSON node over a nonempty half-open UTF-16 range in the original text. */
export type UserTextNode<K extends UserTextId = UserTextId> = {
  [Id in K]: {
    readonly id: Id
    readonly start: number
    readonly end: number
    readonly data: JsonPayload<UserTextDataMap[Id]>
  }
}[K]

/** Facts reader valid only during its owning synchronous query; never retain it. */
export interface UserTextTransformContext {
  /**
   * Record a field dependency, including an absent value; throws after the call returns or throws.
   * @param key - field of the caller's readonly Facts snapshot.
   * @returns the borrowed readonly value, or undefined when absent.
   */
  read<K extends keyof UserTextFacts>(key: K): UserTextFacts[K] | undefined
}

/** One forward matcher for business references or Text replacements; order only resolves same-start candidates. */
export interface UserTextRule<out Id extends string = string> {
  readonly id: Id
  /** Finite ascending priority; equal values use stable ID ordering, never plugin load order. */
  readonly order: number
  /**
   * Find one nearest original-text candidate at or after `from`, resolving own same-start alternatives deterministically.
   * Search uses original lexical boundaries, not the beginning of a sliced suffix. Queries are independent of accepted nodes.
   * @param text - complete original text; neither this string nor caller Facts may be mutated.
   * @param from - inclusive original UTF-16 start offset, advancing within one reconciliation.
   * @param context - synchronous Facts reader; all retained queries contribute dependencies.
   * @returns one nonempty node using this rule's ID or `text`, or undefined when no later candidate exists.
   * Text candidates preserve the exact source substring and may supply `data.display`.
   */
  match(this: void, text: string, from: number, context: UserTextTransformContext): (UserTextNode & { readonly id: Id }) | UserTextNode<'text'> | undefined
}

/**
 * Reconcile one document using current rules and independently cached candidate queries.
 * Reentrant calls throw. Failures carry ruleId and cause without publishing partial output;
 * failed queries retry when their offset, definition, original text, or read Facts change.
 * @param input - original text and readonly JSON Facts; fields are compared with Object.is.
 * @returns readonly nodes covering the text, or [] for empty text; equivalent results retain identities.
 */
export type UserTextEvaluator = (input: UserTextDocumentInput) => readonly UserTextNode[]
