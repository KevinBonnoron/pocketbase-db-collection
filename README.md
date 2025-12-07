# pocketbase-db-collection

PocketBase adapter for TanStack DB - enables using PocketBase as a data source with TanStack DB.

## Installation

```bash
npm install pocketbase-db-collection
# or
bun add pocketbase-db-collection
# or
pnpm add pocketbase-db-collection
```

## Dependencies

This package requires the following dependencies:

- `@tanstack/db` - The TanStack DB library
- `pocketbase` - The PocketBase client
- `@standard-schema/spec` - For schema support
- `@tanstack/store` - For internal store

## Usage

```typescript
import { createCollection } from "@tanstack/db"
import { pocketbaseCollectionOptions } from "pocketbase-db-collection"
import PocketBase from "pocketbase"

const pb = new PocketBase("http://localhost:8090")
const recordService = pb.collection("your_collection")

const collection = createCollection(
  pocketbaseCollectionOptions({
    recordService,
  })
)

// Use the collection
await collection.stateWhenReady()
const items = collection.getAll()
```

## Development

### Prerequisites

- [Bun](https://bun.sh) (v1.2.22 or higher)

### Install Dependencies

```bash
bun install
```

### Build

```bash
bun run build
```

This generates files in `dist/` with both ESM and CJS formats, as well as TypeScript definitions. The build uses `bun build` directly configured via `bunfig.toml`.

### Tests

```bash
bun test
```

### Development Mode

```bash
bun run dev
```

This runs the build in watch mode.

## Publishing to npm

1. Make sure the build works: `bun run build`
2. Verify tests pass: `bun test`
3. Update the version in `package.json`
4. Publish: `npm publish`

The `prepublishOnly` script will automatically run before publishing to ensure the build is up to date.

## Project Structure

```
.
├── src/
│   ├── index.ts          # Main entry point
│   └── pocketbase.ts     # PocketBase adapter implementation
├── tests/
│   └── pocketbase.test.ts # Tests
├── dist/                 # Generated files (ESM and CJS)
└── package.json
```

## License

MIT
