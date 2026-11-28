// AST helpers shared by the v2 codemod transforms: parsing, walking, chains
// and source positions. Offsets are oxc-parser's UTF-16 offsets, so they index
// JavaScript strings directly.
import { parseSync, visitorKeys } from 'oxc-parser'

export function parseSource(path, source) {
	return parseSync(path, source, { lang: langOf(path), sourceType: 'module' })
}

function langOf(path) {
	if (path.endsWith('.tsx')) return 'tsx'
	if (/\.(?:[cm]?js|jsx)$/.test(path)) return 'jsx'
	return 'ts'
}

/** Depth-first walk; `visit(node, parent)` runs before the node's children. */
export function walk(node, visit, parent = null) {
	visit(node, parent)
	for (const key of visitorKeys[node.type] ?? []) {
		const child = node[key]
		if (Array.isArray(child)) {
			for (const item of child) if (item) walk(item, visit, node)
		} else if (child) walk(child, visit, node)
	}
}

export function parentMap(program) {
	const parents = new Map()
	walk(program, (node, parent) => parents.set(node, parent))
	return parents
}

const WRAPPERS = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
])

export function unwrap(node) {
	let current = node
	while (current && WRAPPERS.has(current.type)) current = current.expression
	return current
}

/** Split `a.b(c).d` into its root and the member/call steps applied to it. */
export function chainOf(node) {
	const steps = []
	let current = node
	for (;;) {
		if (current.type === 'MemberExpression') {
			const name =
				!current.computed && current.property.type === 'Identifier'
					? current.property.name
					: current.computed &&
						  current.property.type === 'Literal' &&
						  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only string literals name schema members in the parser's Literal union.
						  typeof current.property.value === 'string'
						? current.property.value
						: null
			steps.unshift({ kind: 'member', node: current, name })
			current = current.object
		} else if (current.type === 'CallExpression') {
			steps.unshift({ kind: 'call', node: current })
			current = current.callee
		} else break
	}
	return { root: current, steps }
}

/** The outermost member/call chain that starts at `node`. */
export function outerChain(node, parents) {
	let current = node
	for (;;) {
		const parent = parents.get(current)
		if (!parent) return current
		if (parent.type === 'MemberExpression' && parent.object === current) current = parent
		else if (parent.type === 'CallExpression' && parent.callee === current) current = parent
		else return current
	}
}

/** Whether an Identifier is a value or type reference rather than a declared or borrowed name. */
export function isReference(node, parent) {
	if (!parent) return true
	switch (parent.type) {
		case 'MemberExpression':
			return parent.object === node || parent.computed
		case 'Property':
		case 'PropertyDefinition':
		case 'MethodDefinition':
		case 'TSPropertySignature':
		case 'TSMethodSignature':
			return parent.key !== node || parent.computed
		case 'TSQualifiedName':
			return parent.left === node
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
		case 'ExportSpecifier':
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
			return false
		default:
			return parent.id !== node
	}
}

/** Identifier names bound by a declaration pattern. */
export function patternNames(pattern, names = []) {
	if (!pattern) return names
	switch (pattern.type) {
		case 'Identifier':
			names.push(pattern.name)
			break
		case 'ObjectPattern':
			for (const property of pattern.properties) {
				patternNames(property.type === 'RestElement' ? property.argument : property.value, names)
			}
			break
		case 'ArrayPattern':
			for (const element of pattern.elements) patternNames(element, names)
			break
		case 'AssignmentPattern':
			patternNames(pattern.left, names)
			break
		case 'RestElement':
			patternNames(pattern.argument, names)
			break
		case 'TSParameterProperty':
			patternNames(pattern.parameter, names)
			break
		default:
			break
	}
	return names
}

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])

