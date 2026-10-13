# `cvx-kit/webhooks` — the sanctioned webhook boundary

Webhooks are the one boundary that genuinely needs deduplication (Convex's
client gives exactly-once for its own mutations; external providers redeliver).
The helper encodes the pattern: **verify over the raw body (fail closed) →
derive the natural key → delegate to an internal mutation whose first act is
transactional dedup**.

## Wiring

```ts
// schema — host-owned dedup table (the kit gains no tables):
webhookEvents: webhookEventsTable().table.index('by_eventKey', ['eventKey'])

// boundary — used inside the host's httpAction:
const boundary = createWebhookBoundary({
  // RAW body, BEFORE parsing. Constant-time comparison (crypto.subtle HMAC
  // verify), secret from a Convex environment variable — never in code.
  verify: async (raw, request) => verifyVendorSignature(raw, request.headers),
  // The natural-key pattern:
  eventKey: (raw) => {
    const event = JSON.parse(raw)
    return `${event.type}:${event.id}:${event.updatedAt}`
  },
  source: 'vendor',
})

// http.ts — routing only:
http.route({ path: '/webhooks/vendor', method: 'POST',
  handler: httpAction((ctx, request) =>
    boundary.handle(ctx, request, internal.<module>.functions.applyVendorEvent)) })

// the target — a systemMutation; dedup FIRST, transactionally:
export const applyVendorEvent = systemMutation({
  args: { eventKey: z.string(), payload: z.string(), source: z.string() },
  handler: async (ctx, args) => {
    const { duplicate } = await recordWebhookEvent(ctx, { key: args.eventKey, source: args.source })
    if (duplicate) return null
    const payload = JSON.parse(args.payload)   // parse INSIDE the trusted path
    // ...apply, via domain executors
    return null
  },
})
```

## Rules

1. **Dedup lives in the mutation, never the action.** The action can race;
   the mutation's insert-if-absent is transactional.
2. **Verification is over raw bytes.** Re-serialized/parsed bodies break or
   weaken HMACs; the helper hands `verify` the raw `request.text()`.
3. **Fail closed.** `verify` returning false OR throwing both reject with
   `WEBHOOK_SIGNATURE_INVALID`, before any delegation.
4. **Retention is yours.** Dedup rows grow forever unless pruned — run a
   cleanup cron over `receivedAt` with a window comfortably longer than the
   provider's redelivery horizon (days, not hours).
5. Providers with signed timestamps (Stripe-style): also enforce a tolerance
   window inside `verify`.
