import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { BaseCollectionConfig, CollectionConfig, DeleteMutationFnParams, InferSchemaOutput, InsertMutationFnParams, LoadSubsetOptions, SyncConfig, UpdateMutationFnParams } from '@tanstack/db';
import type { RecordFullListOptions, RecordModel, RecordService } from 'pocketbase';
import { buildSubsetRequest, type FilterBinder } from './filter';

type PocketbaseRecord = Omit<RecordModel, `collectionId` | `collectionName`> & {
  id: string;
};

export type PocketbaseCollectionUtils = {
  /** Generates a PocketBase-compatible record id (15 lowercase alphanumeric characters). Use it as the `id` of inserted records so the optimistic row and the server row share the same key. */
  newId: () => string;
  /** Re-runs the initial fetch and replaces the synced state with the server state. TanStack DB shares `utils` between every collection created from the same options, so all of them are refetched. */
  refetch: () => Promise<void>;
};

const ID_ALPHABET = `abcdefghijklmnopqrstuvwxyz0123456789`;
const ID_LENGTH = 15;

export function newRecordId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = ``;
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

export interface PocketbaseCollectionConfig<TItem extends PocketbaseRecord = RecordModel, TSchema extends StandardSchemaV1 = never> extends Omit<BaseCollectionConfig<TItem, string, TSchema>, `onInsert` | `onUpdate` | `onDelete` | `getKey` | `utils`> {
  recordService: RecordService<TItem>;
  /** Forwarded to `getFullList()`, `getList()` and `subscribe()`: filter, expand, fields, sort, … */
  options?: RecordFullListOptions;
  /** Applied to every record coming from PocketBase (initial fetch, realtime events, mutation responses). */
  transform?: (record: RecordModel) => TItem;
}

type SyncParams<TItem extends PocketbaseRecord> = Parameters<SyncConfig<TItem, string>[`sync`]>[0];

interface SyncSession<TItem extends PocketbaseRecord> {
  upsert: (records: Array<TItem>) => void;
  remove: (keys: Array<string>) => void;
  refetch: () => Promise<void>;
}

/**
 * TanStack DB keeps the optimistic row of a direct transaction until a sync change for its key
 * is committed *after* the transaction completes. Server state is therefore written on the next
 * macrotask, once the mutation handler has resolved.
 */
function afterHandlerResolves(callback: () => void) {
  setTimeout(callback, 0);
}

