#!/usr/bin/env bash
# A check: does the built image contain the change under test.
#
# A zero exit code from docker compose build does not prove that the image was
# built from the current sources. Twice in a row conclusions about the behavior
# of the code were drawn from a stand that held the previous image. This check
# runs BEFORE the container is started and before any measurement.
#
#   scripts/verify-image-contains.sh <substring> [path-inside-the-image]
#
# Example:
#   scripts/verify-image-contains.sh open_session_for \
#     /app/tessera_api/services/auth.py
#
# Without the second argument it searches the whole of /app/tessera_api.
#
# The image is set by the IMAGE variable. The name is assembled from the name of
# the set and the name of the service, hence the doubling. The default is the
# application; for the screens use IMAGE=tessera-v2-tessera-v2-web:latest with
# the path /app/apps/web/build, for collaborative editing
# IMAGE=tessera-v2-tessera-v2-collab:latest with the path
# /app/services/collab/src.
#
# In the application image the sources lie as they are, so the substring to
# search for is the same as in the file. The screens image carries a build, and
# the bundler rewrites the source: there, pick a substring that survives the
# build — a string literal, an object key name.

set -euo pipefail

IMAGE="${IMAGE:-tessera-v2-tessera-v2-api:latest}"
NEEDLE="${1:-}"
TARGET="${2:-/app/tessera_api}"

if [ -z "$NEEDLE" ]; then
  echo "Usage: $0 <substring> [path-inside-the-image]" >&2
  exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "IMAGE NOT FOUND: $IMAGE" >&2
  exit 1
fi

built=$(docker image inspect "$IMAGE" --format '{{.Created}}')
found=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -rc -- '$NEEDLE' '$TARGET' 2>/dev/null | awk -F: '{s+=\$NF} END {print s+0}'")

echo "image:   $IMAGE (built $built)"
echo "path:    $TARGET"
echo "needle:  $NEEDLE"
echo "found:   $found"

if [ "$found" -eq 0 ]; then
  echo
  echo "THE CHANGE IS NOT IN THE IMAGE. No conclusions may be drawn from the stand." >&2
  echo "Rebuild, and on a repeat build with --no-cache." >&2
  exit 1
fi

echo
echo "The change is in the image; the container may be started and measured."
