/**
 * Minimal type shim for `@sqlite.org/sqlite-wasm`. The upstream package
 * doesn't ship `.d.ts` files; we wrap it in `lib/search/opfsAdapter.ts`
 * so consumers never see this surface — keeping the types `any`-ish
 * here is fine and keeps tsc unblocked.
 */
declare module '@sqlite.org/sqlite-wasm' {
  interface Sqlite3InitOpts {
    print?: (...args: unknown[]) => void;
    printErr?: (...args: unknown[]) => void;
    [k: string]: unknown;
  }

  interface Sqlite3DbConstructor {
    new (path: string, flags?: string): {
      exec: (opts: unknown) => unknown;
      close: () => void;
    };
  }

  interface Sqlite3Module {
    oo1?: {
      DB?: Sqlite3DbConstructor;
      OpfsDb?: Sqlite3DbConstructor;
    };
    [k: string]: unknown;
  }

  type Sqlite3InitFn = (opts?: Sqlite3InitOpts) => Promise<Sqlite3Module>;

  const initModule: Sqlite3InitFn;
  export default initModule;
}