/** Resolve a value name at its use site, stopping at the nearest lexical binding. */
export function resolveBinding(node, parents, name = node.name) {
	for (let scope = parents.get(node); scope; scope = parents.get(scope)) {
		if (FUNCTIONS.has(scope.type)) {
			const parameter = scope.params.find((param) => patternNames(param).includes(name))
			if (parameter) return { kind: 'parameter', node: parameter, scope }
			if (scope.id?.name === name) return { kind: 'function', node: scope, scope }
			const variable = hoistedVar(scope.body, name)
			if (variable) return { kind: 'var', node: variable, scope, init: variable.init }
		}
		if (scope.type === 'CatchClause' && patternNames(scope.param).includes(name))
			return { kind: 'parameter', node: scope.param, scope }
		const head =
			scope.type === 'ForStatement'
				? scope.init
				: ['ForOfStatement', 'ForInStatement'].includes(scope.type)
					? scope.left
					: null
		const statements = ['Program', 'BlockStatement', 'StaticBlock'].includes(scope.type)
			? scope.body
			: scope.type === 'SwitchStatement'
				? scope.cases.flatMap((item) => item.consequent)
				: head
					? [head]
					: []
		for (const statement of statements) {
			const declaration = statement.declaration ?? statement
			if (declaration.type === 'ImportDeclaration') {
				const spec = declaration.specifiers.find((item) => item.local.name === name)
				if (spec)
					return {
						kind: 'import',
						node: spec,
						scope,
						source: declaration.source.value,
						imported:
							spec.type === 'ImportNamespaceSpecifier'
								? '*'
								: spec.type === 'ImportDefaultSpecifier'
									? 'default'
									: (spec.imported.name ?? spec.imported.value),
					}
			}
			if (declaration.type === 'VariableDeclaration') {
				if (declaration.kind === 'var' && scope.type !== 'Program') continue
				const item = declaration.declarations.find((entry) => patternNames(entry.id).includes(name))
				if (item)
					return {
						kind: declaration.kind,
						node: item,
						scope,
						init: item.init,
						path: bindingPath(item.id, name),
					}
			}
			if (
				['FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration'].includes(
					declaration.type,
				) &&
				declaration.id?.name === name
			)
				return {
					kind:
						declaration.type === 'FunctionDeclaration'
							? 'function'
							: declaration.type === 'TSEnumDeclaration'
								? 'enum'
								: 'class',
					node: declaration,
					scope,
				}
		}
		if (scope.type === 'Program') {
			const variable = hoistedVar(scope, name)
			if (variable) return { kind: 'var', node: variable, scope, init: variable.init }
		}
	}
	return null
}

function hoistedVar(node, name) {
	if (
		!node ||
		FUNCTIONS.has(node.type) ||
		['ClassDeclaration', 'ClassExpression'].includes(node.type)
	)
		return null
	if (node.type === 'VariableDeclaration' && node.kind === 'var')
		return node.declarations.find((item) => patternNames(item.id).includes(name)) ?? null
	for (const key of visitorKeys[node.type] ?? []) {
		const value = node[key]
		for (const child of Array.isArray(value) ? value : [value]) {
			const found = hoistedVar(child, name)
			if (found) return found
		}
	}
	return null
}

function bindingPath(pattern, name) {
	if (pattern.type === 'Identifier') return pattern.name === name ? [] : null
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) {
			if (property.type !== 'Property' || property.computed) continue
			const rest = bindingPath(property.value, name)
			if (rest) return [property.key.name ?? property.key.value, ...rest]
		}
	}
	return null
}

/** Whether a local binding named `name` is visible at `node` below the module scope. */
export function isShadowed(node, name, parents) {
	const binding = resolveBinding(node, parents, name)
	return binding !== null && binding.scope.type !== 'Program'
}

export function lineIndex(source) {
	const starts = [0]
	for (let index = 0; index < source.length; index++) {
		if (source.charCodeAt(index) === 10) starts.push(index + 1)
	}
	return (offset) => {
		let low = 0
		let high = starts.length - 1
		while (low < high) {
			const middle = (low + high + 1) >> 1
			if (starts[middle] <= offset) low = middle
			else high = middle - 1
		}
		return { line: low + 1, column: offset - starts[low] + 1 }
	}
}

/** Apply non-overlapping `{ start, end, text }` edits; touching edits are allowed. */
export function applyEdits(source, edits) {
	const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end)
	let output = ''
	let cursor = 0
	for (const edit of ordered) {
		if (edit.start < cursor) {
			throw new Error(`Overlapping edits at offset ${edit.start}`)
		}
		output += source.slice(cursor, edit.start) + edit.text
		cursor = edit.end
	}
	return output + source.slice(cursor)
}
