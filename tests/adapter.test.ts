import { describe, expect, it, jest, mock } from 'bun:test';
import { BasicIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import type { RecordService, RecordSubscription } from 'pocketbase';
import { buildSubsetRequest, compileSort, compileWhere, type PocketbaseCollectionUtils, pocketbaseCollectionOptions, UnsupportedFilterError } from '../src';

type Row = { id: string; data: string; updated?: string; created?: string };

/** Evaluates the `field <op> 'value'` comparisons of a filter as a conjunction, enough for the filters these tests emit. */
function matchesFilter(record: Row, filter: string | undefined): boolean {
  return Array.from(filter?.matchAll(/(\w+) (=|<|>) '([^']*)'/g) ?? []).every(([, field, operator, value]) => {
    const actual = String(record[field as keyof Row] ?? ``);
    return operator === `=` ? actual === value : operator === `<` ? actual < (value as string) : actual > (value as string);
  });
}

type ListOptions = { filter?: string; sort?: string };

type Handler = (data: RecordSubscription<Row>) => void;

class FakeRecordService {
  records = new Map<string, Row>();
  handlers: Array<Handler> = [];
  echoRealtime = true;
  failSubscribe = false;
  failUnsubscribe = false;
  failFetch = false;

  query(options: ListOptions | undefined): Array<Row> {
    const rows = Array.from(this.records.values()).filter((record) => matchesFilter(record, options?.filter));
    const sort = options?.sort;
    if (sort) {
      const field = sort.replace(/^-/, ``) as keyof Row;
      const direction = sort.startsWith(`-`) ? -1 : 1;
      rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -direction : direction));
    }
    return rows;
  }

  getFullList = mock((options?: ListOptions) => (this.failFetch ? Promise.reject(new Error(`fetch failed`)) : Promise.resolve(this.query(options))));
  getList = mock((page: number, perPage: number, options?: ListOptions) => Promise.resolve({ items: this.query(options).slice((page - 1) * perPage, page * perPage), page, perPage, totalItems: -1, totalPages: -1 }));
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

