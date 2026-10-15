# Cải thiện loop-plan / loop-implement từ dữ liệu codex-review

Trạng thái: **Kế hoạch implement đã hoàn thiện ở mục 21, chờ user cho lệnh implement.** Các mục 1–20 là lịch sử thảo luận và bằng chứng; chỗ nào khác với mục 21 thì theo mục 21. Cập nhật lần cuối: 2026-10-15.
Dữ liệu và script phân tích: `/Volumes/UGREEN_NVMe/projects/common_issues`.

Ký hiệu trạng thái từng mục:
- **[CHỐT]**: user đã nêu hoặc đồng ý.
- **[ĐỀ XUẤT]**: Claude đề xuất, chờ user xác nhận.
- **[MỞ]**: câu hỏi chưa trả lời.
- **[ĐÃ LÀM]**: đã thay đổi trong repo.

---

## 1. Bối cảnh và kết luận từ các nghiên cứu trước

Nguồn: khoảng 2.067 phiên codex-review (8.701 issue).
- impl-review: 1.441 phiên, 5.371 issue.
- plan-review: 515 phiên, 3.300 issue.
- 5.236 issue impl đã được gán vào taxonomy 70 lớp (`data/taxonomy/`).

### 1.1 Hướng "decision model (Jev) gợi ý cho reviewer": tạm dừng [CHỐT]
- Jev phát hiện tốt hình dạng rủi ro (AUROC thẻ trung vị 0,94). Nhưng nó không phân biệt được code lỗi với code đúng có cùng hình dạng, nên trên hunk sạch nhiễu cộng dồn lớn.
- Pilot end-to-end (codex exec, cửa sổ khoảng 55 dòng, 10 issue bị bỏ sót + 10 hunk sạch):
  - không gợi ý: 0/10
  - checklist lớp: 1/10
  - thẻ bẫy: 0/10
  - **gợi ý đúng tuyệt đối (oracle): 1/10**

  Lý do: phần lớn bug cần code nằm ngoài cửa sổ. Reviewer thiếu bằng chứng chứ không thiếu chú ý.
- Bài học: **gợi ý hay checklist dạng nhắc nhở gần như không đổi được hành vi của model.**

### 1.2 Lỗi lãng phí nằm ở người viết code, không ở reviewer
- Codex bắt lỗi khá tốt: 93% issue được sửa, 4% bị cãi lại.
- Chi phí nằm ở số vòng:

  | | Trung bình số vòng | Phiên ≥4 vòng |
  |---|---|---|
  | impl-review | 2,6 | 20% |
  | plan-review | 3,1 | 35% |

- 32% issue impl được nêu từ vòng 2 trở đi. Trong số đó **khoảng 70% là bug do chính lần sửa trước gây ra**, chỉ khoảng 30% là bị bỏ sót thật.

### 1.3 Phân bố lỗi impl (5.236 issue) và giai đoạn nên chặn

| Nhóm | Lớp tiêu biểu | Khoảng | Chặn tốt nhất ở |
|---|---|---|---|
| Hợp đồng xuyên thành phần | producer/consumer lệch (135), config khai báo mà không áp (134), docs lệch (260), projection desync (142), metric lệch sự thật (157), degradation không truyền (83), cancel/timeout không truyền (73), cache không invalidate (41) | ~20% | Plan |
| Trạng thái và lỗi giữa chừng | thiếu guard chuyển trạng thái (157), read-then-write không CAS (131), ghi nhiều chỗ không atomic (78), bỏ cleanup khi lỗi (69), nuốt lỗi báo thành công (94), sai mã lỗi (97) | ~14% | Plan + Implement |
| Biên giá trị | validate ở biên (212), giá trị rỗng/thiếu (88), page/size (53), tăng không giới hạn (68), byte/char (45) | ~10% | Plan + Implement — **xem mục 3, không được hiểu là "thêm giới hạn"** |
| Trung thành với plan | làm yếu hoặc đổi thiết kế (370), thiếu hạng mục (243) | ~12% | Implement |
| Test yếu | thiếu ca test plan yêu cầu (201), test không fail được (130) | ~6% | Implement |
| Bug do lần sửa trước | 70% issue vòng ≥2 | — | Implement (lúc sửa theo review) |

Plan-review: 474/3.300 issue có category "sequencing" (thứ tự phase sai), 455 "architecture", 1.610 "correctness". Phần này chưa gán nhãn taxonomy.

### 1.4 Tác động của loop skills (dùng từ 20/9/2026), tính theo tỉ lệ trên tổng issue impl

| Lớp | Trước 20/9 | Sau 20/9 |
|---|---|---|
| Docs/spec lệch | 5,5% | 3,0% ↓ |
| Thiếu test plan yêu cầu | 4,2% | 2,4% ↓ |
| Test không fail được | 2,7% | 1,7% ↓ |
| Yêu cầu chưa làm | 4,6% | 4,4% = |
| **Làm yếu hoặc đổi thiết kế** | 6,4% | **8,2% ↑** |

Docs-first và tests-first đã có tác dụng. Lỗ hổng còn lại là tự đổi thiết kế hoặc nới ràng buộc mà không khai báo, và làm thiếu bề mặt.

---

## 2. Nguyên tắc thiết kế quy tắc

- **[ĐỀ XUẤT] Quy tắc phải sinh ra thứ kiểm được, không phải lời nhắc.** Mỗi quy tắc buộc người làm viết ra một bảng, một đối chiếu hay một lệnh, mà codex-plan-review hoặc codex-impl-review kiểm được. Không dùng checklist kiểu "nhớ kiểm X".
- **[CHỐT] Quy tắc phải sắc.** Chỉ đưa lớp lỗi có bằng chứng: lặp lại, ở nhiều dự án, ít bị cãi. Không đưa những thứ model vốn đã làm đúng, vì chúng tốn thời gian xử lý mà không thêm giá trị.
- **[ĐỀ XUẤT] Không lặp lại thứ loop skills đã có:** docs-first, tests-first, anti-shortcut, đối chiếu AC lúc kết thúc.
- **[ĐỀ XUẤT] Giữ SKILL.md gọn.** Bảng, danh mục và chính sách chi tiết đặt trong `references/`. Mục nào phase không đụng tới thì ghi "N/A".

---

## 3. Chính sách giới hạn (bound, cap, max, limit) [CHỐT — ý của user, Claude bổ sung chi tiết]

### Vấn đề
Agent tạo ra nhiều giá trị max hay biên tuỳ tiện. Chúng không làm hệ thống an toàn hơn mà chặn hoạt động bình thường, hạn chế UX/UI, và trở thành điểm nghẽn của engine.

Dữ liệu (lọc thô bằng regex, cần đo lại theo mục 6.1):
- Khoảng 58 issue reviewer đòi thêm giới hạn ("unbounded", "no limit"…). **56/58 được chấp nhận sửa**, gần như không bao giờ bị cãi.
- Khoảng 360 issue mà chính giới hạn hoặc cắt bớt là nguyên nhân gây lỗi. Ví dụ:
  - "Customer history silently becomes incomplete at the page cap"
  - "Valid bounded gate inputs are truncated"
  - "External submissions incorrectly enforce the internal body limit"
  - "Community pool is truncated before structural scoring"
  - `trim-drops-required-first`: 54 issue
- Taxonomy chỉ có lớp "thiếu giới hạn", không có lớp "giới hạn quá chặt", tức là lệch theo góc nhìn của reviewer.
- Vòng lặp: reviewer thấy unbounded → agent thêm con số tuỳ tiện kèm chặn cứng hoặc cắt im lặng → vòng sau hoặc user phát hiện nó chặn việc bình thường.

### 6 điểm
1. **Validate tính đúng khác với giới hạn dung lượng.**
   - Validate chặn giá trị sai nghĩa: config bằng 0 làm tắt tính năng, số âm, sai kiểu. Vẫn cần.
   - Giới hạn dung lượng chỉ tồn tại để bảo vệ một tài nguyên cụ thể khỏi quá tải hoặc lạm dụng, theo kiểu safe cap hay circuit breaker.
2. **Mỗi giới hạn dung lượng khai đủ 4 điều**, thiếu thì không được thêm:
   - tài nguyên được bảo vệ: bộ nhớ, CPU, chi phí, quota ngoài, trần nền tảng;
   - sự cố cần chặn;
   - vì sao là con số đó: trần thật, đo đạc, hoặc cao hơn nhiều lần tải bình thường lớn nhất thực tế, để người dùng bình thường không bao giờ chạm tới;
   - cách xử lý khi chạm ngưỡng.
3. **Chạm ngưỡng thì xử lý mềm**, theo thứ tự ưu tiên:
   - chia nhỏ hoặc tiếp tục được: batch, cursor, stream, nhiều lượt;
   - backpressure, xếp hàng;
   - circuit breaker: ngắt khi lỗi hoặc tải vượt ngưỡng, tự hồi phục;
   - degrade có báo hiệu: `truncated`, số lượng bị bỏ, load more.

   Không bao giờ cắt im lặng. Khi buộc phải cắt thì giữ phần bắt buộc, chỉ bỏ phần tuỳ chọn.
4. **Đặt đúng chỗ.**
   - Đặt ở biên tin cậy (input ngoài, mạng) và nơi tiêu tài nguyên.
   - Không đặt giữa các thành phần nội bộ trên đường dữ liệu hợp lệ.
   - Không áp giới hạn nội bộ cho luồng bên ngoài, và ngược lại.
5. **Giới hạn nghiệp vụ** (số mục trên UI, độ dài text…) chỉ có khi plan hoặc user yêu cầu. Agent không tự đặt ra.
6. **Năng lực bên ngoài phải được kiểm với thực tế hiện tại, không lấy từ trí nhớ** [CHỐT].
   - Ví dụ: một năm trước max output thường là 8k token và context 256k. Nay provider đã chấp nhận 16–32k output và context 1M. Kiến thức lúc train của model đã cũ từ đầu.
   - Phạm vi: context, max output, rate limit, batch embedding của LLM; giới hạn D1/SQLite/Workers/body HTTP/quota API; buffer mặc định của thư viện; thiết bị, trình duyệt.
   - Nguồn hợp lệ: docs chính thức (context7/web), API metadata của provider, type hoặc config của SDK đang cài, đo thực tế. **Không được dùng "kiến thức chung" hay trí nhớ.**
   - Không kiểm được thì đánh dấu `UNVERIFIED`. Không được dựa vào nó để chặn; hoặc hỏi user.
   - Giới hạn nội bộ suy ra từ các fact, không phải hằng số độc lập. Ví dụ: ngân sách input = context − phần dành cho output.
   - Ưu tiên đọc năng lực từ nguồn sự thật lúc chạy hoặc từ một catalog cấu hình, có một chỗ duy nhất để cập nhật.
   - Gặp hệ thống hay model chưa biết thì không lùi về một con số nhỏ "cho chắc". Để provider tự từ chối (`context_length_exceeded`, 413, 429) rồi xử lý mềm.
   - Dữ liệu ủng hộ:
     - "Context limit model mapping includes unverified model assumptions"
     - "The 32,000-token boundary is conflated with the provider's actual context limit"
     - "An unreachable 1024-token target causes per-character fragment storms"
     - "Best-effort token pressure can become a permanent safety rejection"
     - các issue về trần D1 batch/bind bị vượt

### Đặt chính sách vào đâu [ĐỀ XUẤT]
- **loop-plan:**
  - Mục "Input validity": chỉ chặn giá trị sai nghĩa.
  - Mục "Capacity safeguards": mỗi giới hạn khai đủ 4 điều, hoặc ghi rõ "không đặt giới hạn" và lý do.
  - Bảng "Capacity facts": năng lực | giá trị | nguồn | ngày kiểm.
- **loop-implement:**
  - Không thêm giới hạn ngoài plan.
  - Con số năng lực bên ngoài không có trong bảng thì phải kiểm rồi mới dùng, ghi nguồn và ngày.
  - Plan có con số đã cũ thì báo là lệch.
  - Review đòi thêm giới hạn thì áp chính sách: có rủi ro thật thì dùng safe cap kèm xử lý mềm; không có thì cãi lại.
- **Prompt của codex-impl-review và codex-plan-review** (nơi khởi đầu vòng lặp):
  - Khi báo unbounded phải nêu tài nguyên cụ thể và tình huống thực tế.
  - Không đòi giới hạn trên đường nội bộ tin cậy.
  - Giới hạn quá chặt hoặc cắt im lặng làm hỏng việc hợp lệ là defect.
  - Không đề xuất con số từ trí nhớ; muốn nói sai phải dẫn nguồn.
  - Hằng số năng lực bên ngoài không có nguồn là defect.
- **Danh sách DISPUTE của Claude** (trong các review skill): thêm "yêu cầu giới hạn không có rủi ro tài nguyên cụ thể".

---

## 4. Đề xuất cho loop-plan: plan phải có gì [ĐỀ XUẤT]

Chỉ bắt buộc khi phase có đụng tới loại đó; không đụng thì ghi N/A.

- **A. Bản đồ bề mặt hợp đồng** (nhắm ~20% lỗi impl).
  - Với mỗi thứ bị đổi (shape dữ liệu, config key, mã lỗi/status, metric, ID/key, event, chế độ): liệt kê mọi producer, consumer, docs, schema, generated client kèm `file:symbol`.
  - Mỗi dòng phải được giao cho một phase.
  - Config mới phải chỉ ra mọi đường code đọc nó.
- **B. Bảng trạng thái và lỗi** (nhắm ~14%). Với mỗi thao tác đổi trạng thái hoặc ghi dữ liệu, trả lời:
  - chuyển trạng thái nào được phép hay bị chặn;
  - lỗi giữa hai bước ghi thì rollback, cleanup hay để dở;
  - có ghi đồng thời không, chặn bằng gì;
  - lỗi báo ra ngoài bằng mã nào.
- **C. Input validity + Capacity safeguards + Capacity facts:** theo mục 3. Phần này thay cho đề xuất "bảng giá trị biên" trước đó, vì đề xuất cũ sẽ khuyến khích thêm giới hạn.
- **D. Bẫy đã biết.**
  - Tra danh mục bẫy theo loại code (từ 59 thẻ đạt chuẩn: ≥5 lần, ≥2 dự án, ≤10% bị cãi). Chọn thẻ khớp với phase.
  - Với mỗi thẻ, ghi thiết kế tránh bằng cách nào và test nào chứng minh.
  - Mục "Anti-shortcut coverage" dẫn chiếu tới các thẻ này.
- **E. Kiểm thứ tự phase** (nhắm 474 issue sequencing trong plan-review).
  - Gate của mỗi phase chạy được chỉ với output của các phase trước.
  - Contract được định nghĩa trước consumer của nó.
  - Không phase nào dựa vào "phase sau sửa lại".
- **F. Quyết định cố định.**
  - Ghi rõ quyết định thiết kế nào không được đổi nếu chưa hỏi user: cơ chế, giới hạn, quyền, gate.
  - Lý do: "đổi thiết kế" tăng sau khi có loop skills.

## 5. Đề xuất cho loop-implement: lúc làm cần làm gì [ĐỀ XUẤT]

1. **Trước khi code:** biến các bảng A–D của phase thành danh sách việc. Mỗi dòng gắn với code hoặc test cụ thể.
2. **Nhật ký lệch:**
   - Mọi chỗ khác plan đều ghi vào progress log.
   - Đụng tới mục F (nới limit/validation/gate, đổi cơ chế) thì phải hỏi user.
   - Plan nhắc bề mặt nào (tab, client, phase…) thì sửa đủ bề mặt đó.
3. **Trước khi review:**
   - Đi lại bản đồ bề mặt: mọi consumer đã được sửa chưa.
   - `rg` tên, mode, flag cũ để tìm tàn dư trong code, help, docs, generated.
4. **Test phải fail được, kiểm bằng đột biến thật:**
   - Với dòng chính của mỗi AC: tạm đảo hoặc bỏ dòng đó, chạy test, thấy đỏ thì khôi phục.
   - Danh sách các dạng test yếu cụ thể (từ dữ liệu):
     - không đi tới tình huống thật (không có eviction, restart thật);
     - chấp nhận cả trạng thái lỗi;
     - chỉ kiểm status, truthy hay sự tồn tại;
     - mock chính hàm cần test;
     - kiểm sai bước, sai điều kiện.
