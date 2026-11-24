/** Retained Feishu OpenAPI declarations from satori@662c3daff128b4b610ebbc393bac388679e60010. */
export * from './auth.ts'
export * from './im.ts'
export * from './contact.ts'


export interface AppFeedNotify {
  /** 是否关闭通知 */
  close_notify?: boolean
  /** 自定义语音播报文本内容 */
  custom_sound_text?: string
  /** 是否播报自定义语音 */
  with_custom_sound?: boolean
}

export interface AvatarInfo {
  /** 72*72像素头像链接 */
  avatar_72?: string
  /** 240*240像素头像链接 */
  avatar_240?: string
  /** 640*640像素头像链接 */
  avatar_640?: string
  /** 原始头像链接 */
  avatar_origin?: string
}

export interface BatchMessageReadUser {
  /** 已读人数 */
  read_count: string
  /** 总人数 */
  total_count: string
}

export interface BatchMessageRecallProgress {
  /** 该条批量消息是否被执行过撤回操作 */
  recall?: boolean
  /** 已经成功撤回的消息数量 */
  recall_count?: number
}

export interface BatchMessageSendProgress {
  /** 批量请求中有效的userid数量(包含机器人不可见用户) */
  valid_user_ids_count?: number
  /** 已经成功给用户发送成功的消息数量 */
  success_user_ids_count?: number
  /** 已读信息用户数量 */
  read_user_ids_count?: number
}

export interface ChatMenuItem {
  /** 菜单类型 */
  action_type: 'NONE' | 'REDIRECT_LINK'
  /** 跳转链接 */
  redirect_link?: ChatMenuItemRedirectLink
  /** image_key */
  image_key?: string
  /** 名称 */
  name: string
  /**
   * 国际化名称，一级菜单名称字符数要在1到8范围内，二级菜单名称字符数要在1到24范围内。
   * **注意：**
   * 1中文=2英文=2其他语言字符=2字符
   */
  i18n_names?: I18nNames
}

export interface ChatMenuItemRedirectLink {
  common_url?: string
  ios_url?: string
  android_url?: string
  pc_url?: string
  web_url?: string
}

export interface ChatMenuSecondLevel {
  /** 二级菜单信息 */
  chat_menu_item?: ChatMenuItem
}

export interface ChatMenuTopLevel {
  /** 一级菜单信息 */
  chat_menu_item: ChatMenuItem
  /** 二级菜单列表 */
  children?: ChatMenuSecondLevel[]
}

export interface ChatMenuTree {
  /** 一级菜单列表 */
  chat_menu_top_levels: ChatMenuTopLevel[]
}

export interface ChatTab {
  /** Tab名称 */
  tab_name?: string
  /** Tab类型 */
  tab_type: 'message' | 'doc_list' | 'doc' | 'pin' | 'meeting_minute' | 'chat_announcement' | 'url' | 'file' | 'files_resources' | 'images_videos' | 'task'
  /** Tab内容 */
  tab_content?: ChatTabContent
  /** Tab的配置 */
  tab_config?: ChatTabConfig
}

export interface ChatTabConfig {
  /** 群Tab图标 */
  icon_key?: string
  /** 群tab是否App内嵌打开 */
  is_built_in?: boolean
}

export interface ChatTabContent {
  /** URL类型 */
  url?: string
  /** Doc链接 */
  doc?: string
  /** 会议纪要 */
  meeting_minute?: string
  /** 任务 */
  task?: string
}

export interface ChatTopNotice {
  /** 置顶的类型 */
  action_type?: '1' | '2'
  /** 消息ID */
  message_id?: string
}

export interface Contact {
  contact_type?: 1 | 2 | 3
  /** 联系人名 */
  contact_name?: string
}

export interface CreateTag {
  /** 标签类型 */
  tag_type: 'tenant'
  /** 标签默认名称 */
  name: string
  /** i18n标签名称集合 */
  i18n_names?: TagI18nName[]
}

