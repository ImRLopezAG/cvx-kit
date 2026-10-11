// @vitest-environment node
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it, expect } from 'vite-plus/test'
import { rules } from '../../../src/oxlint'
RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({
	cwd: process.cwd(),
	languageOptions: { parserOptions: { lang: 'ts' } },
})
const filename = resolve('convex/domain/orders/queries.ts')
const kit = "import { createQueryEngine as make } from 'cvx-kit/querying'; const engine = make({});"
const native =
	"import { query as q } from './_generated/server'; q({handler: async (ctx) => { CODE }});"
const testCase = (code, messageId) => ({ filename, code, errors: [{ messageId }] })

const functionsFile = resolve('convex/functions.ts')
for (const builder of [
	'queryGeneric',
	'internalQueryGeneric',
	'mutationGeneric',
	'internalMutationGeneric',
]) {
	const registrations = [
		`import {${builder}} from 'convex/server'; ${builder}(CALLBACK)`,
		`import {${builder} as run} from 'convex/server'; run(CALLBACK)`,
		`import * as server from 'convex/server'; server.${builder}(CALLBACK)`,
		`import {${builder} as read} from 'convex/server'; const alias = read; const run = alias; run(CALLBACK)`,
		`import * as server from 'convex/server'; const native = server; const run = native.${builder}; run(CALLBACK)`,
		`import * as server from 'convex/server'; const {${builder}: run} = server; run(CALLBACK)`,
		`import * as server from 'convex/server'; server['${builder}'](CALLBACK)`,
		`import * as server from 'convex/server'; const {['${builder}']: run} = server; run(CALLBACK)`,
	]
	for (const form of ['direct', 'object']) {
		const wrap = (callback) => (form === 'direct' ? callback : `{handler: ${callback}}`)
		const entry = (code) => ({ filename: functionsFile, code })
		const bodies = [
			["reader => reader.db.query('orders').collect()", 'bounded'],
			["async reader => (await reader.db.query('orders').take(5)).filter(predicate)", 'order'],
			["reader => reader.db.query('orders').take(5).then(rows => rows.filter(predicate))", 'order'],
			[
				"reader => reader.db.query('orders').paginate(opts).then(result => result.page.filter(predicate))",
				'order',
			],
			[
				"async function(reader) { const context = reader; const {['db']: db} = context; const result = await db.query('orders').paginate(opts); const {['page']: page} = result; const rows = page; return rows.filter(predicate) }",
				'order',
			],
		]
		const negatives = [
			`const run = ${builder}; run = local; run(CALLBACK)`,
			`let run = ${builder}; run(CALLBACK)`,
			`function f(${builder}) { ${builder}(CALLBACK) }`,
			`function f(server) { server.${builder}(CALLBACK) }`,
			`const native = server; native = local; native.${builder}(CALLBACK)`,
			`let native = server; native.${builder}(CALLBACK)`,
			`${builder}(other, CALLBACK)`,
			`const callback = reader => reader.db.query('orders').collect(); ${builder}(${form === 'direct' ? 'callback' : '{handler: callback}'})`,
			`function helper() { return ${builder} } helper()(CALLBACK)`,
			`${builder}()(CALLBACK)`,
			`const key = '${builder}'; server[key](CALLBACK)`,
			`const key = '${builder}'; const {[key]: run} = server; run(CALLBACK)`,
		]
		const unprovenCallbacks = [
			"reader => { reader = local; return reader.db.query('orders').collect() }",
			"(input, reader) => reader.db.query('orders').collect()",
			"reader => { function f(reader) { return reader.db.query('orders').collect() } }",
			"reader => { let context = reader; return context.db.query('orders').collect() }",
			"reader => { const context = reader; context = local; return context.db.query('orders').collect() }",
			"reader => { const context = reader; function f(context) { return context.db.query('orders').collect() } }",
			"reader => { const db = reader.db; db = local; return db.query('orders').collect() }",
			"reader => reader.db.query('orders').take(5).then(rows => { rows = local; return rows.filter(predicate) })",
			"reader => reader.db.query('orders').paginate(opts).then(result => { result = local; return result.page.filter(predicate) })",
			"reader => reader.db.query('orders').paginate(opts).then(result => { function f(result) { return result.page.filter(predicate) } })",
		]
		tester.run(`U7 R5 ${builder} ${form} provenance`, rules['no-unbounded-reads'], {
			valid: [
				...registrations.flatMap((code) =>
					[
						"async reader => (await reader.db.query('orders').take(5)).map(project)",
						"reader => reader.db.query('orders').filter(predicate).take(5).then(rows => rows.map(project))",
						"reader => reader.db.query('orders').filter(predicate).paginate(opts).then(result => result.page.map(project))",
					].map((callback) => entry(code.replace('CALLBACK', wrap(callback)))),
				),
				...unprovenCallbacks.map((callback) =>
					entry(`import {${builder}} from 'convex/server'; ${builder}(${wrap(callback)})`),
				),
				...negatives.map((code) =>
					entry(
						`import {${builder}} from 'convex/server'; import * as server from 'convex/server'; ` +
							code.replace('CALLBACK', wrap("reader => reader.db.query('orders').collect()")),
					),
				),
				...['./helpers', 'convex/server/foreign', './_generated/server'].map((source) =>
					entry(
						`import {${builder}} from '${source}'; ${builder}(${wrap("reader => reader.db.query('orders').collect()")})`,
					),
				),
				entry(
					`import * as server from './helpers'; server.${builder}(${wrap("reader => reader.db.query('orders').collect()")})`,
				),
				entry(
					`const ${builder} = local; ${builder}(${wrap("reader => reader.db.query('orders').collect()")})`,
				),
			],
			invalid: [
				...registrations.flatMap((code) =>
					bodies.map(([callback, messageId]) => ({
						...entry(code.replace('CALLBACK', wrap(callback))),
						errors: [{ messageId }],
						output: null,
					})),
				),
				{
					...entry(
						`import {${builder}} from 'convex/server'; ${builder}(${wrap("(reader, input) => reader.db.query('orders').collect()")})`,
					),
					errors: [{ messageId: 'bounded' }],
					output: null,
				},
				...(form === 'object'
					? [
							{
								...entry(
									`import {${builder}} from 'convex/server'; ${builder}({['handler']: reader => reader.db.query('orders').collect()})`,
								),
								errors: [{ messageId: 'bounded' }],
								output: null,
							},
							{
								...entry(
									`import {${builder}} from 'convex/server'; ${builder}({handler(reader) { return reader.db.query('orders').collect() }})`,
								),
								errors: [{ messageId: 'bounded' }],
								output: null,
							},
						]
					: []),
			],
		})
		tester.run(`U7 R5 ${builder} ${form} allowed registration`, rules['no-raw-builders'], {
			valid: registrations.map((code) => entry(code.replace('CALLBACK', wrap(bodies[0][0])))),
			invalid: [],
		})
	}
}
tester.run(
	'U7 R5 native generic actions have no database provenance',
	rules['no-unbounded-reads'],
	{
		valid: ['actionGeneric', 'internalActionGeneric', 'httpActionGeneric'].flatMap((builder) =>
			['CALLBACK', '{handler: CALLBACK}'].flatMap((form) =>
				[
					`import {${builder} as run} from 'convex/server'; run(${form})`,
					`import * as server from 'convex/server'; const run = server['${builder}']; run(${form})`,
				].flatMap((code) =>
					[
						"reader => reader.db.query('orders').collect()",
						"reader => reader.db.query('orders').take(5).then(rows => rows.filter(predicate))",
					].map((callback) => ({
						filename: functionsFile,
						code: code.replace('CALLBACK', callback),
					})),
				),
			),
		),
		invalid: [],
	},
)

