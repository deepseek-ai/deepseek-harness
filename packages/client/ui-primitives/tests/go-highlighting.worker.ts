/** Source-mode highlighter fixture; the parent owns termination during synchronous regex matching. */
import { parentPort } from 'node:worker_threads'
import {
  highlightLines, highlightToHtml, StreamingHighlightSession, subscribeGrammarLoaded,
} from '../src/markdown/highlight.ts'
import { GO_SOURCE } from './go-source.ts'

const ready = Promise.withResolvers<undefined>()
const dispose = subscribeGrammarLoaded(() => {
  if (highlightLines('package example', 'go') !== undefined) ready.resolve(undefined)
})
try {
  if (highlightLines('package example', 'go') === undefined) await ready.promise
} finally {
  dispose()
}
// The parent times matching separately from imports and grammar loading.
parentPort?.postMessage('loaded')
const lines = highlightLines(GO_SOURCE, 'go')
const stream = new StreamingHighlightSession()
const split = GO_SOURCE.indexOf('\t//')
if (split <= 0) throw new Error('GO_SOURCE no longer contains the brace-bearing struct comment')
stream.update(GO_SOURCE.slice(0, split), 'go')
const streamed = stream.update(GO_SOURCE, 'go')
parentPort?.postMessage({
  text: lines?.map(line => line.map(span => span.text).join('')).join('\n'),
  colored: lines?.map(line => line.flatMap(span =>
    span.style.color === 'var(--shiki-foreground)' ? [] : [`${span.text}:${String(span.style.color).replace('var(--shiki-token-', '').replace(')', '')}`])),
  streamingMatchesSettled: JSON.stringify(streamed) === JSON.stringify(new StreamingHighlightSession().update(GO_SOURCE, 'go')),
  html: highlightToHtml(GO_SOURCE, 'go'),
})
