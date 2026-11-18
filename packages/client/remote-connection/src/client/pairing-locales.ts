/** Copy for Remote connection settings and owner approval. */
export const en = {
  'pairing.title': 'Pairing requests',
  'pairing.description': 'Open this app on the other device and request pairing. Compare the codes before approving.',
  'pairing.permission': 'Approval gives that browser full access to this app, including approving other devices.',
  'pairing.code': 'Pairing code',
  'pairing.sourceIp': 'Source IP',
  'pairing.sourceIpUnknown': 'Unknown',
  'pairing.approve': 'Approve',
  'pairing.deny': 'Deny',
  'pairing.retry': 'Retry',
  'pairing.loading': 'Loading pairing requests',
  'pairing.readFailed': 'Could not load requests. Retry to refresh the list.',
  'pairing.approved': 'Request approved',
  'pairing.denied': 'Request denied',
  'pairing.unavailable': 'This request is no longer awaiting approval',
  'pairing.failed': 'Could not confirm your decision. Refresh the list before trying again.',
} as const

/** Keys shared by the pairing dictionaries. */
export type PairingLocaleKey = keyof typeof en

/** Chinese pairing copy. */
export const zh: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': '来源 IP', 'pairing.sourceIpUnknown': '未知',
  'pairing.title': '配对申请',
  'pairing.description': '在另一台设备上打开此应用并申请配对，核对两端配对码后再批准',
  'pairing.permission': '批准后，该浏览器将获得此应用的完整访问权限，也可以批准其他设备',
  'pairing.code': '配对码', 'pairing.approve': '批准', 'pairing.deny': '拒绝', 'pairing.retry': '重试', 'pairing.loading': '正在加载配对申请',
  'pairing.readFailed': '无法加载申请，请重试以刷新列表', 'pairing.approved': '已批准申请', 'pairing.denied': '已拒绝申请',
  'pairing.unavailable': '此申请已不在待审批状态', 'pairing.failed': '无法确认审批结果，请刷新列表后再试',
}

/** Japanese pairing copy. */
export const ja: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': '接続元 IP', 'pairing.sourceIpUnknown': '不明',
  'pairing.title': 'ペアリング申請', 'pairing.description': '別のデバイスでこのアプリを開き、ペアリングを申請してください。承認する前に両方のコードを照合してください。',
  'pairing.permission': '承認すると、そのブラウザーはこのアプリへのフルアクセス権を得て、他のデバイスも承認できます。',
  'pairing.code': 'ペアリングコード', 'pairing.approve': '承認', 'pairing.deny': '拒否', 'pairing.retry': '再試行', 'pairing.loading': 'ペアリング申請を読み込み中',
  'pairing.readFailed': '申請を読み込めませんでした。再試行して一覧を更新してください。', 'pairing.approved': '申請を承認しました', 'pairing.denied': '申請を拒否しました',
  'pairing.unavailable': 'この申請は承認待ちではありません', 'pairing.failed': '審査結果を確認できませんでした。一覧を更新してから再試行してください。',
}

/** Spanish pairing copy. */
export const es: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': 'IP de origen', 'pairing.sourceIpUnknown': 'Desconocida',
  'pairing.title': 'Solicitudes de vinculación', 'pairing.description': 'Abra esta aplicación en el otro dispositivo y solicite la vinculación. Compare los códigos antes de aprobar.',
  'pairing.permission': 'La aprobación concede a ese navegador acceso completo a esta aplicación, incluida la capacidad de aprobar otros dispositivos.',
  'pairing.code': 'Código de vinculación', 'pairing.approve': 'Aprobar', 'pairing.deny': 'Rechazar', 'pairing.retry': 'Reintentar', 'pairing.loading': 'Cargando solicitudes de vinculación',
  'pairing.readFailed': 'No se pudieron cargar las solicitudes. Reintente para actualizar la lista.', 'pairing.approved': 'Solicitud aprobada', 'pairing.denied': 'Solicitud rechazada',
  'pairing.unavailable': 'Esta solicitud ya no está pendiente de aprobación', 'pairing.failed': 'No se pudo confirmar su decisión. Actualice la lista antes de reintentar.',
}

