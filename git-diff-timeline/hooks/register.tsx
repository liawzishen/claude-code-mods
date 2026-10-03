import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, RenderSurface, Timer } from 'claude-code'

import type { GitDiffCommit, GitDiffFile, GitDiffPatch, GitDiffStat, GitDiffTimeline } from '../types'
import { branchCard, historyCard } from './card'
import type { CardNode } from './card'
import { EMPTY_TREE, LOG_LIMIT, MAX_LOG, fetchAll, fetchHeadPath, loadBranchCompare, loadPatch, loadStat, loadTimeline } from './git'
import type { Loaded, Run } from './git'
import { ARROW_W, SLOT_W, centerStart, dayLabels, formatTime, resolveStart, shortDate, stepStart, visibleCount } from './layout'
import {
  INITIAL,
  WORKING,
  buttonLabel,
  clickCommit,
  commitTitle,
  describeFetch,
  describeStat,
  diffSpec,
  merge,
  nodeIds,
  rangeCommits,
  refOf,
  selectionKey,
  settleFetch,
} from './model'

type Kit = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button' | 'Code'> & {
  /** Absent on the phone. */
  Select: ElementTable<'terminal'>['Select'] | null
  /** The desktop's; the terminal draws the timeline in text. */
  Svg: ElementTable<'desktop'>['Svg'] | null
}

type Actions = {
  refresh: () => void
  details: () => void
  mode: (mode: GitDiffTimeline['mode']) => void
  pickCommit: (index: number) => void
  pickBranch: (side: 'base' | 'compare', name: string) => void
  swap: () => void
  step: (delta: number, count: number) => void
  /** Show another branch's history; '' is the checked-out one. */
  viewBranch: (name: string) => void
  /** Scroll the timeline to node `index`, in a window of `count` nodes. */
  goTo: (index: number, count: number) => void
  fetch: () => void
  toggleFile: (path: string) => void
}

const PANE = 'git-diff'
const PANE_ARGS = { id: PANE, title: 'Git Diff', rows: 24, columns: 96 } as const

/** Tools whose calls can change what git sees. */
const WATCHED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const REFRESH_DELAY_MS = 1200
/** A fetch may take a while on a slow remote. */
const FETCH_TIMEOUT_MS = 120_000
/** Remote branches older than this, in seconds, are shown as stale. */
const STALE_AFTER_S = 86_400
/** Files the files view lists, and diffs it holds open at once. */
const MAX_FILES = 100
const MAX_OPEN = 4
/** Commits the files view lists above the files. */
const MAX_COMMITS = 20
const BLOCKS = 5
/** Cells of track either side of a commit's knob on the terminal. */
const HALF_SLOT = (SLOT_W - 1) / 2

/** Theme keys: each surface paints them in the person's theme, the colour-blind ones too. */
const ACCENT = 'claude'
const ADDED = 'success'
const DELETED = 'error'
const ERROR = 'error'
const WARNING = 'warning'

const timeline = atom({ plugin: 'git-diff-timeline', key: 'timeline' } as const, INITIAL)

/** `band`: the strip above the prompt. `pane`: the side pane, opened on its own. Set in register. */
let position: 'band' | 'pane' = 'band'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The elements a surface draws. By the surface, not by the table's keys: a table is
 * completed to every element name, one the surface lacks drawing nothing.
 */
const kitOf = (ui: ElementTable, surface: RenderSurface): Kit => ({
  Box: ui.Box,
  Text: ui.Text,
  Button: ui.Button,
  Code: ui.Code,
  Select: surface !== 'mobile' && 'Select' in ui ? ui.Select : null,
  Svg: surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null,
})

