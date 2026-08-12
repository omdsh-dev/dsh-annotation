/**
 * Selection extraction and anchor re-location using ONLY stock 0811 chat
 * attributes (`data-chat-anchor-key` / `data-chat-flow-kind` on every chat
 * node — no DSH modification). Anchors never cross messages: re-location
 * searches only the one message named by the target, in the order 1) same
 * message + same offset still matches the exact text, 2) unique match by
 * exact text plus prefix/suffix within that message, 3) otherwise the anchor
 * is reported as moved.
 */

import type { AnnotationTargetV1 } from './types.ts'
import { boundAnchorContext } from './store.ts'

/** The stock chat-node attribute carrying the stable node key. */
export const ANCHOR_KEY_ATTR = 'data-chat-anchor-key'
/** The stock chat-node attribute carrying the node kind. */
export const KIND_ATTR = 'data-chat-flow-kind'

/** Anchor re-location over the flattened plain text of ONE message. */
export function locateOffsets(plainText: string, target: AnnotationTargetV1): { start: number; end: number } | null {
  // 1) Same message, same position still matches the exact text.
  if (target.end <= plainText.length
    && plainText.slice(target.start, target.end) === target.exact) {
    return { start: target.start, end: target.end }
  }
  // 2) Unique match by exact text + prefix/suffix within this message.
  const candidates: Array<{ start: number; end: number; score: number }> = []
  let from = 0
  while (true) {
    const at = plainText.indexOf(target.exact, from)
    if (at < 0) break
    const before = plainText.slice(Math.max(0, at - target.prefix.length), at)
    const after = plainText.slice(at + target.exact.length, at + target.exact.length + target.suffix.length)
    let score = 0
    if (target.prefix !== '') {
      score += before === target.prefix ? 2 : 0
    }
    if (target.suffix !== '') {
      score += after === target.suffix ? 2 : 0
    }
    candidates.push({ start: at, end: at + target.exact.length, score })
    from = at + 1
  }
  if (candidates.length === 0) return null
  const best = candidates.reduce((current, candidate) => (candidate.score > current.score ? candidate : current))
  if (candidates.length === 1 || best.score > 0) {
    return { start: best.start, end: best.end }
  }
  return null
}

/** Build an anchor target from a DOM selection confined to ONE chat message. */
export function extractTarget(
  selection: { rangeCount: number; getRangeAt(index: number): Range; toString(): string },
  root: Document,
): AnnotationTargetV1 | null {
  if (selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (range.collapsed) return null
  const container = messageContainerOf(range.startContainer, root)
  if (container === null) return null
  if (messageContainerOf(range.endContainer, root) !== container) return null
  const key = container.getAttribute(ANCHOR_KEY_ATTR)
  if (key === null || key === '') return null
  const text = flattenedText(container)
  if (text.nodes.length === 0) return null
  const start = textOffsetOf(text, range.startContainer, range.startOffset)
  const end = textOffsetOf(text, range.endContainer, range.endOffset)
  if (start < 0 || end < start) return null
  const exact = plainTextSlice(text, start, end)
  if (exact === '') return null
  const { prefix, suffix } = boundAnchorContext(
    plainTextSlice(text, Math.max(0, start - 40), start),
    plainTextSlice(text, end, end + 40),
  )
  return { messageId: key, start, end, exact, prefix, suffix }
}

/**
 * The annotatable message element containing `node`, if any. Only assistant
 * nodes are annotatable (streaming rows included — the plugin refuses anchors
 * on running turns through the panel's stream check).
 */
export function messageContainerOf(node: Node, root: Document): HTMLElement | null {
  let current: Node | null = node
  while (current !== null && current !== root) {
    if (current instanceof HTMLElement && current.hasAttribute(ANCHOR_KEY_ATTR)) {
      return current
    }
    current = current.parentNode
  }
  return null
}

/** The chat message element with the given stable node key, if present. */
export function messageElementOf(key: string, root: Document): HTMLElement | null {
  return root.querySelector(`[${ANCHOR_KEY_ATTR}="${cssEscape(key)}"]`)
}

/** Flatten one message's text nodes in document order with cumulative offsets. */
export interface FlattenedText {
  readonly nodes: readonly Text[]
  /** nodes[i] starts at offsets[i] (offsets.length === nodes.length). */
  readonly offsets: readonly number[]
  readonly total: number
}

export function flattenedText(container: Node): FlattenedText {
  const nodes: Text[] = []
  const offsets: number[] = []
  let total = 0
  const owner = container.ownerDocument ?? (container as HTMLElement).ownerDocument
  const walker = owner.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if (node instanceof Text && node.data.length > 0) {
      nodes.push(node)
      offsets.push(total)
      total += node.data.length
    }
    node = walker.nextNode()
  }
  return { nodes, offsets, total }
}

/** Character offset of (node, offset) within one flattened message; -1 when foreign. */
export function textOffsetOf(text: FlattenedText, node: Node, offset: number): number {
  const index = text.nodes.indexOf(node as Text)
  if (index < 0) return -1
  const base = text.offsets[index] ?? 0
  return base + offset
}

/** Plain-text slice of one flattened message. */
export function plainTextSlice(text: FlattenedText, start: number, end: number): string {
  let out = ''
  for (let i = 0; i < text.nodes.length; i += 1) {
    const node = text.nodes[i]!
    const nodeStart = text.offsets[i]!
    const nodeEnd = nodeStart + node.data.length
    if (nodeEnd <= start) continue
    if (nodeStart >= end) break
    const from = Math.max(start, nodeStart) - nodeStart
    const to = Math.min(end, nodeEnd) - nodeStart
    out += node.data.slice(from, to)
  }
  return out
}

/** Resolve a target into a DOM Range inside its message element, or null when moved. */
export function resolveInDom(target: AnnotationTargetV1, root: Document): Range | null {
  const container = messageElementOf(target.messageId, root)
  if (container === null) return null
  const text = flattenedText(container)
  const offsets = locateOffsets(plainTextSlice(text, 0, text.total), target)
  if (offsets === null) return null
  const start = nodeAtOffset(text, offsets.start)
  const end = nodeAtOffset(text, offsets.end)
  if (start === null || end === null) return null
  const range = root.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

/** The (node, offset) pair owning one flattened offset. */
function nodeAtOffset(text: FlattenedText, offset: number): { node: Text; offset: number } | null {
  for (let i = 0; i < text.nodes.length; i += 1) {
    const node = text.nodes[i]!
    const nodeStart = text.offsets[i]!
    if (offset <= nodeStart + node.data.length) {
      return { node, offset: offset - nodeStart }
    }
  }
  return null
}

/** Minimal CSS identifier escaping for attribute selectors. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
