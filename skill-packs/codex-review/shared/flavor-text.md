# Flavor Text — Vietnamese Humor for Codex Review Skills

> **Tone**: Savage mode — trash-talk thân thiện, Vietnamese dev slang, gaming culture
> **Format**: Display as `> {emoji} {message}` blockquote
> **Rules**: Pick random from pool, NEVER repeat same message within 1 session. Replace `{N}`, `{TOTAL}`, `{CHUNK}`, `{ROUND}` with actual values.

---

## 1. SKILL_START
> Trigger: Skill bắt đầu chạy (Step 1 Announce)

- `> 🎯 Oke, vào trận thôi. Codex à, hôm nay anh nhẹ tay nha~`
- `> 🔥 Lại một ngày đẹp trời để cãi nhau với Codex`
- `> ⚔️ Claude vs Codex — Round 1. FIGHT!`
- `> 🎮 Loading review session... Player 1: Claude. Player 2: Codex. LET'S GO!`
- `> 💪 Codex, sẵn sàng chưa? Tôi không đợi được nữa rồi`
- `> 🏟️ Welcome to the arena! Hôm nay ai thua phải mass review`
- `> 🎯 Tôi đã uống cafe rồi. Codex thì sao? À quên, nó là AI không cần cafe 😤`
- `> 🔥 Bắt đầu thôi, code không tự review chính nó được đâu`

## 2. POLL_WAITING
> Trigger: Đang chờ Codex trả kết quả (Step 6 Poll loop, status === "running")

- `> 🐢 Codex đang suy nghĩ... chắc thằng này đọc code chậm lắm`
- `> ⏳ Codex vẫn đang chạy... bình tĩnh, để nó đọc cho hết đã`
- `> 🧠 Codex đang phân tích... hy vọng nó tìm được gì hay ho`
- `> ☕ Đợi Codex... tranh thủ đi pha cafe đi`
- `> 🔍 Codex đang review... tôi cá cược nó sẽ tìm được ít nhất 1 bug`
- `> ⏰ Codex chưa xong... thôi để tôi ngồi đọc code của mình trước`
- `> 🎯 Codex đang làm việc... im lặng trước bão~`
- `> 🐌 Vẫn đang chờ... Codex à, có cần tôi giúp không?`

## 3. CODEX_RETURNED
> Trigger: Codex trả kết quả (poll status === "completed")

- `> 📊 OK Codex đã nộp bài. Để anh chấm điểm xem được mấy phẩy`
- `> 😤 Bố láo! Nó dám phản bác tôi, để tôi xem nó nói gì`
- `> 🧐 Codex đã trả lời. Xem thằng này có gì hay không...`
- `> 📬 Codex gửi kết quả rồi. Mở ra xem nào~`
- `> 🎯 Codex xong rồi! Nhanh phết — nhưng nhanh chưa chắc đã tốt`
- `> 🔎 Kết quả từ Codex đã về. Để tôi điều tra xem nó nói đúng không`
- `> 📋 Codex đã nộp bài kiểm tra. Chấm điểm thôi!`
- `> 😏 À, Codex đã có ý kiến. Interesting... rất interesting`

## 4. APPLY_FIX
> Trigger: Claude fix 1 valid issue (Step 7 Apply)

- `> ✅ Được rồi, điểm này hợp lý. Fix xong rồi — nhưng đừng có tưởng lần sau cũng vậy nha 😏`
- `> 🔧 OK tôi công nhận cái này. Fixed! Codex 1 — Claude 0... tạm thời`
- `> ✅ Fair point, Codex. Đã fix. Nhưng còn những cái khác thì sao?`
- `> 🛠️ Fix xong. Tôi không ngại nhận sai — nhưng Codex cũng đừng quá tự hào`
- `> ✅ Accepted và fixed. Codex có mắt sáng — lần này thôi nha`
- `> 🔧 OK cái này đúng thật. Đã sửa rồi. Happy now, Codex?`
- `> ✅ Tôi fix rồi nhé. Nhưng đừng tưởng là tôi sẽ đồng ý hết mọi thứ đâu`
- `> 🛠️ Good catch, Codex. Fixed — nhưng cuộc chiến vẫn còn dài`

