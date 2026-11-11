import type { LoadSubsetOptions } from '@tanstack/db';

type BasicExpression = NonNullable<LoadSubsetOptions['where']>;
type OrderBy = NonNullable<LoadSubsetOptions['orderBy']>;

export type FilterBinder = (raw: string, params: Record<string, unknown>) => string;

/** PocketBase rejects a `filter` longer than this many bytes (`search.MaxFilterLength`). */
export const MAX_FILTER_LENGTH = 3500;
/** PocketBase rejects a `filter` with more comparisons than this (`search.DefaultFilterExprLimit`). */
export const MAX_FILTER_EXPRESSIONS = 200;
/** PocketBase silently caps `perPage` at this value (`search.MaxPerPage`). */
export const MAX_PER_PAGE = 1000;

export class UnsupportedFilterError extends Error {
  constructor(detail: string) {
    super(`Cannot translate expression to a PocketBase filter: ${detail}`);
    this.name = `UnsupportedFilterError`;
  }
}

const COMPARISONS: Record<string, string> = {
  eq: `=`,
  gt: `>`,
  gte: `>=`,
  lt: `<`,
  lte: `<=`,
  like: `~`,
  ilike: `~`,
};

const NEGATED_COMPARISONS: Record<string, string> = {
  eq: `!=`,
};

/** TanStack DB passes row-relative paths to `loadSubset` (`['calendar', 'organization']`), never prefixed with the query alias. */
function fieldPath(expr: BasicExpression): string {
  if (expr.type !== `ref`) {
    throw new UnsupportedFilterError(`expected a field reference, got ${expr.type}`);
  }
  if (expr.path.length === 0) {
    throw new UnsupportedFilterError(`empty field reference`);
  }
  return expr.path.join(`.`);
}

function literal(expr: BasicExpression): unknown {
  if (expr.type !== `val`) {
    throw new UnsupportedFilterError(`expected a literal value, got ${expr.type}`);
  }
  return expr.value;
}

function defaultBinder(raw: string, params: Record<string, unknown>): string {
  return raw.replace(/\{:(\w+)\}/g, (_match, name: string) => formatValue(params[name]));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return `null`;
  }
  if (typeof value === `number` || typeof value === `boolean`) {
    return String(value);
  }
  if (value instanceof Date) {
    return `'${value.toISOString().replace(`T`, ` `)}'`;
  }
  return `'${String(value).replace(/\\/g, `\\\\`).replace(/'/g, `\\'`)}'`;
}

class FilterCompiler {
  private counter = 0;
  readonly params: Record<string, unknown> = {};
  /** False when the PocketBase filter matches a superset of the expression (see `likePattern`). */
  exact = true;

  private bind(value: unknown): string {
    const name = `p${this.counter++}`;
    this.params[name] = value;
    return `{:${name}}`;
  }

  compile(expr: BasicExpression, negated = false): string {
    if (expr.type !== `func`) {
      throw new UnsupportedFilterError(`top-level ${expr.type} expression`);
    }

    const { name, args } = expr;

    if (name === `and` || name === `or`) {
      if (negated) {
        throw new UnsupportedFilterError(`negated ${name}`);
      }
      const parts = args.map((arg) => this.compile(arg));
      return `(${parts.join(name === `and` ? ` && ` : ` || `)})`;
    }

    if (name === `not`) {
      const [inner] = args;
      if (!inner) {
        throw new UnsupportedFilterError(`not without operand`);
      }
      return this.compile(inner, !negated);
    }

    if (name === `in`) {
      const [field, values] = args;
      if (!field || !values) {
        throw new UnsupportedFilterError(`in without operands`);
      }
      const list = literal(values);
      if (!Array.isArray(list)) {
        throw new UnsupportedFilterError(`in expects an array literal`);
      }
      if (list.length === 0) {
        return negated ? `1 = 1` : `1 = 0`;
      }
      const path = fieldPath(field);
      const operator = negated ? `!=` : `=`;
      const joiner = negated ? ` && ` : ` || `;
      return `(${Array.from(new Set(list), (value) => `${path} ${operator} ${this.bind(value)}`).join(joiner)})`;
    }

    const operator = negated ? NEGATED_COMPARISONS[name] : COMPARISONS[name];
    if (!operator) {
      throw new UnsupportedFilterError(`${negated ? `negated ` : ``}function ${name}`);
    }

    const [left, right] = args;
    if (!left || !right) {
      throw new UnsupportedFilterError(`${name} without two operands`);
    }

    const isLike = name === `like` || name === `ilike`;
    if (left.type === `ref`) {
      const value = literal(right);
      return `${fieldPath(left)} ${operator} ${this.bind(isLike ? this.likePattern(name, value) : value)}`;
    }
    if (right.type === `ref`) {
      if (isLike) {
        throw new UnsupportedFilterError(`${name} with the pattern on the field side`);
      }
      const flipped: Record<string, string> = { '>': `<`, '>=': `<=`, '<': `>`, '<=': `>=` };
      return `${fieldPath(right)} ${flipped[operator] ?? operator} ${this.bind(literal(left))}`;
    }
    throw new UnsupportedFilterError(`${name} between two literals`);
  }

  /**
   * TanStack DB patterns are anchored, `%` and `_` are wildcards and there is no escape character; `like`
   * is case-sensitive and `ilike` folds case with `toLowerCase()`. PocketBase `~` runs SQLite `LIKE … ESCAPE '\'`,
   * which folds case for ASCII only, and when the pattern has no `%` it escapes `%` and `_` and wraps it in `%…%`.
   * The translated pattern always matches a superset: backslashes are escaped, a pattern without `%` is wrapped
   * here (so `_` stays a wildcard), and for `ilike` every non-ASCII cased letter becomes `%`. Only an `ilike`
   * pattern that needs none of this is exact.
   */
  private likePattern(name: string, pattern: unknown): string {
    if (typeof pattern !== `string`) {
      throw new UnsupportedFilterError(`${name} with a non-string pattern`);
    }
    let exact = name === `ilike`;
    let value = pattern.replace(/\\/g, `\\\\`);
    if (name === `ilike`) {
      const folded = value.replace(/[^\p{ASCII}]/gu, (char) => (char.toLowerCase() === char.toUpperCase() ? char : `%`));
      exact &&= folded === value;
      value = folded;
    }
    if (!value.includes(`%`)) {
      value = `%${value}%`;
      exact = false;
    }
    this.exact &&= exact;
    return value;
  }
}

