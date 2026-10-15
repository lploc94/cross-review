# cross-review dashboard: xem phiên review và cài đặt reviewer

## Plan schema
loop-plan/v1

## Target
Một web UI chạy cục bộ để:
1. Xem các phiên review ở dạng người đọc được: phiên nào đang diễn ra, lịch sử, từng phiên kể lại thành cuộc trao đổi giữa reviewer và agent, issue nào đi qua những bước nào, và reviewer đang làm gì (cập nhật trực tiếp).
2. Cài đặt reviewer, model và effort ở hai mức, global và từng workspace, kèm override theo skill. Runner dùng các giá trị này làm mặc định cho phiên mới.
3. Đặt avatar cho từng bên: You, reviewer, agent.
4. Tuỳ chọn "Follow reviews": khi bật, mỗi review bắt đầu sẽ tự mở trang của phiên đó trong trình duyệt để user theo dõi. Dashboard chưa chạy thì tự khởi động.

Giao diện làm **giống hệt mock** `mockups/dashboard.html` (bản ngày 2026-10-15, có mục Avatars). Mock là nguồn sự thật về bố cục, chữ, màu, khoảng cách và tương tác. Chỗ dữ liệu thật buộc phải khác mock được liệt kê ở `Fixed decisions` (D14).

Hai cách chạy:
- `npx github:lploc94/cross-review dashboard [--root <dir>] [--port <n>] [--no-open]`
- `node ~/.claude/skills/cross-review/scripts/review-runner.js dashboard [...]`

Server chỉ nghe ở `127.0.0.1`, trên một cổng ngẫu nhiên còn trống trong dải 20000–30000, và đòi token cho mọi request. Chạy bằng lệnh thì Ctrl-C là dừng. Bản được "Follow reviews" tự khởi động sẽ tự tắt sau 30 phút không có trang nào mở.

## Scope
Trong phạm vi:
- **Runtime ghi thêm dữ liệu cho dashboard:**
  - input gốc của từng round;
  - caller (MCP `clientInfo`);
  - `ended_at`;
  - thời điểm từng dòng event (watchdog ghi);
  - nguồn của reviewer/model/effort.
- **Mô hình phiên** (thuần, đọc file): trạng thái, tiêu đề, lịch sử từng issue (ledger), chuỗi bước, activity diễn đạt thành câu.
- **Server** HTTP stdlib: quét workspace, API JSON, SSE, phục vụ UI tĩnh, chống DNS rebinding và CSRF.
- **UI** vanilla JS:
  - Sessions: nhóm "In progress" cập nhật trực tiếp, cùng bảng History có bộ lọc và tìm kiếm;
  - trang chi tiết phiên, kèm activity trực tiếp trong round đang chạy;
  - Settings: global/workspace, per-skill, Avatars;
  - route bằng hash.
- **Config hai mức**: runner đọc config này khi `begin`. Danh sách model lấy qua adapter codex (`codex debug models`), có đường dự phòng khi lệnh lỗi.
- Avatar do người dùng tải lên, lưu ở `~/.cross-review/avatars/`.
- "Follow reviews" (khoá config `open_dashboard`):
  - `begin` tìm dashboard đang chạy qua file `~/.cross-review/dashboard.json`, không có thì khởi động một bản chạy tách rời;
  - đăng ký workspace của phiên với dashboard;
  - mở trình duyệt tới trang của phiên;
  - trả `dashboard_url` trong kết quả của `begin`.
- Docs: README, CLAUDE.md, `core.md` (luật model/effort), `manifest.json` 10.1.0.

Ngoài phạm vi:
- Thao tác trên phiên từ UI: stop, resume, reply, xoá.
- Reviewer khác Codex.
- Chạy nền/daemon, xác thực người dùng, truy cập từ máy khác.
- Đọc phiên tạo trước bản này: không cần tương thích ngược, theo quyết định của user 2026-10-15. Phiên cũ vẫn hiện, chỉ thiếu phần dữ liệu mới (giờ của activity, caller, lời reply của agent).
- Index toàn cục các workspace.
- Đóng gói logo của Codex/Claude hay bất kỳ font nào.

## Invariants
- **Dashboard chỉ đọc phiên.**
  - Không bao giờ gọi `poll`, `stop`, `resume`, `finalize`. Đặc biệt `poll` có ghi `state.json` (đếm stall) và có thể kill process.
  - Không ghi gì vào thư mục phiên.
  - Chỉ ghi vào: `~/.cross-review/config.json`, `<workspace>/.cross-review/config.json`, `<workspace>/.cross-review/.gitignore` (khi thiếu), `~/.cross-review/avatars/` và `~/.cross-review/dashboard.json` (file mode 0600).
- **Follow reviews không bao giờ làm hỏng review.** Mọi lỗi khi tìm, khởi động, đăng ký hay mở trình duyệt chỉ được ghi vào `dashboard_error` trong kết quả `begin`. Phiên vẫn chạy bình thường.
- **Phạm vi file server đọc được.**
  - Thư mục phiên: chỉ những phiên nằm trong danh sách đã quét.
  - Tên file: chỉ một tập tên cố định.
  - Không nhận đường dẫn tuỳ ý từ request.
- **Hành vi review hiện có giữ nguyên.** `begin/wait/reply/end`, mã exit, `computeNext`, deadline và stall hoạt động như cũ. Thay đổi duy nhất về hành vi:
  - `begin` lấy giá trị mặc định từ config;
  - watchdog thoát khi reviewer đã kết thúc.
- **Runner vẫn chỉ dùng stdlib.** Dashboard cũng chỉ dùng stdlib, không thêm dependency.
- **Thứ tự ưu tiên của config:**
  1. tham số được truyền rõ (`model`/`effort`/`reviewer`, tức user nói trong chat hoặc checkpoint của plan chỉ định);
  2. workspace, theo skill;
  3. workspace;
  4. global, theo skill;
  5. global;
  6. mặc định: model của reviewer CLI, effort `high`, reviewer `codex`.

  Mỗi khoá (`reviewer`, `model`, `effort`) được tính độc lập.
- **Không lộ dữ liệu thật của user** (user yêu cầu 2026-10-15). Mock, fixture, dữ liệu demo, ảnh chụp, ví dụ trong docs và test chỉ dùng dữ liệu tổng hợp: tên workspace, tiêu đề, prompt, review, lệnh và output đều bịa. Không chép file nào từ `.cross-review/sessions/` thật hay từ thư mục dự án khác của user vào repo. Test và ảnh chụp chạy dashboard với `--root` là thư mục tạm chứa fixture (`buildFixture`), không bao giờ quét `~` hay `~/projects`; ảnh chụp lưu ở thư mục tạm hoặc `.cross-review/` (bị gitignore), không commit.
- **Config hỏng thì `begin` báo lỗi.** Mã lỗi là `CONFIG_INVALID`, kèm đường dẫn file và lý do. Không lặng lẽ bỏ qua config.

## Fixed decisions
| # | Quyết định | Lý do |
|---|---|---|
| D1 | Server dùng `node:http` thuần, UI là vanilla JS/CSS dạng ES module, không bước build | Runner chỉ dùng stdlib; một người dùng, cục bộ; không cần thêm dependency |
| D2 | Bind `127.0.0.1`. Cổng ngẫu nhiên đều trong [20000, 30000]: bận (`EADDRINUSE`) thì thử cổng khác, tối đa 50 lần, rồi báo lỗi; `--port <n>` thì dùng đúng cổng đó. In URL kèm token; tự mở trình duyệt, tắt bằng `--no-open` | User chốt 2026-10-15: cổng bất kỳ trong dải 20k–30k chưa bị chiếm |
| D3 | Quét `--root` (mặc định cwd) và tối đa 3 cấp con. Một workspace là thư mục có `.cross-review/sessions/`. Bỏ qua thư mục ẩn, `node_modules` và symlink | User chốt 2026-10-15, không dùng index toàn cục. Spike: `~/projects` có 969 thư mục, quét mất 100ms |
| D4 | Route bằng hash, có 5 dạng: `#/`, `#/s/<ws>/<session>`, `#/s/<ws>/<session>/ISSUE-<n>`, `#/settings`, `#/settings/<ws>`. Trong đó `<ws>`, sau encodeURIComponent, là đường dẫn tương đối so với root (chính root ghi là `.`), hoặc đường dẫn tuyệt đối nếu workspace được `begin` đăng ký và nằm ngoài vùng quét | User chốt 2026-10-15. F5, nút Back và link phiên đều đúng; server chỉ cần trả một trang |
| D5 | Live update dùng SSE (`EventSource`). Server so stat file mỗi giây và đọc phần mới của `output.jsonl` theo byte offset. Mỗi lần kết nối (kể cả tự kết nối lại), server gửi `snapshot` trước; client tải lại trang activity và gộp sự kiện live theo khoá `${round}:${item.id}`, nên mất kết nối không làm mất hay lặp dòng (Phase 4) | Theo chuẩn WHATWG; một chiều là đủ; tự kết nối lại |
| D6 | Ba lớp bảo vệ.<ul><li>**Token:** mỗi lần chạy sinh token ngẫu nhiên 32 byte (`crypto.randomBytes`, hex). URL in ra hoặc mở ra có dạng `/?t=<token>#…`. Server so khớp bằng `timingSafeEqual`, đặt cookie `cr_token` (`HttpOnly; SameSite=Strict; Path=/`) rồi chuyển hướng 303 về URL không còn token. Mọi request khác, kể cả file tĩnh, API, SSE và avatar, đều phải có cookie hoặc `Authorization: Bearer <token>` (dùng cho `begin`); thiếu thì 401 với trang chữ "Open the dashboard from the link printed in the terminal".</li><li>**Host:** `Host` phải là `127.0.0.1:<port>` hoặc `localhost:<port>`, sai thì 403 (chống DNS rebinding).</li><li>**Request ghi:** phải là `POST`/`DELETE`, có `Origin` trùng gốc của dashboard (trừ lời gọi có Bearer từ `begin`), body JSON (riêng avatar là ảnh).</li></ul>Thêm CSP `default-src 'self'; img-src 'self' data:`, không có inline script và inline style | User yêu cầu token. MCP spec, mục Transports Security Warning (kiểm `Origin`, bind localhost); OWASP CSRF Cheat Sheet (kiểm origin, cookie SameSite) |
| D7 | Config gồm `~/.cross-review/config.json` (global) và `<workspace>/.cross-review/config.json`. Schema: `{reviewer?, model?, effort?, skills?: {<skill>: {model?, effort?}}}`. Khoá lạ là lỗi | User chốt hai mức. Đặt file trong `.cross-review/` vì thư mục này đã tự ignore khỏi git |
| D8 | Logic config nằm ở `scripts/lib/config.js`, dùng chung cho `review-core.beginSession` và dashboard. `state.json` lưu thêm `settings_sources: {reviewer, model, effort}` | Một nguồn sự thật; trang chi tiết hiện được nguồn gốc của giá trị (mock: "xhigh · workspace, review-impl") |
| D9 | Mọi thứ riêng của Codex nằm trong adapter `reviewers/codex.js`:<ul><li>`listModels()` (`codex debug models`, lỗi thì thử `--bundled`, lỗi nữa thì `null`)</li><li>`defaultModel()` (khoá `model` ở cấp trên cùng của `$CODEX_HOME/config.toml`)</li><li>`cliInfo()` (`codex --version`, `codex login status`)</li><li>`activityItems(lines)` (chuẩn hoá event)</li></ul> | Đúng nguyên tắc adapter trong CLAUDE.md. `debug models` là lệnh debug, có thể đổi, nên phải có đường dự phòng |
| D10 | Watchdog ghi `outputs/times-round-NNN.jsonl`: mỗi giây, khi số dòng hoàn chỉnh của `output.jsonl` tăng, thêm một dòng `[soDong, epochGiay]`. Reviewer chết thì kiểm lần cuối rồi `exit(0)`. Timeout vẫn kill và ghi marker như cũ | Log JSONL của Codex không có timestamp (spike 2026-10-15). Watchdog vốn sống suốt round. Đọc rollout nội bộ trong `~/.codex/sessions` thì dễ vỡ |
| D11 | `begin`/`reply` lưu input markdown gốc vào `inputs/round-NNN.md`, ghi sau khi start/resume thành công. `end` ghi `ended_at` và `end_outcome` (`finalized`/`stopped`); `reply` thành công thì xoá hai trường này. MCP `review_begin` lưu `caller` = `{name, title, version}` lấy từ `server.server.getClientVersion()` | Cần cho lời reply của agent, ledger, phân loại xong/chưa xong và avatar agent. Spike: Claude Code gửi `title: "Claude Code"`, Codex gửi `title: "Codex"` |
| D12 | Icon lấy từ Lucide (`lucide-static` 1.57.0, giấy phép ISC): chép path SVG vào `ui/icons.js`, kèm nguyên văn LICENSE ở `ui/LICENSE-lucide.txt` (có phần MIT của Feather). Logo hai ô vuông là hình tự vẽ. Font chỉ dùng stack có sẵn trong hệ điều hành, không đóng gói file font | User yêu cầu không dùng thứ có bản quyền. ISC cho phép dùng nếu kèm notice. Gọi tên font hệ thống không phải là phát hành lại font |
| D13 | Không đóng gói logo Codex/Claude. Avatar do user tự tải lên. Khi chưa tải, dùng ảnh mặc định do user cung cấp (2026-10-15, ảnh tạo bằng AI): cú cho reviewer, vịt cho agent, chó shiba cho You, lưu ở `ui/avatars/{reviewer,agent,you}.png` (256px) cùng bản toàn thân `*-full.png` (480px); chữ cái chỉ còn là dự phòng khi ảnh không tải được. Khoá avatar: `you`, `reviewer:<name>`, `agent:<clientInfo.name>`. Chỉ nhận PNG/JPEG/WebP/GIF (kiểm magic bytes), tối đa 1 MB, không nhận SVG | User chọn 2026-10-15. Logo là nhãn hiệu; SVG có thể chứa script |
| D14 | Chỗ dữ liệu thật khác mock:<ul><li>Test chỉ hiện "passed" hoặc "failed (exit N)" vì không có số test.</li><li>Dòng "Built a throwaway repo…" thành "Worked in a scratch dir `cmd`".</li><li>"Thinking:" lấy từ `agent_message` trung gian và `reasoning`.</li><li>Bỏ ô chọn demo "show as".</li><li>Header thay "mock data" bằng `pack <version>`.</li><li>Mục gợi ý trong thẻ finding có nhãn "Suggested fix", lấy từ `suggested_fix`.</li></ul> | Không bịa dữ liệu |
| D15 | Nhãn trạng thái (bảng 1): xem Phase 2. Phiên "agent's turn" quá 24 giờ không có hoạt động thì vào History với nhãn "no reply". Phiên đã dừng nhưng resume được thì ở "In progress" trong 24 giờ | Giữ "In progress" chỉ gồm việc user còn xử lý được. Protocol cho phép resume phiên đã dừng |
| D16 | **Follow reviews.** Khoá config `open_dashboard` (boolean, đặt được ở cả global và workspace, resolve như các khoá khác, mặc định `false`).<br>Dashboard khi chạy ghi `~/.cross-review/dashboard.json` = `{pid, port, token, root, started_at}` (mode 0600). Lúc thoát, nó chỉ xoá file nếu file vẫn trỏ về chính nó.<br>`beginSession`, khi resolve ra `true` và **sau khi phiên đã start**:<ol><li>đọc file; nếu pid còn sống và `GET /api/health` (Bearer) trả 200 thì dùng dashboard đó;</li><li>nếu không, spawn tách rời `review-runner.js dashboard --root <workingDir> --no-open --idle-exit 1800` rồi chờ file xuất hiện và health OK, tối đa 5 giây;</li><li>`POST /api/workspaces {path: workingDir}` (Bearer) để dashboard theo dõi workspace này nếu nó nằm ngoài vùng quét;</li><li>mở trình duyệt tới `http://127.0.0.1:<port>/?t=<token>#/s/<ws>/<id>`;</li><li>trả `dashboard_url`, hoặc `dashboard_error` khi có bước lỗi.</li></ol>`--idle-exit <s>`: thoát khi không còn kết nối SSE nào trong `s` giây liên tục. Lệnh chạy tay thì không có cờ này nên không tự thoát | User yêu cầu 2026-10-15. Đây là ngoại lệ có chủ đích cho quyết định "không chạy nền": process do `begin` khởi động tự dọn sau 30 phút không ai xem. Lỗi không bao giờ chặn review |
| D17 | Không bump runner version (giữ 15), vì CLI không mất gì và các trường state mới là tuỳ chọn. `manifest.json` lên 10.1.0 | Thêm tính năng; không phá hợp đồng nào |

