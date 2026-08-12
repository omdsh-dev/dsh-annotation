/**
 * The annotation panel: mounted in the conversation.composer.dock slot
 * (the native band under the composer card). Renders the collapsible
 * 「批注 ×N」 list, the selection float bar (「批注」 button over assistant
 * text), the CSS-Highlight painting with rAF-merged repositioning, and the
 * lifecycle observation: chip disappearance (submitted, optimistic),
 * chip restoration after a failed send (failed), the queue carrying the
 * envelope (queued), and history carrying the native context row (landed →
 * cleared). No auto re-insertion: a deleted or refreshed-away chip is
 * re-attached by the user from the panel (or rebuilt once when the draft
 * fingerprint still matches).
 */

import { useEffect, useRef, useState } from 'react'
import type { ClientContext, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { extractTarget } from './anchor.ts'
import { chipInsert, SOURCE } from './codec.ts'
import { createHighlightSurface, RepaintQueue, type HighlightSurface } from './highlight.ts'
import type { SessionRegistry } from './session-registry.ts'
import type { AnnotationItemV1, AnnotationTargetV1 } from './types.ts'

/** Structural input-state face (the stock ui-conversation input currency; no modified-surface imports). */
export interface PanelInputState {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  occurrences: ReadonlyArray<{ source: string; ref: string; offset: number }>
}

/** Structural input-action face. */
export interface PanelInputActions {
  setDraft(text: string): void
}

/** Injected face of the composer.dock entry. */
export interface AnnotationPanelInjected {
  sessionId: string
  /** Session scope (scoped input-mutation events). */
  actx: ClientContext | undefined
  registry: SessionRegistry
}

/** Full component props: dock owner + injected face only. The framework
 *  standard kit (useInput / inputActions) is injected at runtime — the stock
 *  ui-conversation surface does not export its input types, and declaring
 *  structural generics here would fight the slot type check. */
export interface AnnotationPanelProps extends AnnotationPanelInjected {
  /** The dock owner currency: conversation snapshot (landed detection). */
  session: ConversationSnapshot
}

const EMPTY_INPUT: PanelInputState = { draft: '', draftRev: 0, phase: 'plain', occurrences: [] }

const MAX_NOTE_LENGTH = 4 * 1024

/** Runtime-injected framework kit, reached structurally (see AnnotationPanelProps). */
interface PanelKit {
  useInput?: <T>(selector: (state: PanelInputState) => T) => T
  inputActions?: PanelInputActions
}

/** The id marker the Node half embeds in the native context row. */
const ID_MARKER = /〔([^〕]+)〕/g

/** Collect annotation ids referenced by the history's native context rows. */
function landedIds(session: ConversationSnapshot, ids: readonly string[]): Set<string> {
  const wanted = new Set(ids)
  const landed = new Set<string>()
  for (const node of session.chat.nodes.values()) {
    const data = node.data as { content?: unknown }
    if (!Array.isArray(data?.content)) continue
    for (const block of data.content) {
      if (typeof block !== 'object' || block === null) continue
      const text = (block as { text?: unknown }).text
      if (typeof text !== 'string') continue
      for (const match of text.matchAll(ID_MARKER)) {
        const id = match[1]
        if (id !== undefined && wanted.has(id)) landed.add(id)
      }
    }
  }
  return landed
}

export function AnnotationPanel(props: AnnotationPanelProps) {
  const { sessionId, actx, registry, session } = props
  const kit = props as unknown as PanelKit
  const useInput = kit.useInput
  const inputActions = kit.inputActions
  const input = useInput === undefined ? EMPTY_INPUT : useInput(state => state)
  const draft = registry.get(sessionId)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [movedIds, setMovedIds] = useState<ReadonlySet<string>>(new Set())
  const [float, setFloat] = useState<{ x: number; y: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HighlightSurface | null>(null)
  const queueRef = useRef<RepaintQueue | null>(null)
  const floatTargetRef = useRef<AnnotationTargetV1 | null>(null)
  const lastChipRefs = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const rebuiltRef = useRef(false)
  const locked = input.phase === 'submitting' || input.phase === 'adjudicating'

  // Paint highlights + pins whenever the items, the input, or the session
  // change; keep the moved set in sync (only re-render on change).
  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    if (surfaceRef.current === null) {
      const cssHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS
        ? CSS.highlights
        : undefined
      const surface = createHighlightSurface(overlay, cssHighlights)
      surfaceRef.current = surface
      queueRef.current = new RepaintQueue(surface, () => registry.get(sessionId).items, document)
    }
    const repaint = (): void => {
      const located = surfaceRef.current!.paint(registry.get(sessionId).items, document)
      const next = new Set(registry.get(sessionId).items.map(item => item.id).filter(id => !located.some(l => l.id === id)))
      setMovedIds(current => {
        if (current.size === next.size && [...current].every(id => next.has(id))) return current
        return next
      })
    }
    repaint()
    return () => { surfaceRef.current?.clearHighlights() }
  }, [sessionId, registry, input, draft.items])

  // Scroll / resize repositioning, merged per frame.
  useEffect(() => {
    const schedule = (): void => { queueRef.current?.schedule() }
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
    }
  }, [])

  // Lifecycle observation over the native chip set:
  // - the draft fingerprint is kept at the "consistent" chip set (chips ==
  //   items) — that is what a refresh compares against for the one-shot
  //   rebuild below,
  // - chips vanishing AFTER mount = submitted (optimistic; the baseline
  //   clears the draft on acceptance and re-injects it on failure),
  // - chips coming back = failed (send failure re-injection).
  useEffect(() => {
    const present = new Set(input.occurrences.filter(o => o.source === SOURCE).map(o => o.ref))
    const key = [...present].sort().join(',')
    const prev = lastChipRefs.current
    lastChipRefs.current = key
    const consistent = draft.items.length === present.size
      && draft.items.every(item => present.has(item.id))
    if (consistent) {
      registry.setFingerprint(sessionId, registry.fingerprint(sessionId))
    }
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    if (prev === null) return
    const prevSet = new Set(prev === '' ? [] : prev.split(','))
    for (const item of draft.items) {
      const wasThere = prevSet.has(item.id)
      const isThere = present.has(item.id)
      if (wasThere && !isThere && item.state === 'attached') {
        registry.setState(sessionId, item.id, 'submitted')
      } else if (!wasThere && isThere && item.state === 'submitted') {
        registry.setState(sessionId, item.id, 'failed')
      }
    }
  }, [input.occurrences, input.draftRev, draft.items, registry, sessionId])

  // Landed detection: the history's native context rows carry our id markers
  // once the Node half has split the batch — those items are durable, clear
  // them (the queue may still show the envelope, that is fine).
  useEffect(() => {
    const ids = draft.items.map(item => item.id)
    if (ids.length === 0) return
    const landed = landedIds(session, ids)
    if (landed.size === 0) return
    registry.removeItems(sessionId, [...landed])
    setNotice(null)
  }, [session, draft.items, registry, sessionId])

  // Refresh rebuild: chips live only in the draft mirror (clipboard
  // projection is empty), so after a reload they are gone. Rebuild them ONCE
  // per mount (the refresh scenario) when the draft fingerprint still matches
  // the persisted one; chips deleted inside the live session are never
  // auto-restored — the user re-attaches from the panel.
  useEffect(() => {
    if (rebuiltRef.current || locked || actx === undefined) return
    const present = new Set(input.occurrences.filter(o => o.source === SOURCE).map(o => o.ref))
    const missing = draft.items.filter(item => !present.has(item.id))
    if (missing.length === 0) return
    if (!registry.shouldRebuildChips(sessionId)) return
    rebuiltRef.current = true
    for (const item of missing) {
      const index = draft.items.indexOf(item)
      const { reference, span } = chipInsert(item, index, input.draft.length, input.draftRev)
      actx.bail(actx, 'slash/input-insert-reference', { reference, span })
    }
  }, [actx, input.draft, input.draftRev, input.occurrences, input.phase, locked, draft.items, registry, sessionId])

  // Selection float bar: annotate button over assistant text.
  useEffect(() => {
    let frame = 0
    const onSelectionChange = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection()
        if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
          setFloat(null)
          floatTargetRef.current = null
          return
        }
        const target = extractTarget(selection, document)
        if (target === null) {
          setFloat(null)
          floatTargetRef.current = null
          return
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        floatTargetRef.current = target
        setFloat({ x: rect.left + rect.width / 2, y: rect.top })
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      cancelAnimationFrame(frame)
    }
  }, [])

  const annotate = (): void => {
    const target = floatTargetRef.current
    if (target === null) return
    const item = registry.add(sessionId, target, '')
    if (item === null) {
      setNotice('批注已达上限（32 条）')
      return
    }
    insertChip(item)
    document.getSelection()?.removeAllRanges()
    setFloat(null)
    floatTargetRef.current = null
    setOpen(true)
    setNotice(null)
  }

  const insertChip = (item: AnnotationItemV1): void => {
    const index = draft.items.indexOf(item)
    const { reference, span } = chipInsert(item, index, input.draft.length, input.draftRev)
    actx?.bail(actx, 'slash/input-insert-reference', { reference, span })
  }

  const reattach = (item: AnnotationItemV1): void => {
    insertChip(item)
    registry.setState(sessionId, item.id, 'attached')
    setNotice(null)
  }

  const removeItem = (id: string): void => {
    registry.remove(sessionId, id)
    const occurrence = input.occurrences.find(o => o.source === SOURCE && o.ref === id)
    if (occurrence !== undefined && inputActions !== undefined) {
      inputActions.setDraft(
        input.draft.slice(0, occurrence.offset) + input.draft.slice(occurrence.offset + 1),
      )
    }
    if (editingId === id) setEditingId(null)
  }

  const clearAll = (): void => {
    registry.clear(sessionId)
    const occurrences = input.occurrences.filter(o => o.source === SOURCE)
    if (occurrences.length > 0 && inputActions !== undefined) {
      let next = input.draft
      // Remove from the tail so offsets stay valid.
      for (let i = occurrences.length - 1; i >= 0; i -= 1) {
        const offset = occurrences[i]!.offset
        next = next.slice(0, offset) + next.slice(offset + 1)
      }
      inputActions.setDraft(next)
    }
    setEditingId(null)
  }

  if (draft.items.length === 0) {
    // Still render the overlay seat so pins/highlights never orphan; the bar
    // itself stays hidden.
    return (
      <>
        <div ref={overlayRef} className="dsh-ann2-overlay" data-dsh-annotation-2 />
        {float !== null && (
          <div className="dsh-ann2-floatbar" data-dsh-annotation-2 style={{ left: float.x, top: float.y }}>
            <button type="button" onClick={annotate}>批注</button>
          </div>
        )}
      </>
    )
  }

  return (
    <div data-dsh-annotation-2 className="dsh-ann2-panel">
      <div ref={overlayRef} className="dsh-ann2-overlay" />
      {float !== null && (
        <div className="dsh-ann2-floatbar" style={{ left: float.x, top: float.y }}>
          <button type="button" onClick={annotate}>批注</button>
        </div>
      )}
      <button
        type="button"
        className="dsh-ann2-panel-row"
        data-expanded={open || undefined}
        onClick={() => { setOpen(value => !value) }}
        aria-expanded={open}
      >
        <span className="dsh-ann2-count">{draft.items.length}</span>
        <span>批注</span>
      </button>
      {open && (
        <div className="dsh-ann2-body">
          {notice !== null && <div className="dsh-ann2-moved">{notice}</div>}
          {draft.items.map((item, index) => (
            <AnnotationItemRow
              key={item.id}
              item={item}
              index={index}
              moved={movedIds.has(item.id)}
              locked={locked}
              editing={editingId === item.id}
              chipPresent={input.occurrences.some(o => o.source === SOURCE && o.ref === item.id)}
              onEdit={() => { setEditingId(item.id) }}
              onSave={(note) => {
                registry.update(sessionId, item.id, note.slice(0, MAX_NOTE_LENGTH))
                setEditingId(null)
              }}
              onCancel={() => { setEditingId(null) }}
              onRemove={() => { removeItem(item.id) }}
              onReattach={() => { reattach(item) }}
            />
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="dsh-ann2-btn" onClick={clearAll} disabled={locked}>
              清空批注
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const STATE_LABEL: Record<string, string> = {
  submitted: '已提交，等待确认',
  queued: '已排队',
  failed: '发送失败，可重新附加',
  unknown: '状态未知（队列被修改）',
}

function AnnotationItemRow({ item, index, moved, locked, editing, chipPresent, onEdit, onSave, onCancel, onRemove, onReattach }: {
  item: AnnotationItemV1
  index: number
  moved: boolean
  locked: boolean
  editing: boolean
  chipPresent: boolean
  onEdit: () => void
  onSave: (note: string) => void
  onCancel: () => void
  onRemove: () => void
  onReattach: () => void
}) {
  const [value, setValue] = useState(item.note)
  const stateLabel = item.state === 'attached' ? null : STATE_LABEL[item.state]

  if (editing) {
    return (
      <div className="dsh-ann2-item" data-dsh-annotation-2>
        <span className="dsh-ann2-badge">{index + 1}</span>
        <div>
          <textarea
            className="dsh-ann2-editor"
            value={value}
            rows={3}
            autoFocus
            onChange={event => { setValue(event.target.value) }}
            onKeyDown={(event) => {
              // Enter inserts a newline (native); Cmd/Ctrl+Enter saves; Escape cancels.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                onSave(value)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onCancel()
              }
            }}
          />
          <div className="dsh-ann2-actions">
            <button type="button" className="dsh-ann2-btn" data-primary onClick={() => { onSave(value) }}>
              保存
            </button>
            <button type="button" className="dsh-ann2-btn" onClick={onCancel}>
              取消
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dsh-ann2-item" data-dsh-annotation-2>
      <span className="dsh-ann2-badge">{index + 1}</span>
      <div>
        <div className="dsh-ann2-quote" title={item.target.exact}>{item.target.exact}</div>
        {item.note === ''
          ? <div className="dsh-ann2-note" data-empty>（未填写）</div>
          : <div className="dsh-ann2-note">{item.note}</div>}
        {moved && <div className="dsh-ann2-moved">原文位置已变化（引用和批注仍可发送）</div>}
        {stateLabel !== null && <div className="dsh-ann2-moved">{stateLabel}</div>}
        {!chipPresent && item.state !== 'submitted' && item.state !== 'landed' && (
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button type="button" className="dsh-ann2-btn" data-primary onClick={onReattach} disabled={locked}>
              重新附加
            </button>
          </div>
        )}
      </div>
      <div className="dsh-ann2-toolbar">
        <button type="button" className="dsh-ann2-tool" disabled={locked} onClick={onEdit} title="编辑批注">
          编辑
        </button>
        <button type="button" className="dsh-ann2-tool" disabled={locked} onClick={onRemove} title="删除批注">
          删除
        </button>
      </div>
    </div>
  )
}
