/**
 * Per-session annotation registry: in-memory drafts backed by localStorage,
 * with mutations always persisted (best-effort). One registry per plugin
 * apply; sessions materialize their draft on first access.
 */

import {
  addItem, clearItems, deriveBatchId, loadDraft, removeItems, saveDraft, updateNote,
  type DraftMutation,
} from './store.ts'
import type { AnnotationDraftStateV1, AnnotationItemV1, AnnotationTargetV1 } from './types.ts'

export interface SessionRegistry {
  /** The pending draft for one session (restored from storage on first access). */
  get(sessionId: string): AnnotationDraftStateV1
  /** Add one item; returns it on success, null when full or out of bounds. */
  add(sessionId: string, target: AnnotationTargetV1, note: string): AnnotationItemV1 | null
  /** Replace one item's note. */
  update(sessionId: string, id: string, note: string): void
  /** Drop one item. */
  remove(sessionId: string, id: string): void
  /** Drop the listed items (the Host-accepted path). */
  commit(sessionId: string, ids: readonly string[]): void
  /** Drop every item. */
  clear(sessionId: string): void
}

export function createSessionRegistry(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): SessionRegistry {
  const drafts = new Map<string, AnnotationDraftStateV1>()

  const get = (sessionId: string): AnnotationDraftStateV1 => {
    const existing = drafts.get(sessionId)
    if (existing !== undefined) return existing
    const restored = loadDraft(sessionId, storage)
    drafts.set(sessionId, restored)
    return restored
  }

  const apply = (sessionId: string, mutation: DraftMutation): AnnotationDraftStateV1 => {
    drafts.set(sessionId, mutation.draft)
    saveDraft(sessionId, mutation.draft, storage)
    return mutation.draft
  }

  return {
    get,
    add(sessionId, target, note) {
      const draft = get(sessionId)
      const item: AnnotationItemV1 = { id: crypto.randomUUID(), target, note }
      const mutation = addItem(draft, item)
      if (mutation === null) return null
      apply(sessionId, mutation)
      return item
    },
    update(sessionId, id, note) {
      apply(sessionId, updateNote(get(sessionId), id, note))
    },
    remove(sessionId, id) {
      apply(sessionId, removeItems(get(sessionId), [id]))
    },
    commit(sessionId, ids) {
      apply(sessionId, removeItems(get(sessionId), ids))
    },
    clear(sessionId) {
      apply(sessionId, clearItems(get(sessionId)))
    },
  }
}

/** Exported for tests: derive the batch id the same way the registry does. */
export { deriveBatchId }
