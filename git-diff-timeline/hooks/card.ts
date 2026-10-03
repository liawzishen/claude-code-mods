import { slotCenter } from './layout'

/**
 * The cards the desktop draws as one Svg each. Minimal, with a few physical cues lit from
 * above: a raised card, the commits on a recessed track, the compared span a lit bar in
 * that track with a raised knob at each end, and a summary pill on top. The colours are
 * the app's own; the card is light, and dark where the app is (a media query inside the
 * Svg). Units are tenths of a cell, so a knob drawn at a slot's centre sits over the
 * commit button in that slot below the card.
 */

/** viewBox units per cell: a card is `columns * CELL` wide. */
export const CELL = 10

/** viewBox units down: both cards are this tall. */
export const HEIGHT = 156

const PILL_Y = 28
const PILL_H = 32
const PILL_SIZE = 16
const PILL_PAD = 16
const SIDE_SIZE = 14
const LABEL_SIZE = 15
/** Track ends, from the card's sides. */
const EDGE = 20
const TRACK_Y = 106
const TRACK_H = 12
const SPAN_H = 8
const KNOB_R = 10
const BAR_BASE = 92
const BAR_MAX = 30
const BAR_W = 8
const LABEL_Y = 138
const RAIL_Y = 70
const BASE_Y = 110
const MAX_DOTS = 12

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** The colour of each role on a light card: what the attributes paint. */
const LIGHT = {
  surface: '#ffffff',
  surfaceLow: '#faf9f6',
  pill: '#ffffff',
  edge: '#e4e2db',
  ink: '#1f1e1d',
  soft: '#5e5d59',
  muted: '#6b6a64',
  groove: '#ebe9e3',
  grooveTop: '#d3cfc6',
  dot: '#7f7c73',
  bar: '#d9d5cb',
  knob: '#ffffff',
  knobLow: '#ecebe5',
  stop: '#ffffff',
  barLit: '#ebb4a1',
  accent: '#d77757',
  accentHigh: '#e99a7e',
  added: '#2c7a39',
  deleted: '#ab2b3f',
} as const

type Tone = keyof typeof LIGHT

/** The same roles on a dark card: what the media query paints. */
const DARK: Record<Tone, string> = {
  surface: '#363532',
  surfaceLow: '#2d2c29',
  pill: '#42413d',
  edge: '#4d4b47',
  ink: '#f4f3ee',
  soft: '#c4c2b9',
  muted: '#a3a199',
  groove: '#211f1d',
  grooveTop: '#141312',
  dot: '#8f8c83',
  bar: '#4d4b46',
  knob: '#f4f3ee',
  knobLow: '#d3d0c7',
  stop: '#fbefe9',
  barLit: '#b9654a',
  accent: '#d77757',
  accentHigh: '#e7917a',
  added: '#4eba65',
  deleted: '#ff6b80',
}

const DARK_RULES = (Object.keys(DARK) as Tone[])
  .map(tone => `.f-${tone}{fill:${DARK[tone]}}.s-${tone}{stroke:${DARK[tone]}}.c-${tone}{stop-color:${DARK[tone]}}`)
  .join('')

export type CardNode = {
  /** Under the knob or dot: `Jul 4`, `Now`. */
  label: string
  /** Lines changed: the height of its bar over the track. */
  churn: number
  role: 'outside' | 'base' | 'between' | 'compare'
  isWorking: boolean
  /** What the dot is, for a reader that hovers or cannot see it. */
  tip: string
}

export type CardStats = { files: string; added: string; deleted: string } | null

/** Where the window sits in the history loaded, as nodes counted from the oldest. */
export type CardOverview = {
  total: number
  /** The window's first and last node. */
  first: number
  last: number
  /** The compared pair. */
  pickFrom: number
  pickTo: number
  /** True when git holds older commits than are loaded. */
  more: boolean
}

export type HistoryCardInput = {
  /** The band's width in cells: the card spans it. */
  columns: number
  /** The commits in view, oldest first, one per slot. */
  nodes: CardNode[]
  title: string
  /** The two ends compared, as the pill names them: a short sha, `#123`, `Now`. */
  range: { from: string; to: string }
  stats: CardStats
  /** Commits beyond the view on each side. */
  older: number
  newer: number
  /** When given, a small scroll bar in the top right tells where the window sits. */
  overview?: CardOverview
}

export type BranchCardInput = {
  columns: number
  base: string
  compare: string
  ahead: number
  behind: number
  /** Titles of each side's commits, oldest first. */
  aheadTips: string[]
  behindTips: string[]
  /** Under the fork: `merge base · Jul 13`; '' when the branches share no history. */
  mergeBase: string
  stats: CardStats
}

