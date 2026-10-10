# `cvx-kit/auth` — auth-aware function constructors from injected policy

`createAuthFunctions` builds the function constructors your whole backend uses
in place of raw `query`/`mutation`/`action`. Nothing in the kit imports your
app's singletons — identity resolution, role vocabulary, membership
verification, trigger wrapping, and error policy are all **injected** by the
host. The kit provides the structure; the app provides the policy.

## Setup — declared once per app

```ts
// convex/functions.ts (the single place constructors are built)
import { createAuthFunctions, defaultRoleMap } from 'cvx-kit/auth'
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import type { DataModel } from './_generated/dataModel'
import { triggers } from './triggers'
import { authKit } from './auth'

export const {
	authQuery,
	authMutation,
	authAction,
	roleQuery,
	roleMutation,
	roleAction,
	adminQuery,
	adminMutation,
	adminAction,
	systemQuery,
	systemMutation,
	systemAction,
	include,
	authenticatedUser,
} = createAuthFunctions<DataModel>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
	getAuthUser: (ctx) => authKit.getAuthUser(ctx),
	mapRole: defaultRoleMap, // or your own vocabulary (see below)
	adminRoles: ['admin'],
	triggers, // every mutation write runs through wrapDB
	verifyMembership: async ({ userId, organizationId }) => {
		const memberships = await authKit.workos.userManagement.listOrganizationMemberships({
			organizationId,
			userId,
			statuses: ['active'],
		})
		const m = memberships.data.find((c) => c.userId === userId)
		return m ? { organizationId: m.organizationId, roleSlug: m.role.slug } : null
	},
})
```

Every function in the app is then built from these — raw `query`/`mutation`
imports from `_generated/server` appear **only** in this file.

## One shared Effect function foundation

Use `createEffectAuthFunctions` from `cvx-kit/effect` in `convex/functions.ts`
to configure all twelve constructors once. Its first argument is the same
`AuthFunctionsConfig` used by `createAuthFunctions`; its second argument has
six explicit policies: `query`, `mutation`, `action`, `systemQuery`,
`systemMutation`, and `systemAction`. Each accepts `services`, `context`, and
`mapError`, like `effectZodApiBuilder`. Pass `{}` when no additions are needed.

Type the auth config with your generated `DataModel` and role vocabulary,
then let the factory infer its generics from both arguments. Do not supply
partial generic arguments, which would fix the remaining inference defaults.
The following public-package example defines a reusable app factory; the
host passes its auth, membership, trigger, and RLS policy as `config`.

<!-- packed-effect-example -->

```ts
import {
	defineSchema,
	defineTable,
	makeFunctionReference,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
	type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { Effect } from 'effect'
import { z } from 'zod'
import type { AuthFunctionsConfig, AuthBundle } from 'cvx-kit/auth'
import { createEffectAuthFunctions, createEffectFoundation } from 'cvx-kit/effect'

const schema = defineSchema({ notes: defineTable({ tenant: v.string(), title: v.string() }) })
type Model = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'
const input = z.object({ title: z.string().trim().min(1) })
const saveRef = makeFunctionReference<'mutation', z.input<typeof input>, null>('notes:save')

export function createApplicationFunctions(config: AuthFunctionsConfig<Model, Role>) {
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		writeAudit: () => undefined, // supply the app's transactional audit writer in production
	})
	const queries = foundation.Query({
		context: (ctx: (GenericQueryCtx<Model> | GenericMutationCtx<Model>) & AuthBundle<Role>) => ctx,
		operations: ({ query }) => ({
			actor: query({
				input: z.object({}),
				result: z.string(),
				handler: (_input, ctx) => ctx.actor.userId,
			}),
		}),
	})
	const commands = foundation.Command({
		context: (ctx: GenericMutationCtx<Model> & AuthBundle<Role>) => ctx,
		operations: ({ command }) => ({
			save: command({
				input,
				result: z.null(),
				classification: 'business',
				audit: () => null,
				handler: (args, ctx) =>
					Effect.promise(async () => {
						await ctx.db.insert('notes', { title: args.title, tenant: ctx.tenant })
						return null
					}),
			}),
		}),
	})
	const functions = createEffectAuthFunctions(config, {
		query: { context: (ctx) => ({ queries: queries.withContext(ctx) }) },
		mutation: {
			context: (ctx) => ({
				queries: queries.withContext(ctx),
				commands: commands.withContext(ctx),
			}),
		},
		action: {
			context: (ctx) => ({
				commands: {
					save: (args: z.input<typeof input>) =>
						Effect.promise(() => ctx.runMutation(saveRef, args)),
				},
			}),
		},
		systemQuery: {},
		systemMutation: {},
		systemAction: {},
	})
	const save = functions.roleMutation('owner')({
		args: input.shape,
		returns: z.null(),
		handler: (ctx, args) => ctx.commands.exec('save', args),
	})
	return { ...functions, save }
}
```

