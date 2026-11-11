# Optional domain contracts

Declare schemas and command classification once in `contracts.ts`, then attach
the declaration to a Command or Query registry. Errors belong at the root beside
commands and queries. Either section and the error contract may be omitted.

For contracts that derive many schemas, use `defineDomainContract(() => ({ ... }))`
to defer construction of the object and its schemas.

The first property read, enumeration or other object operation builds the declaration
once. Schema identities and inferred literal operation keys are preserved. Object-form
declarations continue to work. The callback must be synchronous.

The regular registry uses `createFoundation` from `cvx-kit`; the Effect registry
uses `createEffectFoundation` from `cvx-kit/effect`. Both accept the same contract
and handler-first implementation helpers. Existing inline Effect definitions and the
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
		'tasks.create': command.handler((input) => input + 1),
		'tasks.close': command.handler((input) => input.id.length > 0, { audit: () => null }),
	}),
})
const queries = Query({
	contract,
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({ 'tasks.get': query.handler((input) => input) }),
})
const created = await commands.exec('tasks.create', '2', { actorId: 'actor' })
const count = await queries.withContext({ actorId: 'actor' }).exec('tasks.get', created.count)
void count
```

Each map must implement exactly its declared keys, including maps supplied through
variables. The object key selects the contract entry and infers the handler and
option callback types through `command.handler(fn, options?)` or
`query.handler(fn, options?)`. Keep the map directly in `operations` for contextual
inference. For separately assembled maps, the existing named helpers provide explicit
contract selection without relying on the enclosing object for inference. Input, result,
classification, replayResult, and wire come from the declaration and cannot be
overridden in the implementation. Construction snapshots operation records and
map membership without cloning validators or running user callbacks.

Options include guard, middleware, metadata, and permission; commands also allow
prepare, aggregates, and audit overrides. Options are optional when a root audit
is configured; commands without one require an audit in their options. Existing
`command['tasks.create']({ handler, ...options })` and named query helpers remain
supported. Named helpers retain their exact key binding.

The handler receives decoded input, returns the result schema's accepted input,
and execution returns its decoded result. Normal handlers and hooks return values
or Promises. Effect handlers and hooks may also return Effects; their error and
service channels remain part of the selected operation's type. For example, with
`Command` from `createEffectFoundation`:

```ts
import { Effect } from 'effect'
import { createEffectFoundation } from 'cvx-kit/effect'

const effectFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: (_host: { actorId: string }) => undefined,
})
const effectCommands = effectFoundation.Command({
	contract,
	context: (host: { actorId: string }) => host,
	audit: () => null,
	operations: ({ command }) => ({
		'tasks.create': command.handler((input) => Effect.succeed(input + 1)),
		'tasks.close': command.handler((input) => Effect.succeed(input.id.length > 0)),
	}),
})
```

The same contract owns both implementations; selecting a different adapter does
not require repeating schemas.

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

## Per-request cost: lazy operations

Convex evaluates the whole import graph on every request, and module state never survives to the next one. A thunk defers the declaration, but the first read of any operation still builds all of them. A registry's first `exec` also binds every operation. Declare operations, or their `input`/`result`, as getters so a module builds only what it reads or executes:

```ts
export const financeContract = defineDomainContract(() => ({
	queries: {
		get listPayments() {
			return {
				input: relations.tables.payments.paginationOpts({ type: true }),
				result: relations.tables.payments.pageDto({ client: true }),
			}
		},
		get getPayment() {
			return { input: paymentId, result: payments.dto(true) }
		},
	},
}))
```

`defineDomainContract` memoizes each getter, so schema identity is stable and every operation is built at most once. A registry binds a getter-declared operation on its first execution. That binding runs the same helper-ownership, protected-field and audit checks, and a failure is rethrown on every later execution. Key-set mismatches still fail when the registry is first used. Data-declared operations bind exactly as before. Pair this with `get args()` / `get returns()` on the registered functions (README, "Per-request import cost"). Otherwise `args: contract.queries.x.input` reads the operation at import anyway.