export function pocketbaseCollectionOptions<TSchema extends StandardSchemaV1>(
  config: PocketbaseCollectionConfig<InferSchemaOutput<TSchema> & PocketbaseRecord, TSchema> & {
    schema: TSchema;
  },
): CollectionConfig<InferSchemaOutput<TSchema>, string, TSchema, PocketbaseCollectionUtils> & {
  schema: TSchema;
};
export function pocketbaseCollectionOptions<TItem extends PocketbaseRecord>(
  config: PocketbaseCollectionConfig<TItem, never> & {
    schema?: never;
  },
): CollectionConfig<TItem, string, never, PocketbaseCollectionUtils> & {
  schema?: never;
};
export function pocketbaseCollectionOptions<TItem extends PocketbaseRecord = PocketbaseRecord, TSchema extends StandardSchemaV1 = never>(config: PocketbaseCollectionConfig<TItem, TSchema>): CollectionConfig<TItem, string, TSchema, PocketbaseCollectionUtils> {
  const { recordService, options, transform, ...restConfig } = config;
  const toItem = (record: unknown): TItem => (transform ? transform(record as RecordModel) : (record as TItem));
  const getKey = (item: TItem) => item.id;

  const bind: FilterBinder | undefined = (() => {
    const client = (recordService as unknown as { client?: { filter?: FilterBinder } }).client;
    return client?.filter ? client.filter.bind(client) : undefined;
  })();

  const sessions = new Map<object, SyncSession<TItem>>();

  const sync: SyncConfig<TItem, string> = {
    sync: (params: SyncParams<TItem>) => {
      const { collection, begin, write, commit, markReady, markError, truncate } = params;
      const syncedKeys = new Set<string>();
      let unsubscribeFn: (() => Promise<void>) | undefined;
      let active = true;

      const upsertAll = (records: Array<TItem>) => {
        for (const record of records) {
          const key = getKey(record);
          if (syncedKeys.has(key)) {
            write({ type: `update`, value: record });
          } else {
            write({ type: `insert`, value: record });
            syncedKeys.add(key);
          }
        }
      };

      const removeAll = (keys: Array<string>) => {
        for (const key of keys) {
          if (!syncedKeys.has(key)) {
            continue;
          }
          write({ type: `delete`, key });
          syncedKeys.delete(key);
        }
      };

      async function fetchAll(): Promise<Array<TItem>> {
        const records = await recordService.getFullList<RecordModel>({ ...options, requestKey: null });
        return records.map(toItem);
      }

      async function initialFetch() {
        const records = await fetchAll();
        if (!active) return;
        begin();
        upsertAll(records);
        commit();
      }

      const session: SyncSession<TItem> = {
        upsert: (records) => {
          if (!active) return;
          begin();
          upsertAll(records);
          commit();
        },
        remove: (keys) => {
          if (!active) return;
          begin();
          removeAll(keys);
          commit();
        },
        refetch: async () => {
          const records = await fetchAll();
          if (!active) return;
          begin();
          truncate();
          syncedKeys.clear();
          upsertAll(records);
          commit();
        },
      };
      sessions.set(collection, session);

      async function listen() {
        const unsubscribe = await recordService.subscribe<RecordModel>(
          `*`,
          (event) => {
            if (!active) return;
            begin();
            switch (event.action) {
              case `create`:
              case `update`:
                upsertAll([toItem(event.record)]);
                break;
              case `delete`:
                removeAll([event.record.id]);
                break;
            }
            commit();
          },
          options,
        );
        if (!active) {
          await unsubscribe().catch(() => {});
          return;
        }
        unsubscribeFn = unsubscribe;
      }

      async function start() {
        try {
          await listen();
          if (collection.config.syncMode !== `on-demand`) {
            await initialFetch();
          }
          markReady();
        } catch (error) {
          if (unsubscribeFn) {
            await unsubscribeFn().catch(() => {});
            unsubscribeFn = undefined;
          }
          markError(error);
        }
      }

      const loadSubset = (subset: LoadSubsetOptions): true | Promise<void> => {
        if (subset.signal?.aborted) {
          return Promise.resolve();
        }
        const request = buildSubsetRequest(subset, options?.filter, options?.sort, bind);
        const requestOptions: RecordFullListOptions = { ...options, filter: request.filter, sort: request.sort, signal: subset.signal, requestKey: null };
        const fetching = request.perPage === undefined ? recordService.getFullList<RecordModel>(requestOptions) : recordService.getList<RecordModel>(1, request.perPage, requestOptions).then((page) => page.items);
        return fetching.then(
          (records) => {
            if (!active || subset.signal?.aborted) return;
            begin();
            upsertAll(records.map(toItem));
            commit();
          },
          (error: unknown) => {
            if (subset.signal?.aborted || (error as { isAbort?: boolean })?.isAbort) return;
            throw error;
          },
        );
      };

      start();

      return {
        cleanup: () => {
          active = false;
          if (sessions.get(collection) === session) {
            sessions.delete(collection);
          }
          if (unsubscribeFn) {
            void unsubscribeFn().catch(() => {});
            unsubscribeFn = undefined;
          }
        },
        loadSubset,
      };
    },
  };

  const utils: PocketbaseCollectionUtils = {
    newId: newRecordId,
    refetch: async () => {
      if (sessions.size === 0) {
        throw new Error(`Collection sync has not started`);
      }
      await Promise.all(Array.from(sessions.values(), (session) => session.refetch()));
    },
  };

  return {
    ...restConfig,
    getKey,
    sync,
    utils,
    onInsert: async (params: InsertMutationFnParams<TItem, string>) => {
      const session = sessions.get(params.collection);
      return await Promise.all(
        params.transaction.mutations.map(async (mutation) => {
          const { id, ...rest } = mutation.changes;
          const changes = id ? { id, ...rest } : rest;
          const created = toItem(await recordService.create<RecordModel>(changes));
          afterHandlerResolves(() => session?.upsert([created]));
          return created.id;
        }),
      );
    },
    onUpdate: async (params: UpdateMutationFnParams<TItem, string>) => {
      const session = sessions.get(params.collection);
      return await Promise.all(
        params.transaction.mutations.map(async ({ key, changes }) => {
          const updated = toItem(await recordService.update<RecordModel>(key, changes));
          afterHandlerResolves(() => session?.upsert([updated]));
          return key;
        }),
      );
    },
    onDelete: async (params: DeleteMutationFnParams<TItem, string>) => {
      const session = sessions.get(params.collection);
      return await Promise.all(
        params.transaction.mutations.map(async (mutation) => {
          await recordService.delete(mutation.key);
          afterHandlerResolves(() => session?.remove([mutation.key]));
          return mutation.key;
        }),
      );
    },
  };
}
