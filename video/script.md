# cross-review — kịch bản video giới thiệu (v2, nháp)

Ngôn ngữ video: **tiếng Anh**. Ghi chú sản xuất viết tiếng Việt; chữ trên màn hình và lệnh để nguyên tiếng Anh.

## 1. Thông điệp

- **Câu chốt:** *A second model checks your agent's work.* (giống landing)
- **Ba ý, theo thứ tự xuất hiện:**
  1. Bạn gọi review ngay trong agent (Claude Code hoặc Codex).
  2. Reviewer đọc code, chạy test, nêu issue; agent sửa hoặc phản bác bằng bằng chứng.
  3. Lặp tới khi reviewer approve, và bạn xem lại mọi vòng trên dashboard.
- **Ràng buộc:**
  - Chỉ dữ liệu bịa: workspace `orchard-api`, file `src/upload/*.js`.
  - Không logo, màu hay giao diện của Claude Code hay Codex. Cảnh terminal là một terminal trung tính do mình tự dựng; tên Claude Code và Codex chỉ xuất hiện dưới dạng chữ.
  - Chữ trong video dùng font OFL: Source Serif 4, Source Sans 3, JetBrains Mono.

## 2. Bộ video

| Bản | Độ dài | Âm thanh | Tỉ lệ | Dùng ở |
|---|---|---|---|---|
| Giới thiệu | ~88s | Không tiếng | 16:9, 1920×1080, 30 fps | Landing, ngay dưới hero: tự chạy khi cuộn tới, có nút điều khiển, poster là thẻ mở đầu |

Xuất: MP4 (H.264) và WebM (VP9), không track âm thanh, mỗi file ≤ 3 MB, kèm `poster.png`.

## 3. Phân cảnh

Bản v1 chỉ có hình, người xem chưa hiểu cách hoạt động (góp ý của người dùng, 2026-10-16). Bản v2 xen thẻ chữ giải thích (lời lấy theo landing) với hình minh hoạ từng bước. Thẻ chữ ở lại khoảng 1 giây cho mỗi 3,5 từ, cộng 1 giây.

| Cảnh | Thời lượng | Nội dung | Chú thích ở đáy |
|---|---|---|---|
| title | 5.5s | Con cú + **A second model checks your agent's work.** + *An agent that checks its own work keeps its own blind spots.* | — |
| how | 7s | Sơ đồ: You → `/review-impl` (hoặc `$review-impl`) → Your agent (Claude Code or Codex) ⇄ The reviewer (Codex): "the change, then fixes" / "issues, then a verdict" | — |
| step1 + terminal | 6.5s + 2.7s | *You ask for a review.* `/review-impl` trong Claude Code, `$review-impl` trong Codex; plan thì dùng `review-plan` → gõ `/review-impl` | Step 1 |
| step2 + terminal | 6s + 5.8s | *A second model checks.* → reviewer đọc file, chạy test, vòng 1 REVISE với 2 issue | Step 2 |
| step3 + terminal | 5s + 4.9s | *Your agent answers each issue.* → Fixed ISSUE-1, Disputed ISSUE-2, vòng 2 bắt đầu | Step 3 |
| step4 + dashboard | 6.5s + ~15s | *Round after round, until it approves.* → dashboard thật: activity vòng 2 cập nhật, rồi Approved in round 2, sổ issue `fixed → verified`, `disputed → withdrawn` | Step 4 |
| decide | 9s | *The models argue. You decide.*: disputes need evidence, stalemates come to you, your instruction wins | — |
| skills | 9s | Sáu skill, mỗi skill một dòng | — |
| end | 5s | Con cú, `npx @tlelabs/cross-review`, `cross-review.tlelabs.com · for Claude Code and Codex · MIT` | — |

Giữa các cảnh, cảnh trước mờ dần về màu giấy rồi cảnh sau hiện lên (0.2s mỗi chiều); không crossfade, vì hai thẻ chữ chồng lên nhau sẽ rối. Vòng lặp quay về thẻ mở đầu cùng nền giấy.

Chỉ ba font OFL được xuất hiện trong video: `build.mjs` kiểm tra mọi trang trước khi chụp hoặc quay xong và dừng nếu có chữ nào rơi về font hệ thống. Ký hiệu font không có (dấu tích, vòng quay) được vẽ bằng CSS.

## 4. Pipeline (trong `video/`, chạy lại được ở mỗi bản phát hành)

- `video/build.mjs`: một lệnh làm hết, không cần sửa dashboard.
  - Tải ba font OFL từ `github.com/google/fonts` với SHA-256 cố định, vào thư mục cache bị git bỏ qua. Font không được commit và site không tải font nào.
  - Cảnh terminal là một trang HTML (`video/terminal.html`) tự chạy theo kịch bản, render bằng JetBrains Mono.
  - Cảnh dashboard: dashboard thật chạy với `--root` là một thư mục tạm, HOME tạm. Một script ghi dần file phiên (vòng 1 → câu trả lời của agent → vòng 2 đang chạy → approve), nên dashboard tự cập nhật như khi review thật. Font được chèn qua CDP (`Page.setBypassCSP` + `@font-face`).
  - Quay bằng CDP screencast: terminal ở viewport 1280×627 tỉ lệ 1.5, dashboard ở 1100×539 tỉ lệ 1920/1100 (chữ to hơn), cùng ra 1920×940 cộng thanh chú thích 140 px. ffmpeg ghép thành 30 fps đều, thêm chú thích, thẻ mở đầu, thẻ kết và chuyển cảnh mờ.
  - Không thêm dependency npm nào: Chrome, ffmpeg và Node có sẵn (cùng cách với `docs/screenshots.mjs`).
- Ảnh README (`docs/screenshots.mjs`), ảnh dashboard trên site và `og.png` của site được chụp lại bằng cùng các font OFL.

## 5. Landing

- Đặt video ngay dưới hero: `<video autoplay muted loop playsinline preload="metadata" poster=…>`, có WebM và MP4.
- Người bật "giảm chuyển động" (`prefers-reduced-motion`) chỉ thấy ảnh poster, kèm nút Play.
- Font chỉ được vẽ thành hình trong video, không được phát hành kèm site, nên không cần ghi chú OFL trên site.
