/** Test theme that replaces one product icon with two-tone artwork painted from theme tokens. */
window.__ModuleLoader__.load({
  id: '@fixture/icon-skin',
  factory() {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
      + '<circle data-skin-disc="" cx="8" cy="8" r="6" fill="var(--dsw-alias-state-success-primary)"/>'
      + '<path d="M5 8h6" stroke="currentColor"/></svg>'
    return {
      inject: ['theme'],
      apply(ctx) {
        ctx.effect(() => ctx.theme.register({
          id: 'fixture-icon-skin',
          colorScheme: 'light',
          tokens: {},
          icons: { 'dsw-icon-search-outline-regular': icon },
        }))
        ctx.theme.setTheme('fixture-icon-skin')
      },
    }
  },
})
