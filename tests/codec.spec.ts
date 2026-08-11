import { describe, expect, it } from 'vitest'
import { chipInsert, createAnnotationSource, noticeText, SOURCE } from '../src/client/codec.ts'
import { createSessionRegistry } from '../src/client/session-registry.ts'
import { emptyDraft } from '../src/client/store.ts'
import type { AnnotationItemV1 } from '../src/client/types.ts'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

const TARGET = { messageId: '42', start: 0, end: 4, exact: '原文片段', prefix: '前文', suffix: '后文' }

describe('annotation source codec', () => {
  it('serializes pending refs into ONE context part sharing the draft batch id', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const a = registry.add('s', TARGET, '第一处批注')!
    const b = registry.add('s', TARGET, '第二处批注')!
    const source = createAnnotationSource(registry)
    const first = await source.codec!.serialize({ sessionId: 's' as never }, a.id, new AbortController().signal)
    const second = await source.codec!.serialize({ sessionId: 's' as never }, b.id, new AbortController().signal)
    expect(first.kind).toBe('context')
    expect(second.kind).toBe('context')
    if (first.kind !== 'context' || second.kind !== 'context') throw new Error('unreachable')
    expect(first.batchId).toBe(second.batchId)
    expect(first.batchId).toBe(registry.get('s').batchId)
    expect(first.text).toContain('原文片段')
    expect(first.text).toContain('第一处批注')
    expect(second.text).toContain('第二处批注')
  })

  it('clipboard projects to empty (annotation protocol never enters the draft projection)', () => {
    const registry = createSessionRegistry(memoryStorage())
    const source = createAnnotationSource(registry)
    expect(source.codec!.clipboardText('any')).toBe('')
  })

  it('an unknown ref rejects (never silently downgrades)', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const source = createAnnotationSource(registry)
    await expect(
      source.codec!.serialize({ sessionId: 's' as never }, 'missing', new AbortController().signal),
    ).rejects.toThrow(/no longer pending/)
  })

  it('committed retires exactly the sent item; the batch id changes', async () => {
    const registry = createSessionRegistry(memoryStorage())
    registry.add('s', TARGET, 'n1')
    const sent = registry.add('s', TARGET, 'n2')!
    const before = registry.get('s').batchId
    const source = createAnnotationSource(registry)
    source.codec!.committed?.({ sessionId: 's' as never }, sent.id)
    expect(registry.get('s').items.map(i => i.id)).toEqual([expect.not.stringMatching(sent.id)])
    expect(registry.get('s').batchId).not.toBe(before)
  })

  it('committed for an unknown id is a no-op', () => {
    const registry = createSessionRegistry(memoryStorage())
    registry.add('s', TARGET, 'n1')
    const source = createAnnotationSource(registry)
    source.codec!.committed?.({ sessionId: 's' as never }, 'missing')
    expect(registry.get('s').items).toHaveLength(1)
  })
})

describe('chip insertion', () => {
  it('inserts at the draft tail with the current revision; label carries the ordinal', () => {
    const item: AnnotationItemV1 = { id: 'i-1', target: TARGET, note: '' }
    const { reference, span } = chipInsert(item, 0, 12, 7)
    expect(reference).toMatchObject({ source: SOURCE, ref: 'i-1', label: '批注 1', clipboardText: '' })
    expect(span).toEqual({ start: 12, end: 12, draftRev: 7 })
  })
})

describe('notice text', () => {
  it('is readable markdown quoting the anchor and the note; empty notes are explicit', () => {
    const item: AnnotationItemV1 = { id: 'i', target: TARGET, note: '批注内容' }
    const text = noticeText(item, 3)
    expect(text).toContain('> 引用：原文片段')
    expect(text).toContain('第 3 处')
    expect(text).toContain('批注：批注内容')
    expect(noticeText({ ...item, note: '' }, 1)).toContain('（未填写）')
  })
})

describe('registry persistence round-trip', () => {
  it('a session draft survives a registry rebuild (refresh simulation)', () => {
    const storage = memoryStorage()
    const first = createSessionRegistry(storage)
    const item = first.add('sess-x', TARGET, '持久批注')!
    const rebuilt = createSessionRegistry(storage)
    expect(rebuilt.get('sess-x').items).toHaveLength(1)
    expect(rebuilt.get('sess-x').items[0]!.id).toBe(item.id)
    expect(rebuilt.get('sess-x').batchId).toBe(first.get('sess-x').batchId)
  })

  it('clearing removes the persisted key (empty drafts are not stored)', () => {
    const storage = memoryStorage()
    const registry = createSessionRegistry(storage)
    registry.add('s', TARGET, 'x')
    registry.clear('s')
    expect(storage.getItem('dsh-annotation:draft:v1:s')).toBeNull()
    expect(registry.get('s')).toEqual(emptyDraft())
  })
})
