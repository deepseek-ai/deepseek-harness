const api = window.dshDesktop

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.npmPackage
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button, input')) control.disabled = busy
    status.textContent = statusMessage
  }

  async function render() {
    const plugins = await api.plugins.list()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.version
      identity.append(document.createTextNode(plugin.name), version)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.plugins.remove(plugin.name),
        message('removing', { name: plugin.name }),
      ))
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = messages.update
      update.addEventListener('click', () => {
        const next = window.prompt(message('targetVersion', { name: plugin.name }), plugin.version)?.trim()
        if (next === undefined || next === '' || next === plugin.version) return
        void run(() => api.plugins.update(plugin.name, next), message('updating', { name: plugin.name }))
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      actions.append(update, remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function run(operation, statusMessage) {
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = messages.operationComplete
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))

  await load(messages.loadingPlugins, '')
}

void main()
