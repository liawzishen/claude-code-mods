/** Cells of room at either end of the timeline's track. */
export const ARROW_W = 3

/** Cells one commit takes on the track: room for its label (`Jun 16`, `9:47 PM`). */
export const SLOT_W = 9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number) => String(n).padStart(2, '0')

/** `Jan 2, 2026`, in local time. */
export const formatDate = (seconds: number): string => {
  const date = new Date(seconds * 1000)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/** `Jan 2`, in local time. */
export const shortDate = (seconds: number): string => {
  const date = new Date(seconds * 1000)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** `02:40 PM`, in local time. */
export const formatTime = (seconds: number): string => {
  const date = new Date(seconds * 1000)
  const hours = date.getHours()

  return `${two(hours % 12 || 12)}:${two(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
}

/** `9:47 PM`, in local time. */
const shortTime = (seconds: number): string => {
  const date = new Date(seconds * 1000)
  const hours = date.getHours()

  return `${hours % 12 || 12}:${two(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
}

const dayOf = (seconds: number) => new Date(seconds * 1000).toDateString()

/** Whether the dot at `i` starts a day: the first dot, or a commit on another day than the one before it. */
const startsDay = (times: ReadonlyArray<number | null>, i: number) => {
  const time = times[i]
  const before = i === 0 ? null : times[i - 1]

  return time === null || time === undefined || before === null || before === undefined || dayOf(before) !== dayOf(time)
}

/** Each dot's name: its day where the day changes, else its time; null is the working tree. */
export const dayLabels = (times: ReadonlyArray<number | null>): string[] =>
  times.map((time, i) => (time === null ? 'Now' : startsDay(times, i) ? shortDate(time) : shortTime(time)))

/**
 * The labels under the track, sparse so it reads at a glance: each day where it starts, the
 * two picked dots always (by their time when their day is named already), and Now.
 */
export const trackLabels = (times: ReadonlyArray<number | null>, isPicked: ReadonlyArray<boolean>): string[] => {
  const labels = dayLabels(times)

  return labels.map((label, i) => (isPicked[i] === true || startsDay(times, i) ? label : ''))
}

/** How many commits fit on the track; at least two, at most all of them. */
export const visibleCount = (columns: number, total: number): number => {
  const room = Math.floor((columns - 2 * ARROW_W) / SLOT_W)

  return Math.max(2, Math.min(total, room))
}

/** The centre of slot `i`, in cells from the left edge. */
export const slotCenter = (i: number): number => ARROW_W + i * SLOT_W + SLOT_W / 2

const clampStart = (start: number, count: number, total: number) =>
  Math.min(Math.max(0, total - count), Math.max(0, start))

/** The leftmost visible node: `-1` means the newest window. */
export const resolveStart = (start: number, count: number, total: number): number =>
  start < 0 ? Math.max(0, total - count) : clampStart(start, count, total)

/**
 * The window that shows the pick `from`..`to`: where it was while both ends are in view, else
 * centred on the pick, or on its newer end when the pick is wider than the window. `-1` once
 * that is the newest window, so it follows new commits. `from` may be -1: the commit before the
 * oldest, which the track's start stands for.
 */
export const revealStart = (start: number, from: number, to: number, count: number, total: number): number => {
  const current = resolveStart(start, count, total)
  const older = Math.max(0, from)
  const next =
    older >= current && to <= current + count - 1
      ? current
      : to - older + 1 > count
        ? to - count + 1
        : Math.round((older + to + 1 - count) / 2)
  const clamped = clampStart(next, count, total)

  return clamped === Math.max(0, total - count) ? -1 : clamped
}
