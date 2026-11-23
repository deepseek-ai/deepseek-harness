/**
 * Display resolution for roster presets, shared by every surface that renders
 * preset names: shipped presets resolve through locale dictionary keys, and
 * user-authored metadata is never translated. A pure fold with no runtime imports, so
 * browser bundles inline it and the Host uses the same single home for which
 * shipped id carries which copy key.
 * @module @deepseek-ai/dsh-agent-preset-registry/display
 */

import type { BuiltInPresetCopyKey, PresetDisplaySource, PresetDisplayText } from './types.ts'

type NameKey = Extract<BuiltInPresetCopyKey, `${string}Name`>

/** Built-in mode names for each client to register in its own locale namespace. */
export const presetNames = {
  en: {
    presetStandardName: 'Standard mode', presetPtcName: 'PTC mode',
    presetMinimalName: 'Minimal mode', presetCordisName: 'Creator mode',
  },
  zh: {
    presetStandardName: '标准模式', presetPtcName: 'PTC 模式',
    presetMinimalName: '极简模式', presetCordisName: '创造模式',
  },
  ja: {
    presetStandardName: '標準モード', presetPtcName: 'PTC モード',
    presetMinimalName: '最小モード', presetCordisName: 'クリエイターモード',
  },
  es: {
    presetStandardName: 'Modo estándar', presetPtcName: 'Modo PTC',
    presetMinimalName: 'modo mínimo', presetCordisName: 'Modo creador',
  },
  fr: {
    presetStandardName: 'Mode standard', presetPtcName: 'Mode PTC',
    presetMinimalName: 'Mode minimal', presetCordisName: 'Mode Créateur',
  },
  de: {
    presetStandardName: 'Standardmodus', presetPtcName: 'PTC-Modus',
    presetMinimalName: 'Minimalmodus', presetCordisName: 'Erstellermodus',
  },
  ru: {
    presetStandardName: 'Стандартный режим', presetPtcName: 'Режим PTC',
    presetMinimalName: 'Минимальный режим', presetCordisName: 'Режим автора',
  },
  pt: {
    presetStandardName: 'Modo padrão', presetPtcName: 'modo PTC',
    presetMinimalName: 'Modo mínimo', presetCordisName: 'Modo criador',
  },
} satisfies Record<string, Record<NameKey, string>>

interface PresetLocaleKeys {
  readonly name: NameKey
  readonly description: BuiltInPresetCopyKey
}

const BUILT_IN_PRESET_KEYS: Readonly<Partial<Record<string, PresetLocaleKeys>>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  ptc: { name: 'presetPtcName', description: 'presetPtcDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/**
 * Whether a roster row is one of the shipped presets whose copy the dictionaries carry.
 * A shipped preset publishes no `name`; a declaration that names itself owns its copy.
 * @param preset - roster row.
 * @returns true for a shipped preset id without a published name.
 */
export function isBuiltInPreset(preset: PresetDisplaySource): boolean {
  return preset.name === undefined && BUILT_IN_PRESET_KEYS[preset.id] !== undefined
}

/** Whether a shipped preset requires the Coding Tools preference.
 * @param preset Roster entry; named custom overrides keep their own behavior.
 * @returns True only for the built-in PTC and Minimal presets.
 */
export function requiresCodingTools(preset: PresetDisplaySource | undefined): boolean {
  return preset !== undefined && isBuiltInPreset(preset) && (preset.id === 'ptc' || preset.id === 'minimal')
}

/**
 * Resolve a name for menus that only display the selected mode.
 * @param preset Roster entry.
 * @param t Localized built-in preset names.
 * @returns The published name, localized built-in name, or preset id.
 */
export function presetDisplayName(preset: PresetDisplaySource, t: (key: NameKey) => string): string {
  const keys = BUILT_IN_PRESET_KEYS[preset.id]
  return preset.name ?? (keys ? t(keys.name) : preset.id)
}

/**
 * Resolve preset display copy without making user-authored metadata translatable.
 * @param preset - roster row whose copy is being rendered.
 * @param t - active locale lookup covering {@link BuiltInPresetCopyKey}.
 * @returns localized copy for a known shipped preset, otherwise declaration metadata.
 */
export function presetDisplayText(
  preset: PresetDisplaySource,
  t: (key: BuiltInPresetCopyKey) => string,
): PresetDisplayText {
  const keys = isBuiltInPreset(preset) ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
  const name = presetDisplayName(preset, t)
  if (keys !== undefined) return { name, description: t(keys.description) }
  return {
    name,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}