/** A run of the pill's text: its words, its colour, and the gap before it. */
type Span = { text: string; tone: Tone; gap?: number; isMono?: boolean; isBold?: boolean }

const r = (n: number) => Math.round(n * 10) / 10

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Paints with a tone: the light colour as the attribute, a class the dark rules restyle. */
const fillOf = (tone: Tone) => ` class="f-${tone}" fill="${LIGHT[tone]}"`

const strokeOf = (tone: Tone) => ` class="s-${tone}" stroke="${LIGHT[tone]}"`

const fillAndStroke = (fill: Tone, stroke: Tone) =>
  ` class="f-${fill} s-${stroke}" fill="${LIGHT[fill]}" stroke="${LIGHT[stroke]}"`

const stopOf = (offset: number, tone: Tone) => `<stop offset="${offset}" class="c-${tone}" stop-color="${LIGHT[tone]}"/>`

/** About how wide `text` draws at `size` units: on the wide side, so a pill around it fits. */
const widthOf = (text: string, size: number, isMono = false) =>
  [...text].reduce((sum, ch) => {
    if (isMono) {
      return sum + size * 0.62
    }

    const em = ch === ' ' ? 0.3 : /[.,:;·'|il]/.test(ch) ? 0.32 : /[→…—]/.test(ch) ? 1 : /[A-Z0-9+−%#@mw]/.test(ch) ? 0.66 : 0.55

    return sum + size * em
  }, 0)

const spansWidth = (spans: readonly Span[], size: number) =>
  spans.reduce((sum, span) => sum + (span.gap ?? 0) + widthOf(span.text, size, span.isMono) * (span.isBold ? 1.1 : 1), 0)

const tspan = (span: Span) =>
  `<tspan${span.gap ? ` dx="${span.gap}"` : ''}${span.isMono ? ` font-family="${MONO}"` : ''}${span.isBold ? ' font-weight="600"' : ''}${fillOf(span.tone)}>${esc(span.text)}</tspan>`

/** Groups of spans, a dot between each two. */
const joined = (...groups: Span[][]): Span[] =>
  groups
    .filter(group => group.length > 0)
    .flatMap((group, i) =>
      i === 0 ? group : [{ text: '·', tone: 'muted', gap: 9 }, { ...group[0]!, gap: 9 }, ...group.slice(1)],
    )

/** The totals: `4 files changed +172 −35`, or that they are on their way. */
const statSpans = (stats: CardStats, withFiles: boolean): Span[] =>
  stats === null
    ? [{ text: 'reading the diff…', tone: 'muted' }]
    : [
        ...(withFiles ? [{ text: stats.files, tone: 'soft' as const }] : []),
        { text: stats.added, tone: 'added', gap: withFiles ? 10 : 0 },
        { text: stats.deleted, tone: 'deleted', gap: 7 },
      ]

/** The summary in a raised capsule at the card's top centre: the first choice that fits `room`. */
const pillOf = (center: number, room: number, choices: Span[][]) => {
  const spans = choices.find(choice => spansWidth(choice, PILL_SIZE) + 2 * PILL_PAD <= room) ?? choices.at(-1) ?? []
  const width = spansWidth(spans, PILL_SIZE) + 2 * PILL_PAD

  return {
    width,
    svg:
      `<rect x="${r(center - width / 2)}" y="${PILL_Y - PILL_H / 2}" width="${r(width)}" height="${PILL_H}" rx="${PILL_H / 2}"${fillAndStroke('pill', 'edge')} stroke-width="1" filter="url(#shadow-pill)"/>` +
      `<text x="${r(center)}" y="${PILL_Y + 5.5}" font-size="${PILL_SIZE}" text-anchor="middle">${spans.map(tspan).join('')}</text>`,
  }
}

const open = (width: number, label: string) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" width="${width * 4}" height="${HEIGHT * 4}" font-family="${SANS}" role="img" aria-label="${esc(label)}">`,
    `<style>@media (prefers-color-scheme: dark){${DARK_RULES}}</style>`,
    '<defs>',
    `<linearGradient id="card" x1="0" y1="0" x2="0" y2="1">${stopOf(0, 'surface')}${stopOf(1, 'surfaceLow')}</linearGradient>`,
    `<linearGradient id="groove" x1="0" y1="0" x2="0" y2="1">${stopOf(0, 'grooveTop')}${stopOf(0.55, 'groove')}</linearGradient>`,
    `<linearGradient id="span" x1="0" y1="0" x2="0" y2="1">${stopOf(0, 'accentHigh')}${stopOf(1, 'accent')}</linearGradient>`,
    `<linearGradient id="knob" x1="0" y1="0" x2="0" y2="1">${stopOf(0, 'knob')}${stopOf(1, 'knobLow')}</linearGradient>`,
    '<filter id="shadow-card" x="-5%" y="-10%" width="110%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.08"/></filter>',
    '<filter id="shadow-pill" x="-10%" y="-40%" width="120%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="0.1"/></filter>',
    '<filter id="shadow-knob" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000" flood-opacity="0.3"/></filter>',
    '</defs>',
    `<rect x="4" y="3" width="${width - 8}" height="${HEIGHT - 10}" rx="18" fill="url(#card)" filter="url(#shadow-card)"/>`,
    // The card's top edge catches the light; only the dark card shows it.
    `<path d="M22,3.6 H${width - 22}" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1"/>`,
  ].join('')