const directQueries = [
	"import {query} from './_generated/server'; query(CALLBACK)",
	"import {internalQuery} from './_generated/server'; internalQuery(CALLBACK)",
	"import {query as read} from './_generated/server'; read(CALLBACK)",
	"import {internalQuery as read} from './_generated/server'; read(CALLBACK)",
	"import * as server from './_generated/server'; server.query(CALLBACK)",
	"import * as server from './_generated/server'; server.internalQuery(CALLBACK)",
	"import {query as q} from './_generated/server'; const read = q; const alias = read; alias(CALLBACK)",
	"import * as server from './_generated/server'; const native = server; const read = native.internalQuery; read(CALLBACK)",
	"import * as server from './_generated/server'; const {query: read} = server; read(CALLBACK)",
]
tester.run('U7 R3 direct native callback provenance', rules['no-unbounded-reads'], {
	valid: [
		...directQueries.map((code) => ({
			filename: functionsFile,
			code: code.replace(
				'CALLBACK',
				"async reader => (await reader.db.query('orders').take(5)).map(project)",
			),
		})),
		...[
			"import {query} from './_generated/server'; query(reader => { reader = local; return reader.db.query('orders').collect() })",
			"import {query} from './_generated/server'; query(async reader => { reader = local; return (await reader.db.query('orders').take(5)).filter(predicate) })",
			"import {query} from './_generated/server'; const read = query; read = local; read(reader => reader.db.query('orders').collect())",
			"import {query} from './_generated/server'; let read = query; read(reader => reader.db.query('orders').collect())",
			"import {query} from './_generated/server'; function f(query) { query(reader => reader.db.query('orders').collect()) }",
			"import * as server from './_generated/server'; function f(server) { server.internalQuery(reader => reader.db.query('orders').collect()) }",
			"import {query} from './_generated/server'; query(reader => { function f(reader) { return reader.db.query('orders').collect() } })",
			"import {query} from './_generated/server'; query(other, reader => reader.db.query('orders').collect())",
			"import * as server from './_generated/server'; server.internalQuery(other, reader => reader.db.query('orders').collect())",
			"import {query} from './_generated/server'; query((input, ctx) => ctx.db.query('orders').collect())",
			"import {query} from './helpers'; query(reader => reader.db.query('orders').collect())",
			"import * as server from './helpers'; server.internalQuery(reader => reader.db.query('orders').collect())",
			"const query = local; query(ctx => ctx.db.query('orders').collect())",
			"import {query} from './_generated/server'; function helper() { return query } helper()(reader => reader.db.query('orders').collect())",
			"import {query} from './_generated/server'; query()(reader => reader.db.query('orders').collect())",
			"import {query} from './_generated/server'; const callback = reader => reader.db.query('orders').collect(); query(callback)",
			"import {authQuery} from './functions'; authQuery(reader => reader.db.query('orders').collect())",
		].map((code) => ({ filename: functionsFile, code })),
	],
	invalid: [
		...directQueries.flatMap((code) => [
			{
				filename: functionsFile,
				code: code.replace('CALLBACK', "reader => reader.db.query('orders').collect()"),
				errors: [{ messageId: 'bounded' }],
				output: null,
			},
			{
				filename: functionsFile,
				code: code.replace(
					'CALLBACK',
					"async reader => (await reader.db.query('orders').take(5)).filter(predicate)",
				),
				errors: [{ messageId: 'order' }],
				output: null,
			},
		]),
		{
			filename: functionsFile,
			code: "import {internalQuery} from './_generated/server'; internalQuery(async function(reader) { const context = reader; return context.db.query('orders').collect() })",
			errors: [{ messageId: 'bounded' }],
			output: null,
		},
	],
})
tester.run('U7 R3 native registration allowed location', rules['no-raw-builders'], {
	valid: directQueries.map((code) => ({
		filename: functionsFile,
		code: code.replace('CALLBACK', "reader => reader.db.query('orders').collect()"),
	})),
	invalid: [],
})