5. **Kỷ luật khi sửa theo review** (nhắm lỗi do lần sửa trước gây ra):
   - Tìm các đường code anh em có cùng mẫu và sửa hết.
   - Chạy lại bảng B/C cho hàm vừa sửa.
   - Thêm test hồi quy cho đúng finding.
   - Không âm thầm mở rộng contract.
   - Thêm giới hạn theo yêu cầu review thì phải qua chính sách ở mục 3.

   **Mục này mới là giả thuyết, cần phân tích ở 6.2.**

---

## 6. Việc dữ liệu cần làm trước khi viết [MỞ — chờ user đồng ý]

1. **Đo nhóm giới hạn bằng Jev** trên 8.701 issue (chưa tới 1 USD). Ba câu hỏi:
   - (a) issue đòi thêm hoặc siết giới hạn;
   - (b) issue do một giới hạn có sẵn chặn hoặc cắt việc hợp lệ;
   - (c) issue do con số năng lực bên ngoài sai, cũ hoặc chưa kiểm.

   Sau đó kiểm xem (b) có hay xuất hiện sau các lần sửa (a) không. Kết quả này là baseline cho mục 3.
2. **Phân tích bug do lần sửa trước gây ra:** đọc issue vòng N cùng lần sửa ở vòng N−1 (khoảng 230 issue có cặp) để rút ra mẫu thật cho mục 5.5.
3. **Gán nhãn 3.300 issue plan-review** vào taxonomy, cộng thêm lớp "giới hạn quá chặt". Mục đích: biết A–F chặn được bao nhiêu và còn lớp nào chưa phủ.
4. **Danh mục bẫy:** viết lại 59 thẻ đạt chuẩn bằng tiếng Anh, gom theo loại code, đặt vào `references/` dùng chung cho hai skill loop. 77 thẻ chỉ của một dự án thì đưa vào `CLAUDE.md`/`AGENTS.md` của repo đó, không đưa vào skill chung.

## 7. Đo hiệu quả sau khi triển khai [ĐỀ XUẤT]
- Baseline theo dự án: issue vòng 1 mỗi phiên, số vòng mỗi phiên, tỉ lệ từng nhóm lỗi ở mục 1.3, và nhóm giới hạn ở mục 6.1.
- Sau 2–3 tuần dùng, chạy lại pipeline trích xuất trên các phiên mới và so sánh.
- Rủi ro: plan dài hơn có thể làm plan-review nhiều vòng hơn. Theo dõi số vòng plan-review.

---

## 8. Trạng thái repo

### [ĐÃ LÀM] (chưa commit, nằm trên WIP chưa commit của user)
- Gỡ `codex-parallel-review`, `codex-codebase-review`, `codex-security-review`:
  - `git rm` thư mục skill;
  - bỏ map template trong runner;
  - bỏ flavor text PARALLEL_* và CHUNK_*;
  - bỏ dòng nhắc security-review trong `codex-impl-review/SKILL.md`.
- Thêm `skills/loop-plan/SKILL.md` và `skills/loop-implement/SKILL.md` (bản cho Claude, copy từ `~/.claude/skills`).
- Installer:
  - chia `RUNNER_SKILLS` và `PLAIN_SKILLS` (plain skill chép SKILL.md nguyên trạng);
  - `REMOVED_SKILLS` bị xoá khỏi `~/.claude/skills` mỗi lần cài;
  - `-full` chỉ in thông báo;
  - khối guidance `--auto` thêm loop-plan/loop-implement.
- Cập nhật `manifest.json`, `README.md`, `CLAUDE.md`.
- Đã thử installer vào HOME tạm: cài đủ 7 skill, xoá bản cũ của skill bị gỡ, runner version 13.

### Việc còn thiếu đã biết (user nhận xét "làm thiếu tùm lum", cần rà lại)
- Installer chưa chép `references/` cho plain skill. Cần sửa nếu loop skills có `references/` (mục 4D, mục 3).
- Hai bản Codex của skill loop (`~/.codex/skills`, dùng `$loop-plan` và `AGENTS.md`) chưa được repo quản lý. Installer chỉ cài cho Claude.
- Runner còn code nhận dạng format security/codebase (dòng khoảng 677, 727). Chưa quyết bỏ hay giữ.
- 5 file `references/protocol.md` chưa track, khác `shared/protocol.md`, và bị bản `shared/` đè khi cài. Cần user xác nhận bản nào đúng.
- Chưa chạy `gitnexus_impact` như `CLAUDE.md` của repo yêu cầu, vì session không có tool GitNexus.
- Chưa commit. Đề xuất: 1 commit cho WIP cũ của user, 1 commit cho việc gỡ/thêm skill.
- Chọn model reviewer (`--model`):
  - Runner hỗ trợ ở `start`/`resume`, nhưng **chỉ có trong WIP chưa commit**, chưa có ở HEAD, và chưa có ở bản đã cài trong `~/.claude/skills`.
  - Hướng dẫn chỉ nằm ở `shared/protocol.md` § Optional Model Selection. Không SKILL.md nào nhắc `--model`, và SKILL.md chỉ trỏ tới protocol.md "cho error flows", nên Claude dễ không biết tuỳ chọn này.
  - loop-implement bước 7 không nói reviewer là ai hay dùng model nào.
  - [MỞ] Cách truyền model vào review skill, và từ loop-implement sang review.
- [MỞ] Còn thiếu gì nữa theo ý user?

---

## 9. Review skills: chọn model + SKILL.md tự đủ, không phải đọc thêm file

### Yêu cầu [CHỐT — user 2026-10-14]
- Cập nhật các review skill về cách dùng model.
- Ghi protocol thẳng vào SKILL.md, để model không phải đọc thêm một file (tốn thêm một bước).
- Skill nào có nhiều file rời rạc thì gộp về SKILL.md.

### Hiện trạng file

**Claude phải tự đọc** (đây là các file cần gộp):

| File | Dòng | Dùng ở | Ghi chú |
|---|---|---|---|
| `shared/protocol.md` → copy vào `references/protocol.md` của mỗi skill | 168 | cả 5 review skill | SKILL.md chỉ trỏ tới nó "cho error flows"; mục chọn model nằm trong đây |
| `shared/flavor-text.md` → copy vào `references/` | 162 | cả 5 review skill (mục "Flavor Text Triggers") | đọc lúc bắt đầu skill |
| `codex-think-about/references/question-sharpening.md` | 179 | think-about bước 1 | |
| `claude-analysis-template.md` | 42–51 | commit, pr, think-about | SKILL.md bảo Claude đọc, nhưng runner `render` đã chèn sẵn vào prompt `{CLAUDE_ANALYSIS_FORMAT}`, nên đọc riêng là thừa |

**Runner đọc lúc `render`, Claude không cần đọc, nên giữ nguyên là file:** `prompts.md` (108–250 dòng), `output-format.md`, `claude-analysis-template.md`. Runner tìm chúng theo đường dẫn `references/` (khoảng dòng 1204, 1233, 1242).

Kích thước SKILL.md hiện tại: plan 95, impl 123, think 81, commit 77, pr 79.

### Đề xuất [ĐỀ XUẤT]
1. **Gộp protocol vào SKILL.md, chỉ phần skill đó cần:**
   - Phần chung: stdin, init, start, render, resume, **model**, poll, operational authority và recovery, finalize/cleanup, xử lý lỗi.
   - Phần riêng: impl/plan lấy biến thể Apply/Rebut; commit/pr lấy Cross-Analysis; think-about lấy phần riêng của nó.
   - Bỏ `references/protocol.md`, kể cả 5 bản copy chưa track hiện nay.
2. **Giữ một nguồn trong repo, gộp lúc cài.** Repo giữ các đoạn protocol trong `shared/` (ví dụ `shared/protocol/core.md`, `apply-rebut.md`, `cross-analysis.md`). Installer thay placeholder (ví dụ `{{PROTOCOL_CORE}}`) trong template SKILL.md. Như vậy bản cài là một file tự đủ, còn repo không phải sửa tay 5 chỗ.

   Phương án thay thế: copy tay vào từng SKILL.md. Đơn giản hơn nhưng dễ lệch nhau.
3. **Model ghi thẳng vào bước Start/Resume của mỗi SKILL.md:**
   - Lệnh mẫu có `--model "$MODEL"`.
   - Quy tắc: user (hoặc plan, xem câu hỏi mở) nêu model thì truyền đúng tên đó ở `start` và **mọi** `resume`, kể cả khi recovery. Không nêu thì bỏ flag, để Codex dùng mặc định.
   - Effort giữ quy tắc như cũ.
4. **think-about:** gộp `question-sharpening.md` vào SKILL.md, viết gọn lại.
5. **claude-analysis-template:** bỏ câu "đọc theo file", thay bằng "format đã có trong prompt đã render".
6. **Flavor text** [MỞ]: (a) bỏ hẳn; (b) chỉ giữ 2–3 câu cho mỗi trigger mà skill dùng, ghi thẳng vào SKILL.md; (c) giữ nguyên. Hiện mỗi phiên tốn 162 dòng đọc chỉ để lấy câu đùa.
7. **Hệ quả:**
   - SKILL.md dài lên khoảng 180–250 dòng. Trái với nguyên tắc "SKILL.md ~40–70 dòng, chi tiết để ở references/" trong `CLAUDE.md` của repo, nên phải sửa nguyên tắc đó theo quyết định mới.
   - Installer: bỏ bước copy `shared/` vào `references/`, thêm bước thay placeholder protocol.
8. **loop-implement bước 7:** ghi rõ review phase bằng `/codex-impl-review`, và cách truyền model (gắn với câu hỏi về model ở mục 8).

---

## 10. Đơn giản hoá protocol: giữ chức năng, giảm thao tác [ĐỀ XUẤT]

### Yêu cầu [CHỐT — user 2026-10-14]
Rà protocol và các bước hiện tại xem chỗ nào phức tạp hoặc thừa, gây tốn effort. Thiết kế lại sao cho giữ nguyên chức năng nhưng cách dùng đơn giản, để model không rối và không hallucinate.

### BUG ĐÃ XÁC NHẬN: runner parse output APPROVE không có issue thành `unknown` [CHỐT — user báo, dữ liệu xác nhận]
- **Nguyên nhân.** Output format quy định: không còn issue thì bỏ hết block ISSUE, chỉ trả block `### VERDICT` với `Status: APPROVE`. Nhưng `parseOutputMarkdown` (`codex-runner.js` khoảng dòng 655–690) chỉ nhận ra format khi có `### ISSUE-`/`RESPONSE-`/`CROSS-`/Key Insights/Considerations. Không có thì trả `format: "unknown"` **mà không gọi `parseVerdict`**. Vì vậy mọi lần APPROVE sạch, đúng như contract yêu cầu, đều bị parse thành unknown.
- **Hệ quả dây chuyền:**
  - `rounds.json` không ghi verdict cho vòng cuối.
  - `finalize` lấy verdict của vòng gần nhất có verdict (khoảng dòng 2153–2166), tức là **REVISE của vòng trước**.
  - Nếu chỉ có 1 vòng thì `finalize` báo "No verdict available", và Claude tự chế verdict truyền qua override.
- **Số liệu, quét toàn bộ phiên impl/plan trên máy (đối chiếu `meta.json` / `review.md` vòng cuối / `rounds.json` vòng cuối):**

  | `meta.json` | `review.md` vòng cuối | `rounds.json` vòng cuối | Số phiên |
  |---|---|---|---|
  | APPROVE | APPROVE | None (parse hỏng) | 755 |
  | **REVISE** | **APPROVE** | None | **495** |
  | không có meta | APPROVE | None | 119 |
  | APPROVE | APPROVE | APPROVE (parse đúng) | 295 |

- **Đính chính.** Con số "33% phiên finalize REVISE" trước đó **chủ yếu do bug này**, không phải Claude thoát vòng sai. Gần 25 biến thể verdict tự do (`APPROVE_WITH…`, `ABORTED — …`, `{'status': …`) rất có thể cũng do Claude phải tự điền khi runner báo không có verdict.
- **Ảnh hưởng tới dữ liệu nghiên cứu.** Verdict trong `common_issues/data/sessions.jsonl` lấy từ `meta.json`, nên khoảng 495 phiên bị ghi nhầm REVISE. Việc trích hunk sạch chỉ lấy phiên APPROVE, nên bị thiếu mẫu nhưng không bị nhiễm sai. Cần sửa lại verdict khi phân tích tiếp.
- **Lỗi phụ:** khoảng 17 output dùng heading khác (`## VERDICT`, `**Verdict**`, `VERDICT: APPROVE` viết cùng dòng), 9 output trả JSON. Status chưa được chuẩn hoá (dấu `**`, backtick, dấu chấm).
- **Hướng sửa [ĐỀ XUẤT]:**
  - Parse VERDICT độc lập với việc nhận dạng format. Chỉ có VERDICT thì vẫn là `format: "review"` với `blocks: []`.
  - Nới heading (`##`/`###`, hoa/thường, `VERDICT: X` cùng dòng) và chuẩn hoá status về `APPROVE | REVISE | CONSENSUS | CONTINUE | STALEMATE`.
  - Thiếu verdict thì báo lỗi rõ ràng và `next: ask_user`. **`finalize` không bao giờ lấy verdict của vòng trước**: chỉ dùng verdict vòng cuối, hoặc báo lỗi.
  - Dùng khoảng 2.800 output thật trên máy làm bộ test hồi quy cho parser.

- **Thời điểm sửa** [CHỐT — user 2026-10-14]: sửa chung đợt với các thay đổi khác, không tách ra làm trước.

### Dấu hiệu khác (cần đọc lại sau khi trừ ảnh hưởng của bug trên)
- 159 phiên impl có verdict `None`: dừng giữa chừng hoặc lỗi. Riêng 119 phiên không có meta nhưng vòng cuối là APPROVE, có thể do `finalize` lỗi vì thiếu verdict.

### Chỗ phức tạp hoặc thừa trong protocol và SKILL.md hiện tại
1. **Ống nước bash dễ sai:**
   - hàm `json_esc` tự định nghĩa;
   - quy tắc heredoc có hay không có nháy (`<<'RENDER_EOF'` vs `<<RENDER_EOF`);
   - `printf` thay vì `echo`;
   - bóc tiền tố `CODEX_SESSION:`;
   - render ra biến `$PROMPT` rồi pipe sang `start`/`resume`.

   Mỗi vòng Claude phải tự ghép 2–3 lệnh shell có escape. Đây là chỗ dễ sai nhất.
2. **Điều kiện recovery 5 vế** (`status`, `timeout_reason`, `recoverable`, `thread_id`, `progress_observed`) lặp lại ở 4 chỗ: Critical Rules, bước 6, protocol, bảng lỗi. Runner đã có đủ dữ liệu để tự tính kết luận.
3. **Bảng quyết định vòng lặp** (stalemate trước rồi đến verdict) lặp lại ở SKILL.md và protocol. Runner đã tính `convergence.stalemate` và parse verdict, nhưng vẫn để Claude tự suy ra bước tiếp theo.
4. **`finalize` + `stop` tách đôi**, có điều kiện dùng khác nhau, và Claude tự điền verdict tự do (xem các số liệu ở trên).
5. **Model phải truyền lại ở mọi `resume`.** Runner không lưu, nên quên truyền là đổi model giữa chừng mà không biết.
6. **Đoạn ABSOLUTE USER AUTHORITY** dài khoảng 80 từ, lặp ở SKILL.md, protocol, và runner còn tự chèn vào prompt. Một câu là đủ.
7. **Ghi chú vận hành** (privilege/sandbox, `--min-interval`, timeout 5 giờ) là chi tiết của runner, Claude chỉ cần biết một câu.
8. **Flavor text**: đọc 162 dòng mỗi phiên, cộng 9–11 trigger phải nhớ.
9. **Nhiều placeholder mỗi template** (pr round2+ có 9 placeholder) cộng schema SESSION_CONTEXT 5 trường. Claude phải escape từng cái vào JSON.

### Hướng thiết kế: runner lo trạng thái, Claude lo nội dung
Mọi quyết định cơ học (khi nào tiếp, khi nào dừng, có resume được không, finalize hay chỉ stop, giữ model nào) do runner tính và trả về một trường `next`. Claude chỉ làm phần cần phán đoán: phân loại ACCEPT/DISPUTE/USER DECISION, sửa code hoặc plan, viết rebuttal.

Đề xuất 4 lệnh cấp cao, thay cho chuỗi init → render → start → poll → render → resume → finalize → stop:

