# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library that provides a PocketBase adapter for TanStack DB. It enables using PocketBase as a real-time data source with TanStack DB's local-first sync engine.

**Key Architecture Concepts:**

- **Adapter Pattern**: The library implements TanStack DB's `CollectionConfig` interface to bridge PocketBase's RecordService API with TanStack DB's collection model
- **Real-time Sync**: Uses PocketBase's subscribe mechanism to listen for server changes and synchronize them to the local TanStack DB collection
- **Sync Flow**: Listens first (via `recordService.subscribe`), then fetches initial data (via `getFullList`), ensuring no events are missed during initial load
- **Mutation Handlers**: Implements `onInsert`, `onUpdate`, and `onDelete` to propagate local changes back to PocketBase server, then enqueue the server response into the sync buffer (TanStack DB only drops a direct transaction's optimistic row when a sync change for its key lands after the transaction completed, and the buffer flushes on a later macrotask)
- **Batched sync writes**: realtime events and mutation responses share one buffer keyed by record id (last event wins) and are committed together on a `setTimeout(flush, batchDelay)` timer that is armed once, not re-armed
- **Realtime upserts**: the adapter tracks synced keys itself; realtime `create`/`update` become `update` for known keys and `delete` of unknown keys is ignored
- **On-demand mode**: `src/filter.ts` compiles live-query `where`/`orderBy`/`limit` into PocketBase `filter`/`sort`/`perPage`; untranslatable expressions fall back to the base filter

## Development Commands

### Build
```bash
bun run build
```
Builds both ESM (`dist/esm/`) and CJS (`dist/cjs/`) formats with TypeScript definitions. The build process:
1. Cleans dist directory
2. Builds ESM bundle (browser target, minified)
3. Builds CJS bundle (node target, minified)
4. Generates TypeScript declarations
5. Copies `.d.ts` files to `.d.cts` for CJS compatibility

Individual build steps:
```bash
bun run build:esm   # ESM only
bun run build:cjs   # CJS only
bun run build:types # TypeScript declarations only
```

### Development
```bash
bun run dev
```
Builds ESM bundle in watch mode for iterative development.

### Testing
```bash
bun test
```
Runs tests with coverage enabled (configured in `bunfig.toml`). Tests use Bun's built-in test runner with mocking capabilities.

### Formatting
```bash
bun run format
```
Formats code using Biome. Configuration in `biome.json` enforces:
- Single quotes
- 320 character line width
- Space indentation
- Auto-organize imports

## Code Structure

- **`src/pocketbase.ts`**: Core adapter implementation
  - `pocketbaseCollectionOptions()`: Factory function that creates TanStack DB CollectionConfig from PocketBase RecordService
  - Implements sync protocol with `begin()`, `write()`, `commit()`, `markReady()` lifecycle
  - Handles create/update/delete mutations via PocketBase API

- **`src/filter.ts`**: Expression to PocketBase filter compiler used by `loadSubset`

- **`src/index.ts`**: Public API exports

- **`tests/pocketbase.test.ts`**, **`tests/adapter.test.ts`**: Test suites with fake record services that simulate PocketBase behavior (realtime echoes, failures, on-demand)

## Type System Notes

- Uses function overloads to support both schema-based and untyped usage
- `PocketbaseRecord` type extends PocketBase's `RecordModel` but omits `collectionId` and `collectionName`
- Schema support via `@standard-schema/spec` integration

## Publishing

The `prepublishOnly` script automatically runs the build before publishing to npm. Always verify tests pass before publishing.
