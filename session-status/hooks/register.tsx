import type { EngineInterface, Register } from 'claude-code'

import { statusLine } from './line'
import type { Counts, Figures } from './line'

const REFRESH_MS = 30_000

let figures: Figures = { rateLimits: [] }
let counts: Counts = { prompts: 0, tools: 0, failed: 0 }
/** When the session began, in `$.clock.now()`'s milliseconds; null until read. */
let startedAt: number | null = null

const show = async ($: EngineInterface) => {
  const now = await $.clock.now()

  $.ui.status(statusLine(figures, counts, startedAt ?? now, now))
}

/** Reads the engine's figures, which cost nothing: when the session began, and how full it is. */
const readUsage = async ($: EngineInterface) => {
  try {
    const usage = await $.session.usage()

    figures = usage
    startedAt = usage.startedAt
  } catch {
    // The line shows what it has; the next measurement fills the rest.
  }
}

export const register: Register = on => {
  figures = { rateLimits: [] }
  counts = { prompts: 0, tools: 0, failed: 0 }
  startedAt = null

  on('session.start', async ($, e, next) => {
    await readUsage($)
    await show($)
    $.clock.every(REFRESH_MS, () => void show($))

    return next(e)
  })

  // Pushed after each turn, and when a rate-limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    figures = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    await show($)

    return next(e)
  })

  // A /clear starts the session over: no session.start follows it.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    counts = { prompts: 0, tools: 0, failed: 0 }
    startedAt = await $.clock.now()

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    counts = { ...counts, prompts: counts.prompts + 1 }
    await show($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    counts = { ...counts, tools: counts.tools + 1 }

    const ran = await next(e)

    if (ran.deny === undefined && ran.isError === true) {
      counts = { ...counts, failed: counts.failed + 1 }
    }

    await show($)

    return ran
  })
}
