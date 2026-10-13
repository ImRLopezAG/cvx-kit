# `cvx-kit/agent-tools` — agents get audited commands

`createAgentTools` turns a table's tool masks into framework-agnostic tool
records `{ name, description, args, handler }` — directly spreadable into
`@convex-dev/agent`'s `createTool`, adaptable to ai-sdk `tool()`, and the
kit depends on neither (shape checked against `@convex-dev/agent@0.6.x`;
re-verify at install).

The point is the routing, not the shape: **mutation handlers go through
command executors**, so every agent action is validated, guarded, audited,
and observed. An agent never gets raw db access.

```ts
import { createAgentTools } from 'cvx-kit/agent-tools'

const tools = createAgentTools(<entities>, {
  // mutations — audited commands (createCrudCommands executors fit exactly):
  create: (ctx, input) => crud.executeCreate(ctx, input),
  update: (ctx, input) => crud.executeUpdate(ctx, input),
  archive: (ctx, input) => crud.executeArchive(ctx, input),
  // reads — caller-supplied query handlers (reads don't route through commands):
  get: (ctx, { id }) => loadDto(ctx, id),
  list: (ctx, { paginationOpts }) => listPage(ctx, paginationOpts),
})

// host-side, with @convex-dev/agent:
// const agentTools = Object.fromEntries(Object.values(tools).map((t) =>
//   [t.name, createTool({ description: t.description, args: t.args, handler: t.handler })]))
```

## Contracts

- **Args are the table masks, no drift**: `create` = `tools.insert`
  (`commandFields`), `update` = `tools.update`, `archive`/`get` = `tools.id`,
  `list` = the pagination opts boundary. Ids present as plain strings in
  generated JSON schemas (`jsonSafeZid`) while keeping `Id<...>` types.
- **Only the kinds you supply handlers for are emitted**; names are
  `<tableName>_<verb>`; descriptions are derived and overridable via
  `options.descriptions`.
- DTO discipline applies to reads: `get`/`list` handlers should return
  `toPublicDto`-projected data, same as any public query.
