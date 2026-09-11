import { describe, expect, it, mock } from 'bun:test';
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import type { RecordService, RecordSubscription } from 'pocketbase';
import { buildSubsetRequest, compileSort, compileWhere, pocketbaseCollectionOptions, UnsupportedFilterError } from '../src';

type Row = { id: string; data: string; updated?: string };

type Handler = (data: RecordSubscription<Row>) => void;

class FakeRecordService {
  records = new Map<string, Row>();
  handlers: Array<Handler> = [];
  echoRealtime = true;
  failSubscribe = false;
  failUnsubscribe = false;
  failFetch = false;

  getFullList = mock((_options?: unknown) => (this.failFetch ? Promise.reject(new Error(`fetch failed`)) : Promise.resolve(Array.from(this.records.values()))));
  getList = mock((_page: number, perPage: number, _options?: unknown) => Promise.resolve({ items: Array.from(this.records.values()).slice(0, perPage), page: 1, perPage, totalItems: this.records.size, totalPages: 1 }));
  subscribe = mock((_topic: string, callback: Handler, _options?: unknown) => {
    if (this.failSubscribe) {
      return Promise.reject(new Error(`realtime unavailable`));
    }
    this.handlers.push(callback);
    return Promise.resolve(async () => {
      this.handlers = this.handlers.filter((handler) => handler !== callback);
      if (this.failUnsubscribe) {
        throw new Error(`unsubscribe failed`);
      }
    });
  });
  unsubscribe = mock(() => Promise.resolve());
  create = mock((body: Record<string, unknown>) => {
    const record = { ...body, id: (body.id as string) || `srv-${this.records.size + 1}` } as Row;
    this.records.set(record.id, record);
    if (this.echoRealtime) {
      queueMicrotask(() => this.emit(`create`, record));
    }
    return Promise.resolve(record);
  });
  update = mock((id: string, body: Record<string, unknown>) => {
    const record = { ...this.records.get(id), ...body, id } as Row;
    this.records.set(id, record);
    if (this.echoRealtime) {
      queueMicrotask(() => this.emit(`update`, record));
    }
    return Promise.resolve(record);
  });
  delete = mock((id: string) => {
    const record = this.records.get(id);
    this.records.delete(id);
    if (this.echoRealtime && record) {
      queueMicrotask(() => this.emit(`delete`, record));
    }
    return Promise.resolve(true);
  });

  emit(action: string, record: Row) {
    for (const handler of this.handlers) {
      handler({ action, record });
    }
  }
}

function service() {
  return new FakeRecordService();
}

function collectionFor(svc: FakeRecordService, extra: Record<string, unknown> = {}) {
  return createCollection(pocketbaseCollectionOptions({ recordService: svc as unknown as RecordService<Row>, ...extra }));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe(`direct writes after mutations`, () => {
  it(`keeps an inserted row visible even when no realtime echo arrives`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    const collection = collectionFor(svc);
    await collection.stateWhenReady();

    const id = collection.utils.newId();
    expect(id).toMatch(/^[a-z0-9]{15}$/);
    const tx = collection.insert({ id, data: `hello` });
    await tx.isPersisted.promise;
    await tick();

    expect(collection.size).toBe(1);
    expect(collection.get(id)?.data).toBe(`hello`);
    expect((collection.toArray[0] as { $synced?: boolean }).$synced).toBe(true);
    expect(svc.create).toHaveBeenCalledWith({ id, data: `hello` });
  });

  it(`does not throw when the realtime echo repeats a record already written directly`, async () => {
    const svc = service();
    const collection = collectionFor(svc);
    await collection.stateWhenReady();

    const id = collection.utils.newId();
    const tx = collection.insert({ id, data: `hello` });
    await tx.isPersisted.promise;
    await tick();

    expect(collection.size).toBe(1);
    expect(collection.get(id)?.data).toBe(`hello`);

    const updateTx = collection.update(id, (draft) => {
      draft.data = `changed`;
    });
    await updateTx.isPersisted.promise;
    await tick();
    expect(collection.get(id)?.data).toBe(`changed`);

    const deleteTx = collection.delete(id);
    await deleteTx.isPersisted.promise;
    await tick();
    expect(collection.size).toBe(0);
  });

  it(`ignores realtime deletes for unknown keys and updates for unseen keys become inserts`, async () => {
    const svc = service();
    const collection = collectionFor(svc);
    await collection.stateWhenReady();

    svc.emit(`delete`, { id: `ghost`, data: `x` });
    await tick();
    expect(collection.size).toBe(0);

    svc.emit(`update`, { id: `late`, data: `arrived` });
    await tick();
    expect(collection.get(`late`)?.data).toBe(`arrived`);
  });
});

