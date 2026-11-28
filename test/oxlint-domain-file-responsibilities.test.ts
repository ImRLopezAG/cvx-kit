// @vitest-environment node
import { resolve } from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vite-plus/test'
import { rules } from '../src/oxlint'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
	cwd: process.cwd(),
	languageOptions: { parserOptions: { lang: 'ts' } },
})

tester.run('domain-file-responsibilities accepts Zod Mini', rules['domain-file-responsibilities'], {
	valid: ['rules', 'queries', 'schema', 'table', 'contracts', 'constants'].flatMap((role) =>
		['zod', 'zod/v4', 'zod/mini', 'zod/v4-mini'].map((source) => ({
			filename: resolve(`convex/domain/orders/${role}.ts`),
			code: `import * as z from '${source}'; export const name = z.string()`,
		})),
	),
	invalid: [
		{
			filename: resolve('convex/domain/orders/contracts.ts'),
			code: "import client from 'external-service'; export const name = client()",
			errors: [{ messageId: 'ownership' }],
		},
	],
})
