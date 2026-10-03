import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, RenderSurface, Timer, UiOpenResult } from 'claude-code'

import type { GitDiffCommit, GitDiffFile, GitDiffPatch, GitDiffStat, GitDiffTimeline } from '../types'
import { branchCard, historyCard } from './card'
import type { CardNode } from './card'
import { EMPTY_TREE, LOG_LIMIT, MAX_LOG, fetchAll, fetchHeadPath, loadBranchCompare, loadPatch, loadStat, loadTimeline } from './git'
import type { Loaded, Run } from './git'
import { ARROW_W, SLOT_W, dayLabels, formatTime, leadOf, resolveStart, revealStart, shortDate, visibleCount } from './layout'
import {
  INITIAL,
  WORKING,
  buttonLabel,
  clickNode,
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
  shifted,
  withFrom,
  withTo,
} from './model'
import type { Range } from './model'

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
  /** A press on a dot's label, by the node's id, the track `count` nodes wide: the nearer knob moves there. */
  pressNode: (id: string, count: number) => void
  /** Pick the newer or the older end of the comparison by its node's id, the track `count` nodes wide. */
  pickTo: (id: string, count: number) => void
  pickFrom: (id: string, count: number) => void
  /** Move the comparison one commit older (-1) or newer (1). */
  shift: (delta: number, count: number) => void
  pickBranch: (side: 'base' | 'compare', name: string) => void
  swap: () => void
  /** Show another branch's history; '' is the checked-out one. */
  viewBranch: (name: string) => void
  fetch: () => void
  toggleFile: (path: string) => void
}

const PANE = 'git-diff'
const PANE_ARGS = { id: PANE, title: 'Git Diff', rows: 24, columns: 96 } as const

/** Tools whose calls can change what git sees. */
const WATCHED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const REFRESH_DELAY_MS = 1200
/** How long a command or a prompt waits for the surface to say it drew the pane. */
const OPEN_WAIT_MS = 2000
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
  let checkedAt = 0

  try {
    const path = t.branches.some(branch => branch.isRemote) ? await fetchHeadPath(run, cwd) : ''

    if (path !== '') {
      fetchedAt = Math.floor((await $.fs.stat(path)).mtimeMs / 1000)
      checkedAt = Math.floor((await $.clock.now()) / 1000)
    }
  } catch {
    // No FETCH_HEAD yet (never fetched since the clone), or git did not say: the age is unknown.
  }

  const isStale = checkedAt > 0 && checkedAt - fetchedAt > STALE_AFTER_S

  await update($, timeline, cur => ({ ...cur, fetchedAt, checkedAt, isStale }))
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

/**
 * Opens the files view, and says whether it is drawn; null when the surface has not said within
 * `ms`. A desktop can draw the pane and be slow to say so, or not say at all: a command or a
 * prompt waiting on it would never end.
 */
const openWithin = ($: EngineInterface, ms: number): Promise<UiOpenResult | null> =>
  new Promise(resolve => {
    let timer: Timer | undefined

    try {
      timer = $.clock.after(ms, () => resolve(null))
    } catch {
      // No clock to time it by: the answer alone ends the wait.
    }

    $.ui.open(PANE_ARGS).then(
      opened => {
        timer?.cancel()
        wasPlaced = opened.isPlaced
        resolve(opened)
      },
      () => {
        timer?.cancel()
        resolve(null)
      },
    )
  })

/**
 * Shows what the person picked: the strip moves at once, the files view opens beside it, and the
 * diff is read. The open is not waited for: a desktop can be slow to say it drew the pane, or not
 * say it at all, and the pick must not wait on that.
 */
const show = async ($: EngineInterface, change: (t: GitDiffTimeline) => GitDiffTimeline) => {
  await update($, timeline, t => {
    const next = { ...change(t), problem: '' }

    return selectionKey(next) === selectionKey(t)
      ? next
      : { ...next, stat: null, statKey: '', statError: '', open: [], patches: [] }
  })
  void openDetails($)
  await loadSelection($, false)
}

/** The node a list's value names: a commit's sha or WORKING, or the commit before the oldest (-1); null when gone. */
const indexOfRef = (t: GitDiffTimeline, id: string): number | null => {
  if (id !== '' && id === t.baseOfOldest) {
    return -1
  }

  const index = nodeIds(t).indexOf(id)

  return index < 0 ? null : index
}

