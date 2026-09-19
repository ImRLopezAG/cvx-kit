import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rules } from '../dist/oxlint.mjs'

const root = join(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-oxlint-'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ruleNames = Object.keys(rules)
assert.equal(ruleNames.length, 20)

try {
	run('bun', ['pm', 'pack', '--destination', temporary, '--ignore-scripts'], root)
	for (const installer of ['npm', 'bun']) {
		const fixture = join(temporary, installer)
		mkdirSync(join(fixture, 'convex/components/example'), { recursive: true })
		mkdirSync(join(fixture, 'convex/api'), { recursive: true })
		mkdirSync(join(fixture, 'convex/domain/orders'), { recursive: true })
		writeFileSync(
			join(fixture, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${join(temporary, `cvx-kit-${manifest.version}.tgz`)}`,
					convex: manifest.devDependencies.convex,
					'convex-helpers': manifest.devDependencies['convex-helpers'],
					zod: manifest.devDependencies.zod,
				},
				devDependencies: { oxlint: manifest.devDependencies.oxlint },
			}),
		)
		run(installer, ['install', '--ignore-scripts'], fixture)
		writeFileSync(
			join(fixture, '.oxlintrc.json'),
			JSON.stringify({
				jsPlugins: [{ name: 'cvx', specifier: 'cvx-kit/oxlint' }],
				rules: Object.fromEntries(ruleNames.map((name) => [`cvx/${name}`, 'error'])),
			}),
		)
		writeFileSync(
			join(fixture, 'convex/api/orders.ts'),
			"import { authMutation } from '../functions'; import { executeSaveOrder } from '../domain/orders/commands'; export const save = authMutation({ handler: (ctx, args) => executeSaveOrder(ctx, args) })\n",
		)
		writeFileSync(
			join(fixture, 'convex/components/example/client.ts'),
			'export function run() { return 1 }\n',
		)
		for (const directory of ['api', 'components/example']) {
			mkdirSync(join(fixture, 'convex', directory, '__tests__'), { recursive: true })
			writeFileSync(
				join(fixture, 'convex', directory, '__tests__/behavior.test.ts'),
				'test("behavior", () => { expect(1).toBe(1) })',
			)
		}
		const oxlint = join(fixture, 'node_modules/.bin/oxlint')
		run(oxlint, ['--config', '.oxlintrc.json', 'convex'], fixture)
		writeFileSync(
			join(fixture, 'convex/components/example/bad.ts'),
			`
import { defineTable } from 'convex/server'
import { host } from '../../host'
function helper() { return process.env.SECRET }
const privateHelper = () => helper()
export const table = defineTable({})
export { host }
export const value = privateHelper()
`,
		)
		writeFileSync(
			join(fixture, 'convex/host.ts'),
			"import { authMutation } from './functions'; export const save = authMutation({}); export const host = 1; import './components/example/bad'\n",
		)
		writeFileSync(
			join(fixture, 'convex/api/orders.ts'),
			`import { mutation } from '../_generated/server'
import { makeFunctionReference as ref } from 'convex/server'
import { z } from 'zod'
import { createAuthFunctions } from 'cvx-kit/auth'
import { other } from '../domain/users/commands'
export const save = mutation({ handler: async (ctx) => {
  await ctx.db.insert('orders', { updatedAt: Date.now() })
  return ctx.db.query('orders').collect()
}})
export const constructors = createAuthFunctions({})
export const state = z.enum(['draft'])
export const target = ref('orders:save')
export const value = other
`,
		)
		mkdirSync(join(fixture, 'convex/application'), { recursive: true })
		writeFileSync(
			join(fixture, 'convex/application/provider.ts'),
			"import Stripe from 'stripe'; export const provider = new Stripe('key')",
		)
		writeFileSync(
			join(fixture, 'convex/domain/orders/queries.ts'),
			"export function save(ctx) { return ctx.db.insert('orders', {}) }",
		)
		writeFileSync(
			join(fixture, 'convex/api/internal.ts'),
			"import { systemMutation } from '../functions'; export const internal = systemMutation({})",
		)
		const invalid = spawnSync(
			oxlint,
			['--config', '.oxlintrc.json', '--format', 'json', 'convex'],
			{
				cwd: fixture,
				encoding: 'utf8',
			},
		)
		assert.ifError(invalid.error)
		assert.equal(invalid.status, 1, invalid.stderr)
		const diagnostics = JSON.parse(invalid.stdout).diagnostics
		for (const name of ruleNames) {
			assert.ok(
				diagnostics.some((item) => item.code === `cvx(${name})`),
				`${installer}: missing ${name}: ${invalid.stdout}`,
			)
		}
		writeFileSync(
			join(fixture, 'plugin-types.ts'),
			`
import plugin, { rules, checkArchitecture, type ArchitectureDiagnostic, type RuleName } from 'cvx-kit/oxlint'
import type { Plugin, Rule } from '@oxlint/plugins'
const compatible: Plugin = plugin
const name: RuleName = 'component-boundaries'
const rule: Rule = rules[name]
const issues: ArchitectureDiagnostic[] = checkArchitecture()
void issues
void compatible
void rule
`,
		)
		run(
			join(root, 'node_modules/.bin/tsc'),
			[
				'--noEmit',
				'--strict',
				'--skipLibCheck',
				'--target',
				'es2025',
				'--module',
				'esnext',
				'--moduleResolution',
				'bundler',
				'plugin-types.ts',
			],
			fixture,
		)
		console.log(
			`${installer}: packed Oxlint plugin loads, all consumer rules report, and declarations typecheck`,
		)
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}
