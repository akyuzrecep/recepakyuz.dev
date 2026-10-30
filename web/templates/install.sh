#!/bin/sh
# {{.Host}}{{.Path}} — SSH anahtarlarını ~/.ssh/authorized_keys'e ekler.
# Var olan satırlara ve sıralamaya dokunmaz; eksik anahtarı ekler.
set -eu
dir="$HOME/.ssh"
file="$dir/authorized_keys"
mkdir -p "$dir"
chmod 700 "$dir"
touch "$file"
chmod 600 "$file"
# dosya newline ile bitmiyorsa ekle, yoksa ilk anahtar son satıra yapışır
if [ -s "$file" ] && [ "$(tail -c1 "$file")" != "" ]; then echo >> "$file"; fi

added=0
skipped=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  body=$(printf '%s\n' "$line" | cut -d' ' -f2)
  if grep -qF "$body" "$file"; then
    skipped=$((skipped + 1))
  else
    printf '%s\n' "$line" >> "$file"
    added=$((added + 1))
  fi
done <<'__KEYS__'
{{.KeysText}}__KEYS__

echo "✓ {{.Host}}{{.Path}}: $added anahtar eklendi, $skipped zaten vardı → $file"
