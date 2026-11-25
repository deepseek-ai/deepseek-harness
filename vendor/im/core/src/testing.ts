/**
 * Testkit exported through the `./testing` subpath of `@deepseek-ai/cordis-plugin-im-core`.
 *
 * - {@link FakeAdapter} — an in-memory platform implementing the whole `Adapter` contract: it records every
 *   `sendPayload` / `editPayload` / `deletePart` / `upload` / stream call, installs `editPayload`/`deletePart` per
 *   config (absent ⇒ the adapter cannot edit or delete), scripts per-operation failures and returns stream drivers for
 *   the `patch`/`edit`/`append` strategies. `bot.send`/`edit`/`stream`/`render` stay the real core implementation, so a
 *   fake test exercises the real pipeline.
 * - {@link runConformance} — mode conformance check: every registered tag/variant renders natively, the shared
 *   corpus conserves its text, and `RenderReport` lists every non-native element.
 * - {@link expectGolden} — payload goldens in `<dir>/<name>.json`, rewritten with `IM_GOLDENS=update`.
 * - {@link corpusCases} / {@link streamingScripts} — the shared corpus: one case per vocabulary element and variant,
 *   plus sequences of states for stream drivers.
 *
 * Additive helpers: {@link mountFakeAdapter} (context + bot in one call), {@link createTextMode} /
 * {@link createPlainMode} (reference modes), {@link renderCorpus} (payload goldens of a whole mode) and the
 * text/report predicates used by conformance.
 *
 * @example
 * const text = createTextMode()
 * const { ctx, bot } = await mountFakeAdapter({ modes: { text } })
 * expect((await runConformance(bot, 'text')).ok).toBe(true)
 * expectGolden('text', await renderCorpus(bot, 'text'), { dir: 'tests/goldens/text' })
 * await ctx.fiber.dispose()
 */

export * from './testing/fake.ts'
export * from './testing/corpus.ts'
export * from './testing/conformance.ts'
export * from './testing/golden.ts'
export * from './testing/mode.ts'
export * from './testing/pipeline.ts'
