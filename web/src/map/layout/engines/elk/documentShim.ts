const scope = globalThis as { document?: unknown };

// WORKAROUND: elk.bundled.js treats a scope without `document` as the elk worker script and exports nothing, so the engine cannot be built inside a Web Worker ("_Worker is not a constructor"); defining `document` selects its in-thread branch.
scope.document ??= {};
