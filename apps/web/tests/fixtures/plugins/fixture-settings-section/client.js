/** Test package registering its own settings page into `settings.section`. */
window.__ModuleLoader__.load({
  id: '@fixture/settings-section',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'fixture-settings-section', label: 'Fixture settings',
        }, () => React.createElement('section', { 'data-fixture-settings-section': '', 'aria-label': 'Fixture settings' },
          React.createElement('p', null, 'Settings content from the fixture'))))
      },
    }
  },
})
