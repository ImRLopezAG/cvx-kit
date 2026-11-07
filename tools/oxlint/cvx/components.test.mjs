// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { afterAll, describe, it } from 'vite-plus/test'
import { rules } from '../../../src/oxlint'
import { rules as libraryRules } from './index'

RuleTester.describe = describe
RuleTester.it = it
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cvx-components-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const component = join(root, 'portable', 'outbox')
mkdirSync(component, { recursive: true })
writeFileSync(
	join(component, 'convex.config.ts'),
	`import { defineComponent as component } from 'convex/server'; export default component('outbox')`,
)
const tester = new RuleTester({
	cwd: process.cwd(),
	languageOptions: { parserOptions: { lang: 'ts' } },
})
const options = [{ convexDir: root }]
const schema =
	"import { zodTable as table } from 'cvx-kit/zod-table'; export const intents = table('intents', () => ({}))"

tester.run('component schema ownership', rules['schema-file-boundaries'], {
	valid: [
		{ filename: join(component, 'schema.ts'), options, code: schema },
		{
			filename: join(root, 'custom', 'schema.ts'),
			options: [{ convexDir: root, componentDirs: ['custom'] }],
			code: schema,
		},
	],
	invalid: [
		{
			filename: join(component, 'intents', 'queries.ts'),
			options,
			code: schema,
			errors: [{ messageId: 'schema' }],
		},
		{ filename: join(root, 'schema.ts'), options, code: schema, errors: [{ messageId: 'schema' }] },
	],
})
tester.run('component environment ownership', rules['no-component-env'], {
	valid: [
		{ filename: join(root, 'domain', 'orders', 'queries.ts'), options, code: 'process.env.FLAG' },
	],
	invalid: [
		{
			filename: join(component, 'functions.ts'),
			options,
			code: 'process.env.FLAG',
			errors: [{ messageId: 'env' }],
		},
	],
})
tester.run('component queries remain read only', rules['domain-file-responsibilities'], {
	valid: [
		{
			filename: join(component, 'intents', 'queries.ts'),
			options,
			code: 'export const read = (ctx) => ctx.db.get(id)',
		},
	],
	invalid: [
		{
			filename: join(component, 'intents', 'queries.ts'),
			options,
			code: "export const write = (ctx) => ctx.db.insert('intents', {})",
			errors: [{ messageId: 'ownership' }],
		},
	],
})
tester.run('library component schemas use zodTable', libraryRules['schema-file-boundaries'], {
	valid: [{ filename: join(component, 'schema.ts'), code: schema }],
	invalid: [
		{ filename: join(component, 'functions.ts'), code: schema, errors: [{ messageId: 'schema' }] },
	],
})