## Baseline
- HEAD `3c435bc` (main, đi trước origin 7 commit, chưa push). Working tree: mới có `mockups/` chưa track, cộng với file plan này.
- Đã xong trước plan này: thiết kế lại các skill, bản 10.0.0. Mock UI đã được user duyệt: bố cục, phong cách, icon, header lớn, Avatars.
- Spike nằm ở `.cross-review/spikes/dashboard/` (`models.json`, `client-info-server.mjs`, `scan.mjs`).
- Thời gian đo của các gate (2026-10-15, máy user):
  - `node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js`: 23s;
  - `node --test tests/`: 38s, 90 test pass;
  - cài vào HOME tạm + `install-check`: 2,4s.

## Design and project patterns
- **Mẫu trong repo:**
  - Verb và state: `lib/review-core.js` (`beginSession`, `replySession`, `endSession`, `updateState`, `computeNext`).
  - Adapter: `lib/reviewers/codex.js` (`parseEvents`, `buildCommand`), registry `lib/reviewers/index.js`.
  - Parse review: `lib/parse.js` (`parseOutputMarkdown`; ISSUE block có `id, title, severity, category, extra.location, problem, evidence, why_it_matters, suggested_fix`).
  - Dispatch lệnh CLI: `review-runner.js` `main()`.
  - Watchdog: `cmdWatchdog`, `launchWatchdog`.
  - Installer copy nguyên `scripts/lib` (`bin/cross-review.js:223`); `tests/install-check.mjs:125` kiểm file runtime.
  - Test dùng `node:test` và Codex giả `tests/helpers/fake-codex.js` (`FAKE_CODEX_SLOW_MS`, `FAKE_CODEX_FAIL`).
- **Chuẩn bên ngoài:**
  - SSE và `hashchange`: WHATWG HTML Living Standard.
  - Bảo mật server cục bộ: MCP spec, mục Transports, Security Warning (kiểm `Origin`, bind 127.0.0.1); OWASP CSRF Prevention Cheat Sheet (Verifying Origin With Standard Headers).
  - Escape HTML trước khi render markdown: OWASP XSS Prevention Cheat Sheet.
  - Kiểm file tải lên bằng magic bytes và giới hạn kích thước: OWASP File Upload Cheat Sheet.
  - Lucide ISC License.
- **Cấu trúc mới:**
```text
skill-packs/cross-review/scripts/lib/
├── config.js                 ← đọc, kiểm, ghi, resolve config hai mức (runner + dashboard)
└── dashboard/
    ├── model.js              ← trạng thái phiên, tiêu đề, round, ledger, bước, câu trạng thái (thuần)
    ├── activity.js           ← diễn đạt activity thành câu, gộp dòng đọc liên tiếp, gắn giờ
    ├── scan.js               ← tìm workspace, liệt kê phiên
    ├── server.js             ← HTTP, API, SSE, bảo mật, phục vụ ui/
    ├── avatars.js            ← lưu, kiểm, phục vụ avatar
    └── ui/                   ← index.html, app.css, app.js, markdown.js, icons.js, LICENSE-lucide.txt
```
- **Mức thiết kế:** nhỏ nhất mà vẫn đúng mẫu của repo. Không có framework, không có router library, không có template engine.

## Feasibility evidence
| Giả định | Spike hoặc nguồn | Kết quả | Ngày |
|---|---|---|---|
| Lấy được danh sách model Codex kèm effort | `codex debug models` (codex-cli 0.162.1) → `.cross-review/spikes/dashboard/models.json` | 9 model; 7 có `visibility: "list"`; có `priority`, `display_name`, `description`, `supported_reasoning_levels[].effort`. Chạy ~15ms; `--bundled` cũng chạy | 2026-10-15 |
| Biết được model mặc định của Codex | `~/.codex/config.toml` | Dòng `model = "gpt-6.1-sol"` ở cấp trên cùng | 2026-10-15 |
| MCP cho biết caller là ai | `client-info-server.mjs` chạy qua `claude -p --mcp-config` và `codex exec -c mcp_servers...` | `{"name":"claude-code","title":"Claude Code","version":"2.1.295",…}` và `{"name":"codex-mcp-client","title":"Codex","version":"0.162.1"}`. SDK 1.32.1 có `getClientVersion()` | 2026-10-15 |
| Log JSONL của Codex không có giờ từng event | `.cross-review/sessions/review-impl-20261015-010/output.jsonl` | Chỉ có `type` và `item`, không có timestamp. Các loại event: `thread.started`, `turn.started`, `item.started/completed` (`command_execution`, `agent_message`, `mcp_tool_call`), `turn.completed` | 2026-10-15 |
| Quét 3 cấp đủ nhanh | `scan.mjs ~/projects` | 969 thư mục, 100ms, tìm thấy 2 workspace | 2026-10-15 |
| Trạng thái đăng nhập của Codex đọc được | `codex login status` | "Logged in using ChatGPT", exit 0 | 2026-10-15 |
| Có đủ icon với giấy phép cho phép | `npm pack lucide-static` 1.57.0 | ISC; có đủ cả 23 icon cần dùng (`list`, `sliders-horizontal`, `check`, `check-check`, `pencil`, `clock`, `loader-circle`, `circle-pause`, `scale`, `file`, `search`, `flask-conical`, `git-compare`, `message-circle`, `terminal`, `file-text`, `code`, `lightbulb`, `git-pull-request`, `refresh-cw`, `folder`, `globe`, `triangle-alert`) | 2026-10-15 |
| Logo Codex/Claude không có nguồn tự do | Simple Icons (CC0) | Có `claude`, `claudecode`; logo OpenAI đã bị gỡ; disclaimer ghi CC0 không bao gồm quyền nhãn hiệu. Vì vậy user chọn tự tải avatar | 2026-10-15 |
| Node khởi động và nghe ở một cổng ngẫu nhiên 20000–30000 đủ nhanh để `begin` chờ được | `port-start.mjs` | Tổng 0,05s, listen 1–2ms (3 lần chạy) | 2026-10-15 |
| Headless Chrome kiểm được DOM sau khi JS chạy | `--headless=new --dump-dom` và `--screenshot` trên mock | Chạy được. Chú ý: hash trùng `id` của phần tử sẽ làm trang cuộn tới đó, nên route phải bắt đầu bằng `#/` | 2026-10-15 |

## Capacity
| Giới hạn | Bảo vệ cái gì | Ngăn lỗi gì | Vì sao là số này | Khi chạm ngưỡng |
|---|---|---|---|---|
| Body của `POST /api/settings` tối đa 64 KB | Bộ nhớ của server | Request khổng lồ làm treo process | Một config thật dưới 2 KB; 64 KB lớn hơn gấp bội | 413 kèm thông báo; UI hiện lỗi, giữ nguyên form |
| Chọn cổng tối đa 50 lần trong [20000, 30000] | Thời gian khởi động | Lặp mãi khi dải cổng gần như kín | 10.001 cổng; xác suất 50 lần chọn đều trúng cổng bận là cực nhỏ, trừ khi máy hết cổng thật | Thoát với "No free port between 20000 and 30000; pass --port." (exit 1). `begin` ghi lỗi này vào `dashboard_error`, review vẫn chạy |
| `begin` chờ dashboard tự khởi động tối đa 5 giây | Thời gian của `review_begin` | Treo `begin` khi dashboard không lên | Spike khởi động node mất dưới 1s; 5s lớn hơn nhiều lần | Trả `dashboard_error: "dashboard did not start within 5 s"`; phiên đã chạy |
| Dashboard tự khởi động thoát sau 1800 giây không có kết nối SSE | Process và cổng | Process mồ côi chạy mãi | 30 phút đủ cho một round review dài mà người dùng vẫn đang xem lại; lần follow sau sẽ khởi động lại | Thoát sạch, xoá `dashboard.json` nếu file còn là của nó |
| Avatar tối đa 1 MB | Đĩa và bộ nhớ | Tải nhầm ảnh lớn | Avatar hiện ở 30px; ảnh hợp lý dưới 200 KB | UI chặn trước khi gửi ("That image is over 1 MB. Pick a smaller one."); server trả 413 |

Mấy thứ sau không phải giới hạn dung lượng:
- trang 20 activity (mọi dòng vẫn xem được qua "show 20 earlier");
- độ sâu quét 3 (user quyết định);
- cửa sổ 24 giờ (quy tắc hiển thị D15).

Activity được đọc tăng dần theo byte offset, cache theo `(size, mtimeMs)`, nên `output.jsonl` lớn không bị đọc lại mỗi giây.

## Global Gates
```bash
npm ci --prefix skill-packs/cross-review
node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test tests/
H=$(mktemp -d) && HOME="$H" CODEX_HOME="$H/.codex" node bin/cross-review.js && node tests/install-check.mjs "$H"
node tests/dashboard-ui.mjs
```
- Hai gate đầu: exit 0. Gate thứ ba in `install-check: ok`.
- `dashboard-ui.mjs` dùng headless Chrome (`CHROME_PATH`, mặc định là đường dẫn Chrome trên macOS). Không tìm thấy Chrome thì exit khác 0 kèm thông báo, không âm thầm bỏ qua.
- Không cài thử vào HOME thật. Theo CLAUDE.md, chạy `gitnexus_impact` trước khi sửa một symbol và `gitnexus_detect_changes` trước khi commit, khi có công cụ GitNexus.

## Review checkpoints
- **Sau Phase 1:** hợp đồng state và persistence mới (`inputs/`, `ended_at`, `caller`, file times) và thay đổi watchdog, process quan trọng nhất của runner.
- **Sau Phase 3:** ranh giới bảo mật của server (Host/Origin, phạm vi file) cùng mô hình trạng thái của Phase 2.
- **Sau Phase 5:** hợp đồng config mà runner đọc, việc ghi config và avatar. Đây cũng là checkpoint cuối, review diff cộng dồn của cả plan (`BASE_BRANCH` = SHA của HEAD trước Phase 1, ghi vào `Progress Log`).

Không chỉ định model; dùng mặc định.

## Plan Review
APPROVE (review-plan review-plan-20261015-001, 2026-10-15)

## Phase 1: Runtime ghi dữ liệu cho dashboard
### Goal
Mỗi phiên mới có đủ dữ liệu để dashboard kể lại cuộc review: input gốc của từng round, caller, phiên đã được kết thúc chưa, và giờ của từng dòng event.

### Current behavior and gap
- `beginSession`/`replySession` chỉ lưu prompt đã render (`prompts/round-NNN.txt`). Từ đó không tách lại được `FIXED_ITEMS`/`DISPUTED_ITEMS`.
- `endSession` chỉ chạy `stop` (cộng `finalize` khi có kết quả). Không ghi lại rằng agent đã kết thúc phiên.
- MCP server không lưu client là ai.
- Watchdog chỉ `setTimeout` tới deadline. Sau khi reviewer xong, nó vẫn sống tới khi `poll`/`stop` kill.
- `output.jsonl` không có giờ.

### Evidence
- `review-core.js:207-235` (`beginSession`), `:323-338` (`replySession`), `:344-383` (`endSession`).
- `mcp-server.js:61-84`.
- `review-runner.js:245-261` (`launchWatchdog`), `:1818-1847` (`cmdWatchdog`).
- Spike JSONL không có timestamp (Feasibility).

### Pattern
- `updateState` (ghi atomic bằng tmp rồi rename) trong `review-core.js`.
- Archive theo round dùng `outputs/<kind>-round-NNN.*` (`cmdResume`).

### Dependencies
Không có.

### Files and symbols
- `scripts/lib/review-core.js`:
  - `beginSession`: thêm tham số `caller`, ghi `inputs/round-001.md`;
  - `replySession`: ghi `inputs/round-NNN.md`, xoá `ended_at`/`end_outcome`;
  - `endSession`: ghi `ended_at`, `end_outcome`;
  - helper mới `writeRoundInput(sessionDir, round, text)`.
