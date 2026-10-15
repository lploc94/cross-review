## Peer cross-analysis (`next: cross_check`)
The reviewer's verdict here is advisory; you decide when the debate ends, using this skill's exit rule.

1. **Information barrier.** Right after `review_begin`, work through the returned `analysis_prompt` on your own and finish your analysis before calling `review_wait` or reading any reviewer output.
2. When `next` is `cross_check`, compare your findings with the reviewer's: agreements, disagreements, points only one side raised, and same direction with different severity or depth.
3. If the exit rule is met, call `review_end {session_dir, outcome: "consensus"}`; if the same disagreements persist without new evidence, use `outcome: "stalemate"`. Otherwise `review_reply` with your agreements, disagreements (defended with evidence), and new points, and wait again.
4. `next: done` means the reviewer or the runner detected a stalemate: call `review_end {session_dir, outcome: "stalemate"}`, present the deadlocked points with your recommendation, and let the user decide.