Export the returned constructors once from `convex/functions.ts`, and export
`save` at the registered `notes:save` mutation path. Endpoint modules can then
use `ctx.commands` or `ctx.queries` directly. The callbacks run per invocation
after auth, role checks, triggers/RLS wrapping, and live action membership
refresh. Binding is lazy; do not cache an authenticated `withContext` handle
at module scope. Denied requests never run the callbacks.

| Policy                                            | Available authority and capabilities                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                                           | Trusted auth bundle, secured DB reader, `include`; bind read registries only.                                                                                          |
| `mutation`                                        | Trusted auth bundle, secured triggered DB writer, `include`; bind queries and mutation commands.                                                                       |
| `action`                                          | Live-verified auth bundle, `runQuery`/`runMutation`; use action-compatible registries or forward to registered functions. No DB or `include`.                          |
| `systemQuery` / `systemMutation` / `systemAction` | Existing internal authority, configured separately. No fabricated actor or inherited public handles; system mutations retain triggers and bypass public RLS as before. |

Every auth/role/admin constructor of a kind shares that kind's policy. System
policies are deliberately explicit; choose their trusted capabilities rather
than synthesizing public credentials. An action forwarding to `runMutation`
creates a separate registered mutation transaction; it does not turn the
whole action into a transaction or carry its live role into that mutation's
JWT-based auth policy.

Additions cannot replace native or auth context keys: static checks reject
known collisions and runtime checks also reject inherited keys before the
handler executes. Put class-based handles under named properties in the
returned plain record. Scoped services, required Effect services, Zod raw and
parsed argument/result types, function references, and error projection retain
the existing adapter's behavior. Let failures escape registered mutations so
nested command writes, triggers, and audit writes roll back together.

## Shared Effect execution after authentication

For an individual constructor, wrap the builder returned by `createAuthFunctions` with
`effectZodApiBuilder` from `cvx-kit/effect`. The original constructor resolves
authentication, authorization, tenant policy, and the wrapped database before
the service provider runs. Keep that ordering when adding Effect; use the Zod
adapter for these custom constructors.

This factory accepts the configured `authMutation` from the setup above. The
actor service comes from trusted `ctx.actor`, with no actor or organization
argument from callers:

<!-- packed-effect-example -->

```ts
import type { GenericDataModel } from 'convex/server'
import { createAuthFunctions } from 'cvx-kit/auth'
import { effectZodApiBuilder } from 'cvx-kit/effect'
import { Context, Effect } from 'effect'
import { z } from 'zod'

class Actor extends Context.Service<
	Actor,
	{ userId: string; organizationId: string; role: string }
>()('app/Actor') {}

export function createEffectAccountApi<DataModel extends GenericDataModel>(
	baseAuthMutation: ReturnType<typeof createAuthFunctions<DataModel>>['authMutation'],
) {
	const authMutation = effectZodApiBuilder(baseAuthMutation, {
		services: (ctx) => Context.make(Actor, ctx.actor),
	})
	const currentActor = authMutation({
		args: {},
		returns: z.object({ userId: z.string(), organizationId: z.string() }),
		handler: () =>
			Effect.gen(function* () {
				const actor = yield* Actor
				return { userId: actor.userId, organizationId: actor.organizationId }
			}),
	})
	return { authMutation, currentActor }
}
```

Call `createEffectAccountApi(authMutation)` with the constructor exported by
your `convex/functions.ts`, then export `currentActor` from the account API
module. The factory preserves the configured auth policy; it does not choose
an identity provider or membership authority.

Declare the provider once per constructor, then reuse the builder across
endpoints. Database services should capture the provider's `ctx.db`, so
trigger and RLS enforcement also applies to Effect-driven writes. Services
are created per invocation; do not cache an authenticated context in a module
singleton. Query providers receive readers; HTTP integrations belong in
actions.

