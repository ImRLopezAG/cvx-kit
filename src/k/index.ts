import {
	any,
	array,
	boolean,
	bytes,
	custom,
	discriminatedUnion,
	email,
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
	url,
	voidValue,
} from './kinds'
import { isoDate, isoDateTime, timestamp } from './dates'
import { NEVER } from './issues'
import { jsonObject } from './loose'
import { looseObject, object, partialRecord, record, strictObject } from './object'
import type { KType } from './types'

export const k = {
	string,
	email,
	url,
	number,
	int,
	int64,
	boolean,
	null: nullValue,
	void: voidValue,
	bytes,
	any,
	custom,
	json,
	jsonObject,
	literal,
	enum: enumOf,
	id,
	array,
	object,
	looseObject,
	strictObject,
	record,
	partialRecord,
	union,
	discriminatedUnion,
	isoDate,
	isoDateTime,
	timestamp,
	NEVER,
}

export declare namespace k {
	type infer<T extends KType> = T['_output']
	type output<T extends KType> = T['_output']
	type input<T extends KType> = T['validator']['type']
}
