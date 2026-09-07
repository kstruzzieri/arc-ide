#!/bin/sh

set -eu

if [ "$#" -ne 5 ]; then
	echo "usage: $0 <tag> <changelog> <output> <package.json> <config.yml>" >&2
	exit 2
fi

tag=$1
changelog=$2
output=$3
package_json=$4
config_yml=$5
version=${tag#v}
base_version=${version%%-*}
header_prefix="## [$base_version] - "

header=$(awk -v prefix="$header_prefix" 'index($0, prefix) == 1 { print; exit }' "$changelog")
if [ -z "$header" ]; then
	echo "No curated changelog section found for $base_version" >&2
	exit 1
fi

package_version=$(awk -F'"' '$2 == "version" { print $4; exit }' "$package_json")
if [ "$package_version" != "$base_version" ]; then
	echo "package version $package_version does not match tag $tag" >&2
	exit 1
fi

# wails3 stamps build/config.yml info.version into the packaged binaries
# (Info.plist / Windows file version); guard it so a release cannot ship apps
# advertising a stale version. The awk reads `version:` only inside the `info:`
# block, so the top-level `version: '3'` schema marker is not matched.
wails_version=$(awk '/^info:/{in_info=1; next} in_info && /^[^ ]/{in_info=0} in_info && $1=="version:"{gsub(/["'"'"']/,"",$2); print $2; exit}' "$config_yml")
if [ "$wails_version" != "$base_version" ]; then
	echo "config.yml info.version $wails_version does not match tag $tag" >&2
	exit 1
fi

release_date=${header#"$header_prefix"}
if [ "$version" = "$base_version" ] && ! printf '%s\n' "$release_date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
	echo "replace Pending with the release date before tagging $tag" >&2
	exit 1
fi

awk -v target="$header" '
	$0 == target { in_section = 1; next }
	in_section && index($0, "## [") == 1 { exit }
	in_section { print }
' "$changelog" > "$output"

if ! grep -q '[^[:space:]]' "$output"; then
	echo "Curated changelog section for $base_version is empty" >&2
	exit 1
fi