/** Moves the pick and shows it, the track scrolled to show it too; a pick that cannot be made changes nothing. */
const repick = async ($: EngineInterface, count: number, pick: (t: GitDiffTimeline) => Range | null) => {
  if (pick(await read($, timeline)) === null) {
    return
  }

  await show($, t => {
    const next = pick(t)

    return next === null
      ? t
      : { ...t, ...next, isPinned: true, start: revealStart(t.start, next.from, next.to, count, nodeIds(t).length) }
  })
}

const pressNode = ($: EngineInterface, id: string, count: number) =>
  repick($, count, t => {
    const index = indexOfRef(t, id)

    return index === null || index < 0 ? null : clickNode(t, index)
  })

const pickTo = ($: EngineInterface, id: string, count: number) =>
  repick($, count, t => {
    const index = indexOfRef(t, id)

    return index === null || index < 0 ? null : withTo(t, index)
  })

const pickFrom = ($: EngineInterface, id: string, count: number) =>
  repick($, count, t => {
    const index = indexOfRef(t, id)

    return index === null ? null : withFrom(t, index)
  })

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

/** Reads another page of older commits. The pick is pinned first, so it is found again among them. */
const loadOlder = async ($: EngineInterface) => {
  if (isLoadingOlder) {
    return
  }

  isLoadingOlder = true

  try {
    await update($, timeline, t => ({ ...t, limit: Math.min(MAX_LOG, t.limit + LOG_LIMIT), isPinned: true }))
    await refresh($)
  } finally {
    isLoadingOlder = false
  }
}

/** One commit older or newer. Past the oldest commit loaded, it reads older ones first. */
const shift = async ($: EngineInterface, delta: number, count: number) => {
  const t = await read($, timeline)

  if (delta < 0 && t.from <= -1 && canLoadOlder(t)) {
    await loadOlder($)
  }

  await repick($, count, cur => shifted(cur, delta, nodeIds(cur).length))
}

/** Shows another branch's history. It reads the branch as it is: nothing is checked out. */
const viewBranch = async ($: EngineInterface, name: string) => {
  await update($, timeline, t => ({
    ...t,
    viewing: name,
    limit: LOG_LIMIT,
    start: -1,
    isPinned: false,
    problem: '',
    stat: null,
    statKey: '',
    statError: '',
    open: [],
    patches: [],
  }))
  await refresh($)
}

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

/** Runs what a press started. One that fails says why on the strip, so a press never does nothing. */
const attempt = async ($: EngineInterface, work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    await update($, timeline, t => ({ ...t, problem: errorText(error) })).catch(() => undefined)
  }
}

