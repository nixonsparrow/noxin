#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! $1 =~ ^b[0-9]+$ ]]; then
    echo 'Użycie w LXC: bash build-llama.sh TAG PLIK_WYNIKOWY' >&2
    exit 1
fi
version=$1
output=$2
work=$(mktemp -d /opt/noxin-ai/build.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT

git clone --depth 1 --branch "$version" https://github.com/ggml-org/llama.cpp.git "$work/src"
HF_UI_VERSION="$version" cmake -S "$work/src" -B "$work/out" +    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF +    -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=OFF -DGGML_SSE42=ON +    -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF +    -DGGML_LLAMAFILE=OFF -DGGML_BLAS=OFF -DLLAMA_OPENSSL=OFF +    -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=ON
cmake --build "$work/out" --target llama-server --parallel 2
[[ -f $work/out/tools/ui/dist/index.html ]] || { echo "Brak wbudowanego Llama Chat." >&2; exit 1; }
"$work/out/bin/llama-server" --version
install -m 0755 "$work/out/bin/llama-server" "$output"
