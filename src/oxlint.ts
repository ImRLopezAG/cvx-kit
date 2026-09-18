import { basename, dirname, relative, resolve, sep } from 'node:path'
import type { Context, ESTree, Plugin, Rule, RuleMeta, Scope } from '@oxlint/plugins'
import { z } from 'zod'

const entryPointOptions = z.object({ entryPoints: z.array(z.string()).default(['src/index.ts']) })
const componentOptions = z.object({ packageName: z.string().min(1).optional() })

export type RuleName =
	| 'component-boundaries'
	| 'no-component-env'
	| 'schema-file-boundaries'
	| 'no-internal-reexports'
	| 'public-api-first'
	| 'named-private-helpers'

/** Library rules derived from src/docs/conventions.md and architecture.md. */
export const rules: Record<RuleName, Rule> = {
	'component-boundaries': {
		meta: {
			...metadata('Keep portable components isolated and consume their client facades.', {
				boundary:
					'Components may import only their own files and npm dependencies; inject host policy through the client API.',
				facade: 'Import a component through its client.ts facade, not its private implementation.',
			}),
			schema: [
				{
					type: 'object',
					properties: { packageName: { type: 'string', minLength: 1 } },
					additionalProperties: false,
				},
			],
		},
		create(context) {
			const owner = componentRoot(context.filename)
			const { packageName } = componentOptions.parse(context.options[0] ?? {})
			function check(node: ESTree.Node, source: ESTree.Node | null | undefined) {
				const specifier = staticString(source)
				if (!specifier) return
				if (!specifier.startsWith('.')) {
					if (
						owner &&
						packageName &&
						(specifier === packageName || specifier.startsWith(`${packageName}/`))
					) {
						context.report({ node, messageId: 'boundary' })
					}
					return
				}
				const target = resolve(dirname(context.filename), specifier)
				if (
					owner &&
					(relative(owner, target).startsWith(`..${sep}`) || target === dirname(owner))
				) {
					context.report({ node, messageId: 'boundary' })
				} else if (
					!owner &&
					componentRoot(target) &&
					!/^client(?:\.[cm]?[jt]s)?$/.test(basename(target))
				) {
					context.report({ node, messageId: 'facade' })
				}
			}
			return {
				ImportDeclaration(node) {
					check(node, node.source)
				},
				ExportNamedDeclaration(node) {
					check(node, node.source)
				},
				ExportAllDeclaration(node) {
					check(node, node.source)
				},
				ImportExpression(node) {
					check(node, node.source)
				},
				TSImportType(node) {
					check(node, node.source)
				},
				CallExpression(node) {
					if (
						node.callee.type === 'Identifier' &&
						node.callee.name === 'require' &&
						!binding(context, node.callee)?.defs.length
					) {
						check(node, node.arguments[0])
					}
				},
			}
		},
	},
	'no-component-env': {
		meta: metadata('Pass environment configuration into portable components.', {
			env: 'Portable components must receive configuration through arguments; do not read process.env.',
		}),
		create(context) {
			if (!componentRoot(context.filename)) return {}
			function isProcess(node: ESTree.Node) {
				if (node.type !== 'Identifier') return false
				const variable = binding(context, node)
				if (node.name === 'process' && !variable?.defs.length) return true
				return variable?.defs.some(
					(def) =>
						def.type === 'ImportBinding' &&
						def.parent?.type === 'ImportDeclaration' &&
						['node:process', 'process'].includes(def.parent.source.value) &&
						['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(def.node.type),
				)
			}
			return {
				ImportDeclaration(node) {
					if (['node:process', 'process'].includes(node.source.value)) {
						for (const specifier of node.specifiers) {
							if (
								specifier.type === 'ImportSpecifier' &&
								exportName(specifier.imported) === 'env'
							) {
								context.report({ node: specifier, messageId: 'env' })
							}
						}
					}
				},
				MemberExpression(node) {
					if (propertyName(node) !== 'env') return
					const object = node.object
					const globalProcess =
						object.type === 'MemberExpression' &&
						propertyName(object) === 'process' &&
						object.object.type === 'Identifier' &&
						object.object.name === 'globalThis' &&
						!binding(context, object.object)?.defs.length
					if (isProcess(object) || globalProcess) context.report({ node, messageId: 'env' })
				},
				VariableDeclarator(node) {
					if (node.init && isProcess(node.init) && node.id.type === 'ObjectPattern') {
						for (const property of node.id.properties) {
							if (
								property.type === 'Property' &&
								(property.computed ? staticString(property.key) : exportName(property.key)) ===
									'env'
							) {
								context.report({ node: property, messageId: 'env' })
							}
						}
					}
				},
			}
		},
	},
	'schema-file-boundaries': {
		meta: metadata('Keep component storage definitions in schema.ts or table.ts.', {
			schema: '{{builder}} belongs in {{file}}, not a function or client module.',
		}),
		create(context) {
			if (!componentRoot(context.filename)) return {}
			return {
				CallExpression(node) {
					const callee = node.callee
					const identifier =
						callee.type === 'Identifier'
							? callee
							: callee.type === 'MemberExpression'
								? callee.object
								: null
					if (identifier?.type !== 'Identifier') return
					const definition = binding(context, identifier)?.defs.find(
						(def) =>
							def.type === 'ImportBinding' &&
							def.parent?.type === 'ImportDeclaration' &&
							def.parent.source.value === 'convex/server',
					)
					if (!definition) return
					const builder =
						definition.node.type === 'ImportSpecifier' && callee.type === 'Identifier'
							? exportName(definition.node.imported)
							: definition.node.type === 'ImportNamespaceSpecifier'
								? propertyName(callee)
								: null
					const file = basename(context.filename)
					if (builder === 'defineSchema' && file !== 'schema.ts') {
						context.report({ node, messageId: 'schema', data: { builder, file: 'schema.ts' } })
					} else if (builder === 'defineTable' && !['schema.ts', 'table.ts'].includes(file)) {
						context.report({
							node,
							messageId: 'schema',
							data: { builder, file: 'schema.ts or table.ts' },
						})
					}
				},
			}
		},
	},
	'no-internal-reexports': {
		meta: {
			...metadata('Keep re-exports at package entry points and component client facades.', {
				reexport:
					'Import from the owning file directly; only configured entry points and component client.ts facades may re-export.',
			}),
			schema: [
				{
					type: 'object',
					properties: { entryPoints: { type: 'array', items: { type: 'string' } } },
					additionalProperties: false,
				},
			],
		},
		create(context) {
			const file = context.filename.split(sep).join('/')
			const { entryPoints } = entryPointOptions.parse(context.options[0] ?? {})
			const isEntryPoint = entryPoints.some(
				(entry) => resolve(context.cwd, entry) === resolve(context.filename),
			)
			if (isEntryPoint || /\/src\/components\/[^/]+\/client\.ts$/.test(file)) return {}
			function check(node: ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration) {
				if (node.source) {
					context.report({ node, messageId: 'reexport' })
					return
				}
				for (const specifier of node.type === 'ExportNamedDeclaration' ? node.specifiers : []) {
					if (binding(context, specifier.local)?.defs.some((def) => def.type === 'ImportBinding')) {
						context.report({ node: specifier, messageId: 'reexport' })
					}
				}
			}
			return {
				ExportNamedDeclaration: check,
				ExportAllDeclaration: check,
				ExportDefaultDeclaration(node) {
					if (
						node.declaration.type === 'Identifier' &&
						binding(context, node.declaration)?.defs.some((def) => def.type === 'ImportBinding')
					) {
						context.report({ node, messageId: 'reexport' })
					}
				},
			}
		},
	},
	'public-api-first': {
		meta: metadata('Place private helper implementations after the exported API.', {
			order:
				'Move this private helper below the exported API so the file reads from public purpose to implementation.',
		}),
		create(context) {
			return {
				Program(node) {
					const exports = exportedNames(node)
					const lastExport = node.body.findLastIndex((statement) =>
						statement.type.startsWith('Export'),
					)
					for (const statement of node.body.slice(0, lastExport < 0 ? 0 : lastExport)) {
						if (
							statement.type === 'FunctionDeclaration' &&
							statement.id &&
							!exports.has(statement.id.name)
						) {
							context.report({ node: statement, messageId: 'order' })
						}
					}
				},
			}
		},
	},
	'named-private-helpers': {
		meta: metadata('Use named declarations for top-level private helper functions.', {
			helper: 'Declare this private helper with function name(...) at the bottom of the file.',
		}),
		create(context) {
			return {
				Program(node) {
					const exports = exportedNames(node)
					for (const statement of node.body) {
						if (statement.type !== 'VariableDeclaration') continue
						for (const declaration of statement.declarations) {
							if (
								declaration.id.type === 'Identifier' &&
								!exports.has(declaration.id.name) &&
								(declaration.init?.type === 'ArrowFunctionExpression' ||
									declaration.init?.type === 'FunctionExpression')
							) {
								context.report({ node: declaration, messageId: 'helper' })
							}
						}
					}
				},
			}
		},
	},
}

const plugin: Plugin = { meta: { name: 'cvx' }, rules }
export default plugin

function metadata(description: string, messages: Record<string, string>): RuleMeta {
	return { type: 'problem', docs: { description }, schema: [], messages }
}

function componentRoot(filename: string) {
	const match = filename
		.split(sep)
		.join('/')
		.match(/^(.*\/src\/components\/[^/]+)(?:\/|$)/)
	return match ? resolve(match[1]) : null
}

function staticString(node: ESTree.Node | null | undefined) {
	if (node?.type === 'Literal' && 'value' in node && String(node.value) === node.value)
		return String(node.value)
	if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
		return node.quasis[0].value.cooked
	return null
}

function propertyName(node: ESTree.Node): string | null {
	if (node.type !== 'MemberExpression') return null
	return node.computed ? staticString(node.property) : node.property.name
}

function binding(context: Context, node: ESTree.Node) {
	if (node.type !== 'Identifier') return null
	let scope: Scope | null = context.sourceCode.getScope(node)
	while (scope) {
		const variable = scope.set.get(node.name)
		if (variable) return variable
		scope = scope.upper
	}
	return null
}

function exportedNames(program: ESTree.Program) {
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

function exportName(node: ESTree.Node): string | null {
	return node.type === 'Identifier' ? node.name : staticString(node)
}