const runnerFor = async ($: EngineInterface, init: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Run> => {
  const cwd = await $.session.cwd()

  return argv => $.process.run(argv, { cwd, timeoutMs: 15_000, ...init })
}

/** The files open after a fresh read: the first file for a new pick, else those still changed. */
const openAfter = (cur: GitDiffTimeline, key: string, stat: GitDiffStat | null): string[] => {
  if (cur.statKey !== key) {
    const first = stat?.files[0]

    return first === undefined ? [] : [first.path]
  }

  const paths = new Set(stat?.files.map(file => file.path) ?? [])

  return cur.open.filter(path => paths.has(path))
}

/** Reads the diff of each open file still unread (`force`: every open file). */
const loadPatches = async ($: EngineInterface, force: boolean) => {
  const t = await read($, timeline)

  if (t.status !== 'ready' || t.stat === null) {
    return
  }

  const key = t.statKey
  const wanted = t.open.filter(path => force || !t.patches.some(patch => patch.path === path))

  if (wanted.length === 0) {
    return
  }

  const run = await runnerFor($)
  const spec = diffSpec(t)
  const loaded = await Promise.all(wanted.map(path => loadPatch(run, spec, path)))

  await update($, timeline, cur =>
    cur.statKey !== key
      ? cur
      : {
          ...cur,
          patches: [...cur.patches.filter(patch => !wanted.includes(patch.path)), ...loaded].filter(patch =>
            cur.open.includes(patch.path),
          ),
        },
  )
}

/** Reads what the pick changed, unless it is on screen already (`force` rereads), then its open files. */
const loadSelection = async ($: EngineInterface, force: boolean) => {
  const t = await read($, timeline)

  if (t.status !== 'ready') {
    return
  }

  const key = selectionKey(t)

  if (!force && t.statKey === key && t.stat !== null) {
    await loadPatches($, false)

    return
  }

  const run = await runnerFor($)
  let stat: GitDiffStat | null = null
  let statError = ''
  let branchCompare = t.branchCompare

  try {
    const [loadedStat, compared] = await Promise.all([
      loadStat(run, diffSpec(t)),
      t.mode === 'branches' ? loadBranchCompare(run, t.base, t.compare) : Promise.resolve(null),
    ])

    stat = loadedStat
    branchCompare = compared ?? branchCompare
  } catch (error) {
    statError = errorText(error)
  }

  await update($, timeline, cur =>
    selectionKey(cur) !== key
      ? cur
      : {
          ...cur,
          stat,
          statKey: key,
          statError,
          branchCompare: cur.mode === 'branches' ? branchCompare : cur.branchCompare,
          open: openAfter(cur, key, stat),
          patches: cur.statKey === key ? cur.patches : [],
        },
  )
  await loadPatches($, force)
}

/**
 * When the repository last fetched, read from the file git rewrites on every fetch. The
 * remote branches (`origin/main`) are copies as of then: git never updates them by itself.
 */
const loadFreshness = async ($: EngineInterface, run: Run, cwd: string) => {
  const t = await read($, timeline)
  let fetchedAt = 0
  let isStale = false

  try {
    const path = t.branches.some(branch => branch.isRemote) ? await fetchHeadPath(run, cwd) : ''

    if (path !== '') {
      fetchedAt = Math.floor((await $.fs.stat(path)).mtimeMs / 1000)
      isStale = Math.floor((await $.clock.now()) / 1000) - fetchedAt > STALE_AFTER_S
    }
  } catch {
    // No FETCH_HEAD yet (never fetched since the clone), or git did not say: the age is unknown.
  }

  await update($, timeline, cur => ({ ...cur, fetchedAt, isStale }))
}

const refresh = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const run = await runnerFor($)
  const was = await read($, timeline)
  const isSameRepo = was.cwd === cwd
  const failed = (error: unknown): Loaded => ({
    status: 'error',
    message: errorText(error),
    branch: '',
    commits: [],
    hasWorking: false,
    untracked: 0,
    baseOfOldest: '',
    branches: [],
    defaultBase: '',
    viewing: '',
  })
  const loaded = await loadTimeline(run, isSameRepo ? was.viewing : '', isSameRepo ? was.limit : LOG_LIMIT).catch(failed)

  await update($, timeline, prev => merge(prev, loaded, cwd))
  await loadFreshness($, run, cwd)
  await loadSelection($, true)
}

let pending: Timer | undefined

/** Whether the pane has been seated this session; a pane opened unasked can wait undrawn. */
let wasPlaced = false
let hasOffered = false

const openDetails = async ($: EngineInterface) => {
  try {
    wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
  } catch {
    // /gitdiff says why when the pane cannot open.
  }
}

/** Shows what the person picked: the files view opened by their press, then a fresh read. */
const show = async ($: EngineInterface, change: (t: GitDiffTimeline) => GitDiffTimeline) => {
  await openDetails($)
  await update($, timeline, t => {
    const next = change(t)

    return selectionKey(next) === selectionKey(t)
      ? next
      : { ...next, stat: null, statKey: '', statError: '', open: [], patches: [] }
  })
  await loadSelection($, false)
}

const pickCommit = ($: EngineInterface, index: number) =>
  show($, t => ({ ...t, ...clickCommit(t, index), isPinned: true }))

const pickBranch = ($: EngineInterface, side: 'base' | 'compare', name: string) =>
  show($, t => (side === 'base' ? { ...t, base: name } : { ...t, compare: name }))

const toggleFile = async ($: EngineInterface, path: string) => {
  await update($, timeline, t => {
    if (t.open.includes(path)) {
      return { ...t, open: t.open.filter(p => p !== path), patches: t.patches.filter(patch => patch.path !== path) }
    }

    const open = [...t.open, path].slice(-MAX_OPEN)

    return { ...t, open, patches: t.patches.filter(patch => open.includes(patch.path)) }
  })
  await loadPatches($, false)
}

/** Whether git may hold commits older than the timeline has, and the timeline may still grow. */
const canLoadOlder = (t: GitDiffTimeline) => t.hasMore && t.limit < MAX_LOG

let isLoadingOlder = false