- `scripts/mcp-server.js`: `review_begin` truyền `caller: server.server.getClientVersion()`, chỉ lấy `name`, `title`, `version`.
- `scripts/review-runner.js`:
  - hàm mới `flushLineTimes(stateDir, round)`: đọc số dòng đã ghi giờ từ dòng cuối của `outputs/times-round-NNN.jsonl`, đếm số dòng hoàn chỉnh hiện có trong `output.jsonl`, rồi append một hàng nếu số đó tăng;
  - `cmdWatchdog`: gọi `flushLineTimes` ngay khi khởi động và mỗi 1000 ms; gọi một lần nữa trước khi kill lúc tới deadline; thoát khi reviewer chết;
  - `cmdPoll`: khi kết quả là terminal, gọi `flushLineTimes` **trước** `verifyAndKillWatchdog`;
  - `cmdStop`: gọi `flushLineTimes` trước khi kill watchdog;
  - `cmdResume`: gọi `flushLineTimes` cho round cũ **trước** khi archive và trước khi `launchReviewer` mở lại `output.jsonl` với cờ `w`, nên lượt đổi round không mất dòng nào;
  - `cmdBegin`: không đổi (CLI không có caller).
- Test:
  - `tests/review-core.test.js` (thêm test);
  - `tests/mcp-server.test.js` (caller);
  - `tests/helpers/fake-codex.js` (thêm `FAKE_CODEX_STEPS`: in N event cách nhau `FAKE_CODEX_STEP_MS`).

### Behavioral contract
- `inputs/round-NNN.md` (3 chữ số) chứa **đúng nguyên văn** chuỗi input đã nhận. Chỉ ghi sau khi `start`/`resume` trả về thành công. `NNN` là round mà runner trả về. Ghi atomic; tạo thư mục `inputs/` khi chưa có.
- `endSession` cập nhật state với `ended_at` (epoch giây) và `end_outcome` (`"finalized"` nếu đã finalize, ngược lại `"stopped"`). Việc này diễn ra **sau** `stop`, kể cả khi finalize lỗi.
- `replySession` thành công thì đặt `ended_at: null`, `end_outcome: null`.
- `state.caller` = `{name, title?, version?}` khi gọi qua MCP và client có gửi `clientInfo`. CLI không ghi trường này.
- **Giờ của dòng event** (`flushLineTimes`):
  - mỗi hàng `[tongSoDongHoanChinh, epochGiay]\n` được append vào `outputs/times-round-NNN.jsonl`, chỉ khi tổng tăng so với hàng cuối đã có trong file;
  - append một hàng ngắn với `O_APPEND` là atomic, nên watchdog và poll/stop/resume ghi cùng lúc cũng không làm hỏng file. Bên đọc bỏ qua hàng không tăng;
  - watchdog giữ offset trong bộ nhớ để chỉ đọc phần mới; các lời gọi từ poll/stop/resume đếm lại cả file, vì chỉ chạy một lần;
  - giờ là gần đúng: những dòng xuất hiện giữa hai lần ghi nhận giờ của lần ghi sau, sai số khoảng 1 giây. User chấp nhận (2026-10-15);
  - watchdog thấy `isAlive(targetPid)` là false thì flush lần cuối rồi `process.exit(0)`;
  - `stateDir` rỗng hoặc round không hợp lệ thì chỉ giữ hành vi timeout cũ;
  - mọi lỗi I/O khi ghi giờ đều bị nuốt, vì không được làm hỏng watchdog, poll, stop hay resume.
- Deadline vẫn như cũ: flush, ghi marker rồi `killTree`.

### Documentation
CLAUDE.md, mục "Core Execution Flow": thêm `inputs/`, `outputs/times-round-NNN.jsonl`, `ended_at`, `caller`. Làm ở Phase 5 cùng các docs khác.

### Tests first
1. `begin and reply keep each round's raw input`: begin bằng input A, wait, reply bằng input B. Kiểm `inputs/round-001.md` bằng A và `round-002.md` bằng B, từng byte.
2. `a reply whose resume fails writes no input file`: fake codex không có trên PATH lúc reply, nên `REVIEWER_NOT_FOUND`. Kiểm không có `inputs/round-002.md`.
3. `end records ended_at and outcome; a later reply clears them`: dùng phiên review-plan APPROVE và phiên REVISE (`stopped`).
4. `review_begin over MCP stores the client's name, title and version as caller`: Client `{name:"test-client", title:"Test Client", version:"9.9.9"}`. Thêm `CLI begin stores no caller`.
5. `the watchdog stamps output lines and exits after the reviewer`:
   - `FAKE_CODEX_STEPS=4`, `FAKE_CODEX_STEP_MS=1200`;
   - sau `wait`, kiểm file times có ít nhất 2 hàng, số dòng tăng ngặt, epoch không giảm và nằm trong khoảng `[started_at, completed_at+2]`;
   - giá trị cuối bằng số dòng của `output.jsonl`;
   - `state.watchdog_pid` không còn sống trong 5 giây sau khi reviewer thoát.
6. `a review that ends before the first tick still has every line stamped`: fake codex không chậm, xong ngay. Sau `wait` (poll terminal), giá trị cuối của file times bằng số dòng của `output.jsonl`.
7. `stop and resume flush the round's line times`:
   - phiên đang chạy (`FAKE_CODEX_SLOW_MS`) bị `end`: file times của round đó phủ hết số dòng lúc dừng;
   - reply sang round 2: `times-round-001.jsonl` phủ hết `outputs/output-round-001.jsonl`, và `times-round-002.jsonl` bắt đầu lại từ dòng của round 2.
8. `flushLineTimes` gọi hai lần liên tiếp mà không có dòng mới thì chỉ thêm tối đa một hàng.

### Anti-shortcut coverage
- Test 5 bắt cách làm ngây thơ chỉ ghi một lần lúc kết thúc: cần ít nhất 2 hàng với epoch khác nhau. Cũng bắt watchdog không chịu thoát.
- Test 6 và 7 bắt cách chỉ ghi trong watchdog: poll và stop kill watchdog trước tick kế tiếp, còn resume mở lại `output.jsonl`.
- Test 2 bắt cách ghi input trước khi resume.
- Test 1 so từng byte, nên bắt việc ghi bản đã render thay cho input gốc.

### Implementation obligations
- Không đổi chữ ký CLI. Không đổi `computeNext`.
- Watchdog dùng `fs.openSync`/`readSync` từ offset, không đọc lại cả file mỗi giây.
- Không đổi điều kiện deadline, đếm stall, mã exit hay JSON của `poll`/`stop`/`resume`.
- `getClientVersion()` có thể trả `undefined`; khi đó không ghi gì.

### Acceptance criteria
- [ ] AC-1.1: input gốc của từng round được lưu nguyên văn, chỉ khi round khởi động thành công — chứng minh bởi test 1 và 2.
- [ ] AC-1.2: `end` ghi `ended_at` và `end_outcome`; `reply` thành công thì xoá chúng — chứng minh bởi test 3.
- [ ] AC-1.3: phiên MCP lưu caller lấy từ `clientInfo`; phiên CLI không có caller — chứng minh bởi test 4.
- [ ] AC-1.4: mọi dòng của mỗi round đều có giờ, kể cả round xong trước tick đầu tiên, round bị stop và lượt đổi round; watchdog thoát khi reviewer kết thúc — chứng minh bởi test 5, 6, 7 và 8.
- [ ] AC-1.5: deadline, stall và resume sau timeout không đổi — chứng minh bởi `test-default-timeout.js`, `test-stall-recovery.js`, `test-timeout-resume.js`.

### Focused verification
```bash
node --test --test-name-pattern "raw input|resume fails writes no input|ended_at|caller|watchdog stamps|before the first tick|flush the round|flushLineTimes" tests/
node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js
```

### Phase gates
```bash
node --test tests/review-core.test.js tests/mcp-server.test.js
```

### Review
Checkpoint: `/review-impl`

### Commit
`feat(runtime): record round inputs, caller, end state and output line times for the dashboard`

## Phase 2: Mô hình phiên (đọc file, thuần)
### Goal
Từ file của một phiên, tính ra mọi thứ UI cần: trạng thái, tiêu đề, round, thread, ledger, bước, câu trạng thái và activity đã diễn đạt. Không phụ thuộc HTTP hay DOM.

### Current behavior and gap
Chưa có gì.
- `computeNext` chỉ quyết định bước tiếp theo từ một kết quả poll.
- `parseOutputMarkdown` parse được review.
- `parseEvents` của codex chỉ đưa ra activity thô, `time` là thời điểm poll.

### Evidence
- Cấu trúc phiên do runner tạo: `state.json`, `rounds.json`, `final.txt`, `meta.json`, `review.md`, `outputs/review-round-NNN.md`, `outputs/output-round-NNN.jsonl`, `prompts/round-NNN.txt` (chỉ dùng để biết hình dạng file; fixture viết lại bằng nội dung bịa).
- Mẫu ISSUE block đã parse (Design).
- Prompt rebuttal yêu cầu reviewer giữ số ISSUE và chỉ liệt kê issue còn mở (`review-impl/references/prompts.md`, Rebuttal mục 8–9).

### Pattern
- `computeNext(final, state)` dùng lại để phân loại.
- `parseOutputMarkdown(md, skill)` dùng lại cho mọi review.
- Chuẩn hoá event là việc của adapter (`reviewers/codex.js`), phần diễn đạt chung nằm ở `dashboard/activity.js`.

### Dependencies
Phase 1, cho `inputs/`, `ended_at`, `caller`, file times.

### Files and symbols
- `scripts/lib/reviewers/codex.js`: `activityItems(lines)` → `[{id, line, lastLine, kind: "command"|"message"|"reasoning"|"tool"|"file_change", command?, exitCode?, status?, text?, tool?, path?}]`.
  - Mỗi `item.id` đúng một phần tử; nội dung lấy theo `item.completed`, hoặc `item.started` nếu chưa xong.
  - `line` là dòng **đầu tiên** thấy item đó: dòng `item.started` nếu có, ngược lại dòng `item.completed` (Codex chỉ phát `item.completed` cho `agent_message` và `reasoning` trung gian). `line` dùng để sắp xếp, phân trang và gắn giờ; `lastLine` là dòng cuối cùng chạm tới item, dùng để biết item vừa đổi.
  - Tin nhắn `agent_message` cuối cùng của turn không đưa vào.
  - Cập nhật comment registry `reviewers/index.js`.
- `scripts/lib/dashboard/activity.js`:
  - `humanize(item)` → `{kind: read|search|test|diff|think|scratch|run|tool|change, text, raw}`;
  - `groupReads(list)`;
  - `attachTimes(items, timesRows, roundStartedAt)` → `t` (giây kể từ đầu round) hoặc `null`.
- `scripts/lib/dashboard/model.js`:
  - `readSession(dir)` → `parsed`: chỉ đọc và parse file, không phụ thuộc giờ hay process, nên cache được theo `size`/`mtimeMs`;
  - `classify(parsed, {now, isAlive})` → `{summary, detail}`: mọi thứ phụ thuộc thời gian hoặc process (trạng thái, `warn`, cửa sổ 24 giờ, "For", pid còn sống); rẻ, chạy lại mỗi tick;
  - các hàm con export ra để test: `sessionStatus`, `sessionTitle`, `buildThread`, `buildLedger`, `buildSteps`, `statusSentence`, `parseAgentReply`.
- Test: `tests/dashboard-model.test.js`, cùng `tests/helpers/dashboard-fixture.js` (`buildFixture(root)`: tạo workspace và phiên bằng file tổng hợp, chạy được như CLI `node tests/helpers/dashboard-fixture.js <dir>` để có dữ liệu demo).

### Behavioral contract
**Bảng 1: trạng thái.** Xét theo thứ tự, gặp dòng nào khớp trước thì lấy dòng đó.

| Điều kiện | `group` | `state` | Nhãn (y như mock) |
|---|---|---|---|
| Có `meta.json` | history | xem "Kết quả của phiên đã finalize" bên dưới | approved / consensus / stalemate |
| Round cuối `running`, `isAlive(pid)` | active | running | reviewer working |
| Round cuối `running`, pid chết | (tính lại từ `output.jsonl` qua `parseEvents`: completed thì như có `final.txt` với review đã parse; failed thì là stopped) | | |
| `final.txt` cho `computeNext` = `done` | history | approve/stalemate | approved / stalemate |
| Ngược lại, `final.txt` cho `respond`/`cross_check`/`ask_user` và không có `ended_at` | active, nhưng thành history "no reply" nếu `now - completed_at > 86400` | waiting | agent's turn |
| Round cuối thuộc `failed`/`timeout`/`stalled`/`stopped` | active nếu có `thread_id` và chưa quá 24 giờ kể từ `completed_at`; ngược lại history | stopped | stopped, resumable / stopped |
| `ended_at` có mà không có `meta.json` (những trường hợp còn lại) | history | stopped | stopped |

- **Kết quả của phiên đã finalize** (`meta.json` có): `meta.verdict` là `APPROVE` → approve; `CONSENSUS` → consensus; `STALEMATE` → stalemate. Verdict khác (ví dụ `REVISE` khi phiên dừng vì hội tụ) thì gọi `computeNext` trên `final.txt` của round cuối: `next_reason === "stalemate"` → stalemate; còn lại → stopped (nhãn "stopped", group history), ví dụ agent gọi `end` khi còn issue mở. `meta.outcome` của peer skill (`consensus`/`stalemate`) được giữ nguyên khi có.
- `warn` khi `waiting` và đã chờ quá 1200 giây. Chữ: "Waiting over 20 minutes — the agent may have stopped. Ask it to continue."
- "Now" của phiên `running` là activity mới nhất đã diễn đạt. Của `waiting`: "The reviewer's position is in; the agent has not replied." với peer skill; "The reviewer's findings are in; the agent has not replied." với impl/plan. Của `stopped`: thông báo lỗi trong `final.txt` (`error`).
- **Tiêu đề phiên:**
  - review-plan: basename của `PLAN_PATH`;
  - review-impl: dòng đầu không rỗng của `USER_REQUEST`, tối đa 120 ký tự, cắt ở ranh giới từ và thêm "…";
  - review-think: `QUESTION`;
  - review-pr: `PR_TITLE`, nếu không có thì `HEAD_REF`;
  - thiếu `inputs/round-001.md` thì lấy tên phiên.
