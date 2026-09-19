import { existsSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { CreateRule, ESTree } from '@oxlint/plugins'
import {
	architectureAnchor,
	inspectArchitecture,
	createResolver,
	resolveImport,
} from './architecture'
import {
	consumerOptions,
	appFile,
	imported,
	sourceVisitors,
	isFunctionsImport,
	typeOnlySource,
	isDbAccess,
	isExternalCall,
	containsComponentReference,
	rootMember,
	memberPath,
	isDbWrite,
	metadata,
	componentRoot,
	propertyName,
	binding,
	exportedNames,
	delegatingBody,
} from './ast'

export const ownershipRules = {
	'project-structure': {
		meta: metadata('Validate the application tree, colocated tests, and module cycles.', {
			structure: '{{file}}: {{message}}',
		}),
		create(context) {
			const settings = consumerOptions.parse(context.options[0] ?? {})
			const root = resolve(context.cwd, settings.convexDir)
			if (
				(existsSync(context.filename)
					? realpathSync(context.filename)
					: resolve(context.filename)) !== architectureAnchor(root)
			)
				return {}
			return {
				Program(node) {
					for (const issue of inspectArchitecture({
						cwd: context.cwd,
						convexDir: settings.convexDir,
					}))
						context.report({
							node,
							messageId: 'structure',
							data: { file: issue.file, message: issue.message },
						})
				},
			}
		},
	},
	'root-wiring-only': {
		meta: metadata('Keep root files limited to configuration, assembly, and component facades.', {
			ownership:
				'Root files only wire configuration and components. Move behavior into domain/<module>/: {{reason}}.',
		}),
		create(context) {
			const file = appFile(context)
			if (!file || file.includes('/')) return {}
			let issue: ESTree.Node | null = null
			let reason = 'business implementation'
			let componentFacade = false
			const standard =
				/^(?:convex\.config|auth\.config|vite\.config|vitest\.config|auth|schema|functions|triggers|foundation|http|crons)\.[cm]?[jt]s$/.test(
					file,
				)
			function flag(node: ESTree.Node) {
				issue ??= node
			}
			return {
				Program(node) {
					if (
						node.body.some(
							(statement) =>
								statement.type === 'FunctionDeclaration' ||
								(statement.type === 'ExportNamedDeclaration' &&
									statement.declaration?.type === 'FunctionDeclaration'),
						)
					)
						flag(node)
				},
				NewExpression(node) {
					if (
						imported(context, node.callee) &&
						node.arguments.some((argument) => containsComponentReference(context, argument))
					)
						componentFacade = true
				},
				CallExpression(node) {
					if (
						imported(context, node.callee) &&
						node.arguments.some((argument) => containsComponentReference(context, argument))
					)
						componentFacade = true
					if (
						isDbWrite(node) ||
						isExternalCall(context, node) ||
						(file === 'schema.ts' && !(imported(context, node.callee)?.name === 'defineSchema'))
					)
						flag(node)
				},
				ArrowFunctionExpression(node) {
					if (!node.body || !delegatingBody(node.body)) flag(node)
				},
				FunctionExpression(node) {
					if (!node.body || !delegatingBody(node.body)) flag(node)
				},
				IfStatement: flag,
				SwitchStatement: flag,
				ConditionalExpression: flag,
				ForStatement: flag,
				ForOfStatement: flag,
				WhileStatement: flag,
				'Program:exit'(node) {
					if (!standard && !componentFacade) {
						issue = node
						reason = 'unknown root file; only declared component facades may add root source files'
					}
					if (issue) context.report({ node: issue, messageId: 'ownership', data: { reason } })
				},
			}
		},
	},
	'application-orchestration': {
		meta: metadata('Reserve application/ for thin cross-domain coordination.', {
			ownership:
				'application/ only coordinates two or more domains. Move schemas, providers, storage access, helpers, and business decisions into their owning domain.',
		}),
		create(context) {
			if (!appFile(context)?.startsWith('application/')) return {}
			const owners = new Set<string>()
			const resolver = createResolver()
			let issue: ESTree.Node | null = null
			function flag(node: ESTree.Node) {
				issue ??= node
			}
			const sources = sourceVisitors(context, (node, source) => {
				if (typeOnlySource(node)) return
				const target = resolveImport(resolver, context.filename, source)
				const path = target && appFile(context, target)
				const match = path?.match(/^domain\/([^/]+)\/(?:commands|queries|rules)(?:\.[cm]?[jt]s)?$/)
				if (match && match[1] !== 'shared') owners.add(match[1])
				if (path?.startsWith('domain/') && !match && !path.startsWith('domain/shared/')) flag(node)
				if (
					!path &&
					![
						'cvx-kit',
						'cvx-kit/components/foundation',
						'@convex-dev/workflow',
						'convex/values',
					].includes(source)
				)
					flag(node)
			})
			return {
				...sources,
				Program(node) {
					const publicNames = exportedNames(node)
					for (const statement of node.body) {
						if (
							statement.type === 'FunctionDeclaration' &&
							statement.id &&
							!publicNames.has(statement.id.name)
						)
							flag(statement)
						const declaration =
							statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
						if (
							declaration?.type === 'TSTypeAliasDeclaration' ||
							declaration?.type === 'TSInterfaceDeclaration'
						)
							flag(statement)
						if (declaration?.type === 'VariableDeclaration')
							for (const item of declaration.declarations) {
								if (
									item.init &&
									['ObjectExpression', 'ArrayExpression', 'Literal'].includes(item.init.type)
								)
									flag(item)
								if (
									statement.type === 'VariableDeclaration' &&
									item.id.type === 'Identifier' &&
									!publicNames.has(item.id.name) &&
									['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init?.type ?? '')
								)
									flag(item)
							}
					}
				},
				CallExpression(node) {
					sources.CallExpression?.(node)
					if (isDbAccess(node) || isExternalCall(context, node)) flag(node)
					const ref = imported(context, node.callee)
					if (ref && ['zod', 'zod/v4'].includes(ref.source)) flag(node)
				},
				MemberExpression(node) {
					const path = memberPath(node)
					if (path.length >= 4 && path[1] === 'domain') {
						const ref = imported(context, rootMember(node))
						if (ref?.name === 'internal' && /_generated\/api/.test(ref.source)) owners.add(path[2])
					}
				},
				NewExpression: flag,
				IfStatement: flag,
				SwitchStatement: flag,
				ConditionalExpression: flag,
				'Program:exit'(node) {
					if (owners.size < 2 || issue)
						context.report({ node: issue ?? node, messageId: 'ownership' })
				},
			}
		},
	},
	'internal-function-ownership': {
		meta: metadata('Place internal handlers with their owner, never in root, api/, or shared/.', {
			ownership:
				'Declare system/internal handlers in domain/<module>/, cross-domain application/, migrations/, or an isolated component.',
		}),
		create(context) {
			const file = appFile(context) ?? ''
			if (
				componentRoot(context, context.filename) ||
				/^(?:domain\/(?!shared\/)[^/]+\/|application\/|migrations\/)/.test(file)
			)
				return {}
			return {
				CallExpression(node) {
					if (node.callee.type === 'CallExpression') return
					const ref = imported(context, node.callee)
					if (
						ref &&
						((isFunctionsImport(context, ref.source) &&
							/^system(Query|Mutation|Action)$/.test(ref.name)) ||
							(/(?:_generated\/server|convex\/server)/.test(ref.source) &&
								/^internal(Query|Mutation|Action)(Generic)?$/.test(ref.name)))
					)
						context.report({ node, messageId: 'ownership' })
				},
			}
		},
	},
	'domain-file-responsibilities': {
		meta: metadata(
			'Keep invariants pure, reads read-only, shapes declarative, and I/O action-side.',
			{
				ownership:
					'Respect this domain file responsibility: pure rules, read-only queries, declarative schemas/tables/constants, and external I/O only in actions or integrations.',
			},
		),
		create(context) {
			const file = appFile(context) ?? ''
			const assembly = file === 'domain/table.ts'
			if (!assembly && !/^domain\/[^/]+\//.test(file)) return {}
			const role = basename(file).replace(/\.[cm]?[jt]s$/, '')
			const pure = role === 'rules'
			const read = role === 'queries'
			const declarative = ['schema', 'table', 'constants'].includes(role)
			const actionSide =
				/(?:^|\/)(?:actions|integrations|providers)(?:\/|\.)/.test(file) ||
				/(?:^|_)actions\./.test(file)
			const resolver = createResolver()
			let issue: ESTree.Node | null = null
			function flag(node: ESTree.Node) {
				issue ??= node
			}
			const sources = sourceVisitors(context, (node, source) => {
				if (typeOnlySource(node)) return
				const target = resolveImport(resolver, context.filename, source)
				const path = target && appFile(context, target)
				if (
					assembly &&
					source !== 'cvx-kit/zod-table' &&
					!/^domain\/[^/]+\/table(?:\.[cm]?[jt]s)?$/.test(path ?? '')
				)
					flag(node)
				if (pure && path && !/(?:^|\/)(?:rules|constants)(?:\.[cm]?[jt]s)?$/.test(path)) flag(node)
				if (
					(pure || read || declarative) &&
					!path &&
					![
						'zod',
						'zod/v4',
						'convex/values',
						'cvx-kit',
						'cvx-kit/zod-table',
						'cvx-kit/errors',
					].includes(source)
				)
					flag(node)
				if (
					read &&
					path &&
					/(?:^|\/)(?:commands|actions|integrations|providers)(?:[./]|$)/.test(path)
				)
					flag(node)
			})
			return {
				...sources,
				Program(node) {
					if (!assembly) return
					for (const statement of node.body) {
						if (statement.type === 'ImportDeclaration' || statement.type === 'EmptyStatement')
							continue
						const declaration =
							statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
						if (
							declaration?.type !== 'VariableDeclaration' ||
							declaration.declarations.some((item) => item.init?.type !== 'CallExpression')
						)
							flag(statement)
					}
				},
				CallExpression(node) {
					sources.CallExpression?.(node)
					if (assembly) {
						const ref = imported(context, node.callee)
						if (ref?.source !== 'cvx-kit/zod-table' || ref.name !== 'createModule') flag(node)
					}
					const method = node.callee.type === 'MemberExpression' ? propertyName(node.callee) : null
					if (
						(pure || declarative) &&
						(isDbAccess(node) ||
							['runQuery', 'runMutation', 'runAction', 'runAfter', 'runAt'].includes(method ?? ''))
					)
						flag(node)
					if (
						read &&
						(isDbWrite(node) ||
							['runMutation', 'runAction', 'runAfter', 'runAt'].includes(method ?? ''))
					)
						flag(node)
					const constructor = imported(context, node.callee)
					if (
						constructor &&
						isFunctionsImport(context, constructor.source) &&
						(pure || declarative || (read && /(?:Mutation|Action)$/.test(constructor.name)))
					)
						flag(node)
					if (
						read &&
						node.callee.type === 'MemberExpression' &&
						propertyName(node.callee.object) === 'storage' &&
						['store', 'delete', 'generateUploadUrl'].includes(method ?? '')
					)
						flag(node)
					if (!actionSide && isExternalCall(context, node)) flag(node)
					if (
						pure &&
						node.callee.type === 'MemberExpression' &&
						node.callee.object.type === 'Identifier' &&
						!binding(context, node.callee.object)?.defs.length &&
						((node.callee.object.name === 'Date' && method === 'now') ||
							(node.callee.object.name === 'Math' && method === 'random'))
					)
						flag(node)
				},
				MemberExpression(node) {
					if (pure && ['db', 'storage', 'scheduler', 'env'].includes(propertyName(node) ?? ''))
						flag(node)
				},
				NewExpression(node) {
					if (!(pure || read || declarative)) return
					if (
						node.callee.type === 'Identifier' &&
						!binding(context, node.callee)?.defs.length &&
						['Error', 'TypeError', 'RangeError', 'Set', 'Map', 'RegExp'].includes(node.callee.name)
					)
						return
					flag(node)
				},
				'Program:exit'() {
					if (issue) context.report({ node: issue, messageId: 'ownership' })
				},
			}
		},
	},
} satisfies Record<string, CreateRule>

export type OwnershipRuleName = keyof typeof ownershipRules
