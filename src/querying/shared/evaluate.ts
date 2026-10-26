import { compareValues, type Value } from 'convex/values'
import type { FilterAst } from './ast'
/** Native scalar ordering/equality, including missing vs null, without coercion. */
export function evaluateFilter(
	ast: FilterAst,
	document: Record<string, Value | undefined>,
	accessible?: ReadonlySet<string>,
): boolean | 'unknown' {
	switch (ast.kind) {
		case 'and': {
			let unknown = false
			for (const child of ast.children) {
				const value = evaluateFilter(child, document, accessible)
				if (value === false) return false
				if (value === 'unknown') unknown = true
			}
			return unknown ? 'unknown' : true
		}
		case 'or': {
			let unknown = false
			for (const child of ast.children) {
				const value = evaluateFilter(child, document, accessible)
				if (value === true) return true
				if (value === 'unknown') unknown = true
			}
			return unknown ? 'unknown' : false
		}
		case 'variant':
			return evaluateFilter(
				{
					kind: 'and',
					children: [
						{ kind: 'scalar', field: ast.discriminator, operator: 'eq', value: ast.tag },
						ast.child,
					],
				},
				document,
				accessible,
			)
		case 'not': {
			const value = evaluateFilter(ast.child, document, accessible)
			return value === 'unknown' ? value : !value
		}
		case 'relation':
			if (!accessible) throw new Error('Relation execution requires U6')
			return 'unknown'
		case 'scalar': {
			if (accessible && !accessible.has(ast.field)) return 'unknown'
			const actual = document[ast.field]
			if (ast.operator === 'exists') return (actual !== undefined) === ast.value
			if (ast.operator === 'in')
				return (
					Array.isArray(ast.value) && ast.value.some((value) => compareValues(actual, value) === 0)
				)
			if (Array.isArray(ast.value)) throw new Error('Invalid scalar predicate')
			const compared = compareValues(actual, ast.value)
			switch (ast.operator) {
				case 'eq':
					return compared === 0
				case 'gt':
					return compared > 0
				case 'gte':
					return compared >= 0
				case 'lt':
					return compared < 0
				case 'lte':
					return compared <= 0
			}
		}
	}
}
