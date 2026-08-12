/**
 * Annotation 2.0 data structures (task-spec section 8). Pure data — no
 * runtime logic. Identity and anchors are message-scoped: two annotations on
 * the SAME text in different messages stay independent items.
 */

/** One stable selection anchor inside ONE completed assistant message. */
export interface AnnotationTargetV1 {
  /** The durable assistant-message id (the event seq exposed via data-dsh-assistant-message-id). */
  messageId: string
  /** Character offsets into the message's plain text (start ≤ end). */
  start: number
  end: number
  /** The exact selected text at anchor time. */
  exact: string
  /** Up to 40 chars of plain text before the selection (disambiguation). */
  prefix: string
  /** Up to 40 chars of plain text after the selection (disambiguation). */
  suffix: string
}

/** One annotation item: an anchor plus an optional readable note. */
export interface AnnotationItemV1 {
  /** Owner-scoped stable id (also the reference id riding the draft chip). */
  id: string
  target: AnnotationTargetV1
  /** Readable markdown note; may be empty (= mark-only annotation). */
  note: string
  /** Delivery lifecycle state (see store.ts transitions). */
  state: AnnotationStateV1
}

/**
 * Delivery lifecycle. The plugin observes the native input and session
 * surfaces only (no DSH callbacks exist): chips vanishing from the draft is
 * 'submitted' (optimistic), the queue carrying the envelope is 'queued',
 * history carrying the native context row is 'landed' (the item is cleared),
 * a restored draft (send failure re-injection) is 'failed', and a queue edit
 * that dropped the envelope is 'unknown' (never auto-resend).
 */
export type AnnotationStateV1 =
  | 'attached'
  | 'submitted'
  | 'queued'
  | 'landed'
  | 'failed'
  | 'unknown'

/** Per-session pending (unsent) annotation batch, persisted per session. */
export interface AnnotationDraftStateV1 {
  version: 1
  /**
   * Content-derived batch id: identical data always derives the same id (so
   * a retry after response loss dedupes on the Host), and ANY edit derives a
   * new id (so a changed batch can never collide with an accepted one).
   */
  batchId: string
  items: AnnotationItemV1[]
}

/** Local bound: at most 32 pending items per session. */
export const MAX_ITEMS = 32

/** Local bound: one anchored reference quote at most 8 KiB. */
export const MAX_QUOTE_BYTES = 8 * 1024

/** Local bound: one note at most 4 KiB. */
export const MAX_NOTE_BYTES = 4 * 1024

/** Prefix/suffix context length kept on an anchor for re-location. */
export const ANCHOR_CONTEXT_CHARS = 40
