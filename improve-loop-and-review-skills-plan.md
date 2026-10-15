# Cải thiện loop skills và review skills theo bằng chứng

## Plan schema
loop-plan/v1

## Target

Hiện thực các quyết định đã chốt trong `improve-loop-skills-from-review-data-plan.md` (gọi tắt là **doc nghiên cứu**). Mục 21 của doc đó là nguồn sự thật. Có bốn kết quả mà user nhìn thấy được:

1. **Review không còn báo nhầm verdict.**
   - Một vòng Codex trả `APPROVE` mà không kèm issue thì được ghi đúng là APPROVE.
   - `finalize` không bao giờ lấy verdict của vòng cũ.
2. **Gọi review đơn giản.**
   - Model gọi 4 động từ `begin` / `wait` / `reply` / `end`, qua MCP tools hoặc qua CLI làm đường dự phòng.
   - Runner tự tính bước tiếp theo (`next`) và nhớ model/effort của phiên.
   - SKILL.md của mỗi review skill tự đủ: không phải đọc thêm file protocol, không còn flavor text.
3. **loop-plan và loop-implement được cập nhật đúng các thay đổi quy trình đã chốt**, kèm các luật có bằng chứng (mục 21.3 của doc nghiên cứu). Các luật đã thử mà không có tác dụng thì không đưa vào.
4. **Installer cài được cho cả Claude Code và Codex,** bao gồm bản Codex của loop skills, và đăng ký MCP server.

## Scope

**Trong phạm vi:**
- `skill-packs/codex-review/scripts/codex-runner.js` và phần lõi tách ra từ nó.
- MCP server mới.
- `skill-packs/codex-review/skills/*` (SKILL.md, `references/prompts.md`).
- `skill-packs/codex-review/shared/*`.
- `bin/codex-skill.js`, `manifest.json`, `package.json`, `README.md`, `CLAUDE.md`.
- Bản Codex của loop-plan và loop-implement, gồm SKILL.md và `agents/openai.yaml`.
- Test mới trong `tests/`.

**Ngoài phạm vi** (theo mục 21.6 của doc nghiên cứu):
- phân tích dữ liệu ở mục 6;
- tái cấu trúc phase của loop-plan;
- danh mục bẫy, bảng Impact map, bảng State/lifecycle, luật kiểm gate ở bước plan;
- Claude làm reviewer khi Codex điều phối, nếu Phase 3 cho thấy chưa khả thi;
- pilot đánh giá skill mới (cần user đồng ý riêng vì tốn quota).

## Invariants

- **I1.** Lệnh runner cũ (`init`, `render`, `start`, `poll`, `resume`, `finalize`, `stop`, `status`, `version`) giữ nguyên hành vi, trừ phần sửa bug verdict. Ba test có sẵn (`test-default-timeout.js`, `test-stall-recovery.js`, `test-timeout-resume.js`) phải pass ở mọi phase.
- **I2.** Codex vẫn chạy detached, và trạng thái phiên vẫn nằm trên đĩa ở `.codex-review/sessions/<skill>-<yyyymmdd>-<NNN>/`. MCP server chết thì phiên không mất.
- **I3.** Làm thẳng trên `main`, không tạo nhánh (user quyết 2026-10-15). Mỗi phase một commit cục bộ; không push.
- **I4.** WIP chưa commit của user không giữ thành commit riêng (user quyết 2026-10-15). Phần WIP plan dùng tới được commit cùng phase sở hữu file đó; phần không dùng (5 `references/protocol.md`, `shared/protocol.md`, `shared/flavor-text.md`) bị xoá ở Phase 4.
- **I5.** Không commit output review thật của user vào repo. Bộ quét hồi quy cho parser chỉ chạy cục bộ.
- **I6.** Installer vẫn cài nguyên tử: staging, backup rồi rename, rollback khi lỗi. Bản cài cũ của skill đã gỡ vẫn bị xoá.
- **I7.** Con số năng lực bên ngoài (timeout của MCP client, phiên bản SDK, cú pháp đăng ký) phải lấy từ docs hiện hành hoặc đo thực tế, kèm nguồn, không lấy từ trí nhớ (mục 3.6 của doc nghiên cứu).

## Baseline

Đo ngày 2026-10-15 trên `main` `51d4351`. Working tree có 25 thay đổi chưa commit, là WIP của user:
- gỡ 3 review skill;
- thêm loop-plan và loop-implement;
- sửa runner, installer, protocol và tài liệu;
- 5 file `references/protocol.md` chưa track.

Lệnh test hiện có (repo chưa có test framework):

| Lệnh | Kết quả | Thời gian |
|---|---|---|
| `node test-default-timeout.js` | PASS | 3s |
| `node test-stall-recovery.js` | PASS | 3s |
| `node test-timeout-resume.js` | PASS | 19s |

Runner v13. Công cụ có trên máy: Claude Code 2.1.295, codex-cli 0.162.1.

`~/.codex/skills` đang có một bản codex-review không do installer này quản lý: `codex-review/`, `codex-plan-review/`, ... Ngoài ra có bản Codex của loop-plan và loop-implement, mỗi bản có `agents/openai.yaml`.

Bug đã xác nhận (doc nghiên cứu, mục 10):
- `parseOutputMarkdown` (`codex-runner.js`, khoảng dòng 655–708) trả `format: "unknown"` khi output không có block ISSUE/RESPONSE/CROSS và không có Key Insights/Considerations, mà không gọi `parseVerdict`.
- `cmdFinalize` (khoảng dòng 2102–2197) lấy verdict của vòng gần nhất có verdict.

## Design and project patterns

**Lõi và vỏ.**
- Tách phần logic phiên khỏi `codex-runner.js` thành module `skill-packs/codex-review/scripts/lib/review-core.js`: init, launch, parse, poll, resume, finalize, stop, và hàm mới tính `next`.
- `codex-runner.js` giữ nguyên CLI, nhưng gọi vào lõi.
- MCP server `skill-packs/codex-review/scripts/mcp-server.js` gọi cùng lõi.
- Pattern trong repo: runner là một file ES module, dùng `node:` stdlib. Lõi theo cùng phong cách.

**Phụ thuộc.**
- Doc nghiên cứu mục 11 đã bỏ nguyên tắc "chỉ stdlib". MCP server dùng SDK chính thức. Phiên bản và API phải kiểm từ docs hiện hành ở Phase 3.
- Runner CLI và lõi vẫn chỉ dùng stdlib, để đường fallback bash chạy được khi không có `node_modules`.

**Test.**
- Dùng `node --test` (có sẵn trong Node ≥ 22, không cần dependency).
- Test mới đặt ở `tests/*.test.js`. Test cũ giữ nguyên chỗ.

**Prompt và protocol.**
- Nguồn duy nhất là `skill-packs/codex-review/shared/protocol/*.md`.
- Installer thay các placeholder `{{PROTOCOL_CORE}}` và `{{PROTOCOL_VARIANT}}` trong SKILL.md template lúc cài.
- Đây là cùng cơ chế với `{{RUNNER_PATH}}` hiện có (`bin/codex-skill.js`, vòng lặp `for (const skill of SKILLS)`).

**Bản Codex của loop skills.**
- Repo giữ một template cho mỗi loop skill, có placeholder cho phần khác nhau giữa hai client: `/loop-plan` so với `$loop-plan`, `CLAUDE.md/AGENTS.md` so với `AGENTS.md`, "another session" so với "another Codex session".
- Installer render ra hai bản. File `agents/openai.yaml` được giữ trong repo.

**Nội dung loop skills.** Theo đúng mục 21.3 của doc nghiên cứu, cùng kết luận pilot 5 ở mục 21.7.

## Global Gates