export interface CreateTagFailReason {
  /** 名称重复的标签id */
  duplicate_id?: string
}

export interface CustomAttr {
  /** 自定义字段id */
  id: string
  /** 自定义字段类型 */
  type: string
  /** 选项定义，当type为ENUMERATION或者PICTURE_ENUM时此项有值，列举所有可选项 */
  options?: CustomAttrOptions
  /** 多语言名称 */
  i18n_name?: I18nContent[]
}

export interface CustomAttrGenericUser {
  /** 用户id */
  id: string
  /** 用户类型 1 User 2 Bot 11 Mail */
  type: number
}

export interface CustomAttrOption {
  /** 枚举类型选项id */
  id: string
  /** 枚举选项值 */
  value: string
  /** 名称 */
  name?: string
}

export interface CustomAttrOptions {
  /** 默认选项id */
  default_option_id?: string
  /** 选项类型 */
  option_type: 'TEXT' | 'PICTURE'
  /** 选项列表 */
  options: CustomAttrOption[]
}

export interface Department {
  /** 部门名称 */
  name: string
  /** 国际化的部门名称 */
  i18n_name?: DepartmentI18nName
  /** 父部门的部门ID */
  parent_department_id: string
  /** 本部门的自定义部门ID */
  department_id?: string
  /** 部门的open_id */
  open_department_id?: string
  /** 部门主管用户ID */
  leader_user_id?: string
  /** 部门群ID */
  chat_id?: string
  /** 部门的排序 */
  order?: string
  /** 部门单位自定义ID列表，当前只支持一个 */
  unit_ids?: string[]
  /** 部门下用户的个数 */
  member_count?: number
  /** 部门状态 */
  status?: DepartmentStatus
  /** 部门负责人 */
  leaders?: DepartmentLeader[]
  /** 部门群雇员类型限制 */
  group_chat_employee_types?: number[]
  /** 部门HRBP */
  department_hrbps?: string[]
  /** 部门下主属用户的个数 */
  primary_member_count?: number
}

export interface DepartmentI18nName {
  /** 部门的中文名 */
  zh_cn?: string
  /** 部门的日文名 */
  ja_jp?: string
  /** 部门的英文名 */
  en_us?: string
}

export interface DepartmentLeader {
  /** 负责人类型 */
  leaderType: 1 | 2
  /** 负责人ID */
  leaderID: string
}

export interface DepartmentStatus {
  /** 是否被删除 */
  is_deleted?: boolean
}

export type EeKunlunCommonI18nI18nText = Record<EeKunlunCommonI18nLanguageCode, string>

export type EeKunlunCommonI18nLanguageCode = string

export interface Emoji {
  /** emoji类型 */
  emoji_type: string
}

export interface EmployeeTypeEnum {
  /** 枚举值id */
  enum_id?: string
  /** 枚举值 */
  enum_value?: string
  /** 枚举内容 */
  content: string
  /** 类型 */
  enum_type: 1 | 2
  /** 类型 */
  enum_status: 1 | 2
  /** i18n定义 */
  i18n_content?: I18nContent[]
}

export interface FailedReason {
  /** 错误码 */
  error_code?: number
  /** 错误信息 */
  error_message?: string
  /** 用户id */
  user_id?: string
}

export interface File {
  /** 附件 Token */
  token?: string
  /** 文件名 */
  name?: string
  /** 视图类型，卡片视图（默认）或预览视图 */
  view_type?: 1 | 2
}

export interface FollowUp {
  /** 内容 */
  content: string
  /** 多语言内容 */
  i18n_contents?: I18nContent[]
}

export interface FunctionalRoleMember {
  /** 成员ID */
  user_id?: string
  /** 管理范围的类型 */
  scope_type?: 'All' | 'Part' | 'None'
  /** 表示该角色成员的管理范围，scope_type为“指定范围”时，返回该值 */
  department_ids?: string[]
}

