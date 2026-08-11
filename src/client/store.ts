/**
 * Per-session pending annotation state: the single source of truth for the
 * unsent batch. Persisted to localStorage per session (refresh, session
 * switch, and reopen all restore the exact draft); batch ids derive from the
 * item content so identical retries keep the id while any edit mints a new
 * one.
 */

import { contentHash } from './hash.ts'
import {
  ANCHOR_CONTEXT_CHARS,
  MAX_ITEMS,
  MAX_NOTE_BYTES,
  MAX_QUOTE_BYTES,
  type AnnotationDraftStateV1,
  type AnnotationItemV1,
} from './types.ts'

const STORAGE_PREFIX = 'dsh-annotation:draft:v1:'

export function storageKey(sessionId: string): string {
  return STORAGE_PREFIX + sessionId
}

/** Derive the batch id from the exact item payloads (id-excluded: ids are stable, content is not). */
export function deriveBatchId(items: readonly AnnotationItemV1[]): string {
  const payload = items
    .map(item => `${item.target.messageId}\u0000${item.target.start}\u0000${item.target.end}\u0000${item.target.exact}\u0000${item.note}`)
    .join('\u0001')
  return `ann-${contentHash(payload)}`
}

/** Fresh empty per-session draft state. */
export function emptyDraft(): AnnotationDraftStateV1 {
  return { version: 1, batchId: deriveBatchId([]), items: [] }
}

/** Load the persisted draft for one session; a missing or malformed record yields empty. */
export function loadDraft(sessionId: string, storage: Pick<Storage, 'getItem'>): AnnotationDraftStateV1 {
  const raw = storage.getItem(storageKey(sessionId))
  if (raw === null) return emptyDraft()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isDraftState(parsed)) return emptyDraft()
    // Re-derive the batch id from the stored payload: a legacy or tampered
    // batchId must never survive into a submission.
    return { version: 1, batchId: deriveBatchId(parsed.items), items: parsed.items }
  } catch {
    return emptyDraft()
  }
}

/** Persist one session's draft (best-effort; storage failures never throw). */
export function saveDraft(
  sessionId: string,
  draft: AnnotationDraftStateV1,
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    if (draft.items.length === 0) storage.removeItem(storageKey(sessionId))
    else storage.setItem(storageKey(sessionId), JSON.stringify(draft))
  } catch {
    // Quota or privacy-mode failures degrade to memory-only.
  }
}

export interface DraftMutation {
  /** The next state. */
  readonly draft: AnnotationDraftStateV1
  /** Whether the batch id changed (every content edit does). */
  readonly batchChanged: boolean
}

/** Add one item (bound-checked). Returns null when the draft is full. */
export function addItem(draft: AnnotationDraftStateV1, item: AnnotationItemV1): DraftMutation | null {
  if (draft.items.length >= MAX_ITEMS) return null
  if (!withinBounds(item)) return null
  const items = [...draft.items, item]
  return { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: true }
}

/** Replace one item's note in place. Returns the previous state untouched when the id is unknown. */
export function updateNote(draft: AnnotationDraftStateV1, id: string, note: string): DraftMutation {
  const items = draft.items.map(item => (item.id === id ? { ...item, note } : item))
  if (items.every((item, index) => item === draft.items[index])) return { draft, batchChanged: false }
  return { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: true }
}

/** Remove one item. */
export function removeItem(draft: AnnotationDraftStateV1, id: string): DraftMutation {
  const items = draft.items.filter(item => item.id !== id)
  if (items.length === draft.items.length) return { draft, batchChanged: false }
  return { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: true }
}

/** Remove the items with the given ids in one step (the send-committed path). */
export function removeItems(draft: AnnotationDraftStateV1, ids: readonly string[]): DraftMutation {
  const drop = new Set(ids)
  const items = draft.items.filter(item => !drop.has(item.id))
  if (items.length === draft.items.length) return { draft, batchChanged: false }
  return { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: true }
}

/** Clear every pending item. */
export function clearItems(draft: AnnotationDraftStateV1): DraftMutation {
  if (draft.items.length === 0) return { draft, batchChanged: false }
  const items: AnnotationItemV1[] = []
  return { draft: { version: 1, batchId: deriveBatchId(items), items }, batchChanged: true }
}

/** Local bound check for one item (quote 8 KiB, note 4 KiB). */
export function withinBounds(item: AnnotationItemV1): boolean {
  return utf8Bytes(item.target.exact) <= MAX_QUOTE_BYTES && utf8Bytes(item.note) <= MAX_NOTE_BYTES
}

/** Trim the anchor context strings to their documented length. */
export function boundAnchorContext(prefix: string, suffix: string): { prefix: string; suffix: string } {
  return {
    prefix: prefix.slice(-ANCHOR_CONTEXT_CHARS),
    suffix: suffix.slice(0, ANCHOR_CONTEXT_CHARS),
  }
}

/** UTF-8 byte length without TextEncoder allocations (browsers + jsdom). */
export function utf8Bytes(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function isDraftState(value: unknown): value is { items: AnnotationItemV1[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; items?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.items)) return false
  return candidate.items.every(item => typeof item === 'object' && item !== null
    && typeof (item as AnnotationItemV1).id === 'string'
    && typeof (item as AnnotationItemV1).note === 'string'
    && typeof (item as AnnotationItemV1).target === 'object')
}
