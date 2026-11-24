/** Retained Feishu OpenAPI declarations from satori@662c3daff128b4b610ebbc393bac388679e60010. */
import type * as Lark from './index.ts'
import { Internal, type Paginated, type Pagination } from '../internal.ts'

declare module '../internal.ts' {
  interface Internal {
    im: Im.Methods
  }
}

export namespace Im {
  export interface Methods {
    message: Message.Methods
    thread: Thread.Methods
    batchMessage: BatchMessage.Methods
    image: Image.Methods
    file: File.Methods
    pin: Pin.Methods
    urlPreview: UrlPreview.Methods
    chat: Chat.Methods
    appFeedCard: AppFeedCard.Methods
    feedCard: FeedCard.Methods
    chatButton: ChatButton.Methods
    bizEntityTagRelation: BizEntityTagRelation.Methods
    tag: Tag.Methods
  }

  export namespace Message {
    export interface Methods {
      resource: Resource.Methods
      reaction: Reaction.Methods
      /**
       * 发送消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
      /**
       * 回复消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply
       */
      reply(message_id: string, body: ReplyRequest): Promise<ReplyResponse>
      /**
       * 编辑消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/update
       */
      update(message_id: string, body: UpdateRequest): Promise<UpdateResponse>
      /**
       * 转发消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/forward
       */
      forward(message_id: string, body: ForwardRequest, query?: ForwardQuery): Promise<ForwardResponse>
      /**
       * 合并转发消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/merge_forward
       */
      mergeForward(body: MergeForwardRequest, query?: MergeForwardQuery): Promise<MergeForwardResponse>
      /**
       * 撤回消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete
       */
      delete(message_id: string): Promise<void>
      /**
       * 添加跟随气泡
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/push_follow_up
       */
      pushFollowUp(message_id: string, body: PushFollowUpRequest): Promise<void>
      /**
       * 查询消息已读信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/read_users
       */
      readUsers(message_id: string, query?: ReadUsersQuery): Paginated<Lark.ReadUser>
      /**
       * 获取会话历史消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list
       */
      list(query?: ListQuery): Paginated<Lark.Message>
      /**
       * 获取指定消息的内容
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/get
       */
      get(message_id: string, query?: GetQuery): Promise<GetResponse>
      /**
       * 发送应用内加急
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/urgent_app
       */
      urgentApp(message_id: string, body: UrgentAppRequest, query?: UrgentAppQuery): Promise<UrgentAppResponse>
      /**
       * 发送短信加急
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/urgent_sms
       */
      urgentSms(message_id: string, body: UrgentSmsRequest, query?: UrgentSmsQuery): Promise<UrgentSmsResponse>
      /**
       * 发送电话加急
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/urgent_phone
       */
      urgentPhone(message_id: string, body: UrgentPhoneRequest, query?: UrgentPhoneQuery): Promise<UrgentPhoneResponse>
      /**
       * 更新已发送的消息卡片
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch
       */
      patch(message_id: string, body: PatchRequest): Promise<void>
    }

    export interface CreateRequest {
      /** 依据receive_id_type的值，填写对应的消息接收者id */
      receive_id: string
      /** 消息类型 包括：text、post、image、file、audio、media、sticker、interactive、share_chat、share_user等，类型定义请参考[发送消息content说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json) */
      msg_type: string
      /**
       * 消息内容，json结构序列化后的字符串。不同msg_type对应不同内容。消息类型 包括：text、post、image、file、audio、media、sticker、interactive、share_chat、share_user等，具体格式说明参考：[发送消息content说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)
       * <b>请求体大小限制</b>：
       * - 文本消息请求体最大不能超过150KB
       * - 卡片及富文本消息请求体最大不能超过30KB
       */
      content: string
      /** 由开发者生成的唯一字符串序列，用于发送消息请求去重；持有相同uuid的请求1小时内至多成功执行一次 */
      uuid?: string
    }

    export interface CreateQuery {
      /** 消息接收者id类型 open_id/user_id/union_id/email/chat_id */
      receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'
    }

    export interface CreateResponse {
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
      sender?: Lark.Sender
      /** 消息内容,json结构 */
      body?: Lark.MessageBody
      /** 被艾特的人或应用的id */
      mentions?: Lark.Mention[]
      /** 合并消息的上一层级消息id open_message_id */
      upper_message_id?: string
    }

    export interface ReplyRequest {
      /** 消息内容 json 格式，格式说明参考: [发送消息content说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json) */
      content: string
      /** 消息类型，包括：text、post、image、file、audio、media、sticker、interactive、share_card、share_user */
      msg_type: string
      /** 是否以话题形式回复；若群聊已经是话题模式，则自动回复该条消息所在的话题 */
      reply_in_thread?: boolean
      /** 由开发者生成的唯一字符串序列，用于回复消息请求去重；持有相同uuid的请求1小时内至多成功执行一次 */
      uuid?: string
    }

    export interface ReplyResponse {
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
      sender?: Lark.Sender
      /** 消息内容,json结构 */
      body?: Lark.MessageBody
      /** 被艾特的人或应用的id */
      mentions?: Lark.Mention[]
      /** 合并消息的上一层级消息id open_message_id */
      upper_message_id?: string
    }

    export interface UpdateRequest {
      /** 消息的类型，仅支持文本(text)和富文本(post)类型 */
      msg_type: string
      /** 消息内容，JSON 格式 */
      content: string
    }

    export interface UpdateResponse {
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
      sender?: Lark.Sender
      /** 消息内容,json结构 */
      body?: Lark.MessageBody
      /** 被艾特的人或应用的id */
      mentions?: Lark.Mention[]
      /** 合并消息的上一层级消息id open_message_id */
      upper_message_id?: string
    }

    export interface ForwardRequest {
      /** 依据receive_id_type的值，填写对应的转发目标的ID */
      receive_id: string
    }

    export interface ForwardQuery {
      /** 消息接收者id类型 open_id/user_id/union_id/email/chat_id */
      receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' | 'thread_id'
      /** 由开发者生成的唯一字符串序列，用于转发消息请求去重；持有相同uuid的请求在1小时内向同一个目标的转发只可成功一次。 */
      uuid?: string
    }

    export interface ForwardResponse {
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
      sender?: Lark.Sender
      /** 消息内容,json结构 */
      body?: Lark.MessageBody
      /** 被艾特的人或应用的id */
      mentions?: Lark.Mention[]
      /** 合并消息的上一层级消息id open_message_id */
      upper_message_id?: string
    }

