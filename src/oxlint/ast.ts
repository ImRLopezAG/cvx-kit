import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { Context, ESTree, RuleMeta, Scope, Visitor } from '@oxlint/plugins'
import { z } from 'zod'
import { createResolver, resolveImport } from './architecture'

export const consumerOptions = z.object({ convexDir: z.string().min(1).default('convex') })

export function appFile(context: Context, filename = context.filename) {
	const requestedRoot = resolve(
		context.cwd,
		consumerOptions.parse(context.options[0] ?? {}).convexDir,
	)
	const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot
	const file = relative(root, existsSync(filename) ? realpathSync(filename) : filename)
		.split(sep)
		.join('/')
	return file === '..' || file.startsWith('../') || file.startsWith('/') ? null : file
}

export function imported(
	context: Context,
	node: ESTree.Node,
): { source: string; name: string } | null {
	if (node.type === 'CallExpression') return imported(context, node.callee)
	if (node.type === 'MemberExpression') {
		const owner = imported(context, node.object)
		const name = propertyName(node)
		return owner && name && ['*', 'z', 'default'].includes(owner.name)
			? { source: owner.source, name }
			: null
	}
	if (node.type !== 'Identifier') return null
	for (const def of binding(context, node)?.defs ?? []) {
		if (
			def.type !== 'ImportBinding' ||
			def.parent?.type !== 'ImportDeclaration' ||
			def.parent.importKind === 'type'
		)
			continue
		const specifier = def.node
		if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
		return {
			source: def.parent.source.value,
			name:
				specifier.type === 'ImportSpecifier'
					? (exportName(specifier.imported) ?? '')
					: specifier.type === 'ImportDefaultSpecifier'
						? 'default'
						: '*',
		}
	}
	return null
}

export function sourceVisitors(
	context: Context,
	check: (node: ESTree.Node, source: string) => void,
): Visitor {
	function visit(node: ESTree.Node, source: ESTree.Node | null | undefined) {
		const text = staticString(source)
		if (text) check(node, text)
	}
	return {
		ImportDeclaration(node) {
			visit(node, node.source)
		},
		ExportNamedDeclaration(node) {
			visit(node, node.source)
		},
		ExportAllDeclaration(node) {
			visit(node, node.source)
		},
		ImportExpression(node) {
			visit(node, node.source)
		},
		TSImportType(node) {
			visit(node, node.source)
		},
		CallExpression(node) {
			if (
				node.callee.type === 'Identifier' &&
				node.callee.name === 'require' &&
				!binding(context, node.callee)?.defs.length
			)
				visit(node, node.arguments[0])
		},
	}
}

export function isFunctionsImport(context: Context, source: string) {
	const target = source.startsWith('.')
		? resolve(dirname(context.filename), source)
		: resolveImport(createResolver(), context.filename, source)
	return target !== null && appFile(context, target)?.replace(/\.[cm]?[jt]s$/, '') === 'functions'
}

