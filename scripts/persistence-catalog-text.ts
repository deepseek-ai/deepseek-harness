/** Authored language pairs for generated persistence reference prose. */

/** Language of a generated persistence reference. */
export type PersistenceCatalogLocale = 'en' | 'zh'

const english = {
  title: 'Session Persistence Event Catalog',
  intro: 'Every repository-declared durable Session event appears here with its source declaration and resolved types. The catalog covers the logical and physical headers, event envelopes, and every plugin declaration merge. See [Session](subsystems/session.md) for replay and [persistence](subsystems/persistence.md) for storage.',
  generation: 'Run `pnpm run gen-persistence-catalog` to regenerate both catalog languages, their pairing record, the known-event module, and the machine schema inventory. `pnpm run verify-persistence-catalog` checks all generated files. Declaration fences preserve source JSDoc and type references; resolved definitions expose their transitive structure.',
  envelopeIntro: 'The envelope carries `type`, `seq`, `time`, `data`, optional `ignorable`, and conditional `surfaceOp` / `sourceEventSeqs`. A **surface** event produces model history; a **log-only** event does not. The inventory covers this repository; external plugin types require their own declarations and are outside this catalog.',
  envelope: 'Event envelope', events: 'Events', sources: 'Sources: ', source: 'Source: ', types: 'Types: ',
  fingerprints: 'Persistence type fingerprints',
  fingerprintsIntro: 'The [machine inventory](persistence-schema.json) contains every reachable normalized type and its SHA-256 digest. Root digests include referenced types. Comments, source locations, alias names, erased brands, readonly markers, and harmless field, union, or intersection reordering do not affect these fingerprints. Tuple order, property names, value types, and optionality do. Catalog text and source locations can still produce a diff when digests stay unchanged.',
  historyIntro: 'The [format references](persistence-changes/historical-formats/README.md) cover every historical Session format. The [change records](persistence-changes/README.md) acknowledge exact transitions using snapshots kept in this tree. Follow the [review workflow](cookbook/reviewing-persistence-type-changes.md) to classify a change and record it. These checks cover declared type structure; opaque payload contents and behavior without type changes are outside their scope.',
  rootColumns: '| Root | Kind | SHA-256 | Resolved type |',
  definitions: 'Resolved persistence types',
  definitionsIntro: 'Each definition appears once. References preserve sharing and recursion; the digest beside a definition includes its complete reachable structure. Source names and locations identify its declarations but are excluded from its digest.',
  propertyColumns: '| Property | Presence | Type |', positionColumns: '| Position | Presence | Type |',
  optional: 'optional', required: 'required', rest: 'rest', index: 'index signature',
  emptyObject: 'Object with no declared properties.', arrayPrefix: 'Array of ', arraySuffix: '.',
  oneOf: 'One of:', opaque: ' (opaque)', opaqueExplanation: ": the declaration does not expose the stored value's internal fields.",
}

const chinese: Record<keyof typeof english, string> = {
  title: '会话持久化事件目录',
  intro: '本目录列出仓库声明的每个持久化 Session 事件及其源码声明和解析类型，覆盖逻辑与物理 header、事件信封以及各插件的声明合并。回放规则参见 [Session](subsystems/session.zh.md)，存储规则参见[持久化](subsystems/persistence.zh.md)。',
  generation: '运行 `pnpm run gen-persistence-catalog` 可重新生成目录的两种语言、配对记录、已知事件模块和机器 schema 目录。`pnpm run verify-persistence-catalog` 检查所有生成文件。声明围栏保留源码 JSDoc 和类型引用；解析后的定义展开其传递引用结构。',
  envelopeIntro: '信封包含 `type`、`seq`、`time`、`data`、可选的 `ignorable` 以及条件字段 `surfaceOp` / `sourceEventSeqs`。**surface** 事件产生模型历史，**log-only** 事件不产生模型历史。目录覆盖本仓库；外部插件类型需要独立声明，不属于本目录。',
  envelope: '事件信封', events: '事件', sources: '来源：', source: '来源：', types: '类型：',
  fingerprints: '持久化类型指纹',
  fingerprintsIntro: '[机器可读目录](persistence-schema.json)包含所有可达的规范化类型及其 SHA-256 摘要。根类型的摘要涵盖引用类型。注释、源码位置、别名、擦除的品牌标记、readonly 标记以及无语义变化的字段、联合类型或交叉类型重排不影响摘要；元组顺序、属性名称、值类型和可选性会影响摘要。摘要不变时，目录文本和源码位置仍可能产生 diff。',
  historyIntro: '[格式参考](persistence-changes/historical-formats/README.zh.md)覆盖每个历史 Session 格式。[变更记录](persistence-changes/README.zh.md)通过保存在本源码树中的快照确认精确的类型转换。按照[评审流程](cookbook/reviewing-persistence-type-changes.zh.md)分类并记录变更。这些检查覆盖已声明的类型结构；不透明载荷的内部内容和未改变类型的行为变更不在检查范围内。',
  rootColumns: '| 根类型 | 类别 | SHA-256 | 已解析类型 |',
  definitions: '已解析的持久化类型',
  definitionsIntro: '每个类型定义仅列出一次。引用保留共享和递归关系；定义旁的摘要涵盖其完整可达结构。源码名称和位置标识声明来源，但不参与摘要计算。',
  propertyColumns: '| 属性 | 存在性 | 类型 |', positionColumns: '| 位置 | 存在性 | 类型 |',
  optional: '可选', required: '必需', rest: '剩余项', index: '索引签名',
  emptyObject: '无已声明属性的对象。', arrayPrefix: '', arraySuffix: ' 的数组。',
  oneOf: '以下类型之一：', opaque: '（不透明）', opaqueExplanation: '：此声明未暴露存储值的内部字段。',
}

/** Complete translated prose; adding an English key requires its Chinese counterpart. */
export const persistenceCatalogText = { en: english, zh: chinese }
