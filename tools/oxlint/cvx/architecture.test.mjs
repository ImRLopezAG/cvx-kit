// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { checkArchitecture } from '../../../src/oxlint'

const fixtures = []
const testCode =
	"import { test, expect } from 'vitest'; test('behavior', () => { expect(1).toBe(1) })"
function fixture(files) {
	const cwd = mkdtempSync(join(tmpdir(), 'cvx-architecture-'))
	fixtures.push(cwd)
	for (const [file, code] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true })
		writeFileSync(join(cwd, file), code)
	}
	return cwd
}
function check(files, convexDir = 'convex') {
	return checkArchitecture({ cwd: fixture(files), convexDir })
}
afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('package-owned architecture checks', () => {
	it('accepts tested modules and nested integrations without requiring unused scaffold files', () => {
		expect(
			check({
				'convex/domain/projects/commands.ts': 'export function save() { return 1 }',
				'convex/domain/projects/__tests__/commands.test.ts': testCode,
				'convex/domain/projects/integrations/github/client.ts':
					'export function load() { return 1 }',
				'convex/domain/projects/integrations/github/__tests__/client.test.ts': testCode,
			}),
		).toEqual([])
	})
	it('requires separate tests in nested executable folders', () => {
		expect(
			check({
				'convex/domain/projects/__tests__/commands.test.ts': testCode,
				'convex/domain/projects/internal/callbacks.ts': 'export function run() {}',
			}),
		).toContainEqual(expect.objectContaining({ code: 'tests', file: 'domain/projects/internal' }))
	})
	it.each([
		'',
		'// test("fake", () => {})',
		'export const setup = 1',
		'test.todo("later")',
		'test.skip("later", () => { expect(1).toBe(1) })',
		'describe.skip("later", () => { test("x", () => { expect(1).toBe(1) }) })',
		'test("empty", () => {})',
		'test("x", { skip: true }, () => { expect(1).toBe(1) })',
	])('rejects a non-runnable test file: %s', (code) => {
		expect(
			check({
				'convex/api/projects.ts': 'export const run = () => 1',
				'convex/api/__tests__/projects.test.ts': code,
			}),
		).toContainEqual(expect.objectContaining({ code: 'tests' }))
	})
	it.each([
		testCode,
		'import { it as scenario } from "vitest"; scenario("x", () => expect(1).toBe(1))',
		'import * as t from "bun:test"; t.test("x", () => { t.expect(1).toBe(1) })',
		'test.each([1])("x", n => expect(n).toBe(1))',
	])('recognizes test runners and aliases: %s', (code) => {
		expect(
			check({
				'convex/api/projects.ts': 'export const run = () => 1',
				'convex/api/__tests__/projects.test.ts': code,
			}),
		).toEqual([])
	})
	it('does not require tests for type-only files, grouping folders, generated code, or fixtures inside tests', () => {
		expect(
			check({
				'convex/domain/projects/types.ts': 'export interface Project { id: string }',
				'convex/domain/projects/ambient.ts':
					'export declare const version: string; declare const context: unknown',
				'convex/_generated/api.ts': 'export const api = 1',
				'convex/domain/projects/__tests__/fixtures/data.ts': 'export const fixture = 1',
			}),
		).toEqual([])
	})
	it('reports misplaced test files', () => {
		expect(check({ 'convex/domain/projects/commands.test.ts': testCode })).toContainEqual(
			expect.objectContaining({ code: 'test-location' }),
		)
	})
	it('requires root wiring tests', () => {
		expect(check({ 'convex/convex.config.ts': 'export default {}' })).toContainEqual(
			expect.objectContaining({ code: 'tests', file: '.' }),
		)
	})
	it.each(['host', 'internal', 'lib', 'services', 'utils', 'migrattions'])(
		'rejects root directory %s',
		(dir) => {
			expect(check({ [`convex/${dir}/README.md`]: 'placeholder' })).toContainEqual(
				expect.objectContaining({ code: 'root-directory', file: dir }),
			)
		},
	)
	it('reports a missing configured Convex directory', () => {
		expect(check({})).toContainEqual(expect.objectContaining({ code: 'missing-root' }))
	})
	it('supports custom roots', () => {
		expect(
			check(
				{
					'src/server/convex/domain/projects/run.ts': 'export const run = () => 1',
					'src/server/convex/domain/projects/__tests__/run.test.ts': testCode,
				},
				'src/server/convex',
			),
		).toEqual([])
	})
	it('detects cross-module cycles through aliases and nested files', () => {
		const result = check({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { baseUrl: '.', paths: { '@cvx/*': ['convex/*'] } },
			}),
			'convex/domain/a/queries.ts': 'import { b } from "@cvx/domain/b/queries"; export const a = b',
			'convex/domain/b/queries.ts': 'import { a } from "../a/queries.js"; export const b = a',
			'convex/domain/a/__tests__/queries.test.ts': testCode,
			'convex/domain/b/__tests__/queries.test.ts': testCode,
		})
		expect(result.filter((x) => x.code === 'cycle')).toHaveLength(1)
	})
	it('does not turn type-only dependencies into runtime cycles', () => {
		expect(
			check({
				'convex/domain/a/types.ts': 'import type { B } from "../b/types"; export type A = B',
				'convex/domain/b/types.ts': 'import type { A } from "../a/types"; export type B = A',
			}),
		).toEqual([])
	})
	it('reports invalid test syntax instead of silently accepting it', () => {
		expect(
			check({
				'convex/api/projects.ts': 'export const x = 1',
				'convex/api/__tests__/projects.test.ts': 'test("x", () =>',
			}),
		).toContainEqual(expect.objectContaining({ code: 'parse' }))
	})
	it('refreshes results when tests are added or removed in the same process', () => {
		const cwd = fixture({ 'convex/api/projects.ts': 'export const x = 1' })
		expect(checkArchitecture({ cwd }).some((x) => x.code === 'tests')).toBe(true)
		mkdirSync(join(cwd, 'convex/api/__tests__'))
		const file = join(cwd, 'convex/api/__tests__/projects.test.ts')
		writeFileSync(file, testCode)
		expect(checkArchitecture({ cwd })).toEqual([])
		rmSync(file)
		expect(checkArchitecture({ cwd }).some((x) => x.code === 'tests')).toBe(true)
	})
})

