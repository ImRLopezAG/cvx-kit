// @vitest-environment node
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { afterAll, describe, it } from 'vite-plus/test'
import { rules } from '../../../src/oxlint'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cvx-domain-anatomy-')))
mkdirSync(join(root, 'backend/domain/tasks'), { recursive: true })
mkdirSync(join(root, 'backend/domain/fake'), { recursive: true })
writeFileSync(
	join(root, 'backend/foundation.ts'),
	"import { createFoundation as make } from 'cvx-kit'; const bound = make({}); export const Run = bound.Command; export const Read = bound.Query",
)
writeFileSync(join(root, 'backend/fake.ts'), 'export function Command() { return {} }')
writeFileSync(
	join(root, 'backend/domain/tasks/schema.ts'),
	"import { zodTable } from 'cvx-kit'; export const tasks = zodTable({})",
)
writeFileSync(
	join(root, 'backend/domain/fake/schema.ts'),
	'export const tasks = {toPublicDto(row) { return row }}',
)
mkdirSync(join(root, 'backend/domain/aliases'), { recursive: true })
writeFileSync(
	join(root, 'backend/domain/aliases/schema.ts'),
	"import * as kit from 'cvx-kit/zod-table'; const define = kit.zodTable; const table = define('tasks', () => ({})); export const tasks = table",
)
afterAll(() => rmSync(root, { recursive: true, force: true }))
RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({ cwd: root, languageOptions: { parserOptions: { lang: 'ts' } } })
const options = [{ convexDir: 'backend' }]
tester.run('physical-reserved-domain-files', rules['reserved-domain-file-anatomy'], {
	valid: [
		{
			filename: join(root, 'backend/domain/tasks/commands.ts'),
			options,
			code: "import { Run as Command } from '../../foundation'; export const commands = Command({ contract, context, audit, operations: ({ command }) => ({ save: command.handler((input, ctx) => save(input, ctx), { guard }) }) })",
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: "import * as foundation from '../../foundation'; export const queries = foundation.Read({ contract, context, operations: ({ query }) => ({ get: query.handler((input, ctx) => get(input, ctx)) }) })",
		},
		{
			filename: join(root, 'backend/domain/tasks/contracts.ts'),
			options,
			code: "import { z } from 'zod'; export const contracts = { save: { input: z.string(), result: z.string(), classification: 'business' } }",
		},
		{
			filename: join(root, 'backend/domain/tasks/commands.ts'),
			options,
			code: "import { Run as Command } from '../../foundation'; export const commands = Command({})",
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: "import * as foundation from '../../foundation'; export const queries = foundation.Read({})",
		},
		{
			filename: join(root, 'backend/domain/tasks/table.ts'),
			options,
			code: "import { tasks } from './schema'; export const tables = { tasks: tasks.table.index('by_id', ['id']) }",
		},
	],
	invalid: [
		{
			filename: join(root, 'backend/domain/tasks/commands.ts'),
			options,
			code: "import { Run } from '../../foundation'; const commands = Run({}); export type { commands }",
			errors: [{ messageId: 'anatomy' }],
		},
		{
			filename: join(root, 'backend/domain/tasks/commands.ts'),
			options,
			code: "import kit from 'cvx-kit'; const { Command } = kit.createFoundation({}); export const commands = Command({})",
			errors: [{ messageId: 'anatomy' }],
		},
		{
			filename: join(root, 'backend/domain/tasks/contracts.ts'),
			options,
			code: "export const contracts = { save: { classification: 'business' } }",
			errors: [{ messageId: 'anatomy' }],
		},
		{
			filename: join(root, 'backend/domain/fake/commands.ts'),
			options,
			code: "import { Command } from '../../fake'; export const commands = Command({})",
			errors: [{ messageId: 'anatomy' }],
		},
	],
})

tester.run('U7 table import declaration provenance', rules['no-manual-id-projection'], {
	valid: [
		{
			filename: join(root, 'backend/domain/tasks/read.ts'),
			options,
			code: "import { tasks } from './schema'; function read(tasks) { return {...tasks.toPublicDto(row), id: row._id} }",
		},
		{
			filename: join(root, 'backend/domain/tasks/read.ts'),
			options,
			code: "import { tasks } from '../fake/schema'; const dto = {...tasks.toPublicDto(row), id: row._id}",
		},
	],
	invalid: [
		{
			filename: join(root, 'backend/domain/tasks/read.ts'),
			options,
			code: "import { tasks } from '../aliases/schema'; const dto = {...tasks.toPublicDto(row), id: row._id}",
			errors: [{ messageId: 'projection' }],
		},
		{
			filename: join(root, 'backend/domain/tasks/read.ts'),
			options,
			code: "import { tasks as table } from './schema'; const alias = table; const dto = {...alias.toPublicDto(row), id: row._id}",
			errors: [{ messageId: 'projection' }],
		},
		{
			filename: join(root, 'backend/domain/tasks/read.ts'),
			options,
			code: "import * as tables from './schema'; const dto = {...tables.tasks.publicDto.parse(row), id: row._id}",
			errors: [{ messageId: 'projection' }],
		},
	],
})

const physicalRegistry =
	"import {Read as Query} from '../../foundation'; Query({context: host => host, operations: ({query}) => ({list: query.handler((input, ctx) => { CODE })})})"
