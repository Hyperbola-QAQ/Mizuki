# Cluster deployment candidate — not ready to apply

These manifests only capture the current service shape. They intentionally refer to invalid image names and to Secrets and PVCs that are not created here. They do not change the existing `mizuki` Deployment, Service, HTTPRoutes or production traffic. They are not an Ansible deployment entrypoint.

Before integration into `/home/hyperbola/Work/ansible-debian-k8s` and any apply:

1. Use the existing SSH user kubeconfig on `imini` for read-only cluster checks; do not copy or print it. A fresh observation on 2026-10-30 found three Ready nodes, Mizuki 2/2, both routes accepted with resolved references, and CNPG 3/3 healthy. The formal Ansible inventory still requires a Vault credential not yet found. Recheck state and schedulable capacity at deployment time.
2. Build and test the SSR and CMS images and select a compatible pinned Meilisearch image. Mirror through the configured domestic/cluster registry first and retain immutable digests. Confirm actual runtime env contracts, UID/GID, writable paths and dependency-aware readiness; TCP readiness here proves only that a port accepts connections.
3. Provision a dedicated Strapi PostgreSQL database and restricted role through the cluster's managed mechanism; never reuse a database that belongs to another application. Put `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_SSL`, `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY`, `MEILI_ADMIN_KEY` and `INTERNAL_RENDER_TOKEN` in the protected `shirone-cms` Secret. The database username and password come separately from `mizuki/shirone-cms-db`, which must match `databases/shirone-cms-db`; no password is provided by these manifests. The actual CMS config is authoritative.
4. Prepare `shirone-uploads` and `shirone-search` PVCs with verified permissions and recovery; choose the storage provider based on Meilisearch's supported filesystem semantics. Existing `nfs-ha` is asynchronous and its default reclaim policy deletes data; neither replication nor `Retain` substitutes for verified backups. Meilisearch is a rebuildable index, but Strapi uploads and PostgreSQL are primary data and require a tested restore.
5. Create `shirone-search` Secret containing `MEILI_MASTER_KEY` and `shirone-ssr` Secret containing `STRAPI_API_TOKEN`, the matching `INTERNAL_RENDER_TOKEN`, and a search-only `MEILI_SEARCH_KEY`. Finalize server-only search access and least-privilege keys; do not expose the master key to browsers. Verify access control and network policies, and decide the secured CMS admin entrypoint before adding a route.
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

The candidate `database-candidate.yaml` is an operator-managed Database resource for a new `shirone_cms` database on the existing `databases/postgresql` cluster, with the `retain` reclaim policy. Its Kubernetes schema passed a server-side dry-run on 2026-10-30, with no write. The dedicated role, Secret, grants, and database do not yet exist; the cluster's existing `.spec.managed.roles` list was empty at the time of inspection. Adding a role to a shared CNPG Cluster must preserve all existing fields and roles, and requires a reviewed credential and reconciliation procedure; never recreate the Cluster or reuse another application's database.

## Media authorization boundary

Do not expose the CMS service, `/uploads/`, admin, or API through a direct Gateway route. The intended public origin is `https://hyperbola.cc`; the existing site route will send `/uploads/` requests to SSR after cutover. SSR must authorize every request against currently published, non-password-protected content references and return 404 otherwise; unpublish or removal must take effect immediately. Do not cache a positive authorization past content revocation. Validate encoded path traversal, unpublished and encrypted content, unpublish, image rendering and unknown assets using actual CMS data before cutover. This boundary does not itself provide protection until implemented and verified in the SSR application.

## Dedicated PostgreSQL role preview

`deploy/tools/cnpg-role-patch.py` builds a create-only JSON Patch for a `shirone_cms` login role referencing the `databases/shirone-cms-db` Kubernetes basic-auth Secret; it tests the reviewed Cluster UID and freshly read resourceVersion, preserves other managed roles, rejects a pre-existing same-name role, and does not read or output a password. `deploy/ansible/preview-cnpg-role.yml` reads the live Cluster without logging it, builds the patch locally and sends only a server-side dry-run. A corresponding preview entrypoint was added to the Ansible project as `preview_shirone_cnpg_role.yml`; syntax and real API dry-run passed with 5 ok and 0 changed. To repeat, use the reviewed current Cluster UID rather than assuming a previous UID:

```sh
SHIRONE_WORKSPACE="$PWD" ansible-playbook -i 'imini,' -u hyperbola \
  -e shirone_preview_hosts=imini -e shirone_cnpg_uid=REVIEWED_UID \
  --check /dev/stdin < /home/hyperbola/Work/ansible-debian-k8s/preview_shirone_cnpg_role.yml
python -m unittest discover -s deploy/tests -p 'test_cnpg_role_patch.py'
```

This is not a credential provisioning or apply tool. Before any production write, implement and review one protected, recoverable create-only process for the CNPG basic-auth Secret and the matching CMS database credential in `mizuki`; never log or commit the secret, regenerate it after a partial write, or overwrite a pre-existing object. Verify role readiness and privileges before creating the Database CR. A successful dry-run proves schema and current identity checks, not that a role or database exists or that a real connection works.

A separate read-only `deploy/ansible/preview-db-secrets.yml` (also installed as `preview_shirone_db_secrets.yml` in the Ansible project) validated the schemas of immutable `shirone-cms-db` basic-auth Secrets in both namespaces with deliberately invalid synthetic values. Actual server-side dry-run returned 3 ok and 0 changed; it does not create or compare production credentials. The CMS workload references the `username`/`password` keys from the `mizuki` Secret. Both real Secret objects must be generated from the same durable protected source, with matching username and password, before the role or CMS is enabled.