for (const builder of ['mutation', 'internalMutation']) {
	const registrations = [
		`import {${builder}} from './_generated/server'; ${builder}(CALLBACK)`,
		`import {${builder} as write} from './_generated/server'; write(CALLBACK)`,
		`import * as server from './_generated/server'; server.${builder}(CALLBACK)`,
		`import {${builder} as write} from './_generated/server'; const alias = write; const run = alias; run(CALLBACK)`,
		`import * as server from './_generated/server'; const native = server; const run = native.${builder}; run(CALLBACK)`,
		`import * as server from './_generated/server'; const {${builder}: run} = server; run(CALLBACK)`,
		`import * as server from './_generated/server'; server['${builder}'](CALLBACK)`,
		`import * as server from './_generated/server'; const {['${builder}']: run} = server; run(CALLBACK)`,
		`import {${builder} as write} from './_generated/server.js'; write(CALLBACK)`,
	]
	tester.run(`U7 R4 direct ${builder} read provenance`, rules['no-unbounded-reads'], {
		valid: [
			...registrations.flatMap((code) =>
				[
					"async reader => (await reader.db.query('orders').take(5)).map(project)",
					"reader => reader.db.query('orders').filter(predicate).take(5).then(rows => rows.map(project))",
					"reader => reader.db.query('orders').paginate(opts).then(result => result.page.map(project))",
				].map((callback) => ({
					filename: functionsFile,
					code: code.replace('CALLBACK', callback),
				})),
			),
			...[
				`${builder}(reader => { reader = local; return reader.db.query('orders').collect() })`,
				`${builder}(reader => { reader = local; return reader.db.query('orders').take(5).then(rows => rows.filter(predicate)) })`,
				`const run = ${builder}; run = local; run(reader => reader.db.query('orders').collect())`,
				`let run = ${builder}; run(reader => reader.db.query('orders').collect())`,
				`function f(${builder}) { ${builder}(reader => reader.db.query('orders').collect()) }`,
				`${builder}(reader => { function f(reader) { return reader.db.query('orders').collect() } })`,
				`${builder}(other, reader => reader.db.query('orders').collect())`,
				`${builder}((input, reader) => reader.db.query('orders').collect())`,
				`const callback = reader => reader.db.query('orders').collect(); ${builder}(callback)`,
				`function helper() { return ${builder} } helper()(reader => reader.db.query('orders').collect())`,
				`${builder}()(reader => reader.db.query('orders').collect())`,
			].map((body) => ({
				filename: functionsFile,
				code: `import {${builder}} from './_generated/server'; ` + body,
			})),
			...[
				`import * as server from './_generated/server'; function f(server) { server.${builder}(reader => reader.db.query('orders').collect()) }`,
				`import * as server from './_generated/server'; const native = server; native = local; native.${builder}(reader => reader.db.query('orders').collect())`,
				`import * as server from './_generated/server'; const key = '${builder}'; server[key](reader => reader.db.query('orders').collect())`,
				`import * as server from './_generated/server'; const key = '${builder}'; const {[key]: run} = server; run(reader => reader.db.query('orders').collect())`,
				`import {${builder}} from './helpers'; ${builder}(reader => reader.db.query('orders').collect())`,
				`import * as server from './helpers'; server.${builder}(reader => reader.db.query('orders').collect())`,
				`const ${builder} = local; ${builder}(reader => reader.db.query('orders').collect())`,
			].map((code) => ({ filename: functionsFile, code })),
		],
		invalid: [
			...registrations.flatMap((code) =>
				[
					["reader => reader.db.query('orders').collect()", 'bounded'],
					["async reader => (await reader.db.query('orders').take(5)).filter(predicate)", 'order'],
					[
						"reader => reader.db.query('orders').take(5).then(rows => rows.filter(predicate))",
						'order',
					],
					[
						"reader => reader.db.query('orders').paginate(opts).then(result => result.page.filter(predicate))",
						'order',
					],
				].map(([callback, messageId]) => ({
					filename: functionsFile,
					code: code.replace('CALLBACK', callback),
					errors: [{ messageId }],
					output: null,
				})),
			),
			{
				filename: functionsFile,
				code: `import {${builder}} from './_generated/server'; ${builder}(async function(reader) { const context = reader; const {db} = context; return db.query('orders').collect() })`,
				errors: [{ messageId: 'bounded' }],
				output: null,
			},
			...[
				'reader => reader.db.query("orders").collect()',
				'reader => reader.db.query("orders").take(5).then(rows => rows.filter(predicate))',
			].map((callback, index) => ({
				filename: functionsFile,
				code: `import {${builder}} from './_generated/server'; ${builder}({handler: ${callback}})`,
				errors: [{ messageId: index === 0 ? 'bounded' : 'order' }],
				output: null,
			})),
		],
	})
	tester.run(`U7 R4 ${builder} registration allowed location`, rules['no-raw-builders'], {
		valid: registrations.map((code) => ({
			filename: functionsFile,
			code: code.replace('CALLBACK', "reader => reader.db.query('orders').collect()"),
		})),
		invalid: [],
	})
}
tester.run('U7 R4 action callbacks have no database provenance', rules['no-unbounded-reads'], {
	valid: ['action', 'internalAction'].flatMap((builder) =>
		[
			`import {${builder}} from './_generated/server'; ${builder}(reader => reader.db.query('orders').collect())`,
			`import * as server from './_generated/server'; const run = server['${builder}']; run(reader => reader.db.query('orders').take(5).then(rows => rows.filter(predicate)))`,
			`import {${builder}} from './_generated/server'; ${builder}({handler: reader => reader.db.query('orders').collect()})`,
		].map((code) => ({ filename: functionsFile, code })),
	),
	invalid: [],
})