export interface FunctionalRoleMemberResult {
  /** 用户ID */
  user_id: string
  /** 成员处理结果 */
  reason: 1 | 2 | 3 | 4 | 5 | 6
}

export interface Group {
  /** 用户组ID */
  id: string
  /** 用户组名字 */
  name: string
  /** 用户组描述 */
  description?: string
  /** 用户组成员中用户的数量 */
  member_user_count?: number
  /** 用户组成员中部门的数量 */
  member_department_count?: number
  /** 用户组的类型 */
  type?: 1 | 2
}

export interface I18nContent {
  /** 语言 */
  locale?: string
  /** i18n内容 */
  value?: string
}

export interface I18nNames {
  /** 中文名 */
  zh_cn?: string
  /** 英文名 */
  en_us?: string
  /** 日文名 */
  ja_jp?: string
}

export interface Image {
  /** 宽度，单位 px */
  width?: number
  /** 高度，单位 px */
  height?: number
  /** 图片 Token */
  token?: string
  /** 对齐方式 */
  align?: 1 | 2 | 3
}

export interface JobFamily {
  /** 序列名称。1-100字符，支持中、英文及符号 */
  name?: string
  /** 序列描述，描述序列详情信息 */
  description?: string
  /** 上级序列ID。需是该租户的序列ID列表中的值，对应唯一的序列名称。 */
  parent_job_family_id?: string
  /** 是否启用 */
  status?: boolean
  /** 多语言序列名称 */
  i18n_name?: I18nContent[]
  /** 多语言描述 */
  i18n_description?: I18nContent[]
  /** 职级序列ID */
  job_family_id?: string
}

export interface JobLevel {
  /** 职级名称 */
  name?: string
  /** 职级描述 */
  description?: string
  /** 职级的排序，可填入自然数100-100000的数值，系统按照数值大小从小到大排序。不填写该字段时，默认新增排序在当前职级列表中最后位（最大值） */
  order?: number
  /** 是否启用 */
  status?: boolean
  /** 职级ID */
  job_level_id?: string
  /** 多语言名称 */
  i18n_name?: I18nContent[]
  /** 多语言描述 */
  i18n_description?: I18nContent[]
}

export interface JobTitle {
  /** 职务ID */
  job_title_id?: string
  /** 职务名称。1-100字符，支持中、英文及符号 */
  name?: string
  /** 多语言职务名称 */
  i18n_name?: I18nContent[]
  /** 是否启用 */
  status?: boolean
}

export interface ListChat {
  /** 群组ID */
  chat_id?: string
  /** 群头像URL */
  avatar?: string
  /** 群名称 */
  name?: string
  /** 群描述 */
  description?: string
  /** 群主ID */
  owner_id?: string
  /** 群主ID类型 */
  owner_id_type?: string
  /** 是否是外部群 */
  external?: boolean
  /** tenant key */
  tenant_key?: string
  /** 群状态 */
  chat_status?: 'normal' | 'dissolved' | 'dissolved_save'
}

export interface ListMember {
  /** member id类型 */
  member_id_type?: string
  /** member id */
  member_id?: string
  /** 名字 */
  name?: string
  /** tenant key */
  tenant_key?: string
}

export interface ListModerator {
  /** 可发言用户 ID 类型 */
  user_id_type?: string
  /** 可发言用户 ID */
  user_id?: string
  /** tenant key */
  tenant_key?: string
}

export interface Member {
  /** 知识库协作者 ID 类型 */
  member_type: string
  /** 知识库协作者 ID */
  member_id: string
  /** 知识库协作者角色 */
  member_role: string
  /** 知识库协作者类型 */
  type?: 'user' | 'chat' | 'department'
}

export interface Memberlist {
  /** 成员ID */
  member_id: string
  /** 用户组成员的类型，目前取值为 user。未来将支持department */
  member_type: string
  /** 成员ID类别，仅请求参数中有效 */
  member_id_type?: string
}

export interface MemberResult {
  /** 成员ID */
  member_id: string
  /** 结果响应码，0表示成功 */
  code: number
}

