// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import {
	assertIsolatedConvexFixture,
	assertLocalConvexState,
	localConvexEnvironment,
} from '../scripts/convex-smoke-env.mjs'

it('removes inherited deployment selections before anonymous local smoke execution', () => {
	const env = localConvexEnvironment({
		PATH: '/fixture/bin',
		CONVEX_DEPLOY_KEY: 'fixture-cloud-selection',
		CONVEX_DEPLOYMENT: 'prod:fixture',
		CONVEX_SELF_HOSTED_URL: 'https://fixture.invalid',
		CONVEX_SELF_HOSTED_ADMIN_KEY: 'fixture-admin-selection',
		CONVEX_PROVISION_HOST: 'https://fixture.invalid',
		CONVEX_AGENT_MODE: 'cloud',
		NEXT_PUBLIC_CONVEX_URL: 'https://fixture.invalid',
		VITE_CONVEX_URL: 'https://fixture.invalid',
	})
	expect(env).toEqual({ PATH: '/fixture/bin', CONVEX_AGENT_MODE: 'anonymous' })
})

it('requires deployment state inside the temporary fixture', () => {
	const fixture = mkdtempSync(join(tmpdir(), 'cvx-local-state-proof-'))
	try {
		expect(() => assertLocalConvexState(fixture)).toThrow('project-local deployment state')
		const state = join(fixture, '.convex', 'local', 'default')
		mkdirSync(state, { recursive: true })
		writeFileSync(join(state, 'config.json'), '{}')
		expect(() => assertLocalConvexState(fixture)).not.toThrow()
	} finally {
		rmSync(fixture, { recursive: true, force: true })
	}
})

it('rejects legacy deployment reuse unless project-local state already selects the fixture', () => {
	const temporary = mkdtempSync(join(tmpdir(), 'cvx-isolation-proof-'))
	const fixture = join(temporary, 'fixture')
	const legacyState = join(temporary, 'legacy', 'anonymous-agent')
	try {
		mkdirSync(fixture)
		expect(() => assertIsolatedConvexFixture(fixture, legacyState)).not.toThrow()
		mkdirSync(legacyState, { recursive: true })
		expect(() => assertIsolatedConvexFixture(fixture, legacyState)).toThrow(
			'legacy anonymous-agent',
		)
		const localState = join(fixture, '.convex', 'local', 'default')
		mkdirSync(localState, { recursive: true })
		writeFileSync(join(localState, 'config.json'), '{}')
		expect(() => assertIsolatedConvexFixture(fixture, legacyState)).not.toThrow()
	} finally {
		rmSync(temporary, { recursive: true, force: true })
	}
})