/** Reads another page of older commits, and pages the window back onto them. */
const loadOlder = async ($: EngineInterface, count: number) => {
  if (isLoadingOlder) {
    return
  }

  isLoadingOlder = true

  try {
    // The window is pinned to its commits first, so the commits that come in before them move nothing.
    await update($, timeline, t => ({
      ...t,
      limit: Math.min(MAX_LOG, t.limit + LOG_LIMIT),
      start: resolveStart(t.start, count, nodeIds(t).length),
    }))
    await refresh($)
    await update($, timeline, t => ({ ...t, start: stepStart(t.start, -1, count, nodeIds(t).length) }))
  } finally {
    isLoadingOlder = false
  }
}

/** One page left or right. Left of the oldest commit loaded, it reads older ones. */
const step = async ($: EngineInterface, delta: number, count: number) => {
  const t = await read($, timeline)

  if (delta < 0 && canLoadOlder(t) && resolveStart(t.start, count, nodeIds(t).length) === 0) {
    await loadOlder($, count)

    return
  }

  await update($, timeline, cur => ({ ...cur, start: stepStart(cur.start, delta, count, nodeIds(cur).length) }))
}

/** Shows another branch's history. It reads the branch as it is: nothing is checked out. */
const viewBranch = async ($: EngineInterface, name: string) => {
  await update($, timeline, t => ({
    ...t,
    viewing: name,
    limit: LOG_LIMIT,
    start: -1,
    isPinned: false,
    anchor: '',
    stat: null,
    statKey: '',
    statError: '',
    open: [],
    patches: [],
  }))
  await refresh($)
}

const goTo = (index: number, count: number, $: EngineInterface) =>
  index < 0 ? Promise.resolve() : update($, timeline, t => ({ ...t, start: centerStart(index, count, nodeIds(t).length) }))

/**
 * Brings the remote branches up to date. Only a person's press starts it: a fetch reaches the
 * network, and may ask for a password.
 */
const fetchRemotes = async ($: EngineInterface) => {
  const before = await read($, timeline)

  if (before.fetch === 'running') {
    return
  }

  await update($, timeline, t => ({ ...t, fetch: 'running' as const, fetchNote: '' }))

  try {
    await fetchAll(await runnerFor($, { timeoutMs: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } }))
  } catch (error) {
    await update($, timeline, t => ({ ...t, fetch: 'failed' as const, fetchNote: `Fetch failed: ${errorText(error)}` }))

    return
  }

  await refresh($).catch(() => undefined)

  const after = await read($, timeline)

  await update($, timeline, t => ({ ...t, fetch: 'idle' as const, fetchNote: describeFetch(before.branches, after.branches) }))
}

const actionsFor = ($: EngineInterface): Actions => ({
  refresh: () => void refresh($).catch(() => undefined),
  details: () => void openDetails($),
  mode: mode => void show($, t => ({ ...t, mode })),
  pickCommit: index => void pickCommit($, index),
  pickBranch: (side, name) => void pickBranch($, side, name),
  swap: () => void show($, t => ({ ...t, base: t.compare, compare: t.base })),
  step: (delta, count) => void step($, delta, count).catch(() => undefined),
  viewBranch: name => void viewBranch($, name).catch(() => undefined),
  goTo: (index, count) => void goTo(index, count, $),
  fetch: () => void fetchRemotes($),
  toggleFile: path => void toggleFile($, path),
})

const isEmptyTree = (sha: string) => sha === EMPTY_TREE.sha1 || sha === EMPTY_TREE.sha256

/** A node in words: its pull request or message, `Uncommitted changes`, or what came before. */
const nodeName = (t: GitDiffTimeline, index: number) => {
  if (index < 0) {
    const oldest = t.commits[0]

    return isEmptyTree(t.baseOfOldest) || oldest === undefined
      ? 'nothing (before the first commit)'
      : `before ${commitTitle(oldest)}`
  }

  const commit = t.commits[index]

  return commit === undefined ? 'Uncommitted changes' : commitTitle(commit)
}

/** A node as its button reads, for the card's summary: `#123`, a short sha, `Now`, `empty tree`. */
const nodeTag = (t: GitDiffTimeline, index: number) => {
  if (index < 0) {
    return isEmptyTree(t.baseOfOldest) ? 'empty tree' : t.baseOfOldest.slice(0, 7)
  }

  const commit = t.commits[index]

  return commit === undefined ? 'Now' : buttonLabel(commit)
}

const when = (seconds: number) => `${shortDate(seconds)}, ${formatTime(seconds)}`

/** What a click does next: wait for the second commit, or start a comparison. */
const clickHint = (t: GitDiffTimeline) => {
  const waiting = nodeIds(t).indexOf(t.anchor)

  return waiting < 0
    ? 'Click a commit to see its changes · click two to compare them'
    : `Click another commit to compare it with ${nodeName(t, waiting)}`
}