function compileWhereWithExactness(where: BasicExpression | undefined, bind: FilterBinder): { filter: string | undefined; exact: boolean } {
  if (!where) {
    return { filter: undefined, exact: true };
  }
  const compiler = new FilterCompiler();
  const raw = compiler.compile(where);
  return { filter: bind(raw, compiler.params), exact: compiler.exact };
}

export function compileWhere(where: BasicExpression | undefined, bind: FilterBinder = defaultBinder): string | undefined {
  return compileWhereWithExactness(where, bind).filter;
}

export function compileSort(orderBy: OrderBy | undefined): string | undefined {
  if (!orderBy || orderBy.length === 0) {
    return undefined;
  }
  return orderBy
    .map((clause) => {
      const path = fieldPath(clause.expression);
      return clause.compareOptions.direction === `desc` ? `-${path}` : path;
    })
    .join(`,`);
}

export function combineFilters(...filters: Array<string | undefined>): string | undefined {
  const present = filters.filter((filter): filter is string => Boolean(filter?.trim()));
  if (present.length === 0) {
    return undefined;
  }
  if (present.length === 1) {
    return present[0];
  }
  return present.map((filter) => `(${filter})`).join(` && `);
}

const encoder = new TextEncoder();

/** Counts the comparisons PocketBase would parse, skipping string literals and comments. */
function countExpressions(filter: string): number {
  let count = 0;
  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];
    if (char === `'` || char === `"`) {
      for (i++; i < filter.length && filter[i] !== char; i++) {
        if (filter[i] === `\\`) i++;
      }
    } else if (char === `/` && filter[i + 1] === `/`) {
      while (i < filter.length && filter[i] !== `\n`) i++;
    } else if (char === `=` || char === `~` || char === `<` || char === `>`) {
      count++;
      if (filter[i + 1] === `=`) i++;
    } else if (char === `!` && (filter[i + 1] === `=` || filter[i + 1] === `~`)) {
      count++;
      i++;
    }
  }
  return count;
}

