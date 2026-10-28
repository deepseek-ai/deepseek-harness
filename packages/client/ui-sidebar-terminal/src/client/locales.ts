/** Copy owned by the sidebar terminal feature. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sidebarTerminal: keyof typeof zh
  }
}

/** Simplified Chinese terminal copy. */
export const zh = {
  'shortcut.noSession': '请先选择会话',
  recoveryFailed: '恢复终端失败：{message}', retryRecovery: '重试恢复终端',
  shell: '选择 Shell', shellLoading: '正在读取 Shell…', shellEmpty: '没有可用的 Shell', description: '在会话工作区运行命令',
  title: '终端', new: '新建终端', loading: '正在读取终端环境…', creating: '正在启动…',
  connecting: '正在连接…', disconnected: '连接已断开。', reconnect: '重新连接',
  readonly: '此页面当前只读。', control: '接管输入',
  closed: '终端已关闭。', exited: '进程已退出（{code}）', failed: '终端错误：{message}',
  rename: '终端名称', unavailable: '不可用', retry: '重试',
  cleanupFailed: '终端「{title}」未能结束：{message}',
  missingTerminal: '此终端已不存在，请新建终端。',
  inputFull: '输入缓冲区已满，请重新连接后重试。',
  attachmentEnded: '终端连接已结束，请重新连接。',
  invalidOutput: '终端画面传输异常，请重新连接。',
  terminalLimit: '终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。',
} satisfies Record<string, string>

