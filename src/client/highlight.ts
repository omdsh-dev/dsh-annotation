/**
 * CSS Custom Highlight painting + floating pin badges for pending
 * annotations. Repositioning is merged through requestAnimationFrame (no
 * polling, no body observer); the pins live in ONE fixed overlay container
 * rendered by the panel component.
 */

import { resolveInDom } from './anchor.ts'
import type { AnnotationItemV1 } from './types.ts'

export const HIGHLIGHT_STYLE = 'dsh-annotation-2'

export interface HighlightSurface {
  /**
   * Recompute every item's range and repaint highlights + pins. Returns the
   * subset of items whose anchors are currently located (the others are
   * "moved" and rendered without a pin).
   */
  paint(items: readonly AnnotationItemV1[], root: Document): readonly AnnotationItemV1[]
  /** Drop every plugin-owned CSS highlight only (the pins are React-owned children). */
  clearHighlights(): void
  /** Drop every plugin-owned highlight and pin. */
  clear(): void
}

function highlightName(id: string): string {
  return `${HIGHLIGHT_STYLE}:${id}`
}

export function createHighlightSurface(
  overlay: HTMLElement,
  cssHighlights: (typeof CSS)['highlights'] | undefined,
): HighlightSurface {
  const dropHighlights = (): void => {
    if (cssHighlights !== undefined) {
      for (const name of Array.from(cssHighlights.keys())) {
        if (name.startsWith(`${HIGHLIGHT_STYLE}:`)) cssHighlights.delete(name)
      }
    }
  }
  const paint = (items: readonly AnnotationItemV1[], root: Document): readonly AnnotationItemV1[] => {
    const located: AnnotationItemV1[] = []
    const seen = new Set<string>()
    const existing = new Map<string, HTMLElement>()
    for (const child of Array.from(overlay.children)) {
      const id = child.getAttribute('data-ann2-item')
      if (id !== null) existing.set(id, child as HTMLElement)
    }
    items.forEach((item, index) => {
      seen.add(item.id)
      const range = resolveInDom(item.target, root)
      const pin = existing.get(item.id)
      if (range === null) {
        pin?.remove()
        cssHighlights?.delete(highlightName(item.id))
        return
      }
      located.push(item)
      cssHighlights?.set(highlightName(item.id), new Highlight(range))
      const rect = range.getBoundingClientRect()
      if (pin === undefined) {
        const created = root.createElement('div')
        created.className = 'dsh-ann2-pin'
        created.dataset.ann2Item = item.id
        created.textContent = String(index + 1)
        overlay.appendChild(created)
        return
      }
      pin.style.left = `${rect.left + rect.width / 2}px`
      pin.style.top = `${rect.top}px`
      pin.style.display = rect.width === 0 ? 'none' : 'block'
    })
    for (const [id, pin] of existing) {
      if (!seen.has(id)) {
        pin.remove()
        cssHighlights?.delete(highlightName(id))
      }
    }
    return located
  }

  const clear = (): void => {
    dropHighlights()
    overlay.replaceChildren()
  }

  return { paint, clearHighlights: dropHighlights, clear }
}

/** One merged repaint queue (rAF-coalesced; callers just schedule). */
export class RepaintQueue {
  private queued = false

  constructor(
    private readonly surface: HighlightSurface,
    private readonly getItems: () => readonly AnnotationItemV1[],
    private readonly root: Document,
  ) {}

  /** Schedule one repaint; multiple schedules within a frame coalesce. */
  schedule(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.surface.paint(this.getItems(), this.root)
    })
  }
}
