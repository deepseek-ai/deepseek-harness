/** Real client plugin fixture: settings slot separator combinations. */
window.__ModuleLoader__.load({
  id: "@fixture/settings-slots-custom",
  meta() { return { stylesheets: { "repro.css": { text: () => ".slot-repro-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }\n.slot-repro-copy { min-width: 0; }\n.slot-repro-detail { font-size: 12px; color: var(--dsw-alias-label-secondary); }\n.slot-repro-bordered { border-bottom: 0.5px solid var(--dsw-alias-border-l2); }\n.slot-repro-internal { border-top: 0.5px solid var(--dsw-alias-border-l2); }" } } } },
  factory(require) {
    const React = require("react")
    const h = React.createElement
    function Row({ t, labelKey, bordered = false, internal = false }) {
      const [enabled, setEnabled] = React.useState(false)
      if (bordered && enabled) return null
      return h("div", { className: "slot-repro-row" + (bordered ? " slot-repro-bordered" : "") + (internal ? " slot-repro-internal" : ""), "data-slot-repro-row": labelKey },
        h("div", { className: "slot-repro-copy" }, t(labelKey), h("div", { className: "slot-repro-detail" }, t("detail"))),
        h("input", { type: "checkbox", checked: enabled, onChange: e => setEnabled(e.target.checked), "aria-label": t(labelKey) }))
    }
    function Single(props) { return h(Row, { ...props, labelKey: "single" }) }
    function Pair(props) { return h(React.Fragment, null, h(Row, { ...props, labelKey: "pairA" }), h(Row, { ...props, labelKey: "pairB", internal: true })) }
    function Bordered(props) { return h(Row, { ...props, labelKey: "bordered", bordered: true }) }
    function Empty() { return null }
    function Group({ renderSlot }) { return renderSlot("settings.general.group.repro.item", {}) }
    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        const ns = "slotReprocustom",
          zh = { single: "分组槽位：插件单行（不自带线）", pairA: "同一注册返回两行：A", pairB: "同一注册返回两行：B", bordered: "插件自带底线（末尾）", detail: "仅用于分割线复现，勾选不会写入产品设置", group: "插件分割线实验" },
          en = { single: "Plugin row without a divider", pairA: "Fragment row A", pairB: "Fragment row B", bordered: "Trailing row with its own divider", detail: "Separator fixture only; local state does not save preferences", group: "Plugin divider experiment" }
        ctx.effect(() => ctx.locale.register(ns, { zh, en }))
        ctx.slots.inject("settings.general.group", () => ctx.slots.register({ name: "settings.general.group", id: "repro", order: 15, label: () => ctx.locale.bind(ns)("group"), children: { "settings.general.group.repro.item": { kind: "list", scope: "root" } } }, Group))
        ctx.slots.inject("settings.general.group.repro.item", function* () {
          yield ctx.slots.register({ name: "settings.general.group.repro.item", id: "repro-custom-0", order: 100, locale: ns }, Single)
          yield ctx.slots.register({ name: "settings.general.group.repro.item", id: "repro-custom-1", order: 110, locale: ns }, Empty)
          yield ctx.slots.register({ name: "settings.general.group.repro.item", id: "repro-custom-2", order: 120, locale: ns }, Pair)
          yield ctx.slots.register({ name: "settings.general.group.repro.item", id: "repro-custom-3", order: 130, locale: ns }, Bordered)
          yield ctx.slots.register({ name: "settings.general.group.repro.item", id: "repro-custom-4", order: 140, locale: ns }, Empty)
        })
      },
    }
  },
})
