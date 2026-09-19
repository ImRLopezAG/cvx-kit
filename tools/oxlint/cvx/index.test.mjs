// @vitest-environment node
import { resolve } from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vite-plus/test'
import { rules } from './index'
import { rules as consumerRules } from '../../../src/oxlint'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
	cwd: process.cwd(),
	languageOptions: { parserOptions: { lang: 'ts' } },
})
const component = resolve('src/components/approvals/requests.ts')
const library = resolve('src/crud.ts')

tester.run('component-boundaries', rules['component-boundaries'], {
	valid: [
		{ filename: component, code: "import { x } from './validators'" },
		{ filename: component, code: "import { x } from 'convex/server'" },
		{ filename: component, code: "import { x } from 'cvx-kit/auth'" },
		{ filename: component, code: "import { x } from '@convex-dev/workflow'" },
		{ filename: component, code: "export { x } from './validators'" },
		{ filename: component, code: "function load(require) { return require('../../auth') }" },
		{ filename: library, code: "import { Foundation } from './components/foundation/client'" },
		{ filename: library, code: "export { Foundation } from './components/foundation/client.js'" },
	],
	invalid: [
		{
			filename: component,
			code: "import { x } from '../../auth'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "import type { X } from '../foundation/client'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "export * from '../../auth'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "export { x } from '../../auth'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "const x = import('../../auth')",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: 'const x = import(`../../auth`)',
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "const x = require('../../auth')",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "type X = import('../../auth').X",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "import { x } from 'cvx-kit/auth'",
			options: [{ packageName: 'cvx-kit' }],
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: component,
			code: "import { x } from '../approvals-extra/client'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: library,
			code: "import { x } from './components/foundation/modules/command/command'",
			errors: [{ messageId: 'facade' }],
		},
		{
			filename: library,
			code: "export * from './components/foundation/result'",
			errors: [{ messageId: 'facade' }],
		},
	],
})

tester.run('no-component-env', rules['no-component-env'], {
	valid: [
		{ filename: library, code: 'const flag = process.env.FLAG' },
		{ filename: component, code: 'function read(process) { return process.env.FLAG }' },
		{
			filename: component,
			code: 'function read(globalThis) { return globalThis.process.env.FLAG }',
		},
		{ filename: component, code: 'const flag = config.flag' },
		{ filename: component, code: 'process.version' },
	],
	invalid: [
		{ filename: component, code: 'const flag = process.env.FLAG', errors: [{ messageId: 'env' }] },
		{
			filename: component,
			code: "const flag = process['env'].FLAG",
			errors: [{ messageId: 'env' }],
		},
		{
			filename: component,
			code: 'const flag = globalThis.process.env.FLAG',
			errors: [{ messageId: 'env' }],
		},
		{
			filename: component,
			code: "import proc from 'node:process'; const flag = proc.env.FLAG",
			errors: [{ messageId: 'env' }],
		},
		{
			filename: component,
			code: "import * as proc from 'process'; const flag = proc.env.FLAG",
			errors: [{ messageId: 'env' }],
		},
		{
			filename: component,
			code: "import { env as settings } from 'node:process'",
			errors: [{ messageId: 'env' }],
		},
		{
			filename: component,
			code: 'const { env: settings } = process',
			errors: [{ messageId: 'env' }],
		},
	],
})

tester.run('schema-file-boundaries', rules['schema-file-boundaries'], {
	valid: [
		{
			filename: resolve('src/components/approvals/schema.ts'),
			code: "import { defineSchema, defineTable } from 'convex/server'; export default defineSchema({ items: defineTable({}) })",
		},
		{
			filename: resolve('src/components/approvals/table.ts'),
			code: "import { defineTable } from 'convex/server'; export const items = defineTable({})",
		},
		{ filename: component, code: 'function defineTable() {}; defineTable()' },
		{ filename: component, code: "import { defineTable } from './helpers'; defineTable()" },
		{
			filename: component,
			code: "import { defineTable } from 'convex/server'; function run(defineTable) { defineTable() }",
		},
		{
			filename: resolve('src/zod-table.ts'),
			code: "import { defineTable } from 'convex/server'; defineTable({})",
		},
	],
	invalid: [
		{
			filename: component,
			code: "import { defineTable } from 'convex/server'; defineTable({})",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: component,
			code: "import { defineSchema as schema } from 'convex/server'; schema({})",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: component,
			code: "import * as convex from 'convex/server'; convex.defineTable({})",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: component,
			code: "import * as convex from 'convex/server'; convex['defineSchema']({})",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: resolve('src/components/approvals/table.ts'),
			code: "import { defineSchema } from 'convex/server'; defineSchema({})",
			errors: [{ messageId: 'schema' }],
		},
	],
})