/** English terminal copy. */
export const en = {
  'shortcut.noSession': 'Select a session first',
  recoveryFailed: 'Terminal recovery failed: {message}', retryRecovery: 'Retry terminal recovery',
  shell: 'Choose shell', shellLoading: 'Loading shells…', shellEmpty: 'No shells available', description: 'Run commands in the Session workspace',
  title: 'Terminal', new: 'New terminal', loading: 'Reading terminal environment…', creating: 'Starting…',
  connecting: 'Connecting…', disconnected: 'Disconnected.', reconnect: 'Reconnect',
  readonly: 'This view is read-only.', control: 'Take control',
  closed: 'Terminal closed.', exited: 'Process exited ({code})', failed: 'Terminal error: {message}',
  rename: 'Terminal name', unavailable: 'Unavailable', retry: 'Retry',
  cleanupFailed: 'Terminal “{title}” could not be ended: {message}',
  missingTerminal: 'This terminal no longer exists. Open a new terminal.',
  inputFull: 'The input buffer is full. Reconnect and try again.',
  attachmentEnded: 'The terminal connection ended. Reconnect to continue.',
  invalidOutput: 'The terminal screen could not be received. Reconnect to recover it.',
  terminalLimit: 'The terminal limit has been reached. Close unused terminals and try again. Exited terminals also count toward the limit.',
} satisfies Record<keyof typeof zh, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'shortcut.noSession': '先にセッションを選択してください',
  'recoveryFailed': 'ターミナルの復元に失敗しました: {message}',
  'retryRecovery': 'ターミナルの復元を再試行',
  'shell': 'シェルを選択',
  'shellLoading': 'シェルを読み込み中…',
  'shellEmpty': '利用可能なシェルがありません',
  'description': 'セッションのワークスペースでコマンドを実行',
  'title': 'ターミナル',
  'new': '新しいターミナル',
  'loading': 'ターミナル環境を読み込み中…',
  'creating': '起動中…',
  'connecting': '接続中…',
  'disconnected': '切断されました。',
  'reconnect': '再接続',
  'readonly': 'このビューは読み取り専用です。',
  'control': '制御を取得',
  'closed': 'ターミナルが閉じられました。',
  'exited': 'プロセスが終了しました（{code}）',
  'failed': 'ターミナルエラー: {message}',
  'rename': 'ターミナル名',
  'unavailable': '利用不可',
  'retry': '再試行',
  'cleanupFailed': 'ターミナル「{title}」を終了できませんでした: {message}',
  'missingTerminal': 'このターミナルはすでに存在しません。新しいターミナルを開いてください。',
  'inputFull': '入力バッファがいっぱいです。再接続して再試行してください。',
  'attachmentEnded': 'ターミナル接続が終了しました。続行するには再接続してください。',
  'invalidOutput': 'ターミナル画面を受信できませんでした。再接続して復元してください。',
  'terminalLimit': 'ターミナルの上限に達しました。未使用のターミナルを閉じて再試行してください。終了したターミナルも上限に含まれます。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'shortcut.noSession': 'Seleccione una sesión primero',
  recoveryFailed: 'Falló la recuperación del terminal: {message}', retryRecovery: 'Reintentar la recuperación del terminal',
  shell: 'Elige concha', shellLoading: 'Cargando proyectiles…', shellEmpty: 'No hay conchas disponibles', description: 'Ejecutar comandos en el espacio de trabajo de sesión',
  title: 'terminales', new: 'Nueva terminal', loading: 'Entorno de terminal de lectura...', creating: 'Empezando…',
  connecting: 'Conectando…', disconnected: 'Desconectado.', reconnect: 'Reconectar',
  readonly: 'Esta vista es de sólo lectura.', control: 'toma el control',
  closed: 'Terminal cerrada.', exited: 'Proceso cerrado ({code})', failed: 'Error de terminal: {message}',
  rename: 'Nombre del terminal', unavailable: 'No disponible', retry: 'Reintentar',
  cleanupFailed: 'No se pudo finalizar el terminal “{title}”: {message}',
  missingTerminal: 'Esta terminal ya no existe. Abra una nueva terminal.',
  inputFull: 'El búfer de entrada está lleno. Vuelve a conectarte y vuelve a intentarlo.',
  attachmentEnded: 'La conexión del terminal terminó. Vuelva a conectarse para continuar.',
  invalidOutput: 'No se pudo recibir la pantalla del terminal. Vuelva a conectarse para recuperarlo.',
  terminalLimit: 'Se ha alcanzado el límite terminal. Cierre los terminales no utilizados y vuelva a intentarlo. Las terminales salidas también cuentan para el límite.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'shortcut.noSession': "Sélectionnez d'abord une session",
  recoveryFailed: 'Échec de la récupération du terminal : {message}', retryRecovery: 'Réessayez la récupération du terminal',
  shell: 'Choisissez la coque', shellLoading: 'Chargement des obus…', shellEmpty: 'Aucune coquille disponible', description: 'Exécuter des commandes dans l’espace de travail de la session',
  title: 'Borne', new: 'Nouvelle borne', loading: 'Environnement du terminal de lecture…', creating: 'Commencer…',
  connecting: 'Connexion…', disconnected: 'Déconnecté.', reconnect: 'Reconnecter',
  readonly: 'Cette vue est en lecture seule.', control: 'Prenez le contrôle',
  closed: 'Borne fermée.', exited: 'Processus terminé ({code})', failed: 'Erreur de terminal : {message}',
  rename: 'Nom du terminal', unavailable: 'Indisponible', retry: 'Réessayer',
  cleanupFailed: "Le terminal « {title} » n'a pas pu être terminé : {message}",
  missingTerminal: "Ce terminal n'existe plus. Ouvrez un nouveau terminal.",
  inputFull: "Le tampon d'entrée est plein. Reconnectez-vous et réessayez.",
  attachmentEnded: 'La connexion du terminal est terminée. Reconnectez-vous pour continuer.',
  invalidOutput: "L'écran du terminal n'a pas pu être reçu. Reconnectez-vous pour le récupérer.",
  terminalLimit: 'La limite terminale a été atteinte. Fermez les terminaux inutilisés et réessayez. Les terminaux sortis comptent également dans la limite.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'shortcut.noSession': 'Wählen Sie zunächst eine Sitzung aus',
  recoveryFailed: 'Terminalwiederherstellung fehlgeschlagen: {message}', retryRecovery: 'Versuchen Sie die Terminalwiederherstellung erneut',
  shell: 'Wählen Sie Shell', shellLoading: 'Granaten werden geladen…', shellEmpty: 'Keine Muscheln verfügbar', description: 'Führen Sie Befehle im Sitzungsarbeitsbereich aus',
  title: 'Terminal', new: 'Neues Terminal', loading: 'Terminalumgebung lesen…', creating: 'Beginnend mit …',
  connecting: 'Verbinden…', disconnected: 'Nicht verbunden.', reconnect: 'Wieder verbinden',
  readonly: 'Diese Ansicht ist schreibgeschützt.', control: 'Übernehmen Sie die Kontrolle',
  closed: 'Terminal geschlossen.', exited: 'Prozess beendet ({code})', failed: 'Terminalfehler: {message}',
  rename: 'Terminalname', unavailable: 'Nicht verfügbar', retry: 'Erneut versuchen',
  cleanupFailed: 'Terminal „{title}“ konnte nicht beendet werden: {message}',
  missingTerminal: 'Dieses Terminal existiert nicht mehr. Öffnen Sie ein neues Terminal.',
  inputFull: 'Der Eingabepuffer ist voll. Stellen Sie die Verbindung wieder her und versuchen Sie es erneut.',
  attachmentEnded: 'Die Terminalverbindung wurde beendet. Stellen Sie die Verbindung wieder her, um fortzufahren.',
  invalidOutput: 'Der Terminalbildschirm konnte nicht empfangen werden. Stellen Sie die Verbindung wieder her, um es wiederherzustellen.',
  terminalLimit: 'Das Endlimit wurde erreicht. Schließen Sie nicht verwendete Terminals und versuchen Sie es erneut. Auch verlassene Terminals werden auf das Limit angerechnet.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'shortcut.noSession': 'Сначала выберите сеанс',
  recoveryFailed: 'Восстановление терминала не удалось: {message}', retryRecovery: 'Повторить попытку восстановления терминала',
  shell: 'Выбрать оболочку', shellLoading: 'Загрузка снарядов…', shellEmpty: 'Нет доступных ракушек', description: 'Запуск команд в рабочей области сеанса',
  title: 'Терминал', new: 'Новый терминал', loading: 'Чтение среды терминала…', creating: 'Начало…',
  connecting: 'Подключение…', disconnected: 'Отключено.', reconnect: 'Восстановить соединение',
  readonly: 'Это представление доступно только для чтения.', control: 'Возьмите под свой контроль',
  closed: 'Терминал закрыт.', exited: 'Процесс завершен ({code})', failed: 'Ошибка терминала: {message}',
  rename: 'Имя терминала', unavailable: 'Недоступно', retry: 'Повторить',
  cleanupFailed: 'Терминал «{title}» не удалось завершить: {message}',
  missingTerminal: 'Этого терминала больше не существует. Откройте новый терминал.',
  inputFull: 'Входной буфер заполнен. Подключитесь и повторите попытку.',
  attachmentEnded: 'Терминальное соединение завершилось. Подключитесь повторно, чтобы продолжить.',
  invalidOutput: 'Не удалось получить экран терминала. Повторно подключитесь, чтобы восстановить его.',
  terminalLimit: 'Достигнут лимит терминала. Закройте неиспользуемые терминалы и повторите попытку. Вышедшие терминалы также учитываются в лимите.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'shortcut.noSession': 'Selecione uma sessão primeiro',
  recoveryFailed: 'Falha na recuperação do terminal: {message}', retryRecovery: 'Tentar novamente a recuperação do terminal',
  shell: 'Escolha a concha', shellLoading: 'Carregando conchas…', shellEmpty: 'Não há conchas disponíveis', description: 'Execute comandos no espaço de trabalho Sessão',
  title: 'Terminais', new: 'Novo terminal', loading: 'Lendo o ambiente do terminal…', creating: 'Começando…',
  connecting: 'Conectando…', disconnected: 'Desconectado.', reconnect: 'Reconectar',
  readonly: 'Esta visualização é somente leitura.', control: 'Assuma o controle',
  closed: 'Terminal fechado.', exited: 'Processo encerrado ({code})', failed: 'Erro de terminal: {message}',
  rename: 'Nome do terminal', unavailable: 'Indisponível', retry: 'Tentar novamente',
  cleanupFailed: 'O terminal “{title}” não pôde ser finalizado: {message}',
  missingTerminal: 'Este terminal não existe mais. Abra um novo terminal.',
  inputFull: 'O buffer de entrada está cheio. Reconecte e tente novamente.',
  attachmentEnded: 'A conexão do terminal terminou. Reconecte para continuar.',
  invalidOutput: 'A tela do terminal não pôde ser recebida. Reconecte para recuperá-lo.',
  terminalLimit: 'O limite terminal foi atingido. Feche os terminais não utilizados e tente novamente. Os terminais encerrados também contam para o limite.',
} satisfies Record<keyof typeof en, string>