`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

`H=$(mktemp -d) && HOME="$H" CODEX_HOME="$H/.codex" node bin/codex-skill.js && node tests/install-check.mjs "$H"`

Cả hai lệnh phải exit 0. `tests/install-check.mjs` được tạo ở Phase 7.

Từ Phase 3 trở đi, chạy `npm ci --prefix skill-packs/codex-review` một lần trước các gate (cài SDK MCP từ lock file). `node_modules/` đã có trong `.gitignore`.

## Plan Review
APPROVE (codex-plan-review codex-plan-review-20261014-001, 2026-10-15, 2 vòng: 5 issue ở vòng 1 đều đã sửa)

## Review checkpoints

Review bằng `/codex-impl-review` tại các điểm sau. Model mặc định của Codex, effort `high`.
- **Sau Phase 2.** Lõi và 4 động từ là nền cho mọi phase sau.
- **Sau Phase 3.** MCP server và đăng ký vào client.
- **Sau Phase 6.** Toàn bộ nội dung skill.
- **Cuối,** sau Phase 7, trên diff cộng dồn.

## Phase 1: Sửa parse verdict và finalize

### Goal
APPROVE không kèm issue được parse đúng. `finalize` chỉ dùng verdict của vòng cuối.

### Current behavior and gap
- `parseOutputMarkdown` trả `unknown` khi output chỉ có `### VERDICT`.
- Poll không ghi verdict vào `rounds.json`.
- `cmdFinalize` lấy REVISE của vòng trước, hoặc báo "No verdict available".

Theo quét trên máy (doc nghiên cứu mục 10), 495 phiên bị ghi REVISE trong khi vòng cuối là APPROVE.

### Evidence
- `codex-runner.js:655–708` (`parseOutputMarkdown`).
- `:505–547` (`parseVerdict`, chỉ nhận đúng `### VERDICT`).
- `:1956–2050` (poll ghi `currentRoundObj.verdict`).
- `:2102–2197` (`cmdFinalize`).

### Pattern
- Giữ cấu trúc `parse*` hiện có.
- Để test được parser mà không phải sửa CLI, tách `parseVerdict` và `parseOutputMarkdown` sang `scripts/lib/parse.js`, rồi import vào runner.

### Dependencies
Không có.

### Files and symbols
- `skill-packs/codex-review/scripts/lib/parse.js` (mới): `parseVerdict`, `parseOutputMarkdown`, `normalizeVerdictStatus`, và các helper chúng dùng.
- `codex-runner.js`: import từ `lib/parse.js`; sửa `cmdFinalize`.
- `bin/codex-skill.js`: copy cả `scripts/lib/`.
- `tests/parse-verdict.test.js` (mới).
- `scripts/scan-review-outputs.mjs` (mới): công cụ cục bộ, không đọc file khi chạy test.

### Behavioral contract
- Output chỉ có verdict (không ISSUE) thì cho `format: "review"`, `blocks: []`, và `verdict.status` đã chuẩn hoá.
- Heading được nhận: `## VERDICT` hoặc `### VERDICT`, không phân biệt hoa thường. Cũng nhận dòng `VERDICT: X`.
- Status được chuẩn hoá về `APPROVE | REVISE | CONSENSUS | CONTINUE | STALEMATE`: bỏ `**`, backtick, dấu chấm, khoảng trắng.
- Output think-about và output có block vẫn parse như cũ.
- `cmdFinalize`:
  - verdict là override từ stdin, nếu có;
  - không có override thì lấy verdict của **vòng cuối**;
  - vòng cuối không có verdict thì trả lỗi `PRECONDITION_FAILED` kèm hướng dẫn. Không tìm ngược về các vòng trước.

### Documentation
Mục Breaking Changes trong `CLAUDE.md`: thêm "v14: verdict-only output được parse; finalize chỉ dùng vòng cuối". Viết ở Phase 7, cùng đợt lên v14.

### Tests first
`tests/parse-verdict.test.js` phải đỏ trước khi sửa. Các ca:
- APPROVE chỉ có verdict;
- REVISE kèm ISSUE;
- `## VERDICT`;
- `VERDICT: APPROVE` cùng dòng;
- `**APPROVE**`;
- `` `APPROVE`. ``;
- think-about không đổi.

Thêm một ca cho finalize: 2 vòng, vòng 1 REVISE, vòng 2 chỉ có verdict APPROVE. Dựng bằng session giả, giống cách các test hiện có làm.

### Anti-shortcut coverage
- Có ca "vòng cuối không có verdict, vòng trước có REVISE": finalize phải lỗi, không được trả REVISE.
- Có ca "ISSUE kèm VERDICT" để chặn việc làm hỏng nhánh cũ.

### Implementation obligations
- Sửa nhánh `unknown` trong `parseOutputMarkdown` để vẫn gọi `parseVerdict`.
- Nới regex của `parseVerdict`.
- Viết `normalizeVerdictStatus`.
- Sửa `cmdFinalize`.
- Viết `scan-review-outputs.mjs`: nhận một thư mục gốc, tìm `review.md`, đếm theo `format` và `verdict.status`. In tổng hợp, không in nội dung review.

### Acceptance criteria
- [ ] AC-1.1: Mọi ca trong `tests/parse-verdict.test.js` pass — proven by `node --test tests/parse-verdict.test.js`.
- [ ] AC-1.2: Finalize với vòng cuối thiếu verdict thì lỗi, không lấy verdict cũ — proven by test finalize.
- [ ] AC-1.3: Chạy `node skill-packs/codex-review/scripts/scan-review-outputs.mjs ~/projects` cho 0 output có chứa `VERDICT` mà bị parse thành `unknown` hoặc thiếu status — proven by kết quả ghi vào Progress Log (chỉ số đếm).
- [ ] AC-1.4: Ba test cũ vẫn pass — proven by Global Gate 1.

### Focused verification
`node --test tests/parse-verdict.test.js`