tester.run('no-internal-reexports', rules['no-internal-reexports'], {
	valid: [
		{
			cwd: '/consumer',
			filename: '/consumer/lib/public.ts',
			options: [{ entryPoints: ['lib/public.ts'] }],
			code: "export * from './implementation'",
		},
		{ filename: component, code: 'function ownHelper() {}; export default ownHelper' },
		{
			filename: resolve('src/zod-table.ts'),
			options: [{ entryPoints: ['src/zod-table.ts'] }],
			code: "export { zid } from 'convex-helpers/server/zod4'",
		},
		{
			filename: resolve('src/triggers.ts'),
			options: [{ entryPoints: ['src/triggers.ts'] }],
			code: "import { Triggers } from 'convex-helpers/server/triggers'; export { Triggers }",
		},
		{ filename: resolve('src/index.ts'), code: "export * from './errors'" },
		{
			filename: resolve('src/components/foundation/client.ts'),
			code: "export type { Operation } from './operation'",
		},
		{ filename: component, code: 'const value = 1; export { value }' },
	],
	invalid: [
		{
			cwd: '/consumer',
			filename: '/consumer/src/zod-table.ts',
			code: "export * from './implementation'",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: component,
			code: "export type { Input } from './validators'",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: component,
			code: "import { input } from './validators'; export { input }",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: component,
			code: "import helper from './validators'; export default helper",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: resolve('src/private-helper.ts'),
			code: "export * from './errors'",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: resolve('src/components/approvals/index.ts'),
			code: "export * from './requests'",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: resolve('src/helpers/index.ts'),
			code: "export * from '../errors'",
			errors: [{ messageId: 'reexport' }],
		},
	],
})

tester.run('public-api-first', rules['public-api-first'], {
	valid: [
		'export function run() { return helper() }; function helper() {}',
		'function run() {}; export { run }',
		'function run() {}; export default run',
		'export function run() {}; export type Value = string',
		'function helper() {}',
	],
	invalid: [
		{ code: 'function helper() {}; export function run() {}', errors: [{ messageId: 'order' }] },
		{
			code: 'export type Value = string; function helper() {}; export const value = 1',
			errors: [{ messageId: 'order' }],
		},
	],
})

tester.run('named-private-helpers', rules['named-private-helpers'], {
	valid: [
		'export const run = () => 1',
		'const run = () => 1; export { run }',
		'const run = () => 1; export default run',
		'function helper() {}',
		'export function run() { return [1].map(value => value + 1) }',
		'export const run = factory(() => 1)',
	],
	invalid: [
		{ code: 'const helper = () => 1', errors: [{ messageId: 'helper' }] },
		{ code: 'const helper = function helper() {}', errors: [{ messageId: 'helper' }] },
		{ code: 'const first = 1, helper = async () => first', errors: [{ messageId: 'helper' }] },
	],
})

tester.run('consumer/no-component-env', consumerRules['no-component-env'], {
	valid: [],
	invalid: [
		{
			filename: resolve('convex/components/example/handler.ts'),
			code: 'export const flag = process.env.FLAG',
			errors: [{ messageId: 'env' }],
		},
	],
})

