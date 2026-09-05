# Kịch bản demo bảo vệ + video dự phòng

Nguồn lệnh: `README.md` (Getting Started), `docs/OPERATIONS.md` (runbook),
`apps/leak-inspector-tui/README.md` (sử dụng trong monorepo), `docs/DEFENSE-PLAN.md`
§Giai đoạn 4 item 2. Số liệu kết quả chỉ trích từ `docs/RESULTS-FREEZE.md`
(bảng freeze, các dòng 1, 4, 5, 10). Mọi lệnh đánh dấu `[VERIFY TRƯỚC KHI DEMO]`
chưa có trong tài liệu repo, phải chạy thử trước.

Tổng thời lượng mục tiêu: 7-10 phút. Máy demo: máy local (macOS) của học viên.
Provider LLM thật của học viên: profile `deepseek-direct` (openai-compat,
`https://api.deepseek.com`, model `deepseek-v4-flash`). Model này cũng là model
của các run chốt trong bảng freeze, nên câu nói dẫn được nối tự nhiên.

Chú ý môi trường máy demo: node nằm trong nvm, terminal mới cần nạp nvm trước
mọi lệnh `cleak`/`tsx`:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
```

(Đã kiểm chứng 2026-09-05: không nạp nvm thì `cleak` báo
`env: node: No such file or directory`.)

---

## Phần A. Kịch bản demo live (7-10 phút)

### Bước 1. Mở đầu: vấn đề + hệ thống chạy thật (30 giây)

**Câu nói dẫn.** "Rò rỉ bộ nhớ trong C/C++ không gây crash, static analyzer
báo nhiều dương tính giả, dynamic tool chỉ thấy đường thực thi
thực sự chạy. Hệ thống
của tôi để LLM điều phối cả hai phía qua MCP và viết ra verdict kèm nguyên nhân
và cách sửa. Ngay bây giờ tôi sẽ chạy nó thật trên một repository."

**Khởi động hai analyzer (hai lựa chọn, chọn một):**

Lựa chọn Docker (khuyên dùng, nguồn `docs/OPERATIONS.md` §1):

```bash
docker compose up --build -d
```

Lựa chọn native (nguồn `apps/leak-inspector-tui/README.md`, mục "Sử dụng trong
monorepo"), hai terminal:

```bash
(cd apps/static-analyzer  && MCP_HTTP_PORT=50061 pnpm run dev)
(cd apps/dynamic-analyzer && MCP_HTTP_PORT=50062 pnpm run dev)
```

**Quan trọng cho ngày bảo vệ:** build Docker lần đầu mất nhiều phút. Buộc phải
`docker compose up --build -d` trước giờ (ngày trước hoặc giờ nghỉ giữa các
báo cáo), lúc lên diễn đàn chỉ còn bước kiểm tra sống.

**Kiểm tra analyzer sống** (nguồn `docs/OPERATIONS.md` §1):

```bash
curl -s -m 3 -X POST http://127.0.0.1:50061/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 120
```

**Expected output.** Chuỗi JSON bắt đầu bằng
`{"jsonrpc":"2.0","id":1,"result":{"tools":[...` — nghĩa là static analyzer
đang phục vụ MCP trên cổng 50061. Lặp tương tự với 50062 nếu muốn chắc cả hai.

**Nếu lỗi thì nói gì.** "Cổng bị chiếm hoặc container chưa xong, tôi sẽ khởi
động lại stack trong lúc trình bày slide tiếp theo" (backup: đã có video quay
sẵn, xem Phần B).

### Bước 2. Cấu hình (1 phút)

**Câu nói dẫn.** "Cấu hình nằm trong một file JSON duy nhất. Tôi xem cấu hình
đang hiệu lực:"

**Lệnh** (nguồn `docs/OPERATIONS.md` §2a, `apps/leak-inspector-tui/README.md`
mục "Cấu hình qua config file"):

```bash
cleak config get          # (che apiKey: CLI tự mask thành •••••• theo mặc định)
```

**Expected output** (đã kiểm chứng trên máy demo 2026-09-05):

```json
{
  "staticUrl": "http://localhost:50061/mcp",
  "dynamicUrl": "http://localhost:50062/mcp",
  "provider": "deepseek-direct",
  "llm": {
    "provider": "openai-compat",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "••••••",
    "model": "deepseek-v4-flash",
    ...
```

**Điểm cần nói ra trong 3 câu:**
1. Hai endpoint analyzer trỏ đúng cổng MCP của Docker stack (50061, 50062).
2. Provider là một named profile `deepseek-direct` dạng `openai-compat`, chuyển
   vendor chỉ bằng một lệnh `cleak config set provider <tên>` mà không mất
   profile cũ.
3. `apiKey` được mask mặc định khi in ra; file config có `chmod 600`.

**Tuyệt đối không làm trước máy chiếu:** chạy `cleak config get --show-secrets`,
mở file `~/.config/cleak/config.json`, hay `cat` file `.env` nào. (Nguồn cờ
`--show-secrets`: `apps/leak-inspector-tui/README.md`.)

**Nếu lỗi thì nói gì.** "File cấu hình thiếu thì `cleak config init` tạo mẫu
đủ khoá, tôi sẽ bỏ qua phần này để giữ thời gian."

### Bước 3. Scan live (4-5 phút) — trọng tâm demo

**Câu nói dẫn.** "Tôi quét một repository nhỏ có sẵn trong repo, đúng đường
dẫn mà CI dùng cho smoke test: `make_buffer()` cấp phát bộ nhớ, `main()` gọi
nó rồi thoát mà không free. Hãy để ý TUI: mọi lời gọi công cụ của LLM hiện
thời gian thực."

**Kiểm tra kết nối MCP trước khi scan** (nguồn `apps/leak-inspector-tui/README.md`):

```bash
pnpm exec tsx src/cli.ts tools
```

(chạy trong `apps/leak-inspector-tui/`). Expected: danh sách tool của hai
analyzer, không có thông báo unreachable.

**Cách chạy chính: TUI tương tác** (nguồn `apps/leak-inspector-tui/README.md`,
`docs/OPERATIONS.md` §2a):

```bash
pnpm exec tsx src/cli.ts tui
# trong TUI:
/scan apps/leak-inspector-tui/tests/fixtures/simple-leak
/mode llm_assisted
/dynamic off
```

Chọn `/dynamic off` để giữ thời lượng: chứng cứ động (build + LSan) cần
container và dễ phát sinh thời gian; tầng dynamic đã được đánh giá đầy đủ trong
các run chốt, không cần chứng minh lại bằng live. Nếu còn dư thời gian sau khi
xem report, có thể quay lại TUI chạy `/dynamic selective` để thấy thêm chân
sanitizer.

**Cách chạy dự phòng: headless** (nguồn `docs/OPERATIONS.md` §2b,
`apps/leak-inspector-tui/README.md`):

```bash
pnpm exec tsx src/cli.ts scan --repo apps/leak-inspector-tui/tests/fixtures/simple-leak --mode llm_assisted
```

(Chạy trong `apps/leak-inspector-tui/`. Dùng cách này nếu TUI render lỗi trên
máy chiếu; đầu ra vẫn ghi `results/<scanId>/` như TUI.)

**Fixture.** Đã kiểm chứng tồn tại 2026-09-05:
`apps/leak-inspector-tui/tests/fixtures/simple-leak/` gồm `main.c` (leak thật,
21 dòng), `Makefile` (clang, có target `asan`), `README.md`. README của fixture
ghi rõ đây là smoke fixture, không phải tập đánh giá. Nếu hội đồng hỏi về độ
tin cậy: "đây là ca đơn giản để xem cơ chế chạy live; toàn bộ kết quả định
lượng trên corpus chuẩn nằm ở phần slide sau."

**Fallback nếu fixture thiếu trên máy** `[VERIFY TRƯỚC KHI DEMO]` (lệnh tạo
file không có trong tài liệu repo, chỉ dùng khi lỡ máy sạch):

```bash
mkdir -p /tmp/demo-leak && cat > /tmp/demo-leak/main.c <<'EOF'
#include <stdlib.h>
int main(void) {
    char *buf = malloc(64);
    (void)buf;
    return 0;   /* buf chưa được free: leak */
}
EOF
```

rồi scan `--repo /tmp/demo-leak`. Kỳ vọng đầu ra tương tự fixture.

**Narrative theo từng tầng, đọc khi TUI đang chạy** (nguồn thứ tự pha:
`apps/leak-inspector-tui/README.md` mục "Điều phối HYBRID",
`docs/ARCHITECTURE.md` §1):

1. **Discovery (tất định).** `indexFiles` + `candidateScan` quét cây source,
   bắt mọi điểm gọi `malloc`/`calloc`/`realloc`/`strdup`/`new`. Trên màn hình:
   thẻ tool đầu tiên hiện tên `indexFiles`, rồi `candidateScan`.
2. **Static fan-out / enrichment (tất định).** Các tool tĩnh chạy song song:
   `astScan`, `functionSummary`, `pathConstraints`, `ownershipConventions`.
   Câu nói: "mỗi ứng viên giờ được gắn bằng chứng sở hữu và đường rò rỉ khả
   thi, không phải một dòng cảnh báo trơ."
3. **Investigation (agentic, chỉ khi `llm_assisted`).** Vòng native
   tool-calling: LLM tự quyết định gọi tool nào tiếp theo, đọc file, ghi
   `record_verdict`. Câu nói: "đây là phần LLM thật sự agentic; các pha trước
   và sau đều tất định, nên kết quả có thể tái lập."
4. **Judging (hybrid).** Heuristic chốt mọi bundle, LLM judge chỉ vào các ca
   borderline. Câu nói: "LLM không tự tiện lật verdict; ranh giới quyết định
   nằm trong engine."
5. **Reporting.** Ghi bốn định dạng vào `results/<scanId>/`.

**Expected output.** TUI hiện timeline các pha, thẻ tool với trạng thái chạy
xong, spinner khi chờ LLM, overlay xin phép khi agent cần chạy pha nhạy cảm
(nguồn mô tả UI: `apps/leak-inspector-tui/README.md` mục kiến trúc, "UI Ink:
timeline, tool card, spinner, overlay xin phép"). Kết thúc scan, TUI tóm tắt
scanId và vị trí report. Trên ca fixture này, kỳ vọng ít nhất một finding
leak tại điểm `malloc` trong `make_buffer` với verdict chỉ ra `main` không
free (leak thật, đã xác minh bằng mắt trong `main.c`).

**Nếu lỗi thì nói gì.** LLM chậm hoặc đứt kết nối: "endpoint cloud của tôi có
khiếm khuyết mạng lúc này, bản ghi hình đã quay trước cho đúng ca này" rồi
chuyển video (điều kiện kích hoạt xem Phần B). Scan xong nhưng verdict khác
kỳ vọng: "mode llm_assisted có dao động tự nhiên, tôi sẽ chỉ ý nghĩa của dao
động đó ở phần đánh giá", không cố sửa tại chỗ.

### Bước 4. Report artifacts (1-2 phút)

**Câu nói dẫn.** "Mỗi scan là một thư mục artifact, tái lập được và kiểm
toán được."

**Lệnh** (shell cơ bản; tên file lấy từ `apps/leak-inspector-tui/README.md`
mục "Output"):

```bash
ls results/<scanId>/
cat results/<scanId>/report.md | head -40
```

Expected: thư mục chứa đủ `report.json`, `report.md`, `report.html`,
`snapshot.json`, `events.jsonl`, `transcript.json`. Trong TUI có thể thay bằng
lệnh `/report [scanId]` (nguồn `docs/OPERATIONS.md` §2a).

**Điểm cần chỉ tay vào khi đọc report.md:**
1. Verdict kèm nguyên nhân gốc (đường từ `malloc` đến exit không qua free).
2. Đề xuất sửa cụ thể (thêm `free(buf)`), không chỉ là một cảnh báo.
3. `transcript.json` chứa toàn bộ lịch sử message của agent, phục vụ audit.

**Nếu lỗi thì nói gì.** "Thư mục results bị git-ignored nên scan cũ có thể đã
được dọn; tôi sẽ chạy lại nhanh trong 2 phút" (hoặc mở report từ video).

### Bước 5. Tổng kết (30 giây, nối về slide)

**Câu nói dẫn.** "Ca vừa rồi là một ca đơn giản để thấy cơ chế. Câu hỏi thật
là cơ chế đó chấm điểm ra sao trên corpus chuẩn. Ba con số từ bộ kết quả đã
đóng băng của luận văn:" (tất cả lấy từ `docs/RESULTS-FREEZE.md`, không demo
lại sweep nào, sweep quá dài, chỉ chiếu slide)

1. Juliet full-corpus 1658 ca: cấu hình B6a đạt F1 0.863 ± 0.001, MCC 0.790,
   chi phí 6.63 USD; cấu hình agentic B7 tốn 27.14 USD, khoảng 4 lần, cho F1
   thấp hơn (dòng 1).
2. Dự án thực: LAMeD bắt 15/50 site, recall 30.0%, FP bằng 0, std bằng 0 qua
   3 lần chạy, trong khi Clang Static Analyzer trên cùng corpus bắt 0/43 site;
   MemHint 19 ca đạt recall 46.2% với FP bằng 0 (dòng 4 và 10).
3. Kết quả đảo chiều về consensus: trên n=50 stratified, judge đơn lẻ dao động
   2.0% với F1 0.852, consensus k=3 dao động 8.0% với F1 0.793, McNemar
   p=0.077, vì vậy consensus không được khuyến nghị làm mặc định (dòng 5).

**Kết câu.** "Phát hiện thứ ba là một kết quả phương pháp luận về hiệu ứng
lấy mẫu mà các nghiên cứu LLM-judge trước đó bỏ qua, và tôi sẽ phân tích nó ở
slide tiếp theo."

**Nếu lỗi thì nói gì.** Không cần, bước này không chạy lệnh.

### Tổng thời lượng dự kiến

| Bước | Nội dung | Thời lượng |
|---|---|---|
| 1 | Mở đầu + kiểm tra analyzer | 30 giây |
| 2 | Cấu hình | 1 phút |
| 3 | Scan live (TUI, 5 tầng narrative) | 4-5 phút |
| 4 | Report artifacts | 1-2 phút |
| 5 | Tổng kết 3 con số | 30 giây |
| | **Tổng** | **7-9 phút** |

---

## Phần B. Video dự phòng checklist

### B.1. Recording setup

- **OBS Studio**, canvas và output 1920x1080, 30 fps, nguồn: Window Capture
  hoặc Display Capture của terminal.
- **Terminal:** tăng cỡ chữ lên ít nhất 18-20pt, theme tối tương phản cao,
  tắt hiệu ứng trong suốt. Cửa sổ terminal riêng, chỉ mở đúng tab làm việc.
- **Chống lộ apiKey (bắt buộc kiểm từng khung hình trước khi xuất):**
  - Chỉ dùng `cleak config get` (tự mask `••••••`, đã kiểm chứng), không bao
    giờ chạy `cleak config get --show-secrets` khi đang quay.
  - Không mở `~/.config/cleak/config.json`, không `cat .env`, không mở lịch
    sử shell (Ctrl+R) có thể chứa key đã gõ.
  - Tắt autocomplete/history hiển thị trên màn hình, dọn bookmarks và tab
    trình duyệt nếu quay toàn màn hình.
- **Thông báo hệ điều hành:** bật Do Not Disturb, đóng Slack/Email/Messenger.
- **Âm thanh:** hai lựa chọn, hoặc nói lời thoại trực tiếp khi quay (mic cài
  áo, phòng yên tĩnh), hoặc quay màn hình im lặng rồi ghi voiceover sau. Nói
  trực tiếp tự nhiên hơn, khuyến nghị.
- **Quay dự phòng cùng lúc:** dựng điện thoại quay màn hình laptop (chỉ cần
  đọc được chữ) để có backup nếu file OBS hỏng.

### B.2. Shot list (khớp từng bước Phần A)

| Shot | Khớp bước | Nội dung | Thời lượng | Điểm dừng cắt ghép |
|---|---|---|---|---|
| 1 | A1 | Terminal chạy `docker compose up --build -d` (hoặc đã chạy sẵn), rồi `curl` kiểm tra 50061 hiện JSON tools | ~40 giây | Cắt sau khi JSON hiện rõ |
| 2 | A2 | `cleak config get`, chỉ tay mask `••••••`, nói 3 điểm provider/endpoint/model | ~60 giây | Cắt sau câu "chmod 600" |
| 3 | A3a | `cleak config set`-free, chạy `pnpm exec tsx src/cli.ts tools` hiện danh sách tool | ~30 giây | Cắt khi danh sách ổn định |
| 4 | A3b | Mở TUI, `/scan` fixture, `/mode llm_assisted`, `/dynamic off`; quay trọn 5 tầng narrative, đọc lời thoại theo pha | 4-5 phút | Cắt sau khi TUI tóm tắt scanId; nếu quá dài, cắt bớt phần spinner giữ nguyên mỗi thẻ tool đầu tiên |
| 5 | A4 | `ls results/<scanId>/`, `cat report.md`, chỉ tay vào verdict + fix; nhắc `transcript.json` | ~90 giây | Cắt sau câu audit |
| 6 | A5 | Đóng màn terminal, chuyển sang slide 3 con số freeze (có thể thu ở phần slide) | ~30 giây | Ghép trực tiếp vào slide deck |

Tổng sau cắt: 7-9 phút. Nếu một shot lỗi, quay lại đúng shot đó, cắt ghép sau.

### B.3. Fallback trigger conditions (khi nào dùng video thay live)

Chuyển hẳn sang video nếu xảy ra bất kỳ điều nào dưới đây trong buổi duyệt máy
hoặc chờ giờ bảo vệ:

1. **Mạng LLM không ổn định:** `api.deepseek.com` không phản hồi, timeout lặp
   lại, hoặc tài khoản hết quota ngày hôm đó. Kiểm tra nhanh trước giờ:
   chạy shot 3 và 4, nếu một lần gọi LLM nào timeout thì kích hoạt video.
2. **Analyzer không start:** `docker compose up` lỗi (build fail, port bận do
   tiến trình khác chiếm 50061/50062), hoặc `curl` kiểm tra sống không trả
   JSON sau một lần khởi động lại.
3. **Timeout case:** live scan chưa xong trong 5 phút (gấp đôi thời gian luyện).
4. **Máy/máy chiếu:** thiếu node/pnpm, Docker Desktop không chạy, TUI render
   lỗi ký tự trên máy chiếu, không cài được môi trường trong thời gian cho phép.

Nguyên tắc quyết định: cố gắng live tối đa một lần cho shot 3-4; nếu thất bại
một lần, chuyển video ngay và nói "bản ghi hình đã quay trước cho đúng ca này",
sau đó dùng thời gian dư để nói sâu hơn về 3 con số freeze.

### B.4. Quy trình pre-record (trước ngày bảo vệ 1 ngày)

1. **Chạy thử full kịch bản Phần A trên chính máy sẽ dùng** (nguồn khuyến
   nghị: `docs/DEFENSE-PLAN.md` mục Verification giai đoạn 4, "chạy thử demo
   trên máy sạch hoặc container trước ngày bảo vệ"). Đo thời gian từng bước,
   ghi lại scanId thật.
2. **Quay đủ shot list B.2** trong một buổi, cùng cấu hình máy với ngày thật.
3. **Verify file trước khi rời phòng:**
   - Phát lại toàn bộ, không tua: hình rõ chữ, không khung hình nào lộ key,
     âm thanh nghe được.
   - Thời lượng tổng 7-10 phút sau cắt.
   - Đặt tên có ngày: `cleak-defense-demo-YYYY-MM-DD.mp4`.
4. **Copy 2 nơi tối thiểu:** USB cầm theo người + cloud drive (hoặc laptop
   thứ hai). Kiểm tra file mở được từ nơi copy, không chỉ copy xong là xong.
5. **Checklist ngày bảo vệ:** video có sẵn ở cả hai nơi, máy dự phòng (hoặc
   cùng máy) có repo + config + nvm, kịch bản in sẵn hoặc mở được offline.

### B.5. Ghi chú máy dự phòng / môi trường khác

- Máy demo chính là máy local macOS của học viên. Nếu buộc phải chạy trên
  wsl2: gateway LLM local (`llm-gateway`) nằm trên wsl2 còn profile cloud
  `deepseek-direct` thì cần mạng ra ngoài, node trên wsl2 nằm trong nvm của
  root và không có PATH khi SSH không tương tác, phải chạy qua tmux
  `bash -ilc`. Ưu tiên máy local, wsl2 chỉ là phương án cuối.
- Video là lưới an toàn cuối cùng: nó không cần mạng, không cần Docker, không
  cần node, chỉ cần máy chiếu đọc được mp4.