export interface Mention {
  /** mention key */
  key: string
  /** 用户或机器人的 id, id 类型与 id_type 一致 */
  id: string
  /** id类型，包括open_id，user_id，union_id 或 app_id */
  id_type: string
  /** 被at用户的姓名 */
  name: string
  /** tenant key */
  tenant_key?: string
}

export interface Message {
  /** 消息id open_message_id */
  message_id?: string
  /** 根消息id open_message_id */
  root_id?: string
  /** 父消息的id open_message_id */
  parent_id?: string
  /** 消息所属的话题 ID */
  thread_id?: string
  /** 消息类型 text post card image等等 */
  msg_type?: string
  /** 消息生成的时间戳(毫秒) */
  create_time?: string
  /** 消息更新的时间戳 */
  update_time?: string
  /** 消息是否被撤回 */
  deleted?: boolean
  /** 消息是否被更新 */
  updated?: boolean
  /** 所属的群 */
  chat_id?: string
  /** 发送者，可以是用户或应用 */
  sender?: Sender
  /** 消息内容,json结构 */
  body?: MessageBody
  /** 被艾特的人或应用的id */
  mentions?: Mention[]
  /** 合并消息的上一层级消息id open_message_id */
  upper_message_id?: string
}

export interface MessageBody {
  /** 消息jsonContent */
  content: string
}

export interface MessageReaction {
  /** reaction资源ID */
  reaction_id?: string
  /** 添加reaction的操作人 */
  operator?: Operator
  /** reaction动作的的unix timestamp(单位:ms) */
  action_time?: string
  /** reaction资源类型 */
  reaction_type?: Emoji
}

export interface Object {
  /** 对象 ID */
  id?: number
  /** 对象 API 名称 */
  api_name?: string
  /** 对象名称 */
  label?: EeKunlunCommonI18nI18nText
  /** 对象配置 */
  settings?: ObjectSettings
}

export interface ObjectSearchLayout {
  /** 展示字段 */
  display_fields?: string[]
}

export interface ObjectSettings {
  /** 展示名称 */
  display_name?: string
  /** 允许搜索字段 */
  allow_search_fields?: string[]
  /** 展示字段 */
  search_layout?: ObjectSearchLayout
}

export interface OpenAppFeedCard {
  /** 业务 ID */
  biz_id?: string
  /** 主标题 */
  title?: string
  /** 头像 key */
  avatar_key?: string
  /** 预览信息 */
  preview?: string
  /** 状态标签 */
  status_label?: OpenFeedStatusLabel
  /** 交互按钮 */
  buttons?: OpenAppFeedCardButtons
  /** 跳转链接 */
  link?: OpenAppFeedLink
  /** 即时提醒状态，true-打开，false-关闭 */
  time_sensitive?: boolean
  /** 通知设置，当前可设置通知是否关闭，为空时默认进行通知 */
  notify?: AppFeedNotify
}

export interface OpenAppFeedCardButton {
  /** 跳转 URL */
  multi_url?: OpenAppFeedCardUrl
  /** 交互类型 */
  action_type: 'url_page' | 'webhook'
  /** 文字 */
  text: OpenAppFeedCardText
  /** 按钮类型 */
  button_type?: 'default' | 'primary' | 'success'
  /** action 字典 */
  action_map?: Record<string, string>
}

export interface OpenAppFeedCardButtons {
  /** 按钮组合 */
  buttons: OpenAppFeedCardButton[]
}

export interface OpenAppFeedCardText {
  /** 文本 */
  text: string
}

export interface OpenAppFeedCardUrl {
  /** 默认 URL */
  url?: string
  /** Android 平台 URL */
  android_url?: string
  /** iOS 平台 URL */
  ios_url?: string
  /** PC URL */
  pc_url?: string
}

export interface OpenAppFeedLink {
  /** 链接 */
  link?: string
}