tester.run('consumer/no-raw-builders', consumerRules['no-raw-builders'], {
	valid: [
		{
			filename: resolve('convex/functions.ts'),
			code: "import { query, mutation, internalMutation } from './_generated/server'",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import type { MutationCtx } from '../../_generated/server'",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { type MutationCtx } from '../../_generated/server'",
		},
		{
			filename: resolve('convex/http.ts'),
			code: "import { httpAction } from './_generated/server'",
		},
		{
			filename: resolve('convex/components/local/functions.ts'),
			code: "import { internalMutation } from './_generated/server'",
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { authMutation } from '../functions'",
		},
	],
	invalid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { mutation as raw } from '../_generated/server'",
			errors: [{ messageId: 'builder' }],
		},
		{
			filename: resolve('convex/domain/orders/callback.ts'),
			code: "import * as server from '../../_generated/server'",
			errors: [{ messageId: 'builder' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { mutationGeneric as raw } from 'convex/server'",
			errors: [{ messageId: 'builder' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import * as server from 'convex/server'; server.mutationGeneric({})",
			errors: [{ messageId: 'builder' }],
		},
	],
})

tester.run('consumer/no-handwritten-references', consumerRules['no-handwritten-references'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { internal } from '../../_generated/api'; internal.domain.orders.commands.save",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'function makeFunctionReference() {}; makeFunctionReference()',
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { makeFunctionReference } from 'convex/server'; function x(makeFunctionReference) { makeFunctionReference() }",
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { makeFunctionReference as ref } from 'convex/server'; ref('orders:save')",
			errors: [{ messageId: 'reference' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import * as c from 'convex/server'; c.makeFunctionReference('orders:save')",
			errors: [{ messageId: 'reference' }],
		},
	],
})

tester.run('consumer/domain-import-boundaries', consumerRules['domain-import-boundaries'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { x } from '../users/rules'",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { x } from '../users/queries.js'",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { x } from '../shared/provider'",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { x } from '../../foundation'",
		},
		{ filename: resolve('convex/domain/table.ts'), code: "import { x } from './users/table'" },
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { x } from '../application/checkout'",
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { x } from '../domain/orders/commands'",
		},
		{
			filename: resolve('convex/application/checkout.ts'),
			code: "import { x } from '../domain/users/commands'",
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { x } from '../users/commands'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "export { x } from '../../api/users'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/shared/helper.ts'),
			code: "const x = import('../users/queries')",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { x } from '../domain/users/queries'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "type X = import('../users/schema').X",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "const x = require('../../application/checkout')",
			errors: [{ messageId: 'boundary' }],
		},
	],
})

tester.run('consumer/public-functions-in-api', consumerRules['public-functions-in-api'], {
	valid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { roleMutation as write } from '../functions'; export const save = write('admin')({handler(){}})",
		},
		{
			filename: resolve('convex/domain/orders/callback.ts'),
			code: "import { systemMutation } from '../../functions'; export const apply = systemMutation({})",
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'function authMutation() {}; authMutation()',
		},
	],
	invalid: [
		{
			filename: resolve('convex/orders.ts'),
			code: "import { authMutation as write } from './functions'; export const save = write({})",
			errors: [{ messageId: 'public' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import * as f from '../../functions'; f.adminQuery({})",
			errors: [{ messageId: 'public' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { roleMutation } from '../../functions'; roleMutation('admin')({})",
			errors: [{ messageId: 'public' }],
		},
	],
})

tester.run('consumer/no-inline-enums', consumerRules['no-inline-enums'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import { z } from 'zod'; import { STATES } from './constants'; z.enum(STATES)",
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "const z = { enum(values) {return values} }; z.enum(['a'])",
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import { z as schema } from 'zod'; schema.enum(['draft', 'sent'])",
			errors: [{ messageId: 'vocabulary' }],
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import * as z from 'zod'; z.enum(['draft'])",
			errors: [{ messageId: 'vocabulary' }],
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import { z } from 'zod'; z.enum(['draft'] as const)",
			errors: [{ messageId: 'vocabulary' }],
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import { z } from 'zod'; z.enum(['draft'] satisfies string[])",
			errors: [{ messageId: 'vocabulary' }],
		},
	],
})

tester.run('consumer/no-unbounded-reads', consumerRules['no-unbounded-reads'], {
	valid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "ctx.include(ctx.db.query('orders')).execute(limit, rows => rows.map(orders.toPublicDto))",
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "ctx.include(ctx.db.query('orders')).paginate(options)",
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "Promise.resolve(1); collector.collect(); search.query('text').collect(); ctx.db.get(id)",
		},
	],
	invalid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "ctx.db.query('orders').withIndex('by_owner').collect()",
			errors: [{ messageId: 'bounded' }],
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: "ctx.include(ctx.db.query('orders')).matching('by_owner').resolve()",
			errors: [{ messageId: 'bounded' }],
		},
	],
})

