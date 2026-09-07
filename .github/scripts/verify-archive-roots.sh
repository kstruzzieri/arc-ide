#!/bin/sh
# Enforces the frozen release artifact contract: asset basenames and archive
# root entries must never change (install.sh and user muscle memory depend
# on them). Usage: verify-archive-roots.sh <artifacts-dir>
set -eu

dir=$1
fail=0

zip_roots() {
  unzip -Z1 "$1" | sed 's#^\./##' | awk -F/ 'NF { print $1 }' | LC_ALL=C sort -u
}

tar_roots() {
  tar -tzf "$1" | sed 's#^\./##' | awk -F/ 'NF { print $1 }' | LC_ALL=C sort -u
}

assert_root() {
  archive=$1
  expected=$2
  kind=$3
  if [ ! -f "$archive" ]; then
    echo "missing artifact: $archive" >&2
    fail=1
    return
  fi
  if [ "$kind" = zip ]; then roots=$(zip_roots "$archive"); else roots=$(tar_roots "$archive"); fi
  if [ "$roots" != "$expected" ]; then
    echo "unexpected archive roots in $archive: $roots (want $expected)" >&2
    fail=1
  fi
}

for z in "$dir"/Firn-macos-arm64/Firn-macos-arm64.zip "$dir"/Firn-macos-amd64/Firn-macos-amd64.zip; do
  assert_root "$z" Firn.app zip
done

t="$dir/Firn-linux-amd64/Firn-linux-amd64.tar.gz"
assert_root "$t" firn tar

w="$dir/Firn-windows-amd64/Firn-windows-amd64.zip"
assert_root "$w" firn.exe zip

exit $fail