tester.run('U7 bounded provenance', rules['no-unbounded-reads'], {
	valid: [
		{ filename, code: kit + 'engine(ctx).orders.filter(predicate).take(5).map(project)' },
		{
			filename,
			code: "const ctx = { db: local }; ctx.db.query('orders').collect(); ctx.include(rows).resolve()",
		},
		{
			filename,
			code: native.replace('CODE', "ctx.db.query('orders').filter(predicate).take(5).map(project)"),
		},
		{
			filename,
			code: "import { stream } from './helpers'; stream(reader, schema).query('orders').collect()",
		},
		{
			filename,
			code: native.replace(
				'CODE',
				"function f(ctx) { ctx.db.query('orders').take(5).filter(predicate) }",
			),
		},
		{ filename, code: kit + 'function f(engine) { engine(ctx).orders.take(5).filter(predicate) }' },
		{
			filename,
			code: "const engine = {query(){}}; engine.query('orders').take(5).filter(predicate); engine.related(row, 'items').collect()",
		},
		{ filename, code: kit + "engine(ctx).orders.relation(row._id, 'items').take(5)" },
	],
	invalid: [
		testCase(
			"import { stream as createStream } from 'convex-helpers/server/stream'; " +
				native.replace(
					'CODE',
					"const stream = createStream(ctx.db, schema); stream.query('orders').filterWith(predicate).flatMap(expand).collect()",
				),
			'bounded',
		),
		testCase(
			kit + "const stream = engine(ctx).orders.relation(row._id, 'items'); stream.collect()",
			'bounded',
		),
		testCase(
			kit + 'const rows = await engine(ctx).orders.take(5); rows.filter(predicate)',
			'order',
		),
		testCase(kit + 'engine(ctx).orders.execute(5).map(project).filter(predicate)', 'order'),
		testCase(
			native.replace(
				'CODE',
				"const db = ctx.db; const rows = await db.query('orders').paginate(opts); rows.page.filter(predicate)",
			),
			'order',
		),
		testCase(
			native.replace(
				'CODE',
				"const {db: reader} = ctx; const result = await reader.query('orders').take(5); result.filter(predicate)",
			),
			'order',
		),
		testCase(
			native.replace(
				'CODE',
				"const {page: rows} = await ctx.db.query('orders').paginate(opts); rows.filter(predicate)",
			),
			'order',
		),
		testCase(
			native.replace(
				'CODE',
				"importDummy(); const result = await ctx.db.query('orders').take(5); const alias = result; alias.filter(predicate)",
			),
			'order',
		),
	],
})