/** French pairing copy. */
export const fr: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': 'IP source', 'pairing.sourceIpUnknown': 'Inconnue',
  'pairing.title': 'Demandes d’association', 'pairing.description': 'Ouvrez cette application sur l’autre appareil et demandez une association. Comparez les codes avant d’approuver.',
  'pairing.permission': 'L’approbation donne à ce navigateur un accès complet à cette application, y compris la possibilité d’approuver d’autres appareils.',
  'pairing.code': 'Code d’association', 'pairing.approve': 'Approuver', 'pairing.deny': 'Refuser', 'pairing.retry': 'Réessayer', 'pairing.loading': 'Chargement des demandes d’association',
  'pairing.readFailed': 'Impossible de charger les demandes. Réessayez pour actualiser la liste.', 'pairing.approved': 'Demande approuvée', 'pairing.denied': 'Demande refusée',
  'pairing.unavailable': 'Cette demande n’est plus en attente d’approbation', 'pairing.failed': 'Impossible de confirmer votre décision. Actualisez la liste avant de réessayer.',
}

/** German pairing copy. */
export const de: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': 'Quell-IP', 'pairing.sourceIpUnknown': 'Unbekannt',
  'pairing.title': 'Kopplungsanfragen', 'pairing.description': 'Öffnen Sie diese App auf dem anderen Gerät und fordern Sie eine Kopplung an. Vergleichen Sie die Codes vor der Genehmigung.',
  'pairing.permission': 'Die Genehmigung gewährt diesem Browser vollständigen Zugriff auf diese App, einschließlich der Genehmigung weiterer Geräte.',
  'pairing.code': 'Kopplungscode', 'pairing.approve': 'Genehmigen', 'pairing.deny': 'Ablehnen', 'pairing.retry': 'Erneut versuchen', 'pairing.loading': 'Kopplungsanfragen werden geladen',
  'pairing.readFailed': 'Anfragen konnten nicht geladen werden. Versuchen Sie es erneut, um die Liste zu aktualisieren.', 'pairing.approved': 'Anfrage genehmigt', 'pairing.denied': 'Anfrage abgelehnt',
  'pairing.unavailable': 'Diese Anfrage wartet nicht mehr auf Genehmigung', 'pairing.failed': 'Ihre Entscheidung konnte nicht bestätigt werden. Aktualisieren Sie die Liste, bevor Sie es erneut versuchen.',
}

/** Russian pairing copy. */
export const ru: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': 'IP-адрес источника', 'pairing.sourceIpUnknown': 'Неизвестен',
  'pairing.title': 'Запросы на сопряжение', 'pairing.description': 'Откройте приложение на другом устройстве и запросите сопряжение. Перед одобрением сравните коды.',
  'pairing.permission': 'Одобрение предоставляет этому браузеру полный доступ к приложению, включая возможность одобрять другие устройства.',
  'pairing.code': 'Код сопряжения', 'pairing.approve': 'Одобрить', 'pairing.deny': 'Отклонить', 'pairing.retry': 'Повторить', 'pairing.loading': 'Загрузка запросов на сопряжение',
  'pairing.readFailed': 'Не удалось загрузить запросы. Повторите попытку, чтобы обновить список.', 'pairing.approved': 'Запрос одобрен', 'pairing.denied': 'Запрос отклонён',
  'pairing.unavailable': 'Этот запрос больше не ожидает одобрения', 'pairing.failed': 'Не удалось подтвердить решение. Обновите список перед повторной попыткой.',
}

/** Portuguese pairing copy. */
export const pt: Record<PairingLocaleKey, string> = {
  'pairing.sourceIp': 'IP de origem', 'pairing.sourceIpUnknown': 'Desconhecido',
  'pairing.title': 'Pedidos de emparelhamento', 'pairing.description': 'Abra esta aplicação no outro dispositivo e solicite o emparelhamento. Compare os códigos antes de aprovar.',
  'pairing.permission': 'A aprovação dá a esse navegador acesso completo a esta aplicação, incluindo a possibilidade de aprovar outros dispositivos.',
  'pairing.code': 'Código de emparelhamento', 'pairing.approve': 'Aprovar', 'pairing.deny': 'Recusar', 'pairing.retry': 'Tentar novamente', 'pairing.loading': 'A carregar pedidos de emparelhamento',
  'pairing.readFailed': 'Não foi possível carregar os pedidos. Tente novamente para atualizar a lista.', 'pairing.approved': 'Pedido aprovado', 'pairing.denied': 'Pedido recusado',
  'pairing.unavailable': 'Este pedido já não aguarda aprovação', 'pairing.failed': 'Não foi possível confirmar a decisão. Atualize a lista antes de tentar novamente.',
}