describe(`transform`, () => {
  it(`applies the transform to fetched, realtime and mutated records`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `fetched` });
    const collection = createCollection(
      pocketbaseCollectionOptions({
        recordService: svc as unknown as RecordService<Row>,
        transform: (record) => ({ ...(record as unknown as Row), data: String((record as unknown as Row).data).toUpperCase() }),
      }),
    );
    await collection.stateWhenReady();
    expect(collection.get(`a`)?.data).toBe(`FETCHED`);

    svc.emit(`create`, { id: `b`, data: `live` });
    await tick();
    expect(collection.get(`b`)?.data).toBe(`LIVE`);

    const id = collection.utils.newId();
    const tx = collection.insert({ id, data: `mutated` });
    await tx.isPersisted.promise;
    await tick();
    expect(collection.get(id)?.data).toBe(`MUTATED`);
  });
});

describe(`errors and utils`, () => {
  it(`reports a failed subscription through the collection error state`, async () => {
    const svc = service();
    svc.failSubscribe = true;
    const collection = collectionFor(svc);
    await expect(collection.preload()).rejects.toThrow(`realtime unavailable`);
    expect(collection.status).toBe(`error`);
  });

  it(`reports the fetch error even when the realtime teardown rejects`, async () => {
    const svc = service();
    svc.failFetch = true;
    svc.failUnsubscribe = true;
    const collection = collectionFor(svc);
    await expect(collection.preload()).rejects.toThrow(`fetch failed`);
    expect(collection.status).toBe(`error`);
    expect(svc.handlers).toHaveLength(0);
  });

  it(`refetch replaces the synced state with the server state`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `one` });
    const collection = collectionFor(svc);
    await collection.stateWhenReady();
    expect(collection.size).toBe(1);

    svc.records.delete(`a`);
    svc.records.set(`b`, { id: `b`, data: `two` });
    await collection.utils.refetch();
    await tick();

    expect(collection.size).toBe(1);
    expect(collection.get(`b`)?.data).toBe(`two`);
    expect(collection.get(`a`)).toBeUndefined();
  });
});

