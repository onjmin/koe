# jpreprocess Wasm と naist-jdic 辞書ファイルを demo/utautts/jpreprocess_wasm/ に生成する。
#
#   1. `--features bundled-dict` で cargo check し、jpreprocess-naist-jdic の build.rs に
#      辞書 (prebuilt tarball) を target/ 配下へ展開させる
#   2. 展開された 8 ファイルを gzip して naist-jdic/*.gz として配置する
#   3. 辞書を含まない本体 Wasm をビルドし wasm-bindgen で JS グルーを生成する
#
# 出力: jpreprocess_wasm.js / jpreprocess_wasm_bg.wasm / naist-jdic/{metadata.json,...}.gz
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$out = Join-Path $PSScriptRoot "..\..\demo\utautts\jpreprocess_wasm"
$target = "wasm32-unknown-unknown"

cargo check --release --target $target --features bundled-dict
$dictDir = Get-ChildItem -Path "target\$target\release\build" -Directory -Filter "jpreprocess-naist-jdic-*" |
    ForEach-Object { Join-Path $_.FullName "out\naist-jdic" } |
    Where-Object { Test-Path (Join-Path $_ "dict.da") } |
    Select-Object -First 1
if (-not $dictDir) { throw "naist-jdic dictionary was not produced under target/" }

New-Item -ItemType Directory -Force (Join-Path $out "naist-jdic") | Out-Null
foreach ($name in @("metadata.json", "char_def.bin", "matrix.mtx", "dict.da", "dict.vals", "unk.bin", "dict.wordsidx", "dict.words")) {
    $src = Join-Path $dictDir $name
    $dst = Join-Path $out "naist-jdic\$name.gz"
    $in = [System.IO.File]::OpenRead($src)
    $outStream = [System.IO.File]::Create($dst)
    $gz = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionLevel]::Optimal)
    $in.CopyTo($gz); $gz.Dispose(); $outStream.Dispose(); $in.Dispose()
    Write-Host ("{0,-16} {1,10:N0} -> {2,10:N0} bytes" -f $name, (Get-Item $src).Length, (Get-Item $dst).Length)
}

cargo build --release --target $target
wasm-bindgen "target\$target\release\jpreprocess_wasm.wasm" --out-dir $out --target web
Write-Host ("jpreprocess_wasm_bg.wasm {0:N0} bytes" -f (Get-Item (Join-Path $out "jpreprocess_wasm_bg.wasm")).Length)
