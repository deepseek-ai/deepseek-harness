/** Client face of the synced-configuration fixture: exports no Config and records what its synced Config object shows. */
window.__ModuleLoader__.load({
  id: '@fixture/synced-config',
  factory() {
    return {
      apply(ctx, config) {
        const data = document.documentElement.dataset
        data.syncedApplies = String(Number(data.syncedApplies ?? 0) + 1)
        // References are read at operation time; `Object.keys` lists the fields the Host sent.
        const publish = () => {
          data.syncedConfig = JSON.stringify({
            keys: Object.keys(config).sort(),
            greeting: config.greeting.get(),
            account: config.account.get(),
          })
        }
        publish()
        let notifications = 0
        const notified = () => {
          notifications++
          data.syncedNotifications = String(notifications)
          publish()
        }
        ctx.effect(() => config.greeting.subscribe(notified))
        ctx.effect(() => config.account.subscribe(notified))
      },
    }
  },
})