const actionsFor = ($: EngineInterface): Actions => ({
  refresh: () => void attempt($, refresh($)),
  details: () => void openDetails($),
  mode: mode => void attempt($, show($, t => ({ ...t, mode }))),
  pressNode: (id, count) => void attempt($, pressNode($, id, count)),
  pickTo: (id, count) => void attempt($, pickTo($, id, count)),
  pickFrom: (id, count) => void attempt($, pickFrom($, id, count)),
  shift: (delta, count) => void attempt($, shift($, delta, count)),
  pickBranch: (side, name) => void attempt($, pickBranch($, side, name)),
  swap: () => void attempt($, show($, t => ({ ...t, base: t.compare, compare: t.base }))),
  viewBranch: name => void attempt($, viewBranch($, name)),
  fetch: () => void attempt($, fetchRemotes($)),
  toggleFile: path => void attempt($, toggleFile($, path)),
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

/** A node as the card's pill names it: `#123`, a short sha, `Now`, `empty tree`. */
const nodeTag = (t: GitDiffTimeline, index: number) => {
  if (index < 0) {
    return isEmptyTree(t.baseOfOldest) ? 'empty tree' : t.baseOfOldest.slice(0, 7)
  }

  const commit = t.commits[index]

  return commit === undefined ? 'Now' : buttonLabel(commit)
}

const when = (seconds: number) => `${shortDate(seconds)}, ${formatTime(seconds)}`

/** How long before `now` that was, in words: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
const ago = (seconds: number, now: number) => {
  const past = Math.max(0, now - seconds)

  if (past < 60) {
    return 'just now'
  }

  return past < 3600
    ? `${Math.floor(past / 60)} min ago`
    : past < 86_400
      ? `${Math.floor(past / 3600)} h ago`
      : `${plural(Math.floor(past / 86_400), 'day')} ago`
}

const rangeTitle = (t: GitDiffTimeline) =>
  t.mode === 'branches'
    ? `${t.base} → ${t.compare}`
    : `${t.viewing === '' ? '' : `${t.viewing} · `}${nodeName(t, t.from)} → ${nodeName(t, t.to)}`

const roleOf = (t: GitDiffTimeline, index: number): CardNode['role'] =>
  index === t.to ? 'compare' : index === t.from ? 'base' : index > t.from && index < t.to ? 'between' : 'outside'

/** The commits the track shows: where they start and how many. The pick is always among them. */
const windowOf = (t: GitDiffTimeline, columns: number) => {
  const total = nodeIds(t).length
  const count = visibleCount(columns, total)
  const start = resolveStart(revealStart(t.start, t.from, t.to, count, total), count, total)

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

/** Up to MAX_OPTIONS node indexes from `lo` to `hi`, those nearest `around`, newest first. */
const nearby = (lo: number, hi: number, around: number): number[] => {
  const size = Math.max(0, Math.min(MAX_OPTIONS, hi - lo + 1))
  const first = Math.max(lo, Math.min(around - Math.floor(size / 2), hi - size + 1))

  return Array.from({ length: size }, (_, k) => first + size - 1 - k)
}

/** A node as a list names it: its pull request or message, then its day. */
const optionLabel = (t: GitDiffTimeline, index: number) => {
  const commit = t.commits[index]

  if (index < 0 || commit === undefined) {
    return clip(index < 0 ? nodeName(t, index) : 'Now · uncommitted changes', 44)
  }

  return `${clip(commitTitle(commit), 36)} · ${shortDate(commit.time)}`
}

/** The To list: the nodes around the newer end. The From list: those older than it, down to before the oldest. */
const toOptions = (t: GitDiffTimeline) =>
  nearby(0, nodeIds(t).length - 1, t.to).map(i => ({ value: refOf(t, i), label: optionLabel(t, i) }))

const fromOptions = (t: GitDiffTimeline) =>
  nearby(-1, t.to - 1, t.from).map(i => ({ value: refOf(t, i), label: optionLabel(t, i) }))

/**
 * A view tab: the open one a plain button, the other quiet. Not `primary`: that marks the newer
 * end of the comparison under the track, the one thing on the strip that should stand out.
 */
const tabLook = (isOpen: boolean) => (isOpen ? { variant: 'secondary' as const } : { plain: true as const, dimColor: true })

/** Whether the comparison reads a remote branch (`origin/main`): only then does the age of this computer's copy matter. */
const readsRemote = (t: GitDiffTimeline) => {
  const names = t.mode === 'history' ? [t.viewing] : [t.base, t.compare]

  return t.branches.some(branch => branch.isRemote && names.includes(branch.name))
}

/**
 * How old the remote branches are, and a way to bring them up to date, while a remote branch is
 * in view. `origin/main` is this computer's copy of the server's main as of the last fetch: it is
 * never live, so the chip says when.
 */
const remoteChip = (t: GitDiffTimeline, on: Actions, { Box, Text, Button }: Pick<Kit, 'Box' | 'Text' | 'Button'>) => {
  if (!readsRemote(t)) {
    return null
  }

  if (t.fetch === 'running') {
    return <Text dimColor>Fetching…</Text>
  }

  // Without the time it was read at (a state kept from an older version has none), the day and time.
  const age = t.checkedAt > 0 ? ago(t.fetchedAt, t.checkedAt) : when(t.fetchedAt)

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {t.fetch === 'failed' ? (
        <Text color={ERROR}>{t.fetchNote}</Text>
      ) : t.fetchedAt === 0 ? (
        <Text dimColor>Fetch time unknown</Text>
      ) : (
        <Text {...(t.isStale ? { color: WARNING } : { dimColor: true })}>
          {`Fetched ${age}${t.fetchNote === '' ? '' : ` · ${t.fetchNote}`}`}
        </Text>
      )}
      <Button key="fetch" plain label="Fetch" onPress={on.fetch} />
    </Box>
  )
}

/** The strip's first row: History or Branches and whose history, then the files view and a refresh. */
const header = (kit: Kit, t: GitDiffTimeline, on: Actions): RenderElement => {
  const { Box, Text, Button, Select } = kit
  const isHistory = t.mode === 'history'
  // What went wrong with the last press, or with reading its diff; a state kept from an older version has no `problem`.
  const problem = t.problem || t.statError
  const warning = problem ? (
    <Text color={ERROR} wrap="truncate-end">
      {problem}
    </Text>
  ) : null

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent="space-between">
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Button key="mode:history" label="History" {...tabLook(isHistory)} onPress={() => on.mode('history')} />
        <Button key="mode:branches" label="Branches" {...tabLook(!isHistory)} onPress={() => on.mode('branches')} />
        {isHistory &&
          (Select !== null && t.branches.length > 0 ? (
            <Select
              key="view-branch"
              label="Branch"
              options={viewOptions(t)}
              value={t.viewing}
              onSelect={name => on.viewBranch(name)}
            />
          ) : (
            <Text dimColor>{t.viewing === '' ? t.branch : t.viewing}</Text>
          ))}
      </Box>
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        {warning}
        {remoteChip(t, on, kit)}
        <Button key="details" label="View diff" onPress={on.details} />
        <Button key="refresh" plain label="↻" onPress={on.refresh} />
      </Box>
    </Box>
  )
}

/** The totals as text: the files view's first line. */
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
const trackRow = (kit: Kit, t: GitDiffTimeline, columns: number, indexes: number[]): RenderElement => {
  const { Box, Text } = kit
  const newest = nodeIds(t).length - 1
  // Whether the stretch of track from node `a` to the next one is inside the pick.
  const isIn = (a: number) => t.from <= a && a + 1 <= t.to

  return (
    <Box flexDirection="row">
      <Box width={leadOf(indexes.length, columns)} />
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

/** History's picture: the card on the desktop; on the terminal the pick and totals in a line, over a slider in text. */
const historyView = (kit: Kit, t: GitDiffTimeline, columns: number, win: ReturnType<typeof windowOf>): RenderElement => {
  const { Box, Text, Svg } = kit
  const { total, start, indexes } = win
  const range = { from: nodeTag(t, t.from), to: nodeTag(t, t.to) }
  const title = `${t.viewing === '' ? t.branch : t.viewing} · ${t.commits.length}${t.hasMore ? '+' : ''} commit${t.commits.length === 1 ? '' : 's'}`

  if (Svg === null) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>{`${range.from} → ${range.to}`}</Text>
          <Text dimColor>·</Text>
          {totals(kit, t)}
        </Box>
        {trackRow(kit, t, columns, indexes)}
      </Box>
    )
  }

  const nodes: CardNode[] = indexes.map(i => {
    const commit = t.commits[i]

    return {
      role: roleOf(t, i),
      isWorking: commit === undefined,
      tip: commit === undefined ? 'Uncommitted changes' : `${commit.short} · ${commitTitle(commit)} · +${commit.added} −${commit.deleted}`,
    }
  })

  return (
    <Svg
      source={historyCard({
        columns,
        nodes,
        title,
        range,
        stats: describeStat(t.stat),
        older: start,
        newer: total - start - indexes.length,
      })}
      alt={`${title}: ${rangeTitle(t)}`}
    />
  )
}

/**
 * The track's handles, right under it: each dot's label, its day or time, is a button under that
 * dot, and ‹ and › sit under the track's ends, as in the mockup. The desktop draws the card as a
 * picture, which takes no clicks: these are the timeline's to press. A press on a label moves the
 * nearer knob there, as a range slider takes a click; on a knob's own label, that commit alone.
 * ‹ and › move the whole comparison one commit.
 */
const handleRow = ({ Box, Button, Svg }: Kit, t: GitDiffTimeline, columns: number, on: Actions, win: ReturnType<typeof windowOf>): RenderElement => {
  const { total, count, indexes } = win
  const ids = nodeIds(t)
  const labels = dayLabels(indexes.map(i => t.commits[i]?.time ?? null))
  const gap = leadOf(indexes.length, columns) - ARROW_W
  // The terminal draws a `primary` Button as `[ label ]`, wider than a slot: its knobs are marked on the slider above.
  const lookOf = (i: number) => {
    const role = roleOf(t, i)

    return Svg !== null && role === 'compare'
      ? { variant: 'primary' as const }
      : Svg !== null && role === 'base'
        ? { variant: 'secondary' as const }
        : { plain: true as const, dimColor: role === 'outside' }
  }

  return (
    <Box flexDirection="row" alignItems="center">
      <Box width={ARROW_W}>
        <Button key="older" plain label="‹" dimColor={t.from <= -1 && !canLoadOlder(t)} onPress={() => on.shift(-1, count)} />
      </Box>
      {gap > 0 && <Box width={gap} />}
      {indexes.map((i, k) => (
        <Box width={SLOT_W} justifyContent="center">
          <Button key={`node:${i}`} label={labels[k] ?? ''} {...lookOf(i)} onPress={() => on.pressNode(ids[i] ?? '', count)} />
        </Box>
      ))}
      <Box flexGrow={1} />
      <Box width={ARROW_W} justifyContent="flex-end">
        <Button key="newer" plain label="›" dimColor={t.to >= total - 1} onPress={() => on.shift(1, count)} />
      </Box>
    </Box>
  )
}

/**
 * History's lists, under the handles: the two ends of the comparison by commit message and day,
 * to pick one the track does not show. The phone has no lists: its handles do it all.
 */
const historyPickers = ({ Box, Text, Select }: Kit, t: GitDiffTimeline, on: Actions, count: number): RenderElement | null =>
  Select === null ? null : (
    <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap" justifyContent="center">
      <Select key="from" label="From" options={fromOptions(t)} value={refOf(t, t.from)} onSelect={id => on.pickFrom(id, count)} />
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text dimColor>→</Text>
        <Select key="to" label="To" options={toOptions(t)} value={refOf(t, t.to)} onSelect={id => on.pickTo(id, count)} />
      </Box>
    </Box>
  )

/** Branches: the fork card, or a line of words on the terminal. */
const branchView = (kit: Kit, t: GitDiffTimeline, columns: number): RenderElement => {
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

/** Branches' controls, under the card: the two branches, the base first, and a swap. */
const branchPickers = ({ Box, Text, Button, Select }: Kit, t: GitDiffTimeline, on: Actions): RenderElement | null => {
  if (Select === null) {
    return null
  }

  if (t.branches.length === 0) {
    return <Text dimColor>No branches to compare.</Text>
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent="center">
      <Select key="branch-base" label="Base" options={branchOptions(t)} value={t.base} onSelect={name => on.pickBranch('base', name)} />
      <Text dimColor>→</Text>
      <Select
        key="branch-compare"
        label="Compare"
        options={branchOptions(t)}
        value={t.compare}
        onSelect={name => on.pickBranch('compare', name)}
      />
      <Button key="swap" label="⇄ Swap" onPress={on.swap} />
    </Box>
  )
}

/** The strip: a row of what to show, the card with its handles right under it, then the lists. */
const strip = (kit: Kit, t: GitDiffTimeline, columns: number, on: Actions): RenderElement => {
  const { Box } = kit
  const win = windowOf(t, columns)

  return t.mode === 'history' ? (
    <Box flexDirection="column">
      {header(kit, t, on)}
      {historyView(kit, t, columns, win)}
      {handleRow(kit, t, columns, on, win)}
      {historyPickers(kit, t, on, win.count)}
    </Box>
  ) : (
    <Box flexDirection="column">
      {header(kit, t, on)}
      {branchView(kit, t, columns)}
      {branchPickers(kit, t, on)}
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
      await openWithin($, OPEN_WAIT_MS)
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

    const opened = await openWithin($, OPEN_WAIT_MS)

    return {
      text:
        opened === null
          ? 'Opening the Git Diff pane.'
          : opened.isPlaced
            ? 'Git Diff pane opened.'
            : `Git Diff pane is waiting: ${opened.reason}`,
    }
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