function fitsPocketbaseLimits(filter: string | undefined): boolean {
  return filter === undefined || (encoder.encode(filter).length <= MAX_FILTER_LENGTH && countExpressions(filter) <= MAX_FILTER_EXPRESSIONS);
}

function conjuncts(expr: BasicExpression): Array<BasicExpression> {
  return expr.type === `func` && expr.name === `and` ? expr.args.flatMap(conjuncts) : [expr];
}

function inListLength(expr: BasicExpression): number {
  if (expr.type !== `func` || expr.name !== `in`) return 0;
  const [field, values] = expr.args;
  return field?.type === `ref` && values?.type === `val` && Array.isArray(values.value) ? values.value.length : 0;
}

/**
 * Splits the longest `in` list among the top-level conjuncts of `where` until every filter fits PocketBase's
 * limits. The subset is the union of the parts, which only holds for a conjunct: a negated or nested `in` is
 * never split. Returns undefined when there is nothing to split.
 */
function splitInList(where: BasicExpression, bind: FilterBinder, wrap: (filter: string | undefined) => string | undefined): Array<string | undefined> | undefined {
  const parts = conjuncts(where);
  let index = -1;
  parts.forEach((part, i) => {
    if (inListLength(part) > 1 && (index < 0 || inListLength(part) > inListLength(parts[index] as BasicExpression))) {
      index = i;
    }
  });
  const target = parts[index];
  if (target?.type !== `func`) return undefined;
  const [field, values] = target.args as [BasicExpression, BasicExpression & { value: Array<unknown> }];

  const render = (chunk: Array<unknown>) => {
    const next = parts.slice();
    next[index] = { type: `func`, name: `in`, args: [field, { type: `val`, value: chunk }] } as unknown as BasicExpression;
    const expr = next.length === 1 ? (next[0] as BasicExpression) : ({ type: `func`, name: `and`, args: next } as unknown as BasicExpression);
    return wrap(compileWhereWithExactness(expr, bind).filter);
  };
  const split = (chunk: Array<unknown>): Array<string | undefined> => {
    const filter = render(chunk);
    if (chunk.length <= 1 || fitsPocketbaseLimits(filter)) return [filter];
    const middle = Math.ceil(chunk.length / 2);
    return [...split(chunk.slice(0, middle)), ...split(chunk.slice(middle))];
  };
  return split(Array.from(new Set(values.value)));
}

export interface SubsetRequest {
  /** One PocketBase filter per request. There are several when a large `in` list was split to stay under PocketBase's filter limits; the subset is the union of their results. */
  filters: Array<string | undefined>;
  sort?: string;
  /** Number of records to load from the start of each filter's result; undefined loads them all. */
  perPage?: number;
}

export function buildSubsetRequest(options: LoadSubsetOptions, baseFilter: string | undefined, baseSort: string | undefined, bind: FilterBinder = defaultBinder): SubsetRequest {
  let exact = true;
  const attempt = <T>(compile: () => T): T | undefined => {
    try {
      return compile();
    } catch (error) {
      if (!(error instanceof UnsupportedFilterError)) {
        throw error;
      }
      exact = false;
      return undefined;
    }
  };

  const compiled = attempt(() => compileWhereWithExactness(options.where, bind));
  exact &&= compiled?.exact ?? true;
  const sort = attempt(() => compileSort(options.orderBy)) ?? baseSort;
  const limited = exact && options.limit !== undefined;

  // The cursor (rows strictly after the last loaded value of the single orderBy column) replaces the offset, so a
  // page does not reload the rows before it. TanStack DB loads the rows equal to that value with a separate request.
  let cursor: string | undefined;
  if (limited && options.cursor) {
    try {
      const translated = compileWhereWithExactness(options.cursor.whereFrom, bind);
      cursor = translated.exact ? translated.filter : undefined;
    } catch (error) {
      if (!(error instanceof UnsupportedFilterError)) {
        throw error;
      }
    }
  }
  const perPage = limited ? (options.limit as number) + (cursor ? 0 : (options.offset ?? 0)) : undefined;

  const wrap = (where: string | undefined) => combineFilters(baseFilter, where, cursor);
  const filter = wrap(compiled?.filter);
  const filters = (!fitsPocketbaseLimits(filter) && compiled && options.where && splitInList(options.where, bind, wrap)) || [filter];

  return { filters, sort, perPage };
}