The adapter runs the composed Effect within an invocation scope and awaits
finalizers before returning. Domain errors can be mapped with handler pipes
or shared `mapError`; they remain thrown failures at the native boundary so
mutation writes roll back. Native argument/result validators remain in place.
Effect's inferred server-side error and service channels are not a typed
transport error contract. See [the Effect guide](./effect.md) for complete
domain registries, error mapping, scoped services, and tracing.

## The constructor families

| Constructor                                                     | Visibility | Auth                         | Extra                            |
| --------------------------------------------------------------- | ---------- | ---------------------------- | -------------------------------- |
| `authQuery` / `authMutation` / `authAction`                     | public     | any authenticated org member | actions live-verify membership   |
| `roleQuery(...roles)` / `roleMutation(...)` / `roleAction(...)` | public     | listed roles only            | factory — call with your roles   |
| `adminQuery` / `adminMutation` / `adminAction`                  | public     | `config.adminRoles`          | pre-built `role*(...adminRoles)` |
| `systemQuery`                                                   | internal   | none (trusted caller)        | include-equipped, RLS-unwrapped  |
| `systemMutation`                                                | internal   | none (trusted caller)        | still trigger-wrapped            |
| `systemAction`                                                  | internal   | none                         | plain internal action            |

All are `zCustom*` constructors from convex-helpers, so `args` and `returns`
take zod schemas directly and compose with `zodTable` masks.

## What handlers receive on `ctx`

Authenticated constructors extend the ctx with a frozen auth bundle:

- `ctx.identity` — the raw `UserIdentity` (JWT claims)
- `ctx.user.id` — the synchronized principal id (from `getAuthUser`)
- `ctx.org` — `{ organizationId, role }`
- `ctx.role` — the mapped role
- `ctx.actor` — `{ userId, organizationId, role }` — pass this to audits,
  approvals, and commands as the canonical actor reference
- `ctx.include` — the bounded query builder (below)

`systemQuery` and `systemMutation` get `include` (plus trigger wrapping for the
mutation) but no auth bundle.

## Role vocabulary is per-app

`mapRole` maps the identity's role slug onto **your** role union; returning
`null` rejects with `FORBIDDEN`, so unknown roles never pass. The default
(`defaultRoleMap`) is WorkOS-flavored: `member → writer`, and
`reader`/`writer`/`admin` pass through.

Supply your own vocabulary via the generic:

```ts
createAuthFunctions<DataModel, 'viewer' | 'editor' | 'owner'>({
  mapRole: (slug) => (slug === 'owner' ? 'owner' : slug === 'editor' ? 'editor' : slug ? 'viewer' : null),
  adminRoles: ['owner'],
  ...
})
```

## Queries/mutations trust the JWT; actions re-verify

Queries and mutations read org and role from the identity token. Actions —
which can run long and call third parties — additionally call
`verifyMembership` **live** before the handler runs, and the fresher
role/organization from that check replaces the JWT's. Verification **fails
closed**: any error or org mismatch throws `FORBIDDEN`. Omit
`verifyMembership` to let actions trust the JWT like queries do.

## Resolving org/role from the database (`resolveOrganization`)

Some identity providers issue tokens that carry **no org claims** — custom
credentials, magic codes, or apps that keep memberships in their own tables.
For those, configure `resolveOrganization` to derive organization authority
from the app's own data instead of the JWT.

When configured, the hook is the organization authority — claim parsing is
skipped entirely. Returning `null` **or throwing** rejects with `FORBIDDEN`
(fail closed); a missing identity or user is still `UNAUTHENTICATED`; the
returned `roleSlug` still passes through `mapRole` like a claim would.

The handler must be **action-safe**: in actions the ctx has no `db`, so branch
on its presence and fall back to an internal query:

```ts
import { internal } from './_generated/api'

resolveOrganization: async ({ ctx, user }) => {
  const membership =
    'db' in ctx
      ? await ctx.db
          .query('companyUsers')
          .withIndex('by_user', (q) => q.eq('userId', user.id))
          .first()
      : await ctx.runQuery(internal.memberships.byUser, { userId: user.id })
  if (!membership || !membership.active) return null   // revoked ⇒ FORBIDDEN
  return { organizationId: membership.orgId, roleSlug: membership.roleSlug }
},
```