const registryCase = (code, messageId) => ({
	filename: join(root, 'backend/domain/tasks/queries.ts'),
	options,
	code,
	errors: [{ messageId }],
})
tester.run('U7 R1 physical foundation read provenance', rules['no-unbounded-reads'], {
	valid: [
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalRegistry.replace(
				'CODE',
				"function f(query) { query.handler((input, ctx) => ctx.db.query('tasks').collect()) }",
			),
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalRegistry
				.replace("'../../foundation'", "'../../fake'")
				.replace('CODE', "ctx.db.query('tasks').collect()"),
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalRegistry
				.replace('host => host', 'host => ({db: local})')
				.replace('CODE', "ctx.db.query('tasks').collect()"),
		},
	],
	invalid: [
		registryCase(physicalRegistry.replace('CODE', "ctx.db.query('tasks').collect()"), 'bounded'),
		registryCase(
			physicalRegistry.replace('CODE', "ctx.include(ctx.db.query('tasks')).resolve()"),
			'bounded',
		),
		registryCase(
			physicalRegistry.replace(
				'CODE',
				"ctx.db.query('tasks').take(5).then(rows => rows.filter(predicate))",
			),
			'order',
		),
		registryCase(
			physicalRegistry
				.replace(
					"import {Read as Query} from '../../foundation'; Query",
					"import * as kit from '../../foundation'; kit.Read",
				)
				.replace('CODE', "ctx.db.query('tasks').collect()"),
			'bounded',
		),
	],
})

it('U7 R1 physical destructured foundation exports and fresh contexts', () => {
	const foundation = join(root, 'backend/foundation.ts')
	const original =
		"import { createFoundation as make } from 'cvx-kit'; const bound = make({}); export const Run = bound.Command; export const Read = bound.Query"
	const previousDescribe = RuleTester.describe,
		previousIt = RuleTester.it
	RuleTester.describe = (_, fn) => fn()
	RuleTester.it = (_, fn) => fn()
	try {
		for (const source of [
			"import {createFoundation} from 'cvx-kit'; export const {Query: Read} = createFoundation({})",
			"import {Foundation} from 'cvx-kit/components/foundation'; const kit = new Foundation({}); export const Read = kit.Query",
		]) {
			writeFileSync(foundation, source)
			tester.run('physical Query', rules['no-unbounded-reads'], {
				valid: [],
				invalid: [
					registryCase(
						physicalRegistry.replace('CODE', "ctx.db.query('tasks').collect()"),
						'bounded',
					),
					registryCase(
						physicalRegistry.replace(
							'query.handler((input, ctx) => { CODE })',
							"query({handler: (input, ctx) => ctx.db.query('tasks').collect()})",
						),
						'bounded',
					),
				],
			})
		}
		writeFileSync(foundation, 'export const Read = local')
		tester.run('fresh context', rules['no-unbounded-reads'], {
			valid: [
				{
					filename: join(root, 'backend/domain/tasks/queries.ts'),
					options,
					code: physicalRegistry.replace('CODE', "ctx.db.query('tasks').collect()"),
				},
				{
					filename: join(root, 'backend/domain/tasks/queries.ts'),
					options,
					code: physicalRegistry.replace(
						'query.handler((input, ctx) => { CODE })',
						"query({handler: (input, ctx) => ctx.db.query('tasks').collect()})",
					),
				},
			],
			invalid: [],
		})
	} finally {
		writeFileSync(foundation, original)
		RuleTester.describe = previousDescribe
		RuleTester.it = previousIt
	}
})

const physicalObjectRegistry = physicalRegistry.replace(
	'query.handler((input, ctx) => { CODE })',
	'query({input: schema, result: schema, handler: (input, ctx) => { CODE }})',
)
tester.run('U7 R2 physical object operation provenance', rules['no-unbounded-reads'], {
	valid: [
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalObjectRegistry.replace(
				'CODE',
				"ctx.db.query('tasks').take(5).then(rows => rows.map(project))",
			),
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalObjectRegistry
				.replace("'../../foundation'", "'../../fake'")
				.replace('CODE', "ctx.db.query('tasks').collect()"),
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalObjectRegistry.replace('CODE', "ctx = local; ctx.db.query('tasks').collect()"),
		},
		{
			filename: join(root, 'backend/domain/tasks/queries.ts'),
			options,
			code: physicalObjectRegistry.replace(
				'CODE',
				"function f(query) { query({handler: (input, ctx) => ctx.db.query('tasks').collect()}) }",
			),
		},
	],
	invalid: [
		registryCase(
			physicalObjectRegistry.replace('CODE', "ctx.db.query('tasks').collect()"),
			'bounded',
		),
		registryCase(
			physicalObjectRegistry.replace('CODE', "ctx.include(ctx.db.query('tasks')).resolve()"),
			'bounded',
		),
		registryCase(
			physicalObjectRegistry.replace(
				'CODE',
				"ctx.db.query('tasks').take(5).then(rows => rows.filter(predicate))",
			),
			'order',
		),
		registryCase(
			physicalObjectRegistry
				.replace(
					"import {Read as Query} from '../../foundation'; Query",
					"import * as kit from '../../foundation'; kit.Read",
				)
				.replace('CODE', "ctx.db.query('tasks').collect()"),
			'bounded',
		),
	],
})
