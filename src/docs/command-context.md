# Optional command context injection

Bind context once at a function boundary when it makes endpoint code clearer.
`withContext(value)` accepts whatever the registry's resolver accepts: a number,
a service bundle, a request context, or another bound command group. It returns
a small handle whose `exec(name, input)` still produces a lazy Effect. Binding
neither resolves context nor executes a command. Explicit
`commands.exec(name, input, context)` remains supported.

## Keep existing function names

Add context through `effectZodApiBuilder` around the existing custom constructor.
Export it under your application's ordinary `authMutation`, `adminQuery`,
`organizationMutation`, or other function name. These are application choices;
the library does not require a new helper family. The same option works on
`effectApiBuilder` for native builders. `services` is optional when your Effects
need no services.

The complete example below uses a custom authenticated mutation to make the
context flow standalone. A kit application can supply
`createAuthFunctions(...).authMutation` instead. Its authenticated, secured
context is constructed before the additions callback runs.

<!-- packed-effect-example -->

```ts
import { Effect } from 'effect'
import { mutationGeneric } from 'convex/server'
import { zCustomMutation } from 'convex-helpers/server/zod4'
import { createEffectFoundation, effectZodApiBuilder } from 'cvx-kit/effect'
import { z } from 'zod'

const foundation = createEffectFoundation({
  observability: {
    enabled: false,
    classifyError: () => ({ outcome: 'failed', errorCode: 'COMMAND_FAILED' }),
  },
  // Standalone demonstration only: production applications provide their audit writer.
  writeAudit: () => undefined,
})

const notifications = foundation.Command({
  context: (dependencies: { format: (message: string) => string }) => dependencies,
  operations: ({ command }) => ({
    format: command({
      input: z.string(), result: z.string(), classification: 'business',
      handler: (message, context) => context.format(message),
      audit: () => null,
    }),
  }),
})

const tasks = foundation.Command({
  context: (dependencies: {
    nextNumber: () => number,
    notifications: ReturnType<typeof notifications.withContext>,
  }) => dependencies,
  operations: ({ command }) => ({
    create: command({
      input: z.string(), result: z.string(), classification: 'business',
      handler: (title, context) => context.notifications.exec(
        'format', `${context.nextNumber()}:${title}`,
      ),
      audit: () => null,
    }),
  }),
})

const baseAuthMutation = zCustomMutation(mutationGeneric, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw Error('UNAUTHORIZED')
    return { ctx: { actor: identity.subject }, args: {} }
  },
})

// In a real app, keep this composition in the tasks feature's functions module.
export const authMutation = effectZodApiBuilder(baseAuthMutation, {
  context: (ctx) => {
    const messages = notifications.withContext({
      format: (message) => `${ctx.actor}:${message}`,
    })
    return {
      tasks: tasks.withContext({ nextNumber: () => 42, notifications: messages }),
    }
  },
})

export const createTask = authMutation({
  args: { title: z.string() },
  returns: z.string(),
  handler: (ctx, input) => ctx.tasks.exec('create', input.title),
})

// An input-only command needs no domain dependencies.
const echo = foundation.Command({
  context: () => undefined,
  operations: ({ command }) => ({
    echo: command({
      input: z.string(), result: z.string(), classification: 'business',
      handler: (input) => input, audit: () => null,
    }),
  }),
})
export const echoEffect = echo.exec('echo', 'hello', undefined)
export const boundEchoEffect = echo.withContext(undefined).exec('echo', 'hello')
// A program can compose further work; the API adapter owns execution.
export const composedEcho = Effect.map(boundEchoEffect, (value) => value.length)
```

Context additions are optional and cannot replace existing fields, including
`db`, `auth`, or a custom constructor's authenticated actor. Type checking rejects
known collisions; runtime checking protects against erased types. Additions can
return a plain record of own properties, or a Promise or Effect of that record.
Wrap class instances and services in named properties, such as `{ pricingService }`,
rather than returning an instance as the additions object. The adapter provides services first, then
runs initialization and the handler in the same invocation scope. Missing
initializer services are rejected when registering the endpoint, just like
missing handler services. Initialization failures use the configured error
projection and release acquired resources.

## Applications with 25–50 entities

Organize by feature or workflow rather than making every entity a property of a
single global context. A tasks helper can bind tasks and notifications; a billing
helper can bind billing and pricing. Each registry declares its own narrow
resolver input. Share stable service implementations at module scope, and build
request-dependent handles within the context callback.

Keep shared identity or tenant information small. Inject a business function or
service only into the features that use it. Pass bound commands only where a
workflow calls them; avoid mutual command dependencies. Bindings hold references
and do not initialize the referenced registry. Large dependency graphs are
application architecture choices, not a required library container.

If a feature needs no injected commands, omit `context` additions. If an endpoint
benefits from explicit execution, pass its context directly. An input-only
handler can ignore domain context, but permission and audit policies may still
need the original trusted invocation context. Preserve those policies when
choosing the registry resolver and binding input.

Nested calls return Effects and compose in the current program. Do not call
`Effect.runPromise` inside command handlers; the function adapter runs the
complete program once. Command schema checks, permissions, audit, and completion
remain active for each nested command. Keep database mutation work in a mutation
boundary so Convex can roll it back if execution or result validation fails.
