# Patched deepmerge 4.3.1

This private package vendors the CommonJS distribution from
[`deepmerge@4.3.1`](https://github.com/TehShrike/deepmerge/tree/v4.3.1).
The original `dist/cjs.js` was copied to `index.cjs`, with its MIT license retained
unchanged in `LICENSE`. The original distribution's SHA-256 is
`2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d`.

Its scoped package version `4.3.2` identifies this local patched fork, not an
upstream release, and satisfies the build tool's compatible 4.x dependency range.

The application uses this package through an npm override for the transitive
`deepmerge` dependency used by its build tools.
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
affects upstream versions 4.2.0 through 4.3.1; the advisory listed no patched
upstream version when reviewed on 2026-10-30.

The local patch rejects `__proto__`, `constructor`, and `prototype` keys before
copying target properties and before merging source properties. The check runs
at every recursive merge, including objects inside default array merges. Both
sides require checking: the upstream target-copy loop could assign `__proto__`
and alter the returned object's prototype even when the source was safe.

The remaining implementation is unchanged. Normal object, array, enumerable
symbol, `all`, `arrayMerge`, `customMerge`, `isMergeableObject`, and `clone`
behavior remains available. The three rejected property names are intentionally
not preserved. Custom merge callbacks and `clone: false` retain upstream
semantics: callers remain responsible for objects returned or reused by their
own callbacks/options.

Regression and compatibility tests are in
`apps/server/src/deepmerge.test.ts`. The poisoning tests failed against the
original upstream file before applying this patch. Run them with:

```sh
npx vitest run apps/server/src/deepmerge.test.ts
```

Revisit this override when upstream ships a reviewed fix. Do not replace the
vendored code with an upstream release without rerunning these tests and the
application build.
