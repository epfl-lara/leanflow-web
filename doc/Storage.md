# Keep project storage available

Add disk space before the storage warning reaches the reserve. LeanFlow checks
the filesystem containing `STUDIO_DATA_DIR`; an expanded filesystem becomes
available to new work automatically. Moving data to a different filesystem
requires a planned migration while project work is idle.

## Warnings and admission

By default, LeanFlow warns when less than 8 GiB remains after active allocation
reservations. New allocations leave at least 2 GiB free for accepted work,
metadata, and recovery. Concurrent operations reserve their estimated space so
they cannot each claim the same available bytes. A new allocation normally
reserves 512 MiB; an operation with a larger known size needs a larger estimate.

When there is insufficient space, new allocations receive an actionable error.
Downloads, recovery, and deliberate deletion remain available. Existing proof
work is not stopped to free space. A failed filesystem check pauses new
allocations until the check succeeds again.

Adjust the thresholds together in the server's private environment file:

```dotenv
STUDIO_STORAGE_MIN_FREE_BYTES=2147483648
STUDIO_STORAGE_WARNING_FREE_BYTES=8589934592
STUDIO_STORAGE_ALLOCATION_BYTES=536870912
```

The warning must be at least the minimum free space. Configuration changes need
an idle restart; a disk expansion does not. Keep enough headroom for the largest
planned setup or full kernel export, in addition to these reserves.

These estimates govern admission. They are not filesystem quotas on a running
worker, and unrelated host applications can still use the volume. Monitor the
data filesystem and Docker's filesystem; they can be different volumes.

## Retained work

LeanFlow does not expire or delete retained runs, source history, or terminal
recovery copies automatically. Disposable verification copies are removed after
their workers and cleanup finish. Keep retained work until its users choose to
remove it, and include it in capacity planning and backups.

When more space is needed, expand the filesystem or review disposable artifacts
and deliberate deletion with the affected users. Do not remove the data
directory, shared dependency caches, or Docker volumes wholesale. A cache or
candidate may still be needed by an active worker or a retained review.

From the checkout, inspect the chosen data filesystem without changing it:

```sh
studio_data_dir="${STUDIO_DATA_DIR:-.data}"
df -h "$studio_data_dir"
docker system df
```

See [hosting](Hosting.md#storage-and-capacity) for volume selection and
[configuration](Configuration.md#back-up-before-upgrading) for private backups.