- **Thread**, theo thứ tự:
  1. tin nhắn "You · asked the agent": `USER_REQUEST`, hoặc `QUESTION` (think);
  2. với peer skill: `analysis.md` của agent, nếu có, đặt sau round 1 dưới nhãn "independent analysis";
  3. mỗi round: tin nhắn của reviewer, gồm verdict, thời lượng (`rounds.json.elapsed_seconds`), `verdict.reason` dạng markdown, các thẻ ISSUE (hoặc toàn bộ `raw_markdown` khi không có block), số activity và có prompt hay không;
  4. sau round r (nếu có `inputs/round-(r+1).md`): reply của agent.
     - impl/plan: mỗi dòng `ISSUE-N:` trong `FIXED_ITEMS` thành "Fixed", trong `DISPUTED_ITEMS` thành "Disputed".
     - peer: các mục `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_FINDINGS`/`NEW_PERSPECTIVES` dạng markdown.
- **Ledger** (chỉ khi có ISSUE block):
  - lần đầu xuất hiện: `raised`;
  - agent ghi `fixed`/`disputed`;
  - round kế tiếp của reviewer:
    - issue còn trong danh sách: `maintained` (đã disputed) hoặc `still open` (đã fixed);
    - issue vắng mặt: `verified` (đã fixed), `withdrawn` (đã disputed), `closed` (agent chưa nói gì);
  - cuối chuỗi thêm trạng thái chờ khi phiên còn chạy: `checking now` (running), `agent's turn` (waiting, issue còn mở), `not checked` (stopped, issue chưa được kiểm).
- **Bước:**
  - reviewer: "Round r approved / stalemate / N new / maintained";
  - agent: "agent: a fixed, b disputed";
  - đuôi theo trạng thái: "Round r in progress" / "stopped" / "agent's turn".
- **Câu trạng thái** (`what`/`next`), theo mẫu của mock:
  - approved: "Approved in round R." / "N issues: …";
  - waiting: "Round R left K issue(s) open. The agent has to fix or dispute them." / "… Waiting Xm.";
  - running: "The reviewer is checking the agent's reply to round R-1." (round 1: "The reviewer is reviewing.") / "Round R, running {clock}. Its activity below updates as it works.";
  - stopped: "Stopped in round R: {lý do}." / "The reviewer's thread is kept. …" (có `thread_id`) hoặc "The reviewer had not started; start a new review." (không có);
  - stalemate: "Stalemate. You decide." / "Both sides held their positions …".
- **Activity** (`humanize`):
  - bỏ vỏ `/bin/zsh -lc '…'` hoặc `bash -lc "…"`, rồi xét theo đoạn đầu tiên của chuỗi lệnh (ngăn bởi `&&`, `;`, `|`):
    - `sed -n 'a,bp' F`, `cat F`, `nl … F`, `head/tail … F` → read, `F:a-b`;
    - `rg|grep|git grep P` → search, `P`;
    - `npm (run )?test|node --test|pytest|go test|cargo test|npx (vitest|jest)|yarn test|pnpm test` → test, `cmd — passed|failed (exit N)|running`;
    - `git diff|show|log` → diff;
    - có `mktemp` → scratch;
    - còn lại → run;
  - reasoning hoặc agent_message → think;
  - mcp_tool_call → tool;
  - file_change → change (có dấu cảnh báo);
  - các dòng read liên tiếp gộp thành "Read N files: a, b".

### Documentation
Không có. Docs gom ở Phase 5.

### Tests first
`tests/dashboard-model.test.js`, chạy trên fixture:
1. Mỗi dòng của bảng 1 có một phiên fixture riêng. Kiểm `group`, `state`, nhãn, `warn`. Ranh giới: 1199s và 1201s cho `warn`; 86399s và 86401s cho cửa sổ 24 giờ, kiểm bằng **cùng một** `parsed` gọi `classify` với `now` khác nhau.
2. Round cuối `running` mà pid chết và `output.jsonl` có `turn.completed` thì phân loại như đã có `final.txt`.
3. Tiêu đề cho cả 4 skill, gồm cắt 120 ký tự và trường hợp thiếu input.
4. Phiên theo câu chuyện của mock (3 issue, 3 round) cho ra:
   - ledger `1: raised→fixed→verified`, `2: raised→disputed→withdrawn`, `3: raised→fixed→verified`;
   - bước và câu trạng thái giống chuỗi trong mock ở trạng thái approved;
   - cắt phiên ở round 3 đang chạy thì có `3: raised→fixed→checking now`.
5. `parseAgentReply` với các dòng có và không có `file:line`, và với `None — all issues addressed`.
6. Bảng `humanize`: mỗi lớp lệnh một ca, có lệnh bọc zsh/bash và lệnh nối nhau. Thêm: test exit 1 ra "failed (exit 1)"; 3 dòng read liên tiếp gộp thành 1, nhưng read, search, read thì không gộp.
7. `attachTimes`: dòng 0..k nhận giờ của hàng đầu tiên có `soDong > i`. Không có file times thì `t = null`.
8. Codex `activityItems` trên `output.jsonl` tổng hợp do `buildFixture` sinh, có đủ các loại event Codex thật phát ra (`thread.started`, `turn.started`, `item.started`/`item.completed` cho `command_execution`, `agent_message`, `reasoning`, `mcp_tool_call`, `file_change`, `turn.completed`), nội dung bịa: số phần tử bằng số `item.id` khác nhau trừ tin nhắn cuối.
9. `activityItems` với item chỉ có `item.completed` (một `agent_message` trung gian và một `reasoning`): mỗi item có `line` bằng dòng `item.completed` của nó, đứng đúng thứ tự giữa các lệnh xung quanh và nhận giờ của dòng đó qua `attachTimes`.
10. Lệnh mới `item.started` (status `in_progress`) rồi `item.completed` với exit 0, và một lệnh khác completed với exit 1: mỗi lệnh vẫn là một phần tử, `line` không đổi giữa hai lần đọc, `exitCode`/`status` lấy theo lần cuối.
11. Phiên đã finalize với `meta.verdict` = `REVISE` mà `final.txt` round cuối cho `next_reason: "stalemate"` (hội tụ) → `stalemate`, không phải `approved`/`stopped`.

### Anti-shortcut coverage
- Test 1 kiểm ranh giới hai phía.
- Test 4 với phiên "maintained" và "still open" bắt cách suy ledger chỉ bằng issue có mặt hay vắng mặt mà không xét agent đã nói gì.
- Test 6 dùng lệnh bọc zsh, bắt regex chỉ khớp đầu chuỗi.
- Test 9 bắt cách lấy `line` chỉ từ `item.started` (item chỉ có `completed` sẽ mất vị trí hoặc dồn về cuối).
- Test 11 bắt cách đọc thẳng `meta.verdict` như kết quả.

### Implementation obligations
- `model.js` không gọi tiến trình con và không ghi file.
- `now` và `isAlive` được truyền vào `classify` để test tiêm giá trị; `readSession` không đọc đồng hồ.
- Bảng nhãn và câu chữ đặt ở một chỗ (hằng số), UI chỉ hiển thị.

### Acceptance criteria
- [ ] AC-2.1: phân loại trạng thái theo đúng bảng 1, kể cả các ranh giới và phiên finalize vì hội tụ — chứng minh bởi test 1, 2 và 11.
- [ ] AC-2.2: tiêu đề, thread và reply của agent dựng đúng cho 4 skill — chứng minh bởi test 3 và 5, cùng các ca thread trong test 4.
- [ ] AC-2.3: ledger, bước và câu trạng thái khớp câu chuyện của mock — chứng minh bởi test 4.
- [ ] AC-2.4: activity được diễn đạt, gộp và gắn giờ đúng; mỗi item có danh tính và vị trí ổn định, kể cả item chỉ có `item.completed` — chứng minh bởi test 6, 7, 8, 9 và 10.

### Focused verification
```bash
node --test tests/dashboard-model.test.js
```

### Phase gates
```bash
node --test tests/dashboard-model.test.js tests/review-core.test.js
```

### Review
Checkpoint: None (covered by the checkpoint after Phase 3)

### Commit
`feat(dashboard): session model — status, thread, issue ledger, humanized activity`

## Phase 3: Server, khung UI và trang Sessions
### Goal
`dashboard` chạy được và trang Sessions giống hệt mock: header, nhóm In progress cập nhật trực tiếp, History có lọc và tìm kiếm, cùng route.

### Current behavior and gap
Không có lệnh `dashboard` và không có server.

### Evidence
- `review-runner.js` `main()` (dispatch).
- `bin/cross-review.js:1-70`: installer chạy code ở top-level, nên phải dispatch trước mọi bước cài.
- `bin/cross-review.js:223`: copy `lib` nên `ui/` cũng được cài theo.

### Pattern
- Lệnh mới trong `main()` theo cách của `begin`: async rồi `process.exit(code)`; riêng server thì không exit.
- Kiểm file runtime trong `install-check.mjs:125`.

### Dependencies
Phase 2.

### Files and symbols
- `scripts/lib/dashboard/scan.js`: `findWorkspaces(root, maxDepth = 3)`, `listSessions(wsPath)`.
- `scripts/lib/dashboard/server.js`: `startDashboard({root, port, open, idleExitSeconds})` → `{url, port, token, close()}`.
  - Route:
    - `GET /?t=<token>` đặt cookie rồi 303; `GET /` cùng các file tĩnh của `ui/`, theo danh sách cố định (Phase 4 và 5 thêm `feed.js`, `markdown.js`, `settings.js` vào danh sách);
    - `GET /api/health` → `{ok: true, root, pid}`;
    - `POST /api/workspaces {path}`: thêm workspace (thư mục phải có `.cross-review/sessions/`) vào tập theo dõi trong bộ nhớ;
    - `GET /api/overview`;
    - `GET /api/sessions`: `{active, history, workspaces}`, mỗi summary có `searchText` (tiêu đề, tiêu đề và vị trí issue);
    - `GET /api/stream?view=list`: SSE. Ngay khi kết nối (kể cả mỗi lần tự kết nối lại) gửi một sự kiện `sessions` đầy đủ; sau đó gửi khi summary đổi; mỗi 15 giây gửi `: ping`.
  - Bảo mật theo D6.
  - Header: `Cache-Control: no-store` cho API; `X-Content-Type-Options: nosniff`.
- `scripts/lib/dashboard/ui/`:
  - `index.html`;
  - `app.css`: CSS của mock giữ nguyên giá trị; inline style trong mock chuyển thành class;
  - `app.js`: router hash, view Sessions, đồng hồ "For" chạy phía client;
  - `icons.js`: path Lucide cùng logo tự vẽ;
  - `LICENSE-lucide.txt`.
- `scripts/lib/dashboard/discovery.js`: `writeDiscovery(info)`, `readDiscovery()`, `removeDiscoveryIfOwn(pid)`, quản lý `~/.cross-review/dashboard.json` với mode 0600.
- `scripts/review-runner.js`: lệnh `dashboard [--root] [--port] [--no-open] [--idle-exit <s>]`; thêm vào usage.
- `bin/cross-review.js`: `if (process.argv[2] === 'dashboard')` thì dynamic import `../skill-packs/cross-review/scripts/lib/dashboard/server.js` và chạy, **trước** mọi bước cài.
- `tests/install-check.mjs`: kiểm có `scripts/lib/dashboard/ui/index.html` và `LICENSE-lucide.txt`.
- Test: `tests/dashboard-server.test.js`, `tests/dashboard-ui.mjs` (headless Chrome).

### Behavioral contract
- **Quét:**
  - root ở độ sâu 0, con tới độ sâu 3;
  - bỏ qua thư mục bắt đầu bằng `.`, `node_modules` và symlink;
  - workspace ở độ sâu 4 không được tìm thấy;
  - quét lại cây thư mục khi có request `/api/sessions` (cache 5 giây) và trong chu kỳ live (xem dưới).
- **Chu kỳ live của danh sách** (`createListWatcher({root, now, rescanMs = 10000, tickMs = 1000})`, `now` và hai khoảng thời gian tiêm được để test):
  - mỗi tick: đọc lại thư mục `.cross-review/sessions/` của mọi workspace đang theo dõi (thấy phiên mới, phiên bị xoá); mỗi `rescanMs` thì quét lại cả cây từ root (thấy workspace mới);
  - **parse** (`model.readSession`) chỉ chạy lại khi `size`/`mtimeMs` của file theo dõi đổi, kết quả cache theo phiên;
  - **phân loại** (`group`, `state`, `warn`, cửa sổ 24 giờ, "For") chạy lại **mỗi tick** trên dữ liệu đã cache với `now()` hiện tại, vì các mốc 1200 giây và 86400 giây đổi mà không file nào đổi;
  - summary nào khác lần gửi trước (so JSON) thì gửi sự kiện `sessions`.
- **Khoá phiên** là cặp `(ws, id)`.
  - `id` phải khớp `^[a-z]+(-[a-z]+)*-\d{8}-\d{3}$`.
  - `ws` phải là một workspace đã quét; ngoài ra trả 404.
- **Lệnh** in ra `cross-review dashboard: http://127.0.0.1:<port>/?t=<token>  (scanning <root>, 3 levels down)`.
  - Cổng chọn theo D2. Khởi động xong thì ghi `dashboard.json`; Ctrl-C, SIGTERM hay idle-exit đều gọi `removeDiscoveryIfOwn`.
  - Mặc định mở trình duyệt: `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows); lỗi thì bỏ qua và chỉ in URL.
- **Bảo mật** (D6):
  - không có token, hoặc token sai → 401 với trang chữ; token đúng trong `?t=` → đặt cookie rồi 303 về URL không token;
  - `Host` lạ → 403;
  - `POST` không có `Origin` khớp → 403;
  - đường dẫn tĩnh ngoài danh sách → 404;
  - `..` trong đường dẫn không bao giờ đọc ra ngoài `ui/`.
- **UI Sessions** giống mock:
  - header: logo, tên, nav có icon; bên phải là `<root> · scanned 3 levels down · N workspaces · pack <version>`;
  - "In progress": các cột State/Session/Now/For, icon skill, cảnh báo;
  - "History": 3 bộ lọc và ô tìm kiếm, tất cả lọc phía client;
  - bấm một dòng thì mở `#/s/<ws>/<id>`;
  - không có phiên đang diễn ra thì hiện "Nothing in progress." trong nhóm đó.