| Lệnh | Gộp từ | Ghi chú |
|---|---|---|
| `begin --skill <s> --mode <m> --input <file.md> [--model M] [--effort E]` | init + render + start | Claude viết input (request, context, plan trace…) vào một file markdown bằng Write tool. Không cần JSON, `json_esc` hay heredoc. Runner lưu model/effort vào session. |
| `wait <session>` | poll (có throttle) | Trả về review đã parse cùng `next` ∈ `respond` \| `done` \| `ask_user` \| `stopped` kèm lý do. Runner tự áp bảng stalemate/verdict và các điều kiện recovery. |
| `reply <session> --input <file.md>` | render rebuttal + resume | Dùng lại model/effort đã lưu. Muốn đổi thì truyền flag. |
| `end <session>` | finalize + stop | Runner tự quyết finalize hay chỉ stop theo trạng thái thật. Verdict lấy từ review, Claude không tự điền. |

Hệ quả:
- Phần protocol trong mỗi SKILL.md co lại còn khoảng 10–15 dòng: 4 lệnh và "làm theo `next`". Việc "gộp protocol vào SKILL.md" ở mục 9 trở nên nhẹ, không làm SKILL.md phình ra.
- SKILL.md dành chỗ cho phần nội dung có giá trị: phân loại finding, chính sách giới hạn, self-check.
- Lệnh cũ (`init`/`render`/`start`/`poll`/`resume`/`finalize`/`stop`) giữ lại để debug và để không phá vỡ cách dùng hiện tại. Runner lên v14.
- Bỏ hàm `json_esc`, quy tắc heredoc, và quy tắc `printf`/`echo` khỏi SKILL.md.

### Việc cần kiểm trước khi chốt [MỞ]
- ~~Đọc khoảng 20 phiên finalize `REVISE` để biết lý do dừng~~: đã có câu trả lời, phần lớn là do bug parse APPROVE ở trên. Chỉ còn 32 phiên REVISE thật mà vòng cuối cũng REVISE.
- Rà runner để xem `wait` có thể tự tính `next` từ những gì poll đã có hay không (convergence, verdict, các trường recovery).

---

## 11. Giao tiếp qua MCP, bash làm đường dự phòng

### Ý tưởng [CHỐT hướng — user 2026-10-14]
Model gọi review qua MCP tools. Lệnh bash của runner hiện tại giữ lại làm fallback.

### Vì sao MCP hợp hơn bash [ĐỀ XUẤT — lập luận]
- **Input có kiểu.** Context, rebuttal, model, effort là tham số JSON schema. Không còn `json_esc`, heredoc, `printf`/`echo` hay bóc tiền tố. Những thứ này chính là nhóm phức tạp số 1 ở mục 10.
- **Output có cấu trúc.** Trả thẳng `{review, next, activities}`, không phải parse stdout.
- **Hướng dẫn nằm ở mô tả tool.** Phần protocol trong SKILL.md chỉ còn "gọi `begin` → `wait` → `reply` → `end`, làm theo `next`".
- **Có thể giải quyết vấn đề privilege/sandbox.** MCP server là tiến trình riêng do client khởi động, không chạy trong sandbox của Bash tool. Vậy start, poll và stop luôn cùng một ngữ cảnh. *Cần kiểm thực tế, chưa xác minh.*
- **Dùng được cho cả Codex làm orchestrator.** Codex CLI cũng nhận MCP server, nên bản Codex của loop skills (`~/.codex/skills`) có thể gọi cùng server.

### Thiết kế [ĐỀ XUẤT]
- **Một lõi, hai vỏ.** Logic runner (session, spawn Codex detached, parse, tính `next`) tách thành phần lõi. CLI (bash fallback) và MCP server (stdio) là hai lớp mỏng gọi cùng lõi, cùng ngữ nghĩa 4 động từ.
- **Tool tối thiểu:** `review_begin`, `review_wait`, `review_reply`, `review_end`. Có thể thêm `review_status` nếu cần. Ít tool thì tốn ít context và ít chọn nhầm.
- **Codex vẫn chạy detached, trạng thái nằm trên đĩa** như hiện nay. MCP server chết hoặc client restart thì review không mất, và gọi lại `review_wait` với cùng session được.
- **`review_wait` có thời hạn.** Mỗi lần gọi chờ tối đa N phút rồi trả `running` kèm activities, giống throttle của poll hiện tại. Lý do: tool call MCP có timeout phía client.
- **SKILL.md:** "dùng MCP tools; nếu tool không có trong danh sách, dùng lệnh bash `node $RUNNER begin|wait|reply|end` cùng tham số". Fallback chỉ thêm vài dòng vì cùng ngữ nghĩa.
- **Information barrier** (pr, commit review): giữ quy tắc "phân tích độc lập xong mới gọi `review_wait`".

### Phải kiểm trước khi chốt (theo chính sách mục 3.6: kiểm thực tế, không dùng trí nhớ) [MỞ]
- Timeout mặc định cho một tool call MCP trong Claude Code, và cách chỉnh (biến môi trường hoặc config). Con số này quyết định N phút của `review_wait`.
- MCP server stdio có chạy ngoài sandbox của Bash tool không, và có spawn tiến trình detached được không.
- Cách đăng ký server ở phạm vi user: `claude mcp add …` hay sửa file config; với Codex là `~/.codex/config.toml` `[mcp_servers.*]`. Cú pháp hiện hành lấy từ docs.
- Phiên bản protocol MCP hiện hành, và client có hiển thị progress notification không.

### Quyết định [CHỐT — user 2026-10-14]
- **Phụ thuộc:** bỏ nguyên tắc "Node stdlib, không dependency". Dùng SDK chính thức hoặc thư viện hỗ trợ tốt. Phiên bản SDK và API hiện hành phải kiểm từ docs, không dùng trí nhớ. Installer phải cài dependency, và `CLAUDE.md` của repo phải sửa nguyên tắc này.
- **Installer tự đăng ký MCP server** cho Claude Code và cho Codex.
- **Hỗ trợ chiều ngược lại:** Codex điều phối (loop skills bản Codex), Claude làm reviewer.
  - [MỞ] Claude làm reviewer chạy bằng gì: `claude -p` headless? Cần kiểm khả năng thực tế (chạy nền, giữ phiên qua nhiều vòng, chế độ chỉ đọc).
  - Repo khi đó phải quản lý cả bản Codex của skill (`$loop-plan`, `AGENTS.md`), và installer cài vào `~/.codex/skills`.

---

## 12. loop-plan: pilot/spike chứng minh khả thi trước khi ghi vào plan [CHỐT ý tưởng — user 2026-10-14; chi tiết là ĐỀ XUẤT]

### Vấn đề
Plan chỉ dựa trên tưởng tượng thì khi implement giữa chừng hay phải sửa plan. Ví dụ: thư viện không làm được như tưởng, API cư xử khác, con số hiệu năng sai.

Dữ liệu liên quan:
- Mục đích của plan-review vốn đã nhắm vào "technology/capability hallucinations".
- 3.300 issue plan-review với trung bình 3,1 vòng.
- Nhóm "đổi thiết kế" (296 issue impl) tăng sau khi có loop skills.

[MỞ] Đo được bao nhiêu phần trong số này do giả định chưa kiểm: cần gán nhãn plan-review (mục 6.3), thêm câu hỏi "giả định kỹ thuật sai hoặc chưa kiểm".

### Đề xuất
- **Bước "Feasibility spikes" trong loop-plan, sau Discovery và trước khi viết các phase.**
  - Liệt kê các giả định kỹ thuật **chưa được chứng minh** mà plan dựa vào: thư viện hay API làm được X, định dạng hay hành vi của hệ thống ngoài, hiệu năng, năng lực hay giới hạn (nối với "Capacity facts" ở mục 3.6).
  - Với mỗi giả định rủi ro, viết **script thử tối thiểu** để chứng minh. Không cần dùng ngôn ngữ chính của dự án; Python hay Node script là đủ. Được tải thư viện về để thử.
  - Ghi vào plan mục **"Feasibility evidence"**: giả định | lệnh hoặc script | kết quả và thông số đo được | kết luận.
  - Chỉ có kết quả rồi mới thảo luận với user hoặc ghi thành thiết kế.
  - Giả định không thử được thì đánh dấu `UNVERIFIED`. Khi đó hoặc phase 1 phải là spike có tiêu chí dừng, hoặc phải hỏi user.
- **Ranh giới an toàn:**
  - Spike chạy trong thư mục tạm riêng, ngoài repo (hoặc một thư mục đã gitignore).
  - Không đổi dependency hay code của dự án lúc lập plan.
  - Không commit spike.
  - Muốn thêm dependency vào dự án vẫn là USER DECISION.
  - Sửa câu "This skill plans only; it does not implement application code" thành: được chạy spike tạm, không sửa code dự án.
- **Không phải plan nào cũng cần spike.** Chỉ làm khi plan dựa vào khả năng hay hành vi chưa thấy chạy thật trong repo. Ví dụ: thư viện mới, API mới, con số hiệu năng, định dạng lạ.

### Nơi để spike [CHỐT — user đồng ý đề xuất bên dưới]
- User muốn spike nằm trong thư mục làm việc của dự án. Có hai phương án: để trong `.codex-review` để tận dụng ignore sẵn có, hoặc để ở cấp dự án rồi xoá khi thử xong.
- **[ĐỀ XUẤT] `.codex-review/spikes/<tên-plan>/`:**
  - Spike nằm cạnh session review, cùng tên với plan. Codex lúc plan-review có thể đọc và chạy lại spike để kiểm bằng chứng. Xoá ở cuối loop-implement.
  - Trong plan chỉ giữ bảng "Feasibility evidence" với số liệu, không phụ thuộc vào thư mục spike còn tồn tại.
- **Lưu ý thực tế.** Runner hiện **không tự gitignore** `.codex-review`. muster và salonrize-apps có dòng ignore do user tự thêm; ctxe (`~/projects/ctxe`) không có.
  - Đề xuất: runner, hoặc installer khi tạo `.codex-review`, ghi `.codex-review/.gitignore` chứa `*`. Thư mục tự ignore chính nó, không phải sửa `.gitignore` của dự án.
- Không đặt spike vào `sessions/`, vì đó là vùng runner quản lý.

### Giới hạn công [CHỐT — user]: lỏng, không cần quy định cứng.

---

## 13. Chiến lược chạy test: nhỏ trước, rộng sau [CHỐT ý tưởng — user 2026-10-14; chi tiết là ĐỀ XUẤT]

### Vấn đề
Sửa một chỗ nhỏ nhưng không test riêng chỗ đó mà chạy full test mất cả tiếng. Sai thì sửa rồi lại chạy thêm một tiếng nữa. Cực kỳ kém hiệu quả.

Hiện trạng trong skill:
- loop-plan: mỗi phase có "Phase gates" và có "Global Gates". Thường phase gate chứa luôn full suite.
- loop-implement: bước 6 chạy "every phase gate" mỗi phase; phần kết thúc chạy toàn bộ Global Gates.

### Đề xuất: thang kiểm thử, chỉ leo bậc khi bậc dưới đã xanh
1. **Kiểm tức thì** (giây): test hay script nhỏ nhất chạm đúng chỗ vừa sửa, ví dụ một test theo tên hay một file. Kèm typecheck hoặc lint cho file đổi nếu nhanh.
2. **Kiểm vùng ảnh hưởng** (phút): test của module hoặc package bị ảnh hưởng.
3. **Phase gate** (đặt mục tiêu vài phút): bộ test vùng ảnh hưởng, contract test của phase, kiểm tra nhanh toàn repo nếu rẻ (build, typecheck).
4. **Full suite / Global Gates** (dài): **chỉ chạy ở cuối implement**, lúc duyệt lại toàn bộ. Không chạy mỗi phase.

Quy tắc đi kèm:
- Test fail thì sửa rồi **chạy lại đúng test đã fail trước**, xanh mới mở rộng. Không chạy lại cả suite dài để kiểm một chỗ sửa nhỏ.
- **Plan ghi thời lượng thật của từng lệnh**, đo ở bước Baseline chứ không đoán (cùng tinh thần mục 3.6). Lệnh nào quá lâu thì không được làm gate của phase. Plan phải ghi lệnh test hẹp tương ứng cho từng AC.
- Sửa theo review cũng theo thang: test của finding, rồi vùng ảnh hưởng. Full suite để cuối.
- Nếu full suite ở cuối bắt được lỗi, quay về bậc 1 cho lỗi đó, không chạy lại full ngay.

### Liên quan tới phần khác
- Mục 5.4 "kiểm bằng đột biến thật" phải dùng test bậc 1. Chỉ làm cho AC cốt lõi, hoặc khi không chắc test có bắt được lỗi; không làm cho mọi AC.

### Mức chặt [CHỐT — user]: lỏng. Không đặt ngưỡng thời gian cứng, chỉ theo tinh thần "nhỏ trước, rộng sau; full suite ở cuối".

---

## 14. Điểm review theo plan, không review mọi phase [CHỐT — user 2026-10-14]
- Review để đảm bảo không đi sai quá xa, nhưng không cần review khi chỉ sửa vài dòng. Số lần review phải thích ứng theo plan.
- **loop-plan** đề xuất mục **"Review checkpoints"**: review Codex đặt ở phase nào và vì sao.
  - Gợi ý đặt checkpoint sau phase dựng contract, schema, migration, trạng thái hay luồng tiền, tức là thứ các phase sau sẽ xây lên trên. Đặt thêm một checkpoint ở cuối.
  - Phase cơ học hoặc nhỏ thì gộp vào checkpoint kế tiếp.
  - Mỗi checkpoint review phần diff cộng dồn từ checkpoint trước.
- Ở bước handoff, loop-plan trình bày checkpoint cho user. **User đồng ý thì giữ, không thì sửa theo user.**
- **loop-implement** review đúng tại các checkpoint đã chốt, không review mọi phase.
- Có thể ghi model hoặc effort review theo từng checkpoint nếu user muốn. Đây là một cách trả lời câu hỏi 9 về chọn model.

---

## 15. Tinh giản loop-implement: bỏ bước trùng, bước trung gian ít giá trị [ĐỀ XUẤT]

### Yêu cầu [CHỐT — user]
Effort phải mang lại hiệu quả, không phải làm lâu. Không được rề rà nhiều bước mà các bước trung gian không có ý nghĩa.

### Rà bản hiện tại (`loop-implement/SKILL.md`)

| Chỗ | Vấn đề | Đề xuất |
|---|---|---|
| Admission 2 "Validate headings, phase fields, dependency order, baseline, progress log…" | Agent tự kiểm schema của plan bằng tay. Plan đã qua plan-review APPROVE. | Rút còn: plan có `Plan Review: APPROVE` và còn phase chưa xong. Thấy plan đã bị sửa sau khi approve thì hỏi. |
| Ghi sổ tiến độ ở 4 chỗ: Admission 4 (đúng một phase `in_progress`), Phase 2 (đánh dấu `in_progress`), Phase 8 (cập nhật progress row), Finalization 5 (bookkeeping, có thể thêm một commit riêng cho plan) | Sửa file plan nhiều lần mỗi phase, có thể sinh thêm commit chỉ để ghi sổ. | Ghi một dòng progress lúc commit phase (kèm nhật ký lệch, mục 5.2). Bỏ trạng thái `in_progress` trung gian và commit riêng cho plan. |
| Phase 7: ba gạch đầu dòng về cách xử lý finding (fix/dispute/ask) | Trùng với quy tắc ACCEPT/DISPUTE/USER DECISION đã có trong codex-impl-review. | Thay bằng: "tại review checkpoint (mục 14) chạy `/codex-impl-review`". Quy tắc xử lý finding chỉ nằm ở review skill. |
| Phase 6 "inspect exit codes, stderr, generated state, cleanup, and the complete diff", Phase 8 "inspect the staged diff for secrets" | Xem diff hai lần. Review checkpoint cũng xem diff. | Gộp thành một bước trước commit: xem staged diff (đúng phạm vi phase, không có secret). |
| Phase 6 "every phase gate + realistic smoke" | Theo thang test (mục 13), phase gate nên nhẹ. | Phase gate theo plan, đã nhẹ. Smoke chỉ khi plan yêu cầu. |
| Phase 8 kiểm AC từng phase, Finalization 1 "map every AC, invariant… to evidence" | Kiểm AC hai lần. | Finalization dùng lại bằng chứng của từng phase. Chỉ kiểm thêm phần xuyên phase (invariant, ranh giới, exclusion). |
| Finalization 2 Global Gates, Finalization 3 self-audit cumulative diff, rồi sửa và chạy lại review cùng toàn bộ gate | Self-audit trùng với review checkpoint cuối. Sửa xong chạy lại cả gate dài. | Cuối: full suite một lần, cùng review checkpoint cuối trên toàn bộ diff. Lỗi thì sửa theo thang test (bậc 1 trước), không chạy lại full ngay. |
| Phase 1 "Re-read… Revalidate paths and symbols" | Hữu ích khi cây đã đổi, nhưng thường là thừa. | Giữ, viết gọn: đọc lại phase; chỉ kiểm đường dẫn hay symbol mà code sắp đụng. |
| Phase 4 "record meaningful red evidence" | Có ích (TDD), nhưng không cần ghi chép dài. | Giữ: thấy test đỏ trước khi code là đủ, ghi một dòng. |

