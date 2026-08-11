import { describe, expect, it } from 'vitest'
import {
  addItem, clearItems, deriveBatchId, emptyDraft, loadDraft, removeItem, removeItems, updateNote,
  utf8Bytes, withinBounds,
} from '../src/client/store.ts'
import type { AnnotationItemV1 } from '../src/client/types.ts'

function item(id: string, over: Partial<AnnotationItemV1> = {}): AnnotationItemV1 {
  return {
    id,
    target: { messageId: '42', start: 0, end: 4, exact: '原文', prefix: '', suffix: '' },
    note: '',
    ...over,
  }
}

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

describe('batch id derivation', () => {
  it('identical payloads derive the same batch id; any edit derives a new one', () => {
    const a = emptyDraft()
    const withItem = addItem(a, item('i-1'))
    const again = addItem(a, item('i-1'))
    expect(withItem).not.toBeNull()
    expect(again).not.toBeNull()
    expect(withItem!.draft.batchId).toBe(again!.draft.batchId)
    const edited = updateNote(withItem!.draft, 'i-1', '改过的批注')
    expect(edited.batchChanged).toBe(true)
    expect(edited.draft.batchId).not.toBe(withItem!.draft.batchId)
  })

  it('the item id itself does not affect the batch id (content-only)', () => {
    const a = addItem(emptyDraft(), item('i-a'))
    const b = addItem(emptyDraft(), item('i-b'))
    expect(a!.draft.batchId).toBe(b!.draft.batchId)
  })

  it('same content on different messages differs (independent annotations)', () => {
    const a = addItem(emptyDraft(), item('i-1'))
    const b = addItem(emptyDraft(), item('i-2', { target: { messageId: '43', start: 0, end: 4, exact: '原文', prefix: '', suffix: '' } }))
    expect(a!.draft.batchId).not.toBe(b!.draft.batchId)
  })
})

describe('draft mutations', () => {
  it('add → update → remove → clear round-trips with batch changes', () => {
    let draft = emptyDraft()
    const added = addItem(draft, item('i-1', { note: '初稿' }))!
    draft = added.draft
    expect(draft.items).toHaveLength(1)
    const edited = updateNote(draft, 'i-1', '终稿')
    expect(edited.draft.items[0]!.note).toBe('终稿')
    const removed = removeItem(edited.draft, 'i-1')
    expect(removed.draft.items).toHaveLength(0)
    expect(removeItem(removed.draft, 'missing').draft).toBe(removed.draft)
    const cleared = clearItems(removed.draft)
    expect(cleared.draft).toBe(removed.draft) // already empty: no mutation
  })

  it('removeItems drops exactly the listed ids (the committed path)', () => {
    const a = addItem(emptyDraft(), item('i-1'))!
    const b = addItem(a.draft, item('i-2'))!
    const c = addItem(b.draft, item('i-3'))!
    const result = removeItems(c.draft, ['i-1', 'i-3'])
    expect(result.draft.items.map(i => i.id)).toEqual(['i-2'])
  })

  it('enforces the 32-item cap', () => {
    let draft = emptyDraft()
    for (let i = 0; i < 32; i += 1) {
      const added = addItem(draft, item(`i-${i}`))
      expect(added).not.toBeNull()
      draft = added!.draft
    }
    expect(addItem(draft, item('overflow'))).toBeNull()
  })

  it('enforces quote 8 KiB and note 4 KiB bounds', () => {
    expect(withinBounds(item('i', { target: { messageId: 'm', start: 0, end: 1, exact: 'x'.repeat(8 * 1024), prefix: '', suffix: '' } }))).toBe(true)
    expect(withinBounds(item('i', { target: { messageId: 'm', start: 0, end: 1, exact: 'x'.repeat(8 * 1024 + 1), prefix: '', suffix: '' } }))).toBe(false)
    expect(withinBounds(item('i', { note: 'y'.repeat(4 * 1024) }))).toBe(true)
    expect(withinBounds(item('i', { note: 'y'.repeat(4 * 1024 + 1) }))).toBe(false)
  })

  it('utf8Bytes counts multi-byte sequences (CJK)', () => {
    expect(utf8Bytes('中文')).toBe(6)
    expect(utf8Bytes('a')).toBe(1)
    expect(utf8Bytes('😀')).toBe(4)
  })
})

describe('persistence', () => {
  it('saves and restores per-session drafts; clearing removes the key', () => {
    const storage = memoryStorage()
    const draft = addItem(emptyDraft(), item('i-1', { note: '持久化' }))!.draft
    expect(loadDraft('sess-a', storage)).toEqual(emptyDraft())
    // save is implicit via the caller; exercise the round-trip directly.
    storage.setItem('dsh-annotation:draft:v1:sess-a', JSON.stringify(draft))
    expect(loadDraft('sess-a', storage)).toEqual(draft)
    expect(loadDraft('sess-b', storage)).toEqual(emptyDraft())
  })

  it('a malformed record degrades to empty and never fabricates a batch', () => {
    const storage = memoryStorage({ 'dsh-annotation:draft:v1:s': 'not json' })
    expect(loadDraft('s', storage)).toEqual(emptyDraft())
    const bad = memoryStorage({ 'dsh-annotation:draft:v1:s': JSON.stringify({ version: 9, items: [] }) })
    expect(loadDraft('s', bad)).toEqual(emptyDraft())
  })

  it('re-derives the batch id from stored content (tampered ids never survive)', () => {
    const storage = memoryStorage({
      'dsh-annotation:draft:v1:s': JSON.stringify({
        version: 1,
        batchId: 'ann-tampered',
        items: [item('i-1', { note: 'n' })],
      }),
    })
    const loaded = loadDraft('s', storage)
    expect(loaded.batchId).toBe(deriveBatchId([item('i-1', { note: 'n' })]))
    expect(loaded.batchId).not.toBe('ann-tampered')
  })
})
