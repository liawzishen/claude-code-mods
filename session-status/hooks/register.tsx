import type { Register } from 'claude-code'

const REFRESH_MS = 30_000

const elapsed = (since: number) => {
  const minutes = Math.floor((Date.now() - since) / 60_000)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export const register: Register = on => {
  let startedAt = Date.now()
  let prompts = 0
  let tools = 0
  let failed = 0

  const line = () =>
    `⏱ ${elapsed(startedAt)} · ${prompts} prompts · ${tools} tools${failed > 0 ? ` (${failed} failed)` : ''}`

  on('session.start', ($, e, next) => {
    startedAt = Date.now()
    $.ui.status(line())
    $.clock.every(REFRESH_MS, () => $.ui.status(line()))
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    prompts += 1
    $.ui.status(line())
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    tools += 1
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) failed += 1
    $.ui.status(line())
    return ran
  })
}
