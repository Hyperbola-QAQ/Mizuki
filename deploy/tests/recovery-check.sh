#!/bin/sh
# Synthetic recovery check: local disposable PostgreSQL and synthetic uploads.
# It never contacts a cluster, reads existing databases or accesses existing PVCs.
set -eu
postgres_image=${POSTGRES_TEST_IMAGE:-192.168.86.100:30500/ca-clean/postgresql:18.4-system-trixie}
test_dir=$(mktemp -d /tmp/shirone-recovery-check.XXXXXX)
container_name="shirone-recovery-check-$$"
cleanup() {
  docker stop -t 1 "$container_name" >/dev/null 2>&1 || true
  docker container rm "$container_name" >/dev/null 2>&1 || true
  rm -rf -- "$test_dir"
}
trap cleanup EXIT HUP INT TERM
# Do not implicitly pull an image: use only an already verified local image.
docker image inspect "$postgres_image" >/dev/null
mkdir "$test_dir/uploads" "$test_dir/restored-uploads"
printf 'synthetic upload bytes\n' > "$test_dir/uploads/synthetic.txt"
docker run -d --name "$container_name" --network none \
  --tmpfs /tmp:rw,size=512m,uid=26,gid=26 "$postgres_image" \
  sh -c 'initdb -D /tmp/pgdata -U strapi --auth=trust >/dev/null && exec postgres -D /tmp/pgdata -h ""' >/dev/null
ready=0
for i in $(seq 1 50); do
  if docker exec "$container_name" pg_isready -U strapi -d postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { printf 'isolated PostgreSQL did not become ready\n' >&2; exit 1; }
docker exec "$container_name" createdb -U strapi synthetic_source
docker exec "$container_name" createdb -U strapi synthetic_restore
docker exec "$container_name" psql -X -v ON_ERROR_STOP=1 -U strapi -d synthetic_source \
  -c "CREATE TABLE posts (id integer PRIMARY KEY, body text NOT NULL); INSERT INTO posts VALUES (1, 'synthetic content');" >/dev/null
docker exec "$container_name" pg_dump -U strapi -Fc synthetic_source > "$test_dir/strapi.dump"
[ -s "$test_dir/strapi.dump" ]
docker exec -i "$container_name" pg_restore --exit-on-error -U strapi -d synthetic_restore < "$test_dir/strapi.dump"
restored=$(docker exec "$container_name" psql -X -A -t -U strapi -d synthetic_restore -c 'SELECT body FROM posts WHERE id = 1')
[ "$restored" = 'synthetic content' ] || { printf 'database restore mismatch\n' >&2; exit 1; }
tar -cf "$test_dir/uploads.tar" -C "$test_dir/uploads" synthetic.txt
tar -xf "$test_dir/uploads.tar" -C "$test_dir/restored-uploads"
cmp "$test_dir/uploads/synthetic.txt" "$test_dir/restored-uploads/synthetic.txt"
printf 'Synthetic PostgreSQL dump/restore and upload archive/restore passed.\n'
