/**
 * The annotation trigger source: registered so the input pipeline can route
 * reference serialization through its codec — using the ORIGINAL 0811
 * ReferenceCodec contract (`serialize(ref, signal)`), no DSH modification.
 *
 * The source itself never opens a menu (candidates are empty); chips are
 * inserted by the panel through the native scoped insert-reference event.
 * `ref` is the GLOBAL-unique annotation id, so the old signature can resolve
 * the item without a session parameter. Serialization emits a strict
 * versioned envelope (plain text inside the message); the plugin Node half
 * splits it into native context + clean question at agent/pre-step time.
 */

import type { ReferenceInsert, SlashSource } from '@deepseek-ai/dsh-client-ui-slash/client'
import { encodeEnvelope } from '../shared/envelope.ts'
import type { SessionRegistry } from './session-registry.ts'
import type { AnnotationItemV1 } from './types.ts'

/** The source name (serializer routing key for annotation occurrences). */
export const SOURCE = 'annotation'

/** The model-facing label prefix inside chip rendering. */
export function chipLabel(index: number): string {
  return `批注 ${index + 1}`
}

export function createAnnotationSource(registry: SessionRegistry): SlashSource {
  return {
    trigger: '@',
    name: SOURCE,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      // The chip's clipboard projection: empty — the envelope protocol never
      // enters copy/cut/persistence projections.
      clipboardText: () => '',
      // Original 0811 signature: the ref is a GLOBAL unique annotation id, so
      // the registry resolves it without a session parameter.
      serialize(ref: string, signal: AbortSignal): Promise<string> {
        try {
          const item = registry.find(ref)
          if (item === undefined) {
            return Promise.reject(new Error(`annotation "${ref}" is no longer pending in any session`))
          }
          signal.throwIfAborted()
          return Promise.resolve(encodeEnvelope({
            version: 1,
            id: item.id,
            quote: item.target.exact,
            note: item.note,
          }))
        } catch (error) {
          // Synchronous throw (abort, etc.) becomes a rejection, never escapes.
          return Promise.reject(error)
        }
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