- **Router:** `hashchange` render view. Hash lạ thì về `#/`. Tab đang mở được đánh dấu đúng như mock (chi tiết phiên thì sáng tab Sessions).

### Documentation
Không có. Docs gom ở Phase 5.

### Tests first
`tests/dashboard-server.test.js`, chạy server thật trên fixture, cổng 0:
1. `findWorkspaces` thấy workspace ở độ sâu 0..3, không thấy độ sâu 4, không thấy trong `node_modules`, thư mục ẩn hay qua symlink.
2. `/api/sessions` xếp các phiên fixture đúng nhóm, đúng nhãn và thứ tự: active theo `since` mới nhất trước, history theo `created_at` giảm dần.
3. Bảo mật:
   - `Host: evil.example:PORT` → 403;
   - POST có `Origin: http://evil.example` → 403;
   - `GET /../../etc/passwd` và `/api/session?ws=..&id=x` → 404;
   - `id` không khớp mẫu → 404.
4. SSE `view=list`: thêm một dòng vào `output.jsonl` của phiên running thì trong 3 giây nhận sự kiện `sessions` có "Now" mới; ghi `final.txt` thì phiên chuyển sang `waiting`.
4b. Chuyển trạng thái chỉ do thời gian: watcher với `now` giả, phiên `waiting` ở 1199 giây; tăng `now` lên 1201 giây mà không đổi file nào thì tick kế tiếp phát `sessions` có `warn`; tăng lên 86401 giây thì phiên chuyển sang history "no reply". Phiên stopped có `thread_id` rời nhóm active sau 86400 giây theo cùng cách.
4d. Kết nối lại SSE `view=list` sau khi một phiên đổi trạng thái trong lúc mất kết nối: sự kiện đầu tiên là `sessions` đầy đủ, có trạng thái mới.
4c. Phát hiện mới khi trang đang mở: sau khi SSE đã kết nối, tạo một phiên mới trong workspace đã biết → có trong sự kiện `sessions` ở tick kế tiếp; tạo một workspace mới (độ sâu 2) cùng một phiên → có sau lần quét lại (`rescanMs` tiêm bằng 500 ms).
5. Không truyền `--port` thì cổng nằm trong [20000, 30000]. Mô phỏng 3 lần đầu bận (tiêm hàm chọn cổng trả 3 cổng đang bị chiếm rồi một cổng trống) thì vẫn lên ở cổng thứ tư. Tiêm 50 cổng bận thì báo "No free port…".
6. Token:
   - không có cookie → 401 cho `/`, `/app.js`, `/api/sessions`, `/api/stream`;
   - `?t=` sai → 401;
   - `?t=` đúng → 303, có `Set-Cookie` chứa `HttpOnly` và `SameSite=Strict`, rồi dùng cookie đó thì 200;
   - `Authorization: Bearer <token>` → 200.
7. `dashboard.json` được ghi với mode 0600 và nội dung đúng. `close()` xoá file. Nếu file đã bị process khác ghi đè thì `close()` không xoá.
8. `--idle-exit 2`: server thoát sau khoảng 2s khi không có SSE; đang có một kết nối SSE thì không thoát.
9. `POST /api/workspaces` với thư mục nằm ngoài root: phiên của nó xuất hiện trong `/api/sessions` với `ws` là đường dẫn tuyệt đối. Thư mục không có `.cross-review/sessions` → 400.

`tests/dashboard-ui.mjs`: dựng fixture, chạy server, gọi Chrome `--dump-dom` với URL `/?t=<token>#/`, để Chrome đi theo redirect và dùng cookie, rồi kiểm DOM:
- `.top .wrap .name svg`, nav có 2 mục kèm `svg`, mục Sessions có class `on`;
- `#active tr` bằng số phiên active, mỗi dòng có `.st` và icon;
- dòng cảnh báo có `.warn`;
- `#history tr` bằng số phiên history;
- không có ô chọn `#demo`.

Thêm chụp màn hình 1400px của `#/` trên fixture để so với mock (bằng mắt, xem AC-3.4); ảnh lưu ngoài repo.

### Anti-shortcut coverage
- Test 3 dùng request thô (`http.request` với `Host` tuỳ chỉnh), bắt server chỉ dựa vào việc bind localhost.
- Test 4 bắt cách chỉ trả snapshot mà không đẩy cập nhật.
- Test 4b bắt cách chỉ tính lại khi stat file đổi.
- Test 4c bắt cách chỉ quét workspace lúc khởi động hoặc chỉ khi có request.

### Implementation obligations
- Server không giữ trạng thái ghi nào ngoài cache. Mỗi phiên parse lại bằng `model.readSession` khi `size`/`mtimeMs` của các file theo dõi thay đổi; phần phân loại theo thời gian tách khỏi parse và chạy mỗi tick (`model.classify(parsed, {now, isAlive})`). Kết cục của `output.jsonl` (có `turn.completed`/`turn.failed` hay không) được `readSession` parse sẵn, để `classify` dùng khi pid đã chết.
- Thứ tự cột, chữ, màu và khoảng cách lấy từ mock. Inline style của mock chuyển thành class, vì CSP không cho inline style.

### Acceptance criteria
- [ ] AC-3.1: quét đúng phạm vi, sâu 3 cấp — chứng minh bởi test 1.
- [ ] AC-3.2: API Sessions và SSE danh sách đúng, kể cả chuyển trạng thái chỉ do thời gian và phiên/workspace mới xuất hiện khi trang đang mở — chứng minh bởi test 2, 4, 4b, 4c và 4d.
- [ ] AC-3.3: token, Host, Origin và đường dẫn đều được kiểm; cổng chọn trong [20000, 30000] và tránh cổng bận — chứng minh bởi test 3, 5 và 6. Test 3 gửi kèm token hợp lệ, nên mỗi lớp được kiểm riêng.
- [ ] AC-3.7: `dashboard.json`, idle-exit và đăng ký workspace đúng — chứng minh bởi test 7, 8 và 9.
- [ ] AC-3.4: trang Sessions giống mock — chứng minh bởi DOM check trong `dashboard-ui.mjs`, cùng ảnh chụp 1400px đặt cạnh `mockups/dashboard.html` (inspection ghi vào Progress Log).
- [ ] AC-3.5: hai lệnh `node review-runner.js dashboard` và `node bin/cross-review.js dashboard` chạy được, không chạy bước cài nào — chứng minh bởi test trong `dashboard-server.test.js` (spawn với `HOME` tạm, kiểm `HOME/.claude` không bị tạo).
- [ ] AC-3.6: bản cài có UI và LICENSE của Lucide — chứng minh bởi `install-check.mjs`.

### Focused verification
```bash
node --test tests/dashboard-server.test.js
node tests/dashboard-ui.mjs
H=$(mktemp -d) && HOME="$H" CODEX_HOME="$H/.codex" node bin/cross-review.js && node tests/install-check.mjs "$H"
```

### Phase gates
```bash
node --test tests/dashboard-server.test.js tests/dashboard-model.test.js
```

### Review
Checkpoint: `/review-impl`

### Commit
`feat(dashboard): local server, workspace scan and Sessions page`

## Phase 4: Trang chi tiết phiên và activity trực tiếp
### Goal
Trang chi tiết giống mock cho mọi trạng thái:
- khung trạng thái, chuỗi bước;
- hội thoại hai phía có avatar;
- thẻ finding;
- ledger issue, thông tin phiên;
- activity trực tiếp trong round đang chạy: 20 dòng mới nhất, nhận dòng mới, "show 20 earlier", bấm để xem lệnh gốc.

### Current behavior and gap
UI mới chỉ có Sessions.

### Evidence
- Model của Phase 2.
- Mock, phần detail (`renderDetail`, `renderActs`, `groups`, `line`, `tick`).

### Pattern
Cùng router/SSE của Phase 3.

### Dependencies
Phase 3.

### Files and symbols
- `server.js`:
  - `GET /api/session?ws&id` → detail;
  - `GET /api/activity?ws&id&round&before=<line>&limit=20` → `{round, items, total, hasEarlier}`; mỗi item có `key = "${round}:${id}"`, `line`, `t`; `total` là số item khác nhau (không phải số dòng event);
  - `GET /api/prompt?ws&id&round` → text;
  - `GET /api/stream?view=session&ws&id`: SSE.
    - Ngay khi kết nối (kể cả mỗi lần `EventSource` tự kết nối lại): sự kiện `snapshot` `{round, total}`.
    - `activity` `{op: "add"|"update", key, item, total}`: `add` khi một `item.id` xuất hiện lần đầu, `update` khi item đã có nhận thêm dòng (ví dụ lệnh `item.started` rồi `item.completed` với `exitCode`).
    - `session` khi state/rounds/final/meta/review/inputs đổi; round mới cũng đi qua sự kiện này;
  - `POST /api/reveal {ws,id}`: mở thư mục phiên trong trình quản lý file (`open` / `xdg-open` / `explorer`).
- `ui/feed.js`: hàm thuần `mergeActivity(feed, event)`, `applyPage(feed, page)` và `onSnapshot(view, snapshot)`, dùng chung cho trình duyệt và test node (ES module không đụng DOM). `feed = {round, byKey, order, total, shown}`.
- `ui/markdown.js`: `renderMarkdown(text)`. Escape trước, rồi dựng heading, đoạn, danh sách, code span, code fence, đậm/nghiêng, link chỉ `http(s)` có `rel="noopener noreferrer"`. Không cho HTML thô.
- `ui/app.js`: view detail, deep link `ISSUE-n` (cuộn và nhấp nháy), feed activity, đồng hồ.
- Test: `tests/dashboard-markdown.test.js`, `tests/dashboard-feed.test.js`, bổ sung cho `tests/dashboard-server.test.js` và `tests/dashboard-ui.mjs`.

### Behavioral contract
- Bố cục, chữ và tương tác theo mock:
  - breadcrumb `Sessions / <ws>`;
  - tiêu đề, dòng meta (skill, mode/base, id);
  - `.status` có icon trạng thái (spinner khi running);
  - chuỗi bước bấm được (cuộn tới tin nhắn);
  - lưới thread và aside dính.
- **Feed activity:**
  - nằm trong tin nhắn reviewer của round đang chạy;
  - **đồng bộ khi kết nối**: nhận `snapshot` thì client gọi `/api/activity?limit=<shown>` (lần đầu `shown = 20`); trong lúc chờ, các sự kiện `activity` được đệm lại; trang về thì `applyPage`, rồi áp các sự kiện đã đệm. Áp theo `key` là idempotent: một item vừa có trong trang vừa có trong sự kiện đệm chỉ hiện một lần, bản có `lastLine` lớn hơn thắng;
  - **mỗi** `snapshot` (kể cả khi round không đổi) đều tải lại detail (`/api/session`), vì sự kiện `session` phát ra trong lúc mất kết nối không được gửi lại: round có thể đã xong, chuyển sang waiting/stopped hoặc đã finalize. Tải lại giữ nguyên `shown` và các dòng đang mở của feed;
  - round trong `snapshot` hoặc `session` khác round đang hiện thì feed được đặt lại cho round mới;
  - `add` thêm item vào cuối; `update` thay dòng có cùng `key` tại chỗ, giữ trạng thái mở xem lệnh gốc;
  - số `latest K of N` lấy `N = total` (số item khác nhau);
  - cửa sổ trượt: giữ `shown` event mới nhất, dòng cũ nhất rơi khỏi đầu;
  - "show 20 earlier" tăng `shown` thêm 20 và giữ vị trí cuộn của người đọc;
  - dòng đang mở xem lệnh gốc vẫn mở sau khi render lại;
  - bên phải ghi `latest K of N events`.
- **Round đã xong:**
  - "activity (N)" mở hoặc đóng cùng kiểu feed đó, phân trang, không live;
  - "prompt sent" mở hoặc đóng một `<pre>` chứa `prompts/round-NNN.txt`.
- **Đồng hồ:** "running m:ss" và "+ running" tự chạy phía client. Khi nhận sự kiện `session` thì tải lại detail mà không làm mất feed đang mở.
- **Aside Session:**
  - Reviewer;
  - Model: tên hiển thị lấy theo catalog nếu có, "· Codex default" khi `state.model` rỗng;
  - Effort và nguồn (từ `settings_sources` của Phase 5; chưa có thì bỏ phần nguồn);
  - Caller (`caller.title`, hoặc "Agent");
  - Reviewer time, Started;
  - Folder "open" gọi `/api/reveal`.
- **Avatar:**
  - mặc định là ảnh `ui/avatars/reviewer.png`, `agent.png` (mọi caller), `you.png`; chữ cái (reviewer `CX`, agent theo `caller.name`: `claude-code` → `CC`, `codex-mcp-client` → `CX`, khác thì chữ cái đầu của title, không có thì `AG`; You `Y`) là `alt`/dự phòng và là `title` khi rê chuột;
  - ảnh toàn thân dùng cho trạng thái trống: "Nothing in progress." (Sessions), và trang 401;
  - có ảnh avatar (Phase 5) thì hiện ảnh.
- **Peer skill:** tin nhắn reviewer render `raw_markdown`; agent có tin nhắn "independent analysis". Ledger chỉ hiện khi có ISSUE.

### Documentation
Không có. Docs gom ở Phase 5.

### Tests first
1. `dashboard-markdown.test.js`:
   - `<img src=x onerror=alert(1)>` thành chữ thường;
   - `[a](javascript:alert(1))` không tạo link;
   - fence giữ nguyên nội dung;
   - heading, danh sách, code span đúng thẻ.
