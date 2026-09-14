const api = window.dshDesktop

async function main() {
  const { id, messages } = await api.locale()
  document.documentElement.lang = id
  document.querySelector('#page-title').textContent = messages.startupLoading
  document.querySelector('#restart').textContent = messages.restartApplication
  document.querySelector('#disable-plugins').textContent = messages.disableThirdPartyPlugins
  document.querySelector('#reset-configuration').textContent = messages.resetConfiguration
  document.querySelector('#reset-advice').textContent = messages.startupConfigurationAdvice
  document.querySelector('#reinstall-advice').textContent = messages.startupReinstallAdvice
  function render(state) {
    const failed = state.phase === 'error'
    document.querySelector('main').setAttribute('aria-busy', String(!failed))
    document.querySelector('#spinner').hidden = failed
    document.querySelector('#title').textContent = failed ? messages.startupFailed : messages.startupLoading
    document.querySelector('#description').textContent = failed ? messages.startupErrorDescription : messages.startupLoadingDescription
    document.querySelector('#error').hidden = !failed
    document.querySelector('#error').textContent = failed ? state.message : ''
    document.querySelector('#actions').hidden = !failed
    for (const button of document.querySelectorAll('#actions button')) button.disabled = !failed
    for (const selector of ['#disable-plugins', '#reset-configuration', '#reset-advice']) {
      document.querySelector(selector).hidden = !failed || !state.profileRecovery
    }
    document.querySelector('#reinstall-advice').hidden = !failed
  }
  let changed = false
  const unsubscribe = api.backend.subscribe(state => { changed = true; render(state) })
  window.addEventListener('pagehide', unsubscribe, { once: true })
  const initial = await api.backend.status()
  if (!changed) render(initial)
  async function recover(operation) {
    render({ phase: 'starting' })
    try { await operation() }
    catch (error) {
      const current = await api.backend.status().catch(() => undefined)
      render(current?.phase === 'error' ? current : { phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  document.querySelector('#disable-plugins').addEventListener('click', () => { void recover(() => api.disablePlugins()) })
  document.querySelector('#reset-configuration').addEventListener('click', () => { void recover(() => api.resetConfiguration()) })
  document.querySelector('#restart').addEventListener('click', () => { void recover(() => api.restart()) })
}

void main()
