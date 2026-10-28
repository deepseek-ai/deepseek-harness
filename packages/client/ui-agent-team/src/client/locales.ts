/** Agent Teams Web dictionaries. */

/** Locale namespace owned by the Agent Teams Web UI. */
export const NS = 'agent-team'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '任务板',
  'mode.label': '使用智能体团队',
  'mode.failed': '无法确认智能体团队设置已保存，请重试：{message}',
  loading: '正在加载任务板…',
  unavailable: '任务板暂不可用',
  failure: '任务记录无效：{message}',
  empty: '暂无共享任务，可以通过对话创建',
  tasks: '共享任务',
  owner: '负责人',
  lead: '主代理',
  unowned: '未分配',
  blockedBy: '依赖',
  writeScopes: '写入范围',
  ready: '可开始',
  blocked: '被依赖阻塞',
  'task.expand': '展开',
  'task.collapse': '收起',
  'status.pending': '待处理',
  'status.in_progress': '进行中',
  'status.completed': '已完成',
} satisfies Record<string, string>

/** Agent Teams locale key union. */
export type TeamKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Task board',
  'mode.label': 'Use Agent Teams',
  'mode.failed': 'Could not confirm Agent Teams was saved. Try again: {message}',
  loading: 'Loading task board…',
  unavailable: 'Task board is unavailable',
  failure: 'Invalid persisted task record: {message}',
  empty: 'No shared tasks yet. Create them through the conversation.',
  tasks: 'Shared tasks',
  owner: 'Owner',
  lead: 'Lead',
  unowned: 'Unowned',
  blockedBy: 'Blocked by',
  writeScopes: 'Write scopes',
  ready: 'Ready',
  blocked: 'Blocked by dependencies',
  'task.expand': 'Show more',
  'task.collapse': 'Show less',
  'status.pending': 'Pending',
  'status.in_progress': 'In progress',
  'status.completed': 'Completed',
} satisfies Record<TeamKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'mode.label': 'エージェントチームを使用',
  'mode.failed': 'エージェントチーム設定の保存を確認できませんでした。再試行してください: {message}',
  'trigger': 'タスクボード',
  'loading': 'タスクボードを読み込み中…',
  'unavailable': 'タスクボードは利用できません',
  'failure': '保存されたタスクレコードが無効です: {message}',
  'empty': '共有タスクはまだありません。会話から作成してください。',
  'tasks': '共有タスク',
  'owner': 'オーナー',
  'lead': 'リード',
  'unowned': 'オーナーなし',
  'blockedBy': 'ブロック元',
  'writeScopes': '書き込みスコープ',
  'ready': '準備完了',
  'blocked': '依存関係によりブロック中',
  'task.expand': 'もっと見る',
  'task.collapse': '折りたたむ',
  'status.pending': '保留中',
  'status.in_progress': '進行中',
  'status.completed': '完了',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'mode.label': 'Usar equipos de agentes',
  'mode.failed': 'No se pudo confirmar que se guardó la configuración del equipo. Inténtalo de nuevo: {message}',
  trigger: 'Tablero de tareas',
  loading: 'Cargando tablero de tareas…',
  unavailable: 'El tablero de tareas no está disponible',
  failure: 'Registro de tarea persistente no válido: {message}',
  empty: 'Aún no hay tareas compartidas. Créelos a través de la conversación.',
  tasks: 'Tareas compartidas',
  owner: 'propietario',
  lead: 'Agente principal',
  unowned: 'Sin dueño',
  blockedBy: 'Bloqueado por',
  writeScopes: 'Escribir alcances',
  ready: 'Listo',
  blocked: 'Bloqueado por dependencias',
  'task.expand': 'Mostrar más',
  'task.collapse': 'Mostrar menos',
  'status.pending': 'Pendiente',
  'status.in_progress': 'En progreso',
  'status.completed': 'Completado',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'mode.label': 'Utiliser les équipes d’agents',
  'mode.failed': 'Impossible de confirmer l’enregistrement des équipes d’agents. Réessayez : {message}',
  trigger: 'Tableau des tâches',
  loading: 'Chargement du tableau des tâches…',
  unavailable: 'Le tableau des tâches n’est pas disponible',
  failure: 'Enregistrement de tâche persistant non valide : {message}',
  empty: "Aucune tâche partagée pour l'instant. Créez-les à travers la conversation.",
  tasks: 'Tâches partagées',
  owner: 'Propriétaire',
  lead: 'Agent principal',
  unowned: 'Sans propriétaire',
  blockedBy: 'Bloqué par',
  writeScopes: 'Écrire des étendues',
  ready: 'Prêt',
  blocked: 'Bloqué par les dépendances',
  'task.expand': 'Afficher plus',
  'task.collapse': 'Afficher moins',
  'status.pending': 'En attente',
  'status.in_progress': 'En cours',
  'status.completed': 'Terminé',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'mode.label': 'Agententeams verwenden',
  'mode.failed': 'Das Speichern der Agententeams konnte nicht bestätigt werden. Erneut versuchen: {message}',
  trigger: 'Aufgabenübersicht',
  loading: 'Aufgabenübersicht wird geladen…',
  unavailable: 'Aufgabenübersicht ist nicht verfügbar',
  failure: 'Ungültiger gespeicherter Aufgabeneintrag: {message}',
  empty: 'Noch keine geteilten Aufgaben. Erstellen Sie sie durch das Gespräch.',
  tasks: 'Geteilte Aufgaben',
  owner: 'Besitzer',
  lead: 'Hauptagent',
  unowned: 'Unbesessen',
  blockedBy: 'Blockiert von',
  writeScopes: 'Bereiche schreiben',
  ready: 'Bereit',
  blocked: 'Blockiert durch Abhängigkeiten',
  'task.expand': 'Mehr anzeigen',
  'task.collapse': 'Weniger anzeigen',
  'status.pending': 'Ausstehend',
  'status.in_progress': 'In Bearbeitung',
  'status.completed': 'Abgeschlossen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'mode.label': 'Использовать команды агентов',
  'mode.failed': 'Не удалось подтвердить сохранение команд агентов. Повторите попытку: {message}',
  trigger: 'Доска задач',
  loading: 'Загрузка доски задач…',
  unavailable: 'Доска задач недоступна',
  failure: 'Недопустимая сохранённая запись задачи: {message}',
  empty: 'Общие задачи пока отсутствуют. Создайте их посредством разговора.',
  tasks: 'Общие задачи',
  owner: 'Владелец',
  lead: 'Главный агент',
  unowned: 'Невладеющий',
  blockedBy: 'Заблокировано',
  writeScopes: 'Запись областей',
  ready: 'Готово',
  blocked: 'Заблокировано зависимостями',
  'task.expand': 'Показать больше',
  'task.collapse': 'Показать меньше',
  'status.pending': 'Ожидается',
  'status.in_progress': 'В процессе',
  'status.completed': 'Завершено',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'mode.label': 'Usar equipes de agentes',
  'mode.failed': 'Não foi possível confirmar que as equipes de agentes foram salvas. Tente novamente: {message}',
  trigger: 'Quadro de tarefas',
  loading: 'Carregando quadro de tarefas…',
  unavailable: 'O quadro de tarefas não está disponível',
  failure: 'Registro de tarefa persistente inválido: {message}',
  empty: 'Ainda não há tarefas compartilhadas. Crie-os através da conversa.',
  tasks: 'Tarefas compartilhadas',
  owner: 'Proprietário',
  lead: 'Agente principal',
  unowned: 'Sem dono',
  blockedBy: 'Bloqueado por',
  writeScopes: 'Escrever escopos',
  ready: 'Pronto',
  blocked: 'Bloqueado por dependências',
  'task.expand': 'Mostrar mais',
  'task.collapse': 'Mostrar menos',
  'status.pending': 'Pendente',
  'status.in_progress': 'Em andamento',
  'status.completed': 'Concluído',
} satisfies Record<keyof typeof en, string>
