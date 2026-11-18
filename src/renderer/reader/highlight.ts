import type { Word } from '../../shared/types'

export interface TimedRange {
  start: number // seconds from the start of the selection
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
  private checkpoints = new Map<number, { cursor: number; count: number }>()
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

  /** Add a chunk's words on the selection timeline. */
  addWords(seq: number, words: Word[], offset: number): void {
    this.checkpoints.set(seq, { cursor: this.cursor, count: this.ranges.length })
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

  /** Find the last word beginning at or before a position, including after a seek. */
  private indexAt(time: number): number {
    let low = 0
    let high = this.ranges.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.ranges[mid].start <= time) low = mid + 1
      else high = mid
    }
    return low - 1
  }

  wordAt(time: number): TimedRange | undefined {
    const word = this.ranges[this.indexAt(time)]
    return word && time < word.end ? word : undefined
  }

  startForOffset(from: number): number | undefined {
    return this.ranges.find((word) => word.from === from)?.start
  }

  discardFrom(seq: number): void {
    const checkpoint = this.checkpoints.get(seq)
    if (!checkpoint) return
    this.cursor = checkpoint.cursor
    this.ranges.length = checkpoint.count
    this.idx = -1
    CSS.highlights.clear()
    for (const key of this.checkpoints.keys()) if (key >= seq) this.checkpoints.delete(key)
  }

  /** Update the highlight for `time` and return the current word when it changes. */
  update(time: number): TimedRange | null {
    const i = this.indexAt(time)
    if (i === this.idx) return null
    this.idx = i
    if (i < 0) {
      CSS.highlights.clear()
      this.scroller.scrollTop = 0
      return null
    }
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
