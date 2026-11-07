import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { parseSync } from 'oxc-parser'

/** Locate standalone components as well as the conventional components/<name> layout. */
export function findComponentRoot(filename: string, roots: readonly string[] = []) {
	const file = resolve(filename)
	for (let directory = dirname(file); ; directory = dirname(directory)) {
		if (roots.includes(directory) || definesComponent(directory)) return directory
		if (dirname(directory) === directory) return null
	}
}

export function conventionalComponentRoot(filename: string, root: string) {
	const match = relative(root, filename)
		.split(sep)
		.join('/')
		.match(/^components\/([^/]+)(?:\/|$)/)
	return match ? resolve(root, 'components', match[1]) : null
}

function definesComponent(directory: string) {
	const config = resolve(directory, 'convex.config.ts')
	if (!existsSync(config)) return false
	const { program, errors } = parseSync(config, readFileSync(config, 'utf8'))
	if (errors.length) return false
	const names = new Set<string>()
	const namespaces = new Set<string>()
	for (const statement of program.body) {
		if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'convex/server')
			continue
		for (const specifier of statement.specifiers) {
			if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name)
			if (
				specifier.type === 'ImportSpecifier' &&
				(specifier.imported.type === 'Identifier'
					? specifier.imported.name
					: specifier.imported.value) === 'defineComponent'
			)
				names.add(specifier.local.name)
		}
	}
	for (const statement of program.body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		const expressions =
			declaration?.type === 'VariableDeclaration'
				? declaration.declarations.map((item) => item.init)
				: statement.type === 'ExportDefaultDeclaration'
					? [statement.declaration]
					: []
		for (const expression of expressions) {
			if (expression?.type !== 'CallExpression') continue
			const callee = expression.callee
			if (callee.type === 'Identifier' && names.has(callee.name)) return true
			if (
				callee.type === 'MemberExpression' &&
				!callee.computed &&
				callee.property.type === 'Identifier' &&
				callee.property.name === 'defineComponent' &&
				callee.object.type === 'Identifier' &&
				namespaces.has(callee.object.name)
			)
				return true
		}
	}
	return false
}
