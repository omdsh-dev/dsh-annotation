/**
 * The annotation trigger source: registered so the input pipeline can route
 * reference serialization and acceptance notifications through its codec.
 * The source itself never opens a menu (candidates are empty); chips are
 * inserted by the panel through the scoped insert-reference event.
 */

import type {
  ClientSessionContext, ReferenceInsert, ReferenceSerialization, SlashSource,
} from '@deepseek-ai/dsh-client-ui-slash/client'
import type { SessionRegistry } from './session-registry.ts'
import type { AnnotationItemV1 } from './types.ts'

/** The source name (serializer routing key for annotation occurrences). */
export const SOURCE = 'annotation'

/** The model-facing label prefix inside chip rendering. */
export function chipLabel(index: number): string {
  return `批注 ${index + 1}`
}

/** One notice's readable markdown body: quote, source index, and the note. */
export function noticeText(item: AnnotationItemV1, index: number): string {
  const lines = [
    `> 引用：${item.target.exact}`,
    `来源：消息 ${item.target.messageId}，第 ${index} 处`,
    `批注：${item.note === '' ? '（未填写）' : item.note}`,
  ]
  return lines.join('\n')
}

export function createAnnotationSource(registry: SessionRegistry): SlashSource {
  return {
    trigger: '@',
    name: SOURCE,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      clipboardText: () => '',
      serialize(session: ClientSessionContext, ref: string): Promise<ReferenceSerialization> {
        const draft = registry.get(session.sessionId)
        const index = draft.items.findIndex(item => item.id === ref)
        if (index < 0) {
          return Promise.reject(new Error(`annotation "${ref}" is no longer pending in this session`))
        }
        const item = draft.items[index]!
        return Promise.resolve({
          kind: 'context',
          // The WHOLE pending batch shares one content-derived id: identical
          // retries dedupe on the Host; any edit derived a new id already.
          batchId: draft.batchId,
          summary: `批注 ${index + 1}`,
          text: noticeText(item, index + 1),
        })
      },
      committed(session: ClientSessionContext, ref: string) {
        // Host accepted the batch: retire exactly the sent item.
        registry.commit(session.sessionId, [ref])
      },
    },
  }
}

/** A chip insertion for one pending item (inserted at the draft tail). */
export function chipInsert(item: AnnotationItemV1, index: number, draftLength: number, draftRev: number): {
  reference: ReferenceInsert
  span: { start: number; end: number; draftRev: number }
} {
  return {
    reference: { source: SOURCE, ref: item.id, label: chipLabel(index), clipboardText: '' },
    span: { start: draftLength, end: draftLength, draftRev },
  }
}
