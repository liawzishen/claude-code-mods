import type { GitDiffBranch, GitDiffCommit, GitDiffStat, GitDiffTimeline } from '../types'
import { LOG_LIMIT } from './git'
import type { Loaded } from './git'

export type Range = { from: number; to: number }

/** The id of the uncommitted-changes node, after the last commit. */
export const WORKING = 'working'

export const INITIAL: GitDiffTimeline = {
  status: 'loading',
  message: '',
  cwd: '',
  branch: '',
  mode: 'history',
  commits: [],
  hasWorking: false,
  untracked: 0,
  baseOfOldest: '',
  from: 0,
  to: 0,
  start: -1,
  isPinned: false,
  branches: [],
  viewing: '',
  limit: LOG_LIMIT,
  hasMore: false,
  fetchedAt: 0,
  checkedAt: 0,
  isStale: false,
  fetch: 'idle',
  fetchNote: '',
  problem: '',
  base: '',
  compare: '',
  branchCompare: null,
  stat: null,
  statKey: '',
  statError: '',
  open: [],
  patches: [],
}

type Nodes = Pick<GitDiffTimeline, 'commits' | 'hasWorking'>
type Picked = Nodes & Range & Pick<GitDiffTimeline, 'baseOfOldest' | 'mode' | 'base' | 'compare'>

/** One id per timeline node, oldest first: commit shas, then `WORKING` when dirty. */
export const nodeIds = (t: Nodes): string[] => [
  ...t.commits.map(commit => commit.sha),
  ...(t.hasWorking ? [WORKING] : []),
]

/** The revision node `index` stands for; -1 is what the oldest commit is compared with. */
export const refOf = (t: Nodes & Pick<GitDiffTimeline, 'baseOfOldest'>, index: number): string =>
  index < 0 ? t.baseOfOldest : (nodeIds(t)[index] ?? '')

/** The revisions of the `git diff` the pick shows: two, one against the working tree, or base...compare. */
export const diffSpec = (t: Picked): string[] => {
  if (t.mode === 'branches') {
    return [`${t.base}...${t.compare}`]
  }

  const to = refOf(t, t.to)

  return to === WORKING ? [refOf(t, t.from)] : [refOf(t, t.from), to]
}

/** What a stat or a patch was read for. */
export const selectionKey = (t: Picked): string =>
  t.mode === 'branches' ? `${t.base}...${t.compare}` : `${refOf(t, t.from)}..${refOf(t, t.to)}`

/** A commit on its own: against the node before it. */
export const commitRange = (index: number): Range => ({ from: index - 1, to: index })

/**
 * A new newer end, picked from the To list: a single commit stays a single commit, the one
 * picked; a range keeps its older end while that is still older.
 */
export const withTo = ({ from, to }: Range, index: number): Range =>
  from === to - 1 || from >= index ? commitRange(index) : { from, to: index }

/**
 * A press on a dot of the track, as a range slider takes a click: the nearer knob moves to it (a
 * dot beyond a knob, that knob; a tie, the newer one). A press on a knob shows that commit alone.
 */
export const clickNode = ({ from, to }: Range, index: number): Range => {
  if (index === to || index === from) {
    return commitRange(index)
  }

  if (index > to) {
    return { from, to: index }
  }

  return index < from || index - from < to - index ? { from: index, to } : { from, to: index }
}

/** A new older end, picked from the From list: it must stay older than the newer end. */
export const withFrom = ({ from, to }: Range, index: number): Range =>
  index >= -1 && index < to ? { from: index, to } : { from, to }

/**
 * The pick moved one node older (`delta` -1) or newer (1), both ends at once: a single commit
 * becomes the one before or after it. Null when that runs off the history loaded.
 */
export const shifted = ({ from, to }: Range, delta: number, total: number): Range | null =>
  from + delta < -1 || to + delta > total - 1 ? null : { from: from + delta, to: to + delta }

/** The commits a history comparison takes in, newest first; the working tree is none of them. */
export const rangeCommits = (t: Nodes & Range): GitDiffCommit[] =>
  t.commits.slice(Math.max(0, t.from + 1), Math.min(t.to + 1, t.commits.length)).reverse()

/** The newest step: the newest node on its own. */
export const defaultRange = (total: number): Range => commitRange(total - 1)

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The three phrases of a summary: `4 files changed`, `+172`, `−35`; null while unread. */
export const describeStat = (stat: GitDiffStat | null) =>
  stat === null
    ? null
    : {
        files: `${stat.files.length} file${stat.files.length === 1 ? '' : 's'} changed`,
        added: `+${grouped(stat.added)}`,
        deleted: `−${grouped(stat.deleted)}`,
      }

/** A merge's subject by its pull request or branch; any other subject as it is. */
const subjectName = (subject: string): string => {
  const pull = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject)

  if (pull !== null) {
    return `PR #${pull[1]} ${pull[2]}`
  }

  const branch = /^Merge branch '([^']+)'/.exec(subject)

  return branch === null ? subject : `Merge ${branch[1]}`
}

const firstLine = (text: string) => text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

/** A GitLab merge's request number, from the `See merge request group/project!123` line it carries. */
const mergeRequestOf = (commit: Pick<GitDiffCommit, 'subject' | 'body'>) =>
  /^Merge branch '/.test(commit.subject) ? (/See merge request \S*!(\d+)/.exec(commit.body)?.[1] ?? null) : null

/** A commit button's label: its pull or merge request number, else its short sha. */
export const buttonLabel = (commit: GitDiffCommit): string => {
  const pull = /^Merge pull request #(\d+)/.exec(commit.subject)

  if (pull !== null) {
    return `#${pull[1]}`
  }

  const request = mergeRequestOf(commit)

  return request === null ? commit.short : `!${request}`
}