### Nguyên tắc khi thêm quy tắc mới (mục 4, 5, 13)
**Gộp vào các bước sẵn có, không thêm bước.** Ví dụ:
- rà bề mặt và tàn dư nằm trong bước "xem staged diff trước commit";
- nhật ký lệch nằm trong dòng progress lúc commit.

Mục tiêu: loop-implement sau sửa có ít bước hơn bản hiện tại, dù có thêm quy tắc.

**[CHỐT — user]** Đồng ý bảng tinh giản trên.

### [MỞ]
- Kiểm bằng dữ liệu: trong session loop-implement thật, bước nào tốn nhiều lượt tool hay thời gian nhất. Cần transcript của Claude, không chỉ dữ liệu codex-review.

---

## 16. Tinh giản loop-plan: giảm phức tạp, giữ nguyên tính năng [CHỐT mục tiêu — user; chi tiết là ĐỀ XUẤT]

> **Ý kiến user (2026-10-14) về cấu trúc mới:** plan có bỏ sót thì đã có reviewer chặn, nên không cần lo. Nếu muốn đề xuất cấu trúc mới thì **phải chứng minh nó hoạt động**; user không tin đề xuất chỉ dựa trên đoán.
>
> **Hướng xử lý [ĐỀ XUẤT]:**
> - Đợt này **giữ cấu trúc phase hiện tại**. Chỉ thêm các mục cấp plan mà các quy tắc đã chốt cần đến (Feasibility evidence, Capacity, Review checkpoints, Fixed decisions…). Phần tái cấu trúc phase bên dưới để sau, chỉ làm khi có bằng chứng.
> - **Cách chứng minh nếu làm sau:** trên máy có hơn 40 plan `loop-plan/v1` thật (96–2.284 dòng, 1–18 phase; nhiều nhất ở mdworker, ctxe, kiro-gateway, salonrize-apps, muster). Issue plan-review có trường "Plan section", nên đo được:
>   - mục con nào của phase thực sự bị review bắt lỗi;
>   - mục con nào lặp nội dung với mục khác;
>   - plan dài có tương quan với số vòng review hay số issue không.
>
>   Sau đó pilot nhỏ: cùng 2–3 task, viết plan theo cấu trúc cũ và mới, chạy codex-plan-review, so sánh số vòng và issue.
>
> Phần đề xuất cấu trúc bên dưới **giữ lại làm giả thuyết**, chưa áp dụng.

Mục tiêu (user): càng phức tạp thì model càng dễ sai. Giảm độ phức tạp nhưng giữ đủ tính năng.

### Hiện trạng
- 12 mục cấp plan.
- **16 mục con cho mỗi phase:** Goal, Current behavior and gap, Evidence, Pattern, Dependencies, Files and symbols, Behavioral contract, Documentation, Tests first, Anti-shortcut coverage, Implementation obligations, Acceptance criteria, Focused verification, Phase gates, Review, Commit.
- Nếu cứ thêm các đề xuất A–F, Capacity, Feasibility, Checkpoints vào như vậy thì plan sẽ phình rất to. Phải tái cấu trúc, không chỉ thêm.

### Đề xuất: chuyển phần xuyên suốt lên cấp plan, phase chỉ giữ thứ riêng của nó

**Cấp plan:**
1. Target & Scope: mục tiêu, phạm vi, exclusions.
2. Fixed decisions & Invariants: gộp mục F và invariants hiện có.
3. Design: pattern trong repo + chuẩn ngành (mục 17) + **Feasibility evidence** (mục 12).
4. Contract surface map (A).
5. State & failure (B), chỉ khi có.
6. Inputs & capacity (C: validity, capacity safeguards, capacity facts), chỉ khi có.
7. Known traps (D).
8. Baseline & test commands: lệnh test theo bậc kèm thời lượng thật đã đo (mục 13).
9. Review checkpoints (mục 14).
10. Phases.
11. Progress log.

**Mỗi phase còn khoảng 5 mục:**
- **Goal:** gộp Goal, Current behavior and gap, Evidence, Pattern.
- **Changes:** gộp Files and symbols, Implementation obligations, Dependencies. Mỗi dòng dẫn chiếu tới dòng tương ứng ở A, B, C, D.
- **Acceptance criteria:** gộp Behavioral contract, Tests first, Anti-shortcut coverage, Focused verification. Mỗi AC là: điều kiện nhị phân, test chứng minh, lệnh chạy hẹp.
- **Docs:** chỉ khi phase có đổi docs.
- **Gate & commit:** một lệnh gate nhẹ cộng commit message.

Bỏ mục "Review: verdict must be APPROVE" của từng phase. Review đi theo checkpoint.

### Phần "Quality and review" và cách phê duyệt
- Hiện tại `Plan Review: APPROVE` do chính agent tự đặt sau "intent-fidelity review" và "plan self-review". Sau đó còn có thể chạy codex-plan-review. Hai lần review chồng nhau, và trạng thái APPROVE không rõ đến từ đâu.
- Đề xuất:
  - Bỏ hai bước tự review dài, thay bằng một tự kiểm ngắn trước handoff: mọi AC có test, mọi dòng A–D đã được giao cho một phase, có Feasibility evidence cho mọi giả định rủi ro.
  - `Plan Review: APPROVE` chỉ được đặt khi **codex-plan-review trả APPROVE hoặc user duyệt**, ghi rõ nguồn.
- Quy tắc đặt tên file plan (mô tả, không được là `plan.md`) đang lặp ở cả loop-plan và loop-implement. Viết gọn còn một câu mỗi nơi.

### Tương tác với loop-implement
loop-implement chỉ đọc cấu trúc mới, không còn kiểm schema bằng tay (mục 15). Mỗi phase lấy danh sách việc từ Changes và AC.

### Kết quả thực nghiệm (2026-10-14) [ĐO ĐƯỢC — n nhỏ]

**Bước 1: phân tích 100 plan thật, 508 phase, 226 issue có ghi "Plan section".**
- Các mục con gần như không chép chữ của nhau: trùng ≤5%.
- Nhưng chúng dính nhau về nghĩa: 24% issue nhắm từ 2 mục con trở lên.
- Mục bị bắt lỗi nhiều nhất là Design (64), Behavioral contract (46), AC (41) và Tests first (40).
- Mục gần như không bao giờ bị nêu tên: Anti-shortcut (4), Docs (3), Evidence (2), Current behavior (2).

**Bước 2: pilot 2 task thật × 2 cấu trúc.**
- Cách làm:
  - Workspace tạo bằng `git archive`, không mang lịch sử.
  - Agent viết plan là Claude subagent, chạy theo `drafts/pilot-plan-structure/loop-plan-{old,new}.md`.
  - Reviewer là codex-plan-review round 1, effort high.
  - Dữ liệu ở `common_issues/data/plans/pilot-review.jsonl`; script ở `scripts/pilot_plan_review.py`.

| | muster old | muster new | ctxe old | ctxe new |
|---|---|---|---|---|
| Dòng / từ | 299 / 3.967 | 170 / 3.214 | 225 / 2.856 | 129 / 2.452 |
| Phase / AC | 4 / 15 | 3 / 16 | 3 / 11 | 3 / 12 |
| Token agent viết plan / thời gian | 98,7K / 122s | 72,4K / 99s | 81,4K / 108s | 74,7K / 90s |
| Tự review của agent | APPROVE | APPROVE | APPROVE | APPROVE |
| Codex round 1 | REVISE, 2 high + 3 med | REVISE, 2 high + 3 med | REVISE, 3 high | REVISE, 3 high + 4 med |

Đọc tay toàn bộ 20 issue:
1. **Cấu trúc không tạo khác biệt đo được về chất lượng.**
   - Ở muster, cả hai bản đều có cùng hai lỗi gốc:
     - thiếu constructor hoặc fixture khi thêm field bắt buộc;
     - kết quả reconcile không tới được snapshot cache mà execution gate và các route khác đọc.
   - Ở ctxe, cả hai bản đều sai chỗ cắm hook hoặc ranh giới publish, và đều sai luật giữ backup.
   - Lỗi do task và độ sâu khám phá code quyết định, không do template.
2. **Số issue không so được ở n=1.** Bản ctxe-old cũng dùng sai `-p ctxe-cli` (15 lần) và cũng thiếu `verify-standard`, nhưng reviewer chỉ bắt lỗi này ở bản new. Chênh 3 và 7 issue phần lớn là nhiễu của reviewer.
3. **Bản mới ngắn hơn 15–43% số từ** và agent viết tốn ít token hơn 8–27%, trong khi số AC và số phase vẫn tương đương. Lợi ích về chi phí là có, nhưng nhỏ.
4. **Tự review vô dụng ở cả hai bản.** Cả 4 plan đều tự đặt APPROVE, cả 4 đều REVISE với lỗi high. Điều này củng cố đề xuất "Plan Review chỉ APPROVE khi Codex hoặc user duyệt".
5. **Các loại lỗi lặp lại là ứng viên cho check sắc,** độc lập với cấu trúc. Cần đối chiếu với 226 issue trước khi viết thành luật:
   - **Thêm field hoặc kiểu bắt buộc:** liệt kê mọi constructor, producer và fixture bằng grep, gồm cả nhánh lỗi.
   - **State mới hoặc đã reconcile:** truy mọi nơi đọc cache hoặc snapshot đó, không chỉ nơi trả về.
   - **Điểm cắm hook:** chỉ ra đúng ranh giới commit/publish bằng path:line, kèm luồng gọi.
   - **Lệnh trong plan:** chạy thử ở dạng rẻ (`--no-run`, `--list`, tên package) trước khi ghi vào plan.
   - **Contract và AC tự mâu thuẫn:** đối chiếu từng nhánh null và equal.

> Lưu ý: kết quả bước 2 chỉ đo plan review, **không phải** tiêu chí đúng (xem mục kế tiếp). Chỉ dùng tham khảo.

**Kết luận tạm:** không đủ bằng chứng để nói cấu trúc mới giảm lỗi. Bằng chứng chỉ cho thấy nó ngắn hơn và không làm tệ hơn ở n=2. Đổi cấu trúc chỉ được biện minh bằng lý do giảm phức tạp (mục tiêu của user), không bằng lý do chất lượng. Đòn bẩy chất lượng thật nằm ở các check grounding (ý 5).

### Tiêu chí đúng: đo chất lượng IMPLEMENT, không đo plan [CHỐT — user 2026-10-14]

> Ý user:
> - Plan review pass chưa chắc implement ít sai hơn.
> - Plan nhanh hay ít token không phải là ưu việt.
> - Mục tiêu là:
>   - ít sai sót;
>   - hoàn thành mục tiêu;
>   - giảm hallucination;
>   - ngăn làm tắt, làm ngây thơ, làm cho có.
> - Cấu trúc cũ chưa chắc tối ưu, nên phải nghiên cứu vài loại cấu trúc rồi thực nghiệm.

**Nghiên cứu cấu trúc (2026-10-14).**

| Nguồn | Nội dung chính | Độ mạnh bằng chứng |
|---|---|---|
| GitHub Spec Kit | constitution → spec (WHAT, `[NEEDS CLARIFICATION]`) → plan có gate trước implement → tasks; test-first | Chỉ là tài liệu thiết kế, không có số liệu |
| Kiro | requirements dạng EARS (`WHEN … THE SYSTEM SHALL …`) → design → tasks; bugfix ghi rõ hành vi "unchanged" | Tài liệu sản phẩm, không có số liệu |
| "From Plan to Action" (arXiv 2604.12147, 16.991 trajectory SWE-bench) | Agent bám plan thì giải được nhiều issue hơn | Có số liệu. Biến số cần đo là **mức độ bám plan** |
| "Tests as Prompt" (WebApp1K) | Càng nhiều test kỳ vọng thì pass@1 càng giảm | Có số liệu. Nút thắt là khả năng hấp thụ đủ kỳ vọng |
| ClarifyGPT | Hỏi lại khi yêu cầu mơ hồ: +8–10 điểm | Có số liệu |
| ImpossibleBench (arXiv 2510.20270) | Agent sửa/xoá test, special-case input để pass | Có số liệu. Chống bằng test do planner sở hữu và hidden test |

- Pre-mortem: không tìm được bằng chứng nào.
- Plan dài so với mức độ bám plan: chưa có nghiên cứu trực tiếp.

**Thiết kế thí nghiệm v2 [ĐỀ XUẤT — chờ user duyệt].**

*Nhánh (arm).* Cùng task và cùng loop-implement; chỉ khác skill loop-plan:

| Arm | Cấu trúc | Giả thuyết |
|---|---|---|
| A0 | loop-plan hiện tại | Đối chứng |
| A1 | Tối giản: Target/Scope, danh sách yêu cầu, phase chỉ có goal + AC | Chi tiết nhiều có thật sự giúp không? |
| A2 | Yêu cầu có ID dạng EARS. Planner viết sẵn **acceptance test đỏ** vào repo; implementer không được sửa các test này | Giảm làm tắt, giảm test tautology, giảm "báo xong mà chưa xong" |
| A3 | Cấu trúc gọn cộng **Impact map** (mọi producer/consumer/reader của state hoặc type bị đổi, kèm path:line tìm bằng grep) cộng **failure modes và cách làm tắt bị cấm** cho từng contract | Giảm đúng loại lỗi grounding mà pilot 1 thấy |

*Task.* Task thật có đáp án lịch sử. Mỗi task đúng 1 commit implement thật, baseline sạch:

| Task (muster) | Baseline | Commit thật | Số lỗi implement thật đã xảy ra |
|---|---|---|---|
| `preserve-backend-test-history` | `20664b4` | `2baa8db` | 7 |
| `root-coordinator-default` | `2baa8db` | `c0b8267` | 8 |

- Request là Target của plan thật.
- Mở rộng sang ctxe (Rust) chỉ khi pilot có tín hiệu.

*Quy trình mỗi ô (task × arm):*
1. Subagent viết plan theo arm.
2. Một subagent **mới** chạy loop-implement, **không** có codex review trong vòng, để đo chất lượng lần làm đầu do plan tạo ra.
3. Chấm mù: evaluator không biết arm và không đọc plan; chấm code theo user request.

*Thước đo.* M1, M2, M4 là chính; M3 là phụ.

| Mã | Thước đo | Cách làm |
|---|---|---|
| M1 | Lỗi lịch sử tái diễn | Codex judge từng lỗi thật: có / không / không áp dụng, kèm bằng chứng path:line |
| M2 | Hoàn thành mục tiêu | Checklist yêu cầu rút từ request và commit thật, **chốt trước khi chạy**. Judge kiểm từng mục (đạt / một phần / thiếu) bằng cách đọc code và chạy test |
| M3 | Lỗi mới (phụ, vì reviewer nhiễu) | codex-impl-review round 1 trên diff so với baseline, theo request; đếm high/medium |
| M4 | Làm tắt / hallucination | Kiểm tự động và bán tự động: test bị xoá/skip/sửa (A2: test của planner bị sửa); stub/TODO; build và test có pass không; implementer **tuyên bố xong** từng AC thì đối chiếu thực tế; plan nhắc tới path/symbol không tồn tại |

*Chi phí ước tính cho pilot 2 task × 4 arm × 1 lần = 8 ô.* Phần implement là **ước đoán**, sẽ đo thật ở ô đầu:
- 8 subagent viết plan, khoảng 80–100K token mỗi cái;
- 8 subagent implement, khoảng 300–800K token mỗi cái;
- 16 lần chạy Codex (M1 + M3), khoảng 0,5M token input mỗi lần, phần lớn cache.

