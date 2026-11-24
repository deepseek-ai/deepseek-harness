/** Retained Feishu OpenAPI declarations from satori@662c3daff128b4b610ebbc393bac388679e60010. */
import type * as Lark from './index.ts'
import { Internal, type Paginated, type Pagination } from '../internal.ts'

declare module '../internal.ts' {
  interface Internal {
    contact: Contact.Methods
  }
}

export namespace Contact {
  export interface Methods {
    scope: Scope.Methods
    user: User.Methods
    group: Group.Methods
    customAttr: CustomAttr.Methods
    employeeTypeEnum: EmployeeTypeEnum.Methods
    department: Department.Methods
    unit: Unit.Methods
    functionalRole: FunctionalRole.Methods
    jobLevel: JobLevel.Methods
    jobFamily: JobFamily.Methods
    jobTitle: JobTitle.Methods
    workCity: WorkCity.Methods
  }

  export namespace Scope {
    export interface Methods {
      /**
       * 获取通讯录授权范围
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/scope/list
       */
      list(query?: ListQuery): Promise<ListResponse>
    }

    export interface ListQuery extends Pagination {
      /** 返回值的用户ID的类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
      /** 返回值的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface ListResponse {
      /** 已授权部门列表，授权范围为全员可见时返回的是当前企业的所有一级部门列表 */
      department_ids?: string[]
      /** 已授权用户列表，应用申请了获取用户user_id 权限时返回；当授权范围为全员可见时返回的是当前企业所有顶级部门用户列表 */
      user_ids?: string[]
      /** 已授权的用户组，授权范围为全员可见时返回的是当前企业所有用户组 */
      group_ids?: string[]
      /** 是否还有更多项 */
      has_more?: boolean
      /** 分页标记，当 has_more 为 true 时，会同时返回新的 page_token */
      page_token?: string
    }
  }

  export namespace User {
    export interface Methods {
      /**
       * 创建用户
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
      /**
       * 修改用户部分信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/patch
       */
      patch(user_id: string, body: PatchRequest, query?: PatchQuery): Promise<PatchResponse>
      /**
       * 更新用户 ID
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/update_user_id
       */
      updateUserId(user_id: string, body: UpdateUserIdRequest, query?: UpdateUserIdQuery): Promise<void>
      /**
       * 获取单个用户信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/get
       */
      get(user_id: string, query?: GetQuery): Promise<GetResponse>
      /**
       * 批量获取用户信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch
       */
      batch(query?: BatchQuery): Promise<BatchResponse>
      /**
       * 获取部门直属用户列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department
       */
      findByDepartment(query?: FindByDepartmentQuery): Paginated<Lark.User>
      /**
       * 通过手机号或邮箱获取用户 ID
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch_get_id
       */
      batchGetId(body: BatchGetIdRequest, query?: BatchGetIdQuery): Promise<BatchGetIdResponse>
      /**
       * 删除用户
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/delete
       */
      delete(user_id: string, body: DeleteRequest, query?: DeleteQuery): Promise<void>
      /**
       * 恢复已删除用户
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/resurrect
       */
      resurrect(user_id: string, body: ResurrectRequest, query?: ResurrectQuery): Promise<void>
      /**
       * 获取用户列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/list
       */
      list(query?: ListQuery): Paginated<Lark.User>
      /**
       * 更新用户所有信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/update
       */
      update(user_id: string, body: UpdateRequest, query?: UpdateQuery): Promise<UpdateResponse>
    }

    export const enum CreateRequestGender {
      /** 保密 */
      Unkown = 0,
      /** 男 */
      Male = 1,
      /** 女 */
      Female = 2,
      /** 其他 */
      Others = 3,
    }

    export interface CreateRequest {
      /** 租户内用户的唯一标识 */
      user_id?: string
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
      gender?: CreateRequestGender
      /** 头像的文件Key */
      avatar_key?: string
      /** 用户所在的部门 */
      department_ids: string[]
      /** 用户的上级领导 */
      leader_user_id?: string
      /** 城市 */
      city?: string
      /** 国家 */
      country?: string
      /** 工位 */
      work_station?: string
      /** 入职时间 */
      join_time?: number
      /** 工号 */
      employee_no?: string
      /** 员工类型 */
      employee_type: number
      /** 用户排序信息 */
      orders?: Lark.UserOrder[]
      /** 自定义属性 */
      custom_attrs?: Lark.UserCustomAttr[]
      /** 企业邮箱 */
      enterprise_email?: string
      /** 职务 */
      job_title?: string
      /** 数据驻留地 */
      geo?: string
      /** 职级ID */
      job_level_id?: string
      /** 序列ID */
      job_family_id?: string
      /** 分配给用户的席位ID列表 */
      subscription_ids?: string[]
      /** 虚线上级ID */
      dotted_line_leader_user_ids?: string[]
    }

    export interface CreateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型。
       * 不同 ID 的说明参见[部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 用于幂等判断是否为同一请求，避免重复创建。字符串类型，自行生成。 */
      client_token?: string
    }

    export interface CreateResponse {
      user?: Lark.User
    }

    export const enum PatchRequestGender {
      /** 保密 */
      Unkown = 0,
      /** 男 */
      Male = 1,
      /** 女 */
      Female = 2,
      /** 其他 */
      Others = 3,
    }

