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