2. `dashboard-server.test.js`:
   - `/api/activity` phân trang: `before` và `limit` trả đúng 20 item, `hasEarlier` đúng ở trang cuối;
   - `/api/prompt` với round không tồn tại → 404;
   - SSE `view=session`: sự kiện đầu tiên là `snapshot`; thêm 3 dòng event của 3 item mới vào `output.jsonl` thì nhận 3 `activity` `op: "add"` theo đúng thứ tự, có `t` khi file times có hàng tương ứng;
   - một lệnh `item.started` rồi `item.completed` với exit 0, và một lệnh khác với exit 1: nhận `add` rồi `update` cùng `key`, `exitCode` 0/1; `/api/activity` sau đó có đúng 2 item cho 2 lệnh này và `total` không tính dòng `started`;
   - ngắt kết nối SSE, thêm 2 dòng, kết nối lại: sự kiện đầu tiên là `snapshot` với `total` đã tăng;
   - ngắt kết nối khi round R đang chạy, cho round R kết thúc (ghi `turn.completed` và `final.txt` với verdict REVISE) mà không bắt đầu round mới, rồi kết nối lại: `snapshot` vẫn là round R, và `/api/session` sau đó trả `state: "waiting"`;
   - `/api/reveal` không có `Origin` khớp → 403.
2b. `tests/dashboard-feed.test.js` (node, import `ui/feed.js`):
   - `add` hai lần cùng `key` → một dòng;
   - `update` thay dòng tại chỗ, thứ tự không đổi;
   - trang về sau các sự kiện đệm có cùng `key` → không lặp, bản `lastLine` lớn hơn giữ lại;
   - mất kết nối giữa chừng: feed 20 dòng, `applyPage` với trang mới chứa 2 item mới và 1 item đã `update` → 22 item khác nhau, cửa sổ hiện 20 mới nhất (khi `shown = 20`), không có dòng trùng hay mất;
   - `snapshot` round khác → feed được đặt lại cho round mới.
2c. `tests/dashboard-feed.test.js`: hàm thuần `onSnapshot(view, snapshot)` trả danh sách việc cần làm; round không đổi vẫn có `reloadDetail` (cùng `fetchActivity`), round đổi thì thêm `resetFeed`.
3. `dashboard-ui.mjs` cho `#/s/<ws>/<story-running>`:
   - có `.status.running`;
   - `.steps .s` gồm 5 phần tử với "Round 3 in progress";
   - `#thread .m` có tin nhắn You bên phải, reviewer bên trái;
   - `.finding[data-issue="3"]`;
   - `#acts .act` có đúng 20 phần tử, cộng `#earlier` với chữ "show 20 earlier";
   - ledger có "checking now".

   Cho `#/s/<ws>/<story-approved>/ISSUE-2`: phần tử issue 2 có class `flash`. Cho các phiên approved, waiting, stopped, stalemate, think (peer): mỗi phiên có `.status` đúng class và câu `what` đúng như mock.

### Anti-shortcut coverage
- Test 3 đếm đúng 20 dòng, bắt cách tải hết mọi activity.
- Test 2 về SSE bắt cách client tự hỏi lại server theo chu kỳ mà không có đẩy, và cách coi mỗi dòng event là một activity.
- Test 2c và ca "round R kết thúc khi mất kết nối" bắt cách chỉ tải lại detail khi round đổi.
- Test 2b bắt cách chỉ nối thêm sự kiện mà không gộp theo khoá (lặp dòng sau kết nối lại) và cách bỏ qua khoảng hở khi mất kết nối.
- Test 1 với `javascript:` bắt renderer chỉ escape thẻ.

### Implementation obligations
- Mọi chuỗi đến từ phiên (review, input, lệnh, lỗi) đều qua escape hoặc `renderMarkdown`. Không dùng `innerHTML` với dữ liệu chưa escape.
- Mỗi tab dùng một `EventSource`, đóng khi rời view.

### Acceptance criteria
- [ ] AC-4.1: markdown an toàn và đúng — chứng minh bởi test 1.
- [ ] AC-4.2: API activity, prompt, reveal và SSE của phiên đúng; mỗi activity có một khoá ổn định, cập nhật tại chỗ, và feed không mất hay lặp dòng và detail được đồng bộ lại khi kết nối lại — chứng minh bởi test 2, 2b và 2c.
- [ ] AC-4.3: trang chi tiết đủ 5 trạng thái, phiên peer và deep link giống mock — chứng minh bởi test 3, cùng ảnh chụp 1400px từng trạng thái đặt cạnh mock (inspection ghi vào Progress Log).

### Focused verification
```bash
node --test tests/dashboard-markdown.test.js tests/dashboard-feed.test.js tests/dashboard-server.test.js
node tests/dashboard-ui.mjs
```

### Phase gates
```bash
node --test tests/dashboard-markdown.test.js tests/dashboard-feed.test.js tests/dashboard-server.test.js tests/dashboard-model.test.js
```

### Review
Checkpoint: None (covered by the checkpoint after Phase 5)

### Commit
`feat(dashboard): session detail with conversation, issue ledger and live activity`

## Phase 5: Config hai mức, Settings, Avatars và docs
### Goal
- Runner áp dụng config global/workspace khi `begin`.
- Settings giống mock: Global/Workspace, Defaults, Per skill, "Result here", Avatars, xem file.
- Danh sách model lấy từ Codex.
- Docs cập nhật.

### Current behavior and gap
- `beginSession` dùng `effort || "high"` và chỉ dùng `model` khi được truyền. Không có config.
- `core.md` ghi "Omit `effort` (the runner uses `high`)".

### Evidence
- `review-core.js:226-229`.
- `shared/protocol/core.md`, luật "Model and effort".
- `tests/skill-templates.test.js:136-143` kiểm câu luật đó.

### Pattern
- Lỗi theo `ReviewError(message, code)`.
- Ghi atomic theo `updateState`.
- `.gitignore` `*` theo `cmdInit` (`review-runner.js:885-887`), chuyển vào `config.js` thành `ensureCrossReviewDir(workspace)` và gọi từ `cmdInit`.

### Dependencies
Phase 4, cho thông tin phiên và avatar trong thread.

### Files and symbols
- `scripts/lib/config.js`:
  - `globalConfigPath()`, `workspaceConfigPath(ws)`;
  - `readConfig(file)`: thiếu file thì `{}`, hỏng thì throw `CONFIG_INVALID`;
  - `validateConfig(obj)`;
  - `resolveSettings({skill, workingDir, explicit})` → `{reviewer, model, effort, sources}`;
  - `writeConfig(file, obj)`;
  - `ensureCrossReviewDir(ws)`.
- `review-core.js` `beginSession`: gọi `resolveSettings`, rồi dùng `reviewer`/`model`/`effort` đã resolve, ghi `settings_sources` vào state. Khi `open_dashboard` là `true`, sau khi start xong thì gọi `followInDashboard({sessionDir, workingDir})`.
- `scripts/lib/dashboard/follow.js`: `followInDashboard()` theo D16. Tham số tiêm được để test: `spawnDashboard`, `openBrowser`, `fetch`, `waitMs`. Trả `{url}` hoặc `{error}`.
- `review-runner.js` `cmdInit`: dùng `ensureCrossReviewDir`.
- `reviewers/codex.js`: `listModels()`, `defaultModel()`, `cliInfo()`.
- `dashboard/avatars.js`: `listAvatars()`, `saveAvatar(key, buf)`, `removeAvatar(key)`, `avatarFile(key)`.
- `server.js`:
  - `GET /api/settings` → `{global, workspaces: {<ws>: config}, models, modelsFetchedAt, codexDefault, reviewer: {version, loggedIn}}`;
  - `GET /api/models?refresh=1`;
  - `POST /api/settings {scope: "global"|"workspace", ws?, config}`;
  - `GET /api/avatars` → `{keys, parties: [{key, label, seenIn}]}`;
  - `GET /avatars/<key>`;
  - `POST /api/avatars/<key>` (body là ảnh);
  - `DELETE /api/avatars/<key>`.
- `ui/settings.js`: hàm thuần (ES module, không đụng DOM) `modelOptions({catalog, saved, inherited, codexDefault})`, `effortOptions({catalog, model, saved, inherited})` và `mergeForm(savedConfig, formValues, touched)`; dùng chung cho trình duyệt và test node.
- `ui/app.js`: view Settings; avatar trong thread và trong bảng Avatars.
- `shared/protocol/core.md`: luật "Model and effort" thành: "Pass `model` or `effort` only when the user names one or the plan's review checkpoint does; otherwise omit them and the runner applies the dashboard settings (workspace, then global), else the reviewer's default model and effort `high`. Do not pick a model or effort from the size of the diff or the question."
- `tests/skill-templates.test.js`: kiểm câu mới.
- Docs: `README.md` (mục "Dashboard": cách chạy, Sessions, Settings, Avatars, chỗ lưu file, giới hạn 127.0.0.1); `CLAUDE.md` (lệnh `dashboard`, cấu trúc `lib/dashboard`, `lib/config.js`, dữ liệu phiên mới của Phase 1, thứ tự ưu tiên config, các mục Key Design Decisions, Breaking Changes "v15 / pack 10.1.0"); `manifest.json` → `10.1.0`.
- Test: `tests/config.test.js`, `tests/follow.test.js`, `tests/dashboard-settings.test.js`, bổ sung cho `tests/review-core.test.js`, `tests/dashboard-server.test.js`, `tests/dashboard-ui.mjs`.

### Behavioral contract
- **`validateConfig`:**
  - `reviewer` thuộc `REVIEWER_NAMES`;
  - `model` là chuỗi không rỗng, ≤ 200 ký tự, không có khoảng trắng hay ký tự điều khiển;
  - `effort` khớp `^[a-z]+$`;
  - `open_dashboard` là boolean;
  - `skills` có khoá thuộc `SKILL_TEMPLATES`, giá trị chỉ có `model`/`effort`;
  - khoá lạ ở bất kỳ cấp nào là lỗi.
- **`resolveSettings`:** theo đúng thứ tự trong Invariants, từng khoá riêng.
  - Nguồn ghi bằng chuỗi: `requested`, `workspace:<skill>`, `workspace`, `global:<skill>`, `global`, `default`.
  - `workingDir` là thư mục truyền cho `begin`; config workspace đọc từ `<workingDir>/.cross-review/config.json`.
- **`beginSession`** truyền reviewer đã resolve cho `init`, effort và model cho `start`. Config hỏng thì throw `CONFIG_INVALID` **trước** `init`, nên không có phiên rác.
- **Follow reviews:** `open_dashboard` resolve theo workspace rồi global, mặc định `false`, ghi vào `settings_sources.open_dashboard`. Khi là `true`, `begin` chạy `followInDashboard` sau `start`.
  - Kết quả của `begin` có thêm `dashboard_url`, hoặc `dashboard_error`.
  - `begin` không bao giờ reject vì bước này.
  - MCP `review_begin` trả nguyên các trường đó; mô tả của tool ghi rằng agent có thể đưa `dashboard_url` cho user.
- **Settings:** trong Defaults có dòng "Follow reviews", đúng như mock:
  - Global: select `Off` / `On — open each new review`;
  - Workspace: thêm `Inherit — on|off`;
  - kèm dòng help của mock.
- **`listModels`:**
  - `codex debug models` (timeout 15s), lỗi thì `--bundled`, lỗi nữa thì `null`;
  - lọc `visibility === "list"`, xếp theo `priority`;
  - mỗi model ra `{slug, name: display_name, description, efforts: supported_reasoning_levels[].effort}`.
- **`defaultModel`:** đọc `$CODEX_HOME/config.toml` (mặc định `~/.codex/config.toml`), khoá `model` cấp trên cùng, trước header `[` đầu tiên. Không có thì `null`.
- **Settings giống mock:**
  - radio Global/Workspace kèm select workspace;
  - dòng đường dẫn và giải thích;
  - Defaults: Reviewer, Model ("Codex default (<name>)" hoặc "Inherit — …"), "refresh list", Effort chỉ gồm các mức model hỗ trợ;
  - bảng Per skill có "set here" và "Result here" (giá trị cùng nguồn);
  - câu thứ tự ưu tiên;
  - "Show <file>" với JSON;
  - nút "Clear this workspace", "Discard", "Save global" / "Save for <ws>".
  - Save gọi `POST /api/settings`; lỗi thì hiện thông báo, giữ form. Discard tải lại giá trị đã lưu.
  - Catalog `null` thì select model có "Codex default" và "Other…" (ô nhập slug); effort thì có `low`, `medium`, `high`, `xhigh`.
  - **Không bao giờ làm mất giá trị đã lưu**, dù catalog có hay không:
    - giá trị đã lưu hoặc kế thừa nằm ngoài danh sách vẫn là một option và được chọn sẵn: effort ngoài danh sách dự phòng hoặc ngoài `efforts` của model ghi "<value> (not verified)"; model không có trong catalog ghi "<slug> (not in list)";
    - Save chỉ đổi khoá user đã chạm vào (`mergeForm`): ví dụ đổi Follow reviews rồi Save thì `effort: "ultra"` đã lưu vẫn còn nguyên trong file.
- **Workspace config:** ghi xong thì có `.gitignore` (`*`) trong `.cross-review/`. Lưu một object rỗng thì xoá file.
- **Avatars:**
  - chỉ hiện ở scope Global, gồm You, Reviewer · Codex, mỗi caller từng xuất hiện trong các phiên đã quét (kèm số phiên), và "Agent" nếu có phiên không có caller;
  - tải lên là lưu ngay;
  - định dạng PNG/JPEG/WebP/GIF, kiểm magic bytes, ≤ 1 MB;
  - file đặt tên `<key với ":" thay bằng "-">.<ext>`;
  - khoá phải khớp `^(you|reviewer:[a-z0-9-]+|agent:[a-z0-9._-]+)$`;
  - thread, bảng Avatars và mọi chỗ có avatar dùng ảnh nếu có.

### Documentation
README, CLAUDE.md, `core.md`, manifest, như liệt kê ở Files.

### Tests first
1. `config.test.js`:
   - `resolveSettings` với ma trận 6 mức: mỗi khoá lấy từ một mức khác nhau trong cùng một lần gọi, ví dụ model từ `workspace:review-impl`, effort từ `global`, reviewer từ `default`;
   - `validateConfig` từ chối khoá lạ, skill lạ, reviewer lạ, model có khoảng trắng;
   - `readConfig` với JSON hỏng thì `CONFIG_INVALID` kèm đường dẫn file.