*Quy tắc mở rộng.* Có arm nào tốt hơn A0 rõ ở M1/M2/M4 trên cả 2 task thì lặp thêm 2 lần, rồi thêm 1 task ctxe. Không có thì dừng và báo.

**Kết quả pilot 2 (2026-10-14) [ĐO ĐƯỢC — n=1 mỗi ô].**
- Dữ liệu ở `common_issues/data/pilot2/`:
  - `summary.json`, `judge.jsonl`, `review.jsonl`, `audit.jsonl`, `implement_agents.jsonl`;
  - oracle trong `oracle/`; skill các arm trong `drafts/pilot2-arms/`;
  - script `scripts/pilot2_eval.py`.
- Baseline của cả 2 task đều xanh: vitest, compile, svelte và e2e (87/87).
- **Judge ổn định:** chấm lại 2 ô thì trùng 27/28 phán quyết, nên nhiễu chính nằm ở agent implement, không ở judge.

Chú thích cột:
- R = yêu cầu đạt; met = 1, partial = 0,5.
- H = số lỗi lịch sử tái diễn.
- M3 = issue từ Codex review vòng 1.
- e2e = chạy lại bởi audit; đã loại 2 lần flaky sau khi chạy lại và thấy pass.

| Ô | R | H tái diễn | M3 | e2e | Token plan / impl |
|---|---|---|---|---|---|
| preserve A0 | 4,5/8 | 3/5 (H2, H3, H4) | REVISE 1h 1m | **54 fail** (bump protocol 13→14, fixture e2e không đổi) | 130K / 112K |
| preserve A1 | 4,5/8 | 3/5 (H2, H3, H4) | REVISE 1h | pass | 87K / 119K |
| preserve A2 | 5/8 | 3/5 (H2, H3, H4) | REVISE 1h 2m | **lỗi cú pháp** (chèn fixture hỏng file e2e) | 94K / 113K |
| preserve A3 | 5/8 | 3/5 (H2, H3, H4) | REVISE 1h | pass | 122K / 141K |
| rootcoord A0 | 5/7 | **6/8** | REVISE 1h 4m | pass | 103K / 258K |
| rootcoord A1 | 5/7 | 4/8 | REVISE 1h 3m | pass | 95K / 223K |
| rootcoord A2 | 5/7 | 4/8 | REVISE 0h 3m | **12 fail** (còn tham chiếu `draft-model-picker`) | 122K / 107K |
| rootcoord A3 | 5/7 | 4/8 | REVISE 1h 3m | **21 fail** | 100K / 118K |

M4 (làm tắt, bịa):
- Không ô nào xoá, skip hay làm yếu test cũ; không có TODO.
- Locked test của A2 không bị sửa.
- Plan bịa path/symbol: chỉ vài tên file test mới mà sau đó agent không tạo (rootcoord A0, A3). Không đáng kể.

**Đọc tay:**
1. **Không arm nào thắng rõ trên cả 2 task**, nên theo quy tắc thì dừng, không mở rộng. Mức hoàn thành yêu cầu gần như bằng nhau. Mọi ô đều dính các lỗi khó vốn có của task:
   - cache coherence;
   - thứ tự async;
   - lỗi ghi DB bị nuốt;
   - vòng đời component (override bị rò hoặc mất);
   - retry/replay re-resolve.
2. **Tín hiệu duy nhất nghiêng về A3 (preserve).**
   - A0, A1 và A2 đều có cùng lỗi high: "trạng thái đã khôi phục không tới được cache mà execution gate đọc".
   - Plan A3 đã lường trước lỗi này ở mục Failure modes (FM-6: "sibling clobber through unmerged cache"). Bản implement tránh được nó; review của A3 không còn lỗi đó.
   - Nhưng A3 vẫn có một lỗi high khác về async race. Lý do: plan A3 chọn cách giảm thiểu sai, cụ thể:
     - FM-5 dựa vào thứ tự `checked_at` ở DB, không có fence trong bộ nhớ;
     - FM-7 chấp nhận `.catch(() => {})` "as today".
   - Vậy liệt kê failure mode giúp *nhìn thấy* rủi ro, nhưng *cách giảm thiểu* trong plan cũng có thể sai, và plan review phải bắt được chỗ này.
   - Ở rootcoord, A3 không hơn A1/A2.
3. **Phát hiện mạnh nhất không thuộc về cấu trúc plan: gate không chạy được thì phải coi là blocker.**
   - Playwright mặc định thiếu browser. 6/8 agent ghi "blocked" rồi đi tiếp.
   - 4/6 ô đó để lại e2e hỏng mà không biết: preserve A0, preserve A2, rootcoord A2, rootcoord A3.
   - 2 agent (rootcoord A0, A1) tự tìm cách chạy bằng browser có sẵn trên máy, và cả 2 đều xanh e2e.
   - Đây là đúng kiểu "báo xong mà chưa kiểm". Đề xuất luật cho loop-implement: một gate trong plan không chạy được thì phải tìm cách chạy, hoặc dừng và báo. Không được "ghi blocked rồi đi tiếp".
4. Agent tự báo "done" cho các AC mà judge chấm partial. Ví dụ ở preserve A0, agent tự ghi deviation "D5 not applied", nhưng vẫn báo các yêu cầu liên quan là done. Self-report không đáng tin để làm bằng chứng hoàn thành.
5. Chi phí implement 107–258K token mỗi ô. A0 rootcoord tốn nhiều nhất (258K, 42 phút) mà lỗi lịch sử tái diễn nhiều nhất.

**Kết luận tạm:**
- Cấu trúc plan là đòn bẩy yếu so với độ khó vốn có của task.
- Hai đòn bẩy có bằng chứng:
  - (a) kỷ luật gate trong loop-implement — mạnh, 4/8 ô;
  - (b) mục Failure modes kiểu A3 — yếu, 1/2 task, cần lặp lại mới tin được.

**Pilot 3 (2026-10-14) [ĐO ĐƯỢC — n=2 mỗi ô; user duyệt "thử A và C"].**

*Thiết kế:*
- 3 arm × 2 task × 2 lần lặp = 12 ô.
- Các arm:
  - A0: loop-plan hiện tại.
  - A3: compact, có Impact map và Failure modes; lặp lại để kiểm tín hiệu của pilot 2.
  - A4 (arm C, mới): compact cộng "State and lifecycle model".
    - Mỗi state là một hàng gồm: owner, writers, readers (kể cả ai đọc bản cache về sau), ordering (có cơ chế ép ở runtime), lifecycle, failure.
    - Mỗi hàng phải map sang AC chạy qua production path.
- Mọi ô dùng `loop-implement-pilot-v2`: gate không chạy được là blocker; deviation còn dở thì phải ghi `not done`.
- Dữ liệu ở `common_issues/data/pilot3/`; skill các arm ở `drafts/pilot2-arms/A4-loop-plan.md` và `loop-implement-pilot-v2.md`.
- **Lưu ý:** mọi agent plan và implement ở pilot 2 và 3 đều chạy **Claude Haiku 5.5**, model mặc định của subagent, không phải Opus. Kết quả có thể khác với model mạnh hơn.

*Kết quả theo ô.* Quy ước cột:
- R = số yêu cầu đạt met.
- H = các lỗi lịch sử còn mắc.
- M3 = số issue high/tổng trong Codex review vòng 1.
- e2e = do audit chạy lại; lỗi flaky đã được chạy lại riêng và thấy pass.

| Ô | R met | H còn mắc | M3 high/tổng | e2e | Token impl |
|---|---|---|---|---|---|
| preserve A0 r1 / r2 | 1/8 · 1/8 | H2 H3 H4 · H2 H3 H4 | 1/1 · 0/2 | pass · pass | 148K · 173K |
| preserve A3 r1 / r2 | 2/8 · 1/8 | H2 H3 H4 · H2 H3 H4 | 1/1 · 1/1 | pass · pass | 210K · 131K |
| preserve A4 r1 / r2 | 0/8 · 2/8 | **H2 H4 · H2 H4** | 1/2 · 1/2 | pass · pass | 177K · 154K |
| rootcoord A0 r1 / r2 | 3/7 · 3/7 | H1 H3 H6 H7 · H1 H3 H4 H5 H7 | 1/4 · 1/5 | pass · pass | 244K · 295K |
| rootcoord A3 r1 / r2 | 3/7 · 3/7 | H2 H3 H7 · H1 H2 H3 H4 H6 H7 | 0/3 · 0/4 | pass · **18 fail thật** | 230K · 199K |
| rootcoord A4 r1 / r2 | 4/7 · 3/7 | **H1 H3 · H1 H3 H6 H7** | 1/4 · 1/6 | pass · pass | 208K · 262K |

*Tổng theo arm (4 ô mỗi arm):*

| Arm | R met | Lỗi lịch sử còn mắc | M3 high | M3 tổng issue | Token impl TB |
|---|---|---|---|---|---|
| A0 | 8 | 15 | 3 | 12 | 215K |
| A3 | 9 | 15 | 2 | 9 | 193K |
| A4 | 9 | **10** | 4 | 14 | 200K |

M4: không ô nào xoá hoặc skip test, không có TODO, và vitest/compile/svelte xanh ở cả 12 ô.
- Bộ đếm báo 3 ô "làm yếu test" (rootcoord A0-r1, A3-r2, A4-r2). Đọc tay thì cả 3 là chuyển đổi hợp lệ: assert về picker được thay bằng `toHaveCount(0)` cộng placeholder hoặc nhãn coordinator, đúng như request yêu cầu bỏ picker. Đây là báo động nhầm.
- Plan có bịa path/symbol nhưng ít. Ví dụ `buildBackendReadinessRows` (preserve A4-r1), `clearDraftOverride` (rootcoord A3-r1), `newTaskModel` (rootcoord A4-r2), và một doc không tồn tại `docs/TASK-MODEL-UI-STATE-AUDIT.md` (rootcoord A0-r2).

*Đọc tay:*
1. **A3 không lặp lại được lợi thế ở pilot 2.**
   - Cả 2 lần preserve A3 vẫn mắc H2, H3, H4, và vẫn có lỗi high về cache/async.
   - Pilot 2 có thể chỉ là may rủi của n=1.
2. **A4 có tín hiệu thật, nhưng hẹp.**
   - Preserve H3 (ghi DB thất bại bị nuốt hoặc kẹt): A4 tránh được ở 2/2 lần. A0 và A3 mắc ở 4/4 lần, và ở cả pilot 2 (2/2).
     - Nếu ngẫu nhiên, xác suất cả 2 ô "absent" cùng rơi vào A4 là 1/28 ≈ 3,6%.
   - Rootcoord: A4 không bao giờ mắc H4/H5 (override rò sang draft khác, hoặc bị xoá khi settings đổi). Đây đúng là loại lỗi bảng state/lifecycle nhắm tới.
   - Tổng lỗi lịch sử của A4 là 10, so với 15 của A0 và của A3.
3. **Lỗi trạng thái khó nhất thì không arm nào giải được.**
   - Preserve H2 (không có fence chống kết quả async cũ ghi đè kết quả mới) và H4 (cache không được làm mới): mắc ở 12/12 lần chạy của preserve, tính cả pilot 2.
   - Rootcoord H3 (retry cùng clientRequestId lại resolve settings): mắc ở 6/6.
   - Plan A4 có viết hàng "ordering" và "lifecycle", nhưng agent implement chọn cách giảm thiểu sai, hoặc chấp nhận phần dư. Ví dụ preserve A4-r1 chấp nhận residual của `peek()`.
   - Vậy "nhìn thấy" rủi ro chưa đủ. Cần một bước kiểm cơ chế: test chạy 2 lời gọi chồng nhau, hoặc retry thật, và phải đỏ trước khi sửa.
4. **Review Codex (M3) không đồng thuận với M1.**
   - A4 có nhiều issue high và tổng issue nhất (4/14). A3 có ít nhất (2/9).
   - Lỗi high của A4 là lỗi mới, không thuộc lỗi lịch sử. Ví dụ rootcoord A4-r2: "Valid draft overrides cannot unblock Send", một lỗi chức năng.
   - Vậy A4 giảm lớp lỗi nó nhắm tới, nhưng không giảm tổng số lỗi. Có thể agent dồn sức vào bảng state, hoặc chỉ là nhiễu ở n=2.
5. **Luật gate v2 của loop-implement có hiệu quả rõ.**
   - Ô để e2e hỏng mà không biết: pilot 2 là 4/8 ô, pilot 3 còn 1/12.
   - Agent cũng thành thật hơn: rootcoord A0-r2, A3-r2 và A4-r2 tự ghi AC `not done` khi còn dở.
6. **Lỗ hổng mới: plan làm hỏng gate, và implement nghe plan thay vì nghe luật.**
   - **Thu hẹp gate** (rootcoord A3-r2):
     - Plan đặt G-4 = e2e với `-g` chỉ 3 test.
     - Agent implement chỉ chạy đúng 3 test đó, dù luật v2 nói mọi suite chạm file đã sửa đều là gate.
     - Placeholder đổi làm 18 test e2e khác đỏ. Chạy lại vẫn đỏ, nên đây là hồi quy thật.
     - Ô này cũng implement nhanh bất thường (688 giây).
   - **Gate hỏng ngay từ baseline** (rootcoord A3-r1): plan đưa vào gate `npm run test:task-audit`, vốn đã đỏ trước khi có thay đổi nào. Agent dừng đúng theo luật, nhưng phase 3 bị bỏ dở.
   - Đề xuất cho loop-plan:
     - Chạy mọi lệnh gate ở baseline và ghi kết quả; lệnh nào đỏ sẵn thì không được làm gate.
     - Không được thu hẹp một suite đã có bằng `-g`/filter để làm gate cuối.
   - Đề xuất cho loop-implement: gate cuối luôn gồm full suite của mọi loại test chạm file đã sửa, bất kể plan ghi gì.
7. **Hoàn thành yêu cầu vẫn thấp ở mọi arm.**
   - Preserve chỉ đạt 0–2/8 met; phần lớn là partial.
   - Không arm nào cải thiện được điều này. Đây là giới hạn của agent implement (Haiku), hoặc độ khó của task, không phải của cấu trúc plan.

*Kết luận tạm (pilot 3):*
- **Đòn bẩy có bằng chứng, xếp theo độ chắc:**
  - (a) luật gate v2 ở loop-implement: 4/8 → 1/12 ô hỏng e2e.
  - (b) kiểm gate ngay ở bước plan: chạy ở baseline, cấm thu hẹp. Cả 2 lỗi cụ thể ở pilot 3 đều nằm ở đây.
  - (c) bảng State and lifecycle (A4): giảm lớp lỗi state rò, nuốt lỗi và sibling (10 so với 15), nhưng không giảm tổng issue review, và không giải được lỗi fence/replay.
- **Không có bằng chứng:** A3 (Impact map và Failure modes) hơn A0.
- **Chưa đo:** hiệu ứng khi dùng Opus.

**Nguyên tắc đánh giá: cải thiện tổng thể, không tối ưu theo case [CHỐT — user 2026-10-14].**
- Review tìm ra lỗi là chuyện bình thường. Mục tiêu là *hạn chế* lỗi, không phải làm cho lỗi không thể xuất hiện. Một arm vẫn còn lỗi high không có nghĩa là arm đó thất bại.
- Không được thiết kế quy tắc nhắm thẳng vào lỗi của vài case cụ thể, rồi thấy các case đó pass là cho rằng đã tối ưu xong. Đó là overfit.
- Một thay đổi tốt phải đúng ở mức general và có tác dụng toàn cục. Từng case vẫn có thể có thiếu sót, nhưng tính tổng trên nhiều task đa dạng thì phải cải thiện.

Hệ quả cho pilot 2–3:
- **Huỷ ý tưởng A5** (bắt test chồng lời gọi hoặc retry cho đúng các hàng ordering). A5 được thiết kế từ chính H2/H3 của 2 task thử, nên là overfit.
- **A4 có nguy cơ overfit ở mức đánh giá.**
  - Bảng state/lifecycle được rút từ các lớp lỗi phổ biến trong dữ liệu review, không phải từ 2 task này. Nhưng nó mới chỉ được đo trên 2 task cùng một repo (muster), và oracle lại lấy từ lịch sử của chính 2 task đó.
  - Mức "10 so với 15" chưa chứng minh được tác dụng general.
