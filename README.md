# pocketbase-db-collection

A [PocketBase](https://pocketbase.io) collection adapter for [TanStack DB](https://tanstack.com/db). It lets you use a PocketBase `RecordService` as a real-time, local-first data source for a TanStack DB collection.

## Features

- Real-time sync via PocketBase's `subscribe()`; realtime events are applied as upserts, so echoes of your own writes never raise duplicate-key errors
- Initial data fetch with `getFullList()` after subscribing (no missed events), or query-driven loading with `syncMode: 'on-demand'`
- Optimistic mutations forwarded to PocketBase (`create`, `update`, `delete`); the server response is written back into the synced state as soon as the mutation settles, so rows never flicker while waiting for the realtime echo
- Realtime events and mutation responses are batched into one commit per macrotask (tunable with `batchDelay`), so a burst of server writes does not freeze the page with one live-query recompute per record
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

- `@tanstack/db` `>=0.9.0 <1` (sync failures are reported through `markError`, which 0.9 introduced)
- `pocketbase` `>=0.26.0 <1` (tested against 0.28)
- Node.js `>=19` for the CJS build: `collection.utils.newId()` relies on the global `crypto`

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

Supported operators: `eq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `and`, `or`, and `not` on `eq` and `in` (a negated `like` cannot be expressed with PocketBase's `!~` contains operator). Field references may be nested (`calendar.organization`). Expressions that cannot be translated fall back to the base filter, which loads a superset that the live query then filters locally. Values are bound with `pb.filter()` when the record service exposes its client.

`like` and `ilike` patterns are translated so the server always returns a superset of what TanStack DB matches: backslashes are escaped, a pattern without `%` is wrapped in `%…%` (PocketBase would otherwise escape `_`, a wildcard in TanStack DB), and for `ilike` every non-ASCII letter becomes `%`, since SQLite `LIKE` folds case for ASCII only. A page size is only sent when the filter is exact, which means an `ilike` with a `%` and ASCII-only letters; any other `like`/`ilike` loads the whole filtered superset.

Paging: an ordered, limited live query on a single column loads its first page with `getList(1, limit)` and every following page with the rows after the last loaded value (`created < '…'`) instead of reloading the previous pages; TanStack DB loads the rows equal to that value with a second request. Ordering on several columns has no cursor and reloads the prefix. Pages larger than 1000 records (PocketBase's `perPage` cap) are loaded in successive requests, all with `skipTotal`.

An `in` list too long for PocketBase's filter limits (3500 bytes, 200 comparisons) is split into several requests whose results are committed together, as long as the `in` is a top-level conjunct of the `where`.

The collection defaults `defaultStringCollation` to `{ stringSort: 'lexical' }`, to match the byte order SQLite uses. TanStack DB otherwise sorts strings by locale and, since it cannot express a locale order as a cursor, loads the full source for every ordered query on a text or date field. Override it if you need locale ordering in the UI. The match is exact for ids, dates and any text below U+E000; JavaScript compares UTF-16 code units and SQLite compares UTF-8 bytes, so an ordered, limited query on a field mixing characters above U+FFFF (emoji) with characters in U+E000–U+FFFF (full-width forms, private use) can page differently from the server. Order such a field with `{ stringSort: 'locale' }` in the query's `orderBy` options: that query then loads its whole filtered source.

By default every realtime create/update the user can see is applied, so new records show up in live queries but the collection keeps growing with every write on the server. Set `realtimeScope: 'loaded'` to only apply events for records already in the collection or matching the `where` of a subset loaded by an active live query; deletes and the responses of local mutations are always applied.

A load response never overwrites a newer state: a realtime event or mutation response received while a load was in flight wins over the row the load returns, and a row deleted meanwhile is not written back.

TanStack DB 0.9 itself loads the full source of an ordered, limited live query when a row of its window is deleted or changes its sort value, since the window's cursor no longer holds.

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

`await todos.utils.refetch()` replaces the synced state with the server state without restarting the subscription. An eager collection re-runs `getFullList()`. An on-demand collection reloads the subsets of its active live queries and commits them at once; rows that no subset returns any more are removed. TanStack DB shares `utils` between every collection created from the same options object, so all of them are refetched.

## API

### `pocketbaseCollectionOptions(config)`

Returns a `CollectionConfig` for TanStack DB's `createCollection()`.

| Field | Type | Description |
| --- | --- | --- |
| `recordService` | `RecordService<TItem>` | A PocketBase record service (`pb.collection('...')`). Required. |
| `options` | `RecordFullListOptions` | Optional. Forwarded to `getFullList()`, `getList()` and `subscribe()`. |
| `transform` | `(record: RecordModel) => TItem` | Optional. Applied to every record coming from PocketBase. |
| `batchDelay` | `number` | Optional, default `0`. Milliseconds to buffer realtime events and mutation responses before committing them together. Raise it to fold longer bursts into fewer commits. |
| `schema` | `StandardSchemaV1` | Optional. Validates mutations and types records. |
| `syncMode` | `'eager' \| 'on-demand'` | Optional, TanStack DB option. `on-demand` skips the initial fetch and loads from live queries. |
| `realtimeScope` | `'all' \| 'loaded'` | Optional, default `all`. On-demand only: `loaded` drops realtime create/update events for records that are neither loaded nor matched by an active live query. |
| `defaultStringCollation` | `StringCollationConfig` | Optional, default `{ stringSort: 'lexical' }` to match SQLite. |
| Other | — | Any other `BaseCollectionConfig` field (`id`, `gcTime`, `startSync`, `autoIndex`, `compare`, …) is forwarded as-is. |

The returned config sets `getKey` to the record id, registers the sync function (subscribe, then initial fetch or `loadSubset`), the `onInsert` / `onUpdate` / `onDelete` handlers, and `utils`:

| Util | Description |
| --- | --- |
| `newId()` | A PocketBase-compatible record id. |
| `refetch()` | Replaces the synced state with the current server state. |

### Filter helpers

`compileWhere`, `compileSort`, `combineFilters` and `buildSubsetRequest` are exported for adapters that need to translate TanStack DB expressions to PocketBase filters themselves. `buildSubsetRequest` returns `filters` (one per request, several when an `in` list was split), `sort` and `perPage`.

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
