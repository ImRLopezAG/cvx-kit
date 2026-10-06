import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A smoke fixture must never inherit a cloud or self-hosted deployment selection. */
export function localConvexEnvironment(source = process.env) {
	const env = Object.fromEntries(
		Object.entries(source).filter(
			([key]) =>
				!key.startsWith('CONVEX_') && key !== 'NEXT_PUBLIC_CONVEX_URL' && key !== 'VITE_CONVEX_URL',
		),
	)
	return { ...env, CONVEX_AGENT_MODE: 'anonymous' }
}

/** Convex 1.45 can fall back to a legacy home deployment with the same agent name. */
export function assertIsolatedConvexFixture(
	fixture,
	legacyState = join(homedir(), '.convex', 'anonymous-convex-backend-state', 'anonymous-agent'),
) {
	const localConfig = join(fixture, '.convex', 'local', 'default', 'config.json')
	if (!existsSync(localConfig) && existsSync(legacyState)) {
		throw new Error(
			'Local smoke cannot reuse legacy anonymous-agent state; an isolated fixture is required',
		)
	}
}

export function assertLocalConvexState(fixture) {
	if (!existsSync(join(fixture, '.convex', 'local', 'default', 'config.json'))) {
		throw new Error('Local smoke did not create project-local deployment state')
	}
}