- **Luật gate** (implement v2; kiểm gate ở baseline; cấm thu hẹp suite) không phụ thuộc task. Bằng chứng cũng nằm ở cơ chế chung (agent ghi "blocked" rồi đi tiếp; plan thu hẹp gate), không nằm ở nội dung task. Đây là ứng viên general mạnh nhất, nhưng vẫn mới đo trên một repo.
- **Cách đo đúng từ nay:**
  - Thiết kế quy tắc từ pattern xuyên nhiều task.
  - Kiểm trên tập task *giữ lại*: repo khác, chưa từng dùng khi thiết kế.
  - Báo cáo tỉ lệ gộp theo arm. Thắng ở từng case chỉ là giai thoại.
  - Nguồn task: `data/plans/plan_impl_link.json` có 64 plan, trong đó ctxe khoảng 46, mdworker 11, salonrize 2, muster 2. Có 36 plan có lỗi review high.

**Pilot 4: kiểm tính tổng quát trên task giữ lại (user chọn phương án 1, 2026-10-14) [THIẾT KẾ — đã khoá trước khi chạy].**

*Sửa dữ liệu nguồn trước khi chọn task.*
- `plan_impl_link.json` cũ nối plan với lỗi review qua ID phiên. ID này (`codex-impl-review-YYYYMMDD-NNN`) trùng nhau giữa các repo, và bước nối không lọc theo project. Kết quả là plan bị gán nhầm lỗi của repo khác: kiro và grok bị gán 21–39 lỗi của ctxe.
- Bản sửa `scripts/relink_plans.py` nối theo từng thư mục `.codex-review`, ra file `data/plans/plan_impl_link_v2.json` (90 plan, 1056 lỗi).
- Pilot 2/3 không bị ảnh hưởng, vì oracle của 2 task muster đã lọc theo project.

*Chọn task:*
- 6 task, 2 repo khác muster:
  - raw-cli: switcher, batch, library (đã thu về phần Components);
  - mdworker: xlsx, ocrsel, wallet.
- Bị loại:
  - ctxe: Rust, chưa có thư mục build, plan quá lớn.
  - salonrize: plan quá lớn.
  - kiro, grok: mỗi plan chỉ có 1 lỗi lịch sử.
- Baseline của mỗi task là commit ngay trước commit đầu tiên của plan. Đề bài, R và H do agent Opus soạn từ plan gốc và lỗi lịch sử của chính task đó, sau đó tôi rà lại và khoá bằng checksum (`data/pilot4/oracle/FROZEN.sha256`).
- Gate baseline:
  - mdworker xanh, trừ `npm run typecheck` của wallet đỏ sẵn.
  - raw-cli có 1–3 test REPL PTY (`tests/cli.test.ts` T-08, T-08b) đỏ sẵn, và 1 test Firefox flaky.
  - Agent **không** được báo trước các lỗi có sẵn này. Nhánh có luật gate phải tự phát hiện.

*3 nhánh, cùng model (Haiku, mặc định của subagent), mỗi ô chạy 1 lần, tổng 18 ô. Skill nằm ở `common_issues/drafts/pilot4-arms/`:*
- `cur`: loop-plan A0 + loop-implement v1, tức skill hiện tại.
- `gate`: A0 + luật kiểm gate ở bước plan + loop-implement v3. Luật kiểm gate gồm: chạy mọi gate ở baseline và ghi kết quả; lệnh đỏ sẵn không được làm gate; Global Gate không được thu hẹp suite. Loop-implement v3 = v2 + chạy full suite khi gate của plan bị lọc + phân biệt lỗi có sẵn với hồi quy bằng cách so với baseline.
- `state`: A4 (giữ nguyên như pilot 3) + đúng các luật gate của nhánh `gate`.
- Lưu ý: A4 vừa có bảng state vừa dùng cấu trúc gọn. Pilot 3 cho thấy cấu trúc gọn một mình (A3) không hơn A0, nên khác biệt giữa `state` và `gate` chủ yếu đến từ bảng state.

*Đo:*
- Cùng M1–M4 như pilot 3, chấm mù theo oracle.
- Chỉ báo cáo tổng theo nhánh trên 6 task: lỗi lịch sử còn mắc, số R đạt met, review high, hồi quy gate so với baseline, làm tắt (M4).
- Thắng thua ở từng task không dùng để kết luận.

**Kết quả pilot 4 (2026-10-14) [ĐO ĐƯỢC — n=1 mỗi ô, Haiku].**

*Cách tính:*
- 3 ô dừng sớm vì plan (ocrsel-gate, wallet-gate, library-gate).
  - View chính: chấm đúng trạng thái lúc dừng (snapshot `*-gatestop`).
  - View nhạy: chấm sau một câu làm rõ trung lập ("không có user, tự quyết theo luật skill và scope plan").
- Tỉ lệ lỗi lịch sử = present / (present + absent) của từng task, rồi lấy trung bình 6 task. Hazard "not-applicable" (thường do ô dừng sớm, chưa làm phần đó) không tính.
- credit = (met + 0,5·partial) / R.
- Gate được so với baseline của chính task, không so với "xanh tuyệt đối".

*Tổng theo nhánh:*

| Nhánh | Tỉ lệ lỗi lịch sử | credit | R missing | review high / tổng issue | Ô dừng | M4 |
|---|---|---|---|---|---|---|
| cur | 0,57 | 0,55 | 0 | 9 / 32 | 0 | 0 |
| gate (view chính) | 0,47* | 0,40 | 10 | 14 / 32 | 3 | 0 |
| gate (view nhạy) | 0,62 | 0,47 | 6 | 14 / 32 | 3 (1 vẫn dừng) | 1 TODO |
| state | 0,64 | 0,54 | 0 | 10 / 39 | 0 | 1 |

\* Thấp giả tạo: ô dừng sớm chưa làm nên nhiều hazard thành not-applicable.

*Lỗi lịch sử theo task (present / áp dụng):*

| Task | cur | gate | state |
|---|---|---|---|
| switcher | 5/12 | 8/11 | 7/11 |
| batch | 5/7 | 6/7 | 5/6 |
| library | 2/5 | 2/5 (nhạy 4/5) | 2/5 |
| xlsx | 6/9 | 4/9 | 4/9 |
| ocrsel | 5/11 | dừng (2/5) | 6/11 |
| wallet | 3/4 | dừng (nhạy 2/4) | 4/4 |

*Gate so với baseline (chạy lại tuần tự, máy rảnh):*
- 15/18 ô không có hồi quy, ở cả 3 nhánh, kể cả `cur`.
- Lỗi mới chỉ có:
  - switcher-gate: 2 test Playwright do chính agent viết (`workspaces.spec.ts`) bị flaky. Chạy lại 3 lần thì đỏ 3/6.
  - Hai ô dừng: library-gatestop đỏ 3 test (lỗi đang dở lúc dừng) và wallet-gatestop đỏ 11 test (đang thiết kế lại harness).
- Các lỗi khác chỉ là flaky đã biết: Firefox history pagination, và 1 test WebKit chạy lại thì xanh 3/3.
- M4 gần như bằng 0 ở mọi nhánh: không xoá test, không skip. Chỉ có 1 test bị làm yếu (ocrsel-state) và 1 TODO (wallet-gate).

*Đọc kết quả:*
1. **Không nhánh nào giảm lỗi lịch sử so với `cur` trên task giữ lại.**
   - state: 0,64 so với 0,57; gate (nhạy): 0,62.
   - Theo từng task, state chỉ tốt hơn cur ở xlsx, và gate ở xlsx/wallet. Ở các task còn lại thì bằng hoặc kém. Mức chênh này nằm trong nhiễu của n=1.
   - Lợi thế của A4 ở pilot 3 (10 so với 15) **không lặp lại** ở repo khác. Điều này khớp với lo ngại overfit đã ghi ở trên.
2. **Luật gate ở bước plan gây hại rõ ràng: tạo điểm dừng.**
   - 3/6 ô gate dừng giữa chừng, so với 0/6 ở cur và 0/6 ở state. state cũng có luật gate, nhưng plan A4 không sinh ra điều kiện dừng cứng.
   - Cả 3 điểm dừng đều do plan tự viết ra:
     - ocrsel: "điều kiện vào cứng" là phải đọc được tài liệu API bên ngoài, trong khi không có mạng. Sau câu làm rõ, agent vẫn dừng, vì plan ghi luật cứng đè lên giả định A1 của chính plan.
     - wallet: plan bắt thiết kế lại harness test, việc này làm lộ lỗi có sẵn.
     - library: plan đặt một invariant mâu thuẫn với thiết kế.
   - Chi phí: 10 R bị missing ở view chính. credit thấp nhất (0,40), và review high nhiều nhất (14).
3. **Lợi ích của luật gate ở pilot 3 không tái hiện, vì `cur` cũng không làm hỏng gate.**
   - Ở pilot 3, loop-implement v1 để e2e hỏng mà không biết ở 4/8 ô. Ở pilot 4, cả 6 ô cur đều chỉ còn lỗi baseline.
   - Agent cur cũng tự báo đúng lỗi baseline (batch-cur ghi T-08b là lỗi có sẵn).
   - Vậy lợi ích ở pilot 3 có thể gắn với repo muster (e2e nặng, dễ bị thu hẹp bằng `-g`), không phải lợi ích general.
4. **Hoàn thành yêu cầu vẫn thấp và gần như bằng nhau** (credit 0,54–0,55 ở cur/state). Phần lớn R là partial. Đây vẫn là giới hạn của agent implement (Haiku) hoặc độ khó của task, không phải của cấu trúc plan.
5. **Review Codex không phân biệt được các nhánh.** Cả 18 ô đều REVISE, và số issue high gần nhau (9 / 10 / 14).

*Bài học general (thấy ở nhiều task, nhiều nhánh):*
- **Plan sinh ra điểm dừng cứng là có hại.** Luật trong plan ("điều kiện vào cứng", "invariant bắt buộc") được agent implement coi là cao hơn cả giả định của chính plan và luật skill. Plan cần phân biệt rõ "chặn thật" (an toàn, mất dữ liệu) với "nên làm". Phần không kiểm được thì ghi thành giả định có cách lùi, không ghi thành cổng chặn.
- **Plan tự mâu thuẫn trong AC.** Ví dụ: AC yêu cầu grep phải rỗng, trong khi một test khác lại cần đúng chuỗi đó. Gặp ở cả wallet-cur và wallet-state. Agent báo thật, nhưng AC đó coi như bỏ.
- **Gate của plan đỏ giữa chừng theo thiết kế.** Ở switcher-cur, gate phase 3 đỏ tới tận phase 5. Gate của từng phase phải xanh được ngay ở chính phase đó.
- **Plan có lường trước việc phải sửa test cũ thì implement không bị kẹt.** Ví dụ library-state đã ghi trước việc thêm thao tác click tab vào `management.spec.ts`.
- **Tự audit cuối phase bắt được lỗi thật**: số symlink (switcher-gate), header tràn (library-state), buffer theo dòng (batch-gate). Bước này nên giữ.
- **Viết code trước test** xảy ra ở mọi nhánh. Nhiều khả năng đây là điểm yếu của Haiku, không phải của skill.
- **Test do agent viết có thể flaky** (switcher-gate). Gate chạy 1 lần không bắt được. Có thể cân nhắc chạy lặp lại các test mới viết.

*Giới hạn của pilot 4:*
- n=1 mỗi ô, nên mức chênh 1–3 hazard mỗi task nằm trong nhiễu.
- Chưa đo độ nhất quán của giám khảo. Plan và implement chạy bằng Haiku.
- Các ô chạy song song làm máy quá tải: test timeout, gây flaky lúc agent tự chạy. Gate để chấm thì đã chạy lại tuần tự.
- Số token của subagent không tin được (xlsx-cur báo 61K token với 120 lần gọi tool), nên không dùng làm chỉ số.

*Kết luận tạm (pilot 2–4):*
- Không thay đổi nào trong A3, A4 hay luật gate ở bước plan cho thấy cải thiện general trên task giữ lại.
- Luật gate ở bước plan, khi viết như hiện tại, còn gây hại vì tạo điểm dừng.
- Ứng viên còn lại là các bài học general ở trên (chống điểm dừng cứng, AC tự mâu thuẫn, gate phải xanh trong phase), nhưng chưa được kiểm như một nhánh riêng.

**Pilot 5: nhánh "plan tự kiểm" so với skill hiện tại (user chọn phương án 1, 2026-10-14) [THIẾT KẾ — khoá trước khi chạy].**

*Nhánh:*
- `check` = cur-loop-plan + 3 luật, cộng loop-implement v1. Chỉ đổi plan, nên khác biệt đến từ 3 luật này. Skill nằm ở `common_issues/drafts/pilot5-arms/check-loop-plan.md`.
  1. Gate của mỗi phase phải pass được khi phase đó kết thúc, chỉ dựa vào phase đó và các phase trước. Phase nào làm đổi hành vi cũ thì phải liệt kê các test cũ sẽ vỡ và sửa chúng ngay trong phase đó.
  2. Không bắt implement phụ thuộc vào thứ agent không kiểm được trong môi trường của nó (tài liệu ngoài, mạng, credential, quyết định của user sau này). Gặp thứ như vậy thì chọn mặc định, ghi thành giả định kèm cách lùi. Điểm dừng cứng chỉ dành cho mất dữ liệu, bảo mật, hoặc hành động không đảo ngược được.
  3. Khi tự review plan, đối chiếu AC, invariant, yêu cầu tài liệu và test dự kiến giữa mọi phase với nhau; cặp nào không thể cùng đúng thì giải quyết ngay trong plan.
- `cur2` = chạy lại đúng skill hiện tại (giống `cur` ở pilot 4). Nhánh này làm đối chứng cùng thời điểm, và cho thêm mẫu thứ 2 của `cur` để đo nhiễu giữa 2 lần chạy cùng skill.

*Cách chạy:* cùng 6 task, oracle, prompt và Haiku như pilot 4, tổng 12 ô. Mỗi đợt chạy 6 agent, và trộn cả 2 nhánh trong cùng đợt để tải máy như nhau.

*Đo:*
- M1–M4, cùng script như pilot 4.
- Thêm tiêu chí: số ô dừng, số AC tự mâu thuẫn, số gate đỏ theo thiết kế.
- **Ngưỡng coi là có tác dụng:** `check` phải tốt hơn `cur2` một khoảng **lớn hơn** độ lệch giữa `cur` (pilot 4) và `cur2`, ở tỉ lệ lỗi lịch sử hoặc credit, và không được kém hơn ở chỉ số còn lại. Nếu không đạt thì kết luận là không đo được tác dụng.

---

## 17. Ưu tiên chuẩn ngành / best practice thay vì chắp vá [CHỐT nguyên tắc — user 2026-10-14; chi tiết là ĐỀ XUẤT]

### Nguyên tắc (user)
- Tham khảo standard industry, best practice, common pattern. Có xu hướng đề xuất làm đúng, **kể cả khi phải breaking change ở nhiều chỗ**, thay vì chắp vá rải rác khắp hệ thống.
- Điều kiện: phải chứng minh cách làm đó đúng pattern và tốt cho phát triển lâu dài. Như vậy còn hơn giữ hiện trạng, càng làm càng rối.

### Va chạm với quy tắc hiện có (cần sửa cho nhất quán)
- loop-plan, Discovery 3: "Choose the smallest project-consistent design; do not add speculative abstractions or compatibility behavior". Câu này đẩy về phía chắp vá nếu pattern trong repo đã rối.
- codex-impl-review và codex-plan-review: "Do NOT over-engineer", "NOT to redesign it", "No new … abstractions". Reviewer sẽ phản đối một đề xuất tái cấu trúc đúng chuẩn.
- Intent guard: thay đổi "architecture direction" là USER DECISION. Điều này vẫn đúng và nên giữ, vì đề xuất breaking thì user quyết.

### Đề xuất cách viết thành quy tắc
- **Trong Discovery của loop-plan:** với mỗi vấn đề, tìm cả pattern trong repo **và** cách làm chuẩn hiện hành.
  - Nguồn: docs chính thức, khuyến nghị của framework, pattern phổ biến. Kiểm từ nguồn hiện tại theo tinh thần mục 3.6, không dùng trí nhớ.
  - Nếu pattern trong repo chính là nguồn rối, thì trình bày **hai phương án**:
    - (a) chắp vá tối thiểu;
    - (b) làm theo chuẩn, kèm: nguồn dẫn chứng, spike chứng minh (mục 12), phạm vi ảnh hưởng (các chỗ phải đổi, có breaking hay không), chi phí migrate, lợi ích lâu dài cụ thể (bớt bao nhiêu chỗ đặc biệt, bớt loại lỗi nào).
  - Khuyến nghị (b) khi có bằng chứng. Đây là USER DECISION, user chọn.
