import { describe, expect, test } from 'claude-code/testing'

import type { GitDiffTimeline } from '../types'
import type { Loaded } from '../hooks/git'
import {
  INITIAL,
  WORKING,
  buttonLabel,
  clickCommit,
  commitRange,
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
} from '../hooks/model'

const commit = (n: number) => ({
  sha: `sha${n}`.padEnd(40, '0'),
  short: `sha${n}`,
  time: 1_700_000_000 + n * 3600,
  subject: `commit ${n}`,
  body: '',
  added: n,
  deleted: 0,
})

const branch = (name: string, sha: string, time: number, isRemote = false) => ({
  name,
  ref: `${isRemote ? 'refs/remotes' : 'refs/heads'}/${name}`,
  sha,
  time,
  isRemote,
})

const BRANCHES = [branch('main', 'm1', 3), branch('feature', 'f1', 2), branch('origin/main', 'o1', 1, true)]

const loaded = (count: number, hasWorking = false): Loaded => ({
  status: 'ready',
  message: '',
  branch: 'main',
  commits: Array.from({ length: count }, (_, i) => commit(i)),
  hasWorking,
  untracked: 0,
  baseOfOldest: 'parent0',
  branches: BRANCHES,
  defaultBase: 'origin/main',
  viewing: '',
})

const ready = (count: number, hasWorking = false): GitDiffTimeline => merge(INITIAL, loaded(count, hasWorking), '/repo')

describe('what is picked', () => {
  test('nodes are the commits then the working tree, and -1 is what the oldest commit is compared with', () => {
    const t = ready(2, true)

    expect(nodeIds(t)).toEqual([commit(0).sha, commit(1).sha, WORKING])
    expect(refOf(t, -1)).toBe('parent0')
    expect(refOf(t, 2)).toBe(WORKING)
  })

  test('the default is the newest commit on its own, or HEAD against the working tree', () => {
    expect(ready(5)).toMatchObject({ from: 3, to: 4, status: 'ready', mode: 'history' })
    expect(ready(5, true)).toMatchObject({ from: 4, to: 5 })
  })

  test('a single commit shows its own changes', () => {
    expect(ready(1)).toMatchObject({ status: 'ready', from: -1, to: 0 })
  })

  test('a commit is shown against its parent', () => {
    expect(commitRange(4)).toEqual({ from: 3, to: 4 })
    expect(commitRange(0)).toEqual({ from: -1, to: 0 })
  })

  test('one click shows that commit and waits; a second click compares the two; the next starts over', () => {
    const t = ready(6)
    const one = clickCommit(t, 2)
    const two = clickCommit({ ...t, ...one }, 5)

    expect(one).toEqual({ from: 1, to: 2, anchor: commit(2).sha })
    expect(two).toEqual({ from: 2, to: 5, anchor: '' })
    expect(clickCommit({ ...t, ...one }, 0)).toEqual({ from: 0, to: 2, anchor: '' })
    expect(clickCommit({ ...t, ...two }, 4)).toEqual({ from: 3, to: 4, anchor: commit(4).sha })
    expect(clickCommit({ ...t, ...one }, 2)).toEqual({ from: 1, to: 2, anchor: '' })
  })

  test('the commits a comparison takes in, newest first', () => {
    expect(rangeCommits({ ...ready(6), from: 1, to: 4 }).map(c => c.subject)).toEqual(['commit 4', 'commit 3', 'commit 2'])
    expect(rangeCommits({ ...ready(3, true), from: 2, to: 3 })).toEqual([])
    expect(rangeCommits({ ...ready(3), from: -1, to: 0 }).map(c => c.subject)).toEqual(['commit 0'])
  })

  test('the diff arguments and key of a pick, in history and between branches', () => {
    const t = ready(5)
    const working = ready(5, true)
    const oldest = { ...t, from: -1, to: 0 }
    const branches = { ...t, mode: 'branches' as const, base: 'origin/main', compare: 'feature' }

    expect(diffSpec(t)).toEqual([commit(3).sha, commit(4).sha])
    expect(selectionKey(t)).toBe(`${commit(3).sha}..${commit(4).sha}`)
    expect(diffSpec(working)).toEqual([commit(4).sha])
    expect(diffSpec(oldest)).toEqual(['parent0', commit(0).sha])
    expect(diffSpec(branches)).toEqual(['origin/main...feature'])
    expect(selectionKey(branches)).toBe('origin/main...feature')
  })
})

