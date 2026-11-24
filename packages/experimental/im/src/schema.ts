/**
 * Model-facing input and output schemas of the `im_*` tools.
 *
 * Inputs are the `parameters` of each tool (`dsh-tools` parameter objects: one required `true` per mandatory
 * property); outputs are canonical JSON values, so a tool result is replayable from the session log. Every tool
 * declares `oneOf: [<its payload>, errorValue]`: an IM refusal (unknown chat, missing grant, empty text …) is a
 * declared value the model can act on, not an opaque tool failure.
 */
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------------------------------------------
// Inputs

/** `im_read` arguments. */
export interface ImReadInput {
  /** Message key (`bot|id`) or per-chat sequence number. */
  message: string
  /** Chat to read from; defaults to the caller's home chat. */
  chat?: string
}
/** `im_history` arguments. */
export interface ImHistoryInput {
  /** Chat to read; defaults to the caller's home chat. */
  chat?: string
  /** Return messages with `seq` below this cursor. */
  before?: number
  /** Return messages with `seq` above this cursor. */
  after?: number
  /** Page size; bounded by `config.tools.maxHistoryItems`. */
  limit?: number
}
/** `im_members` arguments. */
export interface ImMembersInput {
  /** Chat to list; defaults to the caller's home chat. */
  chat?: string
  /** Keep only members whose name carries this text (case-insensitive). */
  query?: string
}
/** `im_send` arguments. */
export interface ImSendInput {
  /** Chat to publish into; defaults to the caller's home chat. */
  chat?: string
  /** Markdown published as one message. */
  text: string
  /** Thread id to publish into; omit to answer in the thread this session answered last, or the chat itself when none. */
  thread?: string
}
/** `im_reply` arguments. */
export interface ImReplyInput {
  /** Chat holding the message; defaults to the caller's home chat. */
  chat?: string
  /** Message to answer, by key or seq. */
  message: string
  /** Markdown reply body. */
  text: string
  /** Answer inside the message's thread as well as replying to it. */
  thread?: boolean
}
/** `im_send_file` arguments. */
export interface ImSendFileInput {
  /** Chat to publish into; defaults to the caller's home chat. */
  chat?: string
  /** Local file to publish; its extension picks the platform message kind. */
  path: string
  /** Message to answer, by key or seq; omit to publish in the thread this session answered last, or the chat itself when none. */
  quote?: string
}
/** `im_read_image` arguments. */
export interface ImReadImageInput {
  /** Chat the id was shown in; defaults to the caller's home chat. */
  chat?: string
  /** Stable media id such as `12.1` from `[图片 #12.1]`. */
  id: string
}
/** `im_read_file` arguments. */
export interface ImReadFileInput {
  /** Chat the id was shown in; defaults to the caller's home chat. */
  chat?: string
  /** Stable media id such as `12.2` from `[文件 #12.2 report.pdf]`. */
  id: string
}

const chatParameter = {
  type: 'string',
  description: 'Chat key (bot|chatId) or bare chat id; omit to use your home chat.',
} as const

/** `im_read` parameters. */
export const imReadParameters = {
  message: {
    type: 'string', required: true,
    description: 'Message key (bot|id) or the per-chat seq number shown as #12.',
  },
  ...{ chat: chatParameter },
} as const satisfies ParameterSchemaSpec

/** `im_history` parameters. */
export const imHistoryParameters = {
  ...{ chat: chatParameter },
  before: { type: 'integer', description: 'Only messages with a lower seq than this cursor.' },
  after: { type: 'integer', description: 'Only messages with a higher seq than this cursor.' },
  limit: { type: 'integer', description: 'Page size, within the operator-configured history limit.' },
} as const satisfies ParameterSchemaSpec

/** `im_members` parameters. */
export const imMembersParameters = {
  ...{ chat: chatParameter },
  query: {
    type: 'string',
    description: 'Keep only members whose name carries this text; use it instead of paging a large chat by hand.',
  },
} as const satisfies ParameterSchemaSpec

/** `im_send` parameters. */
export const imSendParameters = {
  ...{ chat: chatParameter },
  text: { type: 'string', required: true, description: 'Complete markdown to publish as one message.' },
  thread: {
    type: 'string',
    description: 'Thread id to publish into; omit to answer in the thread this session answered last, or the chat itself when none.',
  },
} as const satisfies ParameterSchemaSpec

/** `im_reply` parameters. */
export const imReplyParameters = {
  ...{ chat: chatParameter },
  message: {
    type: 'string', required: true,
    description: 'Message to answer, by key (bot|id) or seq.',
  },
  text: { type: 'string', required: true, description: 'Complete markdown reply.' },
  thread: { type: 'boolean', description: 'Also answer inside that message thread.' },
} as const satisfies ParameterSchemaSpec

