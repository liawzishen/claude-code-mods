import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 9, 0)
const MINUTE = 60_000

/** The engine beneath the plugin: its usage figures, and a record of each status line. */
const world = (on: On) => {
  const lines: (string | undefined)[] = []
  const clock = mock.clock(on, { now: NOW })

  on('ui.status', (_$, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: NOW - 12 * MINUTE, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  return { lines, clock }
}

describe('the status line', () => {
  test('counts from when the engine says the session began, and keeps time', async ($, on) => {
    const { lines, clock } = world(on)

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(lines.at(-1)).toBe('Session 12m · 0 prompts · 0 tool calls')

    await clock.advance(30 * MINUTE)

    expect(lines.at(-1)).toBe('Session 42m · 0 prompts · 0 tool calls')
  })

  test('shows the context gauge and the nearest limit as the engine measures them', async ($, on) => {
    const { lines, clock } = world(on)

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({
      context: { window: 200_000, tokens: 128_000, percent: 64 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 130 * MINUTE).toISOString() }],
      changed: ['context', 'rateLimits'],
    })
    await clock.settle()

    expect(lines.at(-1)).toBe(
      'Context ▰▰▰▰▰▰▱▱▱▱ 64% of 200k · 5-hour limit 23%, resets in 2h 10m · Session 12m · 0 prompts · 0 tool calls',
    )
  })

  test('counts prompts and tool calls, the failed ones too, and starts over on /clear', async ($, on) => {
    const { lines, clock } = world(on)

    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('tool.call', () => ({ isError: true as const, result: 'boom', text: 'boom' }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Bash', command: 'false' })
    await clock.settle()

    expect(lines.at(-1)).toBe('Session 12m · 1 prompt · 1 tool call (1 failed)')

    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } as never })
    await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
    await clock.settle()

    expect(lines.at(-1)).toBe('Session 0m · 1 prompt · 0 tool calls')
  })
})
