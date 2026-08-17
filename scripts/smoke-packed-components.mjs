import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const installer = process.argv[2] ?? 'bun'
if (installer !== 'bun' && installer !== 'npm') {
	throw new Error('Usage: smoke-packed-components.mjs [bun|npm]')
}

const root = join(import.meta.dirname, '..')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cvx-kit-smoke-'))
const fixture = join(temporaryRoot, 'fixture')
const packageVersion = JSON.parse(
	readFileSync(join(root, 'package.json'), 'utf8'),
).version
const tarball = join(temporaryRoot, `cvx-kit-${packageVersion}.tgz`)

function run(command, args, cwd = fixture) {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, CONVEX_AGENT_MODE: 'anonymous' },
	})
}

function runConvex(...args) {
	return installer === 'bun'
		? run('bunx', ['convex', ...args])
		: run('npx', ['convex', ...args])
}

function write(relativePath, contents) {
	const path = join(fixture, relativePath)
	writeFileSync(path, contents)
}

try {
	run(
		'bun',
		['pm', 'pack', '--destination', temporaryRoot, '--ignore-scripts'],
		root,
	)
	mkdirSync(join(fixture, 'convex'), { recursive: true })
	write(
		'package.json',
		JSON.stringify(
			{
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${tarball}`,
					convex: '1.43.0',
					zod: '4.4.3',
				},
				devDependencies: {
					'vite-plus': '0.2.8',
				},
			},
			null,
			2,
		),
	)
	write(
		'packed-test-helper.test.ts',
		`import { describe, expect, it } from 'vite-plus/test'
import { registerApprovals, registerFoundation } from 'cvx-kit/test'

describe('packed cvx-kit test helpers', () => {
  it('registers both compiled component bundles and their discoverable schemas', () => {
    const registrations = []
    const testRuntime = {
      registerComponent(name, schema, modules) {
        registrations.push({ name, schema, modules })
      },
    }

    registerApprovals(testRuntime)
    registerFoundation(testRuntime)

    expect(registrations.map(({ name }) => name)).toEqual(['approvals', 'foundation'])
    expect(Object.keys(registrations[0].schema.tables).sort()).toEqual([
      'approvalDecisions',
      'approvalRuns',
    ])
    expect(Object.keys(registrations[0].modules)).toContain(
      '../dist/components/approvals/health.mjs',
    )
  })
})
`,
	)
	write(
		'convex/convex.config.ts',
		`import { defineApp } from 'convex/server'
import approvals from 'cvx-kit/components/approvals/convex.config'
import foundation from 'cvx-kit/components/foundation/convex.config'

const app = defineApp()
app.use(approvals)
app.use(foundation)
export default app
`,
	)
	write(
		'convex/smoke.ts',
		`import { v } from 'convex/values'
import { components } from './_generated/api'
import { mutation, query } from './_generated/server'

export const health = query({
  args: {},
  returns: v.any(),
  handler: (ctx) => ctx.runQuery(components.approvals.health.check, {}),
})

export const foundationHealth = query({
  args: {},
  returns: v.literal('ready'),
  handler: (ctx) => ctx.runQuery(components.foundation.functions.status, {}),
})

export const start = mutation({
  args: {},
  returns: v.object({ runId: v.string() }),
  handler: (ctx) => ctx.runMutation(components.approvals.requests.start, {
    scopeRef: 'smoke',
    resourceType: 'release',
    resourceRef: 'packed-component',
    requester: { actorRef: 'requester', capabilities: [] },
    workflow: {
      schemaVersion: 1,
      compatibilityKey: 'packedSmoke',
      name: 'packedSmoke',
      steps: [{
        kind: 'decision',
        key: 'releaseDecision',
        decisions: ['approved', 'rejected'],
        quorum: { kind: 'count', approvals: 1 },
        makerChecker: true,
      }],
    },
  }),
})

export const decide = mutation({
  args: { runId: v.string() },
  returns: v.any(),
  handler: (ctx, args) => ctx.runMutation(components.approvals.decisions.decide, {
    runId: args.runId,
    decision: 'approved',
    actor: { actorRef: 'approver', capabilities: [] },
    compatibilityKey: 'packedSmoke',
  }),
})

export const history = query({
  args: { runId: v.string() },
  returns: v.any(),
  handler: (ctx, args) => ctx.runQuery(components.approvals.decisions.list, args),
})
`,
	)

	if (installer === 'bun') run('bun', ['install'])
	else run('npm', ['install', '--ignore-scripts'])
	if (installer === 'bun')
		run('bunx', ['vp', 'test', 'run', 'packed-test-helper.test.ts'])
	else run('npx', ['vp', 'test', 'run', 'packed-test-helper.test.ts'])

	runConvex('dev', '--once')
	const health = JSON.parse(runConvex('run', 'smoke:health'))
	if (health.status !== 'ready' || health.schemaVersion !== 1) {
		throw new Error(
			`Unexpected approvals health response: ${JSON.stringify(health)}`,
		)
	}
	const foundationHealth = JSON.parse(
		runConvex('run', 'smoke:foundationHealth'),
	)
	if (foundationHealth !== 'ready') {
		throw new Error(
			`Unexpected foundation health response: ${JSON.stringify(foundationHealth)}`,
		)
	}
	const { runId } = JSON.parse(runConvex('run', 'smoke:start'))

	let decision
	let lastError
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			decision = JSON.parse(
				runConvex('run', 'smoke:decide', JSON.stringify({ runId })),
			)
			break
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
	}
	if (!decision) throw lastError
	if (decision.state !== 'approved') {
		throw new Error(`Unexpected decision response: ${JSON.stringify(decision)}`)
	}
	const history = JSON.parse(
		runConvex('run', 'smoke:history', JSON.stringify({ runId })),
	)
	if (history.length !== 1 || history[0].decision !== 'approved') {
		throw new Error(`Unexpected approval history: ${JSON.stringify(history)}`)
	}
	console.log(`packed component smoke passed with ${installer}`)
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true })
}
