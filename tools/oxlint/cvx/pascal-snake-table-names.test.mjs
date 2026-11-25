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
const filename = resolve('convex/functions.ts')
for (const table of ['Inventory_Items', 'Sales_PaymentJournals']) {
	const registration = (body) =>
		`import { queryGeneric } from 'convex/server'; export const list = queryGeneric({ handler: async ctx => { ${body} } });`
	// Every consumer rule must accept an otherwise valid bounded native read.
	for (const [name, rule] of Object.entries(rules)) {
		tester.run(`${name} accepts ${table}`, rule, {
			valid: [
				{
					filename,
					code: registration(
						`return ctx.db.query('${table}').filter(q => q.eq(q.field('status'), 'open')).take(5);`,
					),
				},
			],
			invalid: [],
		})
	}
	// Naming must not hide genuine unbounded reads or post-pagination filtering.
	tester.run(`no-unbounded-reads recognizes ${table}`, rules['no-unbounded-reads'], {
		valid: [],
		invalid: [
			{
				filename,
				code: registration(`return ctx.db.query('${table}').collect();`),
				errors: [{ messageId: 'bounded' }],
			},
			{
				filename,
				code: registration(
					`return (await ctx.db.query('${table}').take(5)).filter(row => row.status === 'open');`,
				),
				errors: [{ messageId: 'order' }],
			},
		],
	})
}