it('rejects behavior files directly under domain/', () => {
	expect(check({ 'convex/domain/helpers.ts': 'export function run() {}' })).toContainEqual(
		expect.objectContaining({ code: 'domain-entry' }),
	)
})

it('does not require files that a module does not use', () => {
	expect(
		check({
			'convex/domain/identity/rules.ts': 'export function valid(id) { return id.length > 0 }',
			'convex/domain/identity/__tests__/rules.test.ts': testCode,
		}),
	).toEqual([])
})

it('flags shared code that has only one domain owner, including transitive shared helpers', () => {
	const issues = check({
		'convex/domain/orders/commands.ts':
			'import { run } from "../shared/client"; export const save = run',
		'convex/domain/orders/__tests__/commands.test.ts': testCode,
		'convex/domain/shared/client.ts':
			'import { helper } from "./helper"; export const run = helper',
		'convex/domain/shared/helper.ts': 'export const helper = () => 1',
		'convex/domain/shared/__tests__/client.test.ts': testCode,
	})
	expect(issues.filter((x) => x.code === 'shared-owner').map((x) => x.file)).toEqual([
		'domain/shared/client.ts',
		'domain/shared/helper.ts',
	])
})

it('allows shared infrastructure reached by multiple modules', () => {
	expect(
		check({
			'convex/domain/orders/commands.ts':
				'import { run } from "../shared/client"; export const save = run',
			'convex/domain/orders/__tests__/commands.test.ts': testCode,
			'convex/domain/users/commands.ts':
				'import { run } from "../shared/client"; export const save = run',
			'convex/domain/users/__tests__/commands.test.ts': testCode,
			'convex/domain/shared/client.ts': 'export const run = () => 1',
			'convex/domain/shared/__tests__/client.test.ts': testCode,
		}),
	).toEqual([])
})

it.each([
	'import { test } from "node:test"; test("later", {skip: "not ready"}, () => { throw new Error() })',
	'function test(name, fn) {} ; test("fake", () => { throw new Error() })',
	'const test = (name, fn) => {}; test("fake", () => { throw new Error() })',
	'test("later", { ["skip"]: true }, () => { throw new Error() })',
])('does not count skipped or locally shadowed tests: %s', (code) => {
	expect(
		check({
			'convex/api/orders.ts': 'export const x = 1',
			'convex/api/__tests__/orders.test.ts': code,
		}),
	).toContainEqual(expect.objectContaining({ code: 'tests' }))
})
