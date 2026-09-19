cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/jpreprocess_wasm.wasm --out-dir ../../demo/utautts/jpreprocess_wasm --target web
