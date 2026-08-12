// @vitest-environment jsdom
/**
 * AnnotationPanel behavior (pure-plugin version): NO auto chip re-insertion,
 * manual 重新附加, lifecycle observation (chip vanish → submitted, restore →
 * failed), landed cleanup from the native context rows, the collapsible
 * 批注 ×N list, item removal, moved-anchor marking, and the empty state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ClientContext, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { AnnotationPanel, type AnnotationPanelProps } from '../src/client/panel.tsx'
import { createSessionRegistry } from '../src/client/session-registry.ts'
import { ensureStyles } from '../src/client/styles.ts'
import { encodeEnvelope } from '../src/shared/envelope.ts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const TARGET = { messageId: 'k-42', start: 0, end: 4, exact: '原文片段', prefix: '', suffix: '' }

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

/** Direct-seeded registry with stable item ids (the production path mints uuids). */
function seededRegistry(items: Array<{ id: string; note: string }>) {
  const storage = memoryStorage()
  storage.setItem('dsh-annotation:draft:v1:s', JSON.stringify({
    version: 1,
    batchId: 'ann-seed',
    items: items.map(item => ({ id: item.id, target: TARGET, note: item.note, state: 'attached' })),
  }))
  return createSessionRegistry(storage)
}

function emptySession(): ConversationSnapshot {
  return {
    sessionId: 's',
    views: [],
    chat: { order: [], nodes: new Map() } as unknown as ConversationSnapshot['chat'],
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
  } as unknown as ConversationSnapshot
}

/** A session whose history already carries native context rows with id markers. */
function landedSession(ids: string[]): ConversationSnapshot {
  const session = emptySession()
  const body = ids.map(id => `批注（〔${id}〕）：n`).join('\n')
  ;(session.chat.nodes as unknown as Map<string, { data: { content: unknown[] } }>).set('ctx-1', {
    data: { content: [{ type: 'text', text: body }] },
  })
  return session
}

type InputStateShape = {
  draft: string
  draftRev: number
  phase: 'plain' | 'submitting'
  occurrences: Array<{ source: string; ref: string; offset: number }>
}

function renderPanel(over: {
  registry?: ReturnType<typeof seededRegistry>
  inputState?: InputStateShape
  session?: ConversationSnapshot
} = {}) {
  const bail = vi.fn()
  const setDraft = vi.fn()
  const input: InputStateShape = over.inputState ?? {
    draft: '',
    draftRev: 1,
    phase: 'plain',
    occurrences: [],
  }
  const props = {
    sessionId: 's',
    actx: { bail } as unknown as ClientContext,
    registry: over.registry ?? seededRegistry([]),
    session: over.session ?? emptySession(),
    useInput: (selector: (state: InputStateShape) => unknown) => selector(input),
    inputActions: { setDraft },
  } as unknown as AnnotationPanelProps
  const view = render(<AnnotationPanel {...props} />)
  return { view, bail, setDraft, registry: props.registry }
}