function collectionWithSyncSpy(svc: FakeRecordService, extra: Record<string, unknown> = {}) {
  const options = pocketbaseCollectionOptions({ recordService: svc as unknown as RecordService<Row>, ...extra });
  const counts = { begin: 0, commit: 0, write: 0 };
  const inner = options.sync.sync;
  options.sync = {
    ...options.sync,
    sync: (params) =>
      inner({
        ...params,
        begin: (...args) => {
          counts.begin++;
          return params.begin(...args);
        },
        write: (...args) => {
          counts.write++;
          return params.write(...args);
        },
        commit: (...args) => {
          counts.commit++;
          return params.commit(...args);
        },
      }),
  };
  return { collection: createCollection(options), counts };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

describe(`batched sync writes`, () => {
  it(`flushes several realtime events arriving before the timer in a single commit`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;

    svc.emit(`create`, { id: `a`, data: `1` });
    svc.emit(`create`, { id: `b`, data: `2` });
    svc.emit(`create`, { id: `c`, data: `3` });
    expect(collection.size).toBe(0);
    expect(counts.commit).toBe(commitsBefore);

    await tick();
    expect(counts.commit).toBe(commitsBefore + 1);
    expect(counts.begin).toBe(counts.commit);
    expect(collection.toArray.map((row) => row.data)).toEqual([`1`, `2`, `3`]);
  });

  it(`keeps only the last event per key, so a create followed by a delete leaves the record absent`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const writesBefore = counts.write;

    svc.emit(`create`, { id: `kept`, data: `x` });
    svc.emit(`create`, { id: `gone`, data: `y` });
    svc.emit(`update`, { id: `kept`, data: `z` });
    svc.emit(`delete`, { id: `gone`, data: `y` });
    await tick();

    expect(collection.get(`gone`)).toBeUndefined();
    expect(collection.get(`kept`)?.data).toBe(`z`);
    expect(collection.size).toBe(1);
    expect(counts.write).toBe(writesBefore + 1);
  });

  it(`drops the optimistic row when a realtime delete replaces the buffered insert response`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    const { collection, counts } = collectionWithSyncSpy(svc, { batchDelay: 30 });
    await collection.stateWhenReady();
    const writesBefore = counts.write;

    await collection.insert({ id: `x`, data: `1` }).isPersisted.promise;
    expect(collection.get(`x`)?.data).toBe(`1`);
    svc.emit(`delete`, { id: `x`, data: `1` });
    await sleep(40);

    expect(collection.get(`x`)).toBeUndefined();
    expect(collection.size).toBe(0);
    expect(counts.write).toBe(writesBefore + 2);
  });

  it(`re-creates a record when a create follows a delete in the same flush`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `old` });
    const { collection } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();

    svc.emit(`delete`, { id: `a`, data: `old` });
    svc.emit(`create`, { id: `a`, data: `new` });
    await tick();

    expect(collection.get(`a`)?.data).toBe(`new`);
  });

  it(`flushes at the first deadline under a continuous stream instead of re-arming like a debounce`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc, { batchDelay: 30 });
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;
    jest.useFakeTimers();
    try {
      svc.emit(`create`, { id: `a`, data: `1` });
      fakeTimers.advanceTimersByTime(10);
      svc.emit(`create`, { id: `b`, data: `2` });
      fakeTimers.advanceTimersByTime(10);
      svc.emit(`create`, { id: `c`, data: `3` });
      fakeTimers.advanceTimersByTime(9);
      expect(counts.commit).toBe(commitsBefore);

      fakeTimers.advanceTimersByTime(1);
      expect(counts.commit).toBe(commitsBefore + 1);
      expect(collection.size).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it(`commits the responses of a multi-row transaction and their realtime echoes together`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;
    const writesBefore = counts.write;

    const tx = collection.insert([
      { id: `a`, data: `1` },
      { id: `b`, data: `2` },
      { id: `c`, data: `3` },
    ]);
    await tx.isPersisted.promise;
    await tick();

    expect(counts.commit).toBe(commitsBefore + 1);
    expect(counts.write).toBe(writesBefore + 3);
    expect(collection.size).toBe(3);
    expect(collection.toArray.every((row) => (row as { $synced?: boolean }).$synced)).toBe(true);
  });

  it(`honours batchDelay`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc, { batchDelay: 30 });
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;

    svc.emit(`create`, { id: `a`, data: `1` });
    await tick();
    expect(counts.commit).toBe(commitsBefore);
    svc.emit(`create`, { id: `b`, data: `2` });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(counts.commit).toBe(commitsBefore + 1);
    expect(collection.size).toBe(2);
  });

  it(`folds pending events into the refetch commit`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `server` });
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;

    const refetching = collection.utils.refetch();
    svc.emit(`create`, { id: `b`, data: `live` });
    await refetching;
    await tick();

    expect(counts.commit).toBe(commitsBefore + 1);
    expect(collection.get(`a`)?.data).toBe(`server`);
    expect(collection.get(`b`)?.data).toBe(`live`);
  });

  it(`drops events buffered before the refetch started, since the snapshot is newer`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `v1` });
    svc.records.set(`b`, { id: `b`, data: `v1` });
    const { collection, counts } = collectionWithSyncSpy(svc, { batchDelay: 30 });
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;

    svc.emit(`update`, { id: `a`, data: `stale` });
    svc.emit(`delete`, { id: `b`, data: `v1` });
    svc.records.set(`a`, { id: `a`, data: `v2` });
    await collection.utils.refetch();

    expect(collection.get(`a`)?.data).toBe(`v2`);
    expect(collection.get(`b`)?.data).toBe(`v1`);
    await sleep(40);
    expect(counts.commit).toBe(commitsBefore + 1);
  });

  it(`still drops an optimistic insert deleted remotely when a refetch replaces the buffer`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    const { collection } = collectionWithSyncSpy(svc, { batchDelay: 30 });
    await collection.stateWhenReady();

    await collection.insert({ id: `x`, data: `1` }).isPersisted.promise;
    svc.records.delete(`x`);
    svc.emit(`delete`, { id: `x`, data: `1` });
    await collection.utils.refetch();
    await sleep(40);

    expect(collection.get(`x`)).toBeUndefined();
    expect(collection.size).toBe(0);
  });

  it(`holds events arriving during a slow refetch and applies them on top of the snapshot`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `server` });
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;
    svc.getFullList = mock(() => sleep(30).then(() => Array.from(svc.records.values())));

    const refetching = collection.utils.refetch();
    await tick();
    svc.emit(`create`, { id: `b`, data: `live` });
    await tick();
    expect(counts.commit).toBe(commitsBefore);
    expect(collection.get(`b`)).toBeUndefined();

    await refetching;
    expect(counts.commit).toBe(commitsBefore + 1);
    expect(collection.get(`a`)?.data).toBe(`server`);
    expect(collection.get(`b`)?.data).toBe(`live`);
  });

  it(`lets only the newest of two overlapping refetches commit`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `initial` });
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;
    const resolvers: Array<(records: Array<Row>) => void> = [];
    svc.getFullList = mock(() => new Promise<Array<Row>>((resolve) => resolvers.push(resolve)));

    const older = collection.utils.refetch();
    const newer = collection.utils.refetch();
    await tick();
    expect(resolvers.length).toBe(2);

    resolvers[1]?.([{ id: `a`, data: `newer` }]);
    await newer;
    expect(collection.get(`a`)?.data).toBe(`newer`);

    resolvers[0]?.([{ id: `a`, data: `older` }]);
    await older;
    await tick();
    expect(collection.get(`a`)?.data).toBe(`newer`);
    expect(counts.commit).toBe(commitsBefore + 1);
  });

  it(`does not let a superseded refetch that never settles block flushing`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const resolvers: Array<(records: Array<Row>) => void> = [];
    svc.getFullList = mock(() => new Promise<Array<Row>>((resolve) => resolvers.push(resolve)));

    void collection.utils.refetch();
    const newer = collection.utils.refetch();
    await tick();
    resolvers[1]?.([{ id: `a`, data: `snapshot` }]);
    await newer;
    const commitsBefore = counts.commit;

    svc.emit(`create`, { id: `b`, data: `live` });
    await tick();
    expect(counts.commit).toBe(commitsBefore + 1);
    expect(collection.get(`a`)?.data).toBe(`snapshot`);
    expect(collection.get(`b`)?.data).toBe(`live`);
  });

  it(`resumes flushing when the refetch fails`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const commitsBefore = counts.commit;
    svc.getFullList = mock(() => sleep(10).then(() => Promise.reject(new Error(`fetch failed`))));

    const refetching = collection.utils.refetch();
    svc.emit(`create`, { id: `b`, data: `live` });
    await expect(refetching).rejects.toThrow(`fetch failed`);
    await tick();

    expect(counts.commit).toBe(commitsBefore + 1);
    expect(collection.get(`b`)?.data).toBe(`live`);
  });

  it(`writes nothing when cleanup runs before the flush`, async () => {
    const svc = service();
    const { collection, counts } = collectionWithSyncSpy(svc);
    await collection.stateWhenReady();
    const before = { ...counts };

    svc.emit(`create`, { id: `a`, data: `1` });
    collection.cleanup();
    await tick();

    expect(counts.begin).toBe(before.begin);
    expect(counts.commit).toBe(before.commit);
    expect(counts.write).toBe(before.write);
  });
});
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
  const ref = (...path: Array<string>) => ({ type: `ref`, path });
  const val = (value: unknown) => ({ type: `val`, value });
  const fn = (name: string, ...args: Array<unknown>) => ({ type: `func`, name, args });

  it(`skips the initial fetch and loads subsets from where clauses`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `one` });
    const collection = collectionFor(svc, { syncMode: `on-demand`, options: { filter: `organization = 'org1'`, expand: `owner` } });
    await collection.stateWhenReady();
    expect(svc.getFullList).toHaveBeenCalledTimes(0);

    const where = fn(`and`, fn(`eq`, ref(`status`), val(`CONFIRMED`)), fn(`gte`, ref(`datetime`), val(new Date(`2026-09-01T00:00:00.000Z`))));
    const orderBy = [{ expression: ref(`datetime`), compareOptions: { direction: `desc` } }];

    const request = buildSubsetRequest({ where, orderBy, limit: 20 } as never, `organization = 'org1'`, undefined);
    expect(request.filters).toEqual([`(organization = 'org1') && ((status = 'CONFIRMED' && datetime >= '2026-09-01 00:00:00.000Z'))`]);
    expect(request.sort).toBe(`-datetime`);
    expect(request.perPage).toBe(20);
  });

  it(`compiles in, not, like and nested field paths`, () => {
    expect(compileWhere(fn(`in`, ref(`status`), val([`A`, `B`, `A`])) as never)).toBe(`(status = 'A' || status = 'B')`);
    expect(compileWhere(fn(`not`, fn(`eq`, ref(`status`), val(`A`))) as never)).toBe(`status != 'A'`);
    expect(compileWhere(fn(`like`, ref(`name`), val(`Le%`)) as never)).toBe(`name ~ 'Le%'`);
    expect(compileWhere(fn(`eq`, ref(`calendar`, `organization`), val(`o'neil`)) as never)).toBe(`calendar.organization = 'o\\'neil'`);
    expect(compileSort([{ expression: ref(`calendar`, `created`), compareOptions: { direction: `asc` } }] as never)).toBe(`calendar.created`);
  });

  it(`falls back to the base filter when the expression is not translatable`, () => {
    const request = buildSubsetRequest({ where: fn(`coalesce`) } as never, `organization = 'org1'`, `-created`);
    expect(request.filters).toEqual([`organization = 'org1'`]);
    expect(request.sort).toBe(`-created`);
  });

  it(`does not translate negated like, since PocketBase !~ is a contains match`, () => {
    const notLike = fn(`not`, fn(`like`, ref(`name`), val(`ab`)));
    expect(() => compileWhere(notLike as never)).toThrow(UnsupportedFilterError);
    const request = buildSubsetRequest({ where: notLike, limit: 10 } as never, `organization = 'org1'`, undefined);
    expect(request.filters).toEqual([`organization = 'org1'`]);
  });

  it(`drops perPage when the filter or the sort falls back, so the client never filters a truncated page`, () => {
    const unsupportedOrderBy = [{ expression: fn(`lower`, ref(`name`)), compareOptions: { direction: `asc` } }];
    const supportedWhere = fn(`eq`, ref(`status`), val(`A`));

    expect(buildSubsetRequest({ where: fn(`coalesce`), limit: 10 } as never, undefined, undefined).perPage).toBeUndefined();
    expect(buildSubsetRequest({ where: supportedWhere, orderBy: unsupportedOrderBy, limit: 10 } as never, undefined, undefined).perPage).toBeUndefined();
    expect(buildSubsetRequest({ where: supportedWhere, limit: 10, offset: 5 } as never, undefined, undefined).perPage).toBe(15);
  });

  it(`translates like and ilike into PocketBase patterns that match a superset, exact only for ASCII ilike with a wildcard`, () => {
    const request = (name: string, value: string) => buildSubsetRequest({ where: fn(name, ref(`name`), val(value)), limit: 10 } as never, undefined, undefined);

    expect(request(`like`, `Le%`)).toEqual({ filters: [`name ~ 'Le%'`], sort: undefined, perPage: undefined });
    expect(request(`ilike`, `%ab%`)).toEqual({ filters: [`name ~ '%ab%'`], sort: undefined, perPage: 10 });
    // Without `%`, PocketBase would escape `_` into a literal; wrapping keeps it a wildcard like in TanStack DB
    expect(request(`ilike`, `a_c`)).toEqual({ filters: [`name ~ '%a_c%'`], sort: undefined, perPage: undefined });
    // PocketBase uses `\` as the LIKE escape character, TanStack DB has none
    expect(request(`ilike`, `a\\b%`).filters).toEqual([`name ~ 'a\\\\\\\\b%'`]);
    // SQLite LIKE folds case for ASCII only, so a non-ASCII cased letter becomes a wildcard
    expect(request(`ilike`, `école%`)).toEqual({ filters: [`name ~ '%cole%'`], sort: undefined, perPage: undefined });
    expect(request(`ilike`, `東京%`)).toEqual({ filters: [`name ~ '東京%'`], sort: undefined, perPage: 10 });
  });

  it(`does not translate like or ilike when the field is the pattern`, () => {
    for (const name of [`like`, `ilike`]) {
      const where = fn(name, val(`abc`), ref(`name`));
      expect(() => compileWhere(where as never)).toThrow(UnsupportedFilterError);
      expect(buildSubsetRequest({ where, limit: 10 } as never, `organization = 'org1'`, undefined)).toEqual({ filters: [`organization = 'org1'`], sort: undefined, perPage: undefined });
    }
    expect(compileWhere(fn(`gt`, val(3), ref(`count`)) as never)).toBe(`count < 3`);
  });

  it(`falls back to the base sort when the ordering is not translatable`, () => {
    const request = buildSubsetRequest({ orderBy: [{ expression: fn(`lower`, ref(`name`)), compareOptions: { direction: `asc` } }] } as never, undefined, `-created`);
    expect(request.sort).toBe(`-created`);
  });

  it(`replaces the offset with the cursor, and keeps the offset when the cursor is not translatable`, () => {
    const orderBy = [{ expression: ref(`created`), compareOptions: { direction: `desc`, nulls: `last` } }];
    const cursor = { whereFrom: fn(`lt`, ref(`created`), val(`2026-01-02`)), whereCurrent: fn(`eq`, ref(`created`), val(`2026-01-02`)) };
    expect(buildSubsetRequest({ orderBy, limit: 10, offset: 30, cursor } as never, `a = 1`, undefined)).toEqual({ filters: [`(a = 1) && (created < '2026-01-02')`], sort: `-created`, perPage: 10 });

    const nullsLast = { ...cursor, whereFrom: fn(`or`, fn(`lt`, ref(`created`), val(`2026-01-02`)), fn(`isNull`, ref(`created`))) };
    expect(buildSubsetRequest({ orderBy, limit: 10, offset: 30, cursor: nullsLast } as never, `a = 1`, undefined)).toEqual({ filters: [`a = 1`], sort: `-created`, perPage: 40 });
  });

  it(`splits a large in list so every filter fits PocketBase's length and expression limits`, () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id${String(i).padStart(13, `0`)}`);
    const where = fn(`and`, fn(`eq`, ref(`status`), val(`A`)), fn(`in`, ref(`id`), val([...ids, ids[0]])));
    const { filters } = buildSubsetRequest({ where } as never, `organization = 'org1'`, undefined);

    expect(filters.length).toBeGreaterThan(1);
    const loaded: Array<string> = [];
    for (const filter of filters as Array<string>) {
      expect(new TextEncoder().encode(filter).length).toBeLessThanOrEqual(3500);
      expect(filter.match(/ = /g)?.length ?? 0).toBeLessThanOrEqual(200);
      expect(filter.startsWith(`(organization = 'org1') && ((status = 'A' && (`)).toBe(true);
      loaded.push(...Array.from(filter.matchAll(/id = '(\w+)'/g), (match) => match[1] as string));
    }
    expect(loaded.sort()).toEqual(ids);

    // A negated list is not a union of its parts
    expect(buildSubsetRequest({ where: fn(`not`, fn(`in`, ref(`id`), val(ids))) } as never, undefined, undefined).filters).toHaveLength(1);
  });

  it(`splits every oversized in list, so two large lists still produce filters within the limits`, () => {
    const ids = (prefix: string) => Array.from({ length: 250 }, (_, i) => `${prefix}${String(i).padStart(13, `0`)}`);
    const [owners, tags] = [ids(`o`), ids(`t`)];
    const { filters } = buildSubsetRequest({ where: fn(`and`, fn(`in`, ref(`owner`), val(owners)), fn(`in`, ref(`tag`), val(tags))) } as never, undefined, undefined);

    const pairs = new Set<string>();
    for (const filter of filters as Array<string>) {
      expect(new TextEncoder().encode(filter).length).toBeLessThanOrEqual(3500);
      expect(filter.match(/ = /g)?.length ?? 0).toBeLessThanOrEqual(200);
      const values = (field: string) => Array.from(filter.matchAll(new RegExp(`${field} = '(\\w+)'`, `g`)), (match) => match[1]);
      for (const owner of values(`owner`)) {
        for (const tag of values(`tag`)) pairs.add(`${owner}/${tag}`);
      }
    }
    expect(pairs.size).toBe(owners.length * tags.length);
  });

  it(`does not split when it cannot help or would take too many requests, and sends the filter for PocketBase to reject`, () => {
    const ids = (prefix: string, length: number) => Array.from({ length }, (_, i) => `${prefix}${String(i).padStart(13, `0`)}`);
    const twoLists = (length: number) => fn(`and`, fn(`in`, ref(`owner`), val(ids(`o`, length))), fn(`in`, ref(`tag`), val(ids(`t`, length))));

    // Even single values exceed the limit next to this base filter: no split, instead of 62,500 invalid filters
    expect(buildSubsetRequest({ where: twoLists(250) } as never, `note = '${`x`.repeat(3480)}'`, undefined).filters).toHaveLength(1);
    // Two lists of 2000 values would multiply into hundreds of requests
    expect(buildSubsetRequest({ where: twoLists(2000) } as never, undefined, undefined).filters).toHaveLength(1);
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
    const sync = { begin: mock(() => {}), write: mock((_message: WriteMessage) => {}), commit: mock(() => true as never), truncate: mock(() => {}) };
    const result = options.sync.sync({
      collection: collection as never,
      ...sync,
      markReady: mock(() => {}),
      markError: mock(() => {}),
    });
    type Subset = Record<string, unknown>;
    return { ...(result as { loadSubset: (subset: Subset) => true | Promise<void>; unloadSubset: (subset: Subset) => void; cleanup: () => void }), sync, refetch: (options.utils as PocketbaseCollectionUtils).refetch };
  }

  type WriteMessage = { type: string; value?: Row; key?: string };
  const whereData = (value: string) => ({
    where: {
      type: `func`,
      name: `eq`,
      args: [
        { type: `ref`, path: [`data`] },
        { type: `val`, value },
      ],
    },
  });
  const writesOf = (write: { mock: { calls: Array<[WriteMessage]> } }, key: string) => write.mock.calls.map(([message]) => message).filter((message) => (message.value?.id ?? message.key) === key);

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
          { type: `ref`, path: [`status`] },
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

  it(`loads more than PocketBase's 1000-record page cap in successive pages`, async () => {
    const svc = service();
    for (let i = 0; i < 2500; i++) {
      svc.records.set(`r${i}`, { id: `r${i}`, data: `x` });
    }
    const { loadSubset, cleanup, sync } = startOnDemand(svc);

    await loadSubset({ limit: 2100 });
    expect(svc.getList.mock.calls.map(([page, perPage, options]) => [page, perPage, (options as { skipTotal?: boolean }).skipTotal])).toEqual([
      [1, 1000, true],
      [2, 1000, true],
      [3, 1000, true],
    ]);
    expect(sync.write).toHaveBeenCalledTimes(2100);
    cleanup();
  });

  it(`loads a split in list with one request per part and commits the union once`, async () => {
    const svc = service();
    const ids = Array.from({ length: 300 }, (_, i) => `id${String(i).padStart(13, `0`)}`);
    for (const id of ids.slice(0, 250)) {
      svc.records.set(id, { id, data: `x` });
    }
    svc.getFullList.mockImplementation((options?: ListOptions) => Promise.resolve(Array.from(options?.filter?.matchAll(/id = '(\w+)'/g) ?? [], ([, id]) => svc.records.get(id as string)).filter((row): row is Row => row !== undefined)));
    const { loadSubset, cleanup, sync } = startOnDemand(svc);

    await loadSubset({
      where: {
        type: `func`,
        name: `in`,
        args: [
          { type: `ref`, path: [`id`] },
          { type: `val`, value: ids },
        ],
      },
    });
    expect(svc.getFullList.mock.calls.length).toBeGreaterThan(1);
    expect(sync.begin).toHaveBeenCalledTimes(1);
    expect(sync.commit).toHaveBeenCalledTimes(1);
    expect(sync.write.mock.calls.map(([message]) => message.value?.id).sort()).toEqual(ids.slice(0, 250));
    cleanup();
  });

  it(`does not let an earlier load's commit override a later load's response`, async () => {
    const svc = service();
    const [older, newer] = [Promise.withResolvers<Array<Row>>(), Promise.withResolvers<Array<Row>>()];
    svc.getFullList.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const { loadSubset, cleanup, sync } = startOnDemand(svc);

    const first = loadSubset(whereData(`open`));
    const second = loadSubset({});
    older.resolve([{ id: `a`, data: `open`, updated: `1` }]);
    await first;
    newer.resolve([{ id: `a`, data: `open`, updated: `2` }]);
    await second;

    expect(writesOf(sync.write, `a`).at(-1)?.value?.updated).toBe(`2`);
    cleanup();
  });

  it(`does not restore the rows of a subset released while an older refetch was in flight`, async () => {
    const svc = service();
    svc.records.set(`a1`, { id: `a1`, data: `a` });
    svc.records.set(`b1`, { id: `b1`, data: `b` });
    const { loadSubset, unloadSubset, cleanup, sync, refetch } = startOnDemand(svc);
    const [subsetA, subsetB] = [whereData(`a`), whereData(`b`)];
    await loadSubset(subsetA);
    await loadSubset(subsetB);

    const [slowA, slowB] = [Promise.withResolvers<Array<Row>>(), Promise.withResolvers<Array<Row>>()];
    svc.getFullList.mockImplementationOnce(() => slowA.promise).mockImplementationOnce(() => slowB.promise);
    const olderRefetch = refetch();
    unloadSubset(subsetB);
    await refetch();
    expect(writesOf(sync.write, `b1`).at(-1)?.type).toBe(`delete`);

    // A row created on the server for the released subset must not be installed either
    slowA.resolve([{ id: `a1`, data: `a` }]);
    slowB.resolve([
      { id: `b1`, data: `b` },
      { id: `b2`, data: `b` },
    ]);
    await olderRefetch;
    expect(writesOf(sync.write, `b1`).at(-1)?.type).toBe(`delete`);
    expect(writesOf(sync.write, `b2`)).toEqual([]);
    cleanup();
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

describe(`on-demand live queries`, () => {
  const onDemand = (svc: FakeRecordService, extra: Record<string, unknown> = {}) => collectionFor(svc, { syncMode: `on-demand`, autoIndex: `eager`, defaultIndexType: BasicIndex, ...extra });

  it(`loads the next pages after the cursor instead of reloading the previous ones`, async () => {
    const svc = service();
    for (let i = 0; i < 100; i++) {
      const id = `r${String(i).padStart(3, `0`)}`;
      svc.records.set(id, { id, data: `x`, created: `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, `0`)}:${String(i % 60).padStart(2, `0`)}.000Z` });
    }
    const rows = onDemand(svc);
    const latest = createLiveQueryCollection((q) =>
      q
        .from({ row: rows })
        .orderBy(({ row }) => row.created, `desc`)
        .limit(10),
    );
    await latest.preload();
    for (const limit of [20, 30]) {
      await latest.utils.setWindow({ offset: 0, limit });
      await tick();
    }

    expect(latest.toArray.map(({ id }) => id)).toEqual(Array.from({ length: 30 }, (_, i) => `r${String(99 - i).padStart(3, `0`)}`));
    // Each page asks for 10 rows after the cursor; TanStack DB loads the rows equal to the cursor separately
    expect(svc.getList.mock.calls.map(([page, perPage]) => [page, perPage])).toEqual([
      [1, 10],
      [1, 10],
      [1, 10],
    ]);
    expect(svc.getFullList.mock.calls.every(([options]) => options?.filter?.startsWith(`created = `))).toBe(true);
    expect(rows.size).toBe(30);
  });

  it(`refetch reloads the subsets of active live queries instead of the whole collection`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open` });
    svc.records.set(`b`, { id: `b`, data: `closed` });
    const rows = onDemand(svc);
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    await open.preload();
    expect(rows.get(`a`)).toBeDefined();

    svc.records.delete(`a`);
    svc.records.set(`c`, { id: `c`, data: `open` });
    await rows.utils.refetch();

    expect(rows.get(`a`)).toBeUndefined();
    expect(rows.get(`c`)?.data).toBe(`open`);
    expect(rows.get(`b`)).toBeUndefined();
    expect(svc.getFullList.mock.calls.map(([options]) => options?.filter)).toEqual([`data = 'open'`, `data = 'open'`]);
  });

  it(`refetch keeps an ordered, limited query bounded instead of loading the full source`, async () => {
    const svc = service();
    for (let i = 0; i < 50; i++) {
      const id = `r${String(i).padStart(3, `0`)}`;
      svc.records.set(id, { id, data: `x`, created: `2026-01-01 00:00:${String(i).padStart(2, `0`)}.000Z` });
    }
    const rows = onDemand(svc);
    const latest = createLiveQueryCollection((q) =>
      q
        .from({ row: rows })
        .orderBy(({ row }) => row.created, `desc`)
        .limit(10),
    );
    await latest.preload();
    svc.records.set(`r049`, { ...(svc.records.get(`r049`) as Row), data: `changed` });
    svc.getList.mockClear();
    svc.getFullList.mockClear();

    await rows.utils.refetch();
    await tick();

    // Only the active subsets are replayed: the first page and the rows equal to its boundary
    expect(svc.getList.mock.calls.map(([page, perPage, options]) => [page, perPage, options?.filter])).toEqual([[1, 10, undefined]]);
    expect(svc.getFullList.mock.calls.map(([options]) => options?.filter)).toEqual([`created = '2026-01-01 00:00:40.000Z'`]);
    expect(latest.toArray[0]?.data).toBe(`changed`);
    expect(rows.size).toBe(10);
  });

  it(`does not write back a row deleted while its load was in flight`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open` });
    const response = Promise.withResolvers<Array<Row>>();
    svc.getFullList.mockImplementationOnce(() => response.promise);
    const rows = onDemand(svc);
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    const loading = open.preload();
    await tick();

    svc.emit(`delete`, { id: `a`, data: `open` });
    await tick();
    response.resolve([{ id: `a`, data: `open` }]);
    await loading;
    await tick();

    expect(rows.get(`a`)).toBeUndefined();
  });

  it(`with realtimeScope 'loaded', applies an update received while the load that returns the row was in flight`, async () => {
    const svc = service();
    const response = Promise.withResolvers<Array<Row>>();
    svc.getFullList.mockImplementationOnce(() => response.promise);
    const rows = onDemand(svc, { realtimeScope: `loaded` });
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    const loading = open.preload();
    await tick();

    // Dropped by the realtime filter: the key is not loaded yet and the new value does not match the subset
    svc.emit(`update`, { id: `a`, data: `closed` });
    await tick();
    response.resolve([{ id: `a`, data: `open` }]);
    await loading;
    await tick();

    expect(rows.get(`a`)?.data).toBe(`closed`);
    expect(open.toArray).toEqual([]);
  });

  it(`does not let a load that started before a refetch overwrite the refetched state`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open` });
    svc.records.set(`b`, { id: `b`, data: `open`, updated: `1` });
    const stale = Promise.withResolvers<Array<Row>>();
    svc.getFullList.mockImplementationOnce(() => stale.promise);
    const rows = onDemand(svc);
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    const loading = open.preload();
    await tick();

    // Changes missed by realtime, repaired by the refetch while the first load is still in flight
    svc.records.delete(`a`);
    svc.records.set(`b`, { id: `b`, data: `open`, updated: `2` });
    await rows.utils.refetch();
    stale.resolve([
      { id: `a`, data: `open` },
      { id: `b`, data: `open`, updated: `1` },
    ]);
    await loading;
    await tick();

    expect(rows.get(`a`)).toBeUndefined();
    expect(rows.get(`b`)?.updated).toBe(`2`);
  });

  it(`applies every realtime event by default`, async () => {
    const svc = service();
    const rows = onDemand(svc);
    await rows.stateWhenReady();
    svc.emit(`create`, { id: `x`, data: `anything` });
    await tick();
    expect(rows.get(`x`)).toBeDefined();
  });

  it(`with realtimeScope 'loaded', applies only the events of loaded records or of records matching an active subset`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open` });
    const rows = onDemand(svc, { realtimeScope: `loaded` });
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    await open.preload();

    svc.emit(`create`, { id: `closed`, data: `closed` });
    svc.emit(`create`, { id: `new`, data: `open` });
    svc.emit(`update`, { id: `a`, data: `closed` });
    await tick();
    expect(rows.get(`closed`)).toBeUndefined();
    expect(rows.get(`new`)?.data).toBe(`open`);
    expect(rows.get(`a`)?.data).toBe(`closed`);

    // The server response of a local write is applied even outside every subset, so the optimistic row settles
    const id = rows.utils.newId();
    await rows.insert({ id, data: `draft` }).isPersisted.promise;
    await tick();
    expect((rows.get(id) as { $synced?: boolean } | undefined)?.$synced).toBe(true);

    await open.cleanup();
    svc.emit(`create`, { id: `late`, data: `open` });
    await tick();
    expect(rows.get(`late`)).toBeUndefined();
  });

  it(`does not let an event buffered before a load restore its older value after the load commits`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open`, updated: `2` });
    const rows = onDemand(svc, { batchDelay: 30 });
    await rows.stateWhenReady();
    svc.emit(`update`, { id: `a`, data: `open`, updated: `1` });

    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    await open.preload();
    await sleep(60);

    expect(rows.get(`a`)?.updated).toBe(`2`);
  });

  it(`refetch drops an upsert buffered before it for a row no active subset returns`, async () => {
    const svc = service();
    svc.records.set(`a`, { id: `a`, data: `open` });
    const rows = onDemand(svc, { batchDelay: 30 });
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    await open.preload();

    // Created then deleted on the server; the delete event was missed and the refetch repairs it
    svc.emit(`create`, { id: `x`, data: `open` });
    await rows.utils.refetch();
    await sleep(60);

    expect(rows.get(`x`)).toBeUndefined();
    expect(open.toArray.map(({ id }) => id)).toEqual([`a`]);
  });

  it(`still settles the optimistic row of a mutation whose buffered response a refetch drops`, async () => {
    const svc = service();
    svc.echoRealtime = false;
    svc.records.set(`a`, { id: `a`, data: `open` });
    const rows = onDemand(svc, { batchDelay: 30 });
    const open = createLiveQueryCollection((q) => q.from({ row: rows }).where(({ row }) => eq(row.data, `open`)));
    await open.preload();

    const id = rows.utils.newId();
    const tx = rows.insert({ id, data: `draft` });
    await tx.isPersisted.promise;
    await rows.utils.refetch();
    await sleep(60);

    // The draft matches no active subset, so the refetch removes it like any uncovered row, without leaving it optimistic
    expect(rows.get(id)).toBeUndefined();
    expect(rows.size).toBe(1);
  });
});
