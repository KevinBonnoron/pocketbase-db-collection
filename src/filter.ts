import type { LoadSubsetOptions } from '@tanstack/db';

type BasicExpression = NonNullable<LoadSubsetOptions['where']>;
type OrderBy = NonNullable<LoadSubsetOptions['orderBy']>;

export type FilterBinder = (raw: string, params: Record<string, unknown>) => string;

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

function fieldPath(expr: BasicExpression): string {
  if (expr.type !== `ref`) {
    throw new UnsupportedFilterError(`expected a field reference, got ${expr.type}`);
  }
  const path = expr.path.length > 1 ? expr.path.slice(1) : expr.path;
  if (path.length === 0) {
    throw new UnsupportedFilterError(`empty field reference`);
  }
  return path.join(`.`);
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
  /** False when the PocketBase filter matches a superset of the expression: `~` is case-insensitive and wraps a pattern without `%` in `%…%`. */
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
      return `(${list.map((value) => `${path} ${operator} ${this.bind(value)}`).join(joiner)})`;
    }

    const operator = negated ? NEGATED_COMPARISONS[name] : COMPARISONS[name];
    if (!operator) {
      throw new UnsupportedFilterError(`${negated ? `negated ` : ``}function ${name}`);
    }

    const [left, right] = args;
    if (!left || !right) {
      throw new UnsupportedFilterError(`${name} without two operands`);
    }

    if (left.type === `ref`) {
      const value = literal(right);
      this.trackLikeExactness(name, value);
      return `${fieldPath(left)} ${operator} ${this.bind(value)}`;
    }
    if (right.type === `ref`) {
      if (name === `like` || name === `ilike`) {
        throw new UnsupportedFilterError(`${name} with the pattern on the field side`);
      }
      const flipped: Record<string, string> = { '>': `<`, '>=': `<=`, '<': `>`, '<=': `>=` };
      const value = literal(left);
      this.trackLikeExactness(name, value);
      return `${fieldPath(right)} ${flipped[operator] ?? operator} ${this.bind(value)}`;
    }
    throw new UnsupportedFilterError(`${name} between two literals`);
  }

  private trackLikeExactness(name: string, pattern: unknown) {
    if (name === `ilike` && typeof pattern === `string` && /[^\p{ASCII}]/u.test(pattern)) {
      throw new UnsupportedFilterError(`ilike with a non-ASCII pattern (PocketBase ~ folds case for ASCII only)`);
    }
    if (name === `like` || (name === `ilike` && !(typeof pattern === `string` && pattern.includes(`%`)))) {
      this.exact = false;
    }
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

export interface SubsetRequest {
  filter?: string;
  sort?: string;
  perPage?: number;
}

export function buildSubsetRequest(options: LoadSubsetOptions, baseFilter: string | undefined, baseSort: string | undefined, bind?: FilterBinder): SubsetRequest {
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

  const compiled = attempt(() => compileWhereWithExactness(options.where, bind ?? defaultBinder));
  const where = compiled?.filter;
  exact &&= compiled?.exact ?? true;
  const sort = attempt(() => compileSort(options.orderBy)) ?? baseSort;
  const perPage = exact && options.limit !== undefined ? options.limit + (options.offset ?? 0) : undefined;

  return {
    filter: combineFilters(baseFilter, where),
    sort,
    perPage,
  };
}
