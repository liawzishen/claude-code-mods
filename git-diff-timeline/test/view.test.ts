import { describe, expect, test } from 'claude-code/testing'

import { CELL, HEIGHT, branchCard, historyCard } from '../hooks/card'
import type { CardNode } from '../hooks/card'
import {
  ARROW_W,
  SLOT_W,
  centreStart,
  dayLabels,
  formatDate,
  formatTime,
  leadOf,
  resolveStart,
  revealStart,
  slotCenter,
  visibleCount,
} from '../hooks/layout'

const node = (tip: string, role: CardNode['role']): CardNode => ({ role, isWorking: false, tip })

const attr = (svg: string, name: string) => [...svg.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map(m => m[1])

describe('layout', () => {
  test('visibleCount fits whole commit slots on the track, at least two', () => {
    expect(visibleCount(95, 60)).toBe(Math.floor((95 - 2 * ARROW_W) / SLOT_W))
    expect(visibleCount(20, 60)).toBe(2)
    expect(visibleCount(200, 3)).toBe(3)
  })

  test('slots start past the track’s left end, and a short history sits in the middle of the room', () => {
    // 96 columns: room for 10 slots between the ends.
    expect(leadOf(10, 96)).toBe(ARROW_W)
    expect(slotCenter(0, 10, 96)).toBe(ARROW_W + SLOT_W / 2)
    expect(slotCenter(2, 10, 96)).toBe(ARROW_W + 2 * SLOT_W + SLOT_W / 2)
    // Four commits: three slots of room on each side.
    expect(leadOf(4, 96)).toBe(ARROW_W + 3 * SLOT_W)
    expect(slotCenter(3, 4, 96) + slotCenter(0, 4, 96)).toBe(96)
  })

  test('the window follows the newest unless moved', () => {
    expect(resolveStart(-1, 5, 12)).toBe(7)
    expect(resolveStart(99, 5, 12)).toBe(7)
    expect(resolveStart(2, 5, 12)).toBe(2)
    expect(resolveStart(-1, 5, 3)).toBe(0)
  })

  test('the wheel’s window centres the pick, or its newer end when too wide, and follows the newest at the end', () => {
    expect(centreStart(5, 6, 5, 20)).toBe(4)
    expect(centreStart(0, 9, 5, 20)).toBe(5)
    expect(centreStart(-1, 0, 5, 20)).toBe(0)
    expect(centreStart(18, 19, 5, 20)).toBe(-1)
  })

  test('the window stays while the pick is in view, else centres on it, or on its newer end when too wide', () => {
    // In view: nothing moves; the newest window keeps following the newest.
    expect(revealStart(-1, 9, 10, 5, 12)).toBe(-1)
    expect(revealStart(3, 4, 6, 5, 12)).toBe(3)
    // Out of view: centred.
    expect(revealStart(-1, 3, 4, 5, 12)).toBe(2)
    expect(revealStart(0, 7, 8, 5, 20)).toBe(6)
    // Wider than the window: the newer end at the right.
    expect(revealStart(-1, 0, 9, 5, 12)).toBe(5)
    // Before the oldest commit counts as the oldest; centred near the end, it is the newest window.
    expect(revealStart(5, -1, 0, 5, 12)).toBe(0)
    expect(revealStart(0, 10, 11, 5, 12)).toBe(-1)
  })

  test('a dot reads as its day where the day changes, else as its time, and the working tree as Now', () => {
    const at = (day: number, h: number, m: number) => Math.floor(new Date(2026, 6, day, h, m).getTime() / 1000)

    expect(dayLabels([at(3, 9, 0), at(4, 9, 5), at(4, 21, 47), at(5, 1, 0), null])).toEqual([
      'Jul 3',
      'Jul 4',
      '9:47 PM',
      'Jul 5',
      'Now',
    ])
  })

  test('dates and times', () => {
    const seconds = (h: number, m: number) => Math.floor(new Date(2026, 3, 3, h, m).getTime() / 1000)

    expect(formatDate(seconds(14, 40))).toBe('Apr 3, 2026')
    expect(formatTime(seconds(14, 40))).toBe('02:40 PM')
    expect(formatTime(seconds(0, 5))).toBe('12:05 AM')
  })
})

describe('the history card', () => {
  const nodes = [node('Jul 2', 'outside'), node('Jul 3', 'base'), node('Jul 4', 'compare')]
  const stats = { files: '4 files changed', added: '+172', deleted: '−35' }
  const range = { from: 'a3e3a24', to: 'b5d4801' }
  const svg = historyCard({ columns: 95, nodes, title: 'main · 3 commits', range, stats, older: 2, newer: 0 })

  test('is one svg as wide as the band, each dot over its slot: where its label sits under the card', () => {
    const centres = [...svg.matchAll(/data-node="(\d+)" cx="([\d.]+)"/g)].map(m => Number(m[2]))

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(attr(svg, 'viewBox')[0]).toBe(`0 0 ${95 * CELL} ${HEIGHT}`)
    expect(centres).toEqual(nodes.map((_, i) => slotCenter(i, 3, 95) * CELL))
  })

  test('marks the compared pair, and says what is beyond the window, and nothing else in the corners', () => {
    expect(attr(svg, 'data-role')).toEqual(['outside', 'base', 'compare'])
    expect(svg).toContain('4 files changed')
    expect(svg).toContain('+172')
    expect(svg).toContain('2 older')
    expect(svg).not.toContain('newer')
    // The title is for a reader that cannot see the card: the Branch list above names the branch.
    expect(svg).not.toContain('>main · 3 commits<')
    expect(svg).toContain('aria-label="main · 3 commits: a3e3a24 to b5d4801"')
  })

  test('the pill names both ends and the totals, and keeps the totals when the card is narrow', () => {
    expect(svg).toContain('>a3e3a24</tspan>')
    expect(svg).toContain('>b5d4801</tspan>')

    const narrow = historyCard({ columns: 30, nodes: nodes.slice(1), title: 'main · 3 commits', range, stats, older: 0, newer: 0 })

    expect(narrow).toContain('+172')
    expect(narrow).toContain('−35')
    expect(narrow).not.toContain('4 files changed')
  })

  test('is light, and dark where the app is', () => {
    expect(svg).toContain('@media (prefers-color-scheme: dark)')
    expect(svg).toMatch(/class="f-ink" fill="#[0-9a-f]{6}"/)
  })

  test('draws no words under the dots, and no bars over the track: the labels under the card are the buttons', () => {
    // The pill's text (its words in tspans) and the corner's: nothing at the dots.
    expect([...svg.matchAll(/<text[^>]*>([^<]*)/g)].map(m => m[1])).toEqual(['', '2 older'])
    expect(svg).not.toContain('data-bar')
  })

  test('a pick that starts out of view runs from the track’s start', () => {
    const pick = historyCard({
      columns: 95,
      nodes: [node('Jul 3', 'between'), node('Jul 4', 'compare')],
      title: 'main',
      range,
      stats,
      older: 4,
      newer: 0,
    })
    const x = /data-span="pick" x="([\d.]+)"/.exec(pick)?.[1]

    expect(Number(x)).toBeLessThan(slotCenter(0, 2, 95) * CELL)
    expect(Number(x)).toBeLessThan(ARROW_W * CELL)
  })

  test('says how many commits are beyond the window on each side', () => {
    const both = historyCard({ columns: 120, nodes, title: 'main', range, stats, older: 20, newer: 31 })

    expect(both).toContain('20 older')
    expect(both).toContain('31 newer')
  })

  test('escapes text', () => {
    const odd = historyCard({ columns: 60, nodes, title: 'a<b & c', range, stats: null, older: 0, newer: 0 })

    expect(odd).toContain('a&lt;b &amp; c')
    expect(odd).toContain('reading the diff')
  })
})

describe('the branch card', () => {
  test('shows both branches, how far apart they are, and a dot per commit on each side', () => {
    const svg = branchCard({
      columns: 95,
      base: 'origin/main',
      compare: 'farm-360-tour',
      ahead: 9,
      behind: 5,
      aheadTips: Array.from({ length: 9 }, (_, i) => `a${i}`),
      behindTips: Array.from({ length: 5 }, (_, i) => `b${i}`),
      mergeBase: 'merge base · Jul 13',
      stats: { files: '9 files changed', added: '+1,057', deleted: '−57' },
    })

    expect(svg).toContain('9 ahead')
    expect(svg).toContain('5 behind')
    expect(svg).toContain('origin/main')
    expect(svg).toContain('farm-360-tour')
    expect(attr(svg, 'data-side').filter(side => side === 'ahead')).toHaveLength(9)
    expect(attr(svg, 'data-side').filter(side => side === 'behind')).toHaveLength(5)
  })

  test('draws at most a dozen dots a side and says how many more', () => {
    const svg = branchCard({
      columns: 95,
      base: 'main',
      compare: 'big',
      ahead: 58,
      behind: 0,
      aheadTips: Array.from({ length: 30 }, (_, i) => `a${i}`),
      behindTips: [],
      mergeBase: '',
      stats: null,
    })

    expect(attr(svg, 'data-side').filter(side => side === 'ahead')).toHaveLength(12)
    expect(svg).toContain('+46 more')
  })
})
