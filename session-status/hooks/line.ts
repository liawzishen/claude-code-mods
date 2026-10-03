import type { SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

/** The session's figures as the engine last measured them. */
export type Figures = {
  context?: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
  cost?: SessionCost
}

/** What this session did, as the line counts it. */
export type Counts = { prompts: number; tools: number; failed: number }

const SEGMENTS = 10

/** A rate-limit window by its plain name. */
const WINDOWS: Readonly<Record<string, string>> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  spend_limit: 'Spend limit',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** `▰▰▰▰▰▰▱▱▱▱`: one segment per tenth of `percent`, like a battery. */
export const gauge = (percent: number): string => {
  const filled = Math.min(SEGMENTS, Math.max(0, Math.round(percent / (100 / SEGMENTS))))

  return '▰'.repeat(filled) + '▱'.repeat(SEGMENTS - filled)
}

/** `850`, `200k`, `1M`, `1.5M`: a token count, short. */
export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** `45m`, `2h 10m`, `5d 12h`: a span of time to the minute, short. */
export const duration = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** How full the context window is: a gauge, the percent, and the window's size. */
const contextPart = (context: SessionContextUsage | undefined) =>
  context?.percent === undefined ? null : `Context ${gauge(context.percent)} ${context.percent}% of ${tokens(context.window)}`

/** The rate-limit window nearest its limit, and when it resets; off a subscription, the cost. */
const limitPart = ({ rateLimits, cost }: Figures, now: number) => {
  const nearest = [...rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]

  if (nearest === undefined) {
    return cost === undefined || cost.usd <= 0 ? null : `Cost $${cost.usd.toFixed(2)}`
  }

  const name = WINDOWS[nearest.kind] ?? `${nearest.kind.replace(/_/g, ' ')} limit`
  const left = nearest.resetsAt === undefined ? Number.NaN : Date.parse(nearest.resetsAt) - now

  return `${name} ${Math.round(nearest.percentUsed)}%${left > 0 ? `, resets in ${duration(left)}` : ''}`
}

/**
 * The status line, most useful first: how full the context is, the limit nearest to
 * running out (or the cost), then how long the session has run and what it did.
 */
export const statusLine = (figures: Figures, counts: Counts, startedAt: number, now: number): string =>
  [
    contextPart(figures.context),
    limitPart(figures, now),
    `Session ${duration(now - startedAt)}`,
    plural(counts.prompts, 'prompt'),
    `${plural(counts.tools, 'tool call')}${counts.failed > 0 ? ` (${counts.failed} failed)` : ''}`,
  ]
    .filter(part => part !== null)
    .join(' · ')
