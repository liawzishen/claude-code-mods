import { describe, expect, test } from 'claude-code/testing'

import { duration, gauge, statusLine, tokens } from '../hooks/line'

const NOW = Date.UTC(2026, 9, 3, 9, 0)
const MINUTE = 60_000
const counts = { prompts: 3, tools: 10, failed: 0 }

describe('words', () => {
  test('a gauge is ten segments, one per tenth', () => {
    expect(gauge(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(gauge(64)).toBe('▰▰▰▰▰▰▱▱▱▱')
    expect(gauge(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(gauge(130)).toBe('▰▰▰▰▰▰▰▰▰▰')
  })

  test('token counts and spans of time read short', () => {
    expect(tokens(850)).toBe('850')
    expect(tokens(200_000)).toBe('200k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(1_500_000)).toBe('1.5M')
    expect(duration(45 * MINUTE)).toBe('45m')
    expect(duration(130 * MINUTE)).toBe('2h 10m')
    expect(duration((5 * 24 + 12) * 60 * MINUTE)).toBe('5d 12h')
    expect(duration(-MINUTE)).toBe('0m')
  })
})

describe('the line', () => {
  test('shows how full the context is and the limit nearest to running out, first', () => {
    const line = statusLine(
      {
        context: { window: 200_000, tokens: 128_000, percent: 64 },
        rateLimits: [
          { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 5 * 24 * 60 * MINUTE).toISOString() },
          { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(NOW + 130 * MINUTE).toISOString() },
        ],
      },
      counts,
      NOW - 12 * MINUTE,
      NOW,
    )

    expect(line).toBe('Context ▰▰▰▰▰▰▱▱▱▱ 64% of 200k · 5-hour limit 24%, resets in 2h 10m · Session 12m · 3 prompts · 10 tool calls')
  })

  test('off a subscription it shows the cost instead, and leaves out what is not measured yet', () => {
    expect(statusLine({ rateLimits: [], cost: { usd: 1.237 } }, counts, NOW, NOW)).toBe(
      'Cost $1.24 · Session 0m · 3 prompts · 10 tool calls',
    )
    expect(statusLine({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } }, counts, NOW, NOW)).toBe(
      'Session 0m · 3 prompts · 10 tool calls',
    )
  })

  test('counts in words, failures too', () => {
    expect(statusLine({ rateLimits: [] }, { prompts: 1, tools: 1, failed: 1 }, NOW, NOW)).toBe(
      'Session 0m · 1 prompt · 1 tool call (1 failed)',
    )
  })
})