    export interface MergeForwardRequest {
      /** 依据receive_id_type的值，填写对应的转发目标的ID */
      receive_id: string
      /** 要转发的消息ID列表 */
      message_id_list: string[]
    }

    export interface MergeForwardQuery {
      /** 消息接收者id类型 open_id/user_id/union_id/email/chat_id */
      receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' | 'thread_id'
      /** 由开发者生成的唯一字符串序列，用于转发消息请求去重；持有相同uuid的请求在1小时内向同一个目标的转发只可成功一次。 */
      uuid?: string
    }

    export interface MergeForwardResponse {
      /** 合并转发生成的新消息 */
      message?: Lark.Message
      /** 无效的消息ID列表 */
      invalid_message_id_list?: string[]
    }

    export interface PushFollowUpRequest {
      /** follow up列表 */
      follow_ups: Lark.FollowUp[]
    }

    export interface ReadUsersQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type: 'user_id' | 'union_id' | 'open_id'
    }

    export interface ListQuery extends Pagination {
      /** 容器类型 ，目前可选值仅有"chat"，包含单聊（p2p）和群聊（group） */
      container_id_type: string
      /** 容器的id，即chat的id，详情参见[群ID 说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-id-description) */
      container_id: string
      /** 历史信息的起始时间（秒级时间戳） */
      start_time?: string
      /** 历史信息的结束时间（秒级时间戳） */
      end_time?: string
      /** 消息排序方式 */
      sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc'
    }

