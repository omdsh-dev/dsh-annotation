/**
 * The annotation panel: mounted in the conversation.composer.dock slot
 * (the native band under the composer card). Renders the collapsible
 * 「批注 ×N」 list, the selection float bar (「批注」 button over assistant
 * text), the CSS-Highlight painting with rAF-merged repositioning, and the
 * chip↔item sync (a manually deleted chip is re-inserted and the panel
 * prompts the user to remove it from here instead).
 */

import { useEffect, useRef, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { extractTarget } from './anchor.ts'
import { chipInsert, SOURCE } from './codec.ts'
import { createHighlightSurface, RepaintQueue, type HighlightSurface } from './highlight.ts'
import type { SessionRegistry } from './session-registry.ts'
import type { AnnotationItemV1, AnnotationTargetV1 } from './types.ts'

/** Injected face of the composer.dock entry. */
export interface AnnotationPanelInjected {
  sessionId: string
  /** Session scope (scoped input-mutation events). */
  actx: ClientContext | undefined
  registry: SessionRegistry
}

/** Full component props: framework standard kit + dock owner + injected face. */
export interface AnnotationPanelProps extends AnnotationPanelInjected {
  useInput: <T>(selector: (state: InputState) => T) => T
  inputActions: InputActions | undefined
}

const MAX_NOTE_LENGTH = 4 * 1024

export function AnnotationPanel({
  sessionId, actx, registry, useInput, inputActions,
}: AnnotationPanelProps) {
  const input = useInput(state => state)
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
      const located = queueRef.current === null
        ? surfaceRef.current!.paint(registry.get(sessionId).items, document)
        : surfaceRef.current!.paint(registry.get(sessionId).items, document)
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

  // Chip ↔ item sync: every pending item must own a draft chip. A manually
  // deleted chip is re-inserted and the panel prompts the panel route.
  useEffect(() => {
    if (locked || actx === undefined) return
    const present = new Set(input.occurrences.filter(o => o.source === SOURCE).map(o => o.ref))
    const missing = draft.items.filter(item => !present.has(item.id))
    if (missing.length === 0) return
    for (const item of missing) {
      const index = draft.items.indexOf(item)
      const { reference, span } = chipInsert(item, index, input.draft.length, input.draftRev)
      actx.bail(actx, 'slash/input-insert-reference', { reference, span })
    }
    setNotice(missing.length > 0
      ? `已恢复 ${missing.length} 条被删除的批注引用；如需移除请从批注面板清除`
      : null)
  }, [actx, input.draft, input.draftRev, input.occurrences, input.phase, locked, draft.items])

  // Selection float bar: annotate button over completed assistant text.
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
    const index = draft.items.indexOf(item)
    const { reference, span } = chipInsert(item, index, input.draft.length, input.draftRev)
    actx?.bail(actx, 'slash/input-insert-reference', { reference, span })
    document.getSelection()?.removeAllRanges()
    setFloat(null)
    floatTargetRef.current = null
    setOpen(true)
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
    // Still render the overlay seat so pins/highlights for pending items of
    // OTHER renders never orphan; the bar itself stays hidden.
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
              onEdit={() => { setEditingId(item.id) }}
              onSave={(note) => {
                registry.update(sessionId, item.id, note.slice(0, MAX_NOTE_LENGTH))
                setEditingId(null)
              }}
              onCancel={() => { setEditingId(null) }}
              onRemove={() => { removeItem(item.id) }}
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

function AnnotationItemRow({ item, index, moved, locked, editing, onEdit, onSave, onCancel, onRemove }: {
  item: AnnotationItemV1
  index: number
  moved: boolean
  locked: boolean
  editing: boolean
  onEdit: () => void
  onSave: (note: string) => void
  onCancel: () => void
  onRemove: () => void
}) {
  const [value, setValue] = useState(item.note)

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