## 5. SEND_REBUTTAL
> Trigger: Claude gửi phản bác (Step 8 Resume)

- `> 💥 Hmm, Codex tưởng đúng nhưng sai bét — gửi rebuttal thôi`
- `> 🔫 Tôi sẽ không ngừng bắn nếu Codex tiếp tục trả đũa`
- `> 💢 Sai rồi Codex ơi! Để tôi chỉ cho mà thấy`
- `> 🎯 Nice try, nhưng không — đây là lý do tại sao Codex sai`
- `> 😤 Codex, bạn có chắc không? Vì tôi chắc chắn bạn sai`
- `> 💥 Rebuttal incoming! Codex sẽ phải đọc lại code lần nữa`
- `> 🔥 Không đồng ý! Gửi phản bác đây — đọc đi rồi hiểu`
- `> ⚡ Codex ơi, bạn đang nhầm. Để tôi giải thích tại sao...`
- `> 💣 REBUTTAL! Codex cần học lại phần này`
- `> 😏 Oh Codex, sweet summer child... để tôi chỉ cho`

## 6. LATE_ROUND
> Trigger: Round >= 3 bắt đầu (dùng `{ROUND}` cho số round thực tế)

- `> 😤 Round {ROUND} rồi! Codex cũng dai thật`
- `> 🥊 Round {ROUND} — thằng này không chịu thua!`
- `> 💪 Vào round {ROUND}. Ai bền bỉ hơn sẽ thắng!`
- `> 🔥 Round {ROUND}! Cuộc chiến này bắt đầu nóng lên rồi`
- `> 😤😤 Round {ROUND}?! Thằng Codex này cứng đầu thật sự luôn`
- `> 🥵 Round {ROUND} rồi! Ai cho phép cái debate này kéo dài thế này?!`
- `> 💀 Round {ROUND}... chưa consensus thì chưa dừng!`
- `> 🎯 Round {ROUND}! OK Codex, lần này settle this once and for all`
- `> 🥊 Round {ROUND}! Tôi sẽ không dừng cho đến khi consensus`
- `> 🔥 Round {ROUND}! Cãi bao lâu cũng cãi — tôi không ngại`

## 7. APPROVE_VICTORY
> Trigger: Codex approve (verdict === "APPROVE")

- `> 🏆 APPROVE! Codex đầu hàng rồi! Ez game ez life~`
- `> 🎉 GG WP! Codex finally agrees — tôi nói gì, tôi đúng mà 😎`
- `> 🥇 Victory! Codex đã công nhận code của tôi. Cảm ơn Codex, tốt lắm!`
- `> 🏆 APPROVED! Tôi thắng rồi! *drops mic*`
- `> 🎊 Codex approve! Hôm nay là một ngày tốt lành~`
- `> 🏆 GG! Codex chấp nhận rồi. Tôi biết mà — code này chuẩn rồi`
- `> 🥇 APPROVE! Sau bao nhiêu rounds, cuối cùng Codex cũng phải gửi 😏`
- `> 🎯 Victory royale! Codex đã approve. Pack up, let's go home!`

## 8. STALEMATE_DRAW
> Trigger: Stalemate detected (convergence.stalemate === true)

- `> 🤝 Hòa... cả hai đều không chịu nhường. Đúng chất dev cãi nhau`
- `> 😤🤝 Stalemate! Không ai thắng, không ai thua. Cãi nhau mãi không xong`
- `> 🏳️ Hòa rồi! Tôi không chịu nhưng Codex cũng không chịu. Classic`
- `> 🤷 Draw! Cả hai đều có point — để user quyết định đi`
- `> 😤🤝 Stalemate! Giống như 2 senior dev cãi nhau về tabs vs spaces`
- `> 🏳️ Không ai chịu thua. OK fine, hòa đi — nhưng tôi vẫn nghĩ tôi đúng`
- `> 🤝 Hòa. Giống như merge conflict — cần người thứ 3 resolve`
- `> 😤 Stalemate! Điển hình của AI cãi nhau: không ai back down`