    export interface GetQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
    }

    export interface GetResponse {
      /** message[] */
      items?: Lark.Message[]
    }

    export interface UrgentAppRequest {
      /** 该字段标识目标用户的id类型 */
      user_id_list: string[]
    }

    export interface UrgentAppQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type: 'user_id' | 'union_id' | 'open_id'
    }

    export interface UrgentAppResponse {
      /** 无效的用户id */
      invalid_user_id_list: string[]
    }

    export interface UrgentSmsRequest {
      /** 该字段标识目标用户的id类型 */
      user_id_list: string[]
    }

    export interface UrgentSmsQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type: 'user_id' | 'union_id' | 'open_id'
    }

    export interface UrgentSmsResponse {
      /** 无效的用户id */
      invalid_user_id_list: string[]
    }

    export interface UrgentPhoneRequest {
      /** 该字段标识目标用户的id类型 */
      user_id_list: string[]
    }

    export interface UrgentPhoneQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type: 'user_id' | 'union_id' | 'open_id'
    }

    export interface UrgentPhoneResponse {
      /** 无效的用户id */
      invalid_user_id_list: string[]
    }

    export interface PatchRequest {
      /** 消息内容 json 格式，[发送消息 content 说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)，参考文档中的卡片格式 */
      content: string
    }

    export namespace Resource {
      export interface Methods {
        /**
         * 获取消息中的资源文件
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get
         */
        get(message_id: string, file_key: string, query?: GetQuery): Promise<ArrayBuffer>
      }

      export interface GetQuery {
        /** 资源类型，可选"image, file“； image对应消息中的 图片，富文本消息中的图片。  file对应消息中的 文件、音频、视频、（表情包除外） */
        type: string
      }
    }

    export namespace Reaction {
      export interface Methods {
        /**
         * 添加消息表情回复
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/create
         */
        create(message_id: string, body: CreateRequest): Promise<CreateResponse>
        /**
         * 获取消息表情回复
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/list
         */
        list(message_id: string, query?: ListQuery): Paginated<Lark.MessageReaction>
        /**
         * 删除消息表情回复
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/delete
         */
        delete(message_id: string, reaction_id: string): Promise<DeleteResponse>
      }

      export interface CreateRequest {
        /** reaction资源类型 */
        reaction_type: Lark.Emoji
      }

      export interface CreateResponse {
        /** reaction资源ID */
        reaction_id?: string
        /** 添加reaction的操作人 */
        operator?: Lark.Operator
        /** reaction动作的的unix timestamp(单位:ms) */
        action_time?: string
        /** reaction资源类型 */
        reaction_type?: Lark.Emoji
      }

      export interface ListQuery extends Pagination {
        /**
         * 待查询消息reaction的类型[emoji类型列举](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce)。
         * - 不传入该参数，表示拉取所有类型reaction
         */
        reaction_type?: string
        /** 当操作人为用户时返回用户ID的类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
      }

      export interface DeleteResponse {
        /** reaction资源ID */
        reaction_id?: string
        /** 添加reaction的操作人 */
        operator?: Lark.Operator
        /** reaction动作的的unix timestamp(单位:ms) */
        action_time?: string
        /** reaction资源类型 */
        reaction_type?: Lark.Emoji
      }
    }
  }

  export namespace Thread {
    export interface Methods {
      /**
       * 转发话题
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/thread/forward
       */
      forward(thread_id: string, body: ForwardRequest, query?: ForwardQuery): Promise<ForwardResponse>
    }

    export interface ForwardRequest {
      /** 依据receive_id_type的值，填写对应的转发目标的ID */
      receive_id: string
    }

    export interface ForwardQuery {
      /** 消息接收者id类型 open_id/user_id/union_id/email/chat_id/thread_id */
      receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' | 'thread_id'
      /** 由开发者生成的唯一字符串序列，用于转发消息请求去重；持有相同uuid的请求在1小时内向同一个目标的转发只可成功一次。 */
      uuid?: string
    }

    export interface ForwardResponse {
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
      sender?: Lark.Sender
      /** 消息内容,json结构 */
      body?: Lark.MessageBody
      /** 被艾特的人或应用的id */
      mentions?: Lark.Mention[]
      /** 合并消息的上一层级消息id open_message_id */
      upper_message_id?: string
    }
  }

  export namespace BatchMessage {
    export interface Methods {
      /**
       * 批量撤回消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/batch_message/delete
       */
      delete(batch_message_id: string): Promise<void>
      /**
       * 查询批量消息推送和阅读人数
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/batch_message/read_user
       */
      readUser(batch_message_id: string): Promise<ReadUserResponse>
      /**
       * 查询批量消息整体进度
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/batch_message/get_progress
       */
      getProgress(batch_message_id: string): Promise<GetProgressResponse>
    }

    export interface ReadUserResponse {
      read_user?: Lark.BatchMessageReadUser
    }

    export interface GetProgressResponse {
      /** 消息发送进度 */
      batch_message_send_progress?: Lark.BatchMessageSendProgress
      /** 消息撤回进度 */
      batch_message_recall_progress?: Lark.BatchMessageRecallProgress
    }
  }

  export namespace Image {
    export interface Methods {
      /**
       * 上传图片
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create
       */
      create(form: CreateForm): Promise<CreateResponse>
      /**
       * 下载图片
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/get
       */
      get(image_key: string): Promise<ArrayBuffer>
    }

    export interface CreateForm {
      /** 图片类型 */
      image_type: 'message' | 'avatar'
      /**
       * 图片内容
       * **注意：** 上传的图片大小不能超过10MB
       */
      image: Blob
    }

    export interface CreateResponse {
      /** 图片的key */
      image_key?: string
    }
  }

  export namespace File {
    export interface Methods {
      /**
       * 上传文件
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create
       */
      create(form: CreateForm): Promise<CreateResponse>
      /**
       * 下载文件
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/get
       */
      get(file_key: string): Promise<ArrayBuffer>
    }

    export interface CreateForm {
      /** 文件类型 */
      file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
      /** 带后缀的文件名 */
      file_name: string
      /** 文件的时长（视频，音频），单位:毫秒。不填充时无法显示具体时长。 */
      duration?: number
      /** 文件内容 */
      file: Blob
    }

    export interface CreateResponse {
      /** 文件的key */
      file_key?: string
    }
  }

  export namespace Pin {
    export interface Methods {
      /**
       * Pin 消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/pin/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 移除 Pin 消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/pin/delete
       */
      delete(message_id: string): Promise<void>
      /**
       * 获取群内 Pin 消息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/pin/list
       */
      list(query?: ListQuery): Paginated<Lark.Pin>
    }

    export interface CreateRequest {
      /** 待Pin的消息ID */
      message_id: string
    }

    export interface CreateResponse {
      pin?: Lark.Pin
    }

    export interface ListQuery extends Pagination {
      /** 待获取Pin消息的Chat ID */
      chat_id: string
      /** Pin信息的起始时间（毫秒级时间戳） */
      start_time?: string
      /** Pin信息的结束时间（毫秒级时间戳） */
      end_time?: string
    }
  }

  export namespace UrlPreview {
    export interface Methods {
      /**
       * 更新 URL 预览
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/url_preview/batch_update
       */
      batchUpdate(body: BatchUpdateRequest): Promise<void>
    }

    export interface BatchUpdateRequest {
      /** URL预览的token列表 */
      preview_tokens: string[]
      /** 需要更新URL预览的用户open_id。若不传，则默认更新URL所在会话成员；若用户不在URL所在会话，则无法更新该用户 */
      open_ids?: string[]
    }
  }

  export namespace Chat {
    export interface Methods {
      moderation: Moderation.Methods
      topNotice: TopNotice.Methods
      managers: Managers.Methods
      members: Members.Methods
      announcement: Announcement.Methods
      tab: Tab.Methods
      menuTree: MenuTree.Methods
      menuItem: MenuItem.Methods
      /**
       * 创建群
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
      /**
       * 解散群
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/delete
       */
      delete(chat_id: string): Promise<void>
      /**
       * 更新群信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/update
       */
      update(chat_id: string, body: UpdateRequest, query?: UpdateQuery): Promise<void>
      /**
       * 获取群信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get
       */
      get(chat_id: string, query?: GetQuery): Promise<GetResponse>
      /**
       * 获取用户或机器人所在的群列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/list
       */
      list(query?: ListQuery): Paginated<Lark.ListChat>
      /**
       * 搜索对用户或机器人可见的群列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/search
       */
      search(query?: SearchQuery): Paginated<Lark.ListChat>
      /**
       * 获取群分享链接
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/link
       */
      link(chat_id: string, body: LinkRequest): Promise<LinkResponse>
    }

    export interface CreateRequest {
      /** 群头像对应的 Image Key，可通过[上传图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create)获取（注意：上传图片的 ==image_type== 需要指定为 ==avatar==） */
      avatar?: string
      /**
       * 群名称
       * **注意：** 公开群名称的长度不得少于2个字符
       */
      name?: string
      /** 群描述 */
      description?: string
      /** 群国际化名称 */
      i18n_names?: Lark.I18nNames
      /**
       * 创建群时指定的群主，不填时指定建群的机器人为群主。
       * 群主 ID，ID值与查询参数中的 user_id_type 对应。
       * 不同 ID 的说明参见 [用户相关的 ID 概念](https://open.feishu.cn/document/home/user-identity-introduction/introduction)
       */
      owner_id?: string
      /** 创建群时邀请的群成员，id 类型为 user_id_type */
      user_id_list?: string[]
      /**
       * 创建群时邀请的群机器人
       * **注意：** 拉机器人入群请使用 ==app_id==
       */
      bot_id_list?: string[]
      /** 群消息模式 */
      group_message_type?: 'chat' | 'thread'
      /**
       * 群模式
       * **可选值有**：
       * - `group`：群组
       */
      chat_mode?: string
      /**
       * 群类型
       * **可选值有**：
       * - `private`：私有群
       * - `public`：公开群
       */
      chat_type?: string
      /**
       * 入群消息可见性
       * **可选值有**：
       * - `only_owner`：仅群主和管理员可见
       * - `all_members`：所有成员可见
       * - `not_anyone`：任何人均不可见
       */
      join_message_visibility?: string
      /**
       * 退群消息可见性
       * **可选值有**：
       * - `only_owner`：仅群主和管理员可见
       * - `all_members`：所有成员可见
       * - `not_anyone`：任何人均不可见
       */
      leave_message_visibility?: string
      /**
       * 加群审批
       * **可选值有**：
       * - `no_approval_required`：无需审批
       * - `approval_required`：需要审批
       */
      membership_approval?: string
      /** 防泄密模式设置 */
      restricted_mode_setting?: Lark.RestrictedModeSetting
      /** 谁可以加急 */
      urgent_setting?: 'only_owner' | 'all_members'
      /** 谁可以发起视频会议 */
      video_conference_setting?: 'only_owner' | 'all_members'
      /** 谁可以编辑群信息 */
      edit_permission?: 'only_owner' | 'all_members'
      /** 隐藏群成员人数设置 */
      hide_member_count_setting?: 'all_members' | 'only_owner'
    }

    export interface CreateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 如果选择了设置群主为指定用户，可以选择是否同时设置创建此群的机器人为管理员，此标志位用于标记是否设置创建群的机器人为管理员 */
      set_bot_manager?: boolean
      /** 由开发者生成的唯一字符串序列，用于创建群组请求去重；持有相同uuid的请求10小时内只可成功创建1个群聊 */
      uuid?: string
    }

    export interface CreateResponse {
      /** 群ID */
      chat_id?: string
      /** 群头像URL */
      avatar?: string
      /** 群名称 */
      name?: string
      /** 群描述 */
      description?: string
      /** 群国际化名称 */
      i18n_names?: Lark.I18nNames
      /** 群主 ID */
      owner_id?: string
      /** 群主 ID 类型 */
      owner_id_type?: string
      /** 谁可以加急 */
      urgent_setting?: 'only_owner' | 'all_members'
      /** 谁可以发起视频会议 */
      video_conference_setting?: 'only_owner' | 'all_members'
      /** 加user/bot入群权限(all_members/only_owner) */
      add_member_permission?: string
      /** 群分享权限(allowed/not_allowed) */
      share_card_permission?: string
      /** at所有人权限(all_members/only_owner) */
      at_all_permission?: string
      /** 群编辑权限(all_members/only_owner) */
      edit_permission?: string
      /** 群消息模式 */
      group_message_type?: string
      /** 群模式 */
      chat_mode?: string
      /** 群类型 */
      chat_type?: string
      /** 优先级最高的一个群tag */
      chat_tag?: string
      /** 是否是外部群 */
      external?: boolean
      /** tenant key */
      tenant_key?: string
      /** 入群消息可见性 */
      join_message_visibility?: string
      /** 出群消息可见性 */
      leave_message_visibility?: string
      /** 加群审批 */
      membership_approval?: string
      /** 发言权限 */
      moderation_permission?: string
      /** 防泄密模式设置 */
      restricted_mode_setting?: Lark.RestrictedModeSetting
      /** 隐藏群成员人数设置 */
      hide_member_count_setting?: 'all_members' | 'only_owner'
    }

    export interface UpdateRequest {
      /** 群头像对应的 Image Key，可通过[上传图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create)获取（注意：上传图片的 ==image_type== 需要指定为 ==avatar==） */
      avatar?: string
      /** 群名称 */
      name?: string
      /** 群描述 */
      description?: string
      /** 群国际化名称 */
      i18n_names?: Lark.I18nNames
      /** 加 user/bot 入群权限(all_members/only_owner) */
      add_member_permission?: string
      /** 群分享权限(allowed/not_allowed) */
      share_card_permission?: string
      /** at 所有人权限(all_members/only_owner) */
      at_all_permission?: string
      /** 群编辑权限(all_members/only_owner) */
      edit_permission?: string
      /** 新群主 ID */
      owner_id?: string
      /** 入群消息可见性(only_owner/all_members/not_anyone) */
      join_message_visibility?: string
      /** 出群消息可见性(only_owner/all_members/not_anyone) */
      leave_message_visibility?: string
      /** 加群审批(no_approval_required/approval_required) */
      membership_approval?: string
      /** 防泄密模式设置 */
      restricted_mode_setting?: Lark.RestrictedModeSetting
      /** 群类型 */
      chat_type?: string
      /** 群消息模式 */
      group_message_type?: 'chat' | 'thread'
      /** 谁可以加急 */
      urgent_setting?: 'only_owner' | 'all_members'
      /** 谁可以发起视频会议 */
      video_conference_setting?: 'only_owner' | 'all_members'
      /** 隐藏群成员人数设置 */
      hide_member_count_setting?: 'all_members' | 'only_owner'
    }

    export interface UpdateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
    }

    export interface GetQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
    }

    export interface GetResponse {
      /** 群头像URL */
      avatar?: string
      /** 群名称 */
      name?: string
      /** 群描述 */
      description?: string
      /** 群国际化名称 */
      i18n_names?: Lark.I18nNames
      /** 加user/bot入群权限(all_members/only_owner) */
      add_member_permission?: string
      /** 群分享权限(allowed/not_allowed) */
      share_card_permission?: string
      /** at所有人权限(all_members/only_owner) */
      at_all_permission?: string
      /** 群编辑权限(all_members/only_owner) */
      edit_permission?: string
      /** 群主ID的类型(open_id/user_id/union_id) */
      owner_id_type?: string
      /** 群主ID */
      owner_id?: string
      /** 用户管理员列表 */
      user_manager_id_list?: string[]
      /** 机器人管理员列表 */
      bot_manager_id_list?: string[]
      /** 群消息模式 */
      group_message_type?: string
      /** 群模式 */
      chat_mode?: string
      /** 群类型 */
      chat_type?: string
      /** 优先级最高的一个群tag */
      chat_tag?: string
      /** 入群消息可见性 */
      join_message_visibility?: string
      /** 出群消息可见性 */
      leave_message_visibility?: string
      /** 加群审批 */
      membership_approval?: string
      /** 发言权限 */
      moderation_permission?: string
      /** 是否是外部群 */
      external?: boolean
      /** tenant key */
      tenant_key?: string
      /** 群成员人数 */
      user_count?: string
      /** 群机器人数 */
      bot_count?: string
      /** 防泄密模式设置 */
      restricted_mode_setting?: Lark.RestrictedModeSetting
      /** 谁可以加急 */
      urgent_setting?: 'only_owner' | 'all_members'
      /** 谁可以发起视频会议 */
      video_conference_setting?: 'only_owner' | 'all_members'
      /** 隐藏群成员人数设置 */
      hide_member_count_setting?: 'all_members' | 'only_owner'
      /** 群状态 */
      chat_status?: 'normal' | 'dissolved' | 'dissolved_save'
    }

    export interface ListQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 群组排序方式 */
      sort_type?: 'ByCreateTimeAsc' | 'ByActiveTimeDesc'
    }

    export interface SearchQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 关键词。注意：如果query为空值将返回空的结果 */
      query?: string
    }

    export interface LinkRequest {
      /** 群分享链接有效时长，可选值week、year、permanently，分别表示7天、1年以及永久有效 */
      validity_period?: 'week' | 'year' | 'permanently'
    }

    export interface LinkResponse {
      /** 群分享链接 */
      share_link?: string
      /** 分享链接过期时间戳（秒级） */
      expire_time?: string
      /** 分享链接是否永久有效 */
      is_permanent?: boolean
    }

    export namespace Moderation {
      export interface Methods {
        /**
         * 更新群发言权限
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-moderation/update
         */
        update(chat_id: string, body: UpdateRequest, query?: UpdateQuery): Promise<void>
        /**
         * 获取群成员发言权限
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-moderation/get
         */
        get(chat_id: string, query?: GetQuery): Promise<GetResponse>
      }

      export interface UpdateRequest {
        /** 群发言模式（all_members/only_owner/moderator_list，其中 moderator_list 表示部分用户可发言的模式） */
        moderation_setting?: string
        /** 选择部分用户可发言模式时，添加的可发言用户列表（自动过滤不在群内的用户） */
        moderator_added_list?: string[]
        /** 选择部分用户可发言模式时，移除的可发言用户列表（自动过滤不在群内的用户） */
        moderator_removed_list?: string[]
      }

      export interface UpdateQuery {
        /** 此次调用中使用的用户ID的类型 */
        user_id_type?: 'user_id' | 'union_id' | 'open_id'
      }

      export interface GetQuery extends Pagination {
        /** 此次调用中使用的用户ID的类型 */
        user_id_type?: 'user_id' | 'union_id' | 'open_id'
      }

      export interface GetResponse {
        /** 群发言模式 */
        moderation_setting?: string
        /** 分页标记，当 has_more 为 true 时，会同时返回新的 page_token，否则不返回 page_token */
        page_token?: string
        /** 是否还有更多项 */
        has_more?: boolean
        /** 可发言用户列表 */
        items?: Lark.ListModerator[]
      }
    }

    export namespace TopNotice {
      export interface Methods {
        /**
         * 更新群置顶
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-top_notice/put_top_notice
         */
        putTopNotice(chat_id: string, body: PutTopNoticeRequest): Promise<void>
        /**
         * 撤销群置顶
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-top_notice/delete_top_notice
         */
        deleteTopNotice(chat_id: string): Promise<void>
      }

      export interface PutTopNoticeRequest {
        /** 要进行发布的群置顶 */
        chat_top_notice: Lark.ChatTopNotice[]
      }
    }

    export namespace Managers {
      export interface Methods {
        /**
         * 指定群管理员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-managers/add_managers
         */
        addManagers(chat_id: string, body: AddManagersRequest, query?: AddManagersQuery): Promise<AddManagersResponse>
        /**
         * 删除群管理员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-managers/delete_managers
         */
        deleteManagers(chat_id: string, body: DeleteManagersRequest, query?: DeleteManagersQuery): Promise<DeleteManagersResponse>
      }

      export interface AddManagersRequest {
        /** 要增加的 manager_id */
        manager_ids?: string[]
      }

      export interface AddManagersQuery {
        /** 群成员 id 类型 open_id/user_id/union_id/app_id */
        member_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
      }

      export interface AddManagersResponse {
        /** 群目前的管理员id */
        chat_managers?: string[]
        /** 群目前的管理员bot id */
        chat_bot_managers?: string[]
      }

      export interface DeleteManagersRequest {
        /** 要删除的 manager_id */
        manager_ids?: string[]
      }

      export interface DeleteManagersQuery {
        /** 群成员 id 类型 open_id/user_id/union_id/app_id */
        member_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
      }

      export interface DeleteManagersResponse {
        /** 群目前的管理员id */
        chat_managers?: string[]
        /** 群目前的管理员bot id */
        chat_bot_managers?: string[]
      }
    }

    export namespace Members {
      export interface Methods {
        /**
         * 将用户或机器人拉入群聊
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/create
         */
        create(chat_id: string, body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
        /**
         * 用户或机器人主动加入群聊
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/me_join
         */
        meJoin(chat_id: string): Promise<void>
        /**
         * 将用户或机器人移出群聊
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/delete
         */
        delete(chat_id: string, body: DeleteRequest, query?: DeleteQuery): Promise<DeleteResponse>
        /**
         * 获取群成员列表
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/get
         */
        get(chat_id: string, query?: GetQuery): Promise<GetResponse>
        /**
         * 判断用户或机器人是否在群里
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/is_in_chat
         */
        isInChat(chat_id: string): Promise<IsInChatResponse>
      }

      export interface CreateRequest {
        /**
         * 成员列表
         * <b>注意：</b>每次请求，最多拉50个用户或者5个机器人，并且群组最多容纳15个机器人
         */
        id_list?: string[]
      }

      export interface CreateQuery {
        /**
         * 进群成员 id 类型 open_id/user_id/union_id/app_id
         * <b>注意：</b>拉机器人入群请使用 ==app_id==
         */
        member_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
        /** 出现不可用ID后的处理方式 0/1/2 */
        succeed_type?: 0 | 1 | 2
      }

      export interface CreateResponse {
        /** ID无效的成员列表 */
        invalid_id_list?: string[]
        /** ID不存在的成员列表 */
        not_existed_id_list?: string[]
        /** 等待群主或管理员审批的成员ID列表 */
        pending_approval_id_list?: string[]
      }

      export interface DeleteRequest {
        /** 成员列表 */
        id_list?: string[]
      }

      export interface DeleteQuery {
        /** 出群成员 id 类型 open_id/user_id/union_id/app_id */
        member_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
      }

      export interface DeleteResponse {
        /** 无效成员列表 */
        invalid_id_list?: string[]
      }

      export interface GetQuery extends Pagination {
        /** 群成员 用户 ID 类型，详情参见 [用户相关的 ID 概念](https://open.feishu.cn/document/home/user-identity-introduction/introduction) */
        member_id_type?: 'user_id' | 'union_id' | 'open_id'
      }

      export interface GetResponse {
        /** member列表 */
        items?: Lark.ListMember[]
        /** 分页标记，当 has_more 为 true 时，会同时返回新的 page_token，否则不返回 page_token */
        page_token?: string
        /** 是否还有更多项 */
        has_more?: boolean
        /** 成员总数 */
        member_total?: number
      }

      export interface IsInChatResponse {
        /** 用户或者机器人是否在群中 */
        is_in_chat?: boolean
      }
    }

    export namespace Announcement {
      export interface Methods {
        /**
         * 更新群公告信息
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-announcement/patch
         */
        patch(chat_id: string, body: PatchRequest): Promise<void>
        /**
         * 获取群公告信息
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-announcement/get
         */
        get(chat_id: string, query?: GetQuery): Promise<GetResponse>
      }

      export interface PatchRequest {
        /** 文档当前版本号 int64 类型，get 接口会返回 */
        revision: string
        /**
         * 修改文档请求的序列化字段
         * 更新公告信息的格式和更新[云文档](https://open.feishu.cn/document/ukTMukTMukTM/uYDM2YjL2AjN24iNwYjN)格式相同
         */
        requests?: string[]
      }

      export interface GetQuery {
        /** 此次调用中使用的用户ID的类型 */
        user_id_type?: 'user_id' | 'union_id' | 'open_id'
      }

      export interface GetResponse {
        /** CCM 文档序列化信息 */
        content?: string
        /** 文档当前版本号 纯数字 */
        revision?: string
        /** 文档生成的时间戳（秒） */
        create_time?: string
        /** 消息更新的时间戳（秒） */
        update_time?: string
        /** 文档所有者id类型， open_id/user_id/union_id/app_id */
        owner_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
        /** 文档所有者id */
        owner_id?: string
        /** 文档最新修改者id类型， open_id/user_id/union_id/app_id */
        modifier_id_type?: 'user_id' | 'union_id' | 'open_id' | 'app_id'
        /** 文档最新修改者id */
        modifier_id?: string
      }
    }

    export namespace Tab {
      export interface Methods {
        /**
         * 添加会话标签页
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-tab/create
         */
        create(chat_id: string, body: CreateRequest): Promise<CreateResponse>
        /**
         * 删除会话标签页
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-tab/delete_tabs
         */
        deleteTabs(chat_id: string, body: DeleteTabsRequest): Promise<DeleteTabsResponse>
        /**
         * 更新会话标签页
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-tab/update_tabs
         */
        updateTabs(chat_id: string, body: UpdateTabsRequest): Promise<UpdateTabsResponse>
        /**
         * 会话标签页排序
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-tab/sort_tabs
         */
        sortTabs(chat_id: string, body: SortTabsRequest): Promise<SortTabsResponse>
        /**
         * 拉取会话标签页
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-tab/list_tabs
         */
        listTabs(chat_id: string): Promise<ListTabsResponse>
      }

      export interface CreateRequest {
        /** 会话标签页 */
        chat_tabs: Lark.ChatTab[]
      }

      export interface CreateResponse {
        /** 群标签列表 */
        chat_tabs?: Lark.ChatTab[]
      }

      export interface DeleteTabsRequest {
        /** 会话标签页id列表 */
        tab_ids: string[]
      }

      export interface DeleteTabsResponse {
        /** 群标签列表 */
        chat_tabs?: Lark.ChatTab[]
      }

      export interface UpdateTabsRequest {
        /** 会话标签页 */
        chat_tabs?: Lark.ChatTab[]
      }

      export interface UpdateTabsResponse {
        /** 群标签列表 */
        chat_tabs?: Lark.ChatTab[]
      }

      export interface SortTabsRequest {
        /** 会话标签页ID列表 */
        tab_ids?: string[]
      }

      export interface SortTabsResponse {
        /** 群标签列表 */
        chat_tabs?: Lark.ChatTab[]
      }

      export interface ListTabsResponse {
        /** 会话标签页 */
        chat_tabs?: Lark.ChatTab[]
      }
    }

    export namespace MenuTree {
      export interface Methods {
        /**
         * 添加群菜单
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-menu_tree/create
         */
        create(chat_id: string, body: CreateRequest): Promise<CreateResponse>
        /**
         * 删除群菜单
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-menu_tree/delete
         */
        delete(chat_id: string, body: DeleteRequest): Promise<DeleteResponse>
        /**
         * 排序群菜单
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-menu_tree/sort
         */
        sort(chat_id: string, body: SortRequest): Promise<SortResponse>
        /**
         * 获取群菜单
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-menu_tree/get
         */
        get(chat_id: string): Promise<GetResponse>
      }

      export interface CreateRequest {
        /** 要向群内追加的菜单 */
        menu_tree: Lark.ChatMenuTree
      }

      export interface CreateResponse {
        /** 追加后群内现有菜单 */
        menu_tree?: Lark.ChatMenuTree
      }

      export interface DeleteRequest {
        /** 要删除的一级菜单ID列表 */
        chat_menu_top_level_ids: string[]
      }

      export interface DeleteResponse {
        /** 群内现有菜单 */
        menu_tree?: Lark.ChatMenuTree
      }

      export interface SortRequest {
        /** 一级菜单id列表 */
        chat_menu_top_level_ids: string[]
      }

      export interface SortResponse {
        /** 排序后群内菜单 */
        menu_tree?: Lark.ChatMenuTree
      }

      export interface GetResponse {
        /** 群内所有菜单 */
        menu_tree?: Lark.ChatMenuTree
      }
    }

    export namespace MenuItem {
      export interface Methods {
        /**
         * 修改群菜单元信息
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-menu_item/patch
         */
        patch(chat_id: string, menu_item_id: string, body: PatchRequest): Promise<PatchResponse>
      }

      export interface PatchRequest {
        /** 修改的字段 */
        update_fields: ('ICON' | 'NAME' | 'I18N_NAME' | 'REDIRECT_LINK')[]
        /** 元信息 */
        chat_menu_item: Lark.ChatMenuItem
      }

      export interface PatchResponse {
        chat_menu_item?: Lark.ChatMenuItem
      }
    }
  }

  export namespace AppFeedCard {
    export interface Methods {
      batch: Batch.Methods
      /**
       * 创建应用消息流卡片
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/app_feed_card/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
    }

    export interface CreateRequest {
      /** 应用消息卡片 */
      app_feed_card?: Lark.OpenAppFeedCard
      /** 用户 ID */
      user_ids?: string[]
    }

    export interface CreateQuery {
      /** 用户 ID 类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
    }

    export interface CreateResponse {
      /** 失败的卡片 */
      failed_cards?: Lark.OpenFailedUserAppFeedCardItem[]
      /** 卡片业务 ID */
      biz_id?: string
    }

    export namespace Batch {
      export interface Methods {
        /**
         * 更新应用消息流卡片
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/app_feed_card-batch/update
         */
        update(body: UpdateRequest, query?: UpdateQuery): Promise<UpdateResponse>
        /**
         * 删除应用消息流卡片
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/app_feed_card-batch/delete
         */
        delete(body: DeleteRequest, query?: DeleteQuery): Promise<DeleteResponse>
      }

      export interface UpdateRequest {
        /** 应用消息卡片 */
        feed_cards?: Lark.UserOpenAppFeedCardUpdater[]
      }

      export interface UpdateQuery {
        /** 此次调用中使用的用户ID的类型 可选值有:     - open_id: 以open_id来识别用户     - user_id: 以user_id来识别用户     - union_id: 以union_id来识别用户 */
        user_id_type?: 'open_id' | 'user_id' | 'union_id'
      }

      export interface UpdateResponse {
        /** 失败的卡片 */
        failed_cards?: Lark.OpenFailedUserAppFeedCardItem[]
      }

      export interface DeleteRequest {
        /** 应用消息卡片 */
        feed_cards?: Lark.UserOpenAppFeedCardDeleter[]
      }

      export interface DeleteQuery {
        /** 此次调用中使用的用户ID的类型 可选值有:     - open_id: 以open_id来识别用户     - user_id: 以user_id来识别用户     - union_id: 以union_id来识别用户 */
        user_id_type?: 'open_id' | 'user_id' | 'union_id'
      }

      export interface DeleteResponse {
        /** 失败的卡片 */
        failed_cards?: Lark.OpenFailedUserAppFeedCardItem[]
      }
    }
  }

  export namespace FeedCard {
    export interface Methods {
      /**
       * 机器人单聊即时提醒
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/feed_card/bot_time_sentive
       */
      botTimeSentive(body: BotTimeSentiveRequest, query?: BotTimeSentiveQuery): Promise<BotTimeSentiveResponse>
      /**
       * 即时提醒
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/feed_card/patch
       */
      patch(feed_card_id: string, body: PatchRequest, query?: PatchQuery): Promise<PatchResponse>
    }

    export interface BotTimeSentiveRequest {
      /** 临时置顶状态，true-打开，false-关闭 */
      time_sensitive: boolean
      /** 用户id 列表 */
      user_ids: string[]
    }

    export interface BotTimeSentiveQuery {
      /** 此次调用中使用的用户ID的类型 可选值有:     - open_id: 以open_id来识别用户     - user_id: 以user_id来识别用户     - union_id: 以union_id来识别用户 */
      user_id_type: 'open_id' | 'user_id' | 'union_id'
    }

    export interface BotTimeSentiveResponse {
      /** 失败原因 */
      failed_user_reasons?: Lark.FailedReason[]
    }

    export interface PatchRequest {
      /** 临时置顶状态，true-打开，false-关闭 */
      time_sensitive: boolean
      /** 用户id 列表 */
      user_ids: string[]
    }

    export interface PatchQuery {
      /** 此次调用中使用的用户ID的类型 可选值有:     - open_id: 以open_id来识别用户     - user_id: 以user_id来识别用户     - union_id: 以union_id来识别用户 */
      user_id_type: 'open_id' | 'user_id' | 'union_id'
    }

    export interface PatchResponse {
      /** 失败原因 */
      failed_user_reasons?: Lark.FailedReason[]
    }
  }

  export namespace ChatButton {
    export interface Methods {
      /**
       * 更新消息流卡片按钮
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/chat_button/update
       */
      update(body: UpdateRequest, query?: UpdateQuery): Promise<UpdateResponse>
    }

    export interface UpdateRequest {
      /** 用户 ID 列表 */
      user_ids?: string[]
      /** 群 ID */
      chat_id: string
      /** 按钮 */
      buttons?: Lark.OpenAppFeedCardButtons
    }

    export interface UpdateQuery {
      /** 用户 ID 类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
    }

    export interface UpdateResponse {
      /** 失败的用户 */
      failed_user_reasons?: Lark.FailedReason[]
    }
  }

  export namespace BizEntityTagRelation {
    export interface Methods {
      /**
       * 查询实体与标签的绑定关系
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/biz_entity_tag_relation/get
       */
      get(query?: GetQuery): Promise<GetResponse>
      /**
       * 绑定标签到群
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/biz_entity_tag_relation/create
       */
      create(body: CreateRequest): Promise<void>
      /**
       * 解绑标签与群
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/biz_entity_tag_relation/update
       */
      update(body: UpdateRequest): Promise<void>
    }

    export interface GetQuery {
      /** 业务类型 */
      tag_biz_type: 'chat'
      /** 业务实体id */
      biz_entity_id: string
    }

    export interface GetResponse {
      /** 标签内容及绑定时间 */
      tag_info_with_bind_versions?: Lark.TagInfoWithBindVersion[]
    }

    export interface CreateRequest {
      /** 业务类型 */
      tag_biz_type: 'chat'
      /** 业务实体id */
      biz_entity_id: string
      /** 标签id */
      tag_ids?: string[]
    }

    export interface UpdateRequest {
      /** 业务类型 */
      tag_biz_type: 'chat'
      /** 业务实体id */
      biz_entity_id: string
      /** 标签id */
      tag_ids?: string[]
    }
  }

  export namespace Tag {
    export interface Methods {
      /**
       * 创建标签
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/tag/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 修改标签
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/group/im-v2/tag/patch
       */
      patch(tag_id: string, body: PatchRequest): Promise<PatchResponse>
    }

    export interface CreateRequest {
      /** 创建标签 */
      create_tag: Lark.CreateTag
    }

    export interface CreateResponse {
      /** 创建的tagid */
      id?: string
      /** 创建失败原因 */
      create_tag_fail_reason?: Lark.CreateTagFailReason
    }

    export interface PatchRequest {
      /** 编辑标签 */
      patch_tag?: Lark.PatchTag
    }

    export interface PatchResponse {
      /** 编辑后的taginfo */
      tag_info?: Lark.TagInfo
      /** 修改失败原因 */
      patch_tag_fail_reason?: Lark.PatchTagFailReason
    }
  }
}

