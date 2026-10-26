import { compareValues } from 'convex/values'
export type FilterScalar = string | number | bigint | boolean | null
export type FilterOperator = 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'
export type FilterAst =
	| { kind: 'and' | 'or'; children: FilterAst[] }
	| { kind: 'not'; child: FilterAst }
	| { kind: 'variant'; discriminator: string; tag: string; child: FilterAst }
	| {
			kind: 'scalar'
			field: string
			operator: FilterOperator
			value: FilterScalar | FilterScalar[]
	  }
	| { kind: 'relation'; name: string; mode: 'one' | 'some' | 'none'; predicate: FilterAst | null }

export function valueEqual(left: FilterScalar, right: FilterScalar): boolean {
	return compareValues(left, right) === 0
}
