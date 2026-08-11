// @vitest-environment jsdom
/**
 * AnnotationPanel behavior: chip↔item sync (a missing chip is re-inserted
 * through the scoped input event), the collapsible 批注 ×N list, item
 * removal (registry + draft chip), moved-anchor marking, and the empty
 * state hiding the bar while keeping the overlay seat.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AnnotationPanel, type AnnotationPanelProps } from '../src/client/panel.tsx'
import { createSessionRegistry } from '../src/client/session-registry.ts'
import { ensureStyles } from '../src/client/styles.ts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const TARGET = { messageId: '42', start: 0, end: 4, exact: '原文片段', prefix: '', suffix: '' }

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
    items: items.map(item => ({ id: item.id, target: TARGET, note: item.note })),
  }))
  return createSessionRegistry(storage)
}

function renderPanel(
  over: Partial<AnnotationPanelProps> & { inputState?: Parameters<NonNullable<AnnotationPanelProps['useInput']>>[0] } = {},
) {
  const bail = vi.fn()
  const setDraft = vi.fn()
  // Stable snapshot identity per render (useSyncExternalStore contract).
  const input = over.inputState ?? {
    draft: '',
    draftRev: 1,
    phase: 'plain' as const,
    occurrences: [],
  }
  const props: AnnotationPanelProps = {
    sessionId: 's',
    actx: { bail } as unknown as ClientContext,
    registry: seededRegistry([]),
    useInput: (selector) => selector(input as never),
    inputActions: { setDraft, submit: () => {}, addImages: () => false, removeImage: () => {}, pruneImages: () => {} },
    ...over,
  }
  const view = render(<AnnotationPanel {...props} />)
  return { view, bail, setDraft, registry: props.registry }
}

describe('AnnotationPanel', () => {
  it('injects the plugin stylesheet once (hot-reload idempotent)', () => {
    ensureStyles(document)
    ensureStyles(document)
    expect(document.querySelectorAll(`style#${'dsh-annotation-2-style'}`)).toHaveLength(1)
  })

  it('hides the bar with zero items but keeps the overlay seat', () => {
    const { view } = renderPanel()
    expect(view.queryByText('批注')).toBeNull()
    expect(document.querySelector('.dsh-ann2-overlay')).not.toBeNull()
  })

  it('re-inserts a missing chip through the scoped input event and prompts the panel route', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '' }])
    const inputState = {
      draft: '问题',
      draftRev: 3,
      phase: 'plain' as const,
      occurrences: [] as Array<{ source: string; ref: string; offset: number }>,
    }
    const { bail } = renderPanel({
      registry,
      useInput: (selector) => selector(inputState as never),
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

  it('does not re-insert when the chip is already present', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '' }])
    const inputState = {
      draft: '问题￼',
      draftRev: 4,
      phase: 'plain' as const,
      occurrences: [{ source: 'annotation', ref: 'i-1', offset: 2 }],
    }
    const { bail } = renderPanel({
      registry,
      useInput: (selector) => selector(inputState as never),
    })
    expect(bail).not.toHaveBeenCalled()
  })

  it('lists items with ordinals; removing drops the registry item and the draft chip', () => {
    const registry = seededRegistry([
      { id: 'i-1', note: '第一处' },
      { id: 'i-2', note: '' },
    ])
    const inputState = {
      draft: '￼ ￼',
      draftRev: 2,
      phase: 'plain' as const,
      occurrences: [
        { source: 'annotation', ref: 'i-1', offset: 0 },
        { source: 'annotation', ref: 'i-2', offset: 2 },
      ],
    }
    const { view, setDraft } = renderPanel({
      registry,
      useInput: (selector) => selector(inputState as never),
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    expect(view.getByText('第一处')).toBeTruthy()
    expect(view.getByText('（未填写）')).toBeTruthy()
    // Remove the second item: registry + draft chip both go.
    const removeButtons = view.getAllByTitle('删除批注')
    act(() => { fireEvent.click(removeButtons[1]!) })
    expect(registry.get('s').items.map(item => item.id)).toEqual(['i-1'])
    expect(setDraft).toHaveBeenCalledWith('￼ ')
  })

  it('marks an item whose anchor no longer resolves as 原文位置已变化', () => {
    const registry = seededRegistry([{ id: 'i-1', note: '漂移' }])
    const inputState = {
      draft: '￼',
      draftRev: 1,
      phase: 'plain' as const,
      occurrences: [{ source: 'annotation', ref: 'i-1', offset: 0 }],
    }
    const { view } = renderPanel({
      registry,
      useInput: (selector) => selector(inputState as never),
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    // No [data-dsh-assistant-message-id="42"] element exists in jsdom → moved,
    // while the note stays visible (the batch remains sendable).
    expect(view.getByText(/原文位置已变化/)).toBeTruthy()
    expect(view.getByText('漂移')).toBeTruthy()
  })

  it('locks editing while the input is submitting', () => {
    const registry = seededRegistry([{ id: 'i-1', note: 'n' }])
    const inputState = {
      draft: '￼',
      draftRev: 1,
      phase: 'submitting' as const,
      occurrences: [{ source: 'annotation', ref: 'i-1', offset: 0 }],
    }
    const { view } = renderPanel({
      registry,
      useInput: (selector) => selector(inputState as never),
    })
    act(() => { fireEvent.click(view.getByText('批注')) })
    expect((view.getByTitle('删除批注') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByTitle('编辑批注') as HTMLButtonElement).disabled).toBe(true)
  })
})
