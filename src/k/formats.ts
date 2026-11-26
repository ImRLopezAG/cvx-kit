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

/**
 * The supported timestamp range: 1970-01-01T00:00:00.000Z through 9999-12-31T23:59:59.999Z, so every
 * timestamp has a four-digit ISO year and every conversion is total.
 */
export const maxTimestamp = 253_402_300_799_999

/** A conversion's failure, reported by the walker as an `invalid_value` issue instead of a throw. */
export class KConversionFailure {
	readonly message: string

	constructor(message: string) {
		this.message = message
	}
}

const outOfRange = new KConversionFailure(
	'Out of range: a timestamp must be from 1970-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z',
)

/** Integer milliseconds within the supported range. */
export function isTimestamp(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= maxTimestamp
}

/** UTC midnight of an already validated `YYYY-MM-DD`, or a failure before 1970. */
export function isoDateToTimestamp(value: string): number | KConversionFailure {
	return inRange(Date.parse(`${value}T00:00:00Z`))
}

/** Milliseconds of an already validated ISO date-time, or a failure outside the supported range. */
export function isoDateTimeToTimestamp(value: string): number | KConversionFailure {
	return inRange(Date.parse(value))
}

export function timestampToIsoDateTime(value: number): string | KConversionFailure {
	return isTimestamp(value) ? new Date(value).toISOString() : outOfRange
}

export function timestampToIsoDate(value: number): string | KConversionFailure {
	return isTimestamp(value) ? new Date(value).toISOString().slice(0, 10) : outOfRange
}

function inRange(time: number): number | KConversionFailure {
	return isTimestamp(time) ? time : outOfRange
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
