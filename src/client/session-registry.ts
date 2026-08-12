/**
 * Per-session annotation registry: in-memory drafts backed by localStorage,
 * with mutations always persisted (best-effort), plus a GLOBAL id→item index
 * (the 0811 ReferenceCodec signature has no session parameter, so the ref —
 * a global unique annotation id — resolves through the index). Also owns the
 * draft fingerprint used to decide whether chips can be rebuilt after a
 * refresh.
 */

import { contentHash } from './hash.ts'
import {
  addItem, clearItems, deriveBatchId, loadDraft, removeItems, saveDraft, updateNote,
  type DraftMutation,
} from './store.ts'
import type { AnnotationDraftStateV1, AnnotationItemV1, AnnotationStateV1, AnnotationTargetV1 } from './types.ts'

export interface SessionRegistry {
  /** The pending draft for one session (restored from storage on first access). */
  get(sessionId: string): AnnotationDraftStateV1
  /** Add one item; returns it on success, null when full or out of bounds. */
  add(sessionId: string, target: AnnotationTargetV1, note: string): AnnotationItemV1 | null
  /** Replace one item's note. */
  update(sessionId: string, id: string, note: string): void
  /** Drop one item (also from the global index). */
  remove(sessionId: string, id: string): void
  /** Drop the listed items of one session (the landed-cleanup path). */
  removeItems(sessionId: string, ids: readonly string[]): void
  /** Drop every item of one session. */
  clear(sessionId: string): void
  /** Global index lookup: the ref→item resolution used by the codec. */
  find(id: string): AnnotationItemV1 | undefined
  /** Transition one item's lifecycle state. */
  setState(sessionId: string, id: string, state: AnnotationStateV1): void
  /** Fingerprint of one session's pending chips (for refresh rebuild decisions). */
  fingerprint(sessionId: string): string
  /** Persist the last observed chip-set fingerprint (draft fingerprint). */
  setFingerprint(sessionId: string, fingerprint: string): void
  /**
   * Whether the persisted draft fingerprint still matches the current items
   * (the refresh-rebuild precondition): chips may be rebuilt only when the
   * item set is unchanged since they were last present.
   */
  shouldRebuildChips(sessionId: string): boolean
}

export function createSessionRegistry(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): SessionRegistry {
  const drafts = new Map<string, AnnotationDraftStateV1>()
  /** Global id → {sessionId, item} index (refs are global-unique uuids). */
  const byId = new Map<string, { sessionId: string; item: AnnotationItemV1 }>()

  const fingerprintKey = (sessionId: string): string => `dsh-annotation:fingerprint:v1:${sessionId}`

  const indexItem = (sessionId: string, item: AnnotationItemV1): void => {
    byId.set(item.id, { sessionId, item })
  }

  const reindex = (sessionId: string, draft: AnnotationDraftStateV1): void => {
    for (const [id, entry] of byId) {
      if (entry.sessionId === sessionId) byId.delete(id)
    }
    for (const item of draft.items) indexItem(sessionId, item)
  }

  const get = (sessionId: string): AnnotationDraftStateV1 => {
    const existing = drafts.get(sessionId)
    if (existing !== undefined) return existing
    const restored = loadDraft(sessionId, storage)
    drafts.set(sessionId, restored)
    reindex(sessionId, restored)
    return restored
  }

  const apply = (sessionId: string, mutation: DraftMutation): AnnotationDraftStateV1 => {
    drafts.set(sessionId, mutation.draft)
    reindex(sessionId, mutation.draft)
    saveDraft(sessionId, mutation.draft, storage)
    return mutation.draft
  }

  return {
    get,
    add(sessionId, target, note) {
      const draft = get(sessionId)
      const item: AnnotationItemV1 = { id: crypto.randomUUID(), target, note, state: 'attached' }
      const mutation = addItem(draft, item)
      if (mutation === null) return null
      apply(sessionId, mutation)
      return item
    },
    update(sessionId, id, note) {
      const draft = get(sessionId)
      const target = draft.items.find(item => item.id === id)
      if (target === undefined) return
      apply(sessionId, updateNote(draft, id, note))
    },
    remove(sessionId, id) {
      apply(sessionId, removeItems(get(sessionId), [id]))
    },
    removeItems(sessionId, ids) {
      apply(sessionId, removeItems(get(sessionId), ids))
    },
    clear(sessionId) {
      apply(sessionId, clearItems(get(sessionId)))
    },
    find(id) {
      return byId.get(id)?.item
    },
    setState(sessionId, id, state) {
      const draft = get(sessionId)
      const items = draft.items.map(item => (item.id === id ? { ...item, state } : item))
      if (items.every((item, index) => item === draft.items[index])) return
      apply(sessionId, { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: false })
    },
    fingerprint(sessionId) {
      const items = get(sessionId).items
      return contentHash(items.map(item => item.id).join(','))
    },
    setFingerprint(sessionId, fingerprint) {
      try {
        storage.setItem(fingerprintKey(sessionId), fingerprint)
      } catch {
        // best-effort
      }
    },
    shouldRebuildChips(sessionId) {
      try {
        const stored = storage.getItem(fingerprintKey(sessionId))
        if (stored === null) return false
        return stored === this.fingerprint(sessionId)
      } catch {
        return false
      }
    },
  }
}

/** Exported for tests: derive the batch id the same way the registry does. */
export { deriveBatchId }
