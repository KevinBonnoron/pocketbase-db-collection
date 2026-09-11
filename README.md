# pocketbase-db-collection

A [PocketBase](https://pocketbase.io) collection adapter for [TanStack DB](https://tanstack.com/db). It lets you use a PocketBase `RecordService` as a real-time, local-first data source for a TanStack DB collection.

## Features

- Real-time sync via PocketBase's `subscribe()`; realtime events are applied as upserts, so echoes of your own writes never raise duplicate-key errors
- Initial data fetch with `getFullList()` after subscribing (no missed events), or query-driven loading with `syncMode: 'on-demand'`
- Optimistic mutations forwarded to PocketBase (`create`, `update`, `delete`); the server response is written back into the synced state right after the mutation settles, so rows never flicker while waiting for the realtime echo
- Client-generated ids (`collection.utils.newId()`) so the optimistic row and the server row share the same key
- Optional `transform` to shape every record coming from PocketBase (dates, computed fields)
- Optional Standard Schema for typed and validated mutations
- Sync failures (expired token, network) surface through the collection error state
- Automatic unsubscribe on collection cleanup, `collection.utils.refetch()` to resync from the server

## Installation

```bash
npm install pocketbase-db-collection @tanstack/db pocketbase
# or
bun add pocketbase-db-collection @tanstack/db pocketbase
```

## Peer dependencies

- `@tanstack/db` `>=0.6.0 <1` (tested against 0.9)
- `pocketbase` `>=0.26.0 <1` (tested against 0.28)

## Usage

### Basic

```typescript
import { createCollection } from '@tanstack/db'
import PocketBase from 'pocketbase'
import { pocketbaseCollectionOptions } from 'pocketbase-db-collection'

type Todo = {
  id: string
  title: string
  done: boolean
}

const pb = new PocketBase('http://localhost:8090')

const todos = createCollection(
  pocketbaseCollectionOptions({
    recordService: pb.collection<Todo>('todos'),
  }),
)

// Wait for the initial sync to complete
await todos.stateWhenReady()

// Read
const all = todos.toArray
const one = todos.get('record-id')

// Mutate: generate the id on the client so the optimistic row keeps its key
todos.insert({ id: todos.utils.newId(), title: 'Buy milk', done: false })
todos.update('record-id', (draft) => {
  draft.done = true
})
todos.delete('record-id')
```

PocketBase accepts client-provided ids (15 lowercase alphanumeric characters), which is exactly what `newId()` produces. Inserting without an id still works, but TanStack DB then keeps a temporary optimistic row next to the server row until the next sync change, so always pass one.

### Passing PocketBase options

The `options` field is forwarded to `getFullList()`, `getList()` and `subscribe()`. Use it for filters, expand, fields, sort.

```typescript
const todos = createCollection(
  pocketbaseCollectionOptions({
    recordService: pb.collection<Todo>('todos'),
    options: {
      filter: 'done = false',
      expand: 'author',
      sort: '-created',
    },
  }),
)
```

### Transforming records

`transform` runs on every record coming from PocketBase: initial fetch, realtime events and mutation responses. Use it to parse dates or derive fields.

```typescript
const appointments = createCollection(
  pocketbaseCollectionOptions({
    recordService: pb.collection('appointments'),
    transform: (record) => ({ ...record, datetime: new Date(record.datetime) }),
  }),
)
```

### On-demand loading

With `syncMode: 'on-demand'` the collection subscribes to realtime events but does not fetch everything up front. Live queries drive the loading: their `where`, `orderBy` and `limit` clauses are compiled into a PocketBase filter, sort and page size, combined with the base `options.filter`.

```typescript
import { createCollection, eq, gte } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'

const appointments = createCollection(
  pocketbaseCollectionOptions({
    recordService: pb.collection('appointments'),
    syncMode: 'on-demand',
    options: { expand: 'customer,service' },
  }),
)

// Loads `status = 'CONFIRMED' && datetime >= '2026-09-01 00:00:00.000Z'` sorted by `-datetime`
useLiveQuery((q) =>
  q
    .from({ appointment: appointments })
    .where(({ appointment }) => eq(appointment.status, 'CONFIRMED'))
    .where(({ appointment }) => gte(appointment.datetime, new Date('2026-09-01')))
    .orderBy(({ appointment }) => appointment.datetime, 'desc'),
)
```

Supported operators: `eq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `and`, `or`, and `not` on `eq` and `in` (a negated `like` cannot be expressed with PocketBase's `!~` contains operator). Field references may be nested (`calendar.organization`). Expressions that cannot be translated fall back to the base filter, which loads a superset that the live query then filters locally. `perPage` is only sent when the PocketBase filter is exact: `like` (case-sensitive in TanStack DB, not in PocketBase) and `ilike` without a `%` wildcard (PocketBase turns it into a contains match) load the full superset instead. Values are bound with `pb.filter()` when the record service exposes its client.

### With a Standard Schema

Any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType, …) can be passed via `schema` for typed records and validated mutations. The schema validates what you insert; use `transform` for what comes from the server.

```typescript
import { z } from 'zod'

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
})

const todos = createCollection(
  pocketbaseCollectionOptions({
    recordService: pb.collection('todos'),
    schema: todoSchema,
  }),
)
```

### Sessions

A collection is bound to the PocketBase auth state it was created with. When the user signs out or switches account, clean the collection up and let it restart with the new session:

```typescript
pb.authStore.onChange(() => {
  todos.cleanup()
})
```

`await todos.utils.refetch()` replaces the synced state with a fresh `getFullList()` without restarting the subscription. TanStack DB shares `utils` between every collection created from the same options object, so all of them are refetched.

## API

### `pocketbaseCollectionOptions(config)`

Returns a `CollectionConfig` for TanStack DB's `createCollection()`.

| Field | Type | Description |
| --- | --- | --- |
| `recordService` | `RecordService<TItem>` | A PocketBase record service (`pb.collection('...')`). Required. |
| `options` | `RecordFullListOptions` | Optional. Forwarded to `getFullList()`, `getList()` and `subscribe()`. |
| `transform` | `(record: RecordModel) => TItem` | Optional. Applied to every record coming from PocketBase. |
| `schema` | `StandardSchemaV1` | Optional. Validates mutations and types records. |
| `syncMode` | `'eager' \| 'on-demand'` | Optional, TanStack DB option. `on-demand` skips the initial fetch and loads from live queries. |
| Other | — | Any other `BaseCollectionConfig` field (`id`, `gcTime`, `startSync`, `autoIndex`, `compare`, …) is forwarded as-is. |

The returned config sets `getKey` to the record id, registers the sync function (subscribe, then initial fetch or `loadSubset`), the `onInsert` / `onUpdate` / `onDelete` handlers, and `utils`:

| Util | Description |
| --- | --- |
| `newId()` | A PocketBase-compatible record id. |
| `refetch()` | Replaces the synced state with the current server state. |

### Filter helpers

`compileWhere`, `compileSort`, `combineFilters` and `buildSubsetRequest` are exported for adapters that need to translate TanStack DB expressions to PocketBase filters themselves.

## Development

Requires [Bun](https://bun.sh) `>= 1.2`.

```bash
bun install
bun test            # unit tests with coverage
bun run type-check
bun run lint
bun run build       # ESM, CJS and declarations in dist/
```

## License

MIT
