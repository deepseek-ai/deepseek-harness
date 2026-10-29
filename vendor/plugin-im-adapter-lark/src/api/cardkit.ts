/**
 * CardKit entity routes of the Lark platform.
 *
 * A card *entity* is a card stored on the platform: it is sent **exactly once** as an `interactive` message whose
 * content is `{ type: 'card', data: { card_id } }`, and afterwards updated per element instead of as a whole. That is
 * what makes the `patch` stream strategy possible:
 *
 * | operation | route | used by |
 * |---|---|---|
 * | create the entity | `POST cardkit/v1/cards` | `open` |
 * | replace the whole card | `PUT cardkit/v1/cards/{card_id}` | a `replace` diff, `close` |
 * | replace one component's text | `PUT …/elements/{element_id}/content` | a typewriter tick |
 * | patch one component's props | `PATCH …/elements/{element_id}` | a changed button/panel |
 * | insert elements | `POST …/elements` | an inserted element |
 * | delete one element | `DELETE …/elements/{element_id}` | a deleted element |
 * | change card settings | `PATCH cardkit/v1/cards/{card_id}/settings` | re-enable streaming after the 10-minute cap |
 *
 * Every write carries a `sequence` that must strictly increase per entity; the stream driver owns the counter. The
 * client itself is stateless: it only validates the envelope and surfaces {@link LarkApiError}.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/api/cardkit
 */

import { LarkApiError } from '../errors.ts'
import { nonEmpty } from './events.ts'
import type { LarkApi } from './client.ts'

/** Where an inserted element goes, relative to the elements already in the card. */
export interface LarkCardInsertPosition {
  /** Insert before this element id. */
  before?: string
  /** Insert after this element id. */
  after?: string
}

/**
 * CardKit client of one application.
 *
 * The card JSON is `unknown` on purpose: the card mode owns the card document type, and the driver passes whatever the
 * mode produced, exactly as the platform will render it.
 */
export class LarkCardKit {
  constructor(readonly api: LarkApi) {}

  /**
   * Create a card entity from a complete card JSON 2.0 document (`open`).
   *
   * @param card - the card document, including `config.streaming_mode` / `streaming_config` when it streams.
   * @param signal - cancellation.
   * @returns the platform `card_id` to send and to address later updates with.
   */
  async create(card: unknown, signal?: AbortSignal): Promise<string> {
    const answer = await this.api.answer<{ card_id?: string }>('POST', '/cardkit/v1/cards', {
      data: { type: 'card_json', data: JSON.stringify(card) },
      signal,
    })
    const cardId = nonEmpty(answer.card_id)
    if (!cardId) throw new LarkApiError('cardkit create answered without card_id', { status: 200, published: 'unknown' })
    return cardId
  }

  /**
   * Replace the complete document of one entity (`replace`, and the final `close` update).
   *
   * @param cardId - entity to replace.
   * @param card - the new document.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async update(cardId: string, card: unknown, sequence: number, signal?: AbortSignal): Promise<void> {
    await this.api.request('PUT', `/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
      signal,
    })
  }

  /**
   * Replace the text of one streaming markdown component (typewriter tick); the platform animates only a prefix
   * extension.
   *
   * @param cardId - entity holding the component.
   * @param elementId - stable component id (`e` + base32(sha1)).
   * @param content - the new text.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async content(cardId: string, elementId: string, content: string, sequence: number, signal?: AbortSignal): Promise<void> {
    await this.api.request(
      'PUT',
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
      { data: { content, sequence }, signal },
    )
  }

  /**
   * Patch the properties of one component (changed component).
   *
   * @param cardId - entity holding the component.
   * @param elementId - stable component id.
   * @param partial - the fields to replace, as the platform's partial-element object.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async patchElement(cardId: string, elementId: string, partial: unknown, sequence: number, signal?: AbortSignal): Promise<void> {
    await this.api.request(
      'PATCH',
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}`,
      { data: { partial_element: JSON.stringify(partial), sequence }, signal },
    )
  }

  /**
   * Insert elements into a card (inserted element).
   *
   * The platform takes the whole list as one serialized JSON array in `elements` and names the anchor in
   * `target_element_id`. An array of serialized elements is refused (`9499`, "Invalid parameter type in json:
   * Elements"), and the `before_element_id` / `after_element_id` names are not read (`10002`, "target elementID is
   * nil").
   *
   * @param cardId - entity to extend.
   * @param elements - card elements to add.
   * @param position - relative to an existing element; empty inserts at the end.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async insertElements(cardId: string, elements: readonly unknown[], position: LarkCardInsertPosition, sequence: number, signal?: AbortSignal): Promise<void> {
    const data: Record<string, unknown> = {
      elements: JSON.stringify(elements),
      sequence,
    }
    if (position.before !== undefined) {
      data.type = 'insert_before'
      data.target_element_id = position.before
    } else if (position.after !== undefined) {
      data.type = 'insert_after'
      data.target_element_id = position.after
    } else {
      data.type = 'insert_after'
    }
    await this.api.request('POST', `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements`, { data, signal })
  }

  /**
   * Delete one element (deleted element).
   *
   * @param cardId - entity to shrink.
   * @param elementId - stable component id.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async deleteElement(cardId: string, elementId: string, sequence: number, signal?: AbortSignal): Promise<void> {
    await this.api.request(
      'DELETE',
      `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}`,
      { data: { sequence }, signal },
    )
  }

  /**
   * Change card settings (streaming mode is forced off 10 minutes after it was enabled).
   *
   * The platform takes the settings as a JSON **string** (`settings: "{\"streaming_mode\":true}"`); an object in that
   * field is answered `400`, which is why this route carries a serialized body.
   *
   * @param cardId - entity to reconfigure.
   * @param settings - `{ streaming_mode, streaming_config }`.
   * @param sequence - strictly increasing per entity.
   * @param signal - cancellation.
   */
  async settings(cardId: string, settings: { streaming_mode?: boolean; streaming_config?: unknown }, sequence: number, signal?: AbortSignal): Promise<void> {
    await this.api.request('PATCH', `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      data: { settings: JSON.stringify(settings), sequence },
      signal,
    })
  }
}
