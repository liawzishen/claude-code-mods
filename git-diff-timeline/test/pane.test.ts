import type { CommandRunInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const RS = '\u001e'
const US = '\u001f'
const GS = '\u001d'
const NUL = '\u0000'
const NUMSTAT = `12\t3\tsrc/app.tsx${NUL}-\t-\tlogo.png${NUL}5\t0\tREADME.md${NUL}`
const BASE = Math.floor(new Date(2026, 0, 2, 10, 15).getTime() / 1000)

const sha = (n: number) => String(n).padStart(40, '0')
const record = (n: number) =>
  `${RS}${sha(n)}${US}${sha(n).slice(0, 7)}${US}${BASE + n * 86_400}${US}commit ${n}${US}Body of commit ${n}${GS}\n\n 1 file changed, ${n + 1} insertions(+)\n`
const LOG = [5, 4, 3, 2, 1, 0].map(record).join('')
const patch = (path: string) =>
  path === 'logo.png'
    ? 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n`
/** `git for-each-ref` output; origin/main points at `originSha`. */
const branches = (originSha: string) =>
  [
    ['refs/heads/main', 'main', '9', '', 'a1'],
    ['refs/heads/feature', 'feature', '8', '', 'b1'],
    ['refs/remotes/origin/main', 'origin/main', '7', '', originSha],
  ]
    .map(fields => fields.join(US))
    .join('\n')

/** The test clock starts here, in milliseconds. */
const NOW = Date.UTC(2026, 9, 3, 12, 0)

const answer = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Opened = { value: { isPlaced: true } | { isPlaced: false; reason: string } }

const placed: Opened = { value: { isPlaced: true } }

const world = (
  on: On,
  {
    isDirty,
    open,
    fetchedAgo,
    fetchError,
    extraBranches = 0,
  }: { isDirty: boolean; open?: () => Opened; fetchedAgo?: number; fetchError?: string; extraBranches?: number },
) => {
  const diffs: string[][] = []
  const runs: string[][] = []
  const fetches: { env?: Record<string, string>; timeoutMs?: number }[] = []
  let isFetched = false

  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', () => ({ value: { command: 'gitdiff' } }))
  on('ui.open', open ?? (() => placed))

  if (fetchedAgo !== undefined) {
    // When the repository last fetched: git's FETCH_HEAD, `fetchedAgo` seconds before the clock.
    mock.clock(on, { now: NOW })
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW - fetchedAgo * 1000, isLink: false } }))
  }

  on('process.run', (_$, e) => {
    const argv = e.argv
    const [, sub, flag] = argv
    const last = argv[argv.length - 1] ?? ''

    runs.push([...argv])

    switch (sub) {
      case 'fetch':
        fetches.push({ env: e.init?.env, timeoutMs: e.init?.timeoutMs })
        isFetched = fetchError === undefined

        return fetchError === undefined ? answer('Fetching origin\n') : answer('', 1, fetchError)
      case 'rev-parse':
        if (flag === '--is-inside-work-tree') {
          return answer('true\n')
        }

        if (argv.includes('--git-path')) {
          return answer('.git/FETCH_HEAD\n')
        }

        return answer(argv.some(arg => arg.endsWith('^')) ? `${'9'.repeat(40)}\n` : `${sha(5)}\n`)
      case 'branch':
        return answer('main\n')
      case 'ls-files':
        return answer('')
      case 'for-each-ref':
        return answer(
          `${[
            branches(isFetched ? 'c2' : 'c1'),
            ...Array.from({ length: extraBranches }, (_, i) =>
              ['refs/remotes/origin/topic-' + i, 'origin/topic-' + i, String(5 - i / 1000), '', 'd' + i].join(US),
            ),
          ].join('\n')}\n`,
        )
      case 'symbolic-ref':
        return answer('origin/main\n')
      case 'rev-list':
        return answer('5\t9\n')
      case 'merge-base':
        return answer(`${sha(2)}\n`)
      case 'diff':
        diffs.push([...argv])

        if (argv.includes('-U3')) {
          return answer(patch(last))
        }

        return answer(argv.includes('HEAD') ? (isDirty ? NUMSTAT : '') : NUMSTAT)
      default:
        if (argv.includes('-1')) {
          return answer(record(2))
        }

        return answer(last.includes('..') ? record(4) + record(3) : LOG)
    }
  })

  return { diffs, runs, fetches }
}

const PANE = {
  title: 'Git Diff',
  isFocused: false,
  bodyColumns: 84,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 18 },
  view: {},
} as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

const PLUGIN = 'git-diff-timeline'

/** `/gitdiff` typed at the prompt, whole as the engine passes it: no arguments, a fullscreen terminal. */
const GITDIFF: CommandRunInput = {
  command: 'gitdiff',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
}

describe('the strip above the prompt', () => {
  test('desktop: the card, and From and To name the ends of the comparison; picking one shows it', async ($, on) => {
    let opens = 0

    world(on, {
      isDirty: true,
      open: () => {
        opens += 1

        return placed
      },
    })
    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })
    const options = async (key: string) => ((await band.find({ key }))?.props as { options: { value: string; label: string }[] }).options

    expect(await band.find({ type: 'Svg' })).toBeDefined()
    // History has a branch picker: another branch's history is read without checking it out.
    expect(await band.find({ key: 'view-branch' })).toMatchObject({ props: { value: '' } })
    // The open view is a plain tab, the other a quiet one.
    expect(await band.find({ key: 'mode:history' })).toMatchObject({ props: { variant: 'secondary' } })
    expect(await band.find({ key: 'mode:branches' })).toMatchObject({ props: { dimColor: true } })
    // The newest step: the last commit against the uncommitted changes.
    expect(await band.find({ key: 'from' })).toMatchObject({ props: { label: 'From', value: sha(5) } })
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { label: 'To', value: 'working' } })
    expect((await options('to'))[0]).toEqual({ value: 'working', label: 'Now · uncommitted changes' })
    expect((await options('to'))[1]?.label).toMatch(/^commit 5 · /)
    // From lists only what is older than To, down to what the oldest commit is compared with.
    expect((await options('from')).map(option => option.value)).toEqual([5, 4, 3, 2, 1, 0].map(sha).concat('9'.repeat(40)))
    // Nothing to click on the card: no button per commit, no hint to learn.
    expect(await band.find({ key: 'node:0' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'Click' })).toBeUndefined()
    expect(await band.find({ key: 'newer' })).toMatchObject({ props: { dimColor: true } })
    expect(await band.find({ key: 'older' })).toMatchObject({ props: { dimColor: false } })

    const before = opens

    // A commit on its own: To moves, and From follows it.
    await band.select({ key: 'to', value: sha(2) })

    expect(opens).toBe(before + 1)
    expect(await band.find({ key: 'from' })).toMatchObject({ props: { value: sha(1) } })
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: sha(2) } })

    // A range: From picked on its own, To kept.
    await band.select({ key: 'to', value: sha(5) })
    await band.select({ key: 'from', value: sha(2) })

    expect(await band.find({ key: 'from' })).toMatchObject({ props: { value: sha(2) } })
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: sha(5) } })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: 'commit 2 → commit 5' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '3 commits' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Body of commit 4' })).toBeDefined()
    expect(await pane.find({ key: 'file:src/app.tsx' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toMatchObject({ props: { format: 'diff', path: 'src/app.tsx' } })
  })

  test('terminal: no picture, a slider in text, and the same lists', async ($, on) => {
    world(on, { isDirty: false })
    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ type: 'Svg' })).toBeUndefined()
    expect(await band.find({ key: 'view-branch' })).toBeDefined()
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: sha(5) } })
    expect(await band.find({ type: 'Text', text: `${sha(4).slice(0, 7)} → ${sha(5).slice(0, 7)}` })).toBeDefined()

    await band.select({ key: 'from', value: sha(2) })

    // A knob at each end of the pick, the track between them drawn heavy, and the days under it.
    expect(await band.findAll({ type: 'Text', text: '◉' })).toHaveLength(2)
    expect(await band.find({ type: 'Text', text: '━━━━' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'Jan 4' })).toBeDefined()

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('Older and Newer step the comparison one commit, and the track follows it', async ($, on) => {
    world(on, { isDirty: true })
    await $.command.run(GITDIFF)

    // Room on the track for six of the seven nodes.
    const narrow = { ...BAND, bodyColumns: 60 }
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: narrow, viewport: { columns: 60, rows: 30 } })
    const ends = async () => [(await band.find({ key: 'from' }))?.props.value, (await band.find({ key: 'to' }))?.props.value]
    const card = async () => ((await band.find({ type: 'Svg' }))?.props as { source: string }).source

    expect(await ends()).toEqual([sha(5), 'working'])
    expect(await card()).toContain('>1 older<')

    await band.press({ key: 'older' })

    expect(await ends()).toEqual([sha(4), sha(5)])

    for (let step = 0; step < 5; step += 1) {
      await band.press({ key: 'older' })
    }

    // The oldest commit on its own, against the commit before it; the track went with it.
    expect(await ends()).toEqual(['9'.repeat(40), sha(0)])
    expect(await card()).toContain('>1 newer<')
    expect(await card()).not.toContain(' older<')
    expect(await band.find({ key: 'older' })).toMatchObject({ props: { dimColor: true } })

    // Nothing older to read: Older does nothing.
    await band.press({ key: 'older' })

    expect(await ends()).toEqual(['9'.repeat(40), sha(0)])

    await band.press({ key: 'newer' })

    expect(await ends()).toEqual([sha(0), sha(1)])
  })

  test('branches: two branches, how far apart they are, and what the compare branch adds', async ($, on) => {
    const { diffs } = world(on, { isDirty: false })

    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    await band.press({ key: 'mode:branches' })

    expect(await band.find({ key: 'branch-base' })).toMatchObject({ props: { value: 'origin/main' } })
    expect(await band.find({ key: 'branch-compare' })).toMatchObject({ props: { value: 'main' } })
    expect(await band.find({ type: 'Svg' })).toBeDefined()
    // History's own controls are gone with it.
    expect(await band.find({ key: 'view-branch' })).toBeUndefined()
    expect(await band.find({ key: 'older' })).toBeUndefined()

    await band.select({ key: 'branch-compare', value: 'feature' })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: '9 commits ahead, 5 behind' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(diffs.some(argv => argv.includes('origin/main...feature'))).toBe(true)

    await band.press({ key: 'swap' })

    expect(await band.find({ key: 'branch-base' })).toMatchObject({ props: { value: 'feature' } })
  })

  test('another branch’s history is read from its ref, with no checkout, and has no uncommitted changes', async ($, on) => {
    const { runs } = world(on, { isDirty: true })

    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })
    const toValues = async () => ((await band.find({ key: 'to' }))?.props as { options: { value: string }[] }).options.map(o => o.value)

    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: 'working' } })

    await band.select({ key: 'view-branch', value: 'origin/main' })

    const log = runs.filter(argv => argv[1] === 'log').at(-1)

    expect(log?.slice(-2)).toEqual(['refs/remotes/origin/main', '--'])
    expect(runs.some(argv => ['checkout', 'switch', 'reset', 'merge'].includes(argv[1] ?? ''))).toBe(false)
    expect(await band.find({ key: 'view-branch' })).toMatchObject({ props: { value: 'origin/main' } })
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: sha(5) } })
    expect(await toValues()).not.toContain('working')
    expect(await band.find({ type: 'Svg' })).toMatchObject({ props: { alt: expect.stringMatching(/^origin\/main · 6 commits/) } })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: 'origin/main · commit 4 → commit 5' })).toBeDefined()

    await band.select({ key: 'view-branch', value: '' })

    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: 'working' } })
    expect(runs.filter(argv => argv[1] === 'log').at(-1)).not.toContain('refs/remotes/origin/main')
  })

  test('Older past the oldest commit loaded reads older ones, and the lists hold at most 64 commits', async ($, on) => {
    const runs: string[][] = []
    const total = 150

    on('session.cwd', () => ({ value: '/repo' }))
    on('command.register', () => ({ value: { command: 'gitdiff' } }))
    on('ui.open', () => placed)
    on('process.run', (_$, e) => {
      const argv = e.argv
      const [, sub, flag] = argv

      runs.push([...argv])

      switch (sub) {
        case 'rev-parse': {
          if (flag === '--is-inside-work-tree') {
            return answer('true\n')
          }

          // A commit's parent is the commit before it.
          const parent = argv.find(arg => arg.endsWith('^'))

          return answer(`${parent === undefined ? sha(total - 1) : sha(Number(parent.slice(0, -1)) - 1)}\n`)
        }
        case 'branch':
          return answer('main\n')
        case 'for-each-ref':
          return answer(`${['refs/heads/main', 'main', '9', '', 'a1'].join(US)}\n`)
        case 'symbolic-ref':
          return answer('', 1)
        case 'log': {
          const asked = Number(argv[argv.indexOf('-n') + 1])

          // Newest first, as git prints them, as many as asked of the 150 there are.
          return answer(Array.from({ length: Math.min(asked, total) }, (_, i) => record(total - 1 - i)).join(''))
        }
        default:
          return answer('')
      }
    })
    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })
    const asked = () => runs.filter(argv => argv[1] === 'log').map(argv => argv[argv.indexOf('-n') + 1])
    const values = async (key: string) => ((await band.find({ key }))?.props as { options: { value: string }[] }).options.map(o => o.value)

    expect(await band.find({ type: 'Svg' })).toMatchObject({ props: { alt: expect.stringMatching(/^main · 60\+ commits/) } })
    expect(asked()).toEqual(['60'])
    expect(await values('to')).toHaveLength(60)

    // The oldest commit loaded on its own, then one older: git is asked for 60 more.
    await band.select({ key: 'to', value: sha(90) })

    expect(await band.find({ key: 'from' })).toMatchObject({ props: { value: sha(89) } })

    await band.press({ key: 'older' })

    expect(asked()).toEqual(['60', '120'])
    expect(await band.find({ type: 'Svg' })).toMatchObject({ props: { alt: expect.stringMatching(/^main · 120\+ commits/) } })
    expect(await band.find({ key: 'to' })).toMatchObject({ props: { value: sha(89) } })
    expect(await band.find({ key: 'from' })).toMatchObject({ props: { value: sha(88) } })

    // A list takes 64 options at most: To the commits around the pick, From all that are older than To.
    const to = await values('to')
    const from = await values('from')

    expect(to).toHaveLength(64)
    expect(to).toContain(sha(89))
    expect(to).toContain(sha(149 - 59 - 30))
    expect(from).toHaveLength(60)
    expect(from[0]).toBe(sha(88))
    expect(from.at(-1)).toBe(sha(29))
  })

  test('stays out of the way outside a repository', async ($, on) => {
    on('session.cwd', () => ({ value: '/tmp' }))
    on('command.register', () => ({ value: { command: 'gitdiff' } }))
    on('ui.open', () => placed)
    on('process.run', () => answer('', 128, 'fatal: not a git repository\n'))
    // Beneath the plugin: what the engine itself draws in the band, which is nothing.
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))

    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('is not drawn when the setting asks for the side pane', { options: { position: 'pane' } }, async ($, on) => {
    world(on, { isDirty: true })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))

    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ key: 'to' })).toBeUndefined()
  })

  test('a session start closes a leftover side pane in band mode', async ($, on) => {
    const calls: string[] = []
    const clock = mock.clock(on)

    world(on, {
      isDirty: false,
      open: () => {
        calls.push('open')

        return placed
      },
    })
    on('ui.close', () => {
      calls.push('close')

      return { value: undefined }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(calls).toEqual(['close'])
  })
})

describe('a repository with many branches', () => {
  test('the dropdowns hold at most 64 branches, the checked-out and the picked among them, or the band would vanish', async ($, on) => {
    world(on, { isDirty: false, extraBranches: 100 })
    await $.command.run(GITDIFF)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })
    const values = async (key: string) => ((await band.find({ key }))?.props as { options: { value: string }[] }).options.map(o => o.value)
    const view = await values('view-branch')

    expect(view).toHaveLength(64)
    expect(view).toContain('')

    await band.select({ key: 'view-branch', value: 'feature' })
    await band.press({ key: 'mode:branches' })

    const base = await values('branch-base')

    expect(base).toHaveLength(64)
    expect(base).toEqual(expect.arrayContaining(['main', 'feature', 'origin/main']))
    expect(await band.find({ key: 'branch-compare' })).toBeDefined()
  })
})

describe('the remote branches', () => {
  const band = ($: Engine) =>
    $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

  test('say when they were fetched while one is in view, and Fetch brings them up to date and says what moved', async ($, on) => {
    const { runs, fetches } = world(on, { isDirty: false, fetchedAgo: 3 * 3600 })

    await $.command.run(GITDIFF)

    const ui = await band($)

    // The local branch's history: how old the remote copies are does not matter, so nothing says it.
    expect(await ui.find({ key: 'fetch' })).toBeUndefined()

    // Branches compares with origin/main: this computer’s copy as of the last fetch, not live data.
    await ui.press({ key: 'mode:branches' })

    expect(await ui.find({ type: 'Text', text: 'Fetched 3 h ago' })).toMatchObject({ props: { dimColor: true } })

    await ui.press({ key: 'fetch' })

    expect(runs.some(argv => argv.join(' ') === 'git fetch --all --prune')).toBe(true)
    // No password prompt can hang it, and a slow remote has time.
    expect(fetches).toEqual([{ env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 }])
    expect(await ui.find({ type: 'Text', text: '1 updated' })).toBeDefined()

    await ui.press({ key: 'fetch' })

    expect(await ui.find({ type: 'Text', text: 'nothing new' })).toBeDefined()
  })

  test('a fetch more than a day ago is a warning', async ($, on) => {
    world(on, { isDirty: false, fetchedAgo: 3 * 86_400 })
    await $.command.run(GITDIFF)

    const ui = await band($)

    // origin/main's own history is a remote branch in view too.
    await ui.select({ key: 'view-branch', value: 'origin/main' })

    expect(await ui.find({ type: 'Text', text: 'Fetched 3 days ago' })).toMatchObject({ props: { color: 'warning' } })
  })

  test('without a fetch time from git, the chip does not guess', async ($, on) => {
    world(on, { isDirty: false })
    await $.command.run(GITDIFF)

    const ui = await band($)

    await ui.press({ key: 'mode:branches' })

    expect(await ui.find({ type: 'Text', text: 'Fetch time unknown' })).toBeDefined()
    expect(await ui.find({ key: 'fetch' })).toBeDefined()
  })

  test('a fetch that git refuses says why, and can be tried again', async ($, on) => {
    world(on, { isDirty: false, fetchedAgo: 60, fetchError: "fatal: Authentication failed for 'https://gitlab.example/x.git/'\n" })
    await $.command.run(GITDIFF)

    const ui = await band($)

    await ui.press({ key: 'mode:branches' })
    await ui.press({ key: 'fetch' })

    expect(await ui.find({ type: 'Text', text: "Fetch failed: fatal: Authentication failed for 'https://gitlab.example/x.git/'" })).toMatchObject({
      props: { color: 'error' },
    })
    expect(await ui.find({ key: 'fetch' })).toBeDefined()
  })
})

describe('the files view', () => {
  test('a file’s diff opens and closes from its name, and a binary file says so', async ($, on) => {
    world(on, { isDirty: true })
    await $.command.run(GITDIFF)

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: '3 files changed' })).toBeDefined()
    expect(await pane.findAll({ type: 'Code' })).toHaveLength(1)

    await pane.press({ key: 'file:README.md' })

    expect(await pane.findAll({ type: 'Code' })).toHaveLength(2)

    await pane.press({ key: 'file:src/app.tsx' })

    expect(await pane.findAll({ type: 'Code' })).toHaveLength(1)

    await pane.press({ key: 'file:logo.png' })

    expect(await pane.find({ type: 'Text', text: 'Binary file not shown' })).toBeDefined()
  })

  test('says so outside a repository', async ($, on) => {
    on('session.cwd', () => ({ value: '/tmp' }))
    on('command.register', () => ({ value: { command: 'gitdiff' } }))
    on('ui.open', () => placed)
    on('process.run', () => answer('', 128, 'fatal: not a git repository\n'))

    await $.command.run(GITDIFF)

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: 'Not a git repository: /tmp' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
  })

  test('with the side-pane setting, the pane carries the timeline too', { options: { position: 'pane' } }, async ($, on) => {
    world(on, { isDirty: false })

    const ran = await $.command.run(GITDIFF)

    expect(ran.text).toBe('Git Diff pane opened.')

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Svg' })).toBeDefined()
    expect(await pane.find({ key: 'to' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('a session start opens the side pane when the setting asks for it', { options: { position: 'pane' } }, async ($, on) => {
    const calls: string[] = []
    const clock = mock.clock(on)

    world(on, {
      isDirty: false,
      open: () => {
        calls.push('open')

        return placed
      },
    })
    on('ui.close', () => {
      calls.push('close')

      return { value: undefined }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(calls).toEqual(['open'])
  })

  test('the first prompt asks again when the pane was left waiting, and only once', { options: { position: 'pane' } }, async ($, on) => {
    const opens: boolean[] = []

    world(on, {
      isDirty: false,
      open: () => {
        const isPlaced = opens.length > 0

        opens.push(isPlaced)

        return isPlaced ? placed : { value: { isPlaced: false as const, reason: 'too narrow' } }
      },
    })
    on('prompt.submit', (_$, e) => ({ text: e.text }))

    const ran = await $.command.run(GITDIFF)

    expect(ran.text).toBe('Git Diff pane is waiting: too narrow')
    expect(opens).toEqual([false])

    const submit = { text: 'hello', wait: false, origin: { kind: 'composer' as const } }

    await $.prompt.submit(submit)
    await $.prompt.submit(submit)

    expect(opens).toEqual([false, true])
  })
})
