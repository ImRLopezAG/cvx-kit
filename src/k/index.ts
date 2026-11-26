import {
	any,
	array,
	boolean,
	bytes,
	discriminatedUnion,
	enumOf,
	id,
	int,
	int64,
	json,
	literal,
	nullValue,
	number,
	string,
	union,
} from './kinds'
import { isoDate, isoDateTime, timestamp } from './dates'
import { object, partialRecord, record } from './object'
import type { KType } from './types'

export const k = {
	string,
	number,
	int,
	int64,
	boolean,
	null: nullValue,
	bytes,
	any,
	json,
	literal,
	enum: enumOf,
	id,
	array,
	object,
	record,
	partialRecord,
	union,
	discriminatedUnion,
	isoDate,
	isoDateTime,
	timestamp,
}

export declare namespace k {
	type infer<T extends KType> = T['_output']
	type output<T extends KType> = T['_output']
	type input<T extends KType> = T['validator']['type']
}
