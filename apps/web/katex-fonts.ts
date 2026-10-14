/** WOFF2-only KaTeX font sources for the Web and Desktop browser bundle. */

import { transform } from 'lightningcss'
import type { Plugin } from 'vite'

/**
 * Select WOFF2 before Vite collects KaTeX font assets, preserving every face and layout rule.
 * A face without WOFF2 rejects the build. Other packages' stylesheets are unchanged.
 * @returns Vite stylesheet transform for the installed KaTeX distribution.
 */
export function katexWoff2Fonts(): Plugin {
  return {
    name: 'dsh-katex-woff2-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/node_modules\/katex\/dist\/katex(?:\.min)?\.css(?:\?|$)/u.test(id.replaceAll('\\', '/'))) return
      const result = transform({
        filename: id, code: Buffer.from(code), sourceMap: true,
        visitor: { Rule: { 'font-face'(rule) {
          const descriptors = rule.value.properties.filter(property => property.type === 'source')
          if (descriptors.length === 0) throw new Error('KaTeX font face requires a WOFF2 source')
          for (const property of descriptors) {
            const sources = property.value.filter(source => source.type === 'url' && source.value.format?.type === 'woff2')
            if (sources.length === 0) throw new Error('KaTeX font face requires a WOFF2 source')
            property.value = sources
          }
          return rule
        } } },
      })
      return { code: result.code.toString(), map: result.map?.toString() }
    },
  }
}
