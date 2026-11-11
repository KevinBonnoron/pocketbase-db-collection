import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type BaseCollectionConfig, type CollectionConfig, compileSingleRowExpression, type DeleteMutationFnParams, type InferSchemaOutput, type InsertMutationFnParams, type LoadSubsetOptions, type SyncConfig, toBooleanPredicate, type UpdateMutationFnParams } from '@tanstack/db';
import type { RecordFullListOptions, RecordListOptions, RecordModel, RecordService } from 'pocketbase';
import { buildSubsetRequest, type FilterBinder, MAX_PER_PAGE } from './filter';

type PocketbaseRecord = Omit<RecordModel, `collectionId` | `collectionName`> & {
  id: string;
};

export type PocketbaseCollectionUtils = {
  /** Generates a PocketBase-compatible record id (15 lowercase alphanumeric characters). Use it as the `id` of inserted records so the optimistic row and the server row share the same key. */
  newId: () => string;
  /** Replaces the synced state with the server state: eager collections re-run the initial fetch, on-demand collections reload the subsets of their active live queries. TanStack DB shares `utils` between every collection created from the same options, so all of them are refetched. */
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

const REQUEST_CONCURRENCY = 4;

/** Runs `run` over `items` with at most REQUEST_CONCURRENCY requests in flight, stops issuing new ones after a failure, and keeps the input order. */
async function mapConcurrently<T, R>(items: Array<T>, run: (item: T) => Promise<R>): Promise<Array<R>> {
  const results: Array<R> = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, items.length) }, worker));
  return results;
}

export interface PocketbaseCollectionConfig<TItem extends PocketbaseRecord = RecordModel, TSchema extends StandardSchemaV1 = never> extends Omit<BaseCollectionConfig<TItem, string, TSchema>, `onInsert` | `onUpdate` | `onDelete` | `getKey` | `utils`> {
  recordService: RecordService<TItem>;
  /** Forwarded to `getFullList()`, `getList()` and `subscribe()`: filter, expand, fields, sort, … */
  options?: RecordFullListOptions;
  /** Applied to every record coming from PocketBase (initial fetch, realtime events, mutation responses). */
  transform?: (record: RecordModel) => TItem;
  /** Milliseconds to wait before committing buffered realtime events and mutation responses together. Defaults to 0 (next macrotask); raise it to fold longer bursts into fewer commits. */
  batchDelay?: number;
  /**
   * Which realtime create/update events an on-demand collection applies. `all` (default) applies every event the
   * user can see, so new records show up in live queries but the collection grows with every write on the server.
   * `loaded` only applies events for records already in the collection or matching the `where` of a subset loaded
   * by an active live query. Deletes are always applied. Ignored by eager collections, which hold everything anyway.
   */
  realtimeScope?: `all` | `loaded`;
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
  const { recordService, options, transform, batchDelay = 0, realtimeScope = `all`, ...restConfig } = config;
  const toItem = (record: unknown): TItem => (transform ? transform(record as RecordModel) : (record as TItem));
  const getKey = (item: TItem) => item.id;

  const bind: FilterBinder | undefined = (() => {
    const client = (recordService as unknown as { client?: { filter?: FilterBinder } }).client;
    return client?.filter ? client.filter.bind(client) : undefined;
  })();

  /** Loads the first `count` records, in pages of at most MAX_PER_PAGE since PocketBase silently caps `perPage`; `skipTotal` spares the `COUNT(*)` PocketBase otherwise runs for every page. */
  async function fetchFirst(count: number, requestOptions: RecordListOptions): Promise<Array<RecordModel>> {
    const perPage = Math.min(count, MAX_PER_PAGE);
    const records: Array<RecordModel> = [];
    for (let page = 1; records.length < count; page++) {
      const { items } = await recordService.getList<RecordModel>(page, perPage, { ...requestOptions, skipTotal: true });
      records.push(...items);
      if (items.length < perPage) break;
    }
    return records.slice(0, count);
  }

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
      /** Orders realtime events, mutation responses and load starts: each takes the next value when it happens. */
      let clock = 0;
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

