#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
tools_dir="$(mktemp -d)"
trap 'rm -rf "$tools_dir"' EXIT
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform=linux_amd64
    checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    ;;
  Darwin-arm64)
    platform=darwin_arm64
    checksum=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
    ;;
  *) echo 'Run workflow validation on Linux x64 or macOS ARM64.' >&2; exit 1 ;;
esac
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_${platform}.tar.gz" \
  --output "$tools_dir/actionlint.tar.gz"
actual="$(shasum -a 256 "$tools_dir/actionlint.tar.gz" | cut -d ' ' -f 1)"
test "$actual" = "$checksum"
tar -xzf "$tools_dir/actionlint.tar.gz" -C "$tools_dir" actionlint
"$tools_dir/actionlint" -color