tester.run('U7 root factory locations', rules['root-facade-ownership'], {
	valid: [
		{ filename: resolve('convex/querying.ts'), code: kit },
		{
			filename: resolve('convex/relations.ts'),
			code: "import { defineRelations as define } from 'cvx-kit/relations'; export const relations = define(tables, r => ({}))",
		},
		{
			filename,
			code: "import { defineRelations } from 'cvx-kit/relations'; function f(defineRelations) { defineRelations({}) }",
		},
	],
	invalid: [
		testCase(kit, 'facade'),
		testCase(
			"import { defineRelations as def } from 'cvx-kit/relations'; const alias = def; alias(tables, r => ({}))",
			'facade',
		),
	],
})

const table =
	"import { zodTable as define } from 'cvx-kit/zod-table'; const orders = define('orders', () => ({}));"
tester.run('U7 manual ID projection', rules['no-manual-id-projection'], {
	valid: [
		{ filename, code: table + 'orders.toPublicDto(row, true)' },
		{
			filename,
			code: table + 'function f(orders) { return {...orders.toPublicDto(row), id: row._id} }',
		},
		{
			filename,
			code: 'const orders = {toPublicDto(){}}; const dto = {...orders.toPublicDto(row), id: row._id}',
		},
		{ filename, code: table + 'const dto = {...orders.toPublicDto(row), label: row.name}' },
	],
	invalid: [
		testCase(table + 'const dto = {...orders.toPublicDto(row), id: row._id}', 'projection'),
		testCase(table + 'const dto = {...orders.toPublicDto(row), _id: row._id}', 'projection'),
		testCase(table + 'const dto = orders.publicDto.parse(row); dto._id = row._id', 'projection'),
		testCase(table + 'const dto = orders.toPublicDto(row); dto.id = row._id', 'projection'),
		testCase(
			table +
				'const parsed = orders.publicDto.parse(row); const alias = parsed; const dto = {...alias, id: row._id}',
			'projection',
		),
		testCase(
			table +
				'const selected = orders.select(mask); const parsed = selected.parse(row); const dto = {id: row._id, ...parsed}',
			'projection',
		),
	],
})
tester.run('U7 copied native pagination', rules['no-copied-pagination'], {
	valid: [
		{ filename, code: 'const opts = {numItems: 5, cursor: "next"}' },
		{
			filename,
			code: "import { z } from 'zod'; function f(z) { return z.object({numItems: z.number(), cursor: z.string().nullable()}) }",
		},
		{
			filename,
			code: 'const z = local; z.object({page: z.array(row), isDone: z.boolean(), continueCursor: z.string()})',
		},
		{ filename, code: table + 'orders.paginationOpts(mask)' },
	],
	invalid: [
		testCase(
			"import { z as schema } from 'zod'; const z = schema; z.object({numItems: z.number(), cursor: z.string().nullable()})",
			'pagination',
		),
		testCase(
			"import { v as validator } from 'convex/values'; validator.object({page: validator.array(row), isDone: validator.boolean(), continueCursor: validator.string()})",
			'pagination',
		),
	],
})

tester.run('U7 root declaration anatomy', rules['root-wiring-only'], {
	valid: [
		{
			filename: resolve('convex/querying.ts'),
			code: "import { createQueryEngine as make } from 'cvx-kit/querying'; const alias = make; export const querying = alias({relations})",
		},
		{
			filename: resolve('convex/relations.ts'),
			code: "import * as kit from 'cvx-kit/relations'; const alias = kit; export const relations = alias.defineRelations(tables, r => ({orders: {items: r.many.items({from: r.orders.id.through(r.links.orderId), to: r.items.id.through(r.links.itemId)})}}))",
		},
	],
	invalid: [
		{
			filename: resolve('convex/querying.ts'),
			code: "import { createQueryEngine } from 'cvx-kit/querying'; import { save } from './domain/orders/commands'; export const querying = createQueryEngine({}); export const business = save",
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/querying.ts'),
			code: kit + 'export function business() { return 1 }',
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/relations.ts'),
			code: "import { defineRelations } from 'cvx-kit/relations'; export const relations = defineRelations(tables, r => { business(); return {} })",
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/querying.ts'),
			code: "import { createQueryEngine } from 'cvx-kit/querying'; import { components } from './_generated/api'; export const querying = createQueryEngine({component: components.foundation}); export const business = () => save()",
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/relations.ts'),
			code: "import { defineRelations } from './fake'; export const relations = defineRelations(tables, r => ({}))",
			errors: [{ messageId: 'ownership' }],
		},
	],
})
tester.run('U7 directed domain imports', rules['domain-import-boundaries'], {
	valid: [
		{ filename, code: "import { contract } from '../inventory/contracts'" },
		{
			filename: resolve('convex/relations.ts'),
			code: "import { orders } from './domain/orders/schema'",
		},
		{
			filename: resolve('convex/querying.ts'),
			code: "import { queries } from './domain/orders/queries'; import { contract } from './domain/orders/contracts'",
		},
	],
	invalid: [
		testCase("import { stock } from '../inventory/schema'", 'boundary'),
		testCase("import { commands } from '../inventory/commands'", 'boundary'),
		{
			filename: resolve('convex/relations.ts'),
			code: "import { commands } from './domain/orders/commands'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/querying.ts'),
			code: "import { storage } from './domain/orders/storage'",
			errors: [{ messageId: 'boundary' }],
		},
		{
			filename: resolve('convex/domain/shared/query.ts'),
			code: "import { contract } from '../orders/contracts'",
			errors: [{ messageId: 'boundary' }],
		},
	],
})

