# Project evidence storage policy (`<projectHome>/.twinny/config.json`)

The quotas, eviction order and retention settings for captured evidence belong to the project, in
`<projectHome>/.twinny/config.json`, next to `project.sqlite`. This file is the single source of truth.
It is **not** the gateway config file; nothing here reads or writes that one, and no quota value is
mirrored as an independently mutable `package.json`/VS Code setting.

```json
{
  "evidence": {
    "storage": {
      "maxProjectBytes": 64000000,
      "maxBlobBytes": 2000000,
      "evictionOrder": "oldest_unfavourited_first",
      "redactionMode": "presentation_only",
      "enabled": true
    }
  }
}
```

An example with the documented defaults is `docs/twinny.config.example.json`. A copy of it placed at
`<projectHome>/.twinny/config.json` changes nothing, because the same values are already the defaults.

## What each key means

| Key | Documented default | Accepted values | What it governs |
|---|---|---|---|
| `maxProjectBytes` | `64000000` | whole number, `1`–`1000000000` | the bytes this project's store holds at once, counted from what it actually holds |
| `maxBlobBytes` | `2000000` | whole number, `1`–`100000000` | the largest single stream the store retains as one byte object |
| `evictionOrder` | `oldest_unfavourited_first` | `oldest_unfavourited_first`, `oldest_first` | which blob gives up its bytes when the project is out of room |
| `redactionMode` | `presentation_only` | `presentation_only`, `exclude_raw_secrets` | whether raw sensitive bytes may be retained at all |
| `enabled` | `true` | `true`, `false` | whether retention is on; off reports the same gaps instead of writing bytes |

Bounds as the reader checks them: `maxProjectBytes` `1`–`1,000,000,000`, `maxBlobBytes` `1`–`100,000,000`;
every byte value must be a whole nonnegative number.

## Reading and reporting

- A missing file uses the documented defaults, reported as `source: defaults`.
- A corrupt, unreadable or invalid file is reported as an actionable error naming the path and the key
  that failed (`evidence.storage.maxBlobBytes must be a whole nonnegative number of bytes`). It is never
  silently fallen back on, never overwritten, never reset, and no database is touched because of it.
- Keys outside `evidence.storage` are preserved exactly as they are and reported as read-but-not-used,
  so nothing in a user's file is dropped quietly.
- Reload is safe: the file is read again only when its size or modification time has changed, so a new
  setting takes effect at the next storage operation without a restart.

## The database row is an audit mirror, not a setting

`storage_policy` holds one row per project with the effective values in force for a write. It is written
from the JSON reading, never read as a setting of its own, so there is exactly one source of truth.

## What completeness states mean

The store reports what it measured, never what was claimed:

- `captured_complete` — were the bytes received (`complete`), partly (`partial`), not at all
  (`not_captured`), or withheld by policy (`excluded`).
- `storage_complete` — are the retained bytes whole (`complete`), part of them (`partial`), gone
  (`evicted`), or unreachable (`inaccessible`).
- `gap_reason` — why a limit was reached: `capture_limit`, `storage_limit`, `eviction`, `redaction`,
  `failure`, `not_captured`, `storage_error`. A byte that cannot be written is `storage_error`, never a
  successful record.
- Coverage is the retained range, half-open `[start, end)`, recorded per stream in `evidence_chunks`; a
  gap records what had been received when nothing was retained. A result larger than `maxBlobBytes` is
  recorded incomplete with its exact coverage and no phantom blob ID.

## Accounting

- Inline payloads are real SQLite BLOB bytes; anything past `INLINE_BLOB_LIMIT` (`64000`) goes to an
  external byte object under `.twinny/blobs/`, written by stage, verified against its content digest and
  renamed atomically — a SQLite transaction by itself cannot make a filesystem write atomic.
- Byte objects are content-addressed by `UNIQUE(project_id, content_digest)`, so two observations of the
  same bytes share one blob while each keeps its own outcome row and its own chunk history. Sharing bytes
  never merges receipt history.
- The project count is over `stored_bytes` of blobs that have not been evicted. Favouriting affects
  eviction priority only, never a project or blob cap; until Stage 6 activates protection the store keeps
  today's oldest-first order and reports the order it actually used.
- Pending writes are counted at the next operation: an outcome whose terminal result never arrived stays
  pending and is settled by a reopen to `lost` (bytes had arrived) or `unknown` (nothing can be said),
  never to success. Byte objects with no pointer are reported, not deleted.

Changing this file never deletes evidence and never grants anything: access stays with the workspace
view, the access preflight and the operation-scoped write grants.
