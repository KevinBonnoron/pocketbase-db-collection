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
  /** Milliseconds to wait before committing buffered realtime events and mutation responses together. Defaults to 0 (next macrotask); raise it to fold longer bursts into fewer commits. */
  batchDelay?: number;
}

type SyncParams<TItem extends PocketbaseRecord> = Parameters<SyncConfig<TItem, string>[`sync`]>[0];

type SyncEvent<TItem> = { type: `upsert`; item: TItem } | { type: `delete`; key: string; unsynced?: TItem };

interface SyncSession<TItem extends PocketbaseRecord> {
  enqueue: (event: SyncEvent<TItem>) => void;
  refetch: () => Promise<void>;
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
  const { recordService, options, transform, batchDelay = 0, ...restConfig } = config;
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

      const upsertOne = (record: TItem) => {
        const key = getKey(record);
        if (syncedKeys.has(key)) {
          write({ type: `update`, value: record });
        } else {
          write({ type: `insert`, value: record });
          syncedKeys.add(key);
        }
      };

      const removeOne = (key: string, unsynced?: TItem) => {
        if (!syncedKeys.has(key)) {
          if (!unsynced || !collection.has(key)) return;
          write({ type: `insert`, value: unsynced });
        }
        write({ type: `delete`, key });
        syncedKeys.delete(key);
      };

      const upsertAll = (records: Array<TItem>) => {
        for (const record of records) {
          upsertOne(record);
        }
      };

      /**
       * Realtime events and mutation responses are buffered and committed together on a timer, so a burst
       * of SSE messages (each one its own macrotask) costs one commit per flush instead of one per record;
       * an isolated event pays one macrotask of latency. The timer is armed by the first event and never
       * re-armed (a throttle, not a debounce), so a continuous stream still drains on every flush. Only the
       * last event per key is kept, so a create followed by a delete of the same record is applied as the
       * delete alone; when that delete replaces the buffered upsert of a key never synced yet, the insert
       * and the delete are both written so TanStack DB still sees a sync change for the key and drops the
       * optimistic row. The same flush also satisfies TanStack DB, which drops the optimistic row of a direct
       * transaction only once a sync change for its key is committed after the transaction completes: a
       * mutation handler enqueues the server response before resolving, and the flush runs on a later
       * macrotask. While a refetch is in flight the timer is suspended and events accumulate; events
       * enqueued after the refetch started are applied on top of the fresh snapshot instead of being wiped
       * by its truncate, while those enqueued before it are older than the snapshot and are dropped, except
       * a delete that must drop a retained optimistic row the snapshot does not contain.
       */
      const pending = new Map<string, { seq: number; event: SyncEvent<TItem> }>();
      let sequence = 0;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let refetchGeneration = 0;
      let newestRefetchPending = false;

      const cancelFlush = () => {
        if (flushTimer === undefined) return;
        clearTimeout(flushTimer);
        flushTimer = undefined;
      };

      const scheduleFlush = () => {
        if (flushTimer !== undefined || newestRefetchPending || pending.size === 0) return;
        flushTimer = setTimeout(flush, batchDelay);
      };

      const applyPending = (after = 0) => {
        for (const { seq, event } of pending.values()) {
          if (event.type === `upsert`) {
            if (seq > after) upsertOne(event.item);
          } else if (seq > after || (event.unsynced && !syncedKeys.has(event.key))) {
            removeOne(event.key, event.unsynced);
          }
        }
        pending.clear();
      };

      const flush = () => {
        flushTimer = undefined;
        if (!active || pending.size === 0) return;
        begin();
        applyPending();
        commit();
      };

      const enqueue = (event: SyncEvent<TItem>) => {
        if (!active) return;
        const key = event.type === `upsert` ? getKey(event.item) : event.key;
        if (event.type === `delete`) {
          const previous = pending.get(key)?.event;
          const unsynced = previous?.type === `upsert` ? previous.item : previous?.unsynced;
          if (unsynced) {
            event = { ...event, unsynced };
          }
        }
        pending.set(key, { seq: ++sequence, event });
        scheduleFlush();
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
        enqueue,
        refetch: async () => {
          const generation = ++refetchGeneration;
          const sequenceAtStart = sequence;
          newestRefetchPending = true;
          cancelFlush();
          const settle = () => {
            if (generation === refetchGeneration) {
              newestRefetchPending = false;
            }
          };
          let records: Array<TItem>;
          try {
            records = await fetchAll();
          } catch (error) {
            settle();
            scheduleFlush();
            throw error;
          }
          settle();
          if (!active || generation !== refetchGeneration) {
            scheduleFlush();
            return;
          }
          begin();
          truncate();
          syncedKeys.clear();
          upsertAll(records);
          applyPending(sequenceAtStart);
          commit();
        },
      };
      sessions.set(collection, session);

      async function listen() {
        const unsubscribe = await recordService.subscribe<RecordModel>(
          `*`,
          (event) => {
            switch (event.action) {
              case `create`:
              case `update`:
                enqueue({ type: `upsert`, item: toItem(event.record) });
                break;
              case `delete`:
                enqueue({ type: `delete`, key: event.record.id });
                break;
            }
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
          cancelFlush();
          pending.clear();
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
          session?.enqueue({ type: `upsert`, item: created });
          return created.id;
        }),
      );
    },
    onUpdate: async (params: UpdateMutationFnParams<TItem, string>) => {
      const session = sessions.get(params.collection);
      return await Promise.all(
        params.transaction.mutations.map(async ({ key, changes }) => {
          const updated = toItem(await recordService.update<RecordModel>(key, changes));
          session?.enqueue({ type: `upsert`, item: updated });
          return key;
        }),
      );
    },
    onDelete: async (params: DeleteMutationFnParams<TItem, string>) => {
      const session = sessions.get(params.collection);
      return await Promise.all(
        params.transaction.mutations.map(async (mutation) => {
          await recordService.delete(mutation.key);
          session?.enqueue({ type: `delete`, key: mutation.key });
          return mutation.key;
        }),
      );
    },
  };
}
