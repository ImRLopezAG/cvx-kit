import { execFileSync } from 'node:child_process'
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-ids-'))
const manifest = JSON.parse(
	readFileSync(join(root, 'package.json'), 'utf8'),
)
function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'pipe',
	})
}
try {
	run(
		'bun',
		['pm', 'pack', '--destination', temporary, '--ignore-scripts'],
		root,
	)
	for (const installer of ['npm', 'bun']) {
		const fixture = join(temporary, installer)
		mkdirSync(fixture)
		writeFileSync(
			join(fixture, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${join(temporary, `cvx-kit-${manifest.version}.tgz`)}`,
					'convex-helpers': '0.1.123',
					convex: manifest.devDependencies.convex,
					zod: manifest.devDependencies.zod,
				},
				devDependencies: {
					'convex-test': manifest.devDependencies['convex-test'],
					'vite-plus': manifest.devDependencies['vite-plus'],
					'@edge-runtime/vm': manifest.devDependencies['@edge-runtime/vm'],
				},
			}),
		)
		run(installer, ['install', '--ignore-scripts'], fixture)
		writeFileSync(
			join(fixture, 'probe.mjs'),
			`
import { strict as assert } from 'node:assert'
import { tenantTable, zodToConvex as kitConverter, zid as kitId } from 'cvx-kit/zod-table'
import { zid, zodToConvex } from 'convex-helpers/server/zod4'
import { z } from 'zod'
const table = tenantTable('children', id => ({
 parentId: id('parents'), nested: z.object({ parentId: id('parents') }),
}), { commandFields: ['parentId', 'nested'], publicFields: ['parentId', 'nested'] })
for (const validator of [
 zodToConvex(zid('parents')), table.table.validator.fields.parentId,
 zodToConvex(table.storage).fields.parentId,
 zodToConvex(table.commandInput).fields.parentId,
 zodToConvex(table.publicDto).fields.parentId,
 zodToConvex(table.storage).fields.nested.fields.parentId,
 kitConverter(kitId('parents')),
 kitConverter(table.commandInput).fields.nested.fields.parentId,
 kitConverter(table.publicDto).fields.nested.fields.parentId,
]) {
 assert.equal(validator.kind, 'id', 'exported schema lost ID validation')
 assert.equal(validator.tableName, 'parents')
}
`,
		)
		run('node', ['probe.mjs'], fixture)
		for (const testFile of [
			'command.test.ts',
			'command-lifecycle.test.ts',
		]) {
			const source = readFileSync(join(root, 'test', testFile), 'utf8')
				.replace(
					'../src/components/foundation/client',
					'cvx-kit/components/foundation',
				)
				.replace(
					"const modules = import.meta.glob('./fixture/**/*.ts')",
					"const modules = { './_generated/server.ts': async () => ({}) }",
				)
			writeFileSync(join(fixture, testFile), source)
		}
		writeFileSync(
			join(fixture, 'command-types.ts'),
			readFileSync(join(root, 'test/command-types.ts'), 'utf8').replace(
				'../src/components/foundation/client',
				'cvx-kit/components/foundation',
			),
		)
		writeFileSync(
			join(fixture, 'registration.test.ts'),
			`
import { convexTest } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { registerFoundation, registerApprovals } from 'cvx-kit/test'
import { it } from 'vite-plus/test'
it('registers concrete and generic backends from the packed package', () => {
 const modules = { './_generated/server.ts': async () => ({}) }
 const concrete = convexTest(defineSchema({ items: defineTable({ name: v.string() }) }), modules)
 const generic = convexTest(undefined, modules)
 for (const backend of [concrete, generic]) {
  registerFoundation(backend)
  registerApprovals(backend)
  registerFoundation(backend, 'customFoundation')
  registerApprovals(backend, 'customApprovals')
 }
})
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
				'--types',
				'vite/client',
				'command-types.ts',
				'registration.test.ts',
			],
			fixture,
		)
		run(
			join(fixture, 'node_modules/.bin/vp'),
			[
				'test',
				'run',
				'registration.test.ts',
				'command.test.ts',
				'command-lifecycle.test.ts',
			],
			fixture,
		)
		console.log(
			`${installer}: packed IDs, strict declarations, registration, and command lifecycle pass with host convex-helpers 0.1.123`,
		)
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
