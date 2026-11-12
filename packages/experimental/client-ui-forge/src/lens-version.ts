/**
 * The version of a diff's files that a lens request names. The panel host and the changes view compute it alike, so a
 * request refers to exactly the files its view shows.
 */

/**
 * Name the files of one diff: equal versions describe the same paths with the same changes in the same order.
 * @param files - the diff's files in display order.
 * @returns 14 hexadecimal digits of a 53-bit hash over each path and change digest.
 */
export function lensVersion(files: readonly { readonly path: string; readonly digest: string }[]): string {
  // cyrb53: two 32-bit multiply-xorshift lanes folded into 53 bits.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (const file of files) {
    for (const text of [file.path, '\u0000', file.digest, '\u0001']) {
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index)
        h1 = Math.imul(h1 ^ code, 2654435761)
        h2 = Math.imul(h2 ^ code, 1597334677)
      }
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}
