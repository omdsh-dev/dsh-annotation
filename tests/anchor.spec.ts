import { describe, expect, it } from 'vitest'
import { locateOffsets } from '../src/client/anchor.ts'
import type { AnnotationTargetV1 } from '../src/client/types.ts'

const TEXT = '第一段文字。第二段文字。第三段还是文字。'

function target(over: Partial<AnnotationTargetV1> = {}): AnnotationTargetV1 {
  return { messageId: '42', start: 0, end: 4, exact: '第一段', prefix: '', suffix: '', ...over }
}

describe('locateOffsets', () => {
  it('same message + same offset still matching the exact text wins', () => {
    const at = TEXT.indexOf('第二段')
    expect(locateOffsets(TEXT, target({ start: at, end: at + 3, exact: '第二段' }))).toEqual({ start: at, end: at + 3 })
  })

  it('same offset no longer matching falls back to a unique text match', () => {
    const at = TEXT.indexOf('第三段')
    expect(locateOffsets(TEXT, target({ start: 0, end: 3, exact: '第三段' }))).toEqual({ start: at, end: at + 3 })
  })

  it('duplicated text resolves uniquely with prefix/suffix context', () => {
    const first = TEXT.indexOf('文字')
    const second = TEXT.indexOf('文字', first + 1)
    // Both matches score 0 on exact alone; prefix disambiguates the first.
    const withPrefix = target({ start: 0, end: 2, exact: '文字', prefix: '第一段' })
    expect(locateOffsets(TEXT, withPrefix)).toEqual({ start: first, end: first + 2 })
    // Suffix disambiguates a match whose prefix is ambiguous but suffix is not.
    const withSuffix = target({ start: 0, end: 2, exact: '文字', suffix: '。第三' })
    expect(locateOffsets(TEXT, withSuffix)).toEqual({ start: second, end: second + 2 })
  })

  it('ambiguous duplicated text without context resolves to null (moved)', () => {
    expect(locateOffsets(TEXT, target({ start: 0, end: 2, exact: '文字' }))).toBeNull()
  })

  it('missing text resolves to null (moved)', () => {
    expect(locateOffsets(TEXT, target({ exact: '不存在的原文' }))).toBeNull()
  })

  it('never searches another message: only the one text is consulted', () => {
    // The target names message 42; locateOffsets receives ONLY that message's text.
    expect(locateOffsets('别的消息', target({ exact: '第一段' }))).toBeNull()
  })

  it('overlapping repeated patterns resolve with the best context score', () => {
    const text = 'aaaa'
    expect(locateOffsets(text, target({ start: 0, end: 2, exact: 'aa', prefix: 'a' }))).toEqual({ start: 0, end: 2 })
  })
})