    export interface PatchRequest {
      /** 用户名称 */
      name?: string
      /** 英文名 */
      en_name?: string
      /** 别名 */
      nickname?: string
      /** 邮箱 */
      email?: string
      /** 用户手机号 */
      mobile?: string
      /** 手机号码可见性，true 为可见，false 为不可见，目前默认为 true。不可见时，组织员工将无法查看该员工的手机号码 */
      mobile_visible?: boolean
      /** 性别 */
      gender?: PatchRequestGender
      /** 头像的文件Key */
      avatar_key?: string
      /** 用户所在部门ID */
      department_ids?: string[]
      /** 用户直属上级 */
      leader_user_id?: string
      /** 城市 */
      city?: string
      /** 国家 */
      country?: string
      /** 工位 */
      work_station?: string
      /** 入职时间 */
      join_time?: number
      /** 工号 */
      employee_no?: string
      /** 员工类型 */
      employee_type?: number
      /** 用户排序信息 */
      orders?: Lark.UserOrder[]
      /** 自定义属性 */
      custom_attrs?: Lark.UserCustomAttr[]
      /** 企业邮箱 */
      enterprise_email?: string
      /** 职务 */
      job_title?: string
      /** 是否冻结用户 */
      is_frozen?: boolean
      /** 职级ID */
      job_level_id?: string
      /** 序列ID */
      job_family_id?: string
      /** 分配给用户的席位ID列表 */
      subscription_ids?: string[]
      /** 虚线上级ID */
      dotted_line_leader_user_ids?: string[]
    }

    export interface PatchQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface PatchResponse {
      user?: Lark.User
    }

    export interface UpdateUserIdRequest {
      /** 自定义新用户ID */
      new_user_id: string
    }

    export interface UpdateUserIdQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
    }

    export interface GetQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型
       * 不同 ID 的说明 [部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface GetResponse {
      user?: Lark.User
    }

    export interface BatchQuery {
      /** 要查询的用户ID列表 */
      user_ids: string[]
      /** 指定请求中用户ID类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
      /** 指定查询结果中用户关联的部门ID类型 */
      department_id_type?: 'open_department_id' | 'department_id'
    }

    export interface BatchResponse {
      /** 查询到的用户信息，其中异常的用户ID不返回结果。 */
      items?: Lark.User[]
    }

    export interface FindByDepartmentQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型
       * 部门ID类型的区别参见[部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
      /**
       * 填写该字段表示获取该部门下用户，必填。根部门的部门ID为0。
       * ID值与查询参数中的department_id_type 对应。
       * 不同 ID 的说明与department_id的获取方式参见 [部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id: string
    }

    export interface BatchGetIdRequest {
      /**
       * 要查询的用户邮箱，最多 50 条。
       * 注意，emails与mobiles相互独立，每条用户邮箱返回对应的用户ID。
       * 本接口返回的用户ID数量为emails数量与mobiles数量的和。
       */
      emails?: string[]
      /**
       * 要查询的用户手机号，最多 50 条。
       * 注意
       * 1. emails与mobiles相互独立，每条用户手机号返回对应的用户ID。
       * 2.  非中国大陆地区的手机号需要添加以 “+” 开头的国家 / 地区代码。
       */
      mobiles?: string[]
      /** 查询结果包含离职员工，可查询离职用户的ID */
      include_resigned?: boolean
    }

    export interface BatchGetIdQuery {
      /** 返回的用户ID的类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
    }

    export interface BatchGetIdResponse {
      /** 手机号或者邮箱对应的用户id信息 */
      user_list?: Lark.UserContactInfo[]
    }

    export interface DeleteRequest {
      /** 部门群接收者。被删除用户为部门群群主时，转让群主给指定接收者，不指定接收者则默认转让给群内第一个入群的人 */
      department_chat_acceptor_user_id?: string
      /** 外部群接收者。被删除用户为外部群群主时，转让群主给指定接收者，不指定接收者则默认转让给群内与被删除用户在同一组织的第一个入群的人，如果组织内只有该用户在群里，则解散外部群 */
      external_chat_acceptor_user_id?: string
      /** 文档接收者。用户被删除时，其拥有的文档转让给接收者。不指定接收者则默认转让给直属上级，如果无直属上级则将文档资源保留在该用户名下。 */
      docs_acceptor_user_id?: string
      /** 日程接收者。用户被删除时，其拥有的日程转让给接收者，不指定接收者则默认转让给直属上级，如果无直属上级则直接删除日程资源。 */
      calendar_acceptor_user_id?: string
      /** 应用接受者。用户被删除时，其创建的应用转让给接收者，不指定接收者则默认转让给直属上级。如果无直属上级则保留应用在该用户名下，但该用户无法登录开发者后台进行应用管理，管理员可以在管理后台手动转移应用给其他人。 */
      application_acceptor_user_id?: string
      /** 妙记接收者。用户被删除时，其拥有的妙记资源转让给接收者。如果不指定接收者，则默认转让给直属上级。如果无直属上级则将妙记保留在该用户名下。 */
      minutes_acceptor_user_id?: string
      /** 飞书问卷接收者。用户被删除时，其拥有的飞书问卷资源转让给接收者，不指定接收者则默认转让给直属上级，如果无直属上级则直接删除飞书问卷资源。 */
      survey_acceptor_user_id?: string
      /** 用户邮件资源处理方式。用户被删除时，根据传递的操作指令对其拥有的邮件资源做对应处理。未传递指令时默认将邮件资源转让给直属上级，如果无直属上级则保留邮件资源在该用户名下。 */
      email_acceptor?: Lark.ResourceAcceptor
      /** 用户集成平台资源接收者 */
      anycross_acceptor_user_id?: string
    }

    export interface DeleteQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
    }