/** A recessed track from `x1` to `x2`, centred on `y`: its upper wall in shadow. */
const groove = (x1: number, x2: number, y: number) =>
  `<rect x="${r(x1)}" y="${y - TRACK_H / 2}" width="${r(x2 - x1)}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="url(#groove)"/>`

/** A raised knob: the light from above, its shadow below, a ring in the accent. */
const knob = (attrs: string, ring: Tone, radius = KNOB_R, isDashed = false) =>
  `<g filter="url(#shadow-knob)"><circle${attrs} r="${radius}" fill="url(#knob)"${strokeOf(ring)} stroke-width="${radius > 8 ? 3 : 2}"${isDashed ? ' stroke-dasharray="4 3"' : ''}/></g>`

const nodeMark = (node: CardNode, i: number, x: number) => {
  const at = ` data-node="${i}" cx="${r(x)}" cy="${TRACK_Y}"`
  const role = ` data-role="${node.role}"`

  switch (node.role) {
    case 'base':
    case 'compare':
      return knob(`${at}${role}`, 'accent', KNOB_R, node.isWorking)
    case 'between':
      return `<circle${at} r="3"${role}${fillOf('stop')}/>`
    default:
      return node.isWorking
        ? `<circle${at} r="4.5"${role}${fillAndStroke('groove', 'dot')} stroke-width="1.6" stroke-dasharray="2.5 2"/>`
        : `<circle${at} r="3.5"${role}${fillOf('dot')}/>`
  }
}

/** Text at a top corner of the card, beside the pill, when it fits there. */
const corner = (text: string, x: number, room: number, anchor: 'start' | 'end') =>
  text === '' || widthOf(text, SIDE_SIZE) > room
    ? ''
    : `<text x="${r(x)}" y="${PILL_Y + 5}" font-size="${SIDE_SIZE}" text-anchor="${anchor}"${fillOf('muted')}>${esc(text)}</text>`

/** Length of the scroll bar, in viewBox units. */
const SCROLL_LEN = 96

/**
 * A small scroll bar in the top right: the history loaded, the window over it framed, the compared
 * pair lit, and in words where the window is. Nothing when the whole history is in view.
 */
const scrollMark = (right: number, room: number, o: CardOverview) => {
  if (o.total <= 0 || (o.first <= 0 && o.last >= o.total - 1 && !o.more)) {
    return ''
  }

  const text = `${o.first + 1}–${o.last + 1} of ${o.total}${o.more ? '+' : ''}`
  const textW = widthOf(text, SIDE_SIZE)

  if (textW > room) {
    return ''
  }

  const label = `<text x="${r(right)}" y="${PILL_Y + 5}" font-size="${SIDE_SIZE}" text-anchor="end"${fillOf('muted')}>${esc(text)}</text>`

  if (room < textW + 12 + SCROLL_LEN) {
    return label
  }

  const x0 = right - textW - 12 - SCROLL_LEN
  const at = (node: number) => x0 + (SCROLL_LEN * node) / o.total
  const pickX = at(Math.max(0, o.pickFrom))
  const thumbX = at(o.first)

  return (
    label +
    `<rect x="${r(x0)}" y="${PILL_Y - 3}" width="${SCROLL_LEN}" height="6" rx="3"${fillOf('groove')}/>` +
    `<rect data-scroll="pick" x="${r(pickX)}" y="${PILL_Y - 3}" width="${r(Math.max(3, at(o.pickTo + 1) - pickX))}" height="6" rx="3"${fillOf('accent')}/>` +
    `<rect data-scroll="window" x="${r(thumbX)}" y="${PILL_Y - 5}" width="${r(Math.max(6, at(o.last + 1) - thumbX))}" height="10" rx="4" fill="none"${strokeOf('soft')} stroke-width="1.4"/>`
  )
}

