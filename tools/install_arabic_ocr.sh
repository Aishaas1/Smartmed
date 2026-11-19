#!/usr/bin/env bash
set -euo pipefail
destination=${1:-data/tessdata}
system_data=${2:-/usr/share/tesseract-ocr/5/tessdata}
mkdir -p "$destination"
temporary=$(mktemp "$destination/.ara.XXXXXX")
trap 'rm -f "$temporary"' EXIT
curl --fail --silent --show-error --location --max-time 60 \
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/ara.traineddata' \
  --output "$temporary"
printf '%s  %s\n' 'e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729' "$temporary" | sha256sum -c
mv "$temporary" "$destination/ara.traineddata"
for language in eng osd; do
  if [[ -f "$system_data/$language.traineddata" &&
        ! "$system_data/$language.traineddata" -ef "$destination/$language.traineddata" ]]; then
    cp "$system_data/$language.traineddata" "$destination/$language.traineddata"
  fi
done
TESSDATA_PREFIX="$destination" tesseract --list-langs
