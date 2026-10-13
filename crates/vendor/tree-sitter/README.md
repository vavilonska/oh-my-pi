# tree-sitter (vendored)

Vendored copy of [tree-sitter](https://github.com/tree-sitter/tree-sitter)
0.25.10, the crates.io release built from upstream commit
`da6fe9beb4f7f67beb75914ca8e0d48ae48d6406` (`lib/`). The workspace
`Cargo.toml` routes every registry consumer here through `[patch.crates-io]`.
The version, Rust parsing API, grammar ABI and `wasm` feature are unchanged.
MIT licensed; `LICENSE` is copied from that exact upstream commit.

## Local changes

- `Cargo.toml`: `publish = false`; the optional Wasmtime C API dependency is
  pinned to `=36.0.7` instead of `29.0.1`. This is the minimum supported
  Wasmtime patch covering fork Dependabot alerts #1–14. The workspace lock
  pins its complete runtime family to 36.0.7. The upstream generated-manifest
  preamble, `Cargo.toml.orig`, crate-local `Cargo.lock` and VCS metadata are
  dropped; the root manifest and lock are authoritative.
- `src/wasm_store.c`: Wasmtime 36 represents a function's private handle as a
  pointer, not the old 32-bit integer. Builtin callbacks and stdlib exports
  now retain complete `wasmtime_func_t` handles from the public C API rather
  than truncate or reconstruct private IDs. Lexer function-table indices
  remain the same 32-bit values in guest memory. Missing functions use the
  documented null-handle `store_id == 0` representation. No engine settings
  or sandbox features are disabled.
- `BUILD.bazel` and `rustfmt.toml`: workspace build wiring and the usual
  vendored-code formatting exclusion. The Bazel build script consumes
  Wasmtime's header-install metadata; registry ast-grep and first-party
  consumers use this same tree-sitter target.

All other parser source files are unchanged from the 0.25.10 registry release.

## Maintenance

Keep the exact tree-sitter version until all consumers can move together to
an upstream release using a patched Wasmtime. Do not update only the root
`tree-sitter` constraint: ast-grep 0.39 also requires the 0.25 API and must not
resolve a second runtime. Remove this directory, its workspace membership,
`[patch.crates-io]` entry and Bazel dependency wiring once that migration is
complete.

After a Wasmtime update, regenerate the Cargo and Bazel locks and run the
real WASM regression from the workspace root:

```sh
cargo test -p pi-ast wasm_grammar_parses_once_its_module_is_installed --locked
```

That test loads `crates/pi-ast/src/language/testdata/ini.wasm`, checks summary
parsing and matches an AST pattern. Native grammar stand-ins in other tests
do not exercise the Wasmtime adapter. Also build the production native addon
and exercise its INI summary/AST calls before shipping.
