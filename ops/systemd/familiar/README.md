# ops/systemd/familiar

Host-scoped systemd unit fragments and drop-ins for the `familiar` host
(production palace + inference node, 10.0.6.124).

The actual `/etc/systemd/system/*.service` files on familiar are the source
of truth at runtime. Files here are tracked-in-repo copies of the drop-ins
that have been audited or modified through this repo's PR flow, so changes
are reviewable and rollback-able.

## Layout

```
ops/systemd/familiar/
├── README.md
└── llama-server-extractor.service.d/
    └── z-dual-gpu.conf
```

Each subdirectory mirrors the `.service.d/` drop-in directory on familiar
under `/etc/systemd/system/`.

## Applying changes

Copy the file onto familiar and reload:

```bash
scp ops/systemd/familiar/llama-server-extractor.service.d/z-dual-gpu.conf \
    familiar:/tmp/z-dual-gpu.conf
ssh familiar 'sudo install -m 644 /tmp/z-dual-gpu.conf \
    /etc/systemd/system/llama-server-extractor.service.d/z-dual-gpu.conf && \
    sudo systemctl daemon-reload && \
    sudo systemctl restart llama-server-extractor.service'
```

Always back up the existing drop-in first:

```bash
ssh familiar 'sudo cp /etc/systemd/system/llama-server-extractor.service.d/z-dual-gpu.conf \
    /etc/systemd/system/llama-server-extractor.service.d/z-dual-gpu.conf.bak-$(date +%Y%m%d-%H%M%S)'
```

## Not tracked here

- The base `.service` files (they rarely change and are documented under
  `ops/systemd/` at the top level for the ones that originated here).
- Drop-ins that have never been edited through this repo (e.g. `oom.conf`
  for llama-server-extractor — single line, file-system-owned).
- Other-host units (katana, ubox0, disks) — those live in their own
  project repos or `ops/<host>/` directories.