describe(`on-demand sync`, () => {
  it(`skips the initial fetch and loads subsets from where clauses`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `one` });
    const collection = collectionFor(svc, { syncMode: `on-demand`, options: { filter: `organization = 'org1'`, expand: `owner` } });
    await collection.stateWhenReady();
    expect(svc.getFullList).toHaveBeenCalledTimes(0);

    const where = {
      type: `func`,
      name: `and`,
      args: [
        {
          type: `func`,
          name: `eq`,
          args: [
            { type: `ref`, path: [`row`, `status`] },
            { type: `val`, value: `CONFIRMED` },
          ],
        },
        {
          type: `func`,
          name: `gte`,
          args: [
            { type: `ref`, path: [`row`, `datetime`] },
            { type: `val`, value: new Date(`2026-09-01T00:00:00.000Z`) },
          ],
        },
      ],
    };
    const orderBy = [{ expression: { type: `ref`, path: [`row`, `datetime`] }, compareOptions: { direction: `desc` } }];

    const request = buildSubsetRequest({ where, orderBy, limit: 20 } as never, `organization = 'org1'`, undefined);
    expect(request.filter).toBe(`(organization = 'org1') && ((status = 'CONFIRMED' && datetime >= '2026-09-01 00:00:00.000Z'))`);
    expect(request.sort).toBe(`-datetime`);
    expect(request.perPage).toBe(20);
  });

  it(`compiles in, not and like`, () => {
    expect(
      compileWhere({
        type: `func`,
        name: `in`,
        args: [
          { type: `ref`, path: [`r`, `status`] },
          { type: `val`, value: [`A`, `B`] },
        ],
      } as never),
    ).toBe(`(status = 'A' || status = 'B')`);
    expect(
      compileWhere({
        type: `func`,
        name: `not`,
        args: [
          {
            type: `func`,
            name: `eq`,
            args: [
              { type: `ref`, path: [`r`, `status`] },
              { type: `val`, value: `A` },
            ],
          },
        ],
      } as never),
    ).toBe(`status != 'A'`);
    expect(
      compileWhere({
        type: `func`,
        name: `like`,
        args: [
          { type: `ref`, path: [`r`, `name`] },
          { type: `val`, value: `Le%` },
        ],
      } as never),
    ).toBe(`name ~ 'Le%'`);
    expect(
      compileWhere({
        type: `func`,
        name: `eq`,
        args: [
          { type: `ref`, path: [`r`, `calendar`, `organization`] },
          { type: `val`, value: `o'neil` },
        ],
      } as never),
    ).toBe(`calendar.organization = 'o\\'neil'`);
    expect(compileSort([{ expression: { type: `ref`, path: [`r`, `created`] }, compareOptions: { direction: `asc` } }] as never)).toBe(`created`);
  });

  it(`falls back to the base filter when the expression is not translatable`, () => {
    const request = buildSubsetRequest({ where: { type: `func`, name: `coalesce`, args: [] } } as never, `organization = 'org1'`, `-created`);
    expect(request.filter).toBe(`organization = 'org1'`);
    expect(request.sort).toBe(`-created`);
  });

  it(`does not translate negated like, since PocketBase !~ is a contains match`, () => {
    const notLike = {
      type: `func`,
      name: `not`,
      args: [
        {
          type: `func`,
          name: `like`,
          args: [
            { type: `ref`, path: [`r`, `name`] },
            { type: `val`, value: `ab` },
          ],
        },
      ],
    };
    expect(() => compileWhere(notLike as never)).toThrow(UnsupportedFilterError);
    const request = buildSubsetRequest({ where: notLike, limit: 10 } as never, `organization = 'org1'`, undefined);
    expect(request.filter).toBe(`organization = 'org1'`);
  });

  it(`drops perPage when the filter or the sort falls back, so the client never filters a truncated page`, () => {
    const unsupportedWhere = { type: `func`, name: `coalesce`, args: [] };
    const unsupportedOrderBy = [{ expression: { type: `func`, name: `lower`, args: [{ type: `ref`, path: [`r`, `name`] }] }, compareOptions: { direction: `asc` } }];
    const supportedWhere = {
      type: `func`,
      name: `eq`,
      args: [
        { type: `ref`, path: [`r`, `status`] },
        { type: `val`, value: `A` },
      ],
    };

    expect(buildSubsetRequest({ where: unsupportedWhere, limit: 10 } as never, undefined, undefined).perPage).toBeUndefined();
    expect(buildSubsetRequest({ where: supportedWhere, orderBy: unsupportedOrderBy, limit: 10 } as never, undefined, undefined).perPage).toBeUndefined();
    expect(buildSubsetRequest({ where: supportedWhere, limit: 10, offset: 5 } as never, undefined, undefined).perPage).toBe(15);
  });

  it(`drops perPage for like and for ilike without a wildcard, since PocketBase ~ is case-insensitive and auto-wraps`, () => {
    const pattern = (name: string, value: string) => ({
      type: `func`,
      name,
      args: [
        { type: `ref`, path: [`r`, `name`] },
        { type: `val`, value },
      ],
    });

    expect(buildSubsetRequest({ where: pattern(`like`, `Le%`), limit: 10 } as never, undefined, undefined)).toEqual({ filter: `name ~ 'Le%'`, sort: undefined, perPage: undefined });
    expect(buildSubsetRequest({ where: pattern(`ilike`, `ab`), limit: 10 } as never, undefined, undefined)).toEqual({ filter: `name ~ 'ab'`, sort: undefined, perPage: undefined });
    expect(buildSubsetRequest({ where: pattern(`ilike`, `%ab%`), limit: 10 } as never, undefined, undefined)).toEqual({ filter: `name ~ '%ab%'`, sort: undefined, perPage: 10 });
  });

  it(`does not translate like or ilike when the field is the pattern`, () => {
    for (const name of [`like`, `ilike`]) {
      const where = {
        type: `func`,
        name,
        args: [
          { type: `val`, value: `abc` },
          { type: `ref`, path: [`r`, `name`] },
        ],
      };
      expect(() => compileWhere(where as never)).toThrow(UnsupportedFilterError);
      expect(buildSubsetRequest({ where, limit: 10 } as never, `organization = 'org1'`, undefined)).toEqual({ filter: `organization = 'org1'`, sort: undefined, perPage: undefined });
    }
    expect(
      compileWhere({
        type: `func`,
        name: `gt`,
        args: [
          { type: `val`, value: 3 },
          { type: `ref`, path: [`r`, `count`] },
        ],
      } as never),
    ).toBe(`count < 3`);
  });

  it(`does not translate ilike with a non-ASCII pattern, since PocketBase ~ folds case for ASCII only`, () => {
    const where = {
      type: `func`,
      name: `ilike`,
      args: [
        { type: `ref`, path: [`r`, `name`] },
        { type: `val`, value: `école%` },
      ],
    };
    expect(() => compileWhere(where as never)).toThrow(UnsupportedFilterError);
    expect(buildSubsetRequest({ where, limit: 10 } as never, `organization = 'org1'`, undefined)).toEqual({ filter: `organization = 'org1'`, sort: undefined, perPage: undefined });
  });

  it(`falls back to the base sort when the ordering is not translatable`, () => {
    const orderBy = [{ expression: { type: `func`, name: `lower`, args: [{ type: `ref`, path: [`r`, `name`] }] }, compareOptions: { direction: `asc` } }];
    const request = buildSubsetRequest({ orderBy } as never, undefined, `-created`);
    expect(request.sort).toBe(`-created`);
  });
});