const rangeTitle = (t: GitDiffTimeline) =>
  t.mode === 'branches'
    ? `${t.base} ← ${t.compare}`
    : `${t.viewing === '' ? '' : `${t.viewing} · `}${nodeName(t, t.from)} → ${nodeName(t, t.to)}`

const roleOf = (t: GitDiffTimeline, index: number): CardNode['role'] =>
  index === t.to ? 'compare' : index === t.from ? 'base' : index > t.from && index < t.to ? 'between' : 'outside'

/** The window of commits the strip shows: where it starts and how many. */
const windowOf = (t: GitDiffTimeline, columns: number) => {
  const total = nodeIds(t).length
  const count = visibleCount(columns, total)
  const start = resolveStart(t.start, count, total)

  return { total, count, start, indexes: Array.from({ length: Math.min(count, total) }, (_, i) => start + i) }
}

/** The branches to compare, newest first as git sorts them; a long list is cut, the picked ones kept. */
const branchOptions = (t: GitDiffTimeline) =>
  capped(
    t.branches.map(branch => ({
      value: branch.name,
      label: branch.name === t.branch ? `${branch.name} (current)` : branch.name,
    })),
    [t.base, t.compare, t.branch],
  )

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/**
 * The branches whose history can be shown: the checked-out one is '' (kept apart when HEAD is
 * detached). A long list is cut to the newest, the checked-out and the shown kept.
 */
const viewOptions = (t: GitDiffTimeline) => {
  const options = t.branches.map(branch =>
    branch.name === t.branch
      ? { value: '', label: `${branch.name} (current)` }
      : { value: branch.name, label: branch.name },
  )

  return capped(
    t.branches.some(branch => branch.name === t.branch) ? options : [{ value: '', label: `${t.branch} (current)` }, ...options],
    ['', t.viewing],
  )
}

/** A Select takes 1 to 64 options; more, and the engine refuses the whole band. */
const MAX_OPTIONS = 64

/** At most MAX_OPTIONS of `options`, in their order: those named in `keep`, then the first of the rest. */
const capped = <T extends { value: string }>(options: readonly T[], keep: readonly string[]): readonly T[] => {
  if (options.length <= MAX_OPTIONS) {
    return options
  }

  const mustKeep = options.filter(option => keep.includes(option.value))
  const room = MAX_OPTIONS - mustKeep.length
  const chosen = new Set([
    ...mustKeep,
    ...options.filter(option => !keep.includes(option.value)).slice(0, room),
  ])

  return options.filter(option => chosen.has(option))
}

/**
 * The nodes to scroll to, newest first: all of them, or when there are more than a Select takes,
 * 64 spread evenly from the newest to the oldest.
 */
const jumpIndexes = (total: number): number[] => {
  const stride = total <= MAX_OPTIONS ? 1 : (total - 1) / (MAX_OPTIONS - 1)

  return Array.from({ length: Math.min(total, MAX_OPTIONS) }, (_, k) => Math.round((Math.min(total, MAX_OPTIONS) - 1 - k) * stride))
}

/**
 * The list to scroll by, each node by its day, button label and title, and the one nearest the
 * middle of the window: where the person is.
 */
const jumpList = (t: GitDiffTimeline, middle: number) => {
  const ids = nodeIds(t)
  const indexes = jumpIndexes(ids.length)
  const nearest = indexes.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best), indexes[0] ?? 0)

  return {
    value: ids[nearest] ?? '',
    options: indexes.map(i => {
      const commit = t.commits[i]

      return {
        value: ids[i] ?? '',
        label:
          commit === undefined
            ? 'Now · uncommitted changes'
            : clip(`${shortDate(commit.time)} · ${buttonLabel(commit)} · ${commitTitle(commit)}`, 72),
      }
    }),
  }
}

/**
 * A view tab: the open one a plain button, the other quiet. Not `primary`: that marks the
 * commit being looked at, the one thing on the strip that should stand out.
 */
const tabLook = (isOpen: boolean) => (isOpen ? { variant: 'secondary' as const } : { plain: true as const, dimColor: true })

/**
 * How old the remote branches are, and a way to bring them up to date. `origin/main` is this
 * computer's copy of the server's main as of the last fetch: it is never live, so the chip says when.
 */
const remoteChip = (t: GitDiffTimeline, on: Actions, { Box, Text, Button }: Pick<Kit, 'Box' | 'Text' | 'Button'>) => {
  if (!t.branches.some(branch => branch.isRemote)) {
    return null
  }

  if (t.fetch === 'running') {
    return <Text dimColor>Fetching…</Text>
  }

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {t.fetch === 'failed' ? (
        <Text color={ERROR}>{t.fetchNote}</Text>
      ) : t.fetchedAt === 0 ? (
        <Text dimColor>Remotes: last fetch unknown</Text>
      ) : (
        <Text {...(t.isStale ? { color: WARNING } : { dimColor: true })}>
          {`Remotes fetched ${when(t.fetchedAt)}${t.fetchNote === '' ? '' : ` · ${t.fetchNote}`}`}
        </Text>
      )}
      <Button key="fetch" plain label="Fetch" onPress={on.fetch} />
    </Box>
  )
}

