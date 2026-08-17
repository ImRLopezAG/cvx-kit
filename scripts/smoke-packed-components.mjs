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
	return run(process.execPath, [
		join(fixture, 'node_modules', 'convex', 'bin', 'main.js'),
		...args,
	])
}

function write(relativePath, contents) {
	const path = join(fixture, relativePath)
	writeFileSync(path, contents)
}

function step(label, callback) {
	console.log(`smoke step: ${label}`)
	return callback()
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
		`import { approvalCallbackArgs } from 'cvx-kit/components/approvals'
import { createFunctionHandle, paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'

export const applyDecision = internalMutation({
  args: approvalCallbackArgs,
  returns: v.null(),
  handler: (_ctx, input) => {
    if (input.decision?.evidence[0]?.stepKey !== 'releaseDecision') {
      throw new Error('Missing callback decision step key')
    }
    return null
  },
})

export const rejectDecision = internalMutation({
  args: approvalCallbackArgs,
  returns: v.null(),
  handler: () => null,
})

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
  args: { resourceRef: v.optional(v.string()) },
  returns: v.object({ runId: v.string() }),
  handler: async (ctx, args) => {
    const approvedHandle = await createFunctionHandle(internal.smoke.applyDecision)
    const rejectedHandle = await createFunctionHandle(internal.smoke.rejectDecision)
    return ctx.runMutation(components.approvals.requests.start, {
      scopeRef: 'smoke',
      resourceType: 'release',
      resourceRef: args.resourceRef ?? 'packed-component',
      requester: { actorRef: 'requester', capabilities: [] },
      workflow: {
        schemaVersion: 1,
        compatibilityKey: 'packedSmoke',
        name: 'packedSmoke',
        steps: [
          {
            kind: 'decision',
            key: 'releaseDecision',
            decisions: ['approved', 'rejected'],
            quorum: { kind: 'count', approvals: 1 },
            makerChecker: true,
          },
          {
            kind: 'branch',
            key: 'routeDecision',
            approvedStepKey: 'applyDecision',
            rejectedStepKey: 'rejectDecision',
          },
          {
            kind: 'mutation',
            key: 'applyDecision',
            callback: { kind: 'mutation', handle: approvedHandle, retry: false },
          },
          {
            kind: 'mutation',
            key: 'rejectDecision',
            callback: { kind: 'mutation', handle: rejectedHandle, retry: false },
          },
        ],
      },
    })
  },
})

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    state: v.optional(v.union(v.literal('pending'), v.literal('approved'))),
  },
  returns: v.any(),
  handler: (ctx, args) => ctx.runQuery(components.approvals.requests.list, {
    scopeRef: 'smoke',
    ...args,
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

export const status = query({
  args: { runId: v.string() },
  returns: v.any(),
  handler: (ctx, args) => ctx.runQuery(components.approvals.requests.status, {
    ...args,
    compatibilityKey: 'packedSmoke',
  }),
})
`,
	)

	if (installer === 'bun') step('install with bun', () => run('bun', ['install']))
	else
		step('install with npm', () => run('npm', ['install', '--ignore-scripts']))
	if (installer === 'bun')
		step('test helper with bun', () =>
			run('bunx', ['vp', 'test', 'run', 'packed-test-helper.test.ts']),
		)
	else
		step('test helper with npm', () =>
			run('npx', ['vp', 'test', 'run', 'packed-test-helper.test.ts']),
		)

	step('deploy Convex fixture', () => runConvex('dev', '--once'))
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
	const { runId: secondRunId } = JSON.parse(
		runConvex(
			'run',
			'smoke:start',
			JSON.stringify({ resourceRef: 'packed-component-2' }),
		),
	)
	const firstPage = JSON.parse(
		runConvex(
			'run',
			'smoke:list',
			JSON.stringify({
				state: 'pending',
				paginationOpts: { cursor: null, numItems: 1 },
			}),
		),
	)
	if (firstPage.page.length !== 1 || firstPage.page[0]._id !== secondRunId) {
		throw new Error(`Unexpected first approval page: ${JSON.stringify(firstPage)}`)
	}
	const secondPage = JSON.parse(
		runConvex(
			'run',
			'smoke:list',
			JSON.stringify({
				state: 'pending',
				paginationOpts: {
					cursor: firstPage.continueCursor,
					numItems: 10,
				},
			}),
		),
	)
	if (
		secondPage.page.length !== 1 ||
		secondPage.page[0]._id !== runId ||
		secondPage.page[0]._id === firstPage.page[0]._id
	) {
		throw new Error(
			`Unexpected continuation approval page: ${JSON.stringify(secondPage)}`,
		)
	}

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
	let status
	for (let attempt = 0; attempt < 20; attempt += 1) {
		status = JSON.parse(
			runConvex('run', 'smoke:status', JSON.stringify({ runId })),
		)
		if (status.execution?.type === 'completed') break
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	if (status?.execution?.type !== 'completed') {
		throw new Error(`Approval callback did not complete: ${JSON.stringify(status)}`)
	}
	console.log(`packed component smoke passed with ${installer}`)
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true })
}
