# Optional domain contracts

Declare schemas and command classification once in `contracts.ts`, then attach
the declaration to a Command or Query registry. Errors belong at the root beside
commands and queries. Either section and the error contract may be omitted.

The regular registry uses `createFoundation` from `cvx-kit`; the Effect registry
uses `createEffectFoundation` from `cvx-kit/effect`. Both accept the same contract
and named implementation helpers. Existing inline Effect definitions and the
older `new Foundation(...)` constructors continue to work.

```ts
import { z } from 'zod'
import { createFoundation } from 'cvx-kit'
import { defineDomainContract } from 'cvx-kit/contracts'
import { defineErrorContract } from 'cvx-kit/errors'

const contract = defineDomainContract({
	errors: defineErrorContract({ Missing: { message: 'Task missing', details: {} } }),
	commands: {
		'tasks.create': {
			input: z.string().transform(Number),
			result: z.number().transform((count) => ({ count })),
			classification: 'business',
		},
		'tasks.close': {
			input: z.object({ id: z.string() }),
			result: z.boolean(),
			classification: 'business',
		},
	},
	queries: { 'tasks.get': { input: z.number(), result: z.number() } },
})
const { Command, Query } = createFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: (_host: { actorId: string }, entry) => {
		console.log(entry.operation)
	},
})
const commands = Command({
	contract,
	context: (host: { actorId: string }) => host,
	audit: ({ operation, input, result }, context) => {
		if (operation !== 'tasks.create') return null
		return {
			operation,
			actorId: context.actorId,
			aggregate: { type: 'task', id: String(input) },
			metadata: { count: result.count },
		}
	},
	operations: ({ command }) => ({
		'tasks.create': command['tasks.create']({ handler: (input) => input + 1 }),
		'tasks.close': command['tasks.close']({
			handler: (input) => input.id.length > 0,
			audit: () => null,
		}),
	}),
})
const queries = Query({
	contract,
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({ 'tasks.get': query['tasks.get']({ handler: (input) => input }) }),
})
const created = await commands.exec('tasks.create', '2', { actorId: 'actor' })
const count = await queries.withContext({ actorId: 'actor' }).exec('tasks.get', created.count)
void count
```

Each map must implement exactly its declared keys, including maps supplied through
variables. A helper for one key cannot implement another key. Input, result,
classification, replayResult, and wire come from the declaration and cannot be
overridden in the implementation. Construction snapshots operation records and
map membership without cloning validators or running user callbacks.

The handler receives decoded input, returns the result schema's accepted input,
and execution returns its decoded result. Normal handlers and hooks return values
or Promises. Effect handlers and hooks may also return Effects; their error and
service channels remain part of the selected operation's type.

For independent wire projections, use the existing `operationContract` helper
inside a domain declaration. It infers the projector's parameter from the result
schema; provide both its replayResult and wire fields. A command may instead
supply only replayResult directly in its domain entry. A query cannot prepare,
audit, declare aggregates, or declare replayResult.

A root audit receives `{ operation, input, result }` and resolved base context.
Its operation discriminates the corresponding input and result types. An
operation's audit override receives the existing `{ command, result }` envelope
and replaces the root audit. Exactly one callback runs after fresh-result
validation. Returning null skips the write. Replay skips handlers, audits,
writes, and completion; permission still runs before replay. Each command needs
a definite audit source. A definite override excludes the root audit's Effect
channels; an optional override retains channels from both possible callbacks.

Inline registries can also use root audit, leaving schemas and classification
on their operation definitions. The legacy constructor API keeps its existing
context-first execution signatures; the new regular registry uses input-first
handlers and `exec(operation, input, host)` like Effect.

Pass `contract.errors` explicitly to the existing `createEffectApi({ errors })`
option. Attaching a contract does not change a globally configured API. The
original error-contract instance still owns projection: foreign and forged errors
become UnknownFailure. Wire exposure remains explicit through `.expose(owner, key)`.

Enable `cvx/reserved-domain-file-anatomy` together with
`cvx/domain-file-responsibilities` to enforce reserved filenames. A domain's
commands.ts and queries.ts each export one genuine bound registry. Contracts are
declarative; schema.ts may declare several zodTable shapes; table.ts owns their
topology, and domain/table.ts uses createModule to assemble module maps. The rules
recognize aliases, namespaces, and the root foundation.ts facade. They do not
require absent reserved files to be created.