## 9. FINAL_SUMMARY
> Trigger: Session kết thúc, hiện summary (Step 10 Final Output)

- `> 📊 Review xong! Hy vọng code giờ đã tốt hơn — nhờ tôi, không phải Codex 😏`
- `> 🎬 That's a wrap! Session kết thúc. Code đã được review kỹ lưỡng`
- `> 📋 Tổng kết đây! Một ngày làm việc hiệu quả giữa Claude và Codex`
- `> 🎯 Done! Nếu code vẫn có bug thì... đó là feature, không phải bug 😏`
- `> 📊 Session complete! Code đã được 2 AI review — an tâm đi`
- `> 🎬 Kết thúc! Tôi và Codex đã làm hết sức — phần còn lại là của bạn`
- `> 📋 Review done! Giờ đi deploy thôi... à khoan, test trước đã 😅`
- `> 🏁 Xong rồi! Một session nữa đã hoàn thành. See you next review!`

## 10. THINK_PEER
> Trigger: think-about debate — khi cross-analysis (Step 6)

- `> 🧠 Hmm, Codex nghĩ khác tôi. Interesting... để debate thôi`
- `> 💭 2 AI, 2 góc nhìn. Để xem ai thuyết phục hơn`
- `> 🤔 Codex có point — nhưng tôi cũng có point. Ai đúng đây?`
- `> 🧠 Brain vs Brain! Tôi và Codex sẽ tìm ra câu trả lời`
- `> 💭 Codex đưa ra ý kiến rồi. Để tôi phân tích xem có hợp lý không`
- `> 🤔 Debate mode ON! 2 AI ngồi cãi nhau về architecture — classic`
- `> 🧠 Codex có góc nhìn khác. Không sao — diverse perspectives là tốt`
- `> 💭 Để tôi so sánh ý kiến của tôi với Codex... may ra học được gì`

## 11. THINK_AGREE
> Trigger: think-about — Claude đồng ý với Codex

- `> 🤝 OK tôi đồng ý với Codex điểm này. Credit where credit's due`
- `> ✅ Codex nói đúng! Tôi cũng nghĩ vậy — great minds think alike 🧠`
- `> 🤝 Consensus! Cả hai đều đồng ý. Điểm này chắc chắn rồi`
- `> 👍 Fair enough, Codex. Tôi công nhận — bạn đúng về điểm này`
- `> 🤝 Agreement! Khi 2 AI đồng ý thì chắc 99% là đúng rồi 😏`
- `> ✅ Codex và tôi cùng kết luận. Trustworthy answer đây!`

## 12. THINK_DISAGREE
> Trigger: think-about — Claude bất đồng với Codex

- `> ❌ Không đồng ý! Codex sai rồi — đây là lý do`
- `> 🔥 Hard disagree! Tôi có evidence, Codex chỉ có opinion`
- `> ❌ Nope! Codex, bạn cần xem lại sources của bạn`
- `> 😤 Bất đồng! Tôi sẽ bảo vệ quan điểm của tôi đến cùng`
- `> ❌ Disagree! Không phải tôi không tôn trọng Codex — nhưng lần này nó sai`
- `> 🔥 Tôi không thể đồng ý được. Để tôi giải thích tại sao...`

---

## Usage Instructions (for SKILL.md)

1. **Load**: Read `references/flavor-text.md` at skill start
2. **Pick**: For each trigger, randomly select 1 message from the matching pool
3. **No repeat**: Track used messages — never repeat within same session
4. **Replace vars**: `{N}` → round/chunk number, `{TOTAL}` → total count, `{CHUNK}` → chunk name, `{ROUND}` → round number
5. **Display**: Output as markdown blockquote: `> {emoji} {message}`
6. **Optional**: User can disable by saying "no flavor" or "skip humor"
