import { basename, dirname, relative, resolve, sep } from 'node:path'
import type {
	Context,
	CreateRule,
	ESTree,
	Plugin,
	Rule,
	RuleMeta,
	Scope,
	Visitor,
} from '@oxlint/plugins'
import { z } from 'zod'

const options = z.object({ convexDir: z.string().min(1).default('convex') })

export type RuleName =
	| 'component-boundaries'
	| 'no-component-env'
	| 'schema-file-boundaries'
	| 'no-internal-reexports'
	| 'public-api-first'
	| 'named-private-helpers'
	| 'no-raw-builders'
	| 'no-handwritten-references'
	| 'domain-import-boundaries'
	| 'public-functions-in-api'
	| 'thin-api-adapters'
	| 'no-inline-enums'
	| 'no-unbounded-reads'
	| 'no-manual-timestamps'
	| 'root-facade-ownership'

/** Consumer application rules derived from docs/conventions.md. */
const applicationRules: Record<RuleName, CreateRule> = {
	'root-facade-ownership': {
		meta: metadata('Configure shared kit infrastructure once in its root facade.', {
			facade: 'Configure {{name}} once in convex/{{file}}; import that facade elsewhere.',
		}),
		create(context) {
			if (componentRoot(context, context.filename)) return {}
			const seen = new Set<string>()
			function check(node: ESTree.CallExpression | ESTree.NewExpression) {
				const ref = imported(context, node.callee)
				if (!ref) return
				let file: string | null = null
				if (['cvx-kit', 'cvx-kit/auth'].includes(ref.source) && ref.name === 'createAuthFunctions')
					file = 'functions.ts'
				if (['cvx-kit', 'cvx-kit/triggers'].includes(ref.source) && ref.name === 'createTriggers')
					file = 'triggers.ts'
				if (
					['cvx-kit', 'cvx-kit/components/foundation'].includes(ref.source) &&
					ref.name === 'Foundation'
				)
					file = 'foundation.ts'
				if (!file) return
				if (appFile(context) !== file || seen.has(ref.name))
					context.report({ node, messageId: 'facade', data: { name: ref.name, file } })
				seen.add(ref.name)
			}
			return { CallExpression: check, NewExpression: check }
		},
	},
	'no-raw-builders': {
		meta: metadata('Build host functions through the auth-aware root constructors.', {
			builder:
				'Import raw builders only in convex/functions.ts; use auth*/role*/admin* or system* elsewhere.',
		}),
		create(context) {
			if (appFile(context) === 'functions.ts' || componentRoot(context, context.filename)) return {}
			return {
				ImportDeclaration(node) {
					if (node.importKind === 'type') return
					const source = node.source.value
					if (
						!/(?:^|\/)_generated\/server(?:\.[cm]?[jt]s)?$/.test(source) &&
						source !== 'convex/server'
					)
						return
					for (const specifier of node.specifiers) {
						if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
						const name =
							specifier.type === 'ImportSpecifier' ? exportName(specifier.imported) : null
						if (
							(name === null && source !== 'convex/server') ||
							(name &&
								/^(?:internal)?(?:Query|Mutation|Action)(?:Generic)?$|^(?:query|mutation|action)(?:Generic)?$/.test(
									name,
								))
						) {
							context.report({ node: specifier, messageId: 'builder' })
						}
					}
				},
				CallExpression(node) {
					const ref = imported(context, node.callee)
					if (
						ref?.source === 'convex/server' &&
						/^(?:internal)?(?:Query|Mutation|Action)Generic$|^(?:query|mutation|action)Generic$/.test(
							ref.name,
						) &&
						node.callee.type === 'MemberExpression'
					) {
						context.report({ node, messageId: 'builder' })
					}
				},
			}
		},
	},
	'no-handwritten-references': {
		meta: metadata('Use generated api/internal references.', {
			reference: 'Use generated api/internal references instead of makeFunctionReference.',
		}),
		create(context) {
			return {
				CallExpression(node) {
					const ref = imported(context, node.callee)
					if (ref?.source === 'convex/server' && ref.name === 'makeFunctionReference')
						context.report({ node, messageId: 'reference' })
				},
			}
		},
	},
	'domain-import-boundaries': {
		meta: metadata('Keep api, application, domain, and shared dependencies directed.', {
			boundary:
				'Follow api → application/domain → shared; sibling modules expose only rules.ts and queries.ts.',
		}),
		create(context) {
			const file = appFile(context)
			return sourceVisitors(context, (node, source) => {
				if (!file || !source.startsWith('.')) return
				const target = appFile(context, resolve(dirname(context.filename), source))?.replace(
					/\.[cm]?[jt]s$/,
					'',
				)
				if (!target) return
				const from = file.split('/')
				const to = target.split('/')
				let forbidden = false
				if (from[0] === 'domain') {
					forbidden = ['api', 'application'].includes(to[0])
					if (
						to[0] === 'domain' &&
						from[1] !== to[1] &&
						to[1] !== 'shared' &&
						from[1] !== 'table.ts'
					) {
						forbidden =
							from[1] === 'shared' || !['rules', 'queries'].includes(to.slice(2).join('/'))
					}
				} else if (from[0] === 'api') {
					forbidden =
						to[0] === 'api' ||
						(to[0] === 'domain' &&
							to[1] !== 'shared' &&
							to[1] !== basename(file).replace(/\.[cm]?[jt]s$/, ''))
				} else if (from[0] === 'application') forbidden = to[0] === 'api'
				if (forbidden) context.report({ node, messageId: 'boundary' })
			})
		},
	},
	'public-functions-in-api': {
		meta: metadata('Expose authenticated public functions only through api/.', {
			public: 'Declare public auth*/role*/admin* functions in convex/api/<module>.ts.',
		}),
		create(context) {
			if (appFile(context)?.startsWith('api/')) return {}
			return {
				CallExpression(node) {
					const ref = imported(context, node.callee)
					if (
						node.callee.type !== 'CallExpression' &&
						ref &&
						isFunctionsImport(context, ref.source) &&
						/^(auth|role|admin)(Query|Mutation|Action)$/.test(ref.name)
					)
						context.report({ node, messageId: 'public' })
				},
			}
		},
	},
	'thin-api-adapters': {
		meta: metadata('Keep business decisions and writes in domain executors.', {
			adapter:
				'Move business branches, private helpers, and database writes into the owning domain executor.',
		}),
		create(context) {
			if (!appFile(context)?.startsWith('api/')) return {}
			return {
				IfStatement(node) {
					context.report({ node, messageId: 'adapter' })
				},
				SwitchStatement(node) {
					context.report({ node, messageId: 'adapter' })
				},
				ConditionalExpression(node) {
					context.report({ node, messageId: 'adapter' })
				},
				Program(node) {
					const exported = exportedNames(node)
					for (const statement of node.body) {
						if (
							statement.type === 'FunctionDeclaration' &&
							statement.id &&
							!exported.has(statement.id.name)
						)
							context.report({ node: statement, messageId: 'adapter' })
						if (statement.type === 'VariableDeclaration')
							for (const declaration of statement.declarations) {
								if (
									declaration.id.type === 'Identifier' &&
									!exported.has(declaration.id.name) &&
									['ArrowFunctionExpression', 'FunctionExpression'].includes(
										declaration.init?.type ?? '',
									)
								)
									context.report({ node: declaration, messageId: 'adapter' })
							}
					}
				},
				CallExpression(node) {
					if (isDbWrite(node)) context.report({ node, messageId: 'adapter' })
				},
			}
		},
	},
	'no-inline-enums': {
		meta: metadata('Keep vocabularies in named constants.ts tuples.', {
			vocabulary: 'Define a named readonly tuple in constants.ts and pass it to z.enum().',
		}),
		create(context) {
			return {
				CallExpression(node) {
					const ref = imported(context, node.callee)
					let values = node.arguments[0]
					while (values?.type === 'TSAsExpression' || values?.type === 'TSSatisfiesExpression')
						values = values.expression
					if (
						ref &&
						/^zod(?:\/v4)?$/.test(ref.source) &&
						ref.name === 'enum' &&
						values?.type === 'ArrayExpression'
					)
						context.report({ node, messageId: 'vocabulary' })
				},
			}
		},
	},
	'no-unbounded-reads': {
		meta: metadata('Bound collection reads through include or pagination.', {
			bounded:
				'Use include(...).execute(limit) or bounded pagination; do not collect() or resolve() an unbounded query.',
		}),
		create(context) {
			if (componentRoot(context, context.filename)) return {}
			return {
				CallExpression(node) {
					if (node.callee.type !== 'MemberExpression') return
					const name = propertyName(node.callee)
					if (
						(name === 'collect' && hasCall(node.callee.object, 'query')) ||
						(name === 'resolve' && hasCall(node.callee.object, 'include'))
					)
						context.report({ node, messageId: 'bounded' })
				},
			}
		},
	},
	'no-manual-timestamps': {
		meta: metadata('Let timestamps triggers own createdAt and updatedAt.', {
			timestamp: 'Remove {{field}} from this write; register the timestamps trigger instead.',
		}),
		create(context) {
			if (componentRoot(context, context.filename)) return {}
			return {
				CallExpression(node) {
					if (!isDbWrite(node)) return
					const data = node.arguments.at(-1)
					if (data?.type !== 'ObjectExpression') return
					for (const property of data.properties) {
						if (property.type !== 'Property') continue
						const field = property.computed ? staticString(property.key) : exportName(property.key)
						if (field === 'createdAt' || field === 'updatedAt')
							context.report({ node: property, messageId: 'timestamp', data: { field } })
					}
				},
			}
		},
	},
	'component-boundaries': {
		meta: metadata('Keep portable components isolated and consume their client facades.', {
			boundary:
				'Components may import only their own files and npm dependencies; inject host policy through the client API.',
			facade: 'Import a component through its client.ts facade, not its private implementation.',
		}),
		create(context) {
			const owner = componentRoot(context, context.filename)

			return sourceVisitors(context, (node, specifier) => {
				if (!specifier.startsWith('.')) {
					if (
						/^cvx-kit\/components\/[^/]+\//.test(specifier) &&
						!/^cvx-kit\/components\/[^/]+\/convex\.config(?:\.js)?$/.test(specifier)
					) {
						context.report({ node, messageId: 'facade' })
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
					componentRoot(context, target) &&
					!/^client(?:\.[cm]?[jt]s)?$/.test(basename(target)) &&
					!(
						appFile(context) === 'convex.config.ts' &&
						/^convex\.config(?:\.[cm]?[jt]s)?$/.test(basename(target))
					)
				) {
					context.report({ node, messageId: 'facade' })
				}
			})
		},
	},
	'no-component-env': {
		meta: metadata('Pass environment configuration into portable components.', {
			env: 'Portable components must receive configuration through arguments; do not read process.env.',
		}),
		create(context) {
			if (!componentRoot(context, context.filename)) return {}
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
		meta: metadata('Keep storage shapes and indexes in their documented owners.', {
			schema: '{{builder}} belongs in {{file}}.',
		}),
		create(context) {
			return {
				CallExpression(node) {
					const ref = imported(context, node.callee)
					const file = appFile(context)
					if (!file) return
					let expected: string | null = null
					if (ref?.source === 'convex/server') {
						if (
							ref.name === 'defineSchema' &&
							file !== 'schema.ts' &&
							!(componentRoot(context, context.filename) && basename(file) === 'schema.ts')
						)
							expected = 'the root schema.ts (or a component schema.ts)'
						if (
							ref.name === 'defineTable' &&
							!(
								componentRoot(context, context.filename) &&
								['schema.ts', 'table.ts'].includes(basename(file))
							)
						)
							expected =
								'a component schema.ts/table.ts; host tables use zodTable in domain/<module>/schema.ts'
					}
					if (
						ref &&
						['cvx-kit', 'cvx-kit/zod-table'].includes(ref.source) &&
						['zodTable', 'tenantTable', 'zodVariantTable'].includes(ref.name) &&
						!/^domain\/[^/]+\/schema\.ts$/.test(file)
					)
						expected = 'domain/<module>/schema.ts'
					if (expected)
						context.report({
							node,
							messageId: 'schema',
							data: { builder: ref?.name ?? 'table', file: expected },
						})
					if (
						node.callee.type === 'MemberExpression' &&
						['index', 'searchIndex', 'vectorIndex'].includes(propertyName(node.callee) ?? '') &&
						isTableChain(node.callee.object) &&
						!componentRoot(context, context.filename) &&
						!/^domain\/[^/]+\/table\.ts$/.test(file)
					) {
						context.report({
							node,
							messageId: 'schema',
							data: { builder: 'Table indexes', file: 'domain/<module>/table.ts' },
						})
					}
				},
			}
		},
	},
	'no-internal-reexports': {
		meta: metadata('Import from owning modules directly; consumer apps have no barrels.', {
			reexport: 'Import from the owning file directly; do not re-export imports inside convex/.',
		}),
		create(context) {
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

export const rules: Record<RuleName, Rule> = scopeRules(applicationRules)
const plugin: Plugin = { meta: { name: 'cvx' }, rules }
export default plugin

function scopeRules(source: Record<RuleName, CreateRule>): Record<RuleName, Rule> {
	const scoped = { ...source }
	// SAFETY: source is the closed applicationRules record; its own keys are exactly RuleName.
	const names = Object.keys(source) as RuleName[]
	for (const name of names) {
		const rule = source[name]
		scoped[name] = {
			meta: {
				...rule.meta,
				schema: [
					{
						type: 'object',
						properties: { convexDir: { type: 'string', minLength: 1 } },
						additionalProperties: false,
					},
				],
			},
			create(context) {
				const file = appFile(context)
				if (
					!file ||
					/(?:^|\/)(?:_generated|__tests__)(?:\/|$)/.test(file) ||
					/\.(?:test|spec)\.[cm]?[jt]s$/.test(file)
				)
					return {}
				return rule.create(context)
			},
		}
	}
	return scoped
}

function appFile(context: Context, filename = context.filename) {
	const root = resolve(context.cwd, options.parse(context.options[0] ?? {}).convexDir)
	const file = relative(root, filename).split(sep).join('/')
	return file === '..' || file.startsWith('../') || file.startsWith('/') ? null : file
}

function imported(context: Context, node: ESTree.Node): { source: string; name: string } | null {
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

function sourceVisitors(
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

function isFunctionsImport(context: Context, source: string) {
	return (
		source.startsWith('.') &&
		appFile(context, resolve(dirname(context.filename), source))?.replace(/\.[cm]?[jt]s$/, '') ===
			'functions'
	)
}

function isTableChain(node: ESTree.Node): boolean {
	if (node.type === 'MemberExpression')
		return propertyName(node) === 'table' || isTableChain(node.object)
	return node.type === 'CallExpression' && isTableChain(node.callee)
}

function isDbWrite(node: ESTree.CallExpression) {
	return (
		node.callee.type === 'MemberExpression' &&
		['insert', 'patch', 'replace', 'delete'].includes(propertyName(node.callee) ?? '') &&
		node.callee.object.type === 'MemberExpression' &&
		propertyName(node.callee.object) === 'db'
	)
}

function hasCall(node: ESTree.Node, name: string): boolean {
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

function metadata(description: string, messages: Record<string, string>): RuleMeta {
	return { type: 'problem', docs: { description }, schema: [], messages }
}

function componentRoot(context: Context, filename: string) {
	const root = resolve(context.cwd, options.parse(context.options[0] ?? {}).convexDir)
	const file = relative(root, filename).split(sep).join('/')
	const match = file.match(/^components\/([^/]+)(?:\/|$)/)
	return match ? resolve(root, 'components', match[1]) : null
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
