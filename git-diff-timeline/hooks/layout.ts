/** Cells at either end of the timeline's track: the ‹ and › under its ends. */
export const ARROW_W = 3

/** Cells one commit takes on the track: room for its label (`Jun 16`, `9:47 PM`) under its dot. */
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

/** How many commit slots the track has room for between its ends. */
const roomOf = (columns: number) => Math.floor((columns - 2 * ARROW_W) / SLOT_W)

/** How many commits fit on the track; at least two, at most all of them. */
export const visibleCount = (columns: number, total: number): number => Math.max(2, Math.min(total, roomOf(columns)))

/** Cells before the first of `count` slots: the track's end, then half the room left over, so a short history sits in the middle. */
export const leadOf = (count: number, columns: number): number =>
  ARROW_W + Math.floor((Math.max(0, roomOf(columns) - count) * SLOT_W) / 2)

/**
 * The centre of slot `i` of `count`, in cells from the left edge: where the card draws the dot,
 * and where the dot's label sits under it.
 */
export const slotCenter = (i: number, count: number, columns: number): number =>
  leadOf(count, columns) + i * SLOT_W + SLOT_W / 2

const clampStart = (start: number, count: number, total: number) =>
  Math.min(Math.max(0, total - count), Math.max(0, start))

/** The leftmost visible node: `-1` means the newest window. */
export const resolveStart = (start: number, count: number, total: number): number =>
  start < 0 ? Math.max(0, total - count) : clampStart(start, count, total)

/**
 * The window centred on the pick `from`..`to`, or on its newer end when the pick is wider than the
 * window: the track scrolling under the pick as the wheel moves it. `-1` once that is the newest window.
 */
export const centreStart = (from: number, to: number, count: number, total: number): number => {
  const older = Math.max(0, from)
  const clamped = clampStart(to - older + 1 > count ? to - count + 1 : Math.round((older + to + 1 - count) / 2), count, total)

  return clamped === Math.max(0, total - count) ? -1 : clamped
}

/**
 * The window that shows the pick `from`..`to`: where it was while both ends are in view, else
 * centred on the pick, or on its newer end when the pick is wider than the window. `-1` once
 * that is the newest window, so it follows new commits. `from` may be -1: the commit before the
 * oldest, which the track's start stands for.
 */
export const revealStart = (start: number, from: number, to: number, count: number, total: number): number => {
  const current = resolveStart(start, count, total)

  if (Math.max(0, from) >= current && to <= current + count - 1) {
    return current === Math.max(0, total - count) ? -1 : current
  }

  return centreStart(from, to, count, total)
}