### Phase gates
`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Gộp vào checkpoint sau Phase 2.

### Commit
`fix(runner): parse verdict-only reviews and finalize from the last round`

## Phase 2: Lõi phiên và 4 động từ begin / wait / reply / end

### Goal
Runner lo trạng thái, model lo nội dung. Có 4 lệnh CLI cấp cao; runner nhớ model và effort, và trả `next`.

### Current behavior and gap
- Model phải tự ghép `init → render → start → poll → render → resume → finalize → stop`, dùng `json_esc` và heredoc.
- Model phải tự áp bảng stalemate/verdict và điều kiện recovery 5 vế.
- `--model` không được lưu, nên phải truyền lại ở mọi `resume` (doc nghiên cứu mục 10).

### Evidence
- `main()` của `codex-runner.js` (khoảng dòng 2294) dispatch theo `process.argv[2]`.
- `cmdInit` tạo session.
- `cmdRender` đọc `references/prompts.md`.
- `cmdPoll` tính `status`, `recoverable`, `convergence`.
- CLAUDE.md, mục "codex-runner.js Commands (v13)".

### Pattern
- Hàm `cmd*` hiện có được giữ lại.
- Lệnh mới gọi chúng qua lõi, không nhân bản logic.

### Dependencies
Phase 1.

### Files and symbols
- `scripts/lib/review-core.js` (mới):
  - `beginSession({skill, mode, inputFile, workingDir, model, effort, timeout})`;
  - `waitSession(sessionDir, {maxWaitSeconds})`;
  - `replySession(sessionDir, {inputFile, model?, effort?})`;
  - `endSession(sessionDir, {outcome?})`;
  - `computeNext(pollJson, state)`;
  - bảng template theo skill/mode/vòng (xem Behavioral contract).
- `codex-runner.js`: thêm case `begin`, `wait`, `reply`, `end` vào `main()`; `CODEX_RUNNER_VERSION = 14`; lưu `model`, `effort`, `skill`, `mode`, `skills_dir` vào `state.json`.
- `tests/review-core.test.js` (mới).

### Behavioral contract
**Hai loại skill.**
- *Skill có verdict quyết định:* plan-review, impl-review. Verdict của Codex quyết định việc kết thúc, như hiện nay.
- *Skill peer:* think-about, commit-review, pr-review. Verdict của Codex chỉ là tham khảo. Phía điều phối tự phân tích độc lập, đối chiếu, rồi quyết định kết thúc theo điều kiện kết thúc hiện có trong SKILL.md của từng skill: commit-review và pr-review khi không còn bất đồng mức ≥ medium; think-about khi không còn bất đồng đáng kể; cả ba khi bế tắc. Các điều kiện này giữ nguyên.

**Ánh xạ template theo skill, mode và vòng:**

| Skill | Mode | Vòng 1 (`begin`) | Vòng 2+ (`reply`) | Phân tích độc lập |
|---|---|---|---|---|
| codex-plan-review | — | `round1` | `rebuttal` | — |
| codex-impl-review | `working-tree` / `branch` | `<mode>-round1` | `rebuttal-<mode>` | — |
| codex-think-about | — | `round1` | `round2+` | `claude-analysis` |
| codex-commit-review | `staged` / `last` | `<mode>-round1` | `<mode>-round2+` | `claude-<mode>` |
| codex-pr-review | — | `round1` | `round2+` | `claude-analysis` |

Bảng này nằm trong lõi, cạnh `TEMPLATE_MAP`. `begin` ghi `skill`, `mode` và `skills_dir` vào `state.json`; `reply` đọc lại từ đó để chọn template.

**`begin`:**
- Nhận file markdown input: phần đầu là front-matter cho các placeholder, theo đúng tên trong `prompts.md` của skill.
- Tự init, render template vòng 1 theo bảng trên, rồi start.
- Trả `{session_dir, round:1, status:"running"}`. Với skill peer, kết quả có thêm `analysis_prompt`: template phân tích độc lập đã render từ cùng input, để phía điều phối làm phân tích trước khi đọc output Codex.

**`wait`:**
- Poll tối đa `maxWaitSeconds`, có throttle như `poll` hiện tại.
- Trả `{status, round, review?, activities, next, next_reason}`. `next` là một trong `respond`, `cross_check`, `done`, `ask_user`, `stopped`, `running`.

**`computeNext(pollJson, state)`:**
- Status của vòng lấy từ `review.verdict.status`, nếu không có thì từ `review.suggested_status` (think-about, RESPONSE-only).
- `completed` + (`convergence.stalemate` hoặc status `STALEMATE`) → `done` (reason `stalemate`), cho mọi skill.
- Skill có verdict quyết định:
  - `completed` + status APPROVE → `done`;
  - `completed` + status khác hoặc có issue → `respond`;
  - `completed` mà không có status → `ask_user` (reason `missing_verdict`).
- Skill peer: `completed` (trừ stalemate) → `cross_check`, bất kể Codex trả CONSENSUS hay CONTINUE. Phía điều phối đối chiếu với phân tích của mình, rồi gọi `reply` nếu điều kiện kết thúc của skill chưa đạt, hoặc `end --outcome consensus|stalemate` nếu đã đạt.
- `timeout`/`runner_deadline` + recoverable → `stopped` (reason `recoverable_timeout`, kèm hướng dẫn resume ở lần gọi sau).
- Mọi trạng thái lỗi khác → `stopped` (kèm reason).
- Đang chạy → `running`.

**`reply`:**
- Render template vòng 2+ theo bảng trên từ file input rồi resume.
- Model và effort lấy từ state, trừ khi truyền flag mới. Flag mới thì cập nhật vào state.

**`end`:**
- Skill có verdict quyết định, `next` là `done`: finalize (verdict lấy từ vòng cuối, không nhận override) rồi stop.
- Skill peer có `--outcome consensus|stalemate`: finalize với verdict tương ứng (`CONSENSUS`/`STALEMATE`, qua đường override sẵn có của `finalize`) rồi stop. Đây là quyết định của phía điều phối, như hiện nay.
- Các trường hợp khác: chỉ stop.
- Trả `{status:"ended", finalized: bool, verdict?}`.

**Khác:**
- Runner tự ghi `.codex-review/.gitignore` chứa `*` khi tạo `.codex-review/` lần đầu.

### Documentation
Bảng lệnh v14 trong `CLAUDE.md` và `README.md`. Viết ở Phase 7.

### Tests first
`tests/review-core.test.js`, đỏ trước khi viết lõi:
- bảng `computeNext` trên các poll JSON giả (mọi nhánh ở trên), gồm:
  - status `STALEMATE` mà `convergence.stalemate` không bật;
  - think-about có `suggested_status: STALEMATE`;
  - vòng RESPONSE-only;
  - commit-review khi Codex trả CONSENSUS → `cross_check`, không phải `done`;
- model và effort được lưu, và `reply` dùng lại;
- `.gitignore` được tạo đúng một lần;
- `begin → wait → reply → wait` với Codex giả cho từng tổ hợp skill/mode trong bảng (7 tổ hợp). Kiểm prompt Codex giả nhận ở vòng 2 lấy từ đúng heading template. Với skill peer, kiểm `begin` trả `analysis_prompt`. Dùng cùng kỹ thuật `codex` giả trong PATH mà các test cũ dùng, nếu có; không có thì tạo script giả trong thư mục tạm.
- `end --outcome consensus` ở commit-review finalize với `CONSENSUS`; `end` không có outcome ở skill peer thì chỉ stop.

### Anti-shortcut coverage
- `computeNext` phải có ca `completed` mà thiếu verdict cho ra `ask_user`, không mặc định `done`.
- `reply` phải chứng minh được rằng không có flag thì resume chạy với model đã lưu: kiểm tham số mà Codex giả nhận được.
- Ca Codex APPROVE/CONSENSUS ở skill peer phải cho `cross_check`. Chặn cách làm đơn giản là "verdict tốt thì kết thúc" cho mọi skill.

### Implementation obligations
- Tách lõi mà không đổi hành vi lệnh cũ (I1).
- Thêm 4 case vào `main()`.
- Ghi `model`, `effort` vào state ở `start`/`begin` và `resume`/`reply` khi có flag.

### Acceptance criteria
- [ ] AC-2.1: Mọi nhánh `computeNext` có test và pass — proven by `node --test tests/review-core.test.js`.
- [ ] AC-2.1b: Cả 7 tổ hợp skill/mode chạy được `begin → wait → reply → wait` với Codex giả, và vòng 2 dùng đúng template — proven by `node --test tests/review-core.test.js`.
- [ ] AC-2.2: Không truyền `--model` ở `reply` thì Codex giả vẫn nhận model đã dùng ở `begin` — proven by test.
- [ ] AC-2.3: `node codex-runner.js version` in `14` — proven by inspection.
- [ ] AC-2.4: Ba test cũ pass không sửa — proven by Global Gate 1.
- [ ] AC-2.5: Một vòng review thật ngắn qua `begin → wait → end` trên một diff nhỏ cho `next: done` hoặc `respond` với verdict hợp lệ — proven by log ghi vào Progress Log. Chỉ chạy 1 lần vì tốn quota.

### Focused verification
`node --test tests/review-core.test.js`

### Phase gates
`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Checkpoint: `/codex-impl-review` trên diff Phase 1–2.

### Commit
`feat(runner): add begin/wait/reply/end with stored model and computed next step`

## Phase 3: MCP server

### Goal
Model gọi review qua 4 MCP tools có kiểu. Bash là fallback.

### Current behavior and gap
Chưa có MCP server.

### Evidence
- Doc nghiên cứu mục 11, phần đã chốt: dùng SDK chính thức; installer tự đăng ký cho Claude Code và Codex; hỗ trợ Codex điều phối.
- `~/.codex/config.toml` đã có các khối `[mcp_servers.*]`, nên Codex nhận MCP stdio.

### Pattern
Giống các MCP stdio server user đang dùng (`context7`, `linkup` trong `~/.codex/config.toml`).

### Dependencies
Phase 2.

