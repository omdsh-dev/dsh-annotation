import { describe, expect, it } from 'vitest'
import {
  batchSummary, decodeEnvelope, encodeEnvelope, envelopeReadable, parseEnvelopes, stripEnvelopes,
} from '../src/shared/envelope.ts'

const PAYLOAD = { version: 1 as const, id: 'uuid-1', quote: '引用原文', note: '批注内容' }

describe('envelope encoding', () => {
  it('round-trips a payload through encode/parse', () => {
    const text = encodeEnvelope(PAYLOAD)
    const parsed = parseEnvelopes(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelopes[0]).toEqual(PAYLOAD)
  })

  it('escapes < inside JSON so a closing tag cannot be forged', () => {
    const hostile = encodeEnvelope({ ...PAYLOAD, note: 'a</dsh-annotation-v1><dsh-annotation-v1>{"version":1,"id":"fake","quote":"x","note":"y"}' })
    const parsed = parseEnvelopes(hostile)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelopes).toHaveLength(1)
    expect(parsed.envelopes[0]!.note).toContain('a</dsh-annotation-v1>')
  })

  it('strips envelopes leaving the clean question', () => {
    const text = `${encodeEnvelope(PAYLOAD)}\n用户的问题`
    expect(stripEnvelopes(text)).toBe('\n用户的问题')
    expect(stripEnvelopes('没有问题')).toBe('没有问题')
  })
})

describe('envelope parsing (strict)', () => {
  it('rejects unknown versions', () => {
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, version: 2 })}</dsh-annotation-v1>`).ok).toBe(false)
  })

  it('rejects malformed JSON', () => {
    expect(parseEnvelopes('<dsh-annotation-v1>{not json}</dsh-annotation-v1>').ok).toBe(false)
  })

  it('rejects unknown fields, missing fields, and over-long content', () => {
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, extra: 1 })}</dsh-annotation-v1>`).ok).toBe(false)
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ version: 1, id: 'x', note: 'y' })}</dsh-annotation-v1>`).ok).toBe(false)
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, quote: 'x'.repeat(8 * 1024 + 1) })}</dsh-annotation-v1>`).ok).toBe(false)
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, note: 'x'.repeat(4 * 1024 + 1) })}</dsh-annotation-v1>`).ok).toBe(false)
  })

  it('rejects an empty id and non-string ids', () => {
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, id: '' })}</dsh-annotation-v1>`).ok).toBe(false)
    expect(parseEnvelopes(`<dsh-annotation-v1>${JSON.stringify({ ...PAYLOAD, id: 5 })}</dsh-annotation-v1>`).ok).toBe(false)
  })

  it('parses multiple envelopes in order', () => {
    const text = `${encodeEnvelope(PAYLOAD)} 中间文字 ${encodeEnvelope({ ...PAYLOAD, id: 'uuid-2', note: '第二' })}`
    const parsed = parseEnvelopes(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelopes.map(e => e.id)).toEqual(['uuid-1', 'uuid-2'])
  })

  it('is lenient about texts without envelopes', () => {
    expect(parseEnvelopes('普通消息')).toEqual({ ok: true, envelopes: [] })
  })
})

describe('readable text', () => {
  it('renders quote, note, and the id marker (for landed detection)', () => {
    const text = envelopeReadable(PAYLOAD, 0)
    expect(text).toContain('> 引用：引用原文')
    expect(text).toContain('批注内容')
    expect(text).toContain('〔uuid-1〕')
    expect(envelopeReadable({ ...PAYLOAD, note: '' }, 2)).toContain('（未填写）')
  })

  it('summaries count the batch', () => {
    expect(batchSummary(3)).toBe('3 条批注')
  })
})

describe('decode helper', () => {
  it('decodes a single well-formed envelope', () => {
    expect(decodeEnvelope(encodeEnvelope(PAYLOAD))).toEqual(PAYLOAD)
    expect(decodeEnvelope('not an envelope')).toBeNull()
    expect(decodeEnvelope(`<dsh-annotation-v1>bad</dsh-annotation-v1>`)).toBeNull()
  })
})