tester.run('U7 bounded callback ordering', rules['no-unbounded-reads'], {
	valid: [
		{
			filename,
			code: "import { createInclude } from 'cvx-kit/auth'; const include = createInclude(); function f(include) { include(query).execute(5, rows => rows.filter(predicate)) }",
		},
		{
			filename,
			code: native.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => rows.map(project))",
			),
		},
	],
	invalid: [
		testCase(
			native.replace('CODE', "ctx.db.query('orders').take(5).then(rows => rows.filter(predicate))"),
			'order',
		),
		testCase(
			native.replace(
				'CODE',
				"ctx.db.query('orders').paginate(opts).then(result => result.page.filter(predicate))",
			),
			'order',
		),
		testCase(
			"import { createInclude } from 'cvx-kit/auth'; import { authQuery } from '../../functions'; const include = createInclude(); authQuery({handler: ctx => include(ctx.db.query('orders')).execute(5, rows => rows.filter(predicate))})",
			'order',
		),
	],
})

const registry =
	"import { createFoundation as make } from 'cvx-kit'; const foundation = make({}); const {Query: Read} = foundation; Read({context: host => host, operations: ({query: operation}) => ({list: operation.handler((input, ctx) => { CODE })})})"
const auth = "import { authQuery } from '../../functions'; authQuery({handler: ctx => { CODE }})"
tester.run('U7 R1 registry and callback provenance', rules['no-unbounded-reads'], {
	valid: [
		{
			filename,
			code: registry.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => rows.map(project))",
			),
		},
		{
			filename,
			code: registry
				.replace('host => host', 'host => local')
				.replace('CODE', "ctx.db.query('orders').collect()"),
		},
		{ filename, code: registry.replace('CODE', "ctx = local; ctx.db.query('orders').collect()") },
		{
			filename,
			code: registry.replace(
				'CODE',
				"function f(operation) { operation.handler((input, ctx) => ctx.db.query('orders').collect()) }",
			),
		},
		{
			filename,
			code: "const Query = local; Query({context: host => host, operations: ({query}) => ({list: query.handler((input, ctx) => ctx.db.query('orders').collect())})})",
		},
		{ filename, code: auth.replace('CODE', "ctx = local; ctx.db.query('orders').collect()") },
		{
			filename,
			code: auth.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => { rows = other; return rows.filter(predicate) })",
			),
		},
		{
			filename,
			code: auth.replace(
				'CODE',
				"ctx.include(ctx.db.query('orders')).execute(5, rows => { rows = other; return rows.filter(predicate) })",
			),
		},
		{
			filename,
			code: auth.replace(
				'CODE',
				"ctx.include(ctx.db.query('orders')).paginate(opts, rows => rows.map(project))",
			),
		},
		{
			filename,
			code: auth.replace(
				'CODE',
				"ctx.include(ctx.db.query('orders')).paginate(opts, rows => { rows = other; return rows.filter(predicate) })",
			),
		},
		{
			filename,
			code: native.replace(
				'CODE',
				"const db = 'other'; const {[db]: reader} = ctx; reader.query('orders').collect()",
			),
		},
		{
			filename,
			code: native.replace(
				'CODE',
				"const page = 'other'; const {[page]: rows} = await ctx.db.query('orders').paginate(opts); rows.filter(predicate)",
			),
		},
	],
	invalid: [
		testCase(registry.replace('CODE', "ctx.db.query('orders').collect()"), 'bounded'),
		testCase(registry.replace('CODE', "ctx.include(ctx.db.query('orders')).resolve()"), 'bounded'),
		testCase(
			registry.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => rows.filter(predicate))",
			),
			'order',
		),
		testCase(
			registry.replace(
				'CODE',
				"ctx.include(ctx.db.query('orders')).paginate(opts, rows => rows.filter(predicate))",
			),
			'order',
		),
		testCase(
			auth.replace(
				'CODE',
				"ctx.include(ctx.db.query('orders')).paginate(opts, rows => rows.filter(predicate))",
			),
			'order',
		),
		testCase(
			native.replace('CODE', "const {['db']: reader} = ctx; reader.query('orders').collect()"),
			'bounded',
		),
		testCase(
			native.replace(
				'CODE',
				"const {['page']: rows} = await ctx.db.query('orders').paginate(opts); rows.filter(predicate)",
			),
			'order',
		),
	],
})
tester.run('U7 R1 computed DTO keys', rules['no-manual-id-projection'], {
	valid: [
		{
			filename,
			code: table + "const id = 'label'; const dto = {...orders.toPublicDto(row), [id]: 'label'}",
		},
	],
	invalid: [
		testCase(table + "const dto = {...orders.toPublicDto(row), ['_id']: row._id}", 'projection'),
	],
})
tester.run('U7 R1 computed pagination keys', rules['no-copied-pagination'], {
	valid: [
		{
			filename,
			code: "import {z} from 'zod'; const numItems = 'total', cursor = 'pointer'; z.object({[numItems]: z.number(), [cursor]: z.string()})",
		},
	],
	invalid: [
		testCase(
			"import {z} from 'zod'; z.object({['numItems']: z.number(), ['cursor']: z.string()})",
			'pagination',
		),
	],
})
tester.run('U7 R1 root callback placement', rules['root-wiring-only'], {
	valid: [],
	invalid: [
		{
			filename: resolve('convex/relations.ts'),
			code: "import {defineRelations} from 'cvx-kit/relations'; const helpers = {business: x => ({value: x})}; export const relations = defineRelations(tables, r => ({}))",
			errors: [{ messageId: 'ownership' }],
		},
		{
			filename: resolve('convex/relations.ts'),
			code: "import {defineRelations} from 'cvx-kit/relations'; export const relations = defineRelations({business: x => ({value: x})}, r => ({}))",
			errors: [{ messageId: 'ownership' }],
		},
	],
})
it('U7 R1 long recognized chains retain diagnostics within a bounded child', () => {
	const script = `
 import {registerHooks} from 'node:module';
 registerHooks({resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
   if (specifier.startsWith('.')) return next(specifier + '.ts', context);
   throw error;
  }
 }});
 const {RuleTester} = await import('oxlint/plugins-dev');
 const {rules} = await import('./src/oxlint.ts');
 RuleTester.describe = (_, fn) => fn(); RuleTester.it = (_, fn) => fn();
 const tester = new RuleTester({cwd: process.cwd(), languageOptions: {parserOptions: {lang: 'ts'}}});
 const start = performance.now();
 for (const length of [16, 80, 160]) {
  tester.run('chain', rules['no-unbounded-reads'], {valid: [], invalid: [{
   filename: ${JSON.stringify(filename)},
   code: ${JSON.stringify(native)}.replace('CODE', "ctx.db.query('orders')" + '.filter(predicate)'.repeat(length) + '.collect()'),
   errors: [{messageId: 'bounded'}]
  }]});
 }
 console.log('long-chain-ms=' + (performance.now() - start).toFixed(2));
 `
	const started = performance.now()
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: process.cwd(),
		encoding: 'utf8',
		timeout: 15000,
	})
	console.log(
		`U7 chain child elapsed-ms=${(performance.now() - started).toFixed(2)} ${result.stdout.trim()}`,
	)
	expect(result.error, result.stderr).toBeUndefined()
	expect(result.status, result.stderr).toBe(0)
}, 20000)

