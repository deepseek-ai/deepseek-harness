/** Development responses for published Markdown and the documentation index. */
import type { Connect } from 'vite'
import { rawMarkdownRoute } from '../scripts/project-doc-site.ts'

/**
 * Serve published source text while preserving Vite's Markdown module imports.
 * Explicit `dsh-raw=1` fetches return 404 for unpublished Markdown routes.
 *
 * @param base Site URL prefix with leading and trailing slashes.
 * @param index Render the current llms.txt index.
 * @returns Middleware for the Vite development server.
 */
export function rawMarkdownMiddleware(base: string, index: () => string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next()
      return
    }
    let url: URL
    try {
      url = new URL(req.url, 'http://docs.local')
    } catch (_error) {
      // Malformed targets belong to Vite's request handling, not raw-route lookup.
      next()
      return
    }
    if (!url.pathname.startsWith(base)) {
      next()
      return
    }
    const path = url.pathname.slice(base.length)
    const explicit = path.endsWith('.md') && url.searchParams.get('dsh-raw') === '1'
    const destination = req.headers['sec-fetch-dest']
    // Script imports always belong to Vite, including imports carrying a query.
    if (destination !== undefined && destination !== 'document' && !(destination === 'empty' && explicit)) {
      next()
      return
    }
    const content = path === 'llms.txt' ? index() : path.endsWith('.md') ? rawMarkdownRoute(path) : undefined
    if (content === undefined) {
      if (!explicit) {
        next()
        return
      }
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', `${path === 'llms.txt' ? 'text/plain' : 'text/markdown'}; charset=utf-8`)
    res.end(req.method === 'HEAD' ? undefined : content)
  }
}