    export interface ResurrectRequest {
      /** 指定恢复后用户所在部门 */
      departments?: Lark.UserDepartmentInfo[]
      /** 指定恢复后分配的席位 */
      subscription_ids?: string[]
    }

    export interface ResurrectQuery {
      /** 用户id类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
      /** 部门id类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface ListQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 填写该字段表示获取部门下所有用户，选填。 */
      department_id?: string
    }

    export const enum UpdateRequestGender {
      /** 保密 */
      Unkown = 0,
      /** 男 */
      Male = 1,
      /** 女 */
      Female = 2,
      /** 其他 */
      Others = 3,
    }

    export interface UpdateRequest {
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
      gender?: UpdateRequestGender
      /** 头像的文件Key */
      avatar_key?: string
      /** 用户所在部门ID */
      department_ids: string[]
      /** 用户直属上级 */
      leader_user_id?: string
      /** 城市 */
      city?: string
      /** 国家 */
      country?: string
      /** 工位 */
      work_station?: string
      /** 入职时间 */
      join_time?: number
      /** 工号 */
      employee_no?: string
      /** 员工类型 */
      employee_type: number
      /** 用户排序信息 */
      orders?: Lark.UserOrder[]
      /** 自定义属性 */
      custom_attrs?: Lark.UserCustomAttr[]
      /** 企业邮箱 */
      enterprise_email?: string
      /** 职务 */
      job_title?: string
      /** 是否冻结用户 */
      is_frozen?: boolean
    }