describe(`shared options`, () => {
  it(`routes mutations and refetches to the collection that issued them`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    const options = pocketbaseCollectionOptions({ recordService: svc as unknown as RecordService<Row> });
    const first = createCollection(options);
    const second = createCollection(options);
    await Promise.all([first.stateWhenReady(), second.stateWhenReady()]);

    const id = first.utils.newId();
    const tx = first.insert({ id, data: `mine` });
    await tx.isPersisted.promise;
    await tick();

    expect(first.get(id)?.data).toBe(`mine`);
    expect(second.get(id)).toBeUndefined();

    await second.utils.refetch();
    await tick();
    expect(second.get(id)?.data).toBe(`mine`);
  });

  it(`keeps the newer collection writable after the older one is cleaned up`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    const options = pocketbaseCollectionOptions({ recordService: svc as unknown as RecordService<Row> });
    const first = createCollection(options);
    const second = createCollection(options);
    await Promise.all([first.stateWhenReady(), second.stateWhenReady()]);

    await first.cleanup();

    const id = second.utils.newId();
    const tx = second.insert({ id, data: `still works` });
    await tx.isPersisted.promise;
    await tick();
    expect(second.get(id)?.data).toBe(`still works`);
    expect((second.toArray[0] as { $synced?: boolean }).$synced).toBe(true);
  });
});

