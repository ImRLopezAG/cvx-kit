import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { runOwnedProcess } from './owned-process.mjs'
import {
	localConvexEnvironment,
	assertIsolatedConvexFixture,
	assertLocalConvexState,
} from './convex-smoke-env.mjs'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const proof = mkdtempSync(join(tmpdir(), 'cvx-kit-variants-'))
console.log(`Variant packed proof: ${proof}`)
function run(command, args, cwd, label, env = process.env) {
	try {
		const output = execFileSync(command, args, {
			cwd,
			env,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 180000,
			maxBuffer: 8 * 1024 * 1024,
		})
		writeFileSync(join(proof, `${label}.log`), output)
		console.log(`${label}: passed`)
	} catch (error) {
		// Package-manager configuration may contain credentials; never retain install output.
		if (!label.endsWith('install'))
			writeFileSync(join(proof, `${label}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
		throw new Error(`${label} failed (exit ${error.status}); proof at ${proof}`)
	}
}
run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', proof], root, 'pack')
for (const [label, installer, helpers, zod] of [
	['installed', 'bun', manifest.devDependencies['convex-helpers'], manifest.devDependencies.zod],
	['minimum', 'npm', '0.1.127', '4.5.4'],
]) {
	const fixture = join(proof, label)
	mkdirSync(fixture)
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'cvx-kit': `file:${join(proof, `${manifest.name}-${manifest.version}.tgz`)}`,
				convex: manifest.devDependencies.convex,
				'convex-helpers': helpers,
				zod,
				'convex-test': manifest.devDependencies['convex-test'],
				'vite-plus': manifest.devDependencies['vite-plus'],
				'@edge-runtime/vm': manifest.devDependencies['@edge-runtime/vm'],
				'@types/node': manifest.devDependencies['@types/node'],
				typescript: manifest.devDependencies.typescript,
			},
		}),
	)
	for (const name of ['zod-variant-table.test.ts', 'zod-variant-table-types.ts']) {
		writeFileSync(
			join(fixture, name),
			readFileSync(join(root, 'test', name), 'utf8')
				.replaceAll('../src/zod-table', 'cvx-kit/zod-table')
				.replaceAll('../src/relations', 'cvx-kit/relations'),
		)
	}
	writeFileSync(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				target: 'ES2025',
				module: 'ESNext',
				moduleResolution: 'bundler',
				types: ['node'],
			},
			include: ['*.ts', 'convex/**/*.ts'],
		}),
	)
	writeFileSync(
		join(fixture, 'vite.config.ts'),
		"import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { environment: 'edge-runtime' } })\n",
	)
	run(installer, ['install', '--ignore-scripts'], fixture, `${label}-install`)
	mkdirSync(join(fixture, 'convex'))
	writeFileSync(
		join(fixture, 'convex/schema.ts'),
		`
import { defineSchema, defineTable } from 'convex/server'
import { z } from 'zod'
import { zodVariantTable, zid } from 'cvx-kit/zod-table'
export const payments = zodVariantTable('payments', z.discriminatedUnion('type', [
 z.strictObject({ type: z.literal('draft'), clientId: zid('clients'), amount: z.number() }),
 z.strictObject({ type: z.literal('creditor'), clientId: zid('clients'), creditorId: zid('creditors'), amount: z.number() }),
]), { discriminator: 'type', variants: {
 draft: { commandFields: ['clientId', 'amount'], publicFields: ['clientId'] },
 creditor: { commandFields: ['clientId', 'creditorId', 'amount'], publicFields: ['clientId', 'creditorId'] },
} })
export default defineSchema({ payments: payments.table, clients: defineTable({}), creditors: defineTable({}) })
`,
	)
	// Native codegen requires a configured application; create an isolated local backend.
	const codegenEnv = localConvexEnvironment()
	assertIsolatedConvexFixture(fixture)
	const freePort = async () => {
		const server = createServer()
		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		const port = server.address()?.port
		if (!port) throw new Error('Missing fixture port')
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
		return port
	}
	const native = await runOwnedProcess({
		command: process.execPath,
		args: [
			join(fixture, 'node_modules/convex/bin/main.js'),
			'dev',
			'--once',
			'--typecheck=disable',
			'--local-cloud-port',
			String(await freePort()),
			'--local-site-port',
			String(await freePort()),
		],
		cwd: fixture,
		env: codegenEnv,
	})
	writeFileSync(join(proof, `${label}-native.log`), native.stdout + native.stderr)
	if (native.code !== 0 || native.timedOut || native.cleanup?.alive)
		throw new Error(`${label} native configuration failed; proof at ${proof}`)
	assertLocalConvexState(fixture)
	run(
		'node',
		[join(fixture, 'node_modules/convex/bin/main.js'), 'codegen', '--typecheck', 'disable'],
		fixture,
		`${label}-codegen`,
		codegenEnv,
	)
	writeFileSync(
		join(fixture, 'convex/types.ts'),
		`
import type { Doc, Id } from './_generated/dataModel'
import { expectTypeOf } from 'vite-plus/test'
declare const row: Doc<'payments'>
expectTypeOf(row._id).toEqualTypeOf<Id<'payments'>>()
expectTypeOf(row.clientId).toEqualTypeOf<Id<'clients'>>()
if (row.type === 'creditor') expectTypeOf(row.creditorId).toEqualTypeOf<Id<'creditors'>>()
if (row.type === 'draft') {
 // @ts-expect-error generated documents retain branch-specific fields
 row.creditorId
}
`,
	)
	run(
		join(fixture, 'node_modules/.bin/tsc'),
		['--project', 'tsconfig.json'],
		fixture,
		`${label}-types`,
	)
	run(
		join(fixture, 'node_modules/.bin/vp'),
		['test', 'run', 'zod-variant-table.test.ts'],
		fixture,
		`${label}-runtime`,
	)
}
