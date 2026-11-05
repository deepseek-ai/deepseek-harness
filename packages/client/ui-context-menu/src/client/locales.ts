/** Context-menu operation feedback, separate from plugin display metadata. */
export const dictionaries = {
  zh: { back: '返回', failed: '操作失败，请重试' },
  en: { back: 'Back', failed: 'Could not complete the action. Try again.' },
  ja: { back: '戻る', failed: '操作に失敗しました。再試行してください。' },
  es: { back: 'Atrás', failed: 'No se pudo completar la acción. Inténtelo de nuevo.' },
  fr: { back: 'Retour', failed: 'Impossible de terminer l’action. Réessayez.' },
  de: { back: 'Zurück', failed: 'Die Aktion konnte nicht abgeschlossen werden. Versuchen Sie es erneut.' },
  ru: { back: 'Назад', failed: 'Не удалось выполнить действие. Повторите попытку.' },
  pt: { back: 'Voltar', failed: 'Não foi possível concluir a ação. Tente novamente.' },
} satisfies Record<string, { back: string; failed: string }>
