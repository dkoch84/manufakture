#!/usr/bin/env bash
# Run a firmware's own G-code validator on G-code files (M5 plan, T5.4d): `gvalidate` from
# grbl-sim or `grblHAL_validator` from the grblHAL Simulator, built by CI's optional
# `gcode-validate` job. Both read a file through the firmware's parser and exit with the first
# error code (0 when every line parses).
#
# Usage: firmware-validate.sh <validator> <file.nc>...
#
# A line that is exactly `M0` is turned into a comment first: neither validator resumes after a
# program pause (gvalidate waits for a cycle start forever, grblHAL_validator crashes), and M0 is
# a code both firmwares accept. Each file gets 60 seconds. The validators run in a temporary
# directory, since both write an EEPROM.DAT into the current one.

set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <validator> <file.nc>..." >&2
  exit 2
fi
validator=$(realpath "$1")
shift

work=$(mktemp -d) || exit 2
trap 'rm -rf "$work"' EXIT
failed=0
for file in "$@"; do
  sed -E 's/^M0$/(M0 program pause, left out for the validator)/' "$file" > "$work/input.nc"
  out=$(cd "$work" && timeout 60 "$validator" input.nc 2>&1)
  rc=$?
  # Any nonzero exit fails the file, a crash included: grblHAL_validator dies with a segfault
  # (exit 139) on M6, having no tool change handler, and a validator that cannot read a file has
  # not accepted it.
  if [ "$rc" -eq 0 ] && ! grep -qiE '^error|EXITING' <<< "$out"; then
    echo "ok    $file"
  else
    echo "FAIL  $file (exit $rc)"
    tail -n 5 <<< "$out" | sed 's/^/      /'
    failed=1
  fi
done
exit "$failed"