/**
 * History: a range slider over the commits in view, with a bar of each commit's size above
 * it. The pick is the lit span between two knobs; the commits whose changes it takes in
 * have their bars lit too.
 */
export const historyCard = ({ columns, nodes, title, range, stats, older, newer, overview }: HistoryCardInput): string => {
  const width = columns * CELL
  const left = EDGE
  const right = width - EDGE
  const xs = nodes.map((_, i) => slotCenter(i) * CELL)
  const picked = nodes.map((node, i) => (node.role === 'outside' ? -1 : i)).filter(i => i >= 0)
  const firstPicked = picked[0]
  const lastPicked = picked.at(-1)
  // A pick whose end is out of view runs on to the track's end on that side.
  const spanFrom = firstPicked === undefined ? 0 : nodes[firstPicked]!.role === 'base' ? xs[firstPicked]! : left
  const spanTo = lastPicked === undefined ? 0 : nodes[lastPicked]!.role === 'compare' ? xs[lastPicked]! : right
  const rangeSpans: Span[] = [
    { text: range.from, tone: 'ink', isMono: true },
    { text: '→', tone: 'muted', gap: 7 },
    { text: range.to, tone: 'ink', isMono: true, gap: 7 },
  ]
  const pill = pillOf(
    width / 2,
    width - 48,
    stats === null
      ? [joined(rangeSpans, statSpans(null, true)), rangeSpans]
      : [joined(rangeSpans, statSpans(stats, true)), joined(rangeSpans, statSpans(stats, false)), statSpans(stats, false)],
  )
  const sideRoom = width / 2 - pill.width / 2 - 40
  const beyond = [older > 0 ? `${older} older` : '', newer > 0 ? `${newer} newer` : ''].filter(Boolean).join(' · ')
  const tallest = Math.log10(1 + Math.max(1, ...nodes.map(node => node.churn)))
  const parts = [
    open(width, `${title}: ${range.from} to ${range.to}`),
    pill.svg,
    corner(title, 24, sideRoom, 'start'),
    overview === undefined ? corner(beyond, width - 24, sideRoom, 'end') : scrollMark(width - 24, sideRoom, overview),
  ]

  nodes.forEach((node, i) => {
    if (node.churn <= 0) {
      return
    }

    const height = 3 + ((BAR_MAX - 3) * Math.log10(1 + node.churn)) / tallest
    const isIn = node.role === 'between' || node.role === 'compare'

    parts.push(
      `<rect data-bar="${isIn ? 'in' : 'out'}" x="${r(xs[i]! - BAR_W / 2)}" y="${r(BAR_BASE - height)}" width="${BAR_W}" height="${r(height)}" rx="${BAR_W / 2}"${fillOf(isIn ? 'barLit' : 'bar')}/>`,
    )
  })

  parts.push(groove(left, right, TRACK_Y))

  if (spanTo > spanFrom) {
    const x1 = Math.max(left + 2, spanFrom - SPAN_H / 2)
    const x2 = Math.min(right - 2, spanTo + SPAN_H / 2)

    parts.push(
      `<rect data-span="pick" x="${r(x1)}" y="${TRACK_Y - SPAN_H / 2}" width="${r(x2 - x1)}" height="${SPAN_H}" rx="${SPAN_H / 2}" fill="url(#span)"/>`,
    )
  }

  nodes.forEach((node, i) => {
    const x = xs[i]!
    const isPicked = node.role === 'base' || node.role === 'compare'

    parts.push(
      `<g><title>${esc(node.tip)}</title>${nodeMark(node, i, x)}</g>`,
      `<text x="${r(x)}" y="${LABEL_Y}" font-size="${LABEL_SIZE}" text-anchor="middle"${fillOf(isPicked ? 'ink' : 'muted')}${isPicked ? ' font-weight="600"' : ''}>${esc(node.label)}</text>`,
    )
  })

  parts.push('</svg>')

  return parts.join('')
}

/** Spreads `count` dots from `x1` to `x2`, the last one at `x2`. */
const spread = (count: number, x1: number, x2: number) =>
  Array.from({ length: count }, (_, i) => (count === 1 ? x2 : x1 + ((x2 - x1) * i) / (count - 1)))

