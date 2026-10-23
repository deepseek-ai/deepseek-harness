/** `feedback` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.like': '好的回答',
  'action.likeActive': '取消标记',
  'action.dislike': '有问题的回答',
  'action.dislikeActive': '取消标记',
  'dialog.title': '提交反馈',
  'dialog.categories': '反馈分类',
  'dialog.detail': '反馈详情',
  'dialog.hint': '填写详情以帮助我们改进体验，提交内容会包括当前对话的日志',
  'category.task-result': '任务结果',
  'category.instruction-following': '指令理解与遵循',
  'category.product-interaction': '产品功能与交互',
  'category.service-stability': '稳定性和速度',
  'category.resource-cost': '资源使用与费用',
  'category.security-privacy-permission': '安全隐私与权限',
  'category.other': '其他',
  'toast.recorded': '感谢你的反馈',
  'error.conflict': '这条反馈已在别处改动，已显示最新状态',
  'error.load': '反馈状态加载失败',
  'error.generic': '反馈保存失败',
  'error.noteTooLarge': '描述太长，请缩短后再提交',
} satisfies Record<string, string>

/** The feedback namespace key union. */
export type MessageFeedbackKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The feedback surface's copy: the message controls, the dialog, and the acknowledgement. */
    feedback: MessageFeedbackKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.like': 'Good response',
  'action.likeActive': 'Remove rating',
  'action.dislike': 'Bad response',
  'action.dislikeActive': 'Remove rating',
  'dialog.title': 'Submit feedback',
  'dialog.categories': 'Feedback category',
  'dialog.detail': 'Feedback details',
  'dialog.hint': 'Add details to help us improve. Your submission will include the current conversation log.',
  'category.task-result': 'Task result',
  'category.instruction-following': 'Instruction understanding and following',
  'category.product-interaction': 'Product features and interaction',
  'category.service-stability': 'Stability and speed',
  'category.resource-cost': 'Resource usage and cost',
  'category.security-privacy-permission': 'Security, privacy, and permissions',
  'category.other': 'Other',
  'toast.recorded': 'Thanks for your feedback',
  'error.conflict': 'This feedback changed elsewhere; the latest state is shown',
  'error.load': 'Could not load feedback',
  'error.generic': 'Could not save feedback',
  'error.noteTooLarge': 'The description is too long; shorten it and submit again',
} satisfies Record<MessageFeedbackKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'action.like': '良い回答',
  'action.likeActive': '評価を取り消す',
  'action.dislike': '悪い回答',
  'action.dislikeActive': '評価を取り消す',
  'dialog.title': 'フィードバックを送信',
  'dialog.categories': 'フィードバックのカテゴリ',
  'dialog.detail': 'フィードバックの詳細',
  'dialog.hint': '改善のため詳細を追加してください。現在の会話ログが送信内容に含まれます。',
  'category.task-result': 'タスク結果',
  'category.instruction-following': '指示の理解と遵守',
  'category.product-interaction': '製品機能と操作',
  'category.service-stability': '安定性と速度',
  'category.resource-cost': 'リソース使用量とコスト',
  'category.security-privacy-permission': 'セキュリティ、プライバシー、権限',
  'category.other': 'その他',
  'toast.recorded': 'フィードバックありがとうございます',
  'error.conflict': 'このフィードバックは別の場所で変更されました。最新の状態を表示しています',
  'error.load': 'フィードバックを読み込めませんでした',
  'error.generic': 'フィードバックを保存できませんでした',
  'error.noteTooLarge': '説明が長すぎます。短くして再送信してください',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'action.like': 'buena respuesta',
  'action.likeActive': 'Eliminar calificación',
  'action.dislike': 'Mala respuesta',
  'action.dislikeActive': 'Eliminar calificación',
  'dialog.title': 'Enviar comentarios',
  'dialog.categories': 'Categoría de comentarios',
  'dialog.detail': 'Detalles de comentarios',
  'dialog.hint': 'Añade detalles para ayudarnos a mejorar. Su envío incluirá el registro de conversación actual.',
  'category.task-result': 'Resultado de la tarea',
  'category.instruction-following': 'Comprensión y seguimiento de instrucciones.',
  'category.product-interaction': 'Características del producto e interacción.',
  'category.service-stability': 'Estabilidad y velocidad',
  'category.resource-cost': 'Uso y costo de recursos',
  'category.security-privacy-permission': 'Seguridad, privacidad y permisos',
  'category.other': 'Otro',
  'toast.recorded': 'Gracias por tus comentarios',
  'error.conflict': 'Esta retroalimentación cambió en otros lugares; se muestra el último estado',
  'error.load': 'No se pudieron cargar los comentarios',
  'error.generic': 'No se pudieron guardar los comentarios',
  'error.noteTooLarge': 'La descripción es demasiado larga; acortarlo y enviarlo de nuevo',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'action.like': 'Bonne réponse',
  'action.likeActive': 'Supprimer la note',
  'action.dislike': 'Mauvaise réponse',
  'action.dislikeActive': 'Supprimer la note',
  'dialog.title': 'Soumettre des commentaires',
  'dialog.categories': 'Catégorie de commentaires',
  'dialog.detail': 'Détails des commentaires',
  'dialog.hint': 'Ajoutez des détails pour nous aider à nous améliorer. Votre soumission inclura le journal de conversation actuel.',
  'category.task-result': 'Résultat de la tâche',
  'category.instruction-following': 'Compréhension et suivi des instructions',
  'category.product-interaction': 'Caractéristiques du produit et interaction',
  'category.service-stability': 'Stabilité et vitesse',
  'category.resource-cost': 'Utilisation et coût des ressources',
  'category.security-privacy-permission': 'Sécurité, confidentialité et autorisations',
  'category.other': 'Autre',
  'toast.recorded': 'Merci pour vos commentaires',
  'error.conflict': 'Cette rétroaction a changé ailleurs ; le dernier état est affiché',
  'error.load': 'Impossible de charger les commentaires',
  'error.generic': "Impossible d'enregistrer les commentaires",
  'error.noteTooLarge': 'La description est trop longue ; raccourcissez-le et soumettez-le à nouveau',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'action.like': 'Gute Resonanz',
  'action.likeActive': 'Bewertung entfernen',
  'action.dislike': 'Schlechte Reaktion',
  'action.dislikeActive': 'Bewertung entfernen',
  'dialog.title': 'Feedback abgeben',
  'dialog.categories': 'Feedback-Kategorie',
  'dialog.detail': 'Feedback-Details',
  'dialog.hint': 'Fügen Sie Details hinzu, um uns bei der Verbesserung zu helfen. Ihre Einreichung enthält das aktuelle Gesprächsprotokoll.',
  'category.task-result': 'Aufgabenergebnis',
  'category.instruction-following': 'Anweisungen verstehen und befolgen',
  'category.product-interaction': 'Produkteigenschaften und Interaktion',
  'category.service-stability': 'Stabilität und Geschwindigkeit',
  'category.resource-cost': 'Ressourcennutzung und Kosten',
  'category.security-privacy-permission': 'Sicherheit, Datenschutz und Berechtigungen',
  'category.other': 'Andere',
  'toast.recorded': 'Vielen Dank für Ihr Feedback',
  'error.conflict': 'Dieses Feedback hat sich an anderer Stelle geändert; der aktuelle Stand wird angezeigt',
  'error.load': 'Feedback konnte nicht geladen werden',
  'error.generic': 'Das Feedback konnte nicht gespeichert werden',
  'error.noteTooLarge': 'Die Beschreibung ist zu lang; kürzen Sie es und reichen Sie es erneut ein',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'action.like': 'Хороший ответ',
  'action.likeActive': 'Удалить оценку',
  'action.dislike': 'Плохой ответ',
  'action.dislikeActive': 'Удалить оценку',
  'dialog.title': 'Отправить отзыв',
  'dialog.categories': 'Категория обратной связи',
  'dialog.detail': 'Подробности обратной связи',
  'dialog.hint': 'Добавьте детали, чтобы помочь нам стать лучше. Ваше сообщение будет включать текущий журнал разговоров.',
  'category.task-result': 'Результат задачи',
  'category.instruction-following': 'Понимание и следование инструкциям',
  'category.product-interaction': 'Особенности продукта и взаимодействие',
  'category.service-stability': 'Стабильность и скорость',
  'category.resource-cost': 'Использование ресурсов и стоимость',
  'category.security-privacy-permission': 'Безопасность, конфиденциальность и разрешения',
  'category.other': 'Другое',
  'toast.recorded': 'Спасибо за ваш отзыв',
  'error.conflict': 'Этот отзыв изменился в другом месте; отображается последнее состояние',
  'error.load': 'Не удалось загрузить отзыв.',
  'error.generic': 'Не удалось сохранить отзыв',
  'error.noteTooLarge': 'Описание слишком длинное; сократите его и отправьте снова',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'action.like': 'Boa resposta',
  'action.likeActive': 'Remover avaliação',
  'action.dislike': 'Resposta ruim',
  'action.dislikeActive': 'Remover avaliação',
  'dialog.title': 'Enviar comentários',
  'dialog.categories': 'Categoria de comentários',
  'dialog.detail': 'Detalhes do feedback',
  'dialog.hint': 'Adicione detalhes para nos ajudar a melhorar. Seu envio incluirá o registro da conversa atual.',
  'category.task-result': 'Resultado da tarefa',
  'category.instruction-following': 'Compreensão e seguimento das instruções',
  'category.product-interaction': 'Recursos e interação do produto',
  'category.service-stability': 'Estabilidade e velocidade',
  'category.resource-cost': 'Uso e custo de recursos',
  'category.security-privacy-permission': 'Segurança, privacidade e permissões',
  'category.other': 'Outro',
  'toast.recorded': 'Obrigado pelo seu feedback',
  'error.conflict': 'Este feedback mudou em outro lugar; o estado mais recente é mostrado',
  'error.load': 'Não foi possível carregar o feedback',
  'error.generic': 'Não foi possível salvar o feedback',
  'error.noteTooLarge': 'A descrição é muito longa; encurte-o e envie novamente',
} satisfies Record<keyof typeof en, string>