Resolver obligations:

- Bind the lookup to the **verified** user — `user.id` (or
  `identity.subject`), never a caller-influenced or non-unique attribute.
- Resolve revoked/inactive/expired memberships to `null`, so revocation
  actually takes effect fail-closed.

Composition: `mapRole` still applies to the returned slug; with tenancy
configured, `ctx.tenant` derives from the hook's org
(`security.tenancy.resolve` is unchanged); `verifyMembership` for actions is
unchanged and receives the hook-resolved `organizationId` — in actions its
live result supersedes the hook's role/org, exactly as it supersedes claims.

Cost: one DB read per authenticated call (claims are free); actions with
`verifyMembership` configured also pay the live check. When debugging, note
that a misconfigured hook surfaces as blanket `FORBIDDEN` — errors are
swallowed fail-closed, never rethrown.

## Mutations are structurally trigger-wrapped

When `triggers` (or `wrapDB`) is configured, every `authMutation`,
`roleMutation`, and `systemMutation` runs its writes through
`triggers.wrapDB(ctx)`. Trigger enforcement (timestamps, append-only,
no-delete, denormalization) is therefore **structural** — a handler cannot
forget it, because it never sees an unwrapped `ctx.db`. This is the reason raw
`mutation` must not be used outside `functions.ts`.

## `include()` — every read is bounded

`include` wraps a table query in a fluent selector that (a) picks the first
matching indexed query and (b) refuses unbounded reads. `execute(limit)`
rejects limits outside `1..maxRows` (default 100, configurable via
`maxIncludedQueryRows`).

```ts
export const list = authQuery({
	args: { ownerId: zid('users').optional(), limit: z.number() },
	returns: z.array(documents.publicDto),
	handler: (ctx, args) =>
		ctx
			.include(ctx.db.query('documents'))
			.when(args.ownerId, (q, ownerId) =>
				q.withIndex('by_owner', (ix) => ix.eq('ownerId', ownerId)),
			)
			.otherwise((q) => q.withIndex('by_owner'))
			.execute(args.limit, (rows) => rows.map(documents.toPublicDto)),
})
```

Selector methods:

- `.when(value, select)` — if `value` is non-null and nothing selected yet,
  use `select(query, value)`.
- `.matching(indexName, range?, shouldMatch?)` — index selection with an
  optional guard boolean.
- `.otherwise(select)` — fallback, returns the raw `Query`.
- `.resolve()` — selected query or full table scan (escape hatch).
- `.execute(limit, transform?)` — bounded `take` + optional projection. This
  is the normal terminal.

## Row-level security and tenancy (optional)

The `security` config adds structural RLS to every `auth*`/`role*`/`admin*`
constructor — role-level rules (`security.rules`, standalone), tenant
isolation from a table registry (`security.tenancy`, opt-in), or both
AND-composed. Queries get a wrapped reader; mutations wrap triggers first,
then the RLS writer; `system*` stays unwrapped. With tenancy configured, ctx
gains `ctx.tenant` (actions re-derive it from live verification). Full
treatment: `tenancy.md`.

## Errors

All rejections go through the injected `ErrorFactory` (default: throws
`KitError` with codes `UNAUTHENTICATED`, `FORBIDDEN`,
`INVALID_REQUEST_BOUNDARY`). Hosts with their own error taxonomy adapt it:

```ts
errors: { throw: (input) => { throw App.errors.from(input) } }
```

## Rules of thumb

1. Build constructors once in `convex/functions.ts`; import them everywhere
   else. Raw `_generated/server` builders appear nowhere else.
2. Public functions: `auth*`/`role*`/`admin*`. Scheduled/internal work:
   `system*`. Never expose an unauthenticated public function unless it is
   deliberately anonymous (and then document why).
3. Reads go through `ctx.include(...)` with an explicit limit.
4. Use `ctx.actor` as the actor reference in audits and approvals — never
   re-derive identity in a handler.

Optional request context can be added through the existing Effect API adapter's
`context` callback. Bind selected registries with `commands.withContext(value)`
and consume `ctx.commands.exec(name, input)` through the application's existing
function helper names. Keep dependencies local to each feature; explicit execution
and input-only command handlers remain supported. See [optional context injection](./command-context.md).
