// @vitest-environment node
import { resolve } from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vite-plus/test'
import { rules } from '../../../src/oxlint'

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
