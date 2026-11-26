/** Strict ISO 8601 checks and conversions, with no date dependency and no `Date` parsing leniency. */

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const isoDateTimePattern =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

/** `YYYY-MM-DD` naming a real calendar day, leap years included. */
export function isIsoDate(value: string): boolean {
	const match = isoDatePattern.exec(value)
	return match !== null && isCalendarDay(match[1], match[2], match[3])
}

/** An ISO 8601 date-time with seconds, optional fractional seconds and a `Z` or `±HH:MM` offset. */
export function isIsoDateTime(value: string): boolean {
	const match = isoDateTimePattern.exec(value)
	if (match === null || !isCalendarDay(match[1], match[2], match[3])) return false
	if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false
	return match[7] === undefined || (Number(match[8]) <= 23 && Number(match[9]) <= 59)
}

/** Integer milliseconds since the epoch, not negative. */
export function isTimestamp(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

/** UTC midnight of an already validated `YYYY-MM-DD`. */
export function isoDateToTimestamp(value: string): number {
	return Date.parse(`${value}T00:00:00Z`)
}

/** Milliseconds of an already validated ISO date-time. */
export function isoDateTimeToTimestamp(value: string): number {
	return Date.parse(value)
}

export function timestampToIsoDateTime(value: number): string {
	return new Date(value).toISOString()
}

export function timestampToIsoDate(value: number): string {
	return new Date(value).toISOString().slice(0, 10)
}

function isCalendarDay(year: string, month: string, day: string): boolean {
	const y = Number(year)
	const m = Number(month)
	const d = Number(day)
	return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
}

function daysIn(year: number, month: number): number {
	if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}
