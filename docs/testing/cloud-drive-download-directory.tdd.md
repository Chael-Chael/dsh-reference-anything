# Cloud-drive download directory — TDD evidence

## Scope

This change lets a user select the host directory used to materialize referenced cloud-drive attachments. An exact empty value retains the system temporary directory. Web-conversation attachments are intentionally unaffected.

## User journeys covered

1. Choose a directory with the host picker, enter one manually, or reset to the system temporary directory.
2. Reject missing, relative, non-directory, non-writable, device-namespace, final-component symlink/junction, or changed-at-runtime destinations without falling back.
3. Download into a random `dsh-reference-drive-*` child, preserve the configured base and unrelated contents, and switch directories without restarting.
4. Remove failed downloads immediately, expire successful downloads after one hour, and clean tracked files during disposal.
5. Preserve data when a base, generated directory, or attachment file is replaced; never downgrade an unknown path to recursive deletion.
6. Preserve concurrent settings changes, roll back failed UI saves, and keep drafts stable during asynchronous write-back.

## RED/GREEN record

| Slice | RED evidence | GREEN evidence |
| --- | --- | --- |
| Schema and host validation | Missing setting/default and validator tests failed; review regressions then exposed whitespace normalization, missing execute permission, Windows device namespaces, and settings races. | `tests/download-directory.spec.ts`, `tests/client-settings.spec.ts`, `tests/store.spec.ts`, and `tests/sync.spec.ts`: 97/97 passed. |
| Materialization and lifecycle | Custom paths initially still used the system temp directory; invalid paths still downloaded; later regressions exposed recursive-cleanup downgrade, partial-write leakage, base replacement, foreign-entry handling, and disposal during an in-flight write. | Attachment plus Web-attachment focused suites: 40/40 passed; combined directory/tool slice: 71/71 passed. |
| Settings UI | Initial tests failed for missing controls; review regressions exposed trimmed paths, missing rollback, concurrent saves, picker error coverage, and editable drafts during a deferred save. | Settings UI suites: 49/49 passed; production client build passed. |
| Integrated feature | The review regressions failed against the preceding implementation before each remediation. | Eight integrated suites: 188 passed; one POSIX-only exact-path integration was skipped on Windows. |

## Final verification

- `pnpm run check`: TypeScript passed; 41 test files passed, 743 tests passed, 4 pre-existing corpus tests and 1 POSIX-only path test skipped; production build passed.
- `npm pack --dry-run --json`: passed and included the compiled download-directory module; no package archive was written.
- `git diff --check HEAD`: passed (Git emitted only line-ending conversion notices).
- Temporary-artifact audit: no `dsh-reference-*` test roots or package archives remain.
- `pnpm exec vitest ... --coverage`: coverage collection was unavailable because this repository does not install `@vitest/coverage-v8`. No dependency was added solely for this change; the focused behavioral suites above are the recorded coverage evidence.

## Residual platform constraint

Node.js does not expose cross-platform `openat`/`unlinkat` primitives. Selected bases, generated roots, and files are identity-checked repeatedly; selected roots use exclusive `0600` file creation, non-recursive directory removal, tracked operation leases, and fail-closed tombstones. A same-user attacker racing the final identity check and path-based unlink remains an operating-system API limitation rather than a claim of atomic deletion.

No checkpoint commits were made while implementing the change because the delivery workflow requires explicit Gate 2 approval before committing or updating the pull request.
