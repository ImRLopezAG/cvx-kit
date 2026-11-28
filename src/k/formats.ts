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

/** Zod 4's email pattern: a practical address check, not RFC 5322. */
export const emailPattern =
	/^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

export function isEmail(value: string): boolean {
	return emailPattern.test(value)
}

/**
 * Whether the WHATWG URL parser accepts the string (surrounding whitespace ignored, as Zod does), and
 * its protocol (without the colon) and hostname match the given patterns.
 */
export function isUrl(
	value: string,
	protocol: RegExp | undefined,
	hostname: RegExp | undefined,
): boolean {
	// Every Convex and browser runtime provides the WHATWG URL constructor; the kit compiles without DOM typings.
	const scope: { readonly URL?: new (input: string) => ParsedUrl } = globalThis
	const Url = scope.URL
	if (Url === undefined) return false
	let parsed: ParsedUrl
	try {
		parsed = new Url(value.trim())
	} catch {
		return false
	}
	if (protocol !== undefined) {
		protocol.lastIndex = 0
		if (!protocol.test(parsed.protocol.replace(/:$/, ''))) return false
	}
	if (hostname !== undefined) {
		hostname.lastIndex = 0
		if (!hostname.test(parsed.hostname)) return false
	}
	return true
}

/** Zod 4.6.7 (MIT), src/v4/core/regexes.ts. */
export const ipv4Pattern =
	/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/

/** Zod 4.6.7 (MIT), UUID versions 1 to 8, nil and lowercase max. */
export const uuidPattern =
	/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/

/** Zod 4.6.7 (MIT), src/v4/core/schemas.ts: alphabet guard, then URL host parsing. */
export function isIpv6(value: string): boolean {
	if (!/^[0-9a-fA-F:.]+$/.test(value)) return false
	const scope: { readonly URL?: new (input: string) => ParsedUrl } = globalThis
	try {
		if (scope.URL === undefined) return false
		new scope.URL(`http://[${value}]`)
		return true
	} catch {
		return false
	}
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

interface ParsedUrl {
	readonly protocol: string
	readonly hostname: string
}
