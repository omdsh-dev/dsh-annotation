import { describe, expect, it } from 'vitest'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { splitAnnotationMessages, buildContextMessage, PLUGIN_NAME } from '../src/node/index.ts'
import { encodeEnvelope } from '../src/shared/envelope.ts'

function userMessage(text: string, id = 'm-1'): UserMessage {
  return freezeMessage({
    id: id as unknown as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function envelope(id: string, quote = '引用', note = '批注') {
  return encodeEnvelope({ version: 1, id, quote, note })
}

describe('splitAnnotationMessages', () => {
  it('returns null for ordinary messages (pure no-op)', () => {
    const messages = [userMessage('普通问题')]
    expect(splitAnnotationMessages(messages)).toBeNull()
  })

  it('splits a batched message into native context + clean question', () => {
    const message = userMessage(`${envelope('u-1')}\n${envelope('u-2')}\n问题是什么？`)
    const result = splitAnnotationMessages([message])
    expect(result).not.toBeNull()
    const [context, clean] = result!
    expect(context).toBeDefined()
    expect(clean).toBeDefined()
    if (context === undefined || clean === undefined) throw new Error('unreachable')
    // Native collapsed context row: plugin source, notice form, count summary.
    expect(context.source).toMatchObject({ kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: '2 条批注' })
    expect(context.content.map(b => (b.type === 'text' ? b.text : ''))[0]).toContain('〔u-1〕')
    expect(context.content.map(b => (b.type === 'text' ? b.text : ''))[0]).toContain('〔u-2〕')
    // Clean question: original id, content only the question.
    expect(clean.id).toBe(message.id)
    expect(clean.content).toEqual([{ type: 'text', text: '\n\n问题是什么？' }])
  })

  it('a questionless batch produces the context row alone (no empty bubble)', () => {
    const message = userMessage(envelope('u-1'))
    const result = splitAnnotationMessages([message])
    expect(result).toHaveLength(1)
    expect(result![0]!.source).toMatchObject({ kind: 'plugin', form: 'notice' })
  })

  it('keeps non-user messages untouched', () => {
    const tool = freezeMessage({
      id: 't-1' as never,
      role: 'user',
      content: [{ type: 'text', text: '工具结果' }],
      source: { kind: 'tool', callId: 'c1' as never },
    })
    const user = userMessage(`${envelope('u-1')}问题`, 'm-9')
    const result = splitAnnotationMessages([tool, user])
    expect(result).not.toBeNull()
    expect(result![0]).toBe(tool)
    expect(result![1]!.source).toMatchObject({ kind: 'plugin' })
    expect(result![2]!.id).toBe('m-9')
  })

  it('a malformed envelope keeps the WHOLE message original (no partial split)', () => {
    const message = userMessage(`${envelope('u-1')}\n<dsh-annotation-v1>bad</dsh-annotation-v1>\n问题`)
    expect(splitAnnotationMessages([message])).toBeNull()
  })

  it('unknown versions keep the message original', () => {
    const text = `<dsh-annotation-v1>${JSON.stringify({ version: 2, id: 'x', quote: 'q', note: 'n' })}</dsh-annotation-v1>问题`
    expect(splitAnnotationMessages([userMessage(text)])).toBeNull()
  })

  it('never throws on hostile content', () => {
    const hostile = [
      userMessage('<dsh-annotation-v1>'),
      userMessage('</dsh-annotation-v1>'),
      userMessage(`<dsh-annotation-v1>${'x'.repeat(200 * 1024)}</dsh-annotation-v1>`),
      userMessage('<dsh-annotation-v1>' + JSON.stringify({ version: 1, id: 'a', quote: 'q', note: 'n' }).slice(0, 10)),
    ]
    for (const message of hostile) {
      expect(() => splitAnnotationMessages([message])).not.toThrow()
    }
  })

  it('tool continuation batches (tool sources only) never re-inject', () => {
    const tool = freezeMessage({
      id: 't-2' as never,
      role: 'user',
      content: [{ type: 'text', text: '结果' }],
      source: { kind: 'tool', callId: 'c1' as never },
    })
    expect(splitAnnotationMessages([tool])).toBeNull()
  })
})

describe('buildContextMessage', () => {
  it('renders a deterministic context row', () => {
    const context = buildContextMessage('m-1' as never, [
      { version: 1, id: 'u-1', quote: '引用A', note: '批注A' },
    ])
    expect(context.source).toMatchObject({ kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: '1 条批注' })
    expect(context.content.map(b => (b.type === 'text' ? b.text : ''))[0]).toContain('引用A')
    expect(context.content.map(b => (b.type === 'text' ? b.text : ''))[0]).toContain('〔u-1〕')
  })
})
