/**
 * Strict versioned envelope carrying one annotation through the native
 * reference channel. The browser codec serializes items into these envelopes
 * (plain text inside the message), and the plugin's Node half splits them out
 * into native context + clean question at `agent/pre-step` time. JSON special
 * characters are escaped so content can never forge a closing tag.
 */

/** One envelope payload (version 1). */
export interface AnnotationEnvelopeV1 {
  readonly version: 1
  /** Global-unique annotation id (also the reference id). */
  readonly id: string
  /** The quoted anchor text. */
  readonly quote: string
  /** The user's note (may be empty). */
  readonly note: string
}

export const ENVELOPE_TAG = 'dsh-annotation-v1'

export const ENVELOPE_OPEN = `<${ENVELOPE_TAG}>`
export const ENVELOPE_CLOSE = `</${ENVELOPE_TAG}>`

/** Per-envelope bounds (mirrors the plugin's local limits). */
export const MAX_QUOTE_CHARS = 8 * 1024
export const MAX_NOTE_CHARS = 4 * 1024
/** At most 32 envelopes in one message. */
export const MAX_ENVELOPES = 32

/** Escape `<` inside JSON so `</dsh-annotation-v1>` can never be forged. */
export function encodeEnvelope(payload: AnnotationEnvelopeV1): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return `${ENVELOPE_OPEN}${json}${ENVELOPE_CLOSE}`
}

/** The model-visible readable text of one envelope (quote + note + id marker). */
export function envelopeReadable(payload: AnnotationEnvelopeV1, index: number): string {
  return [
    `> 引用：${payload.quote}`,
    `批注（第 ${index + 1} 处〔${payload.id}〕）：${payload.note === '' ? '（未填写）' : payload.note}`,
  ].join('\n')
}

/** The collapsed-row summary for one batch. */
export function batchSummary(count: number): string {
  return `${count} 条批注`
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelopes: AnnotationEnvelopeV1[] }
  | { readonly ok: false }

/**
 * Parse every envelope in one message text. Strict: unknown versions,
 * malformed JSON, out-of-bound fields, or an over-long batch fail the WHOLE
 * parse (the caller keeps the message untouched). Never throws.
 */
export function parseEnvelopes(text: string): EnvelopeParseResult {
  const tag = new RegExp(`${ENVELOPE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\S]*?)${ENVELOPE_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
  const envelopes: AnnotationEnvelopeV1[] = []
  let match: RegExpExecArray | null
  let total = 0
  while ((match = tag.exec(text)) !== null) {
    const body = match[1] ?? ''
    if (body.length > 64 * 1024) return { ok: false }
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return { ok: false }
    }
    if (!isEnvelope(payload)) return { ok: false }
    if (envelopes.length >= MAX_ENVELOPES) return { ok: false }
    envelopes.push(payload)
    total += payload.quote.length + payload.note.length
    if (total > MAX_ENVELOPES * (MAX_QUOTE_CHARS + MAX_NOTE_CHARS)) return { ok: false }
  }
  return { ok: true, envelopes }
}

/** Strip every envelope from one message text, leaving the clean question. */
export function stripEnvelopes(text: string): string {
  return text
    .split(ENVELOPE_OPEN)
    .map((segment, index) => {
      if (index === 0) return segment
      const close = segment.indexOf(ENVELOPE_CLOSE)
      return close < 0 ? segment : segment.slice(close + ENVELOPE_CLOSE.length)
    })
    .join('')
}

/** Decode exactly one envelope; null when malformed or absent. */
export function decodeEnvelope(text: string): AnnotationEnvelopeV1 | null {
  const parsed = parseEnvelopes(text)
  if (!parsed.ok || parsed.envelopes.length !== 1) return null
  return parsed.envelopes[0]!
}

function isEnvelope(value: unknown): value is AnnotationEnvelopeV1 {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.length !== 4
    || !keys.includes('version') || !keys.includes('id') || !keys.includes('quote') || !keys.includes('note')) {
    return false
  }
  if (candidate.version !== 1) return false
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 128) return false
  if (typeof candidate.quote !== 'string' || candidate.quote.length === 0 || candidate.quote.length > MAX_QUOTE_CHARS) return false
  if (typeof candidate.note !== 'string' || candidate.note.length > MAX_NOTE_CHARS) return false
  return true
}