/**
 * A commit as the timeline names it: a merge by its pull or merge request's title, else its
 * subject. Whole: the row drawing it cuts it to the room it has.
 */
export const commitTitle = (commit: Pick<GitDiffCommit, 'subject' | 'body'>): string => {
  const title = firstLine(commit.body)
  const pull = /^Merge pull request #(\d+)/.exec(commit.subject)

  if (pull !== null) {
    return title === '' ? subjectName(commit.subject) : `#${pull[1]} ${title}`
  }

  const request = mergeRequestOf(commit)

  return request !== null && title !== '' && !title.startsWith('See merge request')
    ? `!${request} ${title}`
    : subjectName(commit.subject)
}

/**
 * What a fetch changed among the remote branches, in words: how many moved, appeared or were
 * deleted on the remote.
 */
export const describeFetch = (before: readonly GitDiffBranch[], after: readonly GitDiffBranch[]): string => {
  const was = new Map(before.filter(branch => branch.isRemote).map(branch => [branch.name, branch.sha]))
  const now = new Map(after.filter(branch => branch.isRemote).map(branch => [branch.name, branch.sha]))
  const updated = [...now].filter(([name, sha]) => was.has(name) && was.get(name) !== sha).length
  const added = [...now.keys()].filter(name => !was.has(name)).length
  const removed = [...was.keys()].filter(name => !now.has(name)).length
  const parts = [
    updated > 0 ? `${updated} updated` : '',
    added > 0 ? `${added} new` : '',
    removed > 0 ? `${removed} removed` : '',
  ].filter(part => part !== '')

  return parts.length === 0 ? 'nothing new' : parts.join(', ')
}

/**
 * A fetch the last load left running is not running now: the state is the host's and outlives a
 * reload, and the fetch it names went with the old module.
 */
export const settleFetch = (t: GitDiffTimeline): GitDiffTimeline =>
  t.fetch === 'running' ? { ...t, fetch: 'idle', fetchNote: '' } : t

/**
 * The leftmost node a window keeps after a refresh: the commit it began with, found again by
 * its sha, so older commits loaded in front of it do not move the window. -1 follows the newest.
 */
const windowStart = (prev: GitDiffTimeline, ids: readonly string[]): number => {
  const first = prev.start < 0 ? undefined : nodeIds(prev)[prev.start]
  const at = first === undefined ? -1 : ids.indexOf(first)

  return at < 0 ? -1 : at
}

/** The branches compared: kept while they exist, else origin's default against the current one. */
const branchPick = (prev: GitDiffTimeline, loaded: Loaded, isSameRepo: boolean) => {
  const names = new Set(loaded.branches.map(branch => branch.name))
  const kept = (name: string) => (isSameRepo && names.has(name) ? name : '')
  const base = kept(prev.base) || loaded.defaultBase || loaded.branches[0]?.name || ''
  const current = names.has(loaded.branch) ? loaded.branch : ''
  const compare =
    kept(prev.compare) || current || loaded.branches.find(branch => branch.name !== base)?.name || base

  return { base, compare }
}

/** The next state once git answered; keeps what the person picked while it still exists. */
export const merge = (prev: GitDiffTimeline, loaded: Loaded, cwd: string): GitDiffTimeline => {
  const isSameRepo = prev.cwd === cwd
  // What the person chose, and what a fetch said, outlast a refresh, and a git that fails for a moment.
  const kept = isSameRepo ? prev : INITIAL
  const bare: GitDiffTimeline = {
    ...INITIAL,
    cwd,
    status: loaded.status,
    message: loaded.message,
    branch: loaded.branch,
    mode: kept.mode,
    viewing: kept.viewing,
    limit: kept.limit,
    fetchedAt: kept.fetchedAt,
    checkedAt: kept.checkedAt,
    isStale: kept.isStale,
    fetch: kept.fetch,
    fetchNote: kept.fetchNote,
    // A state kept from an older version has no `problem`.
    problem: kept.problem || '',
  }

  if (loaded.status !== 'ready') {
    return bare
  }

  const next: GitDiffTimeline = {
    ...bare,
    commits: loaded.commits,
    hasWorking: loaded.hasWorking,
    untracked: loaded.untracked,
    baseOfOldest: loaded.baseOfOldest,
    branches: loaded.branches,
    viewing: loaded.viewing,
    hasMore: loaded.commits.length >= bare.limit,
    ...branchPick(prev, loaded, isSameRepo),
  }
  const ids = nodeIds(next)
  const locate = (ref: string): number | null => {
    if (ref === '') {
      return null
    }

    if (ref === next.baseOfOldest) {
      return -1
    }

    const index = ids.indexOf(ref)

    return index < 0 ? null : index
  }
  const from = isSameRepo && prev.isPinned ? locate(refOf(prev, prev.from)) : null
  const to = isSameRepo && prev.isPinned ? locate(refOf(prev, prev.to)) : null
  const pick = from !== null && to !== null && to > from ? { from, to } : null
  const merged: GitDiffTimeline = {
    ...next,
    ...(pick ?? defaultRange(ids.length)),
    isPinned: pick !== null,
    start: isSameRepo && loaded.viewing === prev.viewing ? windowStart(prev, ids) : -1,
    branchCompare: isSameRepo ? prev.branchCompare : null,
  }

  // What is on screen stays until the fresh answer lands, unless the pick moved.
  return selectionKey(merged) === prev.statKey
    ? { ...merged, stat: prev.stat, statKey: prev.statKey, statError: prev.statError, open: prev.open, patches: prev.patches }
    : merged
}
