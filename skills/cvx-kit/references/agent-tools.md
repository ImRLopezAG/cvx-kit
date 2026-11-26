# `cvx-kit/agent-tools` — agents get audited commands

`createAgentTools` turns a table's tool masks into framework-agnostic tool
records `{ name, description, args, handler }`, where `args` is a `k` schema.
Adapt them to `@convex-dev/agent`'s `createTool` or ai-sdk `tool()` by
converting `args` to the schema form the library accepts; the kit depends on
neither.

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

// host-side, with a library that takes Zod (import 'cvx-kit/zod' for toZod):
// const agentTools = Object.fromEntries(Object.values(tools).map((t) =>
//   [t.name, createTool({ description: t.description, args: toZod(t.args), handler: t.handler })]))
// with a library that takes JSON Schema: toJsonSchema(t.args) from 'cvx-kit/json-schema'
// with a library that reads Standard JSON Schema (TanStack AI): import 'cvx-kit/json-schema' once,
// then pass t.args itself; it exposes ~standard.jsonSchema.input({ target: 'draft-2020-12' })
```

## Contracts

- **Args are the table masks, no drift**: `create` = `tools.insert`
  (`commandFields`), `update` = `tools.update`, `archive`/`get` = `tools.id`,
  `list` = the pagination opts boundary. `args` is a `k` schema (Standard
  Schema v1, with `args.parse`). Ids stay `k.id(...)`, typed `Id<...>`; they
  are plain strings in the JSON Schema from `toJsonSchema` (`cvx-kit/json-schema`).
  For a library that only accepts Zod, convert with `toZod(args)` from `cvx-kit/zod`.
  A library that reads Standard JSON Schema (`~standard.jsonSchema`, for example
  TanStack AI tool schemas) takes `args` directly once `cvx-kit/json-schema` is
  imported in that module; without the import it fails with `does not expose a
  JSON Schema converter on ~standard.jsonSchema`. Large contracts can pass
  `toJsonSchema(args, { refs: true })` to share repeated sub-schemas via `$defs`.
- **Only the kinds you supply handlers for are emitted**; names are
  `<tableName>_<verb>`; descriptions are derived and overridable via
  `options.descriptions`.
- DTO discipline applies to reads: `get`/`list` handlers should return
  `toPublicDto`-projected data, same as any public query.
