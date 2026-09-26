/** Current-page Markdown actions; each mounted instance owns one page's copy request. */
import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

type CopyState = 'idle' | 'copying' | 'copied' | 'requestFailed' | 'clipboardFailed'

const messages = {
  en: {
    copy: 'Copy page',
    copyDescription: 'Copy page as Markdown for LLMs',
    view: 'View as Markdown',
    viewDescription: 'View this page as plain text',
    newTab: 'View as Markdown (opens in a new tab)',
    menu: 'Page actions',
    more: 'More page actions',
    copying: 'Copying…',
    copied: 'Markdown copied.',
    requestFailed: 'Could not load Markdown. Open the page actions menu and choose View as Markdown to copy it manually.',
    clipboardFailed: 'Could not copy. Open the page actions menu and choose View as Markdown to copy it manually.',
  },
  zh: {
    copy: '复制页面',
    copyDescription: '将页面以 Markdown 格式复制给 LLMs',
    view: '以 Markdown 格式查看',
    viewDescription: '以纯文本查看此页面',
    newTab: '以 Markdown 格式查看（在新标签页打开）',
    menu: '页面操作',
    more: '更多页面操作',
    copying: '正在复制…',
    copied: '已复制 Markdown。',
    requestFailed: '无法加载 Markdown，请打开页面操作菜单，选择“以 Markdown 格式查看”后手动复制。',
    clipboardFailed: '复制失败，请打开页面操作菜单，选择“以 Markdown 格式查看”后手动复制。',
  },
} satisfies Record<'en' | 'zh', Record<Exclude<CopyState, 'idle'> | 'copy' | 'copyDescription' | 'view' | 'viewDescription' | 'newTab' | 'menu' | 'more', string>>

const icons = {
  copy: 'M9 8h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2ZM16 4V3a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v11',
  markdown: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 12V8l3 4 3-4v8m5-8v8m-2-2 2 2 2-2',
  chevron: 'm6 9 6 6 6-6',
  external: 'M7 17 17 7M7 7h10v10',
}

