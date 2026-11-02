/** Copy for the API Session-log upload preference. */
export const en = {
  title: 'Upload Session Log when using the official model API',
  description: 'Help improve DeepSeek models and products.',
  saved: 'Preference saved',
  failed: 'Could not save preference',
}

/** Chinese preference copy. */
export const zh: Record<keyof typeof en, string> = {
  title: '在使用官方模型 API 时上传 Session Log',
  description: '帮助改进 DeepSeek 模型与产品',
  saved: '设置已保存',
  failed: '无法保存设置',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': '公式モデル API 使用時にセッションログをアップロード',
  'description': 'DeepSeek のモデルと製品の改善にご協力ください。',
  'saved': '設定を保存しました',
  'failed': '設定を保存できませんでした',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Cargar registro de sesión cuando utilice el modelo oficial API',
  description: 'Ayude a mejorar los modelos y productos DeepSeek.',
  saved: 'Preferencia guardada',
  failed: 'No se pudo guardar la preferencia',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: "Téléchargez le journal de session lors de l'utilisation du modèle officiel API",
  description: 'Aidez à améliorer les modèles et produits DeepSeek.',
  saved: 'Préférence enregistrée',
  failed: "Impossible d'enregistrer la préférence",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Laden Sie das Sitzungsprotokoll hoch, wenn Sie das offizielle Modell API verwenden',
  description: 'Helfen Sie mit, DeepSeek-Modelle und -Produkte zu verbessern.',
  saved: 'Präferenz gespeichert',
  failed: 'Präferenz konnte nicht gespeichert werden',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Загрузить журнал сеансов при использовании официальной модели API',
  description: 'Помогите улучшить модели и продукты DeepSeek.',
  saved: 'Предпочтение сохранено.',
  failed: 'Не удалось сохранить предпочтения.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Carregar log de sessão ao usar o modelo oficial API',
  description: 'Ajude a melhorar DeepSeek modelos e produtos.',
  saved: 'Preferência salva',
  failed: 'Não foi possível salvar a preferência',
} satisfies Record<keyof typeof en, string>
