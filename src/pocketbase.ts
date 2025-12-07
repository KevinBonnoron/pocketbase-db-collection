import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { BaseCollectionConfig, CollectionConfig, DeleteMutationFnParams, InferSchemaOutput, InsertMutationFnParams, SyncConfig, UpdateMutationFnParams } from '@tanstack/db';
import type { RecordFullListOptions, RecordModel, RecordService } from 'pocketbase';

type PocketbaseRecord = Omit<RecordModel, `collectionId` | `collectionName`> & {
  id: string;
};

export interface PocketbaseCollectionConfig<TItem extends PocketbaseRecord = RecordModel, TSchema extends StandardSchemaV1 = never> extends Omit<BaseCollectionConfig<TItem, string, TSchema>, `onInsert` | `onUpdate` | `onDelete` | `getKey`> {
  recordService: RecordService<TItem>;
  options?: RecordFullListOptions;
}

export function pocketbaseCollectionOptions<TSchema extends StandardSchemaV1>(
  config: PocketbaseCollectionConfig<InferSchemaOutput<TSchema> & PocketbaseRecord, TSchema> & {
    schema: TSchema;
  },
): CollectionConfig<InferSchemaOutput<TSchema>, string, TSchema> & {
  schema: TSchema;
};
export function pocketbaseCollectionOptions<TItem extends PocketbaseRecord>(
  config: PocketbaseCollectionConfig<TItem, never> & {
    schema?: never;
  },
): CollectionConfig<TItem, string> & {
  schema?: never;
};
export function pocketbaseCollectionOptions<TItem extends PocketbaseRecord = PocketbaseRecord, TSchema extends StandardSchemaV1 = never>(config: PocketbaseCollectionConfig<TItem, TSchema>): CollectionConfig<TItem, string, TSchema> {
  const { recordService, options, ...restConfig } = config;
  const getKey = (item: TItem) => {
    return item.id;
  };

  type SyncParams = Parameters<SyncConfig<TItem, string>[`sync`]>[0];
  const sync = {
    sync: (params: SyncParams) => {
      const { begin, write, commit, markReady } = params;

      let unsubscribeFn: (() => Promise<void>) | undefined;

      async function initialFetch() {
        const records = await recordService.getFullList<TItem>(options);

        begin();
        for (const record of records) {
          write({ type: `insert`, value: record });
        }
        commit();
      }

      async function listen() {
        unsubscribeFn = await recordService.subscribe<TItem>(
          `*`,
          (event) => {
            begin();
            switch (event.action) {
              case `create`:
                write({ type: `insert`, value: event.record });
                break;
              case `update`:
                write({ type: `update`, value: event.record });
                break;
              case `delete`:
                write({ type: `delete`, value: event.record });
                break;
            }
            commit();
          },
          options,
        );
      }

      async function start() {
        await listen();

        try {
          await initialFetch();
        } catch (e) {
          if (unsubscribeFn) {
            await unsubscribeFn();
            unsubscribeFn = undefined;
          }
          throw e;
        } finally {
          markReady();
        }
      }

      start();

      // Return cleanup function to unsubscribe when collection is cleaned up
      return async () => {
        if (unsubscribeFn) {
          await unsubscribeFn();
        }
      };
    },
  };

  return {
    ...restConfig,
    getKey,
    sync,
    onInsert: async (params: InsertMutationFnParams<TItem, string>) => {
      return await Promise.all(
        params.transaction.mutations.map(async (mutation) => {
          const { id: _, ...changes } = mutation.changes;
          const result = await recordService.create(changes);
          return result.id;
        }),
      );
    },
    onUpdate: async (params: UpdateMutationFnParams<TItem, string>) => {
      return await Promise.all(
        params.transaction.mutations.map(async ({ key, changes }) => {
          await recordService.update(key, changes);
          return key;
        }),
      );
    },
    onDelete: async (params: DeleteMutationFnParams<TItem, string>) => {
      return await Promise.all(
        params.transaction.mutations.map(async (mutation) => {
          await recordService.delete(mutation.key);
          return mutation.key;
        }),
      );
    },
  };
}
