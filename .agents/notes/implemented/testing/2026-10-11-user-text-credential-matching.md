# Agent Note: Linear credential matching and performance gates for user text

Status: implemented

English | [中文](2026-10-11-user-text-credential-matching.zh.md)

## Problem

[ui-secret-mask](../../../../packages/client/ui-secret-mask/README.md) recognizes credentials in every sent user text. The UserText scheduler queries the matcher again after each accepted node, so a text costs the sum of all its queries. Most text contains no credential, so the first goal is that such text pays as little as possible; second, text with credentials pays in proportion to their number and length; adversarial input must stay linear. Constraints: no regex backtracking, prefix pruning, linear total over all queries of one text, and no allocation before a node is returned.

## Decision

### Algorithm: what each part does and costs

| Part | Method | Cost over all queries of one text |
|---|---|---|
| Finding format starts | All starting literals (`sk-`, `sk_live_` and kin, `AIza`, `ghp_` and kin, `github_pat_`, `glpat-`, `npm_`, `hf_`, `AKIA`/`ASIA`, `LTAI`, `AKID`, `xox?-`, `whsec_`, `eyJ`, `-----BEGIN `, `://`) form one literal-only alternation grouped by shared leading characters, scanned with `test` | Θ(n) native comparisons; no quantifier, so no backtracking; two adjacent queries reread at most one literal |
| Overlapping literals | Where a literal's suffix begins another literal (the `-` of `sk-`, `glpat-`, `xox?-` and `-----BEGIN `), the scan resumes at that suffix; resume offsets are computed from the literal table at module load | At most one character back per hit |
| Identifying the hit | A table keyed by the hit's last two code units; only the three shared endings (`t_`, `e_`, `IA`) are told apart with `startsWith` | O(1) per hit |
| Format checks | Word boundaries, lengths, digit position, and the `.eyJ` separator are numeric comparisons; a private-key label reads at most 52 characters and a scheme at most 16 back; character runs are measured natively with sticky `[class]*` patterns, which stop at the first character outside the class and have nothing after them to backtrack into | O(1) per hit plus run measurement |
| Runs, next digit, next `END` line | Each matcher instance memoizes per text in one `Int32Array`: four slots for `[A-Za-z0-9_-]` (a JWT uses three runs at once), one slot per other class, the next digit, and the next valid `END` line. These are facts of the text, reused across queries and cleared when a query names another text | Each character measured at most once per class |
| Address passwords | When the `://` precedes the query offset and the password follows it, the matcher first confirms that `:`, a nonempty password, and `@` follow the offset, and only then walks back over the user name; an offset inside `://` is checked directly | At most 258 characters back, only where `:password@` follows the offset |
| Joining candidates | Candidates are processed in start order; an address password starts after its `://` and waits until the scan passes its start, and no other `://` can occur before then because user names and passwords exclude `/`; overlapping candidates join the earliest and take its mask; a range that reaches the end of the text ends the scan | O(1) per candidate, no list |
| Masks | A range of prefixed formats only is ASCII without line breaks, so its mask is a slice of its first 8 characters plus a slice of a shared mark string; a private-key body skips ordinary characters natively and takes one slice of a shared "marks plus line break" string per line; address passwords and other mixed ranges count code points character by character | Θ(masked characters + lines), the order of the output |

### Memory

- Nothing is allocated before a node is returned: `test` creates no match array, memo slots are a preallocated integer array, loops use indexes instead of iterators, and candidate ranges live in local numbers.
- Each credential allocates only its result: the node, its `data` object, and the mask. A one-line mask is the concatenation of two slices; a multi-line mask adds one slice and one concatenation per line.
- Each instance keeps a reference to the last queried text until a query names another text.

### Trade-offs

- **Scanning is native, decisions are JavaScript**: in V8 a per-character JavaScript loop is slower than a native literal scan or native run measurement, so all work proportional to input length (finding starts, measuring runs, skipping key bodies) uses non-backtracking native patterns, and JavaScript makes a constant number of decisions per hit.
- **Pruning depends on the formats only**: starts come from format literals, not from anchors chosen by character frequency in natural text, so text with any character distribution pays the same linear cost.
- **Memo per text, not per query**: a memo inside one query cannot stop later queries from measuring the same characters again; keyed by text and owned by the instance, cleared on a new text, it costs one retained string reference.
- **Masks use shared-string slices**: faster than writing into a buffer and decoding it; a multi-line mask allocates in proportion to its lines, which is part of the output.

### Performance gate

[benchmarks/user-text](../../../../benchmarks/user-text/user-text.bench.client.ts) runs in the required `node 24 / benchmarks` lane. Its compiled worker uses the production UserText registry and every shipped matcher (session, file, folder, skill, command, whitespace, credential) under plain Node, in two processes: timing and allocation.