tester.run('consumer/no-manual-timestamps', consumerRules['no-manual-timestamps'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'ctx.db.patch(id, { archivedAt: Date.now() })',
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "const publicFields = ['createdAt', 'updatedAt']",
		},
		{
			filename: resolve('convex/components/local/functions.ts'),
			code: 'ctx.db.patch(id, { updatedAt: Date.now() })',
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'ctx.db.patch(id, { updatedAt: Date.now() })',
			errors: [{ messageId: 'timestamp' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "ctx.db.insert('orders', { ['createdAt']: Date.now() })",
			errors: [{ messageId: 'timestamp' }],
		},
	],
})

tester.run('consumer/schema-file-boundaries', consumerRules['schema-file-boundaries'], {
	valid: [
		{
			filename: resolve('convex/schema.ts'),
			code: "import { defineSchema } from 'convex/server'; export default defineSchema(domainTables)",
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import { tenantTable as table } from 'cvx-kit/zod-table'; export const orders = table('orders', () => ({}))",
		},
		{
			filename: resolve('convex/domain/orders/table.ts'),
			code: "export const orderTables = { orders: orders.table.index('by_ownerId', ['ownerId']) }",
		},
		{
			filename: resolve('convex/components/local/schema.ts'),
			code: "import { defineTable } from 'convex/server'; export const local = defineTable({})",
		},
	],
	invalid: [
		{
			filename: resolve('convex/schema.ts'),
			code: "import { defineTable as table } from 'convex/server'; table({})",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import * as cvx from 'cvx-kit/zod-table'; cvx.zodTable('orders', () => ({}))",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "orders.table.index('by_ownerId', ['ownerId'])",
			errors: [{ messageId: 'schema' }],
		},
		{
			filename: resolve('convex/domain/orders/schema.ts'),
			code: "import * as c from 'convex/server'; c.defineSchema({})",
			errors: [{ messageId: 'schema' }],
		},
	],
})

tester.run('consumer/component-boundaries', consumerRules['component-boundaries'], {
	valid: [
		{
			filename: resolve('convex/components/local/handlers.ts'),
			code: "import { x } from './validators'",
		},
		{
			filename: resolve('convex/convex.config.ts'),
			code: "import local from './components/local/convex.config'",
		},
		{
			filename: resolve('convex/foundation.ts'),
			code: "import { Foundation } from 'cvx-kit/components/foundation'",
		},
		{
			filename: resolve('convex/foundation.ts'),
			code: "import { Client } from './components/local/client'",
		},
		{
			filename: resolve('convex/convex.config.ts'),
			code: "import foundation from 'cvx-kit/components/foundation/convex.config.js'",
		},
	],
	invalid: [
		{
			filename: resolve('convex/components/local/handlers.ts'),
			code: "import { x } from '../../functions'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/components/local/handlers.ts'),
			code: "import { x } from '../other/client'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { Command } from 'cvx-kit/components/foundation/modules/command/command'",
			errors: [{ messageId: 'facade' }],
		},
		{
			filename: resolve('convex/foundation.ts'),
			code: "import { x } from './components/local/handlers'",
			errors: [{ messageId: 'facade' }],
		},
	],
})

tester.run('consumer/no-internal-reexports', consumerRules['no-internal-reexports'], {
	valid: [
		{
			filename: resolve('convex/functions.ts'),
			code: 'const { authQuery } = createAuthFunctions({}); export { authQuery }',
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'export function executeSaveOrder() {}',
		},
	],
	invalid: [
		{
			filename: resolve('convex/index.ts'),
			code: "export * from './functions'",
			errors: [{ messageId: 'reexport' }],
		},
		{
			filename: resolve('convex/domain/orders/index.ts'),
			code: "import { save } from './commands'; export { save }",
			errors: [{ messageId: 'reexport' }],
		},
	],
})

tester.run('consumer/public-api-first', consumerRules['public-api-first'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'export function executeSaveOrder() {return help()}; function help() {return 1}',
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'function help() {return 1}; export function executeSaveOrder() {return help()}',
			errors: [{ messageId: 'order' }],
		},
	],
})

tester.run('consumer/named-private-helpers', consumerRules['named-private-helpers'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'export const executeSaveOrder = commands.exec({handler: () => help()}); function help() {return 1}',
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: 'const help = () => 1; export const result = help()',
			errors: [{ messageId: 'helper' }],
		},
	],
})

