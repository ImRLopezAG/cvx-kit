// Function definitions: rewrite `args: <expr>` / `returns: <expr>` to getters.
// Convex re-evaluates a module's import graph on every call, so a getter means a
// call builds only the validators of the function it invokes.
//
// Rule: an object literal passed as an argument to a call and carrying a
// `handler` property is a function definition. Its `args` / `returns` data
// property becomes `get args() { return <expr> }` unless the value is a cheap
// reference (an identifier or a plain `a.b.c` member chain), or it mentions
// `this`, `await` or `yield`, whose meaning would change inside a getter.
import { unwrap, walk } from './ast.mjs'

const KEYS = new Set(['args', 'returns'])
const UNSAFE = new Set(['ThisExpression', 'AwaitExpression', 'YieldExpression', 'Super'])

function keyName(property) {
	if (property.computed) return null
	if (property.key.type === 'Identifier') return property.key.name
	if (property.key.type === 'Literal') return String(property.key.value)
	return null
}

function isDataProperty(property) {
	return (
		property.type === 'Property' &&
		property.kind === 'init' &&
		!property.method &&
		!property.shorthand
	)
}

/** An identifier or a non-computed member chain over one: reading it costs nothing. */
export function isCheapReference(node) {
	let current = unwrap(node)
	while (current.type === 'MemberExpression' && !current.computed) current = unwrap(current.object)
	return current.type === 'Identifier'
}

function mentionsUnsafe(node) {
	let found = false
	walk(node, (child) => {
		if (UNSAFE.has(child.type)) found = true
	})
	return found
}

export function isFunctionDefinition(node, parent) {
	if (node.type !== 'ObjectExpression' || parent?.type !== 'CallExpression') return false
	if (!parent.arguments.includes(node)) return false
	return node.properties.some(
		(property) => property.type === 'Property' && keyName(property) === 'handler',
	)
}

/** Edits turning eligible `args` / `returns` properties in `root` into getters. */
export function getterEdits(root) {
	const edits = []
	walk(root, (node, parent) => {
		if (!isFunctionDefinition(node, parent)) return
		for (const property of node.properties) {
			if (!isDataProperty(property)) continue
			const name = keyName(property)
			if (!KEYS.has(name)) continue
			const value = property.value
			if (isCheapReference(value) || mentionsUnsafe(value)) continue
			edits.push(
				{ start: property.start, end: value.start, text: `get ${name}() { return `, usesK: false },
				{ start: value.end, end: value.end, text: ' }', usesK: false },
			)
		}
	})
	return edits
}