Internal.define({
  '/im/v1/messages': {
    POST: 'im.message.create',
    GET: { name: 'im.message.list', pagination: { argIndex: 0 } },
  },
  '/im/v1/messages/{message_id}/reply': {
    POST: 'im.message.reply',
  },
  '/im/v1/messages/{message_id}': {
    PUT: 'im.message.update',
    DELETE: 'im.message.delete',
    GET: 'im.message.get',
    PATCH: 'im.message.patch',
  },
  '/im/v1/messages/{message_id}/forward': {
    POST: 'im.message.forward',
  },
  '/im/v1/messages/merge_forward': {
    POST: 'im.message.mergeForward',
  },
  '/im/v1/threads/{thread_id}/forward': {
    POST: 'im.thread.forward',
  },
  '/im/v1/messages/{message_id}/push_follow_up': {
    POST: 'im.message.pushFollowUp',
  },
  '/im/v1/messages/{message_id}/read_users': {
    GET: { name: 'im.message.readUsers', pagination: { argIndex: 1 } },
  },
  '/im/v1/messages/{message_id}/resources/{file_key}': {
    GET: { name: 'im.message.resource.get', type: 'binary' },
  },
  '/im/v1/batch_messages/{batch_message_id}': {
    DELETE: 'im.batchMessage.delete',
  },
  '/im/v1/batch_messages/{batch_message_id}/read_user': {
    GET: 'im.batchMessage.readUser',
  },
  '/im/v1/batch_messages/{batch_message_id}/get_progress': {
    GET: 'im.batchMessage.getProgress',
  },
  '/im/v1/images': {
    POST: { name: 'im.image.create', multipart: true },
  },
  '/im/v1/images/{image_key}': {
    GET: { name: 'im.image.get', type: 'binary' },
  },
  '/im/v1/files': {
    POST: { name: 'im.file.create', multipart: true },
  },
  '/im/v1/files/{file_key}': {
    GET: { name: 'im.file.get', type: 'binary' },
  },
  '/im/v1/messages/{message_id}/urgent_app': {
    PATCH: 'im.message.urgentApp',
  },
  '/im/v1/messages/{message_id}/urgent_sms': {
    PATCH: 'im.message.urgentSms',
  },
  '/im/v1/messages/{message_id}/urgent_phone': {
    PATCH: 'im.message.urgentPhone',
  },
  '/im/v1/messages/{message_id}/reactions': {
    POST: 'im.message.reaction.create',
    GET: { name: 'im.message.reaction.list', pagination: { argIndex: 1 } },
  },
  '/im/v1/messages/{message_id}/reactions/{reaction_id}': {
    DELETE: 'im.message.reaction.delete',
  },
  '/im/v1/pins': {
    POST: 'im.pin.create',
    GET: { name: 'im.pin.list', pagination: { argIndex: 0 } },
  },
  '/im/v1/pins/{message_id}': {
    DELETE: 'im.pin.delete',
  },
  '/im/v2/url_previews/batch_update': {
    POST: 'im.urlPreview.batchUpdate',
  },
  '/im/v1/chats': {
    POST: 'im.chat.create',
    GET: { name: 'im.chat.list', pagination: { argIndex: 0 } },
  },
  '/im/v1/chats/{chat_id}': {
    DELETE: 'im.chat.delete',
    PUT: 'im.chat.update',
    GET: 'im.chat.get',
  },
  '/im/v1/chats/{chat_id}/moderation': {
    PUT: 'im.chat.moderation.update',
    GET: 'im.chat.moderation.get',
  },
  '/im/v1/chats/{chat_id}/top_notice/put_top_notice': {
    POST: 'im.chat.topNotice.putTopNotice',
  },
  '/im/v1/chats/{chat_id}/top_notice/delete_top_notice': {
    POST: 'im.chat.topNotice.deleteTopNotice',
  },
  '/im/v1/chats/search': {
    GET: { name: 'im.chat.search', pagination: { argIndex: 0 } },
  },
  '/im/v1/chats/{chat_id}/link': {
    POST: 'im.chat.link',
  },
  '/im/v1/chats/{chat_id}/managers/add_managers': {
    POST: 'im.chat.managers.addManagers',
  },
  '/im/v1/chats/{chat_id}/managers/delete_managers': {
    POST: 'im.chat.managers.deleteManagers',
  },
  '/im/v1/chats/{chat_id}/members': {
    POST: 'im.chat.members.create',
    DELETE: 'im.chat.members.delete',
    GET: 'im.chat.members.get',
  },
  '/im/v1/chats/{chat_id}/members/me_join': {
    PATCH: 'im.chat.members.meJoin',
  },
  '/im/v1/chats/{chat_id}/members/is_in_chat': {
    GET: 'im.chat.members.isInChat',
  },
  '/im/v1/chats/{chat_id}/announcement': {
    PATCH: 'im.chat.announcement.patch',
    GET: 'im.chat.announcement.get',
  },
  '/im/v1/chats/{chat_id}/chat_tabs': {
    POST: 'im.chat.tab.create',
  },
  '/im/v1/chats/{chat_id}/chat_tabs/delete_tabs': {
    DELETE: 'im.chat.tab.deleteTabs',
  },
  '/im/v1/chats/{chat_id}/chat_tabs/update_tabs': {
    POST: 'im.chat.tab.updateTabs',
  },
  '/im/v1/chats/{chat_id}/chat_tabs/sort_tabs': {
    POST: 'im.chat.tab.sortTabs',
  },
  '/im/v1/chats/{chat_id}/chat_tabs/list_tabs': {
    GET: 'im.chat.tab.listTabs',
  },
  '/im/v1/chats/{chat_id}/menu_tree': {
    POST: 'im.chat.menuTree.create',
    DELETE: 'im.chat.menuTree.delete',
    GET: 'im.chat.menuTree.get',
  },
  '/im/v1/chats/{chat_id}/menu_items/{menu_item_id}': {
    PATCH: 'im.chat.menuItem.patch',
  },
  '/im/v1/chats/{chat_id}/menu_tree/sort': {
    POST: 'im.chat.menuTree.sort',
  },
  '/im/v2/app_feed_card': {
    POST: 'im.appFeedCard.create',
  },
  '/im/v2/app_feed_card/batch': {
    PUT: 'im.appFeedCard.batch.update',
    DELETE: 'im.appFeedCard.batch.delete',
  },
  '/im/v2/feed_cards/bot_time_sentive': {
    PATCH: 'im.feedCard.botTimeSentive',
  },
  '/im/v2/chat_button': {
    PUT: 'im.chatButton.update',
  },
  '/im/v2/feed_cards/{feed_card_id}': {
    PATCH: 'im.feedCard.patch',
  },
  '/im/v2/biz_entity_tag_relation': {
    GET: 'im.bizEntityTagRelation.get',
    POST: 'im.bizEntityTagRelation.create',
    PUT: 'im.bizEntityTagRelation.update',
  },
  '/im/v2/tags': {
    POST: 'im.tag.create',
  },
  '/im/v2/tags/{tag_id}': {
    PATCH: 'im.tag.patch',
  },
})