tester.run('consumer/thin-api-adapters', consumerRules['thin-api-adapters'], {
	valid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: 'export const save = authMutation({handler: (ctx, args) => executeSaveOrder(ctx, args)})',
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: "export const list = authQuery({handler: (ctx) => ctx.include(ctx.db.query('orders')).execute(10, rows => rows.map(orders.toPublicDto))})",
		},
	],
	invalid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "export const save = authMutation({handler: (ctx, args) => ctx.db.insert('orders', args)})",
			errors: [{ messageId: 'adapter' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: 'export const save = authMutation({handler: (ctx, args) => {if(args.x) return 1}})',
			errors: [{ messageId: 'adapter' }],
		},
		{
			filename: resolve('convex/api/orders.ts'),
			code: 'function help() {return 1}; export const n=1',
			errors: [{ messageId: 'adapter' }],
		},
	],
})

for (const [name, rule] of Object.entries(consumerRules)) {
	tester.run(`consumer scope/${name}`, rule, {
		valid: [
			{
				filename: resolve('src/components/local/example.ts'),
				code: 'export const flag = process.env.FLAG',
			},
			{ filename: resolve('convex/_generated/server.ts'), code: "export * from './other'" },
			{
				filename: resolve('convex/domain/orders/__tests__/commands.test.ts'),
				code: "import { mutation } from '../../../_generated/server'",
			},
		],
		invalid: [],
	})
}
tester.run('custom consumer root', consumerRules['no-component-env'], {
	valid: [
		{
			filename: resolve('convex/components/local/example.ts'),
			options: [{ convexDir: 'backend' }],
			code: 'export const flag = process.env.FLAG',
		},
	],
	invalid: [
		{
			filename: resolve('backend/components/local/example.ts'),
			options: [{ convexDir: 'backend' }],
			code: 'export const flag = process.env.FLAG',
			errors: [{ messageId: 'env' }],
		},
	],
})

tester.run('consumer/root-facade-ownership', consumerRules['root-facade-ownership'], {
	valid: [
		{
			filename: resolve('convex/functions.ts'),
			code: "import { createAuthFunctions } from 'cvx-kit/auth'; export const functions = createAuthFunctions({})",
		},
		{
			filename: resolve('convex/foundation.ts'),
			code: "import { Foundation } from 'cvx-kit/components/foundation'; export const { Command } = new Foundation(component)",
		},
	],
	invalid: [
		{
			filename: resolve('convex/api/orders.ts'),
			code: "import { createAuthFunctions as create } from 'cvx-kit/auth'; create({})",
			errors: [{ messageId: 'facade' }],
		},
		{
			filename: resolve('convex/domain/orders/commands.ts'),
			code: "import { Foundation as F } from 'cvx-kit/components/foundation'; new F(component)",
			errors: [{ messageId: 'facade' }],
		},
		{
			filename: resolve('convex/triggers.ts'),
			code: "import { createTriggers } from 'cvx-kit/triggers'; createTriggers(); createTriggers()",
			errors: [{ messageId: 'facade' }],
		},
	],
})

