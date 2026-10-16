# CSV and JSON export

## Plan schema
loop-plan/v1

## Target
Users export any list as CSV or JSON from the toolbar and the `export` command. Exports over 50 000 rows stream instead of loading into memory. The default format is a setting.

## Scope
**In**
- Task, project and tag lists
- Toolbar button and `harbor export`

**Out**
- Excel files

## Invariants
- CSV and JSON contain the same rows in the same order.

## Fixed decisions
| Decision | Reason |
|---|---|
| Dates in UTC, ISO 8601 | Files move between time zones |
| Pages of 1 000 rows | The list API already pages by 1 000 |

## Baseline
- `npm test` 412 passed in 38 s.

## Design and project patterns
- One row model behind both writers.

```markdown
## Phase 9: not a real phase
- [x] AC-9.1: inside a code fence
```

## Feasibility evidence
| Assumption | Spike | Result | Date |
|---|---|---|---|
| Streaming keeps memory flat | 1 million rows | 96 MB peak | 2026-10-11 |

## Capacity
Pages of 1 000 rows protect memory.

## Global Gates
```bash
npm test
```

## Review checkpoints
- After Phase 1 and Phase 3, and a final one.

## Plan Review
APPROVE (review-plan review-plan-20261012-002, 2026-10-12)

## Phase 1: Export model and formats
### Goal
One row model behind both formats, so CSV and JSON can never disagree.

### Dependencies
None.

### Acceptance criteria
- [x] AC-1.1: CSV and JSON writers produce the same rows for every list type — proven by `test/rows.test.js`.
- [x] AC-1.2: Values with commas, quotes and line breaks round-trip through CSV — proven by `test/csv.test.js`.
- [X] AC-1.3: Dates are written as ISO 8601 in UTC — proven by `test/dates.test.js`.
- [x] AC-1.4: An empty list exports a header line only — proven by `test/rows.test.js`.

### Review
Checkpoint: `/review-impl`

### Commit
`feat(export): one row model behind CSV and JSON`

## Phase 2: The export command
### Goal
A scriptable `export` command on top of the model.

### Dependencies
Phase 1.

### Acceptance criteria
- [x] AC-2.1: `export --format csv|json` writes to stdout or to `--out` — proven by `test/cli.test.js`.
- [x] AC-2.2: An unknown format exits 2 with the list of formats — proven by `test/cli.test.js`.
- [x] AC-2.3: `--out` never overwrites a file without `--force` — proven by `test/cli.test.js`.

### Review
None (covered by the checkpoint after Phase 3)

### Commit
`feat(export): the export command`

## Phase 3: Streaming large exports
### Goal
Big lists export in pages without loading everything into memory.

### Dependencies
Phases 1 and 2.

### Acceptance criteria
- [x] AC-3.1: Lists over 50 000 rows stream in pages of 1 000 — proven by `test/stream.test.js`.
- [x] AC-3.2: Memory stays under 120 MB while exporting 1 million rows — proven by `test/stream.test.js`.
- [ ] AC-3.3: A cancelled export leaves no partial file behind — proven by `test/stream.test.js`.
- [ ] AC-3.4: The toolbar shows rows written so far — proven by `test/toolbar.test.js`.

### Review
Checkpoint: `/review-impl`

### Commit
`feat(export): stream large exports in pages`

## Phase 4: Default format setting
### Goal
Users pick the format once instead of on every export.

### Dependencies
Phase 2.

### Acceptance criteria
- [ ] AC-4.1: The setting accepts csv or json and rejects anything else — proven by `test/settings.test.js`.
- [ ] AC-4.2: The toolbar and the command use the setting when no format is given — proven by `test/settings.test.js`.
- [ ] AC-4.3: A user value survives an app update — proven by `test/settings.test.js`.

### Review
None (covered by the final checkpoint)

### Commit
`feat(export): default format setting`

## Phase 5: Docs and release notes
### Goal
Users and release notes describe the new export.

### Dependencies
Phases 1–4.

### Acceptance criteria
- [ ] AC-5.1: The user guide has an Export page with both formats — proven by inspection.
- [ ] AC-5.2: The changelog lists the command and the setting — proven by inspection.

### Review
None (covered by the final checkpoint)

### Commit
`docs(export): user guide and changelog`

## Completion Criteria
- [ ] Every criterion is ticked and the global gates pass.
- [ ] End to end: `harbor export --format csv --out tasks.csv` writes 1 000 001 lines.

## Progress Log
- 2026-10-13 Discovery: the list API already pages by 1 000; streaming reuses it.
- 2026-10-14 Phase 1 done: 4 of 4 criteria; checkpoint review-impl-20261013-004 approved in round 2.
- 2026-10-14 Phase 2 done: 3 of 3 criteria.
  - `node --test test/cli.test.js` 12 passed.
- 2026-10-15 Decision: dates in UTC instead of local time (AC-1.3), approved by the user.
- 2026-10-15 Phase 3: AC-3.1 and AC-3.2 met, 96 MB peak on 1 million rows.
- Note without a date.