### Files and symbols
- `scripts/mcp-server.js` (mới).
- `skill-packs/codex-review/package.json` (mới): `"type": "module"`, khai báo dependency SDK, pin đúng phiên bản đã ghi ở Feasibility evidence. Kèm `package-lock.json` được commit.
- Cài cho dev và test: `npm ci --prefix skill-packs/codex-review`. Runner CLI và lõi không import SDK, nên vẫn chạy được khi chưa cài.
- Server ở `skill-packs/codex-review/scripts/mcp-server.js` tự resolve SDK từ `skill-packs/codex-review/node_modules`. Test trong `tests/` nạp SDK client bằng `createRequire` neo vào `skill-packs/codex-review/package.json`, vì đường resolve mặc định từ `tests/` không đi qua thư mục đó.
- Thiếu SDK thì test MCP **fail** kèm hướng dẫn chạy `npm ci`, không skip.
- `tests/mcp-server.test.js` (mới).

### Behavioral contract
**Kiểm trước khi code, ghi vào Feasibility evidence của phase:**
- tên và phiên bản SDK MCP chính thức cho Node;
- timeout mặc định của một tool call ở Claude Code và ở Codex, và cách chỉnh;
- server stdio có spawn được tiến trình detached sống sót sau khi server thoát không (đo bằng thử thật);
- lệnh hoặc cú pháp đăng ký server phạm vi user ở cả hai client.

**4 tool:**
- `review_begin`, `review_wait`, `review_reply`, `review_end`, với tham số giống CLI (gồm `mode` ở `review_begin` và `outcome` ở `review_end`).
- Input là chuỗi markdown, không phải đường dẫn file. Server tự ghi vào session.
- `review_wait.max_wait_seconds` mặc định bằng timeout đo được trừ biên an toàn.

**Lỗi và vòng đời:**
- Lỗi được trả dưới dạng kết quả tool có `isError`, không làm sập server.
- Server thoát thì phiên vẫn còn (I2). Gọi lại `review_wait` với cùng `session_dir` được.

**Claude làm reviewer:** chạy spike `claude -p` (chạy nền, giữ phiên qua nhiều vòng, chỉ đọc).
- Khả thi thì ghi thiết kế tối thiểu vào Progress Log, và hỏi user trước khi làm. Đây là phạm vi mới.
- Không khả thi thì ghi lý do và hoãn.

### Feasibility evidence
Đo và tra ngày 2026-10-15.

| Điều cần biết | Kết quả | Nguồn |
|---|---|---|
| SDK MCP chính thức cho Node | `@modelcontextprotocol/sdk` 1.32.1 (latest), Node ≥ 18, peer `zod` ^3.25 \|\| ^4.0. Pin 1.32.1 + `zod` 4.6.7. API `McpServer.registerTool` + `StdioServerTransport`; client `Client` + `StdioClientTransport`. | `npm view @modelcontextprotocol/sdk`; docs SDK v1.x `docs/server.md` (context7 `/modelcontextprotocol/typescript-sdk`) |
| Timeout một tool call | Claude Code: mặc định khoảng 28 giờ (`MCP_TOOL_TIMEOUT`, hoặc trường `timeout` theo server). Codex: `tool_timeout_sec` mặc định 60 giây, `startup_timeout_sec` mặc định 10 giây. Nên `review_wait` lấy mặc định từ env `REVIEW_WAIT_DEFAULT_S` do installer đặt theo client: Codex 50, Claude Code 300; không có env thì 50. | https://code.claude.com/docs/en/mcp ; https://learn.chatgpt.com/docs/extend/mcp?surface=cli |
| Tiến trình detached sống sót khi server thoát | Có. Test `tests/mcp-server.test.js` SIGKILL server khi Codex giả đang chạy; server mới gọi `review_wait` cùng `session_dir` nhận `completed`/`done`. | đo bằng test |
| Đăng ký server phạm vi user | Claude Code: `claude mcp add -s user <name> [-e K=V] -- <cmd> <args>`, ghi `$HOME/.claude.json`. Lần thêm thứ hai báo "already exists", nên installer phải `claude mcp remove -s user <name>` trước. Codex: `codex mcp add <name> [--env K=V] -- <cmd> <args>`, ghi `$CODEX_HOME/config.toml` (mặc định `~/.codex`). `CODEX_HOME` phải đã tồn tại; thêm lần hai thì ghi đè, không nhân bản. | đo với HOME/CODEX_HOME tạm; `~/.claude.json` thật không đổi |

### Documentation
README: cách dùng MCP và fallback. Viết ở Phase 7.

### Tests first
`tests/mcp-server.test.js`: dùng client của SDK nói chuyện stdio với server và Codex giả. Kiểm:
- danh sách tool;
- `begin → wait → end`;
- lỗi trả `isError`;
- server chết giữa chừng thì gọi lại vẫn tiếp tục được.

### Anti-shortcut coverage
- Test "server chết giữa chừng" phải kill tiến trình server thật, không mock.

### Implementation obligations
Server, test, và Feasibility evidence.

### Acceptance criteria
- [ ] AC-3.1: Feasibility evidence có đủ 4 dòng, mỗi dòng kèm nguồn (URL docs hoặc lệnh đo) và ngày — proven by inspection.
- [ ] AC-3.2: Test MCP pass — proven by `node --test tests/mcp-server.test.js`.
- [ ] AC-3.3: Một vòng review thật qua MCP ở Claude Code — proven by Progress Log. Phần Codex làm ở Phase 7, sau khi installer đã đăng ký.

### Focused verification
`npm ci --prefix skill-packs/codex-review && node --test tests/mcp-server.test.js`