for (const [name, valid, invalid] of [
	[
		'root-wiring-only',
		[
			[
				'convex/convex.config.ts',
				"import { defineApp } from 'convex/server'; const app = defineApp(); export default app",
			],
			[
				'convex/mail.ts',
				"import { Resend } from '@convex-dev/resend'; import { components } from './_generated/api'; export const mail = new Resend(components.mail)",
			],
			[
				'convex/http.ts',
				"import { httpRouter } from 'convex/server'; import { receive } from './domain/orders/webhook'; const http = httpRouter(); http.route({path: '/orders', handler: receive}); export default http",
			],
		],
		[
			['convex/lib.ts', 'export function calculateTotal(x) { return x * 2 }'],
			['convex/crons.ts', 'export function calculateTotal(x) { return x * 2 }'],
			['convex/http.ts', 'export const handle = (ctx, req) => { if (req.ok) return 1; return 0 }'],
			['convex/schema.ts', 'export const schema = z.object({ value: z.string() })'],
			['convex/anything.ts', 'export const client = new Something()'],
		],
	],
	[
		'application-orchestration',
		[
			[
				'convex/application/checkout.ts',
				"import { save } from '../domain/orders/commands'; import { reserve } from '../domain/inventory/commands'; export async function checkout(ctx,args) { const result = await reserve(ctx,args); return save(ctx,result) }",
			],
		],
		[
			[
				'convex/application/services.ts',
				"import Stripe from 'stripe'; export const stripe = new Stripe('x')",
			],
			[
				'convex/application/checkout.ts',
				"import { save } from '../domain/orders/commands'; export const checkout = save",
			],
			[
				'convex/application/checkout.ts',
				"import { save } from '../domain/orders/commands'; import { reserve } from '../domain/inventory/commands'; export function checkout(ctx,args) { if (args.total > 100) return save(ctx,args); return reserve(ctx,args) }",
			],
			[
				'convex/application/checkout.ts',
				"import { save } from '../domain/orders/commands'; import { reserve } from '../domain/inventory/commands'; export function checkout(ctx,args) { return ctx.db.insert('orders', args) }",
			],
		],
	],
	[
		'internal-function-ownership',
		[
			[
				'convex/domain/orders/internal/callbacks.ts',
				"import { systemMutation } from '../../../functions'; export const run = systemMutation({})",
			],
			[
				'convex/migrations/backfill.ts',
				"import { systemMutation } from '../functions'; export const run = systemMutation({})",
			],
			[
				'convex/application/checkout.ts',
				"import { systemMutation } from '../functions'; export const run = systemMutation({})",
			],
			[
				'convex/components/demo/run.ts',
				"import { internalMutation } from './_generated/server'; export const run = internalMutation({})",
			],
		],
		[
			[
				'convex/api/orders.ts',
				"import { systemMutation } from '../functions'; export const run = systemMutation({})",
			],
			[
				'convex/jobs.ts',
				"import { systemAction } from './functions'; export const run = systemAction({})",
			],
			[
				'convex/domain/shared/run.ts',
				"import { systemQuery } from '../../functions'; export const run = systemQuery({})",
			],
		],
	],
	[
		'domain-file-responsibilities',
		[
			[
				'convex/domain/table.ts',
				"import { createModule } from 'cvx-kit/zod-table'; import { orderTables } from './orders/table'; export const domainTables = createModule(orderTables)",
			],
			['convex/domain/orders/rules.ts', 'export function canBuy(order) { return order.total > 0 }'],
			[
				'convex/domain/orders/queries.ts',
				'export function load(ctx) { return ctx.db.query("orders").take(10) }',
			],
			[
				'convex/domain/orders/actions.ts',
				'export async function send() { return fetch("https://example.com") }',
			],
			[
				'convex/domain/orders/integrations/github/client.ts',
				'export async function load() { return fetch("https://example.com") }',
			],
			[
				'convex/domain/orders/internal/callbacks.ts',
				'export function call(ctx) { return ctx.runMutation(ref, {}) }',
			],
		],
		[
			[
				'convex/domain/table.ts',
				'export function calculateTotal(order) { return order.total * 2 }',
			],
			[
				'convex/domain/table.ts',
				"import { createModule } from 'cvx-kit/zod-table'; import { save } from './orders/commands'; export const domainTables = createModule(save())",
			],
			['convex/domain/orders/rules.ts', 'export function allowed(ctx) { return ctx.db.get("id") }'],
			['convex/domain/orders/rules.ts', 'export function allowed() { return Date.now() > 0 }'],
			[
				'convex/domain/orders/queries.ts',
				'export function save(ctx) { return ctx.db.insert("orders", {}) }',
			],
			[
				'convex/domain/orders/queries.ts',
				'export function save(ctx) { return ctx.runMutation(ref,{}) }',
			],
			[
				'convex/domain/orders/commands.ts',
				'export function save() { return fetch("https://example.com") }',
			],
			[
				'convex/domain/orders/schema.ts',
				'export function save(ctx) { return ctx.db.insert("orders", {}) }',
			],
			[
				'convex/domain/orders/rules.ts',
				"import { save } from './commands'; export const canBuy = save",
			],
			[
				'convex/domain/orders/queries.ts',
				"import Stripe from 'stripe'; export const client = new Stripe('x')",
			],
		],
	],
]) {
	tester.run(name, consumerRules[name], {
		valid: valid.map(([filename, code]) => ({ filename: resolve(filename), code })),
		invalid: invalid.map(([filename, code]) => ({
			filename: resolve(filename),
			code,
			errors: [{ messageId: 'ownership' }],
		})),
	})
}