describe('AnnotationPanel (pure plugin)', () => {
  it('injects the plugin stylesheet once (hot-reload idempotent)', () => {
    ensureStyles(document)
    ensureStyles(document)
    expect(document.querySelectorAll('style#dsh-annotation-2-style')).toHaveLength(1)
  })

  it('hides the bar with zero items but keeps the overlay seat', () => {
    const { view } = renderPanel()
    expect(view.queryByText('批注')).toBeNull()
    expect(document.querySelector('.dsh-ann2-overlay')).not.toBeNull()
  })

  it('does NOT auto re-insert missing chips (user re-attaches manually)', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '' }])
    const { bail } = renderPanel({
      registry,
      inputState: { draft: '问题', draftRev: 3, phase: 'plain', occurrences: [] },
    })
    expect(bail).not.toHaveBeenCalled()
  })

  it('rebuilds chips on refresh only when the draft fingerprint still matches', () => {
    const storage = memoryStorage()
    storage.setItem('dsh-annotation:draft:v1:s', JSON.stringify({
      version: 1,
      batchId: 'x',
      items: [{ id: 'i-1', target: TARGET, note: '', state: 'attached' }],
    }))
    const registry = createSessionRegistry(storage)
    registry.setFingerprint('s', registry.fingerprint('s'))
    const { bail } = renderPanel({
      registry,
      inputState: { draft: '问题', draftRev: 3, phase: 'plain', occurrences: [] },
    })
    expect(bail).toHaveBeenCalledWith(
      expect.anything(),
      'slash/input-insert-reference',
      expect.objectContaining({
        reference: expect.objectContaining({ source: 'annotation', ref: 'i-1', clipboardText: '' }),
        span: { start: 2, end: 2, draftRev: 3 },
      }),
    )
  })

  it('does not rebuild when the fingerprint no longer matches', () => {
    const storage = memoryStorage()
    storage.setItem('dsh-annotation:draft:v1:s', JSON.stringify({
      version: 1,
      batchId: 'x',
      items: [{ id: 'i-1', target: TARGET, note: '', state: 'attached' }],
    }))
    const registry = createSessionRegistry(storage)
    registry.setFingerprint('s', 'stale-fingerprint')
    const { bail } = renderPanel({
      registry,
      inputState: { draft: '问题', draftRev: 3, phase: 'plain', occurrences: [] },
    })
    expect(bail).not.toHaveBeenCalled()
  })

  it('offers 重新附加 for a chip-less item and restores the attached state', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '第一处' }])
    const { view, bail } = renderPanel({
      registry,
      inputState: { draft: '问题', draftRev: 3, phase: 'plain', occurrences: [] },
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    const reattach = view.getByText('重新附加')
    expect(reattach).toBeTruthy()
    act(() => { fireEvent.click(reattach) })
    expect(bail).toHaveBeenCalledWith(
      expect.anything(),
      'slash/input-insert-reference',
      expect.objectContaining({ reference: expect.objectContaining({ ref: 'i-1' }) }),
    )
    expect(registry.get('s').items[0]!.state).toBe('attached')
  })

  it('lists items with ordinals; removing drops the registry item and the draft chip', () => {
    const registry = seededRegistry([
      { id: 'i-1', note: '第一处' },
      { id: 'i-2', note: '' },
    ])
    const { view, setDraft } = renderPanel({
      registry,
      inputState: {
        draft: '￼ ￼',
        draftRev: 2,
        phase: 'plain',
        occurrences: [
          { source: 'annotation', ref: 'i-1', offset: 0 },
          { source: 'annotation', ref: 'i-2', offset: 2 },
        ],
      },
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    expect(view.getByText('第一处')).toBeTruthy()
    expect(view.getByText('（未填写）')).toBeTruthy()
    const removeButtons = view.getAllByTitle('删除批注')
    act(() => { fireEvent.click(removeButtons[1]!) })
    expect(registry.get('s').items.map(item => item.id)).toEqual(['i-1'])
    expect(setDraft).toHaveBeenCalledWith('￼ ')
  })

  it('marks an item whose anchor no longer resolves as 原文位置已变化', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '漂移' }])
    const { view } = renderPanel({
      registry,
      inputState: { draft: '￼', draftRev: 1, phase: 'plain', occurrences: [{ source: 'annotation', ref: 'i-1', offset: 0 }] },
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    expect(view.getByText(/原文位置已变化/)).toBeTruthy()
    expect(view.getByText('漂移')).toBeTruthy()
  })

  it('clears items once the history carries their native context rows (landed)', () => {
    const registry = seededRegistry([{ id: 'i-1', note: 'n' }])
    const { view } = renderPanel({
      registry,
      session: landedSession(['i-1']),
      inputState: { draft: '￼', draftRev: 1, phase: 'plain', occurrences: [{ source: 'annotation', ref: 'i-1', offset: 0 }] },
    })
    expect(view.queryByText('批注')).toBeNull()
    expect(registry.get('s').items).toHaveLength(0)
  })

  it('locks editing while the input is submitting', () => {
    const registry = seededRegistry([{ id: 'i-1', note: 'n' }])
    const { view } = renderPanel({
      registry,
      inputState: { draft: '￼', draftRev: 1, phase: 'submitting', occurrences: [{ source: 'annotation', ref: 'i-1', offset: 0 }] },
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    expect((view.getByTitle('删除批注') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByTitle('编辑批注') as HTMLButtonElement).disabled).toBe(true)
  })
})
