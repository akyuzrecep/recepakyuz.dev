#!/bin/sh
# {{.Host}}{{.Path}} — adds the SSH keys to ~/.ssh/authorized_keys.
# Leaves existing lines and their order alone; only adds missing keys.
set -eu
dir="$HOME/.ssh"
file="$dir/authorized_keys"
mkdir -p "$dir"
chmod 700 "$dir"
touch "$file"
chmod 600 "$file"
# add a newline if the file doesn't end with one, otherwise the first key sticks to the last line
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

echo "✓ {{.Host}}{{.Path}}: $added key(s) added, $skipped already present → $file"