2. `review-core.test.js` (`HOME` tạm):
   - global `{effort:"xhigh"}` thì args của fake codex chứa `model_reasoning_effort=xhigh` và `settings_sources.effort === "global"`;
   - truyền `effort:"low"` thì ra `low` với nguồn `requested`;
   - workspace `skills.review-impl.model` thì có `--model`;
   - config hỏng thì `begin` reject `CONFIG_INVALID` và thư mục `sessions` không có phiên mới.
3. `dashboard-server.test.js`:
   - `POST /api/settings` hợp lệ ghi file đúng và tạo `.gitignore`;
   - `POST` không hợp lệ → 400, file không đổi;
   - body > 64 KB → 413;
   - avatar PNG thật → 200 và `GET /avatars/you` trả đúng byte;
   - file text đổi đuôi `.png` → 400;
   - > 1 MB → 413;
   - khoá `../x` → 400.
4. `listModels` với `codex` giả trả JSON mẫu (lấy từ `models.json` của spike): 7 model đúng thứ tự, có efforts. `codex` giả exit 1 với `debug models` nhưng chạy được `--bundled` thì dùng bản bundled. Cả hai đều lỗi thì `null`.
5. `defaultModel` với `config.toml` có `model` ở cấp trên cùng và một `model` khác trong `[profiles.x]`: trả giá trị cấp trên cùng.
6. `follow.test.js`, chạy với `HOME` tạm và tiêm `openBrowser` để ghi lại URL:
   - không có `dashboard.json`: spawn dashboard thật với `--no-open --idle-exit 5`, chờ health, đăng ký workspace, rồi mở URL dạng `http://127.0.0.1:<20000..30000>/?t=<64 hex>#/s/<ws>/<id>`;
   - có dashboard đang chạy: không spawn thêm (đếm số process) và đăng ký workspace mới;
   - `dashboard.json` trỏ tới pid đã chết: spawn bản mới;
   - `spawnDashboard` tiêm một hàm không làm gì: sau 5s trả `{error}`;
   - `review-core`: `open_dashboard: true` cùng `spawnDashboard` lỗi thì `begin` vẫn resolve với `session_dir` và `dashboard_error`, và reviewer vẫn chạy;
   - `open_dashboard` không đặt thì không gọi gì.
6b. `tests/dashboard-settings.test.js` (node, import `ui/settings.js`):
   - catalog `null`, global đã lưu `effort: "ultra"`: `effortOptions` có `ultra (not verified)` và nó được chọn;
   - catalog có, model đã lưu không có trong catalog: `modelOptions` có `<slug> (not in list)` được chọn;
   - `mergeForm` với chỉ `open_dashboard` bị chạm: kết quả giữ `effort: "ultra"`, `model` và `skills` như file;
   - qua server: config global `{effort:"ultra", model:"x-unknown"}`, `listModels` tiêm trả `null`, `POST /api/settings` với kết quả `mergeForm` sau khi đổi Follow reviews → file vẫn có `effort: "ultra"` và `model: "x-unknown"`.
7. `dashboard-ui.mjs`, `#/settings`:
   - có `.form` với `#f-follow`, 4 dòng `#per-skill tr`, `#avatars tr` ≥ 2, `#save` với chữ "Save global";
   - `#/settings/<ws>` ra `#save` "Save for <ws>" và `#avatars-block` bị ẩn.

### Anti-shortcut coverage
- Test 1 trộn nguồn trong một lần gọi, bắt cách resolve cả object theo mức (đúng loại lỗi ISSUE-3 trong mock).
- Test 2 về config hỏng bắt cách tạo phiên trước khi kiểm config.
- Test 3 về magic bytes bắt cách chỉ xét đuôi file hoặc `Content-Type`.
- Test 6b bắt cách dựng option chỉ từ catalog hoặc danh sách dự phòng rồi gửi lại cả form (âm thầm đổi `ultra` thành giá trị đầu tiên).

### Implementation obligations
- `beginSession` không đổi chữ ký cũ (chỉ thêm `caller` từ Phase 1).
- `replySession` vẫn dùng model và effort đã lưu, không đọc config: config chỉ áp cho phiên mới.
- Catalog chỉ cache trong bộ nhớ của server; "refresh list" gọi lại.

### Acceptance criteria
- [ ] AC-5.1: config hợp lệ được resolve đúng thứ tự cho từng khoá; config hỏng chặn `begin` trước khi tạo phiên — chứng minh bởi test 1 và 2.
- [ ] AC-5.2: API Settings và avatar ghi đúng, từ chối input xấu — chứng minh bởi test 3.
- [ ] AC-5.3: catalog và model mặc định có đường dự phòng; giá trị đã lưu ngoài danh sách vẫn hiện, được chọn và không bị Save ghi đè — chứng minh bởi test 4, 5 và 6b.
- [ ] AC-5.4: trang Settings, Follow reviews và Avatars giống mock — chứng minh bởi test 7, cùng ảnh chụp 1400px đặt cạnh mock (inspection ghi vào Progress Log).
- [ ] AC-5.6: Follow reviews mở đúng phiên, dùng lại dashboard đang chạy hoặc khởi động bản mới, và không bao giờ làm hỏng `begin` — chứng minh bởi test 6.
- [ ] AC-5.5: luật model/effort trong `core.md` và docs khớp hành vi mới — chứng minh bởi `tests/skill-templates.test.js` và inspection README/CLAUDE.md.

### Focused verification
```bash
node --test tests/config.test.js tests/follow.test.js tests/dashboard-settings.test.js
node --test --test-name-pattern "settings|avatar|CONFIG_INVALID|global effort|requested" tests/
node tests/dashboard-ui.mjs
```

### Phase gates
```bash
node --test tests/config.test.js tests/follow.test.js tests/dashboard-settings.test.js tests/review-core.test.js tests/dashboard-server.test.js tests/skill-templates.test.js
```

### Review
Checkpoint: `/review-impl` (checkpoint cuối, diff cộng dồn từ trước Phase 1)

### Commit
`feat(dashboard): two-level review settings, follow reviews, model catalog, avatars; docs and pack 10.1.0`

## Completion Criteria
- Mọi AC đã được đánh dấu, kèm lệnh hoặc inspection ghi trong Progress Log.
- Global Gates đều exit 0.
- Có ảnh chụp 1400px của Sessions, chi tiết (5 trạng thái và peer) và Settings, đặt cạnh mock để user duyệt.
- Checkpoint cuối `/review-impl` APPROVE, hoặc user duyệt.
- `mockups/dashboard.html` được commit cùng plan, làm tài liệu tham chiếu.

## Progress Log
- 2026-10-15: Viết plan. Spike ở `.cross-review/spikes/dashboard/`. Mock được user duyệt, gồm cả Avatars (tải lên, không đóng gói logo) và Follow reviews.
- 2026-10-15, user chốt:
  - giờ của activity không cần tuyệt đối chính xác (watchdog, sai số khoảng 1s);
  - lưu input của từng round;
  - dùng `ended_at` và cửa sổ 24 giờ;
  - chấp nhận chữ "passed / failed (exit N)";
  - cổng ngẫu nhiên trong 20000–30000, kèm token;
  - thêm tuỳ chọn Follow reviews.
- 2026-10-15, user: mock và minh hoạ không được lộ conversation thật trên máy. Đã thay tên workspace và tiêu đề phiên thật trong mock bằng dữ liệu bịa; thêm invariant "Không lộ dữ liệu thật của user"; test 8 của Phase 2 dùng `output.jsonl` tổng hợp.
- 2026-10-15: review-plan round 1 (REVISE, 8 issue), đã sửa: kết quả phiên finalize vì hội tụ; phân loại theo thời gian tách khỏi parse và chạy mỗi tick; quét lại phiên/workspace mới khi trang đang mở; khoá activity `${round}:${item.id}` với `add`/`update`; `snapshot` khi kết nối SSE, gộp idempotent; `line` của item chỉ có `item.completed`; `flushLineTimes` trước khi poll/stop/resume/deadline kill watchdog; Settings giữ giá trị đã lưu ngoài catalog.
- 2026-10-15: review-plan round 2 (REVISE, 1 issue): mỗi `snapshot` tải lại detail kể cả khi round không đổi; SSE danh sách gửi `sessions` đầy đủ mỗi lần kết nối. Round 3: APPROVE.
- 2026-10-15, Phase 1 xong. Base cho checkpoint cuối: `76b6c28`. AC-1.1–1.4: `node --test --test-name-pattern "raw input|resume fails writes no input|ended_at|caller|watchdog stamps|before the first tick|flush the round|flushLineTimes" tests/` 9/9 pass; AC-1.5: ba test legacy pass; phase gate `review-core` + `mcp-server` 51/51. Lệch plan: `flushLineTimes` nằm ở module mới `scripts/lib/line-times.js` (cùng `readLineTimes`/`parseLineTimes` cho Phase 2) thay vì trong `review-runner.js`, vì runner chạy `main()` khi import nên test không gọi trực tiếp được. Test 7 tự kill watchdog trước khi thêm dòng cuối, để chỉ `stop` có thể ghi giờ (đã thử bỏ flush trong `cmdStop` thì test fail). Không có công cụ GitNexus trong phiên này nên không chạy `gitnexus_impact`/`detect_changes`.
- 2026-10-15, user: thêm avatar mặc định tự tạo bằng AI (cú = reviewer, vịt = agent, shiba = You), đầu và toàn thân. Đã thu nhỏ vào `scripts/lib/dashboard/ui/avatars/` (đầu 256px, toàn thân 480px). D13 và Phase 4 (Avatar) cập nhật; ảnh do user tải lên vẫn ưu tiên hơn.
- 2026-10-15, Phase 2 xong. Review checkpoint Phase 1 (`review-impl-20261015-011`): APPROVE ở round 2, sau khi sửa ISSUE-1 (dòng ghi lúc reviewer bị kill vì deadline hoặc vì poll terminal chưa có giờ → flush sau `killTree`, commit `58e2a8b`, test "output written while the deadline stops the reviewer is stamped"). Phase 2: AC-2.1–2.4 bằng `node --test tests/dashboard-model.test.js` 18/18; phase gate model + review-core 63/63. Lệch plan: `model.roundActivity(parsed, round)` thêm sẵn cho `/api/activity` ở Phase 4; "Now" của lệnh `run` hiện nguyên chuỗi lệnh (không chỉ đoạn đầu); dòng `cd … &&` được bỏ qua khi phân loại lệnh. Test viết cùng lúc với code nên không có bước red riêng cho Phase 2.
- 2026-10-15, Phase 3 xong. Red: `node --test tests/dashboard-server.test.js` fail vì chưa có module. AC-3.1–3.3, 3.5, 3.7: `node --test tests/dashboard-server.test.js` 14/14 (đã thử phá: chỉ phân loại lại khi file đổi thì test 4b fail). AC-3.4: `node tests/dashboard-ui.mjs` ok (5 in progress, 8 in history, lọc, route, trạng thái trống); ảnh 1400px trong thư mục tạm đặt cạnh ảnh mock cùng cỡ: header, cột, màu, icon, khoảng cách khớp; khác do dữ liệu thật (chữ lỗi thật thay "Usage limit reached…", tiêu đề dài hơn). AC-3.6: cài vào HOME tạm rồi `install-check` ok; dashboard chạy từ bản cài đọc được `pack 10.0.0`. Phase gate server + model 32/32; cả suite 132/132, ba test legacy pass. Lệch plan:
  - test UI điều khiển Chrome qua DevTools Protocol (`tests/helpers/chrome.js`, WebSocket có sẵn của Node) thay vì `--dump-dom`: `--dump-dom` chụp DOM lúc load, trước khi có dữ liệu, còn `--virtual-time-budget` treo vì stream SSE không bao giờ xong;
  - installer chép thêm `manifest.json` vào runtime để header có `pack <version>`; `install-check` kiểm file này cùng UI và LICENSE;
  - thêm sẵn `GET /api/session` (detail JSON) để test 3 kiểm khoá phiên trên một route thật; Phase 4 dựng trang chi tiết trên route này. Trang chi tiết và Settings tạm chỉ có tiêu đề;
  - `startDashboard` nhận thêm tuỳ chọn cho test (`pickPort`, `discoveryFile`, `now`, `tickMs`, `rescanMs`, `isAlive`) và trả thêm `root`, `closed`; `removeDiscoveryIfOwn` so cả token;
  - CSS thêm ngoài mock: tên và tab không co, `.where` cắt bằng "…" khi root dài (kèm `title`); cột Model, Reviewer time, When không xuống dòng như trong mock; bộ lọc Result có thêm "no reply";
  - ảnh toàn thân được tách nền thành trong suốt (flood fill từ mép), vì nền gần trắng của ảnh hiện thành ô vuông trên nền giấy. Trang 401 nhúng ảnh cú dạng `data:` với CSP riêng (style theo hash), vì mọi request khác đều cần token.
  Không có công cụ GitNexus trong phiên này nên không chạy `gitnexus_impact`/`detect_changes`.
- 2026-10-15, checkpoint sau Phase 3 (`review-impl-20261015-012`) round 1: REVISE, 4 issue, nhận sửa cả 4 kèm test hồi quy: `/api/session` phục vụ cả phiên là symlink mà danh sách bỏ qua (giờ chỉ nhận thư mục `listSessions` trả về); round thất bại chưa ai poll mất `thread_id` trong log nên bị coi là không resume được; round hoàn tất chưa ai poll thiếu phép tính hội tụ của runner (tách thành `scripts/lib/convergence.js`, runner và dashboard dùng chung); `inputValues` tách theo mọi heading viết hoa (giờ dùng tên placeholder của skill như runner, `placeholderNames` được export từ `review-core.js`). Cả suite 138/138, `dashboard-ui` ok.
  Round 2: ISSUE-1–4 được xác nhận đã sửa; ISSUE-5 (do bản sửa ISSUE-4 sinh ra): tên placeholder phải lấy từ `state.skills_dir` của phiên, cache theo thư mục và skill. Đã sửa kèm test hai phiên dùng hai thư mục prompt; cả suite 139/139.
  Round 3: ISSUE-6, dọn profile Chrome sau test UI thỉnh thoảng lỗi `ENOTEMPTY` vì Chrome còn ghi vài file sau khi bị kill. Đã sửa bằng `rmSync` có thử lại, commit `ad642a0`, `dashboard-ui` ok 5/5 lần chạy. Round 4: APPROVE, `review_end` đã finalize.
