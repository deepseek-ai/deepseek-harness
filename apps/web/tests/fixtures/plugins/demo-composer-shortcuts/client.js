/** Offers shortcuts or a planning outline according to the current Session's mode. */
window.__ModuleLoader__.load({
  id: '@fixture/composer-shortcuts',
  factory(require) {
    const { createElement } = require('react')
    const locale = 'demo.composerShortcuts'
    const placeholder = 'conversation.input.placeholder'
    const messages = {
      en: {
        commands: 'Browse commands',
        mentions: 'Mention files or sessions',
        plan: 'Plan outline',
        goal: 'Goal',
        constraints: 'Constraints',
        criteria: 'Success criteria',
      },
      zh: {
        commands: '浏览命令',
        mentions: '引用文件或会话',
        plan: '规划提纲',
        goal: '目标',
        constraints: '约束',
        criteria: '验收标准',
      },
    }
    const fieldStyle = {
      borderRadius: 'var(--dsw-radius-xs)',
      backgroundColor: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-secondary)',
      padding: '1px 5px',
      whiteSpace: 'nowrap',
    }
    const headingStyle = {
      ...fieldStyle,
      backgroundColor: 'var(--dsw-alias-state-business-tertiary)',
      color: 'var(--dsw-alias-state-business-primary)',
      fontWeight: 500,
    }
    const keyStyle = {
      ...fieldStyle,
      border: '1px solid var(--dsw-alias-border-l2)',
      font: 'inherit',
    }

    function PlanOutline({ t }) {
      return createElement('span', { 'data-demo-composer-plan': '' },
        createElement('span', { style: headingStyle }, t('plan')), ' ',
        createElement('span', { style: fieldStyle }, t('goal')), ' · ',
        createElement('span', { style: fieldStyle }, t('constraints')), ' · ',
        createElement('span', { style: fieldStyle }, t('criteria')),
      )
    }

    function ShortcutHint({ t, useProjection }) {
      const planning = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))
      if (planning) return createElement(PlanOutline, { t })
      return createElement('span', null,
        createElement('kbd', { style: keyStyle }, '/'), ' ', t('commands'), ' · ',
        createElement('kbd', { style: keyStyle }, '@'), ' ', t('mentions'),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(locale, messages))
        ctx.slots.inject(placeholder, () => ctx.slots.register({
          name: placeholder,
          locale,
          select: () => true,
        }, ShortcutHint))
      },
    }
  },
})
