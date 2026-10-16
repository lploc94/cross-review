# Offline drafts

## Plan schema
loop-plan/v1

## Target
Drafts written offline sync when the device is back online, without losing either edit.

## Scope
- Notes only.

## Invariants
- No edit is lost.

## Fixed decisions
None.

## Baseline
- Nothing synced offline today.

## Design and project patterns
- A queue of pending saves.

## Feasibility evidence
None.

## Capacity
N/A

## Global Gates
`npm test`

## Review checkpoints
- Final only.

## Plan Review
pending

## Phase 1: Queue offline saves
### Goal
Saves made offline wait in a queue.

### Dependencies
None.

### Acceptance criteria
- [ ] AC-1.1: A save made offline is kept in the queue — proven by `test/queue.test.js`.
- [ ] AC-1.2: The queue survives a restart — proven by `test/queue.test.js`.

### Review
None (covered by the final checkpoint)

### Commit
`feat(sync): queue offline saves`

## Phase 2: Replay the queue
### Goal
The queue replays in order when the device is online.

### Dependencies
Phase 1.

### Acceptance criteria
- [ ] AC-2.1: Queued saves replay in the order they were made — proven by `test/replay.test.js`.

### Review
None (covered by the final checkpoint)

### Commit
`feat(sync): replay the queue`

## Completion Criteria
- [ ] Every criterion is ticked.

## Progress Log