- **"Không over-engineer" vẫn giữ**, nhưng định nghĩa lại: over-engineering là thêm trừu tượng, cấu hình hay khả năng **không cần cho mục tiêu**. Thay thế một cách làm rối bằng chuẩn đã chứng minh **không** phải over-engineering.
- **Prompt của review skill:** reviewer không được phản đối một thay đổi đúng chuẩn mà user đã chọn chỉ vì "redesign". Reviewer được nêu khi bản chắp vá tạo thêm nợ (code đặc biệt, xử lý lặp lại) và có chuẩn tốt hơn, nhưng dưới dạng scope-decision, không phải lỗi bắt buộc sửa.
- **Dữ liệu ủng hộ (gián tiếp):**
  - Khoảng 70% issue vòng ≥2 là bug do chính lần sửa trước gây ra, tức là kiểu "vá trên vá".
  - 20% phiên impl kéo ≥4 vòng.
  - [MỞ] Có thể đo thêm: các file hay vùng code bị sửa lặp lại qua nhiều phiên.

---

## 18. Phân vai theo giai đoạn: thiết kế lớn chỉ ở plan, implement chỉ thực thi [CHỐT — user 2026-10-14]

### Nguyên tắc (user)
- **Lúc plan:** được đề xuất breaking change hoặc tái cấu trúc theo chuẩn ngành (mục 17). **codex-plan-review phải hỗ trợ việc này**: đánh giá đề xuất đúng chuẩn chưa, có bằng chứng chưa, thay vì phản đối vì "redesign".
- **Lúc implement:** không đề xuất lại các thay đổi kiến trúc hay công nghệ. **codex-impl-review không review những vấn đề đó**, mà tập trung vào lỗi implement so với plan đã chốt.
  - Plan đã chốt mà lúc implement lại đưa ra một đống công nghệ, làm thêm một đống thứ, là sai.

### Cách viết thành quy tắc [ĐỀ XUẤT]
- **codex-plan-review prompt:**
  - Bỏ hoặc sửa các câu "Do NOT over-engineer / no new abstractions" theo định nghĩa mới ở mục 17.
  - Thêm nhiệm vụ: kiểm đề xuất chuẩn ngành (nguồn, spike, phạm vi breaking, migrate).
  - Thêm nhiệm vụ: chỉ ra chỗ plan đang chọn vá trong khi có chuẩn rõ ràng tốt hơn.
- **codex-impl-review prompt:**
  - Phạm vi: code có làm đúng plan đã chốt không, và lỗi implement (các lớp ở mục 1.3).
  - **Không** đề xuất công nghệ, kiến trúc hay tái cấu trúc khác với plan.
  - Thấy plan có vấn đề thiết kế thật thì chỉ ghi một finding loại `plan-gap`, để Claude dừng hỏi user, không tự sửa thiết kế.
- **loop-implement:**
  - Không tự thêm công nghệ, dependency hay cơ chế ngoài plan.
  - **Được đề xuất đổi plan khi thật sự cần** [CHỐT — user 2026-10-14]. Ví dụ: không đổi thì gây bug, giảm hiệu năng hoặc tạo rủi ro, và vấn đề này lúc plan không thấy được, phải đến lúc implement mới lộ ra (spike sai, API cư xử khác, dữ liệu thật khác giả định).
    - Trình bày cho user theo mẫu ở mục 19, như thể user không biết gì. Phải nêu rõ vì sao cần đổi, lợi ích, tác hại nếu có, và tác động. Không hỏi vắn tắt.
    - User đồng ý thì **ghi vào plan, kèm ghi chú rõ là đã được user đồng ý** (ngày, nội dung đồng ý). **Không cần chạy lại codex-plan-review.**
    - User không đồng ý thì giữ plan, ghi lại quyết định đó.
    - Nối với mục F "Fixed decisions" và nhật ký lệch ở mục 5.2.
- **Phân loại trong review skill:**
  - Finding chỉ là "có cách thiết kế hay công nghệ khác hay hơn" ở giai đoạn implement thì mặc định là DISPUTE, vì đã chốt ở plan.
  - Finding chỉ ra plan gây bug, giảm hiệu năng hay tạo rủi ro thật thì là `plan-gap`, và thành đề xuất đổi plan theo quy trình ở trên.

---

## 19. Trình bày quyết định cho user như thể user chưa biết gì về hệ thống [CHỐT — user 2026-10-14]

### Vấn đề (user)
Vấn đề lớn nhất của vibe coding hiện nay: user cứ đồng ý đại mà không hiểu mình đang đồng ý cái gì, và mất kiểm soát. Agent hỏi như thể user đã hiểu rõ vấn đề rồi bắt quyết định.

Quá trình plan cũng phải tăng cường trao đổi với user.

### Mẫu "bản tóm tắt quyết định" [ĐỀ XUẤT]
Dùng chung cho loop-plan, loop-implement và các review skill, mỗi khi cần user quyết. Viết bằng ngôn ngữ của user, giải thích thuật ngữ nếu phải dùng.
1. **Bối cảnh:** phần hệ thống này hiện làm gì, 1–3 câu, không giả định user nhớ code.
2. **Vấn đề:** chuyện gì xảy ra nếu để nguyên, kèm ví dụ cụ thể user nhìn thấy được (hành vi, lỗi, chi phí, thời gian).
3. **Các lựa chọn:** mỗi lựa chọn nói rõ:
   - thay đổi gì với user hoặc người dùng cuối;
   - tốn gì (thời gian, phạm vi sửa, breaking);
   - rủi ro gì;
   - **có quay lại được không**.
4. **Khuyến nghị và vì sao:** gắn với bằng chứng (spike, nguồn, dữ liệu). Cho user thấy **lợi ích** và **tác hại** của lựa chọn được khuyến nghị (không có hại thì không cần nêu), và **tác động** cụ thể của nó. [CHỐT — user]
5. **Nếu đồng ý thì cụ thể sẽ xảy ra gì tiếp theo:** phạm vi, file hay khu vực bị đổi, cái gì không đổi.

Quy tắc kèm theo:
- Mỗi lần hỏi một quyết định, không gộp nhiều quyết định vào một câu "ok không?".
- Không dùng lựa chọn mặc định ngầm. Không coi im lặng hay một câu "ok" chung chung là đồng ý cho những thứ chưa được trình bày.

### Tăng trao đổi trong loop-plan [ĐỀ XUẤT]
Ba điểm dừng ngắn để user nắm và sửa sớm:
1. **Sau Discovery:** nhắc lại mục tiêu theo cách hiểu của agent (target, ngoài phạm vi, giả định), để user sửa nếu hiểu sai.
2. **Sau spike, trước khi viết phase:** các quyết định thiết kế chính, đặc biệt là phương án vá hay làm theo chuẩn (mục 17) và breaking change, trình bày theo mẫu trên.
3. **Handoff:** câu chuyện implement bằng lời thường, cộng các review checkpoint (mục 14), cộng những gì user cần nhớ (phạm vi, rủi ro còn lại).

Mỗi điểm dừng phải ngắn. Mục tiêu là user hiểu, không phải đọc nhiều.

---

## 20. Câu hỏi mở cần thảo luận tiếp

> Cập nhật 2026-10-15: user giao cho Claude chọn phương án ổn nhất để hoàn thiện kế hoạch. Mọi câu dưới đây đã có lựa chọn mặc định ở mục 21.2. User vẫn đổi được bất kỳ lựa chọn nào trước khi implement.
1. Đồng ý nguyên tắc "quy tắc sinh ra thứ kiểm được" (mục 2) không?
2. Mục nào trong A–F thừa, hoặc làm plan quá nặng?
3. Làm các phân tích ở mục 6 trước khi viết, hay viết bản đầu rồi bổ sung sau?
4. Chính sách giới hạn (mục 3) đặt ở `references/` dùng chung, hay viết thẳng vào SKILL.md?
5. Có quản lý bản Codex của skill loop trong repo này không? Nếu có thì installer cài cả `~/.codex/skills`?
6. Phạm vi sửa prompt review (codex-impl-review, codex-plan-review) có nằm trong đợt này không?
7. Gộp protocol: một nguồn trong repo và installer gộp lúc cài, hay copy tay vào từng SKILL.md?
8. Flavor text: bỏ, rút gọn vào SKILL.md, hay giữ nguyên?
9. Model reviewer lấy từ đâu: chỉ khi user nêu, plan ghi theo phase, hay một mặc định cấu hình được?
10. Đồng ý hướng "runner lo trạng thái, Claude lo nội dung" với 4 lệnh `begin`/`wait`/`reply`/`end` (mục 10) không?
11. ~~MCP: SDK hay tự viết, có tự đăng ký không, có hỗ trợ Codex điều phối không~~: đã chốt ở mục 11. Còn mở: Claude làm reviewer chạy bằng gì.
12. ~~Chỗ để spike~~: đã chốt `.codex-review/spikes/<tên-plan>/`, runner tự ghi `.codex-review/.gitignore`.
13. ~~Mức chặt của test và spike; gom review~~: đã chốt là lỏng, review theo checkpoint của plan (mục 13, 14).
14. ~~Bảng tinh giản loop-implement~~: đã đồng ý (mục 15).
15. Cấu trúc plan mới, 11 mục cấp plan cộng 5 mục mỗi phase (mục 16): đồng ý không, có thiếu tính năng nào không?
16. ~~`Plan Review: APPROVE` chỉ đặt khi codex-plan-review APPROVE hoặc user duyệt~~: đã đồng ý.
17. ~~Cách viết nguyên tắc chuẩn ngành~~: đã đồng ý.
15b. Cấu trúc plan: đợt này giữ cấu trúc phase hiện tại, tái cấu trúc để sau khi có bằng chứng (mục 16)? Có làm phân tích trên hơn 40 plan thật không?
18. ~~Phân vai plan/implement~~: đã chốt, có bổ sung "được đề xuất đổi plan khi cần, user đồng ý thì ghi vào plan, không chạy lại plan-review" (mục 18).
19. Mẫu tóm tắt quyết định và 3 điểm dừng (mục 19): đã bổ sung yêu cầu nêu lợi ích, tác hại, tác động. Còn chờ user xác nhận 3 điểm dừng.

---

## 21. Kế hoạch implement [CHỐT phạm vi — user 2026-10-15]

User giao (2026-10-15): hoàn thiện kế hoạch trong lúc chờ pilot 5. Nếu nhánh `check` chứng tỏ tốt hơn thì dùng; nếu không thì dừng thử nghiệm, chọn mẫu ổn nhất và ghi vào kế hoạch.

### 21.1 Nguyên tắc chọn nội dung

Có hai loại thay đổi, và mỗi loại được biện minh theo cách khác nhau:

1. **Quy tắc nhằm nâng chất lượng code** (plan phải có bảng gì, implement phải kiểm gì).
   - Chỉ đưa vào khi có bằng chứng thực nghiệm trên task giữ lại (mục 16, pilot 2–5).
   - Không có bằng chứng thì không thêm, dù nghe hợp lý. Bài học ở mục 1.1 là lời nhắc gần như không đổi được hành vi, và pilot 4 cho thấy thêm luật có thể gây hại (tạo điểm dừng).
2. **Thay đổi quy trình mà user đã chốt** (review theo checkpoint, ai được đặt APPROVE, spike, cách hỏi user, chọn model, sửa runner).
   - Đây là quyết định của user về cách làm việc, không phải giả thuyết chất lượng, nên đưa vào luôn.
   - Ràng buộc: không được làm skill dài và rối hơn (mục 15, 16), và không được sinh ra điểm dừng cứng mà agent implement không tự giải được (bài học pilot 4).

### 21.2 Lựa chọn cho các câu hỏi còn mở (Claude chọn theo uỷ quyền của user; user đổi được)

| # (mục 20) | Câu hỏi | Lựa chọn | Lý do |
|---|---|---|---|
| 1 | Quy tắc phải sinh ra thứ kiểm được | **Đồng ý** | Khớp với bằng chứng: lời nhắc không đổi hành vi (mục 1.1). |
| 2 | Bảng A–F trong plan | **Không thêm A, B, D. C chỉ dùng khi có giới hạn. E chờ pilot 5. F gộp vào mục 18.** | A (Impact map, arm A3) và B (bảng state, arm A4) không cải thiện trên task giữ lại (pilot 3–4). D là dạng checklist nhắc nhở. |
| 3 | Phân tích dữ liệu ở mục 6 | **Không làm trước.** | Các pilot đã trả lời câu hỏi quan trọng hơn. Chính sách giới hạn đã chốt, không cần số đo để viết. |
| 4 | Chính sách giới hạn để ở đâu | **Viết gọn thẳng vào SKILL.md** | Theo mục 9: SKILL.md tự đủ, không phải đọc thêm file. |
| 5 | Repo quản lý bản Codex của loop skills | **Có** | Mục 11 đã chốt hỗ trợ Codex điều phối, nên bắt buộc. |
| 6 | Sửa prompt review trong đợt này | **Có** | Mục 3, 17, 18 cần sửa ở cả phía reviewer. |
| 7 | Gộp protocol | **Một nguồn trong `shared/`, installer gộp lúc cài** | Tránh 5 bản copy lệch nhau. Nhờ 4 động từ (mục 10) nên phần protocol chỉ còn khoảng 15 dòng. |
| 8 | Flavor text | **Bỏ hẳn** [CHỐT — user 2026-10-15: "không cần thiết"] | Bỏ bước đọc 162 dòng mỗi phiên và các trigger phải nhớ. |
| 9 | Model reviewer lấy từ đâu | **User nêu, hoặc plan ghi theo từng review checkpoint. Không có thì để Codex dùng mặc định.** | Runner lưu model vào session, nên không còn rủi ro quên truyền khi resume. |
| 10 | Runner lo trạng thái với 4 lệnh | **Đồng ý** | Mục 11 (MCP, đã chốt) cần đúng lõi 4 động từ này ("một lõi, hai vỏ"). |
| 15, 15b | Cấu trúc plan mới | **Giữ cấu trúc phase hiện tại** | Pilot 1–4: cấu trúc khác không giảm lỗi. Đổi cấu trúc chỉ thêm rủi ro. |
| 19 | 3 điểm dừng trong loop-plan | **Đồng ý, mỗi điểm ngắn** | User chốt "tăng trao đổi lúc plan". Lúc plan luôn có user, nên điểm dừng ở đây không gây hại như điểm dừng trong plan giao cho implement. |
| 11 (còn mở) | Claude làm reviewer chạy bằng gì | **Kiểm khả thi ở phase 3. Không khả thi thì hoãn sang đợt sau, ghi rõ.** | Chưa có bằng chứng thực tế. |

### 21.3 Nội dung đưa vào loop-plan và loop-implement

**Đưa vào** (quy trình đã chốt, hoặc có bằng chứng):

