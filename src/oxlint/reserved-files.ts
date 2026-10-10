import { readFileSync } from 'node:fs'
import type { Context, CreateRule, ESTree } from '@oxlint/plugins'
import { parseSync } from 'oxc-parser'
import { appFile, metadata, propertyName, exportName } from './ast'
import { createResolver, resolveImport } from './architecture'

/** Reserved files prove their exported declaration's provenance, not an unused import. */
export const reservedDomainFiles: CreateRule = {
	meta: metadata('Require kit-backed declarations in reserved domain files.', {
		anatomy:
			'{{file}} must export {{expected}} built with cvx-kit; imports or local lookalikes do not count.',
	}),
	create(context) {
		const file = appFile(context) ?? ''
		const match = file.match(/^domain\/(?:.+\/)?(commands|queries|contracts|schema|table)\.ts$/)
		if (!match) return {}
		const role = match[1]
		return {
			Program(program) {
				const evaluate = provenance(context, program, context.filename)
				const exports = publicExpressions(program)
				const values = exports.map((expression) => evaluate(expression))
				const expected =
					role === 'commands'
						? 'one Command registry'
						: role === 'queries'
							? 'one Query registry'
							: role === 'schema'
								? 'zodTable shapes'
								: role === 'contracts'
									? 'declarative contracts'
									: file === 'domain/table.ts'
										? 'createModule assembly'
										: 'a table topology map'
				const wanted =
					role === 'commands'
						? 'registry:Command'
						: role === 'queries'
							? 'registry:Query'
							: role === 'schema'
								? 'shape'
								: role === 'contracts'
									? 'contract'
									: file === 'domain/table.ts'
										? 'assembly'
										: 'topology'
				const count = values.filter((value) => value === wanted).length
				const valid = role === 'commands' || role === 'queries' ? count === 1 : count > 0
				if (!valid)
					context.report({ node: program, messageId: 'anatomy', data: { file, expected } })
			},
		}
	},
}

function publicExpressions(program: ESTree.Program): ESTree.Expression[] {
	const expressions: ESTree.Expression[] = []
	const declarations = new Map<string, ESTree.Expression>()
	for (const statement of program.body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const')
			for (const item of declaration.declarations) {
				if (item.id.type === 'Identifier' && item.init) {
					declarations.set(item.id.name, item.init)
					if (statement.type === 'ExportNamedDeclaration') expressions.push(item.init)
				}
			}
	}
	for (const statement of program.body) {
		if (
			statement.type === 'ExportNamedDeclaration' &&
			statement.exportKind !== 'type' &&
			!statement.source
		)
			for (const specifier of statement.specifiers) {
				if (specifier.exportKind === 'type') continue
				const expression = declarations.get(exportName(specifier.local) ?? '')
				if (expression) expressions.push(expression)
			}
		if (
			statement.type === 'ExportDefaultDeclaration' &&
			statement.declaration.type !== 'FunctionDeclaration' &&
			statement.declaration.type !== 'ClassDeclaration' &&
			statement.declaration.type !== 'TSInterfaceDeclaration'
		) {
			expressions.push(statement.declaration)
		}
	}
	return expressions
}

