/** Context-menu operation feedback, separate from plugin display metadata. */
export const dictionaries = {
  zh: { failed: '操作失败，请重试' },
  en: { failed: 'Could not complete the action. Try again.' },
  ja: { failed: '操作に失敗しました。再試行してください。' },
  es: { failed: 'No se pudo completar la acción. Inténtelo de nuevo.' },
  fr: { failed: 'Impossible de terminer l’action. Réessayez.' },
  de: { failed: 'Die Aktion konnte nicht abgeschlossen werden. Versuchen Sie es erneut.' },
  ru: { failed: 'Не удалось выполнить действие. Повторите попытку.' },
  pt: { failed: 'Não foi possível concluir a ação. Tente novamente.' },
} satisfies Record<string, { failed: string }>
