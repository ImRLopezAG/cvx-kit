import {
	array,
	boolean,
	enumOf,
	id,
	int,
	literal,
	nullValue,
	number,
	object,
	string,
	union,
} from './kinds'
import type { KType } from './types'

export const k = {
	string,
	number,
	int,
	boolean,
	null: nullValue,
	literal,
	enum: enumOf,
	id,
	array,
	object,
	union,
}

export declare namespace k {
	type infer<T extends KType> = T['_output']
	type output<T extends KType> = T['_output']
	type input<T extends KType> = T['validator']['type']
}