describe('refreshing', () => {
  test('a picked range is kept by sha; otherwise the view follows the newest commit', () => {
    const picked: GitDiffTimeline = { ...ready(5), from: 1, to: 2, isPinned: true, start: 0 }
    const grown = merge(picked, loaded(6), '/repo')
    const followed = merge(ready(5), loaded(6), '/repo')
    const gone = merge(picked, { ...loaded(5), commits: loaded(5).commits.slice(2) }, '/repo')
    const elsewhere = merge(picked, loaded(6), '/other')

    expect(grown).toMatchObject({ from: 1, to: 2, isPinned: true, start: 0 })
    expect(followed).toMatchObject({ from: 4, to: 5, isPinned: false })
    expect(gone).toMatchObject({ from: 1, to: 2, isPinned: false })
    expect(elsewhere).toMatchObject({ from: 4, to: 5, isPinned: false, start: -1 })
  })

  test('branches default to the remote default branch against the current one, and keep a pick that still exists', () => {
    const t = ready(3)
    const picked = { ...t, mode: 'branches' as const, base: 'main', compare: 'feature' }
    const withoutFeature = { ...loaded(3), branches: BRANCHES.filter(b => b.name !== 'feature') }

    expect(t).toMatchObject({ base: 'origin/main', compare: 'main' })
    expect(merge(picked, loaded(3), '/repo')).toMatchObject({ mode: 'branches', base: 'main', compare: 'feature' })
    expect(merge(picked, withoutFeature, '/repo')).toMatchObject({ base: 'main', compare: 'main' })
  })

  test('the diff on screen and the open files stay while the pick is unchanged, and go when it moves', () => {
    const t = ready(5)
    const patch = { path: 'a.ts', hunks: '@@ -1 +1 @@\n-a\n+b', isCut: false, note: '' }
    const stat = { files: [{ path: 'a.ts', added: 1, deleted: 1 }], added: 1, deleted: 1 }
    const shown: GitDiffTimeline = { ...t, stat, statKey: selectionKey(t), open: ['a.ts'], patches: [patch] }

    expect(merge(shown, loaded(5), '/repo')).toMatchObject({ stat, open: ['a.ts'], patches: [patch] })
    expect(merge(shown, loaded(6), '/repo')).toMatchObject({ stat: null, open: [], patches: [] })
  })

  test('a first click still waiting survives a refresh while its commit is there', () => {
    const waiting: GitDiffTimeline = { ...ready(5), ...clickCommit(ready(5), 2), isPinned: true }

    expect(merge(waiting, loaded(6), '/repo').anchor).toBe(commit(2).sha)
    expect(merge(waiting, { ...loaded(5), commits: loaded(5).commits.slice(3) }, '/repo').anchor).toBe('')
  })

  test('outside a repository nothing is picked', () => {
    expect(merge(INITIAL, { ...loaded(0), status: 'no-repo', message: 'Not a git repository' }, '/tmp')).toMatchObject({
      status: 'no-repo',
      commits: [],
    })
  })
})

describe('words', () => {
  test('describeStat words the totals, and is null while the diff is unread', () => {
    const file = { path: 'a.ts', added: 1, deleted: 0 }

    expect(describeStat(null)).toBeNull()
    expect(describeStat({ files: [file], added: 1, deleted: 0 })).toEqual({ files: '1 file changed', added: '+1', deleted: '−0' })
    expect(describeStat({ files: [file, file], added: 1172, deleted: 35 })).toEqual({
      files: '2 files changed',
      added: '+1,172',
      deleted: '−35',
    })
  })

  test('a merge with no title in its message reads as its pull request or branch, any other subject whole', () => {
    const named = (subject: string) => commitTitle({ subject, body: '' })

    expect(named('Merge pull request #14 from liawzishen/premium-auth')).toBe('PR #14 premium-auth')
    expect(named('Merge pull request #20 from me/fix/tour-heading')).toBe('PR #20 fix/tour-heading')
    expect(named("Merge branch 'feature-x' into 'main'")).toBe('Merge feature-x')
    expect(named('x'.repeat(80))).toBe('x'.repeat(80))
  })

  test('a commit button reads as its pull or merge request number, else its short sha', () => {
    expect(buttonLabel({ ...commit(1), subject: 'Merge pull request #14 from a/b' })).toBe('#14')
    expect(buttonLabel({ ...commit(1), subject: "Merge branch 'x' into 'main'", body: 'T\n\nSee merge request g/p!123' })).toBe('!123')
    expect(buttonLabel(commit(1))).toBe('sha1')
  })

  test('a merge reads as the title of its pull or merge request', () => {
    const pull = { ...commit(1), subject: 'Merge pull request #14 from me/premium-auth' }

    expect(commitTitle({ ...pull, body: 'Premium auth: 50/50 split\n\nmore' })).toBe('#14 Premium auth: 50/50 split')
    expect(commitTitle(pull)).toBe('PR #14 premium-auth')
    expect(commitTitle({ ...commit(1), subject: "Merge branch 'map' into 'main'", body: 'Add the map\n\nSee merge request g/app!123' })).toBe(
      '!123 Add the map',
    )
    expect(commitTitle({ ...commit(1), subject: 'Fix the map', body: 'Details' })).toBe('Fix the map')
  })
})