/** The strip's first row: History or Branches, how to pick, the files view and a refresh. */
const controls = (
  { Box, Text, Button, Select }: Kit,
  t: GitDiffTimeline,
  on: Actions,
  win: ReturnType<typeof windowOf>,
): RenderElement => {
  const isHistory = t.mode === 'history'
  const ids = nodeIds(t)
  const jump = jumpList(t, Math.min(win.total - 1, win.start + Math.floor(win.indexes.length / 2)))
  const pickers = isHistory ? (
    <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
      {Select !== null && t.branches.length > 0 && (
        <Select
          key="view-branch"
          label="Branch"
          options={viewOptions(t)}
          value={t.viewing}
          onSelect={name => on.viewBranch(name)}
        />
      )}
      {Select !== null && ids.length > win.count && (
        <Select
          key="go-to"
          label="Go to"
          options={jump.options}
          value={jump.value}
          onSelect={id => on.goTo(ids.indexOf(id), win.count)}
        />
      )}
      <Text dimColor>{clickHint(t)}</Text>
    </Box>
  ) : Select === null ? null : t.branches.length === 0 ? (
      <Text dimColor>No branches to compare.</Text>
    ) : (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Select
          key="branch-base"
          label="Base"
          options={branchOptions(t)}
          value={t.base}
          onSelect={name => on.pickBranch('base', name)}
        />
        <Text dimColor>←</Text>
        <Select
          key="branch-compare"
          label="Compare"
          options={branchOptions(t)}
          value={t.compare}
          onSelect={name => on.pickBranch('compare', name)}
        />
        <Button key="swap" plain label="⇄" onPress={on.swap} />
      </Box>
    )

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent="space-between">
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Button key="mode:history" label="History" {...tabLook(isHistory)} onPress={() => on.mode('history')} />
        <Button key="mode:branches" label="Branches" {...tabLook(!isHistory)} onPress={() => on.mode('branches')} />
        {pickers}
      </Box>
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        {remoteChip(t, on, { Box, Text, Button })}
        <Button key="details" label="Files changed" onPress={on.details} />
        <Button key="refresh" plain label="↻" onPress={on.refresh} />
      </Box>
    </Box>
  )
}

/** The totals as text: the terminal's strip, and the files view's first line. */
const totals = ({ Box, Text }: Kit, t: GitDiffTimeline): RenderElement => {
  const stat = describeStat(t.stat)

  return (
    <Box flexDirection="row" columnGap={1}>
      {t.statError !== '' && <Text color={ERROR}>{t.statError}</Text>}
      {t.statError === '' && stat === null && <Text dimColor>Reading the diff…</Text>}
      {stat !== null && <Text>{stat.files}</Text>}
      {stat !== null && <Text color={ADDED}>{stat.added}</Text>}
      {stat !== null && <Text color={DELETED}>{stat.deleted}</Text>}
    </Box>
  )
}

/** Half a slot of track: heavy in the accent inside the compared span, a thin rule outside it. */
const rail = ({ Text }: Kit, isIn: boolean): RenderElement =>
  isIn ? <Text color={ACCENT}>{'━'.repeat(HALF_SLOT)}</Text> : <Text dimColor>{'─'.repeat(HALF_SLOT)}</Text>

