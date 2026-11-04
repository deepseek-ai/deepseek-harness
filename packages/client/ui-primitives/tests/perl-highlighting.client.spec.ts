import { expect, it } from 'vitest'
import { highlightLines, patchPerlGrammar, subscribeGrammarLoaded } from '../src/markdown/highlight.ts'
import type { HighlightSpan } from '../src/markdown/highlight.ts'

const PERL_SOURCE = [
  'for my $doc (split /^---\\s*$/m, $rules) {',
  '  print "$1\\n" if $doc =~ /^id:\\s*(\\S+)/m;',
  '}',
  'my @hits = grep /x/, @list;',
  'my @parts = join(",", 1, /y/);',
  'my $half = $split / 2;',
  'return /done/ and /ok/;',
  'my $m = /x/ || !/z/;',
  'my $q = $a / $b + $o->return / 2;',
  'my @chars = split //, $w;',
  'exit 0;',
].join('\n')

/** Tokens of one line, each tagged with its css-variables token class. */
function colored(lines: HighlightSpan[][], index: number): string[] {
  return (lines[index] ?? []).flatMap(span => span.style.color === 'var(--shiki-foreground)'
    ? []
    : [`${span.text.trim()}:${String(span.style.color).replace('var(--shiki-token-', '').replace(')', '')}`])
}

it('ends bare Perl match patterns in list and expression contexts', async () => {
  const ready = Promise.withResolvers<undefined>()
  const dispose = subscribeGrammarLoaded(() => { ready.resolve(undefined) })
  try {
    if (highlightLines('1;', 'perl') === undefined) await ready.promise
  } finally {
    dispose()
  }
  const lines = highlightLines(PERL_SOURCE, 'perl') ?? []
  expect(colored(lines, 0)).toEqual([
    'for:keyword', 'my:keyword', 'split:function', '/^---\\s*:string-expression', '$:keyword',
    '/:string-expression', 'm:keyword',
  ])
  expect(colored(lines, 1)).toEqual([
    'print:function', '"$1\\n":string-expression', 'if:keyword', '/^id:\\s*(\\S+)/:string-expression', 'm:keyword',
  ])
  expect(colored(lines, 3)).toEqual(['my:keyword', 'grep:function', '/x/:string-expression'])
  expect(colored(lines, 4)).toEqual(['my:keyword', 'join:function', '",":string-expression', '/y/:string-expression'])
  expect(colored(lines, 5)).toEqual(['my:keyword'])
  expect(colored(lines, 6)).toEqual(['return:keyword', '/done/:string-expression', 'and:keyword', '/ok/:string-expression'])
  expect(colored(lines, 7)).toEqual(['my:keyword', '/x/:string-expression', '/z/:string-expression'])
  expect(colored(lines, 8)).toEqual(['my:keyword', '->:keyword'])
  expect(colored(lines, 9)).toEqual(['my:keyword', 'split:function', '//:string-expression'])
  expect(colored(lines, 10)).toEqual(['exit:keyword'])
})

it('patches exactly the vendored match rule and rejects a grammar without it', async () => {
  const { default: grammars } = await import('@shikijs/langs/perl')
  const perl = grammars.find(grammar => grammar.name === 'perl')
  const patched = patchPerlGrammar(grammars)
  const after = patched.find(grammar => grammar.name === 'perl')?.patterns
  const changed = after?.flatMap((rule, index) => rule === perl?.patterns[index] ? [] : [[perl?.patterns[index]?.begin, rule.begin]])
  expect(changed).toEqual([['(?<=[\\&({|~]|if|unless|^)\\s*((/))', expect.stringContaining('[^\\w$@%&>:-]split|^split|')]])
  expect(patched.filter(grammar => grammar.name !== 'perl')).toEqual(grammars.filter(grammar => grammar.name !== 'perl'))
  expect(() => patchPerlGrammar([{ name: 'perl', scopeName: 'source.perl', patterns: [], repository: {} }]))
    .toThrow('expected exactly one Perl match rule to patch, found 0')
  expect(() => patchPerlGrammar([])).toThrow('found 0')
})
