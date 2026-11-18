/** Synthetic Go struct comments and declarations for syntax-highlighting regressions. */
export const GO_SOURCE = [
  'package example',
  '',
  'type Record struct {',
  '\t// docs: {id} explains the ordinary field names for an example record ending here',
  '\tValue int',
  '}',
  '',
  'type Inline struct { Name string; Count int }',
  'type Nested struct { Flags map[string]struct{}; Child struct { Value int } }',
  // Shapes from worlpaker/go-syntax#25's test/semantic_tokens.go and test/stress.go.
  'type OneLineFields struct{ A, B int; C chan<- struct{}; D []string; sync.Mutex }',
  'type SplitOneLine struct { A int; B string',
  '}',
  'var stressFoo14 = struct{ Host string; Port int; Tags []string',
  '}{}',
  `type Many struct { ${Array.from({ length: 24 }, (_, index) => `F${index} int;`).join(' ')} Child struct { X int } }`,
  // Last: its unclosed brace keeps the struct body open to the end of the source.
  `type Open struct { ${'field '.repeat(48)}`,
].join('\n')