tester.run('component timestamps belong to triggers', rules['no-manual-timestamps'], {
	valid: [
		{
			filename: join(component, 'intents', 'commands.ts'),
			options,
			code: 'ctx.db.patch(id, { archivedAt: Date.now() })',
		},
	],
	invalid: [
		{
			filename: join(component, 'intents', 'commands.ts'),
			options,
			code: 'ctx.db.patch(id, { updatedAt: Date.now() })',
			errors: [{ messageId: 'timestamp' }],
		},
	],
})
tester.run('component raw builders belong to its functions facade', rules['no-raw-builders'], {
	valid: [
		{
			filename: join(component, 'functions.ts'),
			options,
			code: "import { mutation } from './_generated/server'",
		},
	],
	invalid: [
		{
			filename: join(component, 'intents', 'commands.ts'),
			options,
			code: "import { mutation } from '../_generated/server'",
			errors: [{ messageId: 'builder' }],
		},
	],
})
tester.run('component root facades own infrastructure', rules['root-facade-ownership'], {
	valid: [
		{
			filename: join(component, 'triggers.ts'),
			options,
			code: "import { createTriggers } from 'cvx-kit/triggers'; export const triggers = createTriggers()",
		},
	],
	invalid: [
		{
			filename: join(component, 'intents', 'commands.ts'),
			options,
			code: "import { createTriggers } from 'cvx-kit/triggers'; export const triggers = createTriggers()",
			errors: [{ messageId: 'facade' }],
		},
	],
})
tester.run('component reads must be bounded', rules['no-unbounded-reads'], {
	valid: [
		{
			filename: join(component, 'functions.ts'),
			options,
			code: "import { query } from './_generated/server'; query({ handler: ctx => ctx.db.query('intents').take(10) })",
		},
	],
	invalid: [
		{
			filename: join(component, 'functions.ts'),
			options,
			code: "import { query } from './_generated/server'; query({ handler: ctx => ctx.db.query('intents').collect() })",
			errors: [{ messageId: 'bounded' }],
		},
	],
})
// Real resolved sibling imports exercise the default and opt-in public surface.
mkdirSync(join(root, 'domain', 'communication', 'helpers'), { recursive: true })
writeFileSync(
	join(root, 'domain', 'communication', 'helpers', 'delivery.ts'),
	'export const notificationAllowed = true',
)
const sibling = {
	filename: join(root, 'domain', 'reminds', 'commands.ts'),
	code: "import { notificationAllowed } from '../communication/helpers/delivery'",
}
tester.run('explicit sibling domain public files', rules['domain-import-boundaries'], {
	valid: [
		{
			...sibling,
			options: [{ convexDir: root, domainPublicFiles: { communication: ['helpers/delivery'] } }],
		},
	],
	invalid: [
		{ ...sibling, options, errors: [{ messageId: 'boundary' }] },
		{
			...sibling,
			options: [{ convexDir: root, domainPublicFiles: { other: ['helpers/delivery'] } }],
			errors: [{ messageId: 'boundary' }],
		},
	],
})
for (const builder of ['zodTable', 'tenantTable', 'zodVariantTable']) {
	const code = `import { ${builder} as table } from 'cvx-kit/zod-table'; export const data = table('data', () => ({}))`
	tester.run(`component ${builder} storage files`, rules['schema-file-boundaries'], {
		valid: ['schema.ts', 'table.ts'].map((file) => ({
			filename: join(component, file),
			options,
			code,
		})),
		invalid: [
			{
				filename: join(component, 'functions.ts'),
				options,
				code,
				errors: [{ messageId: 'schema' }],
			},
		],
	})
}
tester.run('component index ownership', rules['schema-file-boundaries'], {
	valid: [
		{
			filename: join(component, 'table.ts'),
			options,
			code: "export const tables = { intents: intents.table.index('by_key', ['key']) }",
		},
	],
	invalid: [
		{
			filename: join(component, 'schema.ts'),
			options,
			code: "intents.table.index('by_key', ['key'])",
			errors: [{ messageId: 'schema' }],
		},
	],
})
const namespaced = join(root, 'namespaced')
const lookalike = join(root, 'lookalike')
for (const directory of [namespaced, lookalike]) mkdirSync(directory)
writeFileSync(
	join(namespaced, 'convex.config.ts'),
	"import * as c from 'convex/server'; const component = c.defineComponent('example'); export default component",
)
writeFileSync(
	join(lookalike, 'convex.config.ts'),
	"// defineComponent('fake')\nconst defineComponent = () => ({}); export default defineComponent()",
)
tester.run('component detection uses Convex config provenance', rules['no-component-env'], {
	valid: [{ filename: join(lookalike, 'functions.ts'), options, code: 'process.env.FLAG' }],
	invalid: [
		{
			filename: join(namespaced, 'functions.ts'),
			options,
			code: 'process.env.FLAG',
			errors: [{ messageId: 'env' }],
		},
	],
})
tester.run('library component index ownership', libraryRules['schema-file-boundaries'], {
	valid: [
		{ filename: join(component, 'table.ts'), code: "intents.table.index('by_key', ['key'])" },
	],
	invalid: [
		{
			filename: join(component, 'schema.ts'),
			code: "intents.table.index('by_key', ['key'])",
			errors: [{ messageId: 'schema' }],
		},
	],
})

mkdirSync(join(root, 'packages', 'shared'), { recursive: true })
mkdirSync(join(root, 'node_modules'), { recursive: true })
writeFileSync(join(root, 'packages', 'shared', 'index.ts'), 'export const value = 1')
writeFileSync(
	join(root, 'packages', 'shared', 'package.json'),
	JSON.stringify({ name: 'shared', main: 'index.ts' }),
)
symlinkSync(join(root, 'packages', 'shared'), join(root, 'node_modules', 'shared'))
tester.run('component imports installed workspace packages', rules['component-boundaries'], {
	valid: [
		{ filename: join(component, 'functions.ts'), options, code: "import { value } from 'shared'" },
	],
	invalid: [
		{
			filename: join(component, 'functions.ts'),
			options,
			code: "import { value } from '../../packages/shared/index'",
			errors: [{ messageId: 'boundary' }],
		},
	],
})
