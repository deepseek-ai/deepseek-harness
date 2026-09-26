/** Conservative compatibility checks between native RegExp validation and Unicode JSON Schema patterns. */

import type { AST } from '@eslint-community/regexpp'

function bmpOnly(node: AST.Node): boolean {
  switch (node.type) {
    case 'Character': return node.value <= 0xffff && (node.value < 0xd800 || node.value > 0xdfff)
    case 'CharacterClassRange': return bmpOnly(node.min) && bmpOnly(node.max) && (node.max.value < 0xd800 || node.min.value > 0xdfff)
    case 'CharacterClass': return !node.negate && node.elements.every(bmpOnly)
    case 'CharacterSet': return (node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && !node.negate
    case 'Quantifier': return bmpOnly(node.element)
    case 'Assertion': return ['start', 'end', 'word'].includes(node.kind)
    default: return false
  }
}

function broadSet(node: AST.Node): boolean {
  return node.type === 'CharacterSet' && (node.kind === 'any'
    || ((node.kind === 'digit' || node.kind === 'space' || node.kind === 'word') && node.negate))
}

function portableAlternative(alternative: AST.Alternative): boolean {
  // A lone, unanchored broad set asks only whether a matching character exists.
  if (alternative.elements.length === 1 && alternative.elements.some(broadSet)) return true
  let broadRepetitions = 0
  const wordAssertion = alternative.elements.some(element => element.type === 'Assertion' && element.kind === 'word')
  return alternative.elements.every((element) => {
    if (element.type === 'Quantifier' && element.max === Infinity && element.min <= 1 && broadSet(element.element)) {
      // Word assertions and multiple broad groups can observe a surrogate pair's midpoint.
      return !wordAssertion && ++broadRepetitions === 1
    }
    return bmpOnly(element)
  })
}

function signature(pattern: AST.Pattern): string {
  const incidental = new Set(['parent', 'start', 'end', 'raw', 'references', 'resolved'])
  return JSON.stringify(pattern, (key: string, value: unknown) => incidental.has(key) ? undefined : value)
}

/**
 * Create a checker for patterns that can retain native acceptance under Unicode regex semantics.
 * Unrecognized flagless syntax stays explicitly partial rather than becoming a misleading constraint.
 * @returns the compatibility predicate; parsing never executes the regular expression against config values.
 */
export async function createPatternCheck(): Promise<(source: string, flags?: string) => boolean> {
  const { RegExpParser } = await import('@eslint-community/regexpp')
  const parser = new RegExpParser()
  return (source, flags = '') => {
    if (flags !== '' && flags !== 'u') return false
    try {
      const unicode = parser.parsePattern(source, 0, source.length, { unicode: true })
      if (flags === 'u') return true
      const native = parser.parsePattern(source, 0, source.length, { unicode: false })
      return signature(native) === signature(unicode) && native.alternatives.every(portableAlternative)
    } catch (error) {
      // Invalid Unicode syntax cannot be emitted as a standard pattern constraint.
      if (error instanceof SyntaxError) return false
      throw error
    }
  }
}