/** The terminal's slider: a knob at each end of the pick, the span between them drawn heavy. */
const trackRow = (kit: Kit, t: GitDiffTimeline, indexes: number[]): RenderElement => {
  const { Box, Text } = kit
  const newest = nodeIds(t).length - 1
  // Whether the stretch of track from node `a` to the next one is inside the pick.
  const isIn = (a: number) => t.from <= a && a + 1 <= t.to

  return (
    <Box flexDirection="row">
      <Box width={ARROW_W} />
      {indexes.map(i => {
        const role = roleOf(t, i)
        const isPicked = role === 'base' || role === 'compare'
        const glyph = t.commits[i] === undefined ? '○' : isPicked ? '◉' : '●'

        return (
          <Box width={SLOT_W} flexDirection="row">
            {rail(kit, isIn(i - 1))}
            <Text {...(role === 'outside' ? { dimColor: true } : { color: ACCENT })} bold={isPicked}>
              {glyph}
            </Text>
            {i < newest ? rail(kit, isIn(i)) : <Text>{' '.repeat(HALF_SLOT)}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

/** History: the card (a slider in text on the terminal), and under it a button per commit. */
const historyStrip = (
  kit: Kit,
  t: GitDiffTimeline,
  columns: number,
  on: Actions,
  win: ReturnType<typeof windowOf>,
): RenderElement => {
  const { Box, Button, Svg } = kit
  const { total, count, start, indexes } = win
  const labels = dayLabels(indexes.map(i => t.commits[i]?.time ?? null))
  const nodes: CardNode[] = indexes.map((i, k) => {
    const commit = t.commits[i]

    return commit === undefined
      ? { label: 'Now', churn: 0, role: roleOf(t, i), isWorking: true, tip: 'Uncommitted changes' }
      : {
          label: labels[k] ?? '',
          churn: commit.added + commit.deleted,
          role: roleOf(t, i),
          isWorking: false,
          tip: `${commit.short} · ${commitTitle(commit)} · +${commit.added} −${commit.deleted}`,
        }
  })
  const title = `${t.viewing === '' ? t.branch : t.viewing} · ${t.commits.length}${t.hasMore ? '+' : ''} commit${t.commits.length === 1 ? '' : 's'}`
  const picture =
    Svg === null ? (
      <Box flexDirection="column">
        {totals(kit, t)}
        {trackRow(kit, t, indexes)}
      </Box>
    ) : (
      <Svg
        source={historyCard({
          columns,
          nodes,
          title,
          range: { from: nodeTag(t, t.from), to: nodeTag(t, t.to) },
          stats: describeStat(t.stat),
          older: start,
          newer: total - start - indexes.length,
          overview: {
            total,
            first: start,
            last: start + indexes.length - 1,
            pickFrom: t.from,
            pickTo: t.to,
            more: t.hasMore,
          },
        })}
        alt={`${title}: ${rangeTitle(t)}`}
      />
    )

  return (
    <Box flexDirection="column">
      {picture}
      <Box flexDirection="row">
        <Box width={ARROW_W}>
          <Button key="prev" plain dimColor={start === 0 && !canLoadOlder(t)} label="‹" onPress={() => on.step(-1, count)} />
        </Box>
        {indexes.map(i => {
          const commit = t.commits[i]
          const role = roleOf(t, i)
          const look =
            role === 'compare'
              ? { variant: 'primary' as const }
              : role === 'base'
                ? { variant: 'secondary' as const }
                : { plain: true as const, dimColor: role === 'outside' }

          return (
            <Box width={SLOT_W} justifyContent="center">
              <Button
                key={`node:${i}`}
                label={commit === undefined ? 'Now' : buttonLabel(commit)}
                {...look}
                onPress={() => on.pickCommit(i)}
              />
            </Box>
          )
        })}
        <Box width={ARROW_W} justifyContent="flex-end">
          <Button key="next" plain dimColor={start + count >= total} label="›" onPress={() => on.step(1, count)} />
        </Box>
      </Box>
      {messageRow(kit, t, t.from, 'From')}
      {messageRow(kit, t, t.to, 'To')}
    </Box>
  )
}

/** One end of the comparison: From or To, its short sha and message, and when, at the right. */
const messageRow = ({ Box, Text }: Kit, t: GitDiffTimeline, index: number, end: string): RenderElement => {
  const commit = t.commits[index]
  const short = index < 0 ? t.baseOfOldest.slice(0, 7) : (commit?.short ?? '')

  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={4} flexShrink={0}>
        <Text dimColor>{end}</Text>
      </Box>
      {short !== '' && <Text dimColor>{short}</Text>}
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{nodeName(t, index)}</Text>
      </Box>
      {commit !== undefined && <Text dimColor>{when(commit.time)}</Text>}
    </Box>
  )
}

/** Branches: the fork card, or a line of words on the terminal. */
const branchStrip = (kit: Kit, t: GitDiffTimeline, columns: number): RenderElement => {
  const { Box, Text, Svg } = kit
  const compared = t.branchCompare
  const ahead = compared?.ahead ?? 0
  const behind = compared?.behind ?? 0
  const words = `${t.compare} is ${plural(ahead, 'commit')} ahead, ${behind} behind ${t.base}`

  if (Svg === null) {
    return (
      <Box flexDirection="column">
        <Text>{words}</Text>
        {totals(kit, t)}
      </Box>
    )
  }

  const mergeBase = compared?.mergeBase ?? null

  return (
    <Svg
      source={branchCard({
        columns,
        base: t.base,
        compare: t.compare,
        ahead,
        behind,
        aheadTips: compared?.aheadCommits.map(commitTitle) ?? [],
        behindTips: compared?.behindCommits.map(commitTitle) ?? [],
        mergeBase: mergeBase === null ? '' : `merge base ${mergeBase.short} · ${shortDate(mergeBase.time)}`,
        stats: describeStat(t.stat),
      })}
      alt={words}
    />
  )
}

const strip = (kit: Kit, t: GitDiffTimeline, columns: number, on: Actions): RenderElement => {
  const { Box } = kit
  const win = windowOf(t, columns)

  return (
    <Box flexDirection="column">
      {controls(kit, t, on, win)}
      {t.mode === 'history' ? historyStrip(kit, t, columns, on, win) : branchStrip(kit, t, columns)}
    </Box>
  )
}

/** GitHub's five squares: a file's share of lines added and deleted. */
const blocks = (file: GitDiffFile) => {
  const total = (file.added ?? 0) + (file.deleted ?? 0)

  if (file.added === null || total === 0) {
    return { added: 0, deleted: 0 }
  }

  const added = Math.round((file.added / total) * BLOCKS)

  return { added, deleted: BLOCKS - added }
}

const patchView = ({ Box, Text, Code }: Kit, path: string, patch: GitDiffPatch | undefined): RenderElement => {
  if (patch === undefined) {
    return <Text dimColor>Loading the diff…</Text>
  }

  if (patch.note === 'binary') {
    return <Text dimColor>Binary file not shown.</Text>
  }

  if (patch.note === 'empty') {
    return <Text dimColor>No line changes: the file's mode or name changed.</Text>
  }

  if (patch.note !== '') {
    return <Text color={ERROR}>{patch.note}</Text>
  }

  return (
    <Box flexDirection="column">
      <Code source={patch.hunks} format="diff" path={path} />
      {patch.isCut && <Text dimColor>Diff cut to fit here; open the file to see the rest.</Text>}
    </Box>
  )
}

const fileRow = (kit: Kit, t: GitDiffTimeline, file: GitDiffFile, on: Actions): RenderElement => {
  const { Box, Text, Button } = kit
  const isOpen = t.open.includes(file.path)
  const share = blocks(file)
  const rest = BLOCKS - share.added - share.deleted

  // The numbers and squares sit in one column at the right edge, so the rows scan as a table.
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} justifyContent="space-between">
        <Box flexShrink={1}>
          <Button
            key={`file:${file.path}`}
            plain
            label={`${isOpen ? '▾' : '▸'} ${file.path}`}
            onPress={() => on.toggleFile(file.path)}
          />
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          {file.added === null ? <Text dimColor>binary</Text> : <Text color={ADDED}>{`+${file.added}`}</Text>}
          {file.deleted !== null && <Text color={DELETED}>{`−${file.deleted}`}</Text>}
          <Box flexDirection="row">
            {share.added > 0 && <Text color={ADDED}>{'■'.repeat(share.added)}</Text>}
            {share.deleted > 0 && <Text color={DELETED}>{'■'.repeat(share.deleted)}</Text>}
            {rest > 0 && <Text dimColor>{'■'.repeat(rest)}</Text>}
          </Box>
        </Box>
      </Box>
      {isOpen && patchView(kit, file.path, t.patches.find(patch => patch.path === file.path))}
    </Box>
  )
}

const notice = ({ Text }: Kit, t: GitDiffTimeline): RenderElement => {
  switch (t.status) {
    case 'loading':
      return <Text dimColor>Reading git history…</Text>
    case 'no-repo':
      return <Text dimColor>{`Not a git repository: ${t.cwd}`}</Text>
    case 'error':
      return <Text color={ERROR}>{`git failed: ${t.message}`}</Text>
    default:
      return <Text dimColor>{t.message}</Text>
  }
}

/** One commit of a comparison: short sha, message and when, and the body's first line under it. */
const commitRow = ({ Box, Text }: Kit, commit: GitDiffCommit): RenderElement => {
  const title = commitTitle(commit)
  const detail = commit.body
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '' && !title.includes(line) && !line.startsWith('See merge request'))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{commit.short}</Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{title}</Text>
        </Box>
        <Text dimColor>{when(commit.time)}</Text>
      </Box>
      {detail !== undefined && (
        <Box paddingLeft={8}>
          <Text dimColor wrap="truncate-end">
            {detail}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** The commits the comparison takes in, newest first, as GitHub's compare page lists them. */
const commitList = (kit: Kit, t: GitDiffTimeline): RenderElement | null => {
  const { Box, Text } = kit
  const commits =
    t.mode === 'history' ? rangeCommits(t) : [...(t.branchCompare?.aheadCommits ?? [])].reverse()
  const total = t.mode === 'history' ? commits.length : (t.branchCompare?.ahead ?? commits.length)

  if (commits.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      <Text bold>{t.mode === 'history' ? plural(total, 'commit') : `${plural(total, 'commit')} on ${t.compare}`}</Text>
      {commits.slice(0, MAX_COMMITS).map(commit => commitRow(kit, commit))}
      {total > MAX_COMMITS && <Text dimColor>{`… ${total - MAX_COMMITS} older not listed`}</Text>}
    </Box>
  )
}

/** The files view: the commits compared, then what changed, file by file, as GitHub shows it. */
const filesView = (kit: Kit, t: GitDiffTimeline, on: Actions): RenderElement => {
  const { Box, Text } = kit
  const files = t.stat?.files ?? []
  const more = files.length - MAX_FILES
  const compared = t.branchCompare

  return (
    <Box flexDirection="column" rowGap={1}>
      {t.mode === 'branches' && compared !== null && (
        <Text dimColor>
          {`${t.compare} is ${plural(compared.ahead, 'commit')} ahead, ${compared.behind} behind ${t.base}` +
            (compared.mergeBase === null ? ' · no shared history' : ` · they split at ${compared.mergeBase.short}`)}
        </Text>
      )}
      {commitList(kit, t)}
      {totals(kit, t)}
      {files.slice(0, MAX_FILES).map(file => fileRow(kit, t, file, on))}
      {more > 0 && <Text dimColor>{`… ${plural(more, 'more file')} not listed`}</Text>}
      {t.mode === 'history' && refOf(t, t.to) === WORKING && t.untracked > 0 && (
        <Text dimColor>{`${plural(t.untracked, 'untracked file')} not in this diff`}</Text>
      )}
    </Box>
  )
}

const paneView = (kit: Kit, t: GitDiffTimeline, bodyColumns: number, on: Actions): RenderElement => {
  const { Box, Text, Button } = kit
  const isReady = t.status === 'ready'

  return (
    <Box flexDirection="column" paddingX={1} rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          <Text bold>Files changed</Text>
          {isReady && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {rangeTitle(t)}
              </Text>
            </Box>
          )}
        </Box>
        {position === 'band' && <Button key="refresh" plain label="↻" onPress={on.refresh} />}
      </Box>
      {isReady && position === 'pane' && strip(kit, t, bodyColumns - 2, on)}
      {isReady ? filesView(kit, t, on) : notice(kit, t)}
    </Box>
  )
}

/** The strip is always on screen in a repository; the pane only counts while it is open. */
const refreshIfShown = async ($: EngineInterface) => {
  try {
    if (position === 'band' || (await $.ui.panes()).some(pane => pane.id === PANE)) {
      await refresh($)
    }
  } catch {
    // The view keeps its last good state; the next trigger tries again.
  }
}

/** One refresh per burst of tool calls, after the burst settles. */
const scheduleRefresh = ($: EngineInterface) => {
  if (pending !== undefined) {
    return
  }

  pending = $.clock.after(REFRESH_DELAY_MS, () => {
    pending = undefined
    void refreshIfShown($)
  })
}

const begin = async ($: EngineInterface) => {
  try {
    // A reload in the middle of a fetch leaves "Fetching…" in the state, with nothing left to end it.
    await update($, timeline, settleFetch)
    await refresh($)

    if (position === 'band') {
      // The strip replaces the side pane: close one an earlier load or setting left open.
      await $.ui.close({ id: PANE })

      return
    }

    const { status } = await read($, timeline)

    if (status !== 'no-repo' && status !== 'error') {
      wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
    }
  } catch {
    // Opening the pane by hand (/gitdiff) shows the error.
  }
}

/**
 * A pane opened at session start is unasked, and a desktop that has not attached yet
 * seats it late or never. The first prompt of a repository session asks again: opened
 * with the person's prompt behind it, it is seated at any width.
 */
const offerOnce = async ($: EngineInterface) => {
  if (position !== 'pane' || hasOffered) {
    return
  }

  try {
    const { status } = await read($, timeline)

    if (status === 'loading') {
      return
    }

    hasOffered = true

    if (!wasPlaced && status !== 'no-repo' && status !== 'error') {
      wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
    }
  } catch {
    // The pane stays as it was; /gitdiff opens it by hand.
  }
}

export const register: Register = (on, options) => {
  position = options.position === 'pane' ? 'pane' : 'band'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gitdiff', description: 'Open the Git Diff files view (what changed, file by file)' })
    void begin($)

    return next(e)
  })

  on('command.run', { command: 'gitdiff' }, async $ => {
    await refresh($).catch(() => undefined)

    const opened = await $.ui.open(PANE_ARGS)

    wasPlaced = opened.isPlaced

    return { text: opened.isPlaced ? 'Git Diff pane opened.' : `Git Diff pane is waiting: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    await offerOnce($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    scheduleRefresh($)

    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (WATCHED.has(e.tool)) {
      scheduleRefresh($)
    }

    return ran
  })

  // The strip above the prompt: drawn in a repository, left alone elsewhere.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (position !== 'band' || e.props.hasSurvey) {
      return next(e)
    }

    const t = await read($, timeline)

    if (t.status !== 'ready' && t.status !== 'error') {
      return next(e)
    }

    const kit = kitOf($.ui.resolve(e), e.surface)
    const { Text } = kit

    return t.status === 'ready' ? (
      strip(kit, t, e.props.bodyColumns, actionsFor($))
    ) : (
      <Text color={ERROR}>{`Git Diff: git failed: ${t.message}`}</Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, timeline)

    return paneView(kitOf($.ui.resolve(e), e.surface), t, e.props.bodyColumns, actionsFor($))
  })
}