| Thay đổi | Skill | Nguồn |
|---|---|---|
| `Plan Review: APPROVE` chỉ được đặt khi codex-plan-review trả APPROVE hoặc user duyệt, kèm ghi nguồn. Bỏ việc agent tự đặt APPROVE. | plan, implement | Mục 16 (chốt). Pilot 1: 4/4 plan tự APPROVE đều bị Codex REVISE với lỗi high. |
| Mục "Review checkpoints": plan chọn phase nào cần review Codex và vì sao, kèm model nếu có. Implement chỉ review tại đó, bằng `/codex-impl-review`. | plan, implement | Mục 14 (chốt) |
| Thang test: lệnh hẹp cho từng AC, phase gate nhẹ, full suite chỉ ở cuối. Baseline ghi thời lượng thật của lệnh. | plan, implement | Mục 13 (chốt) |
| Feasibility spike trong `.codex-review/spikes/<tên-plan>/` cho giả định kỹ thuật chưa thấy chạy thật. Ghi bảng "Feasibility evidence". | plan | Mục 12 (chốt) |
| **Giả định không kiểm được thì giải quyết ngay lúc plan** (spike, hoặc hỏi user vì lúc này có user). Plan giao cho implement không được chứa điều kiện dừng cứng dựa trên thứ không kiểm được. Phần còn lại ghi thành giả định kèm mặc định và cách lùi. | plan | Pilot 4: 3/3 điểm dừng của nhánh gate đều do plan tự viết ra. Đây là bản hợp nhất giữa mục 12 (`UNVERIFIED`) và luật 2 của pilot 5. |
| Chuẩn ngành: so pattern trong repo với cách làm chuẩn; nếu khác thì trình bày hai phương án theo mẫu mục 19. | plan | Mục 17 (chốt) |
| Mục "Fixed decisions": quyết định nào implement không được tự đổi. | plan | Mục 18 (chốt) |
| Chính sách giới hạn, bản gọn: validate tính đúng khác giới hạn dung lượng; mỗi giới hạn khai đủ 4 điều; chạm ngưỡng thì xử lý mềm; năng lực bên ngoài phải kiểm từ nguồn hiện tại. Chỉ áp khi plan có giới hạn. | plan, implement | Mục 3 (chốt) |
| 3 điểm dừng ngắn: sau Discovery, sau spike, ở handoff. Mỗi quyết định trình bày theo mẫu mục 19. | plan | Mục 19 (chốt) |
| Bảng tinh giản loop-implement (bỏ ghi sổ 4 chỗ, bỏ tự xử lý finding trùng với review skill, gộp xem diff, finalization dùng lại bằng chứng của phase). | implement | Mục 15 (chốt) |
| **Kỷ luật gate:** gate không chạy được thì phải tìm cách chạy; không được ghi "blocked" rồi đi tiếp. Lỗi đã đỏ sẵn ở baseline thì so với baseline, ghi lại và đi tiếp; chỉ lỗi mới mới chặn. | implement | Pilot 2: 4/8 ô để e2e hỏng mà không biết. Pilot 3: còn 1/12 sau khi có luật. Phần so với baseline thêm vào để luật không tạo điểm dừng (pilot 3, rootcoord A3-r1). |
| Đề xuất đổi plan khi implement lộ ra vấn đề thật: trình bày theo mẫu mục 19; user đồng ý thì ghi vào plan kèm ngày, không chạy lại plan-review. Không tự thêm công nghệ, dependency, giới hạn hay cơ chế ngoài plan. | implement | Mục 18 (chốt) |
| AC còn dở thì báo `not done` kèm lý do, không báo done. | implement | Pilot 2: agent tự báo done cho AC mà judge chấm partial. Pilot 3–5: có luật này thì agent báo thật. |
| Giữ bước tự audit tích hợp ở cuối. | implement | Pilot 4–5: bước này bắt được lỗi thật ở 4 ô (symlink, header tràn, buffer theo dòng, ngày `NaN`). |

**Không đưa vào** (đã thử, không có tác dụng general, hoặc gây hại):

| Thay đổi | Lý do |
|---|---|
| Tái cấu trúc phase (11 mục cấp plan + 5 mục mỗi phase) | Pilot 1–2: không khác về chất lượng. |
| Impact map và Failure modes (A3) | Pilot 3: không hơn A0. |
| Bảng State and lifecycle (A4) | Pilot 3 có lợi ở muster, nhưng pilot 4 không lặp lại trên task giữ lại (0,64 so với 0,57). |
| Luật kiểm gate ở bước plan (chạy gate ở baseline, cấm thu hẹp suite) | Pilot 4: 3/6 ô dừng giữa chừng, credit thấp nhất, review high nhiều nhất. |
| Danh mục bẫy theo loại code (D) và checklist dạng nhắc nhở | Mục 1.1: lời nhắc không đổi hành vi. Chưa thử, và rủi ro làm skill dài thêm. |
| Bắt test đột biến cho mọi AC | Tốn công. Chưa có bằng chứng. Mục 13 chỉ giữ dạng tuỳ chọn cho AC cốt lõi. |

**Chờ pilot 5** (mục 21.7): 3 luật "plan tự kiểm":
- gate của phase xanh được trong chính phase đó;
- không có điểm dừng cứng dựa trên thứ không kiểm được (ý chính đã được đưa vào ở bảng trên, qua mục 12);
- đối chiếu chéo AC, invariant và test.

### 21.4 Các phase implement

Thứ tự theo phụ thuộc. Mỗi phase là 1 commit, chỉ commit khi user cho lệnh (mục 8). Trước phase 1, WIP hiện có của user được commit riêng, nguyên trạng, nếu user đồng ý.

**Phase 1: Runner, sửa bug verdict.** File: `skill-packs/codex-review/scripts/codex-runner.js` và test của runner.
- Parse `VERDICT` độc lập với việc nhận dạng format. Output chỉ có verdict vẫn là `format: "review"`, `blocks: []`.
- Nới heading (`##`/`###`, hoa/thường, `VERDICT: X` cùng dòng). Chuẩn hoá status về `APPROVE | REVISE | CONSENSUS | CONTINUE | STALEMATE`.
- Thiếu verdict thì trả lỗi rõ ràng. `finalize` chỉ dùng verdict vòng cuối, không bao giờ lấy của vòng trước.
- Kiểm chứng:
  - test đơn vị với fixture tự tạo cho mọi biến thể đã thấy (mục 10);
  - một script chỉ chạy cục bộ quét khoảng 2.800 output thật trên máy, báo tỉ lệ parse được. **Không commit output thật vào repo**, vì đó là review code riêng của user.
- AC: script quét báo 0 output APPROVE nào bị parse thành `unknown`; 0 phiên finalize lấy verdict cũ.

**Phase 2: Runner, 4 động từ `begin` / `wait` / `reply` / `end`** (mục 10).
- Tách lõi (session, spawn Codex detached, parse, tính `next`) khỏi lớp CLI.
- `begin` nhận `--input <file.md>`, lưu model và effort vào session.
- `wait` trả review đã parse cùng `next` ∈ `respond | done | ask_user | stopped` kèm lý do. Runner tự áp bảng stalemate/verdict và điều kiện recovery.
- `reply` dùng lại model và effort đã lưu. `end` tự chọn finalize hay stop.
- Lệnh cũ giữ lại để debug và tương thích. Runner lên v14.
- Runner tự ghi `.codex-review/.gitignore` chứa `*` (mục 12).
- Kiểm chứng: test đơn vị cho bảng `next`; một vòng review thật ngắn bằng CLI (tốn quota, chỉ 1 lần).

**Phase 3: MCP server** (mục 11).
- **Trước khi code, kiểm từ docs hiện hành, không dùng trí nhớ:**
  - SDK MCP chính thức và phiên bản hiện hành;
  - timeout của một tool call trong Claude Code và Codex;
  - server stdio có chạy ngoài sandbox của Bash tool và spawn được tiến trình detached không;
  - cú pháp đăng ký server ở phạm vi user cho cả hai client.

  Ghi kết quả vào bảng Feasibility evidence ngay trong mục này.
- 4 tool `review_begin` / `review_wait` / `review_reply` / `review_end` gọi cùng lõi của phase 2. `review_wait` có thời hạn, đặt theo timeout đo được.
- Installer cài dependency và tự đăng ký server cho Claude Code và Codex.
- Claude làm reviewer cho Codex điều phối: spike `claude -p` (chạy nền, giữ phiên qua nhiều vòng, chế độ chỉ đọc). Không khả thi thì ghi lại và hoãn.
- Kiểm chứng: một vòng review thật qua MCP ở mỗi client; tắt MCP thì fallback bash vẫn chạy.

**Phase 4: Các review skill** (mục 3, 9, 17, 18).
- SKILL.md tự đủ:
  - installer thay placeholder bằng đoạn protocol từ `shared/` (core, cộng apply-rebut hoặc cross-analysis tuỳ skill);
  - bỏ `references/protocol.md`, kể cả 5 bản chưa track; bỏ bước tự đọc `claude-analysis-template.md`;
  - gộp `question-sharpening.md` vào think-about;
  - bỏ flavor text: xoá `shared/flavor-text.md`, mục "Flavor Text Triggers" trong mọi SKILL.md, bản copy trong `references/`, và bước copy của installer. Thêm `references/flavor-text.md` vào danh sách dọn khi cài, để bản đã cài cũ cũng bị xoá. Chỗ đang nhắc tới flavor text (đã grep): `bin/codex-skill.js`, `shared/protocol.md`, SKILL.md của 5 review skill, và 5 bản `references/protocol.md`. Kiểm chứng: sau khi cài, grep `-i flavor` trong repo và trong thư mục skill đã cài đều rỗng (trừ plan doc này).
- Protocol chỉ còn: dùng MCP tools, không có thì `node $RUNNER begin|wait|reply|end`, và làm theo `next`. Ghi rõ quy tắc model.
- Prompt của codex-plan-review:
  - định nghĩa lại over-engineering;
  - kiểm đề xuất chuẩn ngành (nguồn, spike, phạm vi breaking);
  - chỉ ra chỗ plan đang vá trong khi có chuẩn tốt hơn;
  - phía reviewer của chính sách giới hạn.
- Prompt của codex-impl-review:
  - chỉ review theo plan đã chốt, không đề xuất công nghệ hay kiến trúc khác;
  - finding về thiết kế thì ghi loại `plan-gap`;
  - phía reviewer của chính sách giới hạn.
- Thêm vào danh sách DISPUTE: "yêu cầu giới hạn không có rủi ro tài nguyên cụ thể"; "đề xuất thiết kế khác ở giai đoạn implement".
- Kiểm chứng: render prompt của từng skill sau khi cài, xem có còn placeholder chưa thay không; mỗi skill chạy 1 vòng thật.

**Phase 5: loop-plan.** File: `skills/loop-plan/SKILL.md`, cùng bản Codex.
- Giữ cấu trúc phase hiện tại.
- Thêm các mục cấp plan: `Fixed decisions`, `Feasibility evidence`, `Review checkpoints`, và `Capacity` (chỉ khi có giới hạn). Thêm thời lượng lệnh vào `Baseline`.
- Discovery: thêm bước chuẩn ngành, spike, và quy tắc "giải quyết giả định lúc plan" ở mục 21.3.
- Quality: bỏ hai bước tự review dài; thay bằng tự kiểm ngắn, cộng các luật được chọn ở mục 21.7. APPROVE theo mục 21.3.
- Handoff: 3 điểm dừng theo mẫu mục 19.
- Ràng buộc độ dài: SKILL.md không dài hơn bản hiện tại quá khoảng 40%. Phần dài (chính sách giới hạn, mẫu bản tóm tắt quyết định) phải viết thật gọn.
- Kiểm chứng: xem 21.5.

**Phase 6: loop-implement.** File: `skills/loop-implement/SKILL.md`, cùng bản Codex.
- Áp bảng tinh giản ở mục 15.
- Admission: plan có `Plan Review: APPROVE` (kèm nguồn) và còn phase chưa xong.
- Mỗi phase: test đỏ trước, rồi code, rồi lệnh hẹp, rồi phase gate. Xem staged diff một lần, gồm phạm vi, secret và tàn dư tên cũ. Dòng progress kèm nhật ký lệch được ghi lúc commit.
- Review tại checkpoint bằng `/codex-impl-review`, truyền model theo plan.
- Kỷ luật gate, `not done` trung thực, đề xuất đổi plan theo mục 18, không tự thêm ngoài plan.
- Cuối: full suite một lần, tự audit tích hợp, review checkpoint cuối.
- Mục tiêu: số bước không nhiều hơn bản hiện tại.
- Kiểm chứng: xem 21.5.

**Phase 7: Installer, tài liệu, bản Codex.**
- `bin/codex-skill.js`: cài cả bản Claude và bản Codex của loop skills (`~/.codex/skills`, `$loop-plan`, `AGENTS.md`); gộp placeholder; cài dependency của MCP.
- Runner bỏ code nhận dạng format security/codebase (mục 8), vì skill đã bị gỡ.
- `manifest.json`, `README.md`: cập nhật theo các thay đổi trên.
- `CLAUDE.md` của repo: sửa nguyên tắc "SKILL.md ~40–70 dòng" và "Node stdlib, không dependency" theo quyết định mới.
- Kiểm chứng: cài vào một HOME tạm cho cả hai client. Kiểm có đủ skill, không còn skill đã gỡ, không còn placeholder, và MCP đã đăng ký.

### 21.5 Kiểm chứng tổng

- **Runner và review skill:** như trong từng phase.
- **Loop skills** (phase 5–6) dùng đúng harness của pilot 4–5: 6 task giữ lại, oracle đã khoá, chấm mù M1–M4.
  - So skill mới với `cur` hiện tại: 12 ô, Haiku, cùng prompt. Tốn quota Codex cho chấm và review, nên **chỉ chạy khi user đồng ý**.
  - Tiêu chí **không xấu đi**, vì thay đổi quy trình không hứa nâng chất lượng: số ô dừng không tăng; tỉ lệ lỗi lịch sử và credit không kém `cur` quá độ lệch giữa `cur` và `cur2`; M4 không tăng.
  - Xấu đi thì tìm luật gây ra (thường là luật tạo điểm dừng), sửa, rồi đo lại.
- **Dùng thật:** sau 2–3 tuần, đo lại số vòng review và tỉ lệ nhóm lỗi theo mục 7.

### 21.6 Ngoài phạm vi và rủi ro

- **Ngoài phạm vi:**
  - phân tích dữ liệu ở mục 6;
  - tái cấu trúc plan;
  - Claude làm reviewer, nếu phase 3 cho thấy chưa khả thi;
  - chạy pilot với Opus.
- **Rủi ro:**
  - Mọi pilot dùng Haiku. Với Opus, hiệu ứng của các luật có thể khác.
  - Ba điểm dừng và mẫu bản tóm tắt quyết định làm plan chậm hơn; đó là cái giá user đã chọn để giữ kiểm soát.
  - MCP phụ thuộc hành vi client chưa kiểm. Nếu không đạt thì bash là đường chính.

### 21.7 Kết quả pilot 5 → quyết định cho 3 luật "plan tự kiểm"

Quy tắc đã khoá trước khi chạy:
- **Đạt ngưỡng ở mục 16:** đưa cả 3 luật vào loop-plan (phase 5), đúng văn bản đã thử.
- **Không đạt:** dừng thử nghiệm, chọn theo đánh giá ở dưới, và không chạy pilot nào nữa cho nội dung loop-plan.

**Kết quả (2026-10-15, đủ 12 ô): KHÔNG ĐẠT.**

| Nhánh | Tỉ lệ lỗi lịch sử | credit | Review high | Ô dừng |
|---|---|---|---|---|
| cur (pilot 4) | 0,567 | 0,549 | 9 | 0 |
| cur2 (chạy lại cùng skill; wallet tính sau câu làm rõ) | 0,684 | 0,550 | 12 | 1 |
| check | 0,568 | 0,550 | 12 | 0 |

- `check` tốt hơn `cur2` 0,116 về tỉ lệ lỗi lịch sử. Nhưng hai lần chạy cùng một skill (cur và cur2) đã lệch nhau 0,117. Mức chênh của check vì thế không vượt nhiễu, và check bằng đúng cur.
- credit bằng nhau ở cả ba nhánh.
- Theo từng task, check tốt hơn ở library (0,20 so với 0,80) và xlsx, nhưng kém hơn ở batch. Đây là kiểu dao động quanh nhiễu.
- **Ô dừng:** check 0, cur2 1 (wallet). Plan của hai bên không khác nhau về điều kiện dừng; agent cur2 chọn dừng khi gặp một lỗi có sẵn trong repo. Mới là một ca, chưa đủ làm bằng chứng.

**Quyết định: dừng thử nghiệm nội dung loop-plan, không chạy thêm pilot.**
- **Luật 2** (không đặt điểm dừng cứng dựa trên thứ không kiểm được) **được giữ**, dưới dạng đã hợp nhất vào mục 21.3 ("giải quyết giả định lúc plan"). Lý do không phải chất lượng, mà là chặn tác hại đã đo được ở pilot 4 (3/6 ô dừng). Các thay đổi đã chốt (spike, `UNVERIFIED`, Fixed decisions) dễ sinh ra đúng loại điểm dừng đó.
- **Luật 1** (gate xanh trong phase) và **luật 3** (đối chiếu chéo AC) **không đưa vào**. Không có bằng chứng, và mỗi luật thêm vào làm skill dài thêm.
- Ghi chú: hai lần chạy cùng một skill lệch nhau tới 0,117. Muốn đo được hiệu ứng nhỏ hơn mức này thì cần n lớn hơn nhiều, tốn quota tương ứng.
