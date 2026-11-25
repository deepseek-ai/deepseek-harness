/** Native CSS preflight for stylesheets of packages opting into selector scoping. */

/** Serialize a CSS string, not an identifier: scoped package names may contain punctuation. */
function cssString(value: string): string {
  let result = '"'
  for (const character of value.toWellFormed()) {
    const code = character.charCodeAt(0)
    if (code === 0) result += '\uFFFD'
    else if (code < 32 || code === 127) result += `\\${code.toString(16)} `
    else if (character === '"' || character === '\\') result += `\\${character}`
    else result += character
  }
  return `${result}"`
}

/**
 * Wrap a compiled stylesheet in one native scope, without publishing unverified rules in the destination.
 * @param doc - Destination document whose CSS parser must accept the scope.
 * @param owner - Package id carried by the marked module roots.
 * @param css - Original text produced by the module record.
 * @returns A single scoped rule containing the original stylesheet text.
 * @throws If the document cannot parse the scope or the stylesheet needs top-level imports or namespaces.
 */
export function scopeStylesheet(doc: Document, owner: string, css: string): string {
  const view = doc.defaultView
  if (!view?.CSSScopeRule) throw new Error('style scoping requires CSS @scope support in this document')

  // A constructed sheet discards @import, and grouping discards both @import and @namespace.
  // Inspect possible at-keywords (including CSS escapes) in a document with no browsing context.
  if (/@(?:import|namespace|[a-z]*\\)/i.test(css)) {
    const inert = doc.implementation.createHTMLDocument('')
    const style = inert.createElement('style')
    style.textContent = css
    inert.head.append(style)
    if (!style.sheet) throw new Error('cannot check this stylesheet for top-level @import or @namespace rules')
    const { CSSImportRule, CSSNamespaceRule } = inert.defaultView ?? view
    for (const rule of style.sheet.cssRules) {
      if (rule instanceof CSSImportRule || rule instanceof CSSNamespaceRule) {
        throw new Error('@import and @namespace need the top level; compile them out before opting into style scoping')
      }
    }
  }

  const own = `[data-plugin=${cssString(owner)}]`
  const scopedCss = `@scope (${own}) to ([data-plugin]:not(${own})) {\n${css}\n}`
  const probe = new view.CSSStyleSheet()
  // Unlike whole-sheet parsing, insertRule rejects trailing rules or tokens after the generated scope.
  probe.insertRule(scopedCss)
  if (!(probe.cssRules[0] instanceof view.CSSScopeRule)) throw new Error('this document did not parse the stylesheet as a CSS @scope rule')
  return scopedCss
}