export interface OpenFailedUserAppFeedCardItem {
  /** 业务 ID */
  biz_id: string
  /** 用户 ID */
  user_id: string
  /** 原因 */
  reason?: '0' | '1' | '2' | '3' | '4'
}

export interface OpenFeedStatusLabel {
  /** 标签文字 */
  text: string
  /** 标签类型 */
  type: 'primary' | 'secondary' | 'success' | 'danger'
}

export interface Operator {
  /** 操作人ID */
  operator_id: string
  /** 操作人身份，用户或应用 */
  operator_type: 'app' | 'user'
}

export interface PatchTag {
  /** tagid */
  id?: string
  /** tag name */
  name?: string
  /** i18n名称集合 */
  i18n_names?: TagI18nName[]
}

export interface PatchTagFailReason {
  /** 名称重复的标签id */
  duplicate_id?: string
}

export interface Pin {
  /** Pin的消息ID */
  message_id: string
  /** Pin消息所在的群聊ID */
  chat_id?: string
  /** Pin的操作人ID */
  operator_id?: string
  /** Pin的操作人ID类型 */
  operator_id_type?: string
  /** Pin的创建时间（毫秒级时间戳） */
  create_time?: string
}

export interface ReadUser {
  /** 用户id类型 */
  user_id_type: string
  /** 用户id */
  user_id: string
  /** 阅读时间 */
  timestamp: string
  /** tenant key */
  tenant_key?: string
}

export interface ResourceAcceptor {
  /** 资源处理类型 */
  processing_type: '1' | '2' | '3'
  /** 转移资源时，资源接收者 */
  acceptor_user_id?: string
}

export interface RestrictedModeSetting {
  /** 防泄密模式是否开启 */
  status?: boolean
  /** 允许截屏录屏 */
  screenshot_has_permission_setting?: 'all_members' | 'not_anyone'
  /** 允许下载消息中图片、视频和文件 */
  download_has_permission_setting?: 'all_members' | 'not_anyone'
  /** 允许复制和转发消息 */
  message_has_permission_setting?: 'all_members' | 'not_anyone'
}

export interface Scope {
  /** 权限名称，形如 user.phone:readonly */
  scope_name: string
  /** 租户应用权限授予状态 */
  grant_status: 1 | 2
  /** 权限的身份类型，形如 user(用户身份)、tenant(应用身份) */
  scope_type?: 'tenant' | 'user'
}

export interface Sender {
  /** 该字段标识发送者的id */
  id: string
  /** 该字段标识发送者的id类型 */
  id_type: string
  /** 该字段标识发送者的类型 */
  sender_type: string
  /** tenant key */
  tenant_key?: string
}

export interface TagI18nName {
  /** 语言 */
  locale: string
  /** 名称 */
  name?: string
}

export interface TagInfo {
  /** id */
  id?: string
  /** 标签类型 */
  tag_type?: string
  /** name */
  name?: string
  /** i18n name */
  i18n_names?: TagI18nName[]
  /** 创建时间 */
  create_time?: string
  /** 更新时间 */
  update_time?: string
}

export interface TagInfoWithBindVersion {
  /** 标签内容 */
  tag_info?: TagInfo
  /** 绑定时间 */
  bind_version?: string
}

export interface Unit {
  /** 单位的自定义ID */
  unit_id: string
  /** 单位的名字 */
  name: string
  /** 单位的类型 */
  unit_type: string
}

export interface UnitDepartment {
  /** 单位ID */
  unit_id: string
  /** 部门ID */
  department_id: string
}