    export interface UpdateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface UpdateResponse {
      user?: Lark.User
    }
  }

  export namespace Group {
    export interface Methods {
      member: Member.Methods
      /**
       * 创建用户组
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
      /**
       * 更新用户组
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/patch
       */
      patch(group_id: string, body: PatchRequest, query?: PatchQuery): Promise<void>
      /**
       * 查询指定用户组
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/get
       */
      get(group_id: string, query?: GetQuery): Promise<GetResponse>
      /**
       * 查询用户组列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/simplelist
       */
      simplelist(query?: SimplelistQuery): Paginated<Lark.Group, 'grouplist'>
      /**
       * 查询用户所属用户组
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/member_belong
       */
      memberBelong(query?: MemberBelongQuery): Paginated<string, 'group_list'>
      /**
       * 删除用户组
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group/delete
       */
      delete(group_id: string): Promise<void>
    }

    export const enum CreateRequestType {
      /** 普通用户组 */
      Assign = 1,
      /** 动态用户组 */
      Dynamic = 2,
    }

    export interface CreateRequest {
      /** 用户组的名字，企业内唯一，最大长度：100 字符 */
      name: string
      /** 用户组描述 */
      description?: string
      /** 用户组的类型。默认为1表示普通用户组 */
      type?: CreateRequestType
      /**
       * 自定义用户组ID，可在创建时自定义，不自定义则由系统自动生成，已创建用户组不允许修改 group_id 。
       * 自定义group_id数据校验规则：
       * 最大长度：64 字符
       * 校验规则：数字、大小写字母的组合，不能包含空格
       */
      group_id?: string
    }

    export interface CreateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'open_department_id' | 'department_id'
    }

    export interface CreateResponse {
      /** 用户组ID */
      group_id: string
    }

    export interface PatchRequest {
      /** 用户组的名字，企业内唯一，最大长度：100 字符 */
      name?: string
      /**
       * 用户组描述信息
       * 最大长度：500 字
       */
      description?: string
    }

    export interface PatchQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface GetQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'open_department_id' | 'department_id'
    }

    export interface GetResponse {
      /** 用户组详情 */
      group: Lark.Group
    }

    export const enum SimplelistQueryType {
      /** 普通用户组 */
      Assign = 1,
      /** 动态用户组 */
      Dynamic = 2,
    }

    export interface SimplelistQuery extends Pagination {
      /** 用户组类型 */
      type?: SimplelistQueryType
    }

    export const enum MemberBelongQueryGroupType {
      /** 普通用户组 */
      Assign = 1,
      /** 动态用户组 */
      Dynamic = 2,
    }

    export interface MemberBelongQuery extends Pagination {
      /** 成员ID */
      member_id: string
      /** 成员ID类型 */
      member_id_type?: 'open_id' | 'union_id' | 'user_id'
      /** 欲获取的用户组类型 */
      group_type?: MemberBelongQueryGroupType
    }

    export namespace Member {
      export interface Methods {
        /**
         * 添加用户组成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group-member/add
         */
        add(group_id: string, body: AddRequest): Promise<void>
        /**
         * 批量添加用户组成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group-member/batch_add
         */
        batchAdd(group_id: string, body: BatchAddRequest): Promise<BatchAddResponse>
        /**
         * 查询用户组成员列表
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group-member/simplelist
         */
        simplelist(group_id: string, query?: SimplelistQuery): Paginated<Lark.Memberlist, 'memberlist'>
        /**
         * 移除用户组成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group-member/remove
         */
        remove(group_id: string, body: RemoveRequest): Promise<void>
        /**
         * 批量移除用户组成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/group-member/batch_remove
         */
        batchRemove(group_id: string, body: BatchRemoveRequest): Promise<void>
      }

      export interface AddRequest {
        /** 用户组成员的类型，取值为 user */
        member_type: 'user'
        /** 当member_type =user时候，member_id_type表示user_id_type，枚举值为open_id, union_id, user_id */
        member_id_type: 'open_id' | 'union_id' | 'user_id'
        /** 添加的成员ID */
        member_id: string
      }

      export interface BatchAddRequest {
        /** 待添加成员 */
        members?: Lark.Memberlist[]
      }

      export interface BatchAddResponse {
        /** 成员添加操作结果 */
        results?: Lark.MemberResult[]
      }

      export interface SimplelistQuery extends Pagination {
        /**
         * 欲获取成员ID类型。
         * 当member_type=user时候，member_id_type表示user_id_type，枚举值open_id, union_id和user_id。
         * 当member_type=department时候，member_id_type表示department_id_type，枚举值open_id和department_id。
         */
        member_id_type?: 'open_id' | 'union_id' | 'user_id' | 'department_id'
        /** 欲获取的用户组成员类型。 */
        member_type?: 'user' | 'department'
      }

      export interface RemoveRequest {
        /** 用户组成员的类型，取值为 user */
        member_type: 'user'
        /** 操作移除的用户组成员ID */
        member_id: string
        /** 当member_type =user时候，member_id_type表示user_id_type，枚举值为open_id, union_id, user_id */
        member_id_type: 'open_id' | 'union_id' | 'user_id'
      }

      export interface BatchRemoveRequest {
        /** 待移除成员 */
        members: Lark.Memberlist[]
      }
    }
  }

  export namespace CustomAttr {
    export interface Methods {
      /**
       * 获取企业自定义用户字段
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/custom_attr/list
       */
      list(query?: Pagination): Paginated<Lark.CustomAttr>
    }
  }

  export namespace EmployeeTypeEnum {
    export interface Methods {
      /**
       * 新增人员类型
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/employee_type_enum/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 更新人员类型
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/employee_type_enum/update
       */
      update(enum_id: string, body: UpdateRequest): Promise<UpdateResponse>
      /**
       * 查询人员类型
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/employee_type_enum/list
       */
      list(query?: Pagination): Paginated<Lark.EmployeeTypeEnum>
      /**
       * 删除人员类型
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/employee_type_enum/delete
       */
      delete(enum_id: string): Promise<void>
    }

    export const enum CreateRequestEnumType {
      /** 内置类型 */
      Defualt = 1,
      /** 自定义 */
      Custom = 2,
    }

    export const enum CreateRequestEnumStatus {
      /** 激活 */
      Active = 1,
      /** 未激活 */
      Inactive = 2,
    }

    export interface CreateRequest {
      /** 枚举内容 */
      content: string
      /** 类型 */
      enum_type: CreateRequestEnumType
      /** 类型 */
      enum_status: CreateRequestEnumStatus
      /** i18n定义 */
      i18n_content?: Lark.I18nContent[]
    }

    export interface CreateResponse {
      /** 创建人员类型接口 */
      employee_type_enum?: Lark.EmployeeTypeEnum
    }

    export const enum UpdateRequestEnumType {
      /** 内置类型 */
      Defualt = 1,
      /** 自定义 */
      Custom = 2,
    }

    export const enum UpdateRequestEnumStatus {
      /** 激活 */
      Active = 1,
      /** 未激活 */
      Inactive = 2,
    }

    export interface UpdateRequest {
      /** 枚举内容 */
      content: string
      /** 类型 */
      enum_type: UpdateRequestEnumType
      /** 类型 */
      enum_status: UpdateRequestEnumStatus
      /** i18n定义 */
      i18n_content?: Lark.I18nContent[]
    }

    export interface UpdateResponse {
      employee_type_enum?: Lark.EmployeeTypeEnum
    }
  }

  export namespace Department {
    export interface Methods {
      /**
       * 创建部门
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/create
       */
      create(body: CreateRequest, query?: CreateQuery): Promise<CreateResponse>
      /**
       * 修改部门部分信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/patch
       */
      patch(department_id: string, body: PatchRequest, query?: PatchQuery): Promise<PatchResponse>
      /**
       * 更新部门所有信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/update
       */
      update(department_id: string, body: UpdateRequest, query?: UpdateQuery): Promise<UpdateResponse>
      /**
       * 更新部门 ID
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/update_department_id
       */
      updateDepartmentId(department_id: string, body: UpdateDepartmentIdRequest, query?: UpdateDepartmentIdQuery): Promise<void>
      /**
       * 部门群转为普通群
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/unbind_department_chat
       */
      unbindDepartmentChat(body: UnbindDepartmentChatRequest, query?: UnbindDepartmentChatQuery): Promise<void>
      /**
       * 获取单个部门信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/get
       */
      get(department_id: string, query?: GetQuery): Promise<GetResponse>
      /**
       * 批量获取部门信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/batch
       */
      batch(query?: BatchQuery): Promise<BatchResponse>
      /**
       * 获取子部门列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/children
       */
      children(department_id: string, query?: ChildrenQuery): Paginated<Lark.Department>
      /**
       * 获取父部门信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/parent
       */
      parent(query?: ParentQuery): Paginated<Lark.Department>
      /**
       * 搜索部门
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/search
       */
      search(body: SearchRequest, query?: SearchQuery): Paginated<Lark.Department>
      /**
       * 删除部门
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/delete
       */
      delete(department_id: string, query?: DeleteQuery): Promise<void>
      /**
       * 获取部门信息列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/list
       */
      list(query?: ListQuery): Paginated<Lark.Department>
    }

    export interface CreateRequest {
      /** 部门名称 */
      name: string
      /** 国际化的部门名称 */
      i18n_name?: Lark.DepartmentI18nName
      /** 父部门的ID */
      parent_department_id: string
      /** 本部门的自定义部门ID */
      department_id?: string
      /** 部门主管用户ID */
      leader_user_id?: string
      /** 部门的排序 */
      order?: string
      /** 是否创建部门群，默认不创建 */
      create_group_chat?: boolean
      /** 部门负责人 */
      leaders?: Lark.DepartmentLeader[]
      /** 部门群雇员类型限制 */
      group_chat_employee_types?: number[]
      /** 部门HRBP */
      department_hrbps?: string[]
    }

    export interface CreateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型
       * 不同 ID 的说明参见[部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 用于幂等判断是否为同一请求，避免重复创建。字符串类型，自行生成。 */
      client_token?: string
    }

    export interface CreateResponse {
      department?: Lark.Department
    }

    export interface PatchRequest {
      /** 部门名 */
      name?: string
      /** 国际化的部门名称 */
      i18n_name?: Lark.DepartmentI18nName
      /** 父部门ID */
      parent_department_id?: string
      /** leaderID */
      leader_user_id?: string
      /** 部门的排序 */
      order?: string
      /** 是否创建部门群，默认不创建 */
      create_group_chat?: boolean
      /** 部门负责人 */
      leaders?: Lark.DepartmentLeader[]
      /** 部门群雇员类型限制 */
      group_chat_employee_types?: number[]
      /** 部门HRBP */
      department_hrbps?: string[]
    }

    export interface PatchQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface PatchResponse {
      department?: Lark.Department
    }

    export interface UpdateRequest {
      /** 部门名称 */
      name: string
      /** 国际化的部门名称 */
      i18n_name?: Lark.DepartmentI18nName
      /** 父部门ID */
      parent_department_id: string
      /** LeaderID */
      leader_user_id?: string
      /** 部门的排序 */
      order?: string
      /** 是否创建部门群，默认不创建 */
      create_group_chat?: boolean
      /** 部门负责人 */
      leaders?: Lark.DepartmentLeader[]
      /** 部门群雇员类型限制 */
      group_chat_employee_types?: number[]
    }

    export interface UpdateQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface UpdateResponse {
      department?: Lark.Department
    }

    export interface UpdateDepartmentIdRequest {
      /** 本部门的自定义部门新ID */
      new_department_id: string
    }

    export interface UpdateDepartmentIdQuery {
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface UnbindDepartmentChatRequest {
      /** 部门ID */
      department_id: string
    }

    export interface UnbindDepartmentChatQuery {
      /** 此次调用中使用的部门ID的类型，默认为"open_department_id" */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface GetQuery {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型
       * 不同 ID 的说明 [部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface GetResponse {
      department?: Lark.Department
    }

    export interface BatchQuery {
      /** 查询的部门ID列表，类型需要与department_id_type对应 */
      department_ids: string[]
      /** 说明请求中department_id_list参数所使用的部门ID类型 */
      department_id_type?: 'open_department_id' | 'department_id'
      /** 指定调用结果中包含用户（如部门leader）关联的用户ID类型 */
      user_id_type?: 'open_id' | 'union_id' | 'user_id'
    }

    export interface BatchResponse {
      /** 查询到的部门信息，其中异常的部门ID不返回结果。 */
      items?: Lark.Department[]
    }

    export interface ChildrenQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /**
       * 此次调用中使用的部门ID的类型
       * 不同 ID 的说明与department_id的获取方式参见 [部门ID说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/field-overview#23857fe0)
       */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 是否递归获取子部门 */
      fetch_child?: boolean
    }

    export interface ParentQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 部门ID */
      department_id: string
    }

    export interface SearchRequest {
      /** 搜索关键词，匹配字段为部门名称（不支持匹配部门国际化名称） */
      query: string
    }

    export interface SearchQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface DeleteQuery {
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface ListQuery extends Pagination {
      /** 此次调用中使用的用户ID的类型 */
      user_id_type?: 'user_id' | 'union_id' | 'open_id'
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
      /** 父部门的ID，填上获取部门下所有子部门，此处填写的 ID 必须是 department_id_type 指定的 ID。 */
      parent_department_id?: string
      /** 是否递归获取子部门 */
      fetch_child?: boolean
    }
  }

  export namespace Unit {
    export interface Methods {
      /**
       * 创建单位
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 修改单位信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/patch
       */
      patch(unit_id: string, body: PatchRequest): Promise<void>
      /**
       * 建立部门与单位的绑定关系
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/bind_department
       */
      bindDepartment(body: BindDepartmentRequest): Promise<void>
      /**
       * 解除部门与单位的绑定关系
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/unbind_department
       */
      unbindDepartment(body: UnbindDepartmentRequest): Promise<void>
      /**
       * 获取单位绑定的部门列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/list_department
       */
      listDepartment(query?: ListDepartmentQuery): Paginated<Lark.UnitDepartment, 'departmentlist'>
      /**
       * 获取单位信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/get
       */
      get(unit_id: string): Promise<GetResponse>
      /**
       * 获取单位列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/list
       */
      list(query?: Pagination): Paginated<Lark.Unit, 'unitlist'>
      /**
       * 删除单位
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/unit/delete
       */
      delete(unit_id: string): Promise<void>
    }

    export interface CreateRequest {
      /** 单位自定义ID。不带默认自动生成。1-64字节范围大小，需为数字字母 */
      unit_id?: string
      /** 单位的名字，长度范围为1-100个字 */
      name: string
      /** 单位类型，长度范围为1-100个字，创建后不可修改 */
      unit_type: string
    }

    export interface CreateResponse {
      /** 单位的自定义ID */
      unit_id: string
    }

    export interface PatchRequest {
      /** 单位的名字 */
      name?: string
    }

    export interface BindDepartmentRequest {
      /** 单位ID */
      unit_id: string
      /** 单位关联的部门ID */
      department_id: string
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface UnbindDepartmentRequest {
      /** 单位ID */
      unit_id: string
      /** 预解除关联的部门ID */
      department_id: string
      /** 此次调用中使用的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface ListDepartmentQuery extends Pagination {
      /** 单位ID */
      unit_id: string
      /** 此次调用中预获取的部门ID的类型 */
      department_id_type?: 'department_id' | 'open_department_id'
    }

    export interface GetResponse {
      /** 单位信息 */
      unit: Lark.Unit
    }
  }

  export namespace FunctionalRole {
    export interface Methods {
      member: Member.Methods
      /**
       * 创建角色
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 修改角色名称
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role/update
       */
      update(role_id: string, body: UpdateRequest): Promise<void>
      /**
       * 删除角色
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role/delete
       */
      delete(role_id: string): Promise<void>
    }

    export interface CreateRequest {
      /** 角色名称，在单租户下唯一 */
      role_name: string
    }

    export interface CreateResponse {
      /** 角色ID，在单租户下唯一 */
      role_id: string
    }

    export interface UpdateRequest {
      /** 修改的角色名称，在单租户下唯一 */
      role_name: string
    }

    export namespace Member {
      export interface Methods {
        /**
         * 批量添加角色成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role-member/batch_create
         */
        batchCreate(role_id: string, body: BatchCreateRequest, query?: BatchCreateQuery): Promise<BatchCreateResponse>
        /**
         * 批量设置角色成员管理范围
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role-member/scopes
         */
        scopes(role_id: string, body: ScopesRequest, query?: ScopesQuery): Promise<ScopesResponse>
        /**
         * 查询角色下某个成员的管理范围
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role-member/get
         */
        get(role_id: string, member_id: string, query?: GetQuery): Promise<GetResponse>
        /**
         * 查询角色下的所有成员信息
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role-member/list
         */
        list(role_id: string, query?: ListQuery): Paginated<Lark.FunctionalRoleMember, 'members'>
        /**
         * 删除角色下的成员
         * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/functional_role-member/batch_delete
         */
        batchDelete(role_id: string, body: BatchDeleteRequest, query?: BatchDeleteQuery): Promise<BatchDeleteResponse>
      }

      export interface BatchCreateRequest {
        /** 角色添加的角色成员列表（一批用户的UserID列表) */
        members: string[]
      }

      export interface BatchCreateQuery {
        /** 成员ID类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
      }

      export interface BatchCreateResponse {
        /** 批量新增角色成员结果集 */
        results?: Lark.FunctionalRoleMemberResult[]
      }

      export interface ScopesRequest {
        /** 角色修改的角色成员列表（一批用户的UserID列表) */
        members: string[]
        /** 角色内用户的管理范围 */
        departments: string[]
      }

      export interface ScopesQuery {
        /** 用户 ID 类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
        /** 此次调用中使用的部门ID的类型 */
        department_id_type?: 'department_id' | 'open_department_id'
      }

      export interface ScopesResponse {
        /** 批量更新角色成员管理范围结果集 */
        results?: Lark.FunctionalRoleMemberResult[]
      }

      export interface GetQuery {
        /** 用户 ID 类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
        /** 此次调用中使用的部门ID的类型 */
        department_id_type?: 'department_id' | 'open_department_id'
      }

      export interface GetResponse {
        /** 成员的管理范围 */
        member?: Lark.FunctionalRoleMember
      }

      export interface ListQuery extends Pagination {
        /** 用户 ID 类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
        /** 此次调用中使用的部门ID的类型 */
        department_id_type?: 'department_id' | 'open_department_id'
      }

      export interface BatchDeleteRequest {
        /** 角色删除的角色成员列表（一批用户的UserID列表) */
        members?: string[]
      }

      export interface BatchDeleteQuery {
        /** 成员ID类型 */
        user_id_type?: 'open_id' | 'union_id' | 'user_id'
      }

      export interface BatchDeleteResponse {
        /** 批量新增角色成员结果集 */
        result?: Lark.FunctionalRoleMemberResult[]
      }
    }
  }

  export namespace JobLevel {
    export interface Methods {
      /**
       * 创建职级
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_level/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 更新职级
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_level/update
       */
      update(job_level_id: string, body: UpdateRequest): Promise<UpdateResponse>
      /**
       * 获取单个职级信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_level/get
       */
      get(job_level_id: string): Promise<GetResponse>
      /**
       * 获取租户职级列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_level/list
       */
      list(query?: ListQuery): Paginated<Lark.JobLevel>
      /**
       * 删除职级
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_level/delete
       */
      delete(job_level_id: string): Promise<void>
    }

    export interface CreateRequest {
      /** 职级名称 */
      name: string
      /** 职级描述 */
      description?: string
      /** 职级的排序，可填入自然数100-100000的数值，系统按照数值大小从小到大排序。不填写该字段时，默认新增排序在当前职级列表中最后位（最大值） */
      order?: number
      /** 是否启用 */
      status: boolean
      /** 多语言名称 */
      i18n_name?: Lark.I18nContent[]
      /** 多语言描述 */
      i18n_description?: Lark.I18nContent[]
    }

    export interface CreateResponse {
      /** 职级信息 */
      job_level?: Lark.JobLevel
    }

    export interface UpdateRequest {
      /** 职级名称 */
      name?: string
      /** 职级描述 */
      description?: string
      /** 职级的排序，可填入自然数100-100000的数值，系统按照数值大小从小到大排序。不填写该字段时，默认新增排序在当前职级列表中最后位（最大值） */
      order?: number
      /** 是否启用 */
      status?: boolean
      /** 多语言名称 */
      i18n_name?: Lark.I18nContent[]
      /** 多语言描述 */
      i18n_description?: Lark.I18nContent[]
    }

    export interface UpdateResponse {
      /** 职级信息 */
      job_level?: Lark.JobLevel
    }

    export interface GetResponse {
      /** 职级信息 */
      job_level?: Lark.JobLevel
    }

    export interface ListQuery extends Pagination {
      /** 传入该字段时，可查询指定职级名称对应的职级信息。 */
      name?: string
    }
  }

  export namespace JobFamily {
    export interface Methods {
      /**
       * 创建序列
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_family/create
       */
      create(body: CreateRequest): Promise<CreateResponse>
      /**
       * 更新序列
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_family/update
       */
      update(job_family_id: string, body: UpdateRequest): Promise<UpdateResponse>
      /**
       * 获取单个序列信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_family/get
       */
      get(job_family_id: string): Promise<GetResponse>
      /**
       * 获取租户序列列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_family/list
       */
      list(query?: ListQuery): Paginated<Lark.JobFamily>
      /**
       * 删除序列
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_family/delete
       */
      delete(job_family_id: string): Promise<void>
    }

    export interface CreateRequest {
      /** 序列名称。1-100字符，支持中、英文及符号 */
      name: string
      /** 序列描述，描述序列详情信息 */
      description?: string
      /** 上级序列ID。需是该租户的序列ID列表中的值，对应唯一的序列名称。 */
      parent_job_family_id?: string
      /** 是否启用 */
      status: boolean
      /** 多语言序列名称 */
      i18n_name?: Lark.I18nContent[]
      /** 多语言描述 */
      i18n_description?: Lark.I18nContent[]
    }

    export interface CreateResponse {
      /** 序列信息 */
      job_family?: Lark.JobFamily
    }

    export interface UpdateRequest {
      /** 序列名称。1-100字符，支持中、英文及符号 */
      name?: string
      /** 序列描述，描述序列详情信息 */
      description?: string
      /** 上级序列ID。需是该租户的序列ID列表中的值，对应唯一的序列名称。 */
      parent_job_family_id?: string
      /** 是否启用 */
      status?: boolean
      /** 多语言序列名称 */
      i18n_name?: Lark.I18nContent[]
      /** 多语言描述 */
      i18n_description?: Lark.I18nContent[]
    }

    export interface UpdateResponse {
      /** 更新后的序列信息 */
      job_family?: Lark.JobFamily
    }

    export interface GetResponse {
      /** 序列信息 */
      job_family?: Lark.JobFamily
    }

    export interface ListQuery extends Pagination {
      /** 序列名称,传入该字段时，可查询指定序列名称对应的序列信息 */
      name?: string
    }
  }

  export namespace JobTitle {
    export interface Methods {
      /**
       * 获取单个职务信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_title/get
       */
      get(job_title_id: string): Promise<GetResponse>
      /**
       * 获取租户职务列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/job_title/list
       */
      list(query?: Pagination): Paginated<Lark.JobTitle>
    }

    export interface GetResponse {
      /** 职务信息 */
      job_title?: Lark.JobTitle
    }
  }

  export namespace WorkCity {
    export interface Methods {
      /**
       * 获取单个工作城市信息
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/work_city/get
       */
      get(work_city_id: string): Promise<GetResponse>
      /**
       * 获取租户工作城市列表
       * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/work_city/list
       */
      list(query?: Pagination): Paginated<Lark.WorkCity>
    }

    export interface GetResponse {
      /** 工作城市信息 */
      work_city?: Lark.WorkCity
    }
  }
}

Internal.define({
  '/contact/v3/scopes': {
    GET: 'contact.scope.list',
  },
  '/contact/v3/users': {
    POST: 'contact.user.create',
    GET: { name: 'contact.user.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/users/{user_id}': {
    PATCH: 'contact.user.patch',
    GET: 'contact.user.get',
    DELETE: 'contact.user.delete',
    PUT: 'contact.user.update',
  },
  '/contact/v3/users/{user_id}/update_user_id': {
    PATCH: 'contact.user.updateUserId',
  },
  '/contact/v3/users/batch': {
    GET: 'contact.user.batch',
  },
  '/contact/v3/users/find_by_department': {
    GET: { name: 'contact.user.findByDepartment', pagination: { argIndex: 0 } },
  },
  '/contact/v3/users/batch_get_id': {
    POST: 'contact.user.batchGetId',
  },
  '/contact/v3/users/{user_id}/resurrect': {
    POST: 'contact.user.resurrect',
  },
  '/contact/v3/group': {
    POST: 'contact.group.create',
  },
  '/contact/v3/group/{group_id}': {
    PATCH: 'contact.group.patch',
    GET: 'contact.group.get',
    DELETE: 'contact.group.delete',
  },
  '/contact/v3/group/simplelist': {
    GET: { name: 'contact.group.simplelist', pagination: { argIndex: 0, itemsKey: 'grouplist' } },
  },
  '/contact/v3/group/member_belong': {
    GET: { name: 'contact.group.memberBelong', pagination: { argIndex: 0, itemsKey: 'group_list' } },
  },
  '/contact/v3/custom_attrs': {
    GET: { name: 'contact.customAttr.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/employee_type_enums': {
    POST: 'contact.employeeTypeEnum.create',
    GET: { name: 'contact.employeeTypeEnum.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/employee_type_enums/{enum_id}': {
    PUT: 'contact.employeeTypeEnum.update',
    DELETE: 'contact.employeeTypeEnum.delete',
  },
  '/contact/v3/departments': {
    POST: 'contact.department.create',
    GET: { name: 'contact.department.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/departments/{department_id}': {
    PATCH: 'contact.department.patch',
    PUT: 'contact.department.update',
    GET: 'contact.department.get',
    DELETE: 'contact.department.delete',
  },
  '/contact/v3/departments/{department_id}/update_department_id': {
    PATCH: 'contact.department.updateDepartmentId',
  },
  '/contact/v3/departments/unbind_department_chat': {
    POST: 'contact.department.unbindDepartmentChat',
  },
  '/contact/v3/departments/batch': {
    GET: 'contact.department.batch',
  },
  '/contact/v3/departments/{department_id}/children': {
    GET: { name: 'contact.department.children', pagination: { argIndex: 1 } },
  },
  '/contact/v3/departments/parent': {
    GET: { name: 'contact.department.parent', pagination: { argIndex: 0 } },
  },
  '/contact/v3/departments/search': {
    POST: { name: 'contact.department.search', pagination: { argIndex: 1 } },
  },
  '/contact/v3/unit': {
    POST: 'contact.unit.create',
    GET: { name: 'contact.unit.list', pagination: { argIndex: 0, itemsKey: 'unitlist' } },
  },
  '/contact/v3/unit/{unit_id}': {
    PATCH: 'contact.unit.patch',
    GET: 'contact.unit.get',
    DELETE: 'contact.unit.delete',
  },
  '/contact/v3/unit/bind_department': {
    POST: 'contact.unit.bindDepartment',
  },
  '/contact/v3/unit/unbind_department': {
    POST: 'contact.unit.unbindDepartment',
  },
  '/contact/v3/unit/list_department': {
    GET: { name: 'contact.unit.listDepartment', pagination: { argIndex: 0, itemsKey: 'departmentlist' } },
  },
  '/contact/v3/group/{group_id}/member/add': {
    POST: 'contact.group.member.add',
  },
  '/contact/v3/group/{group_id}/member/batch_add': {
    POST: 'contact.group.member.batchAdd',
  },
  '/contact/v3/group/{group_id}/member/simplelist': {
    GET: { name: 'contact.group.member.simplelist', pagination: { argIndex: 1, itemsKey: 'memberlist' } },
  },
  '/contact/v3/group/{group_id}/member/remove': {
    POST: 'contact.group.member.remove',
  },
  '/contact/v3/group/{group_id}/member/batch_remove': {
    POST: 'contact.group.member.batchRemove',
  },
  '/contact/v3/functional_roles': {
    POST: 'contact.functionalRole.create',
  },
  '/contact/v3/functional_roles/{role_id}': {
    PUT: 'contact.functionalRole.update',
    DELETE: 'contact.functionalRole.delete',
  },
  '/contact/v3/functional_roles/{role_id}/members/batch_create': {
    POST: 'contact.functionalRole.member.batchCreate',
  },
  '/contact/v3/functional_roles/{role_id}/members/scopes': {
    PATCH: 'contact.functionalRole.member.scopes',
  },
  '/contact/v3/functional_roles/{role_id}/members/{member_id}': {
    GET: 'contact.functionalRole.member.get',
  },
  '/contact/v3/functional_roles/{role_id}/members': {
    GET: { name: 'contact.functionalRole.member.list', pagination: { argIndex: 1, itemsKey: 'members' } },
  },
  '/contact/v3/functional_roles/{role_id}/members/batch_delete': {
    PATCH: 'contact.functionalRole.member.batchDelete',
  },
  '/contact/v3/job_levels': {
    POST: 'contact.jobLevel.create',
    GET: { name: 'contact.jobLevel.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/job_levels/{job_level_id}': {
    PUT: 'contact.jobLevel.update',
    GET: 'contact.jobLevel.get',
    DELETE: 'contact.jobLevel.delete',
  },
  '/contact/v3/job_families': {
    POST: 'contact.jobFamily.create',
    GET: { name: 'contact.jobFamily.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/job_families/{job_family_id}': {
    PUT: 'contact.jobFamily.update',
    GET: 'contact.jobFamily.get',
    DELETE: 'contact.jobFamily.delete',
  },
  '/contact/v3/job_titles/{job_title_id}': {
    GET: 'contact.jobTitle.get',
  },
  '/contact/v3/job_titles': {
    GET: { name: 'contact.jobTitle.list', pagination: { argIndex: 0 } },
  },
  '/contact/v3/work_cities/{work_city_id}': {
    GET: 'contact.workCity.get',
  },
  '/contact/v3/work_cities': {
    GET: { name: 'contact.workCity.list', pagination: { argIndex: 0 } },
  },
})