const objectRegistry =
	"import {createEffectFoundation} from 'cvx-kit/effect'; const foundation = createEffectFoundation({}); foundation.Query({context: host => host, operations: ({query: operation}) => ({list: operation({input: schema, result: schema, handler: (input, ctx) => { CODE }})})})"
tester.run('U7 R2 object operation context provenance', rules['no-unbounded-reads'], {
	valid: [
		{
			filename,
			code: objectRegistry.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => rows.map(project))",
			),
		},
		{
			filename,
			code: objectRegistry.replace('CODE', "ctx = local; ctx.db.query('orders').collect()"),
		},
		{
			filename,
			code: objectRegistry.replace('CODE', "function f(ctx) { ctx.db.query('orders').collect() }"),
		},
		{
			filename,
			code: objectRegistry.replace(
				'CODE',
				"function f(operation) { operation({handler: (input, ctx) => ctx.db.query('orders').collect()}) }",
			),
		},
		{
			filename,
			code: "import {createEffectFoundation} from 'cvx-kit/effect'; const f = createEffectFoundation({}); f.Query({context: host => host, operations: ({query}) => { query = local; return {list: query({handler: (input, ctx) => ctx.db.query('orders').collect()})} }})",
		},
		{
			filename,
			code: objectRegistry
				.replace('host => host', 'host => local')
				.replace('CODE', "ctx.db.query('orders').collect()"),
		},
		{
			filename,
			code: "const foundation = local; foundation.Query({context: host => host, operations: ({query}) => ({list: query({handler: (input, ctx) => ctx.db.query('orders').collect()})})})",
		},
		{
			filename,
			code: objectRegistry
				.replace('list: operation({', 'list: operation(other, {')
				.replace('CODE', "ctx.db.query('orders').collect()"),
		},
	],
	invalid: [
		testCase(objectRegistry.replace('CODE', "ctx.db.query('orders').collect()"), 'bounded'),
		testCase(
			objectRegistry.replace('CODE', "ctx.include(ctx.db.query('orders')).resolve()"),
			'bounded',
		),
		testCase(
			objectRegistry.replace(
				'CODE',
				"ctx.db.query('orders').take(5).then(rows => rows.filter(predicate))",
			),
			'order',
		),
		testCase(
			objectRegistry.replace(
				'CODE',
				"const alias = ctx; alias.include(alias.db.query('orders')).paginate(opts, rows => rows.filter(predicate))",
			),
			'order',
		),
	],
})
it('U7 R2 deep recognized chains and cycles complete within a bounded child', () => {
	const script = `
 import {registerHooks} from 'node:module';
 registerHooks({resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
   if (specifier.startsWith('.')) return next(specifier + '.ts', context);
   throw error;
  }
 }});
 const {RuleTester} = await import('oxlint/plugins-dev');
 const {rules} = await import('./src/oxlint.ts');
 RuleTester.describe = (_, fn) => fn(); RuleTester.it = (_, fn) => fn();
 const tester = new RuleTester({cwd: process.cwd(), languageOptions: {parserOptions: {lang: 'ts'}}});
 const code = ${JSON.stringify(native)}.replace('CODE', "ctx.db.query('orders')" + '.filter(predicate)'.repeat(1200) + '.collect()');
 const entry = {filename: ${JSON.stringify(filename)}, code};
 // Establish that the same deep source parses without invoking provenance.
 tester.run('parseable deep chain', {create() {return {}}}, {valid: [entry], invalid: []});
 const start = performance.now();
 tester.run('deep diagnostic', rules['no-unbounded-reads'], {valid: [], invalid: [{...entry, errors: [{messageId: 'bounded'}]}]});
 tester.run('cycles', rules['no-unbounded-reads'], {valid: [
  {filename: entry.filename, code: 'const a = b; const b = a; a.collect()'},
  {filename: entry.filename, code: 'const self = self; self.collect()'},
  {filename: entry.filename, code: 'const a = b.member; const b = a.member; a.collect()'},
  {filename: entry.filename, code: ${JSON.stringify(native)}.replace('CODE', "const a = b; const b = a; a.collect(); ctx.db.query('orders').take(5).map(project)")}
 ], invalid: []});
 tester.run('cycle does not poison recognized reads', rules['no-unbounded-reads'], {valid: [], invalid: [{
  filename: entry.filename, code: ${JSON.stringify(native)}.replace('CODE', "const a = b; const b = a; a.collect(); ctx.db.query('orders').collect()"), errors: [{messageId: 'bounded'}]
 }]});
 for (const builder of ['queryGeneric', 'internalQueryGeneric', 'mutationGeneric', 'internalMutationGeneric']) {
  for (const object of [false, true]) {
   const registration = body => "import {" + builder + "} from 'convex/server'; " + builder + '(' +
    (object ? '{handler: ctx => { ' + body + ' }}' : 'ctx => { ' + body + ' }') + ')';
   const deep = {filename: ${JSON.stringify(functionsFile)}, code: registration("ctx.db.query('orders')" + '.filter(predicate)'.repeat(1200) + '.collect()')};
   tester.run('generic materialization', {create() {return {CallExpression() {}}}}, {valid: [deep], invalid: []});
   tester.run('generic deep diagnostic', rules['no-unbounded-reads'], {valid: [], invalid: [{...deep, errors: [{messageId: 'bounded'}]}]});
   tester.run('generic cycle cache', rules['no-unbounded-reads'], {
    valid: [{filename: deep.filename, code: registration("const a = b.member; const b = a.member; a.collect(); ctx.db.query('orders').take(5).then(rows => rows.map(project))")}],
    invalid: [{filename: deep.filename, code: registration("const a = b.member; const b = a.member; a.collect(); ctx.db.query('orders').paginate(opts).then(result => result.page.filter(predicate))"), errors: [{messageId: 'order'}]}]
   });
  }
 }
 console.log('deep-1200-and-cycles-ms=' + (performance.now() - start).toFixed(2));
 `
	const started = performance.now()
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: process.cwd(),
		encoding: 'utf8',
		timeout: 15000,
	})
	console.log(
		`U7 R2 deep child elapsed-ms=${(performance.now() - started).toFixed(2)} ${result.stdout.trim()}`,
	)
	expect(result.error, result.stderr).toBeUndefined()
	expect(result.status, result.stderr).toBe(0)
}, 20000)
