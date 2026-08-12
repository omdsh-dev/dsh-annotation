import { describe, expect, it } from 'vitest'
import { chipInsert, createAnnotationSource, SOURCE } from '../src/client/codec.ts'
import { createSessionRegistry } from '../src/client/session-registry.ts'
import { ENVELOPE_OPEN, ENVELOPE_CLOSE, parseEnvelopes } from '../src/shared/envelope.ts'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

const TARGET = { messageId: 'k-42', start: 0, end: 4, exact: '原文片段', prefix: '前文', suffix: '后文' }

describe('annotation source codec (stock 0811 signature)', () => {
  it('serializes a pending ref into ONE strict envelope via the global id index', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const item = registry.add('s', TARGET, '第一处批注')!
    const source = createAnnotationSource(registry)
    const text = await source.codec!.serialize(item.id, new AbortController().signal)
    expect(text.startsWith(ENVELOPE_OPEN)).toBe(true)
    expect(text.endsWith(ENVELOPE_CLOSE)).toBe(true)
    const parsed = parseEnvelopes(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelopes[0]).toMatchObject({ version: 1, id: item.id, quote: '原文片段', note: '第一处批注' })
  })

  it('clipboard projects to empty (envelope protocol never enters copy projections)', () => {
    const registry = createSessionRegistry(memoryStorage())
    const source = createAnnotationSource(registry)
    expect(source.codec!.clipboardText('any')).toBe('')
  })

  it('an unknown ref rejects (never silently fabricates an envelope)', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const source = createAnnotationSource(registry)
    await expect(source.codec!.serialize('missing', new AbortController().signal)).rejects.toThrow(/no longer pending/)
  })

  it('an aborted signal rejects the serialization', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const item = registry.add('s', TARGET, 'n')!
    const source = createAnnotationSource(registry)
    const controller = new AbortController()
    controller.abort()
    await expect(source.codec!.serialize(item.id, controller.signal)).rejects.toThrow()
  })

  it('items removed from any session resolve nowhere (global index stays consistent)', async () => {
    const registry = createSessionRegistry(memoryStorage())
    const item = registry.add('s', TARGET, 'n')!
    registry.remove('s', item.id)
    const source = createAnnotationSource(registry)
    await expect(source.codec!.serialize(item.id, new AbortController().signal)).rejects.toThrow(/no longer pending/)
  })
})

describe('chip insertion', () => {
  it('inserts at the draft tail with the current revision; label carries the ordinal', () => {
    const item = registryItem('i-1')
    const { reference, span } = chipInsert(item, 0, 12, 7)
    expect(reference).toMatchObject({ source: SOURCE, ref: 'i-1', label: '批注 1', clipboardText: '' })
    expect(span).toEqual({ start: 12, end: 12, draftRev: 7 })
  })
})

describe('registry lifecycle', () => {
  it('states transition through the registry; fingerprint tracks the chip set', () => {
    const registry = createSessionRegistry(memoryStorage())
    const item = registry.add('s', TARGET, 'n')!
    expect(registry.get('s').items[0]!.state).toBe('attached')
    registry.setState('s', item.id, 'submitted')
    expect(registry.get('s').items[0]!.state).toBe('submitted')
    registry.setState('s', item.id, 'failed')
    expect(registry.get('s').items[0]!.state).toBe('failed')
    const fp1 = registry.fingerprint('s')
    registry.add('s', TARGET, 'n2')
    expect(registry.fingerprint('s')).not.toBe(fp1)
  })

  it('shouldRebuildChips matches only an unchanged item set', () => {
    const registry = createSessionRegistry(memoryStorage())
    registry.add('s', TARGET, 'n')
    registry.setFingerprint('s', registry.fingerprint('s'))
    expect(registry.shouldRebuildChips('s')).toBe(true)
    registry.add('s', TARGET, 'n2')
    expect(registry.shouldRebuildChips('s')).toBe(false)
  })

  it('removeItems drops exactly the listed ids (the landed-cleanup path)', () => {
    const registry = createSessionRegistry(memoryStorage())
    registry.add('s', TARGET, 'a')
    registry.add('s', TARGET, 'b')
    registry.add('s', TARGET, 'c')
    const ids = registry.get('s').items.map(i => i.id)
    registry.removeItems('s', [ids[0]!, ids[2]!])
    expect(registry.get('s').items.map(i => i.id)).toEqual([ids[1]])
  })
})

function registryItem(id: string) {
  return { id, target: TARGET, note: '', state: 'attached' as const }
}
