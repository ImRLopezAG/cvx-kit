# `cvx-kit/components/approvals` — declarative approval workflows

A self-contained Convex component for human-in-the-loop approval flows:
declarative step lists (decision / branch / mutation / action / notify) with
count quorum, maker-checker, expiry, compatibility keys, durable execution via
a **nested** `@convex-dev/workflow`, and its own audit trail via a **nested**
`convex-audit-log`. The component never imports host code: tenancy is an
opaque `scopeRef`, resources are opaque `resourceType`/`resourceRef` strings,
and callbacks cross the boundary as **function handles**.

## Mounting

```ts
// convex/convex.config.ts
import approvals from 'cvx-kit/components/approvals/convex.config'
app.use(approvals)
```

After installation or upgrade, deploy once and run the component health query
from a host wrapper:

```ts
return ctx.runQuery(components.approvals.health.check, {})
```

It returns the installed approvals schema version and required index names. It
also executes reads through
`approvalDecisions.by_runId_and_decidedAt` and
`approvalDecisions.by_runId_and_stepKey_and_actor_actorRef`, failing with an
installation-specific diagnostic if the packaged component schema was not
deployed.

The component mounts its own private `workflow` and `auditLog` children. Do
**not** re-register those children at the app root under the same identity,
and never reach into `components.approvals.workflow` / `.auditLog` from host
code — the `Approvals` client class is the only contract.

```ts
// convex/approvals.ts — host facade, declared once
import { Approvals } from 'cvx-kit/components/approvals'
import { components } from './_generated/api'

export const approvals = new Approvals(components.approvals)
```

## Defining a workflow — in the owning domain

Workflow *definitions* are business logic and live in the domain that owns the
resource, not in the root facade:

```ts
// convex/domain/documents/approval.ts
import { approvals } from '../../approvals'
import { internal } from '../../_generated/api'

export const publishApproval = approvals.define({
  name: 'documentPublish',
  steps: [
    approvals.decision('managerDecision', {
      decisions: ['approved', 'rejected'],
      quorum: { kind: 'count', approvals: 1 },
      makerChecker: true,                  // requester cannot decide
      expiresAfterMs: 7 * 24 * 60 * 60 * 1000,
    }),
    approvals.branch('applyDecision', {
      approvedStepKey: 'publishDocument',
      rejectedStepKey: 'notifyRejected',
    }),
    approvals.mutation('publishDocument', {
      handler: internal.domain.documents.approval_functions.applyDecision,
    }),
    approvals.notify('notifyRejected', {
      handler: internal.domain.documents.approval_functions.notifyRejected,
      retry: true,
    }),
  ],
})
```

### Step kinds

| Step | Runs | Notes |
|---|---|---|
| `decision(key, { decisions, quorum, makerChecker?, expiresAfterMs? })` | waits for humans | quorum is `{ kind: 'count', approvals: n }`; expiry resolves the run as `expired` |
| `branch(key, { approvedStepKey, rejectedStepKey })` | routing | jumps by the preceding decision's outcome |
| `mutation(key, { handler, retry? })` | internal mutation handle | transactional apply step |
| `action(key, { handler, retry? })` | internal action handle | side effects (third parties) |
| `notify(key, { handler, retry? })` | internal action handle | semantically a notification; same contract as action |

Limits (enforced by the component's validators): ≤ 32 steps per workflow,
≤ 8 decisions per decision step, names ≤ 96 chars, references ≤ 256 chars,
metadata ≤ 32 entries (keys ≤ 64, values ≤ 512 chars).

### Compatibility keys

`compatibilityKey` (defaults to `name`) versions the workflow shape. Every
`decide`/`cancel`/`status`/`restart` call sends it, so a run started under an
old definition cannot be driven by an incompatible new one. When you change a
workflow's steps in a breaking way, change the key.

## Driving a run

```ts
// start — from an authMutation, with ctx.actor as the requester
const { runId } = await publishApproval.start(ctx, {
  scopeRef: ctx.org.organizationId,        // opaque tenancy
  resourceType: 'document',
  resourceRef: documentId,                 // opaque to the component
  requester: ctx.actor,
  metadata: { title },                     // bounded string map
})

// decide — a manager approves or rejects
await publishApproval.decide(ctx, { runId, decision: 'approved', reason }, ctx.actor)

// observe
await publishApproval.status(ctx, runId)   // pending | approved | rejected | expired | canceled
await publishApproval.evidence(ctx, runId) // per-step decision evidence
await publishApproval.list(ctx, { scopeRef, ... })

// manage
await publishApproval.cancel(ctx, runId, ctx.actor)
await publishApproval.restart(ctx, runId)
await approvals.cleanupAudit(ctx, { olderThanDays: 365, batchSize: 100 })
```

## Callback handlers — validate everything coming back

Step handlers are **internal** functions (build them with `systemMutation` /
`systemAction`). They receive `ApprovalCallbackInput`: `{ runId, scopeRef,
resourceType, resourceRef, metadata?, decision? }` — all opaque strings.
Because the component cannot know your tables, the handler must re-establish
trust:

```ts
export const applyDecision = systemMutation({
  args: approvalCallbackArgs,
  handler: async (ctx, input) => {
    if (input.resourceType !== 'document') throw new Error('WRONG_RESOURCE')
    const id = ctx.db.normalizeId('documents', input.resourceRef)
    if (!id) throw new Error('BAD_REF')
    const document = await ctx.db.get(id)
    // guard against stale runs: the doc must still point at this run
    if (document?.approvalRunId !== input.runId) return
    await ctx.db.patch(id, { reviewState: 'published' })
  },
})
```

That `approvalRunId` check is the idempotency/staleness guard from the origin
app — copy it.

## Rules and footguns

1. Root facade (`convex/approvals.ts`) instantiates the client; workflow
   *definitions* live in the owning domain.
2. Handlers get opaque strings — always `normalizeId`, re-check
   `resourceType`, and verify the resource still references the run.
3. `makerChecker: true` means the requester's decisions are rejected — design
   your UI accordingly.
4. The component keeps its own audit trail (retention category
   `approval-protocol`, cleanup via `cleanupAudit`, retention 1–3650 days,
   batch ≤ 100). Host-side business audit still goes through your command
   protocol — they are different trails.
5. Changing steps without changing `compatibilityKey` lets old runs be driven
   by a new incompatible shape; bump the key on breaking changes.
