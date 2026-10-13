import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

// Named cross-module/Convex-runtime fixtures, rather than the full unit suite.
// Keep this list deliberate; missing fixtures must fail CI rather than disappear.
const required = [
	'test/command-lifecycle.test.ts',
	'test/convex-auth.test.ts',
	'test/convex-auth-resolve-org.test.ts',
	'test/convex-components.test.ts',
	'test/convex-tenancy.test.ts',
	'test/crud.test.ts',
	'test/domain-boundaries.test.ts',
	'test/domain-integrations.test.ts',
	'test/effect-api.test.ts',
	'test/effect-api-secured.test.ts',
	'test/effect-api-zod.test.ts',
	'test/effect-auth.test.ts',
	'test/effect-auth-commands.test.ts',
	'test/effect-command.test.ts',
	'test/effect-crud.test.ts',
	'test/effect-registry-review.test.ts',
	'test/operation-contracts.test.ts',
	'test/query-middleware.test.ts',
	'test/relations.test.ts',
	'test/webhooks.test.ts',
	'test/zod-registration.test.ts',
	'test/zod-variant-table.test.ts',
	'test/convex-smoke-env.test.mjs',
	'scripts/owned-process.test.mjs',
	'test/querying.test.ts',
	'test/querying-config.test.ts',
	'test/querying-cursors.test.ts',
	'test/querying-relations.test.ts',
	'test/querying-security.test.ts',
	'test/querying-security-auth.test.ts',
]
const stress = 'test/querying-relations-stress.test.ts'

for (const file of required) {
	if (!existsSync(join(root, file))) throw new Error(`Missing CI integration fixture: ${file}`)
}

// Automatically include querying-variants.test.ts when it lands, plus future
// querying integration fixtures. The long oracle stress run stays local.
const querying = readdirSync(join(root, 'test'))
	.filter((file) => /^querying(?:-.+)?\.test\.ts$/.test(file))
	.map((file) => `test/${file}`)
const tests = [...new Set([...required, ...querying])].filter((file) => file !== stress).sort()

// Read-only inspection for CI maintenance, without starting tests or a build.
if (process.argv.slice(2).includes('--list')) {
	console.log(tests.join('\n'))
} else {
	console.log(`CI integration fixtures (${tests.length}):\n${tests.join('\n')}`)
	const result = spawnSync(
		join(root, 'node_modules/.bin/vp'),
		['test', 'run', ...tests, '--exclude', stress],
		{ cwd: root, stdio: 'inherit' },
	)
	if (result.error) throw result.error
	process.exitCode = result.status ?? 1
}