describe('scrolling and branches', () => {
  const at = (t: GitDiffTimeline, n: number) => nodeIds(t)[n]

  test('older commits loaded in front of the window move nothing: it stays on the same commits', () => {
    const paged = { ...ready(8), start: 3, limit: 8 }
    const older = { ...loaded(8) }
    const more = { ...older, commits: [...Array.from({ length: 4 }, (_, i) => commit(100 + i)), ...older.commits] }
    const next = merge(paged, more, '/repo')

    expect(next.commits).toHaveLength(12)
    expect(at(next, next.start)).toBe(at(paged, 3))
    expect(next.start).toBe(7)
  })

  test('a window that follows the newest keeps following it, and one whose commit is gone follows it too', () => {
    expect(merge({ ...ready(8), start: -1 }, loaded(9), '/repo').start).toBe(-1)
    expect(merge({ ...ready(8), start: 3 }, { ...loaded(8), commits: loaded(8).commits.slice(5) }, '/repo').start).toBe(-1)
  })

  test('a window is not kept across another branch’s history', () => {
    const paged = { ...ready(8), start: 3 }

    expect(merge(paged, { ...loaded(8), viewing: 'feature' }, '/repo')).toMatchObject({ viewing: 'feature', start: -1 })
  })

  test('hasMore says git may hold older commits: the limit was filled', () => {
    expect(merge(INITIAL, loaded(60), '/repo')).toMatchObject({ limit: 60, hasMore: true })
    expect(merge(INITIAL, loaded(59), '/repo').hasMore).toBe(false)
    expect(merge({ ...ready(3), limit: 120 }, loaded(60), '/repo')).toMatchObject({ limit: 120, hasMore: false })
  })

  test('the branch viewed, the limit and what a fetch said outlast a refresh, and git failing for a moment', () => {
    const t = { ...ready(3), viewing: 'feature', limit: 120, fetchedAt: 99, isStale: true, fetch: 'failed' as const, fetchNote: 'no network' }
    const same = { viewing: 'feature', limit: 120, fetchedAt: 99, isStale: true, fetch: 'failed', fetchNote: 'no network' }

    expect(merge(t, { ...loaded(3), viewing: 'feature' }, '/repo')).toMatchObject(same)
    expect(merge(t, { ...loaded(3), status: 'error', message: 'locked', commits: [] }, '/repo')).toMatchObject(same)
    // Another repository starts afresh.
    expect(merge(t, { ...loaded(3), branches: [] }, '/other')).toMatchObject({ viewing: '', limit: 60, fetchedAt: 0, fetch: 'idle' })
  })

  test('a fetch the last load left running is not running after a reload; any other state stays', () => {
    const running = { ...ready(3), fetch: 'running' as const, fetchNote: 'x' }

    expect(settleFetch(running)).toMatchObject({ fetch: 'idle', fetchNote: '' })
    expect(settleFetch({ ...running, fetch: 'failed' as const })).toMatchObject({ fetch: 'failed', fetchNote: 'x' })
  })

  test('describeFetch counts the remote branches that moved, appeared or went', () => {
    const before = [branch('main', 'm1', 1), branch('origin/main', 'a', 1, true), branch('origin/old', 'b', 1, true), branch('origin/x', 'c', 1, true)]
    const after = [
      branch('main', 'm2', 2),
      branch('origin/main', 'a2', 2, true),
      branch('origin/x', 'c', 1, true),
      branch('origin/new', 'd', 2, true),
    ]

    expect(describeFetch(before, after)).toBe('1 updated, 1 new, 1 removed')
    expect(describeFetch(before, before)).toBe('nothing new')
    expect(describeFetch([], [])).toBe('nothing new')
  })
})