function provenance(
	context: Context,
	program: ESTree.Program,
	filename: string,
	visited = new Set<string>(),
) {
	const imports = new Map<string, { source: string; name: string }>()
	const variables = new Map<string, { expression: ESTree.Expression; member?: string }>()
	const resolver = createResolver()
	for (const statement of program.body) {
		if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type')
			for (const specifier of statement.specifiers) {
				if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
				imports.set(specifier.local.name, {
					source: statement.source.value,
					name:
						specifier.type === 'ImportSpecifier'
							? (exportName(specifier.imported) ?? '')
							: specifier.type === 'ImportNamespaceSpecifier'
								? '*'
								: 'default',
				})
			}
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const')
			for (const item of declaration.declarations) {
				if (!item.init) continue
				if (item.id.type === 'Identifier') variables.set(item.id.name, { expression: item.init })
				if (item.id.type === 'ObjectPattern')
					for (const property of item.id.properties) {
						if (property.type === 'Property' && property.value.type === 'Identifier')
							variables.set(property.value.name, {
								expression: item.init,
								member: exportName(property.key) ?? '',
							})
					}
			}
	}
	function imported(source: string, name: string): string | null {
		if (
			[
				'cvx-kit',
				'cvx-kit/effect',
				'cvx-kit/components/foundation',
				'cvx-kit/contracts',
				'cvx-kit/zod-table',
				'cvx-kit/errors',
			].includes(source)
		) {
			if (name === '*') return `namespace:${source}`
			if (
				(source === 'cvx-kit/effect' && name === 'createEffectFoundation') ||
				(source === 'cvx-kit' && name === 'createFoundation') ||
				(['cvx-kit', 'cvx-kit/components/foundation'].includes(source) && name === 'Foundation')
			)
				return 'foundationFactory'
			if (
				['cvx-kit', 'cvx-kit/zod-table'].includes(source) &&
				['zodTable', 'zodVariantTable'].includes(name)
			)
				return 'shapeFactory'
			if (['cvx-kit', 'cvx-kit/zod-table'].includes(source) && name === 'createModule')
				return 'assemblyFactory'
			if (
				source === 'cvx-kit/contracts' &&
				['defineDomainContract', 'operationContract'].includes(name)
			)
				return 'contractFactory'
			if (source === 'cvx-kit/errors' && name === 'defineErrorContract') return 'contractFactory'
			return null
		}
		if (['zod', 'zod/v4', 'convex/values'].includes(source)) return 'validator'
		const target = resolveImport(resolver, filename, source)
		const file = target && appFile(context, target)
		if (
			!target ||
			!file ||
			!/^(?:foundation\.ts|domain\/.+\/(?:schema|contracts)\.ts)$/.test(file) ||
			visited.has(target) ||
			visited.size >= 6
		)
			return null
		if (name === '*') return `namespace:${source}`
		const parsed = parseSync(target, readFileSync(target, 'utf8'))
		if (parsed.errors.length) return null
		// SAFETY: oxc-parser and the rule API share these declaration fields; provenance never reads rule-API loc/tokens.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions
		const remote = parsed.program as unknown as ESTree.Program
		const nextVisited = new Set(visited).add(target)
		const evaluateRemote = provenance(context, remote, target, nextVisited)
		for (const statement of remote.body) {
			if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue
			if (statement.declaration?.type === 'VariableDeclaration')
				for (const item of statement.declaration.declarations) {
					if (item.id.type === 'Identifier' && item.id.name === name) return evaluateRemote(item.id)
					if (item.id.type === 'ObjectPattern')
						for (const property of item.id.properties)
							if (
								property.type === 'Property' &&
								property.value.type === 'Identifier' &&
								property.value.name === name
							)
								return evaluateRemote(property.value)
				}
			for (const specifier of statement.specifiers)
				if (
					specifier.exportKind !== 'type' &&
					exportName(specifier.exported) === name &&
					!statement.source
				)
					return evaluateRemote(specifier.local)
		}
		return null
	}
	function member(owner: string | null, name: string): string | null {
		if (owner === 'foundation' && ['Command', 'Query'].includes(name)) return name
		if (owner?.startsWith('namespace:')) return imported(owner.slice(10), name)
		if (owner === 'validator' || owner === 'contract') return 'validator'
		if (owner === 'shape' && name === 'table') return 'table'
		if (owner === 'table' && ['index', 'searchIndex', 'vectorIndex'].includes(name))
			return 'indexFactory'
		return null
	}
	function evaluate(node: ESTree.Node, active = new Set<string>()): string | null {
		if (
			node.type === 'TSAsExpression' ||
			node.type === 'TSSatisfiesExpression' ||
			node.type === 'TSNonNullExpression'
		)
			return evaluate(node.expression, active)
		if (node.type === 'Identifier') {
			if (active.has(node.name)) return null
			const reference = imports.get(node.name)
			if (reference) return imported(reference.source, reference.name)
			const variable = variables.get(node.name)
			if (!variable) return null
			const value = evaluate(variable.expression, new Set(active).add(node.name))
			return variable.member ? member(value, variable.member) : value
		}
		if (node.type === 'MemberExpression')
			return member(evaluate(node.object, active), propertyName(node) ?? '')
		if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			const callee = evaluate(node.callee, active)
			if (callee === 'foundationFactory') return 'foundation'
			if (callee === 'Command' || callee === 'Query') return `registry:${callee}`
			if (callee === 'shapeFactory') return 'shape'
			if (callee === 'assemblyFactory') return 'assembly'
			if (callee === 'contractFactory' || callee === 'validator') return 'contract'
			if (callee === 'indexFactory') return 'table'
			return null
		}
		if (node.type === 'ObjectExpression') {
			const values = node.properties.map((property) =>
				property.type === 'Property' ? evaluate(property.value, active) : null,
			)
			if (values.length && values.every((value) => value === 'table' || value === 'topology'))
				return 'topology'
			if (
				values.some((value) => value === 'contract' || value === 'validator') &&
				values.every((value) => value === 'contract' || value === 'validator' || value === 'data')
			)
				return 'contract'
			if (values.every((value) => value === 'data')) return 'data'
		}
		if (node.type === 'Literal') return 'data'
		return null
	}
	return evaluate
}