describe(`loadSubset requests`, () => {
  function startOnDemand(svc: FakeRecordService, extra: Record<string, unknown> = {}) {
    const options = pocketbaseCollectionOptions({ recordService: svc as unknown as RecordService<Row>, syncMode: `on-demand`, ...extra });
    const collection = { config: { syncMode: `on-demand` } };
    const result = options.sync.sync({
      collection: collection as never,
      begin: mock(() => {}),
      write: mock(() => {}),
      commit: mock(() => true as never),
      markReady: mock(() => {}),
      markError: mock(() => {}),
      truncate: mock(() => {}),
    });
    return result as { loadSubset: (subset: Record<string, unknown>) => true | Promise<void>; cleanup: () => void };
  }

  it(`skips the request when the signal is already aborted`, async () => {
    const svc = service();
    const { loadSubset, cleanup } = startOnDemand(svc);
    const controller = new AbortController();
    controller.abort();

    await expect(loadSubset({ signal: controller.signal })).resolves.toBeUndefined();
    expect(svc.getFullList).not.toHaveBeenCalled();
    cleanup();
  });

  it(`forwards the signal and disables PocketBase auto-cancellation`, async () => {
    const svc = service();
    const { loadSubset, cleanup } = startOnDemand(svc);
    const controller = new AbortController();

    await loadSubset({ signal: controller.signal });
    expect(svc.getFullList).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, requestKey: null }));

    await loadSubset({ signal: controller.signal, limit: 5 });
    expect(svc.getList).toHaveBeenCalledWith(1, 5, expect.objectContaining({ signal: controller.signal, requestKey: null }));
    cleanup();
  });

  it(`ignores a requestKey from the collection options so concurrent subsets do not cancel each other`, async () => {
    const svc = service();
    const { loadSubset, cleanup } = startOnDemand(svc, { options: { requestKey: `shared`, expand: `owner` } });

    await loadSubset({});
    expect(svc.getFullList).toHaveBeenCalledWith(expect.objectContaining({ requestKey: null, expand: `owner` }));
    cleanup();
  });

  it(`disables auto-cancellation for the initial fetch and refetch, so collections sharing a record service do not cancel each other`, async () => {
    const svc = service();
    const collection = collectionFor(svc, { options: { requestKey: `shared`, expand: `owner` } });
    await collection.stateWhenReady();
    expect(svc.getFullList).toHaveBeenCalledWith({ requestKey: null, expand: `owner` });

    await collection.utils.refetch();
    expect(svc.getFullList).toHaveBeenCalledTimes(2);
    expect(svc.getFullList).toHaveBeenLastCalledWith({ requestKey: null, expand: `owner` });
  });

  it(`binds where values through the PocketBase client filter when the record service exposes it`, async () => {
    const svc = service();
    const client = { filter: mock((raw: string, params: Record<string, unknown>) => raw.replace(/\{:(\w+)\}/g, (_match, name: string) => `"${String(params[name])}"`)) };
    (svc as unknown as { client: typeof client }).client = client;
    const { loadSubset, cleanup } = startOnDemand(svc, { options: { filter: `organization = 'org1'` } });

    await loadSubset({
      where: {
        type: `func`,
        name: `eq`,
        args: [
          { type: `ref`, path: [`r`, `status`] },
          { type: `val`, value: `CONFIRMED` },
        ],
      },
      limit: 5,
    });

    expect(client.filter).toHaveBeenCalledWith(`status = {:p0}`, { p0: `CONFIRMED` });
    expect(svc.getList).toHaveBeenCalledWith(1, 5, expect.objectContaining({ filter: `(organization = 'org1') && (status = "CONFIRMED")` }));
    cleanup();
  });

  it(`resolves instead of rejecting when the request is aborted mid-flight`, async () => {
    const svc = service();
    const controller = new AbortController();
    svc.getFullList.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error(`The request was autocancelled`), { isAbort: true }));
    });
    const { loadSubset, cleanup } = startOnDemand(svc);

    await expect(loadSubset({ signal: controller.signal })).resolves.toBeUndefined();

    svc.getFullList.mockImplementationOnce(() => Promise.reject(new Error(`boom`)));
    await expect(loadSubset({})).rejects.toThrow(`boom`);
    cleanup();
  });

  it(`unsubscribes when cleanup runs before the subscription resolved`, async () => {
    const svc = service();
    const { cleanup } = startOnDemand(svc);
    cleanup();
    await tick();
    expect(svc.subscribe).toHaveBeenCalledTimes(1);
    expect(svc.handlers).toHaveLength(0);
  });
});

describe('live queries', () => {
  it('accepts a collection created from the adapter as a query source', async () => {
    const service = new FakeRecordService();
    service.records.set('a1', { id: 'a1', data: 'open' });
    service.records.set('a2', { id: 'a2', data: 'closed' });
    const rows = createCollection(pocketbaseCollectionOptions<Row>({ recordService: service as unknown as RecordService<Row> }));
    const openRows = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, 'open')));
    await openRows.preload();
    expect(openRows.toArray.map(({ id }) => id)).toEqual(['a1']);
  });
});