| Item | Content |
|---|---|
| Workloads | Without credentials: ordinary messages, and long prose, code, base64, Markdown, log, JSON, and shell text. With credentials: messages each carrying one kind (model key, GitHub token, cloud key ID, JWT, address password, private-key block), and batches of `.env` keys. Adversarial: repeated input shaped against each format's prefix, length, and separator rules, at two sizes. All generated from constants; credential samples are assembled at run time |
| Timing | Ten unmeasured pairs warm each workload with the same evaluation count as measured pairs. Five measured pairs alternate baseline-first and matcher-first order; each evaluation builds a fresh registry, document, and matcher instance and times evaluation only. A single-document sample averages twenty evaluations, or forty for the half-sized input of a scaling pair, so both sizes process the same total keys or characters per sample; a 5,000-message sample evaluates the batch once. Garbage collection during evaluation remains included. Each side selects its minimum sample mean, with the mean process CPU time from that sample. The worker JSON in CI logs includes every measured pair and averaging count; the HTML report shows the selected with-credential mean. Registry disposal completes outside the timer before the next evaluation, preventing cleanup and retained registries from accumulating. Warm-up retains no matcher memo |
| Allocation | A separate process with `--expose-gc` and a fixed semi-space larger than any evaluation; after warm-up and GC, the matcher alone answers every query once and the young-generation growth is taken; GC event timestamps confirm no GC ran inside the interval |
| Assertions | Without credentials: absolute budgets and a cap on the with/without time ratio; with credentials: absolute budgets and the time ratio when the key count doubles; adversarial: absolute budgets and doubling ratios; allocation: a floor plus caps per credential, per line break inside masks, and per masked character |
| Excluded | Cold code compilation, React rendering, browser paint and layout; allocation results are asserted and printed to the console, not added to the HTML report |

Expectations come from an x64 development machine. CI time budgets are converted with the shared scale and headroom; ratios are not machine-scaled. Unmatched with/without ratios use a common 1.75× headroom because independently selected minima vary with V8 tiering and workload shape; unchanged-worker CI ratios reached 1.65× their reference expectations. Absolute time budgets, doubling ratios, and allocation budgets retain their existing limits. Negative controls: the same benchmark fails when pointed at the regular-expression implementation or at an implementation that rebuilds its memo per query. Equivalence tests compare this implementation with the regular-expression one ([regex-oracle.client.ts](../../../../packages/client/ui-secret-mask/tests/regex-oracle.client.ts)) node by node through the production scheduler and from every query offset.

The reference constants are calibrated for minima of five single evaluations. Minimum-of-five sample means use the existing absolute headroom without recalibration. Averaging can move the ratio of independently selected minima in either direction; a threefold matcher-work negative control verifies that the JSON ratio limit still rejects extra scanning.

## Alternatives considered

- **Equal evaluation counts at both scaling sizes**: the larger input allocates twice as much per sample, so its fastest sample can include a collection while the smaller input's fastest sample includes none. Equal total input per sample makes the per-evaluation means compare similar allocation volumes without excluding GC or changing the doubling limit.
- **Unwarmed, separate baseline and matcher batches**: sub-millisecond baseline measurements can reach optimized code before the matcher’s newly exercised paths do, and separate batches amplify clock-speed drift. Per-workload warm-up, adjacent pairs, and fixed batches compare warmed code while limiting noise in short intervals and preserving fresh documents and matcher state.
- **One quantified pattern per format, run from every query**: patterns without a hit scan to the end of the text each time, so cost grows quadratically with credentials, and length quantifiers backtrack on failure.
- **One large quantified pattern for all formats**: one scan finds the leftmost match, but branch quantifiers still backtrack on failure.
- **Scanning for rare characters first, then looking back for prefixes**: faster on ordinary text, but cost depends on character distribution, and text dense in `-` or `_` becomes clearly slower.
- **A pure JavaScript Aho–Corasick automaton**: allocation-free, but per-character table lookups carry a state dependency and are slower than the native literal scan, so the most common text, without credentials, gets slower.
- **A memo rebuilt per query**: with accepted tokens between digit-free `sk-` prefixes, every query's digit search reaches the end of the text, which grows quadratically.
- **Building private-key masks in one buffer with `TextDecoder`**: one string per block, but each decode's fixed cost exceeds shared-string slices.
- **`exec` for hits and `for…of` over memo slots**: they allocate match arrays and iterator results.

## Consequences

- The added cost on text without credentials is one native scan plus checks at literals; it cannot drop further without depending on character distribution.
- A new format adds its literal and a forward-only check to the format table; resume offsets and the hit table are derived. The literal-pattern unit test rejects quantifiers, and the benchmark rejects superlinear scans and extra allocation.
- The plugin creates and owns the matcher instance in `apply`; tests and the benchmark create one per sample and share no memo.
