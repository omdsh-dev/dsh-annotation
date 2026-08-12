/**
 * Plugin Node half: registers an `agent/pre-step` listener that splits
 * annotation envelopes out of claimed user messages into native context +
 * clean question. Pure plugin code — no DSH modification. Ordinary messages
 * (no envelopes) pass through untouched; a malformed envelope keeps the whole
 * message as-is; the splitter never throws.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  batchSummary,
  envelopeReadable,
  parseEnvelopes,
  stripEnvelopes,
  type AnnotationEnvelopeV1,
} from '../shared/envelope.ts'

export const PLUGIN_NAME = 'dsh-annotation'

/**
 * Split envelopes out of one claimed message batch. Returns null when no
 * user message carries a valid envelope (caller keeps the batch untouched) —
 * including the case where ANY envelope is malformed (whole message kept).
 */
export function splitAnnotationMessages(messages: readonly UserMessage[]): readonly UserMessage[] | null {
  let changed = false
  const out: UserMessage[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') {
      out.push(message)
      continue
    }
    const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    if (!text.includes('<dsh-annotation-v1>')) {
      out.push(message)
      continue
    }
    const parsed = parseEnvelopes(text)
    if (!parsed.ok || parsed.envelopes.length === 0) {
      // Strict: a damaged envelope keeps the whole message original.
      return null
    }
    const clean = stripEnvelopes(text)
    changed = true
    out.push(buildContextMessage(message.id, parsed.envelopes))
    if (clean.trim() !== '') {
      out.push({ ...message, content: [{ type: 'text', text: clean }] })
    }
  }
  return changed ? out : null
}

/** The native collapsed context row (plugin source, notice form). */
export function buildContextMessage(
  originalId: MessageId,
  envelopes: readonly AnnotationEnvelopeV1[],
): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: envelopes.map((envelope, index) => envelopeReadable(envelope, index)).join('\n\n'),
    }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'notice',
      summary: batchSummary(envelopes.length),
    },
  })
}

/** The plugin body: one `agent/pre-step` listener, ordinary path is a no-op. */
export default {
  name: 'dsh-annotation',
  apply(ctx: { on(event: string, listener: (...args: never[]) => unknown): unknown }): void {
    ctx.on('agent/pre-step', (payload: unknown, next: unknown) => {
      // Run the default chain first (keeps the runtime-context injection etc.),
      // then narrow its messages if they carry annotation envelopes.
      const runNext = next as () => Promise<unknown> | undefined
      return Promise.resolve(typeof runNext === 'function' ? runNext() : undefined)
        .then((decision) => {
          if (decision === null || typeof decision !== 'object') return decision
          const candidate = decision as { kind?: unknown; messages?: readonly UserMessage[] }
          if (candidate.kind !== 'enter' || !Array.isArray(candidate.messages)) return decision
          const split = splitAnnotationMessages(candidate.messages)
          if (split === null) return decision
          return { kind: 'enter', messages: split }
        })
    })
  },
}
