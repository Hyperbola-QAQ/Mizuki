# Cluster deployment candidate — not ready to apply

These manifests only capture the current service shape. They intentionally refer to invalid image names and to Secrets and PVCs that are not created here. They do not change the existing `mizuki` Deployment, Service, HTTPRoutes or production traffic. They are not an Ansible deployment entrypoint.

Before integration into `/home/hyperbola/Work/ansible-debian-k8s` and any apply:

1. Use the existing SSH user kubeconfig on `imini` for read-only cluster checks; do not copy or print it. A fresh observation on 2026-10-30 found three Ready nodes, Mizuki 2/2, both routes accepted with resolved references, and CNPG 3/3 healthy. The formal Ansible inventory still requires a Vault credential not yet found. Recheck state and schedulable capacity at deployment time.
2. Build and test the SSR and CMS images and select a compatible pinned Meilisearch image. Mirror through the configured domestic/cluster registry first and retain immutable digests. Confirm actual runtime env contracts, UID/GID, writable paths and dependency-aware readiness; TCP readiness here proves only that a port accepts connections.
3. Provision a dedicated Strapi PostgreSQL database and restricted role through the cluster's managed mechanism; never reuse a database that belongs to another application. Put `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_SSL`, `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY` and `MEILI_ADMIN_KEY` in the protected `shirone-cms` Secret. The actual CMS config is authoritative.
4. Prepare `shirone-uploads` and `shirone-search` PVCs with verified permissions and recovery; choose the storage provider based on Meilisearch's supported filesystem semantics. Existing `nfs-ha` is asynchronous and its default reclaim policy deletes data; neither replication nor `Retain` substitutes for verified backups. Meilisearch is a rebuildable index, but Strapi uploads and PostgreSQL are primary data and require a tested restore.
5. Create `shirone-search` Secret containing `MEILI_MASTER_KEY` and `shirone-ssr` Secret containing `STRAPI_API_TOKEN` and a search-only `MEILI_SEARCH_KEY`. Finalize server-only search access and least-privilege keys; do not expose the master key to browsers. Verify access control and network policies, and decide the secured CMS admin entrypoint before adding a route.
6. Add a narrow managed Ansible entrypoint, syntax-check and preview it; validate uploads, publication, search synchronization and restart/restore without touching production routes. Inspect the existing route and certificate. Only then switch the `mizuki` service/HTTPRoutes to the verified SSR backend, preserving tested rollback to the existing nginx Deployment and content PVC. Check route Accepted and ResolvedRefs, actual page body and assets, not HTTP status alone.

The currently archived `k8s/httproute.yaml` references the shared Higress gateway and `mizuki` Service; runtime state and source may have changed. Do not apply archived resources blindly.

## Read-only Ansible preview

`preview_shirone.yml` was prepared at the cluster's Ansible source directory. Its default target is `bootstrap_control_plane`; it reads this project's candidate manifest from the `SHIRONE_WORKSPACE` environment variable, checks the expected namespace and kubeconfig path, and only sends `kubectl apply --server-side --dry-run=server`. It has no production apply path.

The standard inventory currently requires an unavailable Vault secret. A read-only validation was run using the existing SSH user's kubeconfig and a single-host inventory, reading the source playbook from stdin to avoid loading the unrelated Vault-protected inventory variables:

```sh
SHIRONE_WORKSPACE="$PWD" ansible-playbook -i 'imini,' -u hyperbola \
  -e shirone_preview_hosts=imini --check /dev/stdin \
  < /home/hyperbola/Work/ansible-debian-k8s/preview_shirone.yml
```

The preview returned 4 ok and 0 changed. This only validates the current candidate schema and admission; it does not validate images, readiness, secrets, storage, quotas, service connectivity, or rollout. Its placeholder images and missing Secrets/PVCs intentionally prevent deployment.

The CMS image was built locally with the existing internal Node 22 image and the configured domestic npm mirror. A disposable internal-only Docker network and temporary PostgreSQL instance produced an HTTP 204 from CMS `/_health`; the containers and network were removed afterwards. No production database or cluster resources were modified, and the image has not been published. This test did not exercise the admin UI, publication, search, persistent uploads or restart recovery. The current CMS image runs as root, which must be resolved before using NFS UID/GID permissions or the cluster's restricted pod security standards.

## Isolated Meilisearch check

The official `getmeili/meilisearch:v1.55.0` OCI index from DaoCloud and Docker Hub was verified to have the same digest, `sha256:ff546679970126f8822e15d1b6a06bfbff1f2ce2e43f810cfb5258012f92de5c`. An internal-only disposable Docker container from that mirror was used for the CMS search integration check. `deploy/tests/meilisearch-live-check.cjs` exercises index rebuild, Chinese queries, updates, deletion and exclusion of encrypted content using synthetic documents. Run it only against a disposable isolated instance:

```sh
MEILI_DISPOSABLE=yes MEILI_URL=http://DISPOSABLE_HOST:7700 \
  MEILI_ADMIN_KEY=DISPOSABLE_KEY node deploy/tests/meilisearch-live-check.cjs
```

The script creates a uniquely named test index and requests its deletion afterward. It does not exercise Strapi HTTP publication events or failure recovery; those still need end-to-end tests.