export interface User {
  /** 用户的union_id */
  union_id?: string
  /** 租户内用户的唯一标识 */
  user_id?: string
  /** 用户的open_id */
  open_id?: string
  /** 用户名 */
  name: string
  /** 英文名 */
  en_name?: string
  /** 别名 */
  nickname?: string
  /** 邮箱 */
  email?: string
  /** 手机号 */
  mobile: string
  /** 手机号码可见性，true 为可见，false 为不可见，目前默认为 true。不可见时，组织员工将无法查看该员工的手机号码 */
  mobile_visible?: boolean
  /** 性别 */
  gender?: 0 | 1 | 2 | 3
  /** 头像的文件Key */
  avatar_key?: string
  /** 用户头像信息 */
  avatar?: AvatarInfo
  /** 用户状态 */
  status?: UserStatus
  /** 用户所属部门的ID列表 */
  department_ids?: string[]
  /** 用户的直接主管的用户ID */
  leader_user_id?: string
  /** 城市 */
  city?: string
  /** 国家 */
  country?: string
  /** 工位 */
  work_station?: string
  /** 入职时间 */
  join_time?: number
  /** 是否是租户超级管理员 */
  is_tenant_manager?: boolean
  /** 工号 */
  employee_no?: string
  /** 员工类型 */
  employee_type?: number
  /** 用户排序信息 */
  orders?: UserOrder[]
  /** 自定义属性 */
  custom_attrs?: UserCustomAttr[]
  /** 企业邮箱 */
  enterprise_email?: string
  /** 职务 */
  job_title?: string
  /** 是否冻结用户 */
  is_frozen?: boolean
  /** 数据驻留地 */
  geo?: string
  /** 职级ID */
  job_level_id?: string
  /** 序列ID */
  job_family_id?: string
  /** 虚线上级ID */
  dotted_line_leader_user_ids?: string[]
}

export interface UserContactInfo {
  /** 用户id，值为user_id_type所指定的类型。如果查询的手机号、邮箱不存在，或者无权限查看对应的用户，则此项为空。 */
  user_id?: string
  /** 手机号 */
  mobile?: string
  /** 邮箱 */
  email?: string
  /** 用户状态 */
  status?: UserStatus
}

export interface UserCustomAttr {
  /** 自定义属性类型 */
  type?: string
  /** 自定义属性ID */
  id?: string
  /** 自定义属性取值 */
  value?: UserCustomAttrValue
}

export interface UserCustomAttrValue {
  /** 属性文本 */
  text?: string
  /** URL */
  url?: string
  /** PC上的URL */
  pc_url?: string
  /** 选项id，自定义选项和图片此项必填 */
  option_id?: string
  /** 用户信息 */
  generic_user?: CustomAttrGenericUser
}

export interface UserDepartmentInfo {
  /** 对应的部门ID */
  department_id: string
  /** 用户在部门内的排序 */
  user_order?: number
  /** 用户的部门间的排序 */
  department_order?: number
}

export interface UserOpenAppFeedCardDeleter {
  /** 业务 ID */
  biz_id: string
  /** 用户 ID */
  user_id: string
}

export interface UserOpenAppFeedCardUpdater {
  /** 应用消息卡片 */
  app_feed_card: OpenAppFeedCard
  /** 用户 id */
  user_id: string
  /** 更新字段列表 */
  update_fields: ('1' | '2' | '3' | '10' | '11' | '12' | '13' | '101' | '102' | '103')[]
}

export interface UserOrder {
  /** 排序信息对应的部门ID */
  department_id?: string
  /** 用户在部门内的排序 */
  user_order?: number
  /** 用户的部门间的排序 */
  department_order?: number
  /** 是否为用户主部门 */
  is_primary_dept?: boolean
}

export interface UserStatus {
  /** 是否冻结 */
  is_frozen?: boolean
  /** 是否离职 */
  is_resigned?: boolean
  /** 是否激活 */
  is_activated?: boolean
  /** 是否主动退出，主动退出一段时间后用户会自动转为已离职 */
  is_exited?: boolean
  /** 是否未加入，需要用户自主确认才能加入团队 */
  is_unjoin?: boolean
}

export interface WorkCity {
  /** 工作城市ID */
  work_city_id?: string
  /** 工作城市名称。1-100字符，支持中、英文及符号 */
  name?: string
  /** 多语言工作城市 */
  i18n_name?: I18nContent[]
  /** 是否启用 */
  status?: boolean
}