/**
 * Branches: the base on a recessed track, the compare branch forking off it on a lit rail.
 * The knobs mark what the diff runs between: where they split, and the compare tip.
 */
export const branchCard = (input: BranchCardInput): string => {
  const { columns, base, compare, ahead, behind, aheadTips, behindTips, mergeBase, stats } = input
  const width = columns * CELL
  const fork = Math.round(width * 0.22)
  const tipX = width - 44
  const middle = (fork + 90 + tipX) / 2
  const aheadCount = Math.min(ahead, MAX_DOTS)
  const behindCount = Math.min(behind, MAX_DOTS)
  const aheadXs = spread(aheadCount, fork + 90, tipX)
  const behindXs = spread(behindCount, fork + 90, tipX)
  const words: Span[] = [
    { text: `${ahead} ahead`, tone: 'ink', isBold: true },
    { text: '·', tone: 'muted', gap: 7 },
    { text: `${behind} behind`, tone: 'ink', isBold: true, gap: 7 },
  ]
  const pill = pillOf(width / 2, width - 48, [
    joined(words, statSpans(stats, true)),
    joined(words, statSpans(stats, false)),
    words,
  ])
  const parts = [
    open(width, `${compare} is ${ahead} ahead of and ${behind} behind ${base}`),
    pill.svg,
    groove(EDGE, width - EDGE, BASE_Y),
    ...[0.25, 0.5, 0.75].map(at => `<circle cx="${r(fork * at)}" cy="${BASE_Y}" r="3.5"${fillOf('dot')}/>`),
  ]

  behindXs.forEach((x, i) => {
    const tip = behindTips[behindTips.length - behindCount + i] ?? ''
    const at = ` data-side="behind" cx="${r(x)}" cy="${BASE_Y}"`

    parts.push(
      `<g><title>${esc(tip)}</title>${i === behindCount - 1 ? knob(at, 'dot', 7) : `<circle${at} r="3.5"${fillOf('dot')}/>`}</g>`,
    )
  })

  if (ahead > 0) {
    const rail = `M${fork},${BASE_Y} C${fork + 40},${BASE_Y} ${fork + 36},${RAIL_Y} ${fork + 76},${RAIL_Y} L${tipX},${RAIL_Y}`

    parts.push(
      `<path d="${rail}" fill="none"${strokeOf('groove')} stroke-width="${TRACK_H}" stroke-linecap="round"/>`,
      `<path d="${rail}" fill="none"${strokeOf('accent')} stroke-width="${SPAN_H}" stroke-linecap="round"/>`,
    )
  }

  aheadXs.forEach((x, i) => {
    const tip = aheadTips[aheadTips.length - aheadCount + i] ?? ''
    const at = ` data-side="ahead" cx="${r(x)}" cy="${RAIL_Y}"`

    parts.push(
      `<g><title>${esc(tip)}</title>${i === aheadCount - 1 ? knob(at, 'accent') : `<circle${at} r="3"${fillOf('stop')}/>`}</g>`,
    )
  })

  if (ahead > aheadCount) {
    parts.push(
      `<text x="${r(middle)}" y="${RAIL_Y + 24}" font-size="${SIDE_SIZE}" text-anchor="middle"${fillOf('muted')}>+${ahead - aheadCount} more</text>`,
    )
  }

  if (behind > behindCount) {
    parts.push(
      `<text x="${r(middle)}" y="${LABEL_Y}" font-size="${SIDE_SIZE}" text-anchor="middle"${fillOf('muted')}>+${behind - behindCount} more</text>`,
    )
  }

  // With nothing ahead there is no rail: the compare branch is the fork, so its name sits there.
  const compareAt = ahead > 0 ? `x="${tipX + KNOB_R}" y="${RAIL_Y - 18}" text-anchor="end"` : `x="${fork}" y="${BASE_Y - 20}" text-anchor="middle"`

  parts.push(
    knob(` cx="${fork}" cy="${BASE_Y}"`, 'accent'),
    `<text ${compareAt} font-size="${LABEL_SIZE}" font-weight="600"${fillOf('ink')}>${esc(compare)}</text>`,
    `<text x="${tipX + KNOB_R}" y="${LABEL_Y}" font-size="${LABEL_SIZE}" font-weight="600" text-anchor="end"${fillOf('soft')}>${esc(base)}</text>`,
    mergeBase === ''
      ? ''
      : `<text x="${fork}" y="${LABEL_Y}" font-size="${SIDE_SIZE}" text-anchor="middle"${fillOf('muted')}>${esc(mergeBase)}</text>`,
    '</svg>',
  )

  return parts.join('')
}
