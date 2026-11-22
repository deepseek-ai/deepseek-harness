/** Shows a three-step review outline in the empty composer of the configured Session. */
window.__ModuleLoader__.load({
  id: '@fixture/composer-review-session',
  factory(require) {
    const { createElement } = require('react')
    const slot = 'conversation.input.placeholder'
    const locale = 'demoComposerReviewSession'
    const steps = [
      { key: 'changes', accent: 'var(--dsw-alias-state-business-primary)' },
      { key: 'risks', accent: 'var(--dsw-alias-state-warn-primary)' },
      { key: 'tests', accent: 'var(--dsw-alias-state-done-primary)' },
    ]
    const leadStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontWeight: 500,
      marginInlineEnd: '4px',
    }
    const stepStyle = {
      display: 'inline-block',
      paddingInline: '7px',
      borderRadius: 'var(--dsw-radius-xs)',
      fontSize: '0.875em',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      verticalAlign: 'baseline',
    }
    const connectorStyle = {
      display: 'inline-block',
      inlineSize: '8px',
      blockSize: '1px',
      marginInline: '1px 5px',
      verticalAlign: 'middle',
      backgroundColor: 'var(--dsw-alias-border-l4)',
    }

    function ReviewStep({ id, accent, label, linked }) {
      return createElement('span', { style: { whiteSpace: 'nowrap' } },
        linked && createElement('span', { 'aria-hidden': true, style: connectorStyle }),
        createElement('span', {
          'data-demo-review-step': id,
          style: {
            ...stepStyle,
            backgroundColor: `color-mix(in srgb, ${accent} 13%, transparent)`,
            boxShadow: `inset 2px 0 ${accent}`,
          },
        }, label),
      )
    }

    function ReviewHint({ t }) {
      return createElement('span', { 'data-demo-review-path': '' },
        createElement('span', { style: leadStyle }, t('review')),
        ...steps.flatMap(({ key, accent }, index) => [
          ' ',
          createElement(ReviewStep, { key, id: key, accent, label: t(key), linked: index > 0 }),
        ]),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx, config) {
        ctx.effect(() => ctx.locale.register(locale, {
          en: { review: 'Review', changes: 'Changes', risks: 'Risks', tests: 'Tests' },
          zh: { review: '审查', changes: '改动', risks: '风险', tests: '测试' },
        }))

        ctx.slots.inject(slot, () => {
          function register() {
            const targetSessionId = config.sessionId.get()
            return ctx.slots.register({
              name: slot,
              locale,
              priority: -1,
              select: ({ sessionId }) => sessionId === targetSessionId ? sessionId : null,
            }, ReviewHint)
          }

          let dispose = register()
          const unsubscribe = config.sessionId.subscribe(() => {
            dispose()
            dispose = register()
          })
          return () => {
            unsubscribe()
            dispose()
          }
        })
      },
    }
  },
})
