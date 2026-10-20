const scope = globalThis as { document?: unknown };

// WORKAROUND: elkjs.bundled treats a scope without `document` as the elk worker script and exports nothing, so the engine cannot be built inside a real Web Worker; defining `document` selects its in-thread branch (observed as "_Worker is not a constructor").
scope.document ??= {};