### Phase gates
`npm ci --prefix skill-packs/codex-review && node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Checkpoint: `/codex-impl-review` trên diff Phase 3.

### Commit
`feat(mcp): expose review_begin/wait/reply/end over stdio`

## Phase 4: Review skills tự đủ, không flavor text, prompt theo phân vai

### Goal
- SKILL.md của 5 review skill tự đủ và ngắn.
- Không còn flavor text.
- Prompt plan-review và impl-review theo phân vai và chính sách giới hạn (doc nghiên cứu mục 3, 17, 18).

### Current behavior and gap
- SKILL.md trỏ tới `references/protocol.md` (168 dòng), có `json_esc`, heredoc, điều kiện recovery 5 vế, và mục "Flavor Text Triggers".
- Installer copy `shared/*` (gồm `flavor-text.md`) vào `references/`, và có comment nhắc `flavor-text.md`.
- Prompt plan-review có "Anti-Over-Engineering Rules (HARD constraints)"; prompt impl-review có "Hard Constraints". Cả hai chưa có chính sách giới hạn và chưa có loại finding `plan-gap`.

### Evidence
- `skills/codex-impl-review/SKILL.md:1–60`.
- `shared/protocol.md` (các mục Stdin, Init, Start, Render, Resume, Optional Model Selection, Poll, Operational Authority, Debate Loop, Finalize, Error Handling, Flavor Text Convention).
- `bin/codex-skill.js`, đoạn "Copy shared files into skill's references/".
- Lệnh `grep -rli flavor` liệt kê các file sau: `bin/codex-skill.js`, `shared/protocol.md`, SKILL.md của 5 review skill, và 5 bản `references/protocol.md`.

### Pattern
Placeholder lúc cài, như `{{RUNNER_PATH}}`.

### Dependencies
Phase 2 (ngữ nghĩa 4 động từ), Phase 3 (tên tool MCP).

### Files and symbols
- `shared/protocol/core.md` (mới): khoảng 15 dòng, gồm:
  - gọi MCP tools, hoặc khi không có thì gọi `node "$RUNNER" begin|wait|reply|end`;
  - làm theo `next`;
  - quy tắc model.
- `shared/protocol/apply-rebut.md` (mới): cho impl-review và plan-review.
- `shared/protocol/cross-analysis.md` (mới): cho commit-review và pr-review. Mô tả: làm phân tích độc lập từ `analysis_prompt` trước khi đọc output Codex; khi `next` là `cross_check` thì đối chiếu, rồi `reply` nếu điều kiện kết thúc của skill chưa đạt, hoặc `end` với `outcome` nếu đã đồng thuận hoặc bế tắc. Think-about dùng cùng luồng này, phần riêng ghi trong SKILL.md của nó.
- Phần riêng của think-about được gộp thẳng vào SKILL.md của nó.
- Xoá:
  - `shared/protocol.md`, `shared/flavor-text.md`;
  - 5 file `skills/*/references/protocol.md` (chưa track);
  - `skills/codex-think-about/references/question-sharpening.md`, sau khi đã gộp nội dung vào SKILL.md.
- Sửa SKILL.md của 5 review skill: bỏ `json_esc`, heredoc, "Critical Rules" lặp lại, "Flavor Text Triggers", và câu bảo đọc `claude-analysis-template.md`.
- Sửa `references/prompts.md` của plan-review và impl-review.
- `bin/lib/render-skill.js` (mới): hàm thuần `renderSkillTemplate(skillPackDir, skill, {runnerPath, skillsDir})`. Thay `{{RUNNER_PATH}}`, `{{SKILLS_DIR}}`, `{{PROTOCOL_CORE}}`, `{{PROTOCOL_VARIANT}}`; báo lỗi nếu còn `{{`. Tách ra file riêng vì `bin/codex-skill.js` chạy cài ngay khi được import.
- `bin/codex-skill.js`: gọi `renderSkillTemplate`; bỏ đoạn copy `shared/*` vào `references/` cùng comment nhắc flavor. Nhờ vậy installer cài đúng ở mọi phase sau Phase 4, không phải chờ Phase 7.

### Behavioral contract
**SKILL.md sau khi cài:**
- không còn placeholder nào;
- không nhắc `protocol.md` hay flavor;
- có quy tắc model: user nêu hoặc plan ghi theo checkpoint thì truyền ở `begin`; không nêu thì bỏ qua; runner nhớ cho các vòng sau.

**Prompt plan-review:**
- over-engineering = thêm trừu tượng, cấu hình hay khả năng không cần cho mục tiêu;
- thay một cách làm rối bằng chuẩn đã chứng minh thì không phải over-engineering;
- kiểm đề xuất chuẩn ngành (nguồn, spike, phạm vi breaking, migrate);
- chỉ ra chỗ plan đang vá trong khi có chuẩn tốt hơn, dưới dạng scope-decision;
- phía reviewer của chính sách giới hạn (doc nghiên cứu mục 3, "Prompt của codex-impl-review và codex-plan-review").

**Prompt impl-review:**
- chỉ review theo plan đã chốt;
- không đề xuất công nghệ hay kiến trúc khác;
- vấn đề thiết kế thật thì ghi category `plan-gap`;
- phía reviewer của chính sách giới hạn.

**Phân loại finding trong SKILL.md của impl-review và plan-review:**
- DISPUTE mặc định cho: "yêu cầu giới hạn không có rủi ro tài nguyên cụ thể" và "đề xuất thiết kế khác ở giai đoạn implement";
- `plan-gap` đi theo quy trình đề xuất đổi plan (doc nghiên cứu mục 18, 19).

### Documentation
README: danh sách skill, không còn flavor text. Viết ở Phase 7.

### Tests first
`tests/skill-templates.test.js` (mới). Render từng SKILL.md bằng `renderSkillTemplate` từ `bin/lib/render-skill.js`, đúng hàm installer dùng. Kiểm:
- không còn `{{`;
- không có `flavor` (không phân biệt hoa thường);
- không có `protocol.md`;
- mỗi skill có đoạn core và đúng variant.

### Anti-shortcut coverage
Test đọc file thật trong `skill-packs/`, không đọc fixture tự tạo.

### Implementation obligations
Viết lại 5 SKILL.md và 2 prompts.md. Tạo `shared/protocol/*`. Xoá các file nêu trên.

### Acceptance criteria
- [ ] AC-4.1: `grep -rli flavor skill-packs bin` rỗng ngay cuối Phase 4 — proven by lệnh grep.
- [ ] AC-4.1b: Cài vào HOME tạm bằng installer của Phase 4 thì các review skill không còn `{{`, chữ `flavor`, file `flavor-text.md` hay `protocol.md` — proven by `H=$(mktemp -d) && HOME="$H" node bin/codex-skill.js && ! grep -rli 'flavor\|{{' "$H/.claude/skills" && test -z "$(find "$H/.claude/skills" -name flavor-text.md -o -name protocol.md)"`.
- [ ] AC-4.2: Test template pass — proven by `node --test tests/skill-templates.test.js`.
- [ ] AC-4.3: Prompt có đủ các ý ở Behavioral contract — proven by inspection, liệt kê dòng trong Progress Log.
- [ ] AC-4.4: Mỗi review skill chạy được 1 vòng thật bằng bản cài tạm — proven by Progress Log. Chạy ở Phase 7, sau khi installer xong.

### Focused verification
`node --test tests/skill-templates.test.js`

### Phase gates
`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Gộp vào checkpoint sau Phase 6.

### Commit
`refactor(skills): self-contained review skills, drop flavor text, role-scoped prompts`

## Phase 5: loop-plan

### Goal
loop-plan có các thay đổi quy trình đã chốt và các luật có bằng chứng (doc nghiên cứu mục 21.3 và 21.7). Cấu trúc phase giữ nguyên.

### Current behavior and gap
`skills/loop-plan/SKILL.md` (80 dòng):
- agent tự đặt `Plan Review: APPROVE`;
- không có spike, review checkpoints, Fixed decisions;
- không có chính sách giới hạn;
- không có quy tắc chuẩn ngành;
- không có điểm dừng trao đổi với user.

### Evidence
- `skills/loop-plan/SKILL.md`.
- Doc nghiên cứu: mục 12, 13, 14, 16 ("Plan Review chỉ APPROVE khi Codex hoặc user duyệt"), 17, 18, 19, 21.3, và các pilot 1–5.

### Pattern
Giữ thứ tự heading của `loop-plan/v1`. Thêm mục cấp plan vào giữa các mục đã có, không đổi tên mục cũ.

### Dependencies
Phase 4 (tên `/codex-plan-review`, `/codex-impl-review`, quy tắc model).

### Files and symbols
- `skills/loop-plan/SKILL.md` thành template dùng chung cho hai client, có placeholder `{{CLIENT_*}}`.
- `bin/lib/render-skill.js`: thêm tham số `client` (`claude` | `codex`) để thay `{{CLIENT_*}}`. `bin/codex-skill.js` render loop skills với `client: "claude"` thay vì copy nguyên văn, để bản cài ở mọi phase không còn placeholder. Đích Codex làm ở Phase 7.
- `skills/loop-plan/agents/openai.yaml`, copy nguyên từ `~/.codex/skills/loop-plan/agents/openai.yaml`.

### Behavioral contract
**Thứ tự heading mới:**

Target, Scope, Invariants, **Fixed decisions**, Baseline (kèm thời lượng lệnh), Design and project patterns, **Feasibility evidence**, **Capacity** (chỉ khi có giới hạn, nếu không thì ghi `N/A`), Global Gates, **Review checkpoints**, Plan Review, các Phase, Completion Criteria, Progress Log.

Mỗi phase giữ 16 mục con như cũ.

**Discovery:**
- Tìm cả pattern trong repo lẫn chuẩn hiện hành.
- Pattern trong repo là nguồn rối thì trình bày hai phương án (vá hoặc làm theo chuẩn) theo mẫu quyết định.
- Giả định kỹ thuật chưa thấy chạy thật thì spike trong `.codex-review/spikes/<tên-plan>/`.
- Giả định không kiểm được thì giải quyết ngay lúc plan, bằng spike hoặc hỏi user. Plan giao cho implement không được chứa điều kiện dừng cứng dựa trên thứ không kiểm được; phần còn lại ghi thành giả định kèm mặc định và cách lùi. Điểm dừng cứng chỉ dành cho mất dữ liệu, bảo mật, hoặc hành động không đảo ngược được.

**Chính sách giới hạn, bản gọn:**
- validate tính đúng khác với giới hạn dung lượng;
- mỗi giới hạn khai đủ 4 điều;
- chạm ngưỡng thì xử lý mềm, không cắt im lặng;
- năng lực bên ngoài lấy từ nguồn hiện tại, kèm nguồn và ngày.

**Thang test:** mỗi AC có một lệnh hẹp; phase gate nhẹ; full suite chỉ nằm trong Global Gates.

**Review checkpoints:** đặt review sau phase dựng contract, schema, migration, trạng thái hoặc luồng tiền, và một checkpoint cuối. Ghi model nếu user muốn.

**Quality:**
- Bỏ "intent-fidelity review" và "plan self-review" dạng dài. Thay bằng tự kiểm ngắn: mọi AC có test và lệnh hẹp; mọi giả định rủi ro có Feasibility evidence hoặc đã được user quyết.
- Không thêm luật tự kiểm nào khác: mục 21.7 của doc nghiên cứu kết luận pilot 5 không đạt ngưỡng.
- `Plan Review` để `pending`. Chỉ đổi thành `APPROVE (codex-plan-review <session> | user <ngày>)` khi có một trong hai nguồn đó.

**Trao đổi với user:** 3 điểm dừng ngắn:
1. sau Discovery: nhắc lại mục tiêu, phần ngoài phạm vi, giả định;
2. sau spike: các quyết định thiết kế chính;
3. handoff: câu chuyện implement bằng lời thường, các checkpoint, rủi ro còn lại.

Mỗi quyết định trình bày theo mẫu 5 phần (doc nghiên cứu mục 19), mỗi lần một quyết định.

**Tên file plan:** giữ quy tắc tên mô tả, viết thành một câu.

### Documentation
Không có tài liệu riêng. SKILL.md chính là tài liệu.

### Tests first
`tests/loop-skills.test.js` (mới). Render template cho cả hai client. Kiểm:
- có đủ các heading mới theo đúng thứ tự;
- không còn `{{`;
- bản Codex dùng `$loop-implement` và không nhắc `CLAUDE.md`;
- không có chữ `APPROVE` nào được agent tự đặt sau self-review;
- độ dài không quá 1,4 lần bản hiện tại (80 dòng, tức ≤ 112 dòng).

### Anti-shortcut coverage
Test độ dài và heading chặn việc viết lan man. Phần nội dung được kiểm ở review checkpoint.

### Implementation obligations
Viết template loop-plan, theo Behavioral contract.

### Acceptance criteria
- [ ] AC-5.1: Test loop-skills cho loop-plan pass — proven by `node --test tests/loop-skills.test.js`.
- [ ] AC-5.2: Mỗi thay đổi ở mục 21.3 (cột "Skill" có `plan`) đều có câu tương ứng trong SKILL.md — proven by bảng đối chiếu trong Progress Log.
- [ ] AC-5.3: Không có luật nào ở bảng "Không đưa vào" của mục 21.3 — proven by inspection.

### Focused verification
`node --test tests/loop-skills.test.js`

### Phase gates
`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Gộp vào checkpoint sau Phase 6.

### Commit
`feat(loop-plan): checkpoints, spikes, fixed decisions, sourced approval, user decision points`

## Phase 6: loop-implement

### Goal
loop-implement được tinh giản theo mục 15 của doc nghiên cứu, kèm các luật thực thi có bằng chứng.

### Current behavior and gap
`skills/loop-implement/SKILL.md` (49 dòng):
- ghi sổ ở 4 chỗ;
- bước 7 tự xử lý finding, trùng với review skill;
- review mọi phase;
- chạy phase gate kèm smoke;
- chưa có kỷ luật gate;
- chưa có quy trình đề xuất đổi plan.

### Evidence
- `skills/loop-implement/SKILL.md`.
- Doc nghiên cứu: mục 13, 14, 15, 18, 21.3; pilot 2–5.

### Pattern
Giữ 4 khối: Admission, Phase loop, Finalization, Stop/Report.

### Dependencies
Phase 4, Phase 5 (heading mới của plan).

### Files and symbols
- `skills/loop-implement/SKILL.md` thành template hai client.
- `skills/loop-implement/agents/openai.yaml`, copy từ `~/.codex/skills`.

### Behavioral contract
**Admission:**
- Plan có `Plan Review: APPROVE` kèm nguồn, và còn phase chưa xong.
- Plan bị sửa sau khi approve thì hỏi.

**Mỗi phase:**
1. Đọc lại phase. Chỉ kiểm lại path hoặc symbol mà code sắp đụng.
2. Viết test và thấy đỏ, ghi một dòng.
3. Code đủ nghĩa vụ production.
4. Chạy lệnh hẹp, rồi phase gate.
5. Xem staged diff một lần: phạm vi, secret, tàn dư tên cũ.
6. Commit, kèm một dòng progress và nhật ký lệch.

Bỏ trạng thái `in_progress` trung gian, và bỏ commit riêng chỉ để ghi sổ.

**Review:** tại các checkpoint của plan, bằng `/codex-impl-review`, truyền model theo plan. Quy tắc xử lý finding nằm ở review skill, không lặp lại ở đây.

**Kỷ luật gate:**
- gate không chạy được thì phải tìm cách chạy, không ghi "blocked" rồi đi tiếp;
- lỗi đã đỏ sẵn ở baseline thì so với baseline, ghi lại, đi tiếp;
- chỉ lỗi mới mới chặn.

**AC còn dở:** báo `not done` kèm lý do.

**Không tự thêm ngoài plan:** công nghệ, dependency, giới hạn, cơ chế.
- Vấn đề thật lộ ra lúc implement thì đề xuất đổi plan theo mẫu 5 phần.
- User đồng ý thì ghi vào plan kèm ngày, không chạy lại plan-review.

**Finalization:**
- full suite (Global Gates) một lần;
- tự audit tích hợp trên diff cộng dồn;
- review checkpoint cuối;
- lỗi thì sửa theo thang test, bắt đầu từ test hẹp, không chạy lại full suite ngay.

**Stop:**
- chỉ dừng cho quyết định thật của user, thiếu hạ tầng bắt buộc, yêu cầu mâu thuẫn không giải được, hoặc hành động không đảo ngược mà plan không cho phép;
- mỗi lần hỏi một câu theo mẫu 5 phần.

### Documentation
Không có tài liệu riêng.

### Tests first
Mở rộng `tests/loop-skills.test.js` cho loop-implement. Kiểm:
- có đủ 4 khối;
- nhắc `/codex-impl-review` (bản Codex: `$codex-impl-review`, nếu Phase 7 xác nhận bản Codex có review skill);
- không còn "in_progress";
- không có "record blocked";
- độ dài ≤ 49 × 1,2 ≈ 59 dòng, theo mục tiêu "không nhiều bước hơn".

### Anti-shortcut coverage
Như Phase 5.

### Implementation obligations
Viết template loop-implement.

### Acceptance criteria
- [ ] AC-6.1: Test loop-skills cho loop-implement pass — proven by `node --test tests/loop-skills.test.js`.
- [ ] AC-6.2: Mỗi dòng của bảng mục 15 và mỗi thay đổi có `implement` ở mục 21.3 đều có câu tương ứng — proven by bảng đối chiếu trong Progress Log.

### Focused verification
`node --test tests/loop-skills.test.js`

### Phase gates
`node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/`

### Review
Checkpoint: `/codex-impl-review` trên diff Phase 4–6.

### Commit
`feat(loop-implement): checkpoint reviews, gate discipline, honest not-done, plan-change proposals`

## Phase 7: Installer, bản Codex, tài liệu

### Goal
Một lệnh cài đủ cho Claude Code và Codex:
- skill đã gộp protocol;
- loop skills cho hai client;
- MCP server có dependency và đã đăng ký;
- dọn bản cũ.

### Current behavior and gap
- Installer chỉ cài vào `~/.claude/skills`.
- Copy `shared/*` vào `references/`.
- Không cài dependency, không đăng ký MCP.
- `CLAUDE.md` còn nguyên tắc "SKILL.md ~40–70 dòng" và "Node stdlib only".
- Runner còn nhánh nhận dạng format security và codebase (`codex-runner.js:677`, `:727`, cùng `fieldMapping`).

### Evidence
- `bin/codex-skill.js:29–46` (`RUNNER_SKILLS`, `PLAIN_SKILLS`, `REMOVED_SKILLS`, `CLEANUP_DIRS`).
- `:90–200` (vòng cài và swap).
- `CLAUDE.md` (Design Principles, Key Design Decisions).

### Pattern
Giữ staging, swap nguyên tử và rollback (I6).

### Dependencies
Phase 1–6.

### Files and symbols
**`bin/codex-skill.js`:**
- mở rộng `renderSkillTemplate` (`bin/lib/render-skill.js`) cho đích Codex;
- đích Codex `~/.codex/skills`, tôn trọng `CODEX_HOME` nếu docs Codex xác nhận biến này;
- copy `scripts/lib/`;
- cài dependency MCP: copy `package.json` và `package-lock.json` của Phase 3 vào thư mục cài `codex-review/`, rồi `npm ci --omit=dev` ở đó. File này thay cho `{"type":"module"}` installer đang tự ghi;
- đăng ký MCP cho hai client theo cú pháp đã kiểm ở Phase 3.

Không cần thêm `flavor-text.md` hay `protocol.md` vào danh sách dọn: swap nguyên tử thay cả thư mục skill, nên file cũ trong `references/` không sống sót. Install-check chứng minh điều này (xem Behavioral contract).

**Bản codex-review không do repo quản lý trong `~/.codex/skills`:** thay bằng bản do installer render, nhưng sao lưu trước. Nếu không xác định được nguồn gốc thì không xoá; dừng và báo.

**`codex-runner.js`:** bỏ nhánh `codebase-validation`, `codebase-cross` và `security-review` trong `parseOutputMarkdown` và `fieldMapping`.

**Tài liệu và manifest:**
- `tests/install-check.mjs` (mới);
- `manifest.json`, `README.md`;
- `CLAUDE.md`: bảng lệnh v14, Breaking Changes v14, sửa 2 nguyên tắc.

### Behavioral contract
Sau khi cài vào một HOME tạm:
- Có đủ 7 skill ở `~/.claude/skills`, và loop-plan, loop-implement ở `~/.codex/skills`. Có review skill bản Codex nếu Phase 3 xác nhận Codex gọi được MCP.
- Không còn placeholder, flavor text hay `protocol.md`. Kể cả khi HOME tạm đã có sẵn một bản cài cũ giả lập, chứa `codex-plan-review/references/flavor-text.md` và `references/protocol.md`, trước lúc cài.
- `codex-review/scripts/` có runner, `lib/`, `mcp-server.js` và `node_modules` của SDK.
- MCP đã đăng ký ở cả hai client. Đăng ký chạy lại nhiều lần vẫn cho cùng kết quả, không nhân bản.
- Không ghi vào HOME thật khi `HOME` trỏ tới thư mục tạm.

### Documentation
README và CLAUDE.md như trên.

### Tests first
`tests/install-check.mjs` nhận HOME tạm và kiểm mọi điều ở Behavioral contract. Ca nâng cấp từ bản cài cũ: một test trong `tests/` dựng bản cài cũ giả lập trong HOME tạm, chạy installer, rồi gọi install-check.

### Anti-shortcut coverage
Install-check đọc file cài thật và gọi `node runner version`. Nó không suy từ output của installer.

### Implementation obligations
Như Files and symbols. Sau đó chạy AC-4.4, AC-3.3 (phần Codex), và một vòng loop-plan ngắn bằng bản cài tạm để chắc skill tải được.

### Acceptance criteria
- [ ] AC-7.1: Global Gate 2 exit 0 — proven by lệnh.
- [ ] AC-7.2: Cài 2 lần liên tiếp vào cùng HOME tạm thì không nhân bản đăng ký MCP — proven by install-check.
- [ ] AC-7.3: Mỗi review skill chạy 1 vòng thật từ bản cài tạm, cả qua MCP và qua fallback bash cho ít nhất 1 skill — proven by Progress Log.
- [ ] AC-7.4: `CLAUDE.md` không còn "Node.js stdlib only" và "~40–70 lines" như nguyên tắc — proven by grep.

### Focused verification
`H=$(mktemp -d) && HOME="$H" CODEX_HOME="$H/.codex" node bin/codex-skill.js && node tests/install-check.mjs "$H"`

### Phase gates
Như Global Gates.

### Review
Checkpoint cuối: `/codex-impl-review` trên diff cộng dồn từ `51d4351`.

### Commit
`feat(installer): install for Claude Code and Codex, register MCP, render self-contained skills`

## Completion Criteria
- [ ] 7 phase đã commit trên `main`, chưa push.
- [ ] Global Gates exit 0 trên HEAD cuối.
- [ ] Mọi review checkpoint có verdict APPROVE từ Codex, hoặc finding còn lại đã được user quyết.
- [ ] Có bảng đối chiếu giữa mục 21.3 của doc nghiên cứu và SKILL.md trong Progress Log.
- [ ] Chưa cài vào HOME thật và chưa push. Cả hai việc đều chờ user.

## Progress Log
- 2026-10-15: plan tạo từ mục 21 của doc nghiên cứu.
- 2026-10-15: pilot 5 không đạt ngưỡng (mục 21.7). Phase 5 chỉ thêm luật "giải quyết giả định lúc plan, không có điểm dừng cứng dựa trên thứ không kiểm được". Không thêm luật "gate xanh trong phase" và "đối chiếu chéo AC".
- 2026-10-15: codex-plan-review APPROVE sau 2 vòng. Đã sửa: bảng template theo skill/mode cho `reply`; STALEMATE và `suggested_status` trong `computeNext`; skill peer dùng `cross_check`, không tự kết thúc theo verdict Codex; chuẩn bị SDK ngay ở Phase 3; bỏ flavor khỏi installer ngay ở Phase 4 qua `bin/lib/render-skill.js`.
- 2026-10-15: user quyết không tạo nhánh, không giữ WIP thành commit riêng; WIP không dùng thì xoá. Sửa I3, I4 và Completion Criteria theo đó.
- 2026-10-15 Phase 1 xong. Red: test finalize "vòng cuối thiếu verdict" đỏ trước khi sửa `cmdFinalize`. `node --test tests/parse-verdict.test.js` 17/17 pass; ba test cũ pass.
  - Ngoài các dạng trong plan, parser nhận thêm 3 dạng thấy trong output thật: dòng `**VERDICT**` đứng riêng, heading có chữ Verdict kèm `: STATUS`, và status trần ở dòng đầu dưới heading verdict.
  - AC-1.3, quét `~/projects` (925 `review.md`): 15 output có chữ VERDICT mà không có status, gồm 11 output JSON kiểu cũ (prompt hiện tại không sinh ra) và 4 output văn xuôi không có từ status. Với các output này, đường `missing_verdict → ask_user` là hành vi đúng. AC-1.3 đạt cho mọi output theo đúng định dạng markdown của prompt; không đạt nguyên văn "0 output".
  - So parser cũ với mới trên cùng 925 file: 751 file đổi từ `unknown` sang có verdict (749 APPROVE, 1 REVISE, 1 CONSENSUS); không file nào đổi kết quả theo hướng khác.
- 2026-10-15 Phase 2 xong. `node --test tests/review-core.test.js` 28/28 pass; full gate 45/45; ba test cũ pass không sửa.
  - Test viết sau code, nên thay cho bằng chứng red tôi làm 3 lần cố ý làm hỏng code. Skill peer kết thúc theo verdict → 5 test fail. `reply` bỏ model đã lưu → 8 fail. Thiếu verdict thành `done` → 1 fail.
  - Cách hiện thực lõi: `lib/review-core.js` gọi các lệnh cấp thấp của runner (init, render, start, poll, resume, finalize, stop) qua tiến trình con, không tách và chép lại logic của các hàm `cmd*`. Hành vi lệnh cũ giữ nguyên (I1); CLI và MCP server dùng chung một lõi.
  - Model và effort lưu ở khoá `model`/`effort` trong `state.json` (`start` luôn ghi; `resume` ghi khi có `--model`). Skill, mode và `skills_dir` do `begin` ghi.
  - `wait` poll theo nhịp 120 giây như `poll` mặc định, vì runner tính một tick stall cho mỗi lần poll không có output mới. Khi tiến trình Codex đã thoát thì poll ngay. Mặc định `--max-wait` là 110 giây, vừa với timeout 120 giây mặc định của lệnh Bash.
  - AC-2.5: chạy 1 vòng thật impl-review (working-tree, effort low) trên repo tạm có diff nhỏ. `begin → wait → end` cho `completed`, `next: done`, verdict APPROVE (format `review`, không có block), `end` finalize với APPROVE, `.codex-review/.gitignore` = `*`.
- 2026-10-15 Checkpoint sau Phase 2: `/codex-impl-review` (branch, base `51371a3`, effort high), chạy bằng chính `begin/wait/reply/end` mới, session `codex-impl-review-20261015-001`. APPROVE sau 2 vòng.
  - Vòng 1: 4 issue, đều ACCEPT và đã sửa ở `c923f13`: `wait` mất activities, input CRLF, block ISSUE nuốt `## VERDICT`, `skillsDir` tương đối. Mỗi issue có test hồi quy; cả 4 test đỏ trên code cũ.
  - Codex nhận định việc lõi gọi runner qua tiến trình con là "acceptable adaptation".
- 2026-10-15 Phase 3 xong. `tests/mcp-server.test.js` 5/5 pass: 4 tool, begin → wait → end, `isError`, server bị kill vẫn tiếp tục được, mặc định wait lấy từ env. Thiếu SDK thì file test fail kèm hướng dẫn `npm ci`, không skip. `npm ci --prefix skill-packs/codex-review` chạy được từ lock.
  - Codex giả được tách ra `tests/helpers/fake-codex.js`, dùng chung cho hai bộ test.
  - AC-3.3: `claude -p --mcp-config <file tạm> --strict-mcp-config` (không đăng ký vào config thật) gọi `review_begin → review_wait → review_end` trên repo tạm. Kết quả `completed`, `next: done`, APPROVE; `meta.json` có verdict APPROVE, runner v14.
  - Spike Claude làm reviewer: khả thi. `claude -p` trả `session_id`; `--resume <id>` giữ được ngữ cảnh giữa các vòng. Read-only chỉ đảm bảo khi mọi lần gọi, kể cả resume, đều truyền giới hạn tool (`--allowedTools Read,Grep,Glob,...` và `--disallowedTools Edit,Write,NotebookEdit`). Lần resume không có giới hạn đã tạo được file. Thiết kế tối thiểu nếu làm: runner thêm backend `claude` ở `launchCodex`, luôn kèm hai cờ đó, và lấy `session_id` thay cho `thread_id`. Đây là phạm vi mới, chờ user quyết; chưa làm.
- 2026-10-15 Checkpoint sau Phase 3: `/codex-impl-review` (branch, base `e0078ae`, effort high), session `codex-impl-review-20261015-002`. APPROVE sau 2 vòng.
  - Vòng 1: 1 issue, ACCEPT: `review_end` báo finalize lỗi mà không có `isError`. Đã sửa ở `72d3e87`, CLI `end` cũng exit khác 0 trong trường hợp này. Có 2 test hồi quy, cả hai đỏ trên code cũ.
- 2026-10-15 Phase 4 xong. Full gate: ba test cũ pass, `node --test tests/` 62/62. `tests/skill-templates.test.js` 4/4; 3 trong 4 test đỏ trên SKILL.md cũ.
  - Tạo `shared/protocol/{core,apply-rebut,cross-analysis}.md` và `bin/lib/render-skill.js`. Installer render 5 review skill và báo lỗi khi thiếu placeholder hoặc còn `{{`; không chép `shared/*` nữa. SKILL.md sau khi cài dài 51–60 dòng.
  - Đã xoá: `shared/protocol.md`, `shared/flavor-text.md`, 5 file `references/protocol.md`, và `codex-think-about/references/question-sharpening.md`. Phần làm rõ câu hỏi chuyển vào SKILL.md của think-about.
  - Sửa thêm ngoài danh sách: bảng template của think-about trong `review-core.js` khai báo `sandbox: "danger-full-access"`, và `begin` truyền `--sandbox`. Lý do: think-about cũ chạy Codex có mạng để tìm trên web. Có test cho việc này.
  - AC-4.1: `grep -rli flavor skill-packs bin --exclude-dir=node_modules` rỗng. Bản grep nguyên văn có trúng file test của zod trong `skill-packs/codex-review/node_modules`; thư mục này bị gitignore và không phải mã của repo.
  - AC-4.1b: lệnh trong AC chạy trên HOME tạm cho kết quả sạch.
  - AC-4.3, theo dòng:
    - impl `prompts.md`:
      - L78 và L140: `plan-gap`.
      - L83 và L145: "Limits and capacities".
      - L179 và L213: mục 6 của rebuttal (không đề xuất công nghệ hay kiến trúc khác; dùng `plan-gap`).
    - `output-format.md`: thêm category `plan-gap`.
    - plan `prompts.md`:
      - L59–65: "Standards and Over-Engineering" (định nghĩa lại over-engineering, kiểm bằng chứng khi đổi sang chuẩn, chuyện vá thay cho chuẩn nêu thành `scope`).
      - L67–70: "Limits and Capacities".
- 2026-10-15 Phase 5 xong. Full gate: ba test cũ pass, `node --test tests/` 67/67. `tests/loop-skills.test.js` 5/5. Trên SKILL.md cũ 4/5 test đỏ; test còn lại (client lạ bị từ chối) chỉ kiểm renderer.
  - `render-skill.js` có thêm `CLIENTS` (`CLIENT_SKILL` là `/` hoặc `$`, `CLIENT_INSTRUCTIONS`). Installer render loop skills với `client: "claude"`. `agents/openai.yaml` chép nguyên từ `~/.codex/skills/loop-plan`.
  - loop-plan dài 110 dòng (giới hạn 112). Schema vẫn `loop-plan/v1`; các mục mới chỉ chèn vào, không đổi tên mục cũ.
  - Khi đối chiếu AC-5.3, tôi bỏ "Baseline ghi kết quả gate hiện tại" khỏi bản nháp, vì đó là luật "chạy gate ở baseline lúc plan" trong bảng "Không đưa vào". Baseline chỉ còn ghi thời lượng lệnh.
  - AC-5.2, đối chiếu mục 21.3 (các dòng có `plan`) với SKILL.md:

    | Thay đổi ở 21.3 | Câu trong SKILL.md |
    |---|---|
    | APPROVE chỉ từ codex-plan-review hoặc user, kèm nguồn | Quality and review, bullet `Plan Review` stays `pending`… |
    | Review checkpoints, kèm model | Mục `Review checkpoints` trong danh sách heading; phase block, mục `### Review` |
    | Thang test và thời lượng ở Baseline | "Test ladder: …" sau phase block; bullet `Baseline` |
    | Spike và Feasibility evidence | Discovery bước 4; bullet `Feasibility evidence` |
    | Giải quyết giả định lúc plan, không có điểm dừng cứng không kiểm được | Discovery bước 5 |
    | Chuẩn ngành: hai phương án theo mẫu quyết định | Discovery bước 3; Talking with the user, điểm dừng 2 |
    | Fixed decisions | Bullet `Fixed decisions` |
    | Chính sách giới hạn, bản gọn | Mục Limits; bullet `Capacity` |
    | 3 điểm dừng, mẫu 5 phần | Mục Talking with the user |

  - AC-5.3: không có Impact map, Failure modes, bảng State and lifecycle, luật chạy gate ở baseline hay cấm thu hẹp suite, checklist bẫy, hay bắt buộc test đột biến. Phần tự kiểm chỉ còn 2 ý mà Behavioral contract cho phép.