function icon(name: keyof typeof icons) {
  return h('svg', { class: `page-markdown-icon page-markdown-icon-${name}`, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false' }, [h('path', { d: icons[name] })])
}

/**
 * Actions keyed by the owning layout to the current route and language.
 * Server rendering exposes the raw link; mounting enables copying and the menu.
 * Clipboard writes begin in the click gesture; their data resolves on demand.
 */
export const PageMarkdownActions = defineComponent({
  name: 'PageMarkdownActions',
  props: {
    path: { type: String, required: true },
    lang: { type: String, required: true },
  },
  setup(props) {
    const interactive = ref(false)
    onMounted(() => { interactive.value = true })
    const state = ref<CopyState>('idle')
    const open = ref(false)
    const root = ref<HTMLElement>()
    const toggle = ref<HTMLButtonElement>()
    const menuCopy = ref<HTMLButtonElement>()
    const menuView = ref<HTMLAnchorElement>()
    const menuId = `page-markdown-${useId()}`

    function closeMenu(restoreFocus = false) {
      open.value = false
      if (restoreFocus) toggle.value?.focus()
    }

    function openMenu(last = false) {
      open.value = true
      void nextTick(() => {
        if (open.value) (last ? menuView.value : menuCopy.value)?.focus()
      })
    }

    watch(open, (visible, _previous, onCleanup) => {
      if (!visible) return
      const dismiss = (event: PointerEvent) => {
        if (event.target instanceof Node && !root.value?.contains(event.target)) closeMenu()
      }
      document.addEventListener('pointerdown', dismiss, true)
      onCleanup(() => { document.removeEventListener('pointerdown', dismiss, true) })
    })

    function menuKeydown(event: KeyboardEvent) {
      const items = [menuCopy.value, menuView.value]
      const index = items.findIndex(item => item === event.target)
      const movement: Partial<Record<string, number>> = {
        ArrowDown: (index + 1) % items.length, ArrowUp: (index + items.length - 1) % items.length,
        Home: 0, End: items.length - 1 }
      const target = movement[event.key]
      if (target !== undefined) {
        event.preventDefault()
        items[target]?.focus()
      } else if (event.key === ' ' && event.target === menuView.value) {
        event.preventDefault()
        menuView.value.click()
      }
    }
    let controller: AbortController | undefined
    onBeforeUnmount(() => {
      open.value = false
      controller?.abort()
    })

    async function copy(): Promise<void> {
      if (state.value === 'copying') return
      if (open.value) closeMenu(true)
      state.value = 'copying'
      const clipboard: Partial<Clipboard> | undefined = (navigator as Partial<Navigator>).clipboard
      if (typeof ClipboardItem === 'undefined' || clipboard?.write === undefined) {
        state.value = 'clipboardFailed'
        return
      }
      const request = new AbortController()
      controller = request
      const outcome = { requestFailed: false }
      const content = fetch(`${props.path}?dsh-raw=1`, { signal: request.signal })
        .then(async (response) => {
          const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
          if (!response.ok || (type !== 'text/markdown' && type !== 'text/plain')) {
            throw new Error('Markdown response unavailable')
          }
          const text = await response.text()
          request.signal.throwIfAborted()
          return new Blob([text], { type: 'text/plain' })
        })
        .catch((error: unknown) => {
          outcome.requestFailed = true
          throw error
        })
      void content.catch((_error: unknown) => {
        // A denied write need not consume this promise; feedback belongs to the write outcome.
      })
      try {
        await clipboard.write([new ClipboardItem({ 'text/plain': content })])
        state.value = 'copied'
      } catch (_error) {
        // Browser failures use localized feedback; their implementation-specific text is not user copy.
        state.value = outcome.requestFailed ? 'requestFailed' : 'clipboardFailed'
      } finally {
        request.abort()
        if (controller === request) controller = undefined
      }
    }

    return () => {
      const text = messages[props.lang.startsWith('zh') ? 'zh' : 'en']
      if (!interactive.value) {
        return h('div', { class: 'page-markdown-actions' }, [
          h('a', { class: 'page-markdown-static', href: props.path, target: '_blank', rel: 'noopener', 'aria-label': text.newTab },
            [text.view, icon('external')]),
        ])
      }
      return h('div', {
        ref: root, class: 'page-markdown-actions',
        onFocusout: (event: FocusEvent) => {
          if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) closeMenu()
        },
        onKeydown: (event: KeyboardEvent) => {
          if (open.value && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeMenu(true)
          }
        },
      }, [
        h('div', { class: 'page-markdown-actions-dropdown' }, [
          h('div', { class: 'page-markdown-actions-controls' }, [
            h('button', { class: 'page-markdown-copy', type: 'button',
              'aria-disabled': state.value === 'copying', 'aria-busy': state.value === 'copying', onClick: copy },
            [icon('copy'), state.value === 'copying' ? text.copying : text.copy]),
            h('button', { ref: toggle, class: 'page-markdown-toggle', type: 'button', 'aria-label': text.more,
              'aria-haspopup': 'menu', 'aria-expanded': open.value, 'aria-controls': menuId,
              onMousedown: (event: MouseEvent) => { if (open.value) event.preventDefault() },
              onClick: () => { if (open.value) closeMenu(true); else openMenu() },
              onKeydown: (event: KeyboardEvent) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  openMenu(event.key === 'ArrowUp')
                }
              },
            }, [icon('chevron')]),
          ]),
          open.value ? h('div', { id: menuId, role: 'menu', 'aria-label': text.menu,
            class: 'page-markdown-menu', onKeydown: menuKeydown,
            // Keep focus until click activation in browsers that do not focus pressed controls.
            onMousedown: (event: MouseEvent) => { event.preventDefault() } }, [
            h('button', { ref: menuCopy, role: 'menuitem', type: 'button', tabindex: -1,
              'aria-label': text.copy, 'aria-describedby': `${menuId}-copy`, 'aria-disabled': state.value === 'copying',
              'aria-busy': state.value === 'copying', onClick: copy }, [
              h('span', { class: 'page-markdown-menu-icon' }, [icon('copy')]),
              h('span', { class: 'page-markdown-menu-text' }, [h('span', { class: 'page-markdown-menu-title' }, text.copy),
                h('span', { id: `${menuId}-copy`, class: 'page-markdown-menu-description' }, text.copyDescription)]),
            ]),
            h('a', { ref: menuView, role: 'menuitem', tabindex: -1, href: props.path, target: '_blank', rel: 'noopener',
              'aria-label': text.newTab, 'aria-describedby': `${menuId}-view`, onClick: () => { closeMenu(true) } }, [
              h('span', { class: 'page-markdown-menu-icon' }, [icon('markdown')]),
              h('span', { class: 'page-markdown-menu-text' }, [h('span', { class: 'page-markdown-menu-title' }, [text.view, icon('external')]),
                h('span', { id: `${menuId}-view`, class: 'page-markdown-menu-description' }, text.viewDescription)]),
            ]),
          ]) : null,
        ]),
        h('p', { class: 'page-markdown-actions-status', role: 'status', 'aria-atomic': 'true' },
          state.value === 'idle' ? '' : text[state.value]),
      ])
    }
  },
})