      const enqueue = (event: SyncEvent<TItem>, stamp: number) => {
        if (!active) return;
        const key = event.type === `upsert` ? getKey(event.item) : event.key;
        if (event.type === `delete`) {
          const previous = pending.get(key)?.event;
          const unsynced = previous?.type === `upsert` ? previous.item : previous?.unsynced;
          if (unsynced) {
            event = { ...event, unsynced };
          }
        }
        pending.set(key, { seq: stamp, event });
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

      const onDemand = collection.config.syncMode === `on-demand`;
      const filterRealtime = onDemand && realtimeScope === `loaded`;
      const matchAll = () => true;
      /** Subsets acquired by active live queries, released by `unloadSubset` with the same options object, with their `where` predicate when realtime events are filtered. */
      const activeSubsets = new Map<LoadSubsetOptions, (item: TItem) => boolean>();

      /**
       * A load response can be older than what the collection learned while it was in flight: a realtime event or a
       * mutation response, or the result of a load that started later (a refetch repairing a missed change). Events
       * and load starts take the next `clock` value. While loads are in flight, the newest known state per key is
       * recorded with its stamp: an event's arrival (before `realtimeScope` filtering, which may drop it), or the
       * start of a committed load for every row that load wrote or deleted. Each load replaces the records whose
       * recorded state is newer than its own start, or drops the deleted ones. A committed load also rewrites the
       * buffered events older than its start for the keys it wrote, so the next flush cannot restore them; they stay
       * buffered because a mutation response must still reach TanStack DB to settle its optimistic row.
       */
      const observed = new Map<string, { seq: number; event: SyncEvent<TItem> }>();
      let loadsInFlight = 0;

      const record = (key: string, event: SyncEvent<TItem>, seq: number) => {
        const latest = observed.get(key);
        if (!latest || latest.seq < seq) observed.set(key, { seq, event });
      };

      /** Stamps an event received from PocketBase and records it for the loads in flight. */
      const observe = (event: SyncEvent<TItem>) => {
        const stamp = ++clock;
        if (loadsInFlight > 0) record(event.type === `upsert` ? getKey(event.item) : event.key, event, stamp);
        return stamp;
      };

      const startLoad = () => {
        loadsInFlight++;
        return ++clock;
      };

      const endLoad = () => {
        if (--loadsInFlight === 0) observed.clear();
      };

      /** Writes what a load returned, after `begin()`, and records it against older loads and buffered events. */
      const writeLoad = (records: Map<string, TItem>, removed: Array<string>, start: number) => {
        for (const key of removed) removeOne(key);
        upsertAll(Array.from(records.values()));
        for (const [key, item] of records) {
          if (loadsInFlight > 1) record(key, { type: `upsert`, item }, start);
          const buffered = pending.get(key);
          if (buffered && buffered.seq < start) pending.set(key, { seq: buffered.seq, event: { type: `upsert`, item } });
        }
        for (const key of removed) {
          if (loadsInFlight > 1) record(key, { type: `delete`, key }, start);
          const buffered = pending.get(key);
          if (buffered && buffered.seq < start) {
            const unsynced = buffered.event.type === `upsert` ? buffered.event.item : buffered.event.unsynced;
            pending.set(key, { seq: buffered.seq, event: unsynced ? { type: `delete`, key, unsynced } : { type: `delete`, key } });
          }
        }
      };

      const newerEvent = (key: string, start: number) => {
        const latest = observed.get(key);
        return latest && latest.seq > start ? latest.event : undefined;
      };

      const reconcile = (lists: Array<Array<RecordModel>>, start: number) => {
        const records = new Map<string, TItem>();
        for (const list of lists) {
          for (const record of list) {
            const item = toItem(record);
            const key = getKey(item);
            const latest = newerEvent(key, start);
            if (latest?.type === `delete`) continue;
            records.set(key, latest?.type === `upsert` ? latest.item : item);
          }
        }
        return records;
      };

      const isLoaded = (item: TItem) => {
        const key = getKey(item);
        if (syncedKeys.has(key) || pending.has(key)) return true;
        for (const matches of activeSubsets.values()) {
          if (matches(item)) return true;
        }
        return false;
      };

      /** Runs the PocketBase requests of a subset: one per filter (several when an `in` list was split), each paged by `perPage` when set. */
      const fetchSubset = (subset: LoadSubsetOptions, signal: AbortSignal | undefined) => {
        const request = buildSubsetRequest(subset, options?.filter, options?.sort, bind);
        return mapConcurrently(request.filters, (filter) => {
          const requestOptions: RecordFullListOptions = { ...options, filter, sort: request.sort, signal, requestKey: null };
          return request.perPage === undefined ? recordService.getFullList<RecordModel>(requestOptions) : fetchFirst(request.perPage, requestOptions);
        });
      };

      /** For each subset, the start of the latest refetch that committed it: a load of the subset started before returns a superseded snapshot. */
      const refreshedBy = new WeakMap<LoadSubsetOptions, number>();
      const superseded = (subset: LoadSubsetOptions, start: number) => (refreshedBy.get(subset) ?? 0) > start;
      /** A subset still owned by a live query; a released or aborted one must not install rows any more. */
      const isCurrent = (subset: LoadSubsetOptions) => activeSubsets.has(subset) && !subset.signal?.aborted;

      /**
       * Reloads the subsets of the active live queries and replaces the synced state with them in one commit: rows
       * synced before the refetch that no current subset returns are deleted. Truncating instead would make TanStack
       * DB replay every subscription, and an ordered one replays as a full-source load of the whole collection.
       */
      const refetchSubsets = async () => {
        const start = startLoad();
        try {
          const before = new Set(syncedKeys);
          const subsets = Array.from(activeSubsets.keys()).filter(isCurrent);
          const results = await mapConcurrently(subsets, (subset) => fetchSubset(subset, undefined));
          if (!active) return;
          const current = subsets.flatMap((subset, i) => (isCurrent(subset) && !superseded(subset, start) ? [{ subset, lists: results[i] as Array<Array<RecordModel>> }] : []));
          const records = reconcile(
            current.flatMap(({ lists }) => lists),
            start,
          );
          // A newer refetch already replaced the rows of a superseded subset, so only it may decide what to remove
          const anySuperseded = subsets.some((subset) => superseded(subset, start));
          const removed = anySuperseded ? [] : Array.from(before).filter((key) => syncedKeys.has(key) && !records.has(key) && !newerEvent(key, start));
          begin();
          writeLoad(records, removed, start);
          for (const { subset } of current) refreshedBy.set(subset, start);
          await commit();
        } finally {
          endLoad();
        }
      };

      const session: SyncSession<TItem> = {
        enqueue: (event) => enqueue(event, observe(event)),
        refetch: async () => {
          if (onDemand) {
            if (active) await refetchSubsets();
            return;
          }
          const generation = ++refetchGeneration;
          const sequenceAtStart = clock;
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
              case `update`: {
                const upsert: SyncEvent<TItem> = { type: `upsert`, item: toItem(event.record) };
                const stamp = observe(upsert);
                if (!filterRealtime || isLoaded(upsert.item)) {
                  enqueue(upsert, stamp);
                }
                break;
              }
              case `delete`: {
                const removal: SyncEvent<TItem> = { type: `delete`, key: event.record.id };
                enqueue(removal, observe(removal));
                break;
              }
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
          if (!onDemand) {
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

      const predicateFor = (where: LoadSubsetOptions[`where`]): ((item: TItem) => boolean) => {
        if (!where) return () => true;
        try {
          const evaluate = compileSingleRowExpression(where);
          return (item) => {
            try {
              return toBooleanPredicate(evaluate(item as Record<string, unknown>));
            } catch {
              return true;
            }
          };
        } catch {
          return () => true;
        }
      };

      const loadSubset = (subset: LoadSubsetOptions): true | Promise<void> => {
        if (subset.signal?.aborted) {
          return Promise.resolve();
        }
        activeSubsets.set(subset, filterRealtime ? predicateFor(subset.where) : matchAll);
        const start = startLoad();
        return fetchSubset(subset, subset.signal)
          .then(
            async (lists) => {
              if (!active || !isCurrent(subset) || superseded(subset, start)) return;
              const records = reconcile(lists, start);
              begin();
              writeLoad(records, [], start);
              // The load settles once its rows are visible, as the LoadSubsetFn contract requires
              await commit();
            },
            (error: unknown) => {
              if (subset.signal?.aborted || (error as { isAbort?: boolean })?.isAbort) return;
              throw error;
            },
          )
          .finally(endLoad);
      };

      const unloadSubset = (subset: LoadSubsetOptions) => {
        activeSubsets.delete(subset);
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
        unloadSubset,
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
    // SQLite compares text byte by byte; TanStack DB defaults to locale ordering, which it cannot express as a
    // cursor, so every ordered on-demand query on a text or date field would fall back to loading the full source.
    defaultStringCollation: { stringSort: `lexical` },
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
