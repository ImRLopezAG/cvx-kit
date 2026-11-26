import {
	type KConversionFailure,
	isoDateTimeToTimestamp,
	isoDateToTimestamp,
	timestampToIsoDate,
	timestampToIsoDateTime,
} from './formats'
import { KNumber, KString } from './kinds'
import type { KTransform } from './schema'

/** A strict `YYYY-MM-DD` calendar date; natively `v.string()`. */
export class KIsoDate extends KString {
	/** Input-position conversion to UTC midnight in milliseconds. A transform: table fields reject it. */
	toTimestamp(): KTransform<this, number> {
		return this.transform(conversion(isoDateToTimestamp))
	}
}

/** An ISO 8601 date-time with a `Z` or numeric offset; natively `v.string()`. */
export class KIsoDateTime extends KString {
	/** Input-position conversion to milliseconds. A transform: table fields reject it. */
	toTimestamp(): KTransform<this, number> {
		return this.transform(conversion(isoDateTimeToTimestamp))
	}
}

/** Finite integer milliseconds since the epoch, not negative; natively `v.number()`. */
export class KTimestamp extends KNumber {
	/** Input-position conversion to an ISO date-time in UTC. A transform: table fields reject it. */
	toIsoDateTime(): KTransform<this, string> {
		return this.transform(conversion(timestampToIsoDateTime))
	}

	/** Input-position conversion to the UTC `YYYY-MM-DD`. A transform: table fields reject it. */
	toIsoDate(): KTransform<this, string> {
		return this.transform(conversion(timestampToIsoDate))
	}
}

const isoDateRoot = new KIsoDate(null, 'isoDate', undefined, undefined)
const isoDateTimeRoot = new KIsoDateTime(null, 'isoDateTime', undefined, undefined)
const timestampRoot = new KTimestamp(null, 'timestamp', undefined, undefined)

export function isoDate(): KIsoDate {
	return isoDateRoot
}

export function isoDateTime(): KIsoDateTime {
	return isoDateTimeRoot
}

export function timestamp(): KTimestamp {
	return timestampRoot
}

/** A conversion's failure value is reported by the walker as an issue, so callers see only the success type. */
function conversion<I, O>(convert: (value: I) => O | KConversionFailure): (value: I) => O {
	// SAFETY: the walker turns a KConversionFailure result into an issue before any caller sees it.
	return convert as (value: I) => O
}
