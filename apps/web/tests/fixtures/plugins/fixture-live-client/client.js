/** Test package using the published registration protocol, locale and slots. */
window.__ModuleLoader__.load({
  id: '@fixture/live-client',
  factory(require) {
    const React = require('react')
    const { MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives')
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/live-client'
    style.textContent = '[data-live-client] { color: rgb(12, 34, 56); position: absolute; bottom: 20px; right: 20px; }'
    document.head.append(style)
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const counters = document.documentElement.dataset
        counters.liveMounts = String(Number(counters.liveMounts ?? 0) + 1)
        ctx.effect(() => ctx.locale.register('fixtureLive', {
          zh: {
            active: '动态插件已启用', configSummary: '示例配置项', configForm: '动态插件配置', configField: '问候语', configSave: '保存',
            action: '夹具操作', badge: '夹具标签', section: '夹具区块', sectionBody: '来自夹具的区块内容',
            exportSession: '导出会话', copySessionId: '复制会话 ID',
          },
          en: {
            active: 'Live plugin enabled', configSummary: 'An example setting', configForm: 'Live plugin configuration', configField: 'Greeting', configSave: 'Save',
            action: 'Fixture action', badge: 'Fixture badge', section: 'Fixture section', sectionBody: 'Section content from the fixture',
            exportSession: 'Export session', copySessionId: 'Copy session ID',
          },
        }))
        // Detail contributions for this bundle's own page and its row's page: an
        // action at the head, a badge beside the title, and a section below.
        // The subject says what the open page is about; another bundle's page
        // gets nothing from these entries.
        const mine = (subject) => (subject.kind === 'bundle' || subject.kind === 'row') && subject.pkg.name === '@fixture/live-client'
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('button', { type: 'button', 'data-live-action': subject.kind }, t('action'))
          : null))
        ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
          name: 'plugins.detail.badge', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('span', { 'data-live-badge': subject.kind }, t('badge'))
          : null))
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('section', { 'data-live-section': subject.kind, 'aria-label': t('section') },
            React.createElement('h4', null, t('section')),
            React.createElement('p', null, t('sectionBody')))
          : null))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t }) => React.createElement('div', { 'data-live-client': '' }, t('active'))))
        // The configuration of this bundle's one row, as the Plugins page renders it on the row's own page.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@fixture/live-client#fixture-live-client', locale: 'fixtureLive',
        }, ({ t, view }) => view === 'summary'
          ? t('configSummary')
          : React.createElement('form', {
            'data-live-config': '',
            'aria-label': t('configForm'),
            onSubmit: (event) => {
              event.preventDefault()
              counters.liveSaves = String(Number(counters.liveSaves ?? 0) + 1)
            },
          },
          React.createElement('label', null, t('configField'), React.createElement('input', { name: 'greeting', defaultValue: 'hello' })),
          React.createElement('button', { type: 'submit' }, t('configSave')))))
        const actionInjected = () => ({
          selectAction(action, sessionId, displayTitle) {
            counters.sessionAction = action
            counters.sessionActionId = sessionId
            counters.sessionActionTitle = displayTitle
          },
        })
        const registerSessionAction = (id, order, label, separatorBefore) => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id, order, locale: 'fixtureLive', inject: actionInjected,
        }, ({ sessionId, displayTitle, useMenuOpenState, selectAction, t }) => {
          const [, setMenuOpen] = useMenuOpenState()
          return React.createElement(
            MenuItemButton,
            {
              separatorBefore,
              onSelect: () => {
                setMenuOpen(false)
                selectAction(id, sessionId, displayTitle)
              },
            },
            t(label),
          )
        })
        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          // The shipped rows end at archive (400); these follow as one group,
          // opened by the export row's hairline.
          yield registerSessionAction('fixture.export-session', 500, 'exportSession', true)
          yield registerSessionAction('fixture.copy-session-id', 600, 'copySessionId', false)
        })
        ctx.effect(() => {
          const ping = () => { counters.liveHits = String(Number(counters.liveHits ?? 0) + 1) }
          window.addEventListener('dsh-fixture-ping', ping)
          return async () => {
            window.removeEventListener('dsh-fixture-ping', ping)
            await Promise.resolve()
            counters.liveDisposals = String(Number(counters.liveDisposals ?? 0) + 1)
          }
        })
      },
    }
  },
})