export function typeOnlySource(node: ESTree.Node) {
	return (
		node.type === 'TSImportType' ||
		(node.type === 'ImportDeclaration' &&
			(node.importKind === 'type' ||
				(node.specifiers.length > 0 &&
					node.specifiers.every(
						(specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
					)))) ||
		((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
			node.exportKind === 'type')
	)
}

export function isDbAccess(node: ESTree.CallExpression) {
	return (
		node.callee.type === 'MemberExpression' &&
		node.callee.object.type === 'MemberExpression' &&
		propertyName(node.callee.object) === 'db'
	)
}

export function isExternalCall(context: Context, node: ESTree.CallExpression) {
	const ref = imported(context, node.callee)
	if (ref && /^(?:node:)?(?:https?|net|tls|fs)(?:\/|$)|^(?:undici|axios)(?:\/|$)/.test(ref.source))
		return true
	return (
		(node.callee.type === 'Identifier' &&
			node.callee.name === 'fetch' &&
			!binding(context, node.callee)?.defs.length) ||
		(node.callee.type === 'MemberExpression' &&
			propertyName(node.callee) === 'fetch' &&
			node.callee.object.type === 'Identifier' &&
			node.callee.object.name === 'globalThis' &&
			!binding(context, node.callee.object)?.defs.length)
	)
}

export function containsComponentReference(context: Context, node: ESTree.Node): boolean {
	if (node.type === 'MemberExpression') {
		const owner = imported(context, node.object)
		if (owner?.name === 'components' && /_generated\/api/.test(owner.source)) return true
		return containsComponentReference(context, node.object)
	}
	if (node.type === 'ObjectExpression')
		return node.properties.some(
			(property) =>
				property.type === 'Property' && containsComponentReference(context, property.value),
		)
	return false
}

export function rootMember(node: ESTree.Node): ESTree.Node {
	return node.type === 'MemberExpression' ? rootMember(node.object) : node
}

export function memberPath(node: ESTree.Node): string[] {
	if (node.type === 'Identifier') return [node.name]
	if (node.type === 'MemberExpression')
		return [...memberPath(node.object), propertyName(node) ?? '']
	return []
}

export function isTableChain(node: ESTree.Node): boolean {
	if (node.type === 'MemberExpression')
		return propertyName(node) === 'table' || isTableChain(node.object)
	return node.type === 'CallExpression' && isTableChain(node.callee)
}

export function isDbWrite(node: ESTree.CallExpression) {
	return (
		node.callee.type === 'MemberExpression' &&
		['insert', 'patch', 'replace', 'delete'].includes(propertyName(node.callee) ?? '') &&
		node.callee.object.type === 'MemberExpression' &&
		propertyName(node.callee.object) === 'db'
	)
}

export function hasCall(node: ESTree.Node, name: string): boolean {
	if (node.type === 'CallExpression')
		return (
			(node.callee.type === 'MemberExpression' &&
				propertyName(node.callee) === name &&
				(name !== 'query' || propertyName(node.callee.object) === 'db')) ||
			hasCall(node.callee, name)
		)
	if (node.type === 'MemberExpression') return hasCall(node.object, name)
	return false
}

export function metadata(description: string, messages: Record<string, string>): RuleMeta {
	return { type: 'problem', docs: { description }, schema: [], messages }
}

export function componentRoot(context: Context, filename: string) {
	const requestedRoot = resolve(
		context.cwd,
		consumerOptions.parse(context.options[0] ?? {}).convexDir,
	)
	const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot
	const file = relative(root, existsSync(filename) ? realpathSync(filename) : filename)
		.split(sep)
		.join('/')
	const match = file.match(/^components\/([^/]+)(?:\/|$)/)
	return match ? resolve(root, 'components', match[1]) : null
}

export function staticString(node: ESTree.Node | null | undefined) {
	if (node?.type === 'Literal' && 'value' in node && String(node.value) === node.value)
		return String(node.value)
	if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
		return node.quasis[0].value.cooked
	return null
}

export function propertyName(node: ESTree.Node): string | null {
	if (node.type !== 'MemberExpression') return null
	return node.computed ? staticString(node.property) : node.property.name
}

export function binding(context: Context, node: ESTree.Node) {
	if (node.type !== 'Identifier') return null
	let scope: Scope | null = context.sourceCode.getScope(node)
	while (scope) {
		const variable = scope.set.get(node.name)
		if (variable) return variable
		scope = scope.upper
	}
	return null
}

export function exportedNames(program: ESTree.Program) {
	const names = new Set<string>()
	for (const statement of program.body) {
		if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
			for (const specifier of statement.specifiers) names.add(exportName(specifier.local) ?? '')
		} else if (
			statement.type === 'ExportDefaultDeclaration' &&
			statement.declaration.type === 'Identifier'
		) {
			names.add(statement.declaration.name)
		}
	}
	return names
}

export function exportName(node: ESTree.Node): string | null {
	return node.type === 'Identifier' ? node.name : staticString(node)
}

export function delegatingBody(node: ESTree.Node): boolean {
	if (node.type === 'CallExpression') return true
	if (node.type === 'AwaitExpression') return delegatingBody(node.argument)
	if (node.type === 'BlockStatement')
		return (
			node.body.length > 0 &&
			node.body.every(
				(statement) =>
					(statement.type === 'ReturnStatement' &&
						statement.argument !== null &&
						delegatingBody(statement.argument)) ||
					(statement.type === 'ExpressionStatement' && delegatingBody(statement.expression)),
			)
		)
	return false
}