- 2026-10-15, Phase 4 xong. Red: `node --test tests/dashboard-markdown.test.js tests/dashboard-feed.test.js tests/dashboard-server.test.js` fail (chưa có `feed.js`, `markdown.js`; `/api/activity` 404; không có sự kiện SSE của phiên).
  - AC-4.1: `dashboard-markdown.test.js` 4/4.
  - AC-4.2: `dashboard-feed.test.js` 6/6 (2b, 2c); `dashboard-server.test.js` 20/20, gồm 5 test mới: phân trang activity, prompt 404, `add` theo thứ tự có `t`, `update` cùng key với exit 0/1 và `total` không tính dòng `started`, kết nối lại có `snapshot` với total mới, round kết thúc khi mất kết nối vẫn giữ round R và `/api/session` trả `waiting`, `session` khi finalize, reveal 403/404.
  - AC-4.3: `node tests/dashboard-ui.mjs` ok 6/6 lần chạy. Ảnh 1400px của running, approved (deep link `ISSUE-2`), waiting, stopped, stalemate, think nằm trong thư mục tạm (đã xoá sau khi xem), đặt cạnh mock: bố cục, bong bóng, finding, ledger, aside, bước, đồng hồ khớp. Waiting giống mock từng chữ. Khác do dữ liệu: câu stopped là lỗi thật của round ("You've hit your usage limit…"); Model là "Codex default" vì Phase 5 mới có catalog.
  - Phase gates: 52/52. Cả suite 154/154. Ba test legacy pass. Cài vào HOME tạm rồi `install-check` ok, UI cài có `feed.js` và `markdown.js`.

  Lệch plan:
  - **Đếm 20 dòng.** Mock gộp các lần đọc file liền nhau thành một dòng, nên 20 event có thể chỉ hiện 18 dòng. Test 3 vì vậy kiểm tổng `data-n` (số event mỗi dòng) bằng 20, thay vì đếm `#acts .act` bằng 20.
  - **Câu đầu của round đang chạy** ("Checking the reply to ISSUE-3.") được dựng phía client từ reply gần nhất của agent.
  - **Model thêm hai trường:** `tone: "stopped"` cho bước của round bị dừng, và `failed` cho tin nhắn round bị dừng (để in "The turn failed: …").
  - **Fixture:** review round 2 của phiên think thêm `### Key Insights`, vì parser thật không nhận ra review quá ngắn (UI từng hiện "no verdict"). Test UI nay kiểm verdict cuối là `consensus`.
  - **`startDashboard` nhận thêm `reveal`** để test không mở Finder thật.
  - **Bỏ qua render khi detail không đổi:** trang không dựng lại khi detail giống lần trước. Lần tải thứ hai lúc mở trang (do `snapshot`) từng xoá hiệu ứng nhấp nháy của deep link; test UI fail 3/4 lần trước khi sửa.
  - **Một stream mỗi lúc:** trang Sessions mở stream danh sách, trang chi tiết mở stream của phiên, Settings không mở stream nào. Rời view thì stream được đóng.

  Không có công cụ GitNexus trong phiên này.
- 2026-10-15, Phase 5 xong. Red: `node --test tests/config.test.js tests/follow.test.js tests/dashboard-settings.test.js` fail (chưa có `config.js`, `follow.js`, `ui/settings.js`, `listModels`); `skill-templates.test.js` fail với câu luật mới trước khi sửa `core.md`.
  - AC-5.1: `config.test.js` 7/7; `review-core.test.js` thêm 4 test (effort global và requested, model per-skill của workspace, config hỏng → `CONFIG_INVALID` và không có thư mục sessions, `open_dashboard` gọi follow).
  - AC-5.2: `dashboard-server.test.js` thêm test settings (ghi global/workspace, `.gitignore`, object rỗng xoá file, từ chối khoá lạ, ws lạ, Origin lạ, body > 64 KB) và avatars (PNG lưu và trả đúng từng byte; text đổi đuôi, > 1 MB, khoá xấu bị từ chối).
  - AC-5.3: `dashboard-settings.test.js` 6/6 (catalog, `--bundled`, `null`, `defaultModel`, option ngoài danh sách, `mergeForm`, Save qua server giữ `effort: "ultra"` và `model: "x-unknown"`).
  - AC-5.4: `node tests/dashboard-ui.mjs` ok: Settings global (Follow reviews, 4 dòng per-skill, Avatars, "Save global", "Codex default (Model A)", help `codex-cli …, signed in`), Save ghi đúng `{open_dashboard: true, skills: {review-impl: {model: "model-b"}}}`, workspace "Save for harbor-app" với "Inherit — on", không có Avatars, Save ghi `{effort: "low"}`; tải ảnh You qua ô file thì thread dùng `avatars/you?v=…`. Ảnh 1400px global và workspace đặt cạnh mock: bố cục, nhãn, select, bảng, nút khớp (đã xoá ảnh).
  - AC-5.5: `skill-templates.test.js` 9/9; README có mục Dashboard, CLAUDE.md có lệnh `dashboard`, `lib/config.js`, `lib/dashboard`, dữ liệu phiên mới, thứ tự ưu tiên, Breaking Changes "v15 / pack 10.1.0"; `manifest.json` 10.1.0.
  - AC-5.6: `follow.test.js` 3/3 (dùng lại dashboard đang chạy, khởi động bản mới, lỗi không làm hỏng `begin`).
  - Focused: `--test-name-pattern "settings|avatar|CONFIG_INVALID|global effort|requested"` 17/17. Phase gates 96/96. Cả suite 176/176, ba test legacy pass. Cài vào HOME tạm rồi `install-check` ok (thêm kiểm `config.js`, `ui/settings.js`; runtime có pack 10.1.0).

  Lệch plan:
  - **`hooks.follow`** trong `review-core.js` là chỗ test thay `followInDashboard`; mặc định nạp `dashboard/follow.js` khi cần.
  - **`startDashboard` nhận `catalog`** (mặc định adapter codex) để test không gọi `codex` thật.
  - **Khoá `agent:unknown`** cho avatar của các phiên không có caller ("Agent").
  - **`listModels`, `cliInfo` là async** (chạy `codex` bằng `execFile`) để server không bị chặn 15 s.
  - **id trong form Settings có hậu tố `-set`** (`f-reviewer-set`, `f-model-set`, `f-effort-set`) vì `f-reviewer`, `f-model`, `f-effort` đã là id của khung Session ở trang chi tiết.
  - **Facts của phiên** hiện tên model từ catalog ("Model A · Codex default") khi trang đã tải catalog.
  - Mọi test chạy review hoặc dashboard (review-core, mcp-server, dashboard-server, dashboard-settings, follow, dashboard-ui) đặt `HOME` tạm.

  Không có công cụ GitNexus trong phiên này.
- 2026-10-15, checkpoint cuối (`review-impl-20261015-013`) round 1: REVISE, 7 issue, nhận sửa cả 7 kèm test hồi quy (đỏ trước khi sửa):
  - ISSUE-1, Save trả về sau khi đã đổi scope ghi giá trị global vào form workspace: Save giữ scope/ws/draft lúc gửi, chỉ reset form khi vẫn đúng form đó; mở Settings chờ Save đang chạy xong rồi mới tải lại. Test UI: giữ phản hồi POST, chuyển sang `#/settings/inkwell`, form workspace vẫn `{}`, Save chỉ ghi `{open_dashboard: false}`.
  - ISSUE-2, kết nối lại sau một khoảng dài để lại lỗ trong feed: trang "latest" không chạm tới item đã cache thì thay chúng (`applyPage(..., {latest: true})`), giữ `shown`. Test `dashboard-feed`.
  - ISSUE-3, giờ watchdog ghi muộn không tới SSE: SSE so `lastLine` và `t`. Test server: dòng có `t: null` rồi được đóng dấu thì có `update` với `t`.
  - ISSUE-4, đọc lại toàn bộ log mỗi tick (lệch D5): adapter có `newLogState`/`foldLog`/`logItems`/`logOutcome` (fold tăng dần; `activityItems` dùng chúng); `model.js` cache theo file: inode, offset, phần dòng dở, 256 byte đầu (đổi thì đọc lại từ đầu). Test: append ~150 byte sau log 2 MB chỉ đọc < 64 KB; dòng bị cắt đôi; file bị thay; file ghi đè tại chỗ.
  - ISSUE-5, mở trình duyệt lỗi vẫn báo thành công: `openBrowser` trả `{ok, error}` theo lỗi spawn/exit code (chạy quá 5 s coi như đã mở); `followInDashboard` trả `{url, error}` và `begin` báo `dashboard_error` có kèm link.
  - ISSUE-6, reply có model/effort vẫn giữ nguồn cũ: `settings_sources.model/effort` thành `requested`.
  - ISSUE-7, trường của finding nhiều dòng mất code block: `renderField` (một dòng: inline; nhiều dòng: block).
- 2026-10-15, user (trong lúc review): (1) trang session hiện round mới nhất ở trên, trong mỗi round giữ thứ tự viết (tin mở round rồi câu trả lời của reviewer); activity cũng mới nhất ở trên, "show 20 earlier" ở dưới; (2) bảng In progress mỗi trường một dòng (cắt bằng "…", đủ chữ ở `title`) để cập nhật live không làm giật; (3) History phân trang vừa cửa sổ, không cuộn (ít nhất 3 dòng; "‹ Newer · 1–N of M · Older ›"); (4) Chrome trong test chạy với `--use-mock-keychain --password-store=basic`, vì HOME tạm làm macOS hỏi keychain "Chrome". Lệch mock có chủ đích theo yêu cầu user. Test UI kiểm thứ tự round, dòng activity mới nhất ở đầu, mọi dòng In progress cùng chiều cao, trang 1000px không cuộn và nút Older. Cả suite 180/180, ba test legacy pass, `dashboard-ui` ok 3/3 lần.
- 2026-10-15, user: hội thoại đảo hẳn, tin mới nhất ở trên cùng (reviewer đang làm hoặc vừa trả lời đứng đầu; trong mỗi round, câu trả lời của reviewer nằm trên tin mở round; tin "You asked the agent" ở cuối trang). Thay cho cách giữ thứ tự viết trong round ở mục trước. Test UI: tin đầu tiên là `s-live`, nhãn đầu là "ROUND 3", tin cuối là của user; `dashboard-ui` ok 2/2 lần.
- 2026-10-15, checkpoint cuối round 2: ISSUE-1–7 đã đóng; REVISE với 4 issue mới, nhận sửa cả 4 kèm test hồi quy:
  - ISSUE-8 (high), `begin` qua CLI có Follow reviews thoát mà không in JSON: timer 5 s của `openBrowser` bị `unref` cùng process con, nên Node thoát trong lúc `begin` còn chờ launcher. Giờ timer được giữ ref, xoá ngay khi launcher trả lời. Test subprocess trong `follow.test.js` (launcher `open` giả thoát sau 0,25 s, stdout có `session_dir` và `dashboard_url`), đỏ trước khi sửa.
  - ISSUE-9, round mới ghi đè `output.jsonl` với cùng byte đầu kế thừa verdict của round trước: cache log gắn với số round. Test `dashboard-model`, đỏ trước khi sửa.
  - ISSUE-10, hai lần Save chồng nhau làm mất giá trị đã lưu: mỗi lúc chỉ một Save (nút bị khoá tới khi có trả lời); form chỉ reset khi vẫn đúng những gì đã gửi, nên chỗ sửa thêm trong lúc chờ được giữ. Test UI, đỏ trước khi sửa.
  - ISSUE-11, phân trang History đo theo dòng của trang trước: trang tính theo `offset`, vẽ các dòng ứng viên kèm pager rồi giữ những dòng kết thúc phía trên pager; Older đi qua đúng số dòng đã hiện, Newer quay về offset trước. Test UI với 40 phiên tiêu đề dài ngắn xen kẽ ở cửa sổ 1200px: mọi trang không cuộn, các trang nối tiếp liền mạch, Newer quay lại đúng trang.
- 2026-10-15, user: chuyển tab Sessions ↔ Settings bị giật vì thanh cuộn chỉ có ở trang dài; `html { scrollbar-gutter: stable; }` giữ chỗ cho thanh cuộn ở mọi trang (test UI kiểm giá trị này, vì Chrome headless ẩn thanh cuộn). Cả suite 182/182, ba test legacy pass, `dashboard-ui` ok.
- 2026-10-15, final checkpoint round 3 (`review-impl-20261015-013`), REVISE với 1 lỗi:
  - ISSUE-12, lượt tải Settings cũ trả về muộn ghi đè workspace đang mở: `openSettings` đếm lượt tải và bỏ câu trả lời của lượt cũ hoặc khi người dùng đã rời Settings. Test UI giữ GET `/api/settings` của harbor-app rồi mở inkwell (nút vẫn "Save for inkwell", chỗ sửa còn nguyên), và một lượt tải trả về sau khi đã sang `#/` không kéo người dùng về Settings; cả hai đỏ trước khi sửa. Cả suite 182/182, ba test legacy pass, `dashboard-ui` ok.
- 2026-10-16, final checkpoint round 4, REVISE với 1 lỗi:
  - ISSUE-13, caller có title chỉ toàn khoảng trắng làm vỡ trang session và bảng Avatars: chữ cái đầu lấy qua helper `initial` (ký tự đầu sau trim, nếu không có thì "AG"), dùng chung cho thread và bảng Avatars. Test UI với một phiên bịa có name và title rỗng: thread có avatar agent "AG", bảng Avatars đủ 3 dòng; đỏ trước khi sửa. Cả suite 182/182, ba test legacy pass, `dashboard-ui` ok.
- 2026-10-16, final checkpoint round 5, REVISE với 1 lỗi (low):
  - ISSUE-14, workspace tên `__proto__` mất khỏi Settings: các bảng theo workspace trong `settingsPayload` dùng `Object.create(null)`. Cùng chỗ đó còn một lỗi tương tự: workspace tên `global` có file hỏng bị báo thành lỗi của config global. Giờ `errors` tách thành `{ global, workspaces }`, UI đọc `errors.workspaces[ws]`. Test server mới với hai workspace bịa `__proto__` và `global`, đỏ trước khi sửa. Cả suite 183/183, ba test legacy pass, `dashboard-ui` ok.
