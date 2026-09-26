/**
 * Structured index injections: the typed rows plugins contribute to the boot
 * HTML instead of raw `tapIndex` string transforms. Rows are pure
 * JSON-serializable data because one table feeds two renderers: the served
 * form renders rows into the index.html text ({@link renderIndexInjections}),
 * and a static worker deployment ships the same rows over its boot payload
 * for a page-side interpreter. Anything not expressible as a row stays on
 * `tapIndex`, which runs after row rendering.
 */

/** Document region a rendered row lands in: after the opening head or body tag. */
export type IndexInjectionPlacement = 'head' | 'body'

/** One structured index injection row. */
export type IndexInjection =
  /** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
  | { kind: 'global'; name: string; value: unknown }
  /** Inline classic script. `text` must not contain `</script`, which would close the element early. */
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
  /**
   * External classic script, executed in table order: a parser-blocking tag
   * when served, an awaited fetch-and-execute in the worker form (whose
   * loader resolves worker-only references such as `plugins/...`).
   */
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
  /** Advisory preload for an external classic script; static workers may ignore it. */
  | { kind: 'script-preload'; src: string }
  /** A `<style>` element in the head. `text` must not contain `</style`, which would close the element early. */
  | { kind: 'style'; text: string }
  /** Raw markup fragment. */
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }

/** Escape a row value before placing it in a quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function assertNever(row: never): never {
  throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`)
}

/** Render one row to markup with its placement. */
function renderRow(row: IndexInjection): { placement: IndexInjectionPlacement; markup: string } {
  switch (row.kind) {
    case 'global': {
      // `<` is escaped in JSON so a row-controlled string cannot break out of
      // the script element.
      const name = JSON.stringify(row.name).replaceAll('<', '\\u003c')
      const value = row.value === undefined
        ? 'undefined'
        : JSON.stringify(row.value).replaceAll('<', '\\u003c')
      return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` }
    }
    case 'script':
      return { placement: row.placement, markup: `<script>${row.text}</script>` }
    case 'script-src':
      return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` }
    case 'script-preload':
      return { placement: 'head', markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">` }
    case 'style':
      return { placement: 'head', markup: `<style>${row.text}</style>` }
    case 'html':
      return { placement: row.placement, markup: row.html }
    default:
      return assertNever(row)
  }
}

/** Insert `markup` into `html` at `at`. */
function splice(html: string, at: number, markup: string): string {
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/**
 * Tail script settling the boot-readiness deferred (`__DSH_BOOT_READY__`):
 * the client entry awaits its `.promise` before reading any injected state.
 * Whichever side runs first creates the deferred (`??=`), so a bootstrap that
 * applies the table asynchronously installs it ahead of the entry module and
 * settles it after the last row; the served form below creates and resolves
 * it in one statement, because every row is already in the document text.
 */
const READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'

/**
 * Render rows into an index.html body: head rows immediately after the
 * opening head tag, body rows immediately after the opening body tag, each
 * group in table order, and the boot-readiness tail after the last body row.
 * @param html - the raw index.html body.
 * @param rows - the collected injection table.
 * @returns the html with every row rendered.
 */
export function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string {
  let head = ''
  let body = ''
  for (const row of rows) {
    const rendered = renderRow(row)
    if (rendered.placement === 'head') head += rendered.markup
    else body += rendered.markup
  }
  body += READY_MARKUP
  let out = html
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out)
    // Headless fixture pages may lack <head>; prepending keeps the rows ahead
    // of every document script.
    out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head)
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out)
    // Body-less fragments receive the rows at the end, where the HTML parser
    // has already synthesized a body.
    out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body)
  }
  return out
}