// Real filesystem fixtures prove resolution rather than only matching import text.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll } from 'vite-plus/test'
const aliasCwd = realpathSync(mkdtempSync(resolve(tmpdir(), 'cvx-lint-aliases-')))
for (const directory of [
	'convex/domain/orders',
	'convex/domain/users',
	'convex/domain/shared',
	'convex/api/orders',
	'convex/migrations',
	'convex/components/example',
	'convex/_generated',
])
	mkdirSync(resolve(aliasCwd, directory), { recursive: true })
writeFileSync(
	resolve(aliasCwd, 'tsconfig.base.json'),
	JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@cvx/*': ['convex/*'] } } }),
)
writeFileSync(
	resolve(aliasCwd, 'tsconfig.json'),
	'{ "extends": "./tsconfig.base.json", // JSONC supported\n "include": ["convex/**/*.ts"] }',
)
for (const file of [
	'domain/orders/commands.ts',
	'domain/users/commands.ts',
	'domain/users/queries.ts',
	'domain/shared/client.ts',
	'migrations/backfill.ts',
	'components/example/private.ts',
	'functions.ts',
	'_generated/server.ts',
])
	writeFileSync(resolve(aliasCwd, 'convex', file), 'export const value = 1')
afterAll(() => rmSync(aliasCwd, { recursive: true, force: true }))
const aliasTester = new RuleTester({
	cwd: aliasCwd,
	languageOptions: { parserOptions: { lang: 'ts' } },
})
aliasTester.run('resolved raw builders', consumerRules['no-raw-builders'], {
	valid: [
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import type { QueryCtx } from "@cvx/_generated/server"',
		},
	],
	invalid: [
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import { mutation } from "@cvx/_generated/server"',
			errors: [{ messageId: 'builder' }],
		},
	],
})
aliasTester.run('resolved domain boundaries', consumerRules['domain-import-boundaries'], {
	valid: [
		{
			filename: resolve(aliasCwd, 'convex/domain/table.ts'),
			code: 'import { tables } from "./orders/table"',
		},
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import { value } from "@cvx/domain/users/queries"',
		},
		{
			filename: resolve(aliasCwd, 'convex/api/orders/list.ts'),
			code: 'import { value } from "@cvx/domain/orders/commands"',
		},
	],
	invalid: [
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import { value } from "@cvx/domain/users/commands"',
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import("@cvx/migrations/backfill")',
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve(aliasCwd, 'convex/domain/shared/client.ts'),
			code: 'import { value } from "@cvx/domain/users/queries"',
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve(aliasCwd, 'convex/api/orders/list.ts'),
			code: 'import { value } from "@cvx/domain/users/commands"',
			errors: [{ messageId: 'boundary' }],
		},
	],
})
aliasTester.run('resolved component boundaries', consumerRules['component-boundaries'], {
	valid: [],
	invalid: [
		{
			filename: resolve(aliasCwd, 'convex/domain/orders/nested.ts'),
			code: 'import { value } from "@cvx/components/example/private"',
			errors: [{ messageId: 'facade' }],
		},
		{
			filename: resolve(aliasCwd, 'convex/components/example/private.ts'),
			code: 'import { value } from "@cvx/domain/users/queries"',
			errors: [{ messageId: 'boundary' }],
		},
	],
})
aliasTester.run('resolved constructor ownership', consumerRules['internal-function-ownership'], {
	valid: [],
	invalid: [
		{
			filename: resolve(aliasCwd, 'convex/api/orders/list.ts'),
			code: 'import { systemMutation as mutation } from "@cvx/functions"; export const run = mutation({})',
			errors: [{ messageId: 'ownership' }],
		},
	],
})

tester.run('query side-effect boundaries', consumerRules['domain-file-responsibilities'], {
	valid: [
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: 'export function fail() { throw new Error("missing") }',
		},
	],
	invalid: [
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: 'export function erase(ctx,id) { return ctx.storage.delete(id) }',
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/domain/orders/queries.ts'),
			code: 'import { systemMutation } from "../../functions"; export const save = systemMutation({})',
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/domain/orders/rules.ts'),
			code: 'export const allowed = process.env.FLAG',
			errors: [{ messageId: 'ownership' }],
		},
	],
})
