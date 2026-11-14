#!/usr/bin/env bash
# Builds both contracts to res/settlement.wasm and res/test_usdc.wasm.
#
#   ./build.sh            (from contracts-near/, or from anywhere)
#
# Toolchain: Rust 1.86.0 from rust-toolchain.toml, target wasm32-unknown-unknown.
# Flags: the release profile in Cargo.toml (opt-level "z", lto, codegen-units 1, panic abort,
# overflow checks) plus .cargo/config.toml's wasm rustflags: -C link-arg=-s -C target-cpu=mvp.
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    # Windows with the GNU toolchain: hide any system MinGW gcc so rustc links build scripts
    # with the MinGW bundled with Rust (an SJLJ gcc on PATH cannot link Rust's std).
    clean_path=""
    IFS=':' read -ra path_parts <<< "$PATH"
    for dir in "${path_parts[@]}"; do
      if [ -e "$dir/x86_64-w64-mingw32-gcc.exe" ] || [ -e "$dir/gcc.exe" ]; then
        continue
      fi
      clean_path="${clean_path:+$clean_path:}$dir"
    done
    export PATH="$clean_path"
    ;;
esac

cargo build --target wasm32-unknown-unknown --release

mkdir -p res
cp target/wasm32-unknown-unknown/release/globalpay_settlement.wasm res/settlement.wasm
cp target/wasm32-unknown-unknown/release/globalpay_test_usdc.wasm res/test_usdc.wasm
ls -l res/*.wasm