/** `im_send_file` parameters. */
export const imSendFileParameters = {
  ...{ chat: chatParameter },
  path: { type: 'string', required: true, description: 'Local path of the file to publish.' },
  quote: {
    type: 'string',
    description: 'Message to answer, by key or seq; omit to publish in the thread this session answered last, or the chat itself when none.',
  },
} as const satisfies ParameterSchemaSpec

/** `im_read_image` parameters. */
export const imReadImageParameters = {
  ...{ chat: chatParameter },
  id: {
    type: 'string', required: true,
    description: 'Stable media id such as 12.1 from [图片 #12.1].',
  },
} as const satisfies ParameterSchemaSpec

/** `im_read_file` parameters. */
export const imReadFileParameters = {
  ...{ chat: chatParameter },
  id: {
    type: 'string', required: true,
    description: 'Stable media id such as 12.2 from [文件 #12.2 report.pdf].',
  },
} as const satisfies ParameterSchemaSpec

// ---------------------------------------------------------------------------------------------------------------
// Outputs

/** A refused operation: typed code plus the operator-facing reason. */
export const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: {
      type: 'string', required: true,
      description: 'ImError code: configuration, ownership, access, unavailable, capacity, persistence or conflict.',
    },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** One person a message mentions: the id a publication addresses and the name the platform showed. */
export const mentionValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Platform user id the mention addresses.' },
    name: { type: 'string', description: 'Display name the platform showed for it.' },
  },
} as const satisfies ValueSchemaSpec

/** One message as the IM tools show it. */
export const messageValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true, description: 'Global message key (bot|id).' },
    seq: { type: 'integer', required: true, description: 'Per-chat sequence number, shown as #seq.' },
    chat: { type: 'string', required: true },
    sender: { type: 'string', required: true, description: 'Sender display name or platform user id.' },
    senderId: { type: 'string', required: true },
    self: { type: 'boolean', required: true },
    time: { type: 'integer', required: true },
    text: { type: 'string', required: true },
    mentions: {
      type: 'array', items: mentionValue, required: true,
      description: 'People this message mentions; a mention of the bot itself is not listed.',
    },
    quote: { type: 'string', description: 'Quoted message key.' },
    thread: { type: 'string', description: 'Thread the message belongs to.' },
    media: {
      type: 'array', items: { type: 'string' }, required: true,
      description: 'Media labels of the message, e.g. [图片 #12.1].',
    },
  },
} as const satisfies ValueSchemaSpec

/** `im_read` result. */
export const imReadOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { message: { ...messageValue, required: true } },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec

/** `im_history` result. */
export const imHistoryOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        messages: { type: 'array', items: messageValue, required: true },
        chat: { type: 'string', required: true },
        total: { type: 'integer', required: true, description: 'Messages this page holds.' },
      },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec

/** `im_members` result: the people a chat lists, with the markdown that mentions each of them. */
export const imMembersOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', required: true },
        members: {
          type: 'array', required: true,
          description: 'Members in platform order, stopped at the configured bound.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: 'Platform user id a mention addresses.' },
              name: { type: 'string', description: 'Display name the platform shows for them.' },
              mention: {
                type: 'string', required: true,
                description: 'Markdown that mentions this person; paste it into a message to notify them.',
              },
            },
          },
        },
        total: { type: 'integer', required: true, description: 'Members this answer holds.' },
        more: { type: 'boolean', required: true, description: 'Whether the chat lists further members.' },
      },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec

/** The outcome of one publication, as the model reads it. */
export const imSendOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['confirmed', 'failed', 'uncertain', 'partial'], required: true },
        message: { type: 'string', description: 'Stored key of the published message.' },
        seq: { type: 'integer', description: 'Per-chat seq of the published message.' },
        report: {
          type: 'string',
          description: 'One-line summary of what the platform could not render natively.',
        },
        error: { type: 'string', description: 'Why the publication failed, is partial, or is uncertain.' },
      },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec

/** `im_read_image` result: one attachment, or why the id carries no readable image. */
export const imReadImageOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        chat: { type: 'string', required: true },
        image: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'image', required: true },
            attachment: { type: 'object', additionalProperties: true, required: true },
          },
        },
        skipped: { type: 'string', description: 'Why the media element was not admitted as an image.' },
      },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec

/** `im_read_file` result: the stored file and where to read it, or why the id carries no readable file. */
export const imReadFileOutput = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        chat: { type: 'string', required: true },
        file: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Display name of the stored copy.' },
            bytes: { type: 'integer', required: true, description: 'Exact byte length of the stored copy.' },
            attachmentId: { type: 'string', required: true, description: 'Content digest of the stored copy.' },
          },
        },
        path: {
          type: 'string',
          description: 'Path of the saved copy in your workspace; read it with your file tools.',
        },
        skipped: {
          type: 'string',
          description: 'Why the media element was not admitted as a file.',
        },
      },
    },
    errorValue,
  ],
} as const satisfies ValueSchemaSpec
