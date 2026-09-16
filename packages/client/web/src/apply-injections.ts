/**
 * Page-side interpreter for the structured index injection table. The served
 * form renders the same rows into index.html text; a static worker page has
 * no served HTML, so it executes the table directly. Rows execute strictly in
 * table order, so a global row lands before the scripts that read it.
 */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

function assertNever(row: never): never {
  throw new Error(`web boot: unknown index injection row ${JSON.stringify(row)}`)
}

/**
 * Execute every row in table order.
 * @param rows - Injection table from the boot payload.
 * @param loadScript - Executes one script-src row through the page owner's asset transport.
 */
export async function applyIndexInjections(
  rows: readonly IndexInjection[],
  loadScript: (src: string) => Promise<void>,
): Promise<void> {
  for (const row of rows) {
    switch (row.kind) {
      case 'global':
        (globalThis as Record<string, unknown>)[row.name] = row.value
        break
      case 'script': {
        const el = document.createElement('script')
        el.textContent = row.text
        ;(row.placement === 'head' ? document.head : document.body).append(el)
        break
      }
      case 'script-src':
        await loadScript(row.src)
        break
      case 'script-preload':
        // Some transports cannot preload without executing; loadScript owns the actual request.
        break
      case 'style': {
        const el = document.createElement('style')
        el.textContent = row.text
        document.head.append(el)
        break
      }
      case 'html':
        (row.placement === 'head' ? document.head : document.body).insertAdjacentHTML('beforeend', row.html)
        break
      default:
        assertNever(row)
    }
  }
}
