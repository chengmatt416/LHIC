# LHIC local product-data lifecycle

LHIC is local-first, but local-first does not remove the need for explicit data control. This guide covers the repository-supported inventory and logical-deletion workflow for the selected LHIC data root.

## Inventory

The default product-data root is `.lhic` in the current working directory.

```bash
lhic data inventory
```

Use a different root when the runtime was initialized elsewhere:

```bash
lhic data inventory --root /absolute/or/relative/path/to/.lhic
```

Write an immutable JSON inventory for review or an audit record:

```bash
lhic data inventory \
  --root .lhic \
  --output records/lhic-data-inventory.json
```

The inventory contains only metadata:

- canonical selected root;
- relative file and directory paths;
- file sizes;
- modification timestamps;
- total counts and bytes;
- a SHA-256 inventory digest;
- a confirmation string derived from the selected root and current inventory.

It never copies file contents. Symbolic links and unsupported filesystem objects fail closed.

## Logical deletion

First run inventory and review the selected root, counts, and paths. Then pass the exact current confirmation value:

```bash
lhic data erase \
  --root .lhic \
  --confirm ERASE-0123456789ABCDEF \
  --receipt records/lhic-data-erase-receipt.json
```

The confirmation changes whenever the inventory changes. The command re-inventories the root immediately before deletion and rejects stale or mistyped confirmations.

The erase command refuses to delete:

- a filesystem root;
- the current user's home directory;
- the current working directory;
- a path that is too broad to satisfy the safety-depth rule;
- a root or descendant that is a symbolic link;
- a tree containing unsupported filesystem objects.

The receipt is created with exclusive file creation and private permissions. It contains a root commitment rather than the plaintext root path, the pre-deletion inventory digest, removed counts and bytes, the deletion time, and an explicit `logicalDeletionOnly: true` statement.

## Scope and limitations

The selected root normally includes the local Skill database and product settings created under `.lhic`. The command does not automatically discover or erase data stored outside that root, including:

- operating-system Keychain or Credential Manager entries;
- an externally configured `LHIC_TRACE_DIRECTORY`;
- an externally configured correction replay directory;
- browser profiles outside the selected root;
- filesystem snapshots, backups, cloud-sync copies, crash dumps, or forensic remnants;
- data already uploaded to a separately configured remote service.

Logical deletion means the selected path is absent after the command completes. It is not a guarantee of physical SSD erasure because modern filesystems, copy-on-write snapshots, and flash wear leveling may retain inaccessible blocks.

Stop LHIC and any process using the selected data root before deletion. If a database is open, the operating system may reject deletion or another process may recreate files after the command finishes.

## External deletion checklist

After local deletion, review the actual deployment and separately remove:

1. provider API credentials from the operating-system keychain;
2. external trace directories and archived trace exports;
3. correction replay markers stored outside the product root;
4. MCP client configuration entries when LHIC is being uninstalled;
5. backups and synchronized copies under the user's control;
6. remote registry or observability data according to that service's deletion procedure.

The receipt is a local operational record. It is not externally signed, independently witnessed, or trusted-timestamped.
