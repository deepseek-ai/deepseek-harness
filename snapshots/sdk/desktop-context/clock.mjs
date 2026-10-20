/** Pin model-visible time for this isolated recorded-session process. */
export function apply(ctx) {
  const original = Date.now
  ctx.effect(() => {
    Date.now = () => 1792108800000
    return () => { Date.now = original }
  }, 'snapshot clock')
}
