import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface MergeOptions {
  clone?: boolean;
  arrayMerge?: (target: unknown[], source: unknown[]) => unknown[];
  customMerge?: (key: string | symbol) =>
    | ((target: unknown, source: unknown) => unknown)
    | undefined;
  isMergeableObject?: (value: unknown) => boolean;
}

interface DeepMerge {
  (target: unknown, source: unknown, options?: MergeOptions): unknown;
  all(objects: unknown[], options?: MergeOptions): unknown;
}

const require = createRequire(import.meta.url);
const deepmerge = require('../../../vendor/deepmerge/index.cjs') as DeepMerge;

describe('patched deepmerge', () => {
  it.each(['target', 'source'] as const)('does not copy prototype keys from the %s', (side) => {
    const poisoned = JSON.parse('{"__proto__":{"polluted":"inherited"},"safe":true}');
    const result = deepmerge(side === 'target' ? poisoned : {}, side === 'source' ? poisoned : {}) as
      Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(result.polluted).toBeUndefined();
    expect(result.safe).toBe(true);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it.each(['target', 'source'] as const)('filters nested constructor and prototype keys from the %s', (side) => {
    const poisoned = JSON.parse(
      '{"nested":{"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"__proto__":{"polluted":true},"safe":"kept"}}',
    );
    const result = deepmerge(side === 'target' ? poisoned : {}, side === 'source' ? poisoned : {}) as
      { nested: Record<string, unknown> };

    expect(result.nested).toEqual({ safe: 'kept' });
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(result.nested, key)).toBe(false);
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('also rejects unsafe source keys when the target already owns them', () => {
    const target = JSON.parse('{"__proto__":{},"constructor":{},"prototype":{}}');
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}',
    );
    const result = deepmerge(target, source);

    expect(result).toEqual({});
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('filters dangerous keys in array elements while preserving symbols with similar names', () => {
    const symbol = Symbol('__proto__');
    const poisoned = JSON.parse('{"__proto__":{"polluted":true},"safe":true}');
    poisoned[symbol] = 'symbol value';
    const result = deepmerge([poisoned], [poisoned]) as Array<Record<PropertyKey, unknown>>;

    expect(result).toHaveLength(2);
    for (const element of result) {
      expect(Object.getPrototypeOf(element)).toBe(Object.prototype);
      expect(element.polluted).toBeUndefined();
      expect(element[symbol]).toBe('symbol value');
      expect(element.safe).toBe(true);
    }
  });

  it('merges normal nested objects, arrays and enumerable symbols without mutating inputs', () => {
    const symbol = Symbol('metadata');
    const target = { nested: { first: 1 }, list: [{ left: true }], [symbol]: { left: true } };
    const source = { nested: { second: 2 }, list: [{ right: true }], [symbol]: { right: true } };

    expect(deepmerge(target, source)).toEqual({
      nested: { first: 1, second: 2 },
      list: [{ left: true }, { right: true }],
      [symbol]: { left: true, right: true },
    });
    expect(target.nested).toEqual({ first: 1 });
    expect(source.nested).toEqual({ second: 2 });
    const result = deepmerge(target, source) as typeof target;
    expect(result.list[0]).not.toBe(target.list[0]);
  });

  it('preserves arrayMerge, customMerge and clone options and the all helper', () => {
    expect(deepmerge([1], [2], { arrayMerge: (_target, source) => source })).toEqual([2]);
    expect(deepmerge({ value: { a: 1 } }, { value: { b: 2 } }, {
      customMerge: (key) => key === 'value' ? () => ({ customized: true }) : undefined,
    })).toEqual({ value: { customized: true } });
    const nested = { unchanged: true };
    expect((deepmerge({}, { nested }, { clone: false }) as { nested: object }).nested).toBe(nested);
    expect(deepmerge.all([{ a: 1 }, { b: 2 }, { a: 3 }])).toEqual({ a: 3, b: 2 });
  });

  it('preserves custom mergeability, special objects and mismatched array handling', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const expression = /names/u;
    const result = deepmerge({ date, expression }, {}) as { date: Date; expression: RegExp };
    expect(result.date).toBe(date);
    expect(result.expression).toBe(expression);
    expect(deepmerge({ ignored: true }, [{ nested: true }])).toEqual([{ nested: true }]);
    expect(deepmerge({ value: { a: 1 } }, { value: { b: 2 } }, {
      isMergeableObject: (value) => typeof value === 'object' && value !== null && !('a' in value),
    })).toEqual({ value: { b: 2 } });
  });
});
