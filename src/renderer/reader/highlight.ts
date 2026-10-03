import type { Word } from '../../shared/types'

export interface TimedRange {
  start: number // absolute AudioContext time
  end: number
  from: number // UTF-16 offsets into the original text
  to: number
  text: string
}

/**
 * Maps engine words onto character ranges of the displayed text and paints the
 * current word using the CSS Custom Highlight API (no DOM rewriting).
 */
export class Highlighter {
  private node: Text
  private cursor = 0
  private ranges: TimedRange[] = []
  private idx = -1

  constructor(
    private container: HTMLElement,
    private scroller: HTMLElement,
    private text: string
  ) {
    container.textContent = text
    this.node = container.firstChild as Text
    CSS.highlights.clear()
  }

  /** Add a chunk's words; `offset` converts chunk-relative times to absolute. */
  addWords(words: Word[], offset: number): void {
    for (const w of words) {
      const token = w.text.trim()
      if (!token) continue
      // Search forward a bounded distance so a misaligned token can't jump far ahead.
      const at = this.text.indexOf(token, this.cursor)
      if (at === -1 || at - this.cursor > 200) continue
      this.cursor = at + token.length
      if (!/[\p{L}\p{N}]/u.test(token)) continue // punctuation: advance, don't highlight
      this.ranges.push({ start: offset + w.start, end: offset + w.end, from: at, to: at + token.length, text: token })
    }
  }

  /** Advance to `time`; returns the newly current word, or null if unchanged. */
  update(time: number): TimedRange | null {
    let i = this.idx
    while (i + 1 < this.ranges.length && this.ranges[i + 1].start <= time) i++
    if (i === this.idx) return null
    this.idx = i
    const r = this.ranges[i]

    const current = new Range()
    current.setStart(this.node, r.from)
    current.setEnd(this.node, r.to)
    const spoken = new Range()
    spoken.setStart(this.node, 0)
    spoken.setEnd(this.node, r.from)
    CSS.highlights.set('current', new Highlight(current))
    CSS.highlights.set('spoken', new Highlight(spoken))
    this.scrollTo(current)
    return r
  }

  private scrollTo(range: Range): void {
    const rect = range.getBoundingClientRect()
    const box = this.scroller.getBoundingClientRect()
    if (rect.top < box.top || rect.bottom > box.bottom) {
      this.scroller.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: 'smooth' })
    }
  }
}
