# Explanation-quality rubric: chấm 20 case xuất từ B6a đông cứng (I6)

> **Trạng thái: PREPARED, CHƯA CHẠY.** Bộ khung chấm điểm cho chất lượng
> explanation + repair diff do LLM judge sinh ra. Người chấm: tác giả luận văn
> (hoặc hai người chấm độc lập nếu muốn đo agreement). Dữ liệu đầu vào đã export
> sẵn: [`paper/figures/explanations-sample.csv`](../paper/figures/explanations-sample.csv).

## 1. Nguồn dữ liệu và luật chọn mẫu

- Nguồn: `paper/figures/explanations-sample.csv`, sinh bởi
  `pnpm exec tsx scripts/export-explanations.ts` (đọc-only) từ sweep đông cứng
  `results/baseline-sweep-2026-08-15T08-28-06/B6a/run-1/cases/` (20 case đầu
  theo thứ tự sort, 93 finding row).
- **Mẫu chấm: 20 row đầu tiên của CSV** (thứ tự file, tất định, tái lập được).
  Đây là các finding của 5 case `char_calloc_01..05`, gồm cả `confirmed_leak`
  (hàm `..._bad`) lẫn `likely_false_positive` (các biến thể good). Một row =
  một site được đánh giá, đúng đơn vị của rubric.
- Không chọn mẫu thủ công, không hoán đổi row sau khi đã chấm.

## 2. Thang điểm

Mỗi row nhận 2 điểm thành phần, tổng 0-4:

### 2.1. Root-cause correctness (0-2)

Explanation có đúng nguyên nhân rò rỉ/không rò rỉ của site không.

| Điểm | Tiêu chí |
|---|---|
| **2** | Explanation nêu đúng biến, đúng dòng cấp phát, và đúng cơ chế (thiếu free trên đường thoát cụ thể, hoặc nêu đúng vị trí free cho site sạch). Khớp với code thật trong case dir. |
| **1** | Đúng hướng nhưng mơ hồ: nói "chưa được giải phóng" mà không chỉ đường thoát/biến cụ thể, hoặc nêu đúng biến nhưng sai cơ chế phụ. |
| **0** | Sai nguyên nhân: quy cho sai biến, khẳng định "đã free" trong khi không, "chưa free" trong khi đã free ở mọi đường thoát, hoặc giải thích thuần template không khớp code. |

### 2.2. Fix-diff applicability (0-2)

`repair_diff` (nếu có) có áp dụng được không, xét trên ba trục: đúng biến, đúng
vị trí, đầy đủ đường thoát.

| Điểm | Tiêu chí |
|---|---|
| **2** | Diff chèn/trả `free()` (hoặc `delete[]`) đúng biến, tại vị trí biên dịch được, phủ mọi đường thoát mà explanation nêu; không double-free với free có sẵn. |
| **1** | Fix đúng bản chất nhưng đặt sai vị trí, hoặc thiếu một đường thoát (early-return), hoặc chỉ sửa một phần biến. |
| **0** | Thiếu diff, diff sai biến, diff trùng free gây double-free, hoặc diff không biên dịch được. |

### 2.3. Quy tắc biên

- Row `likely_false_positive`: giải thích đúng phải **chỉ ra câu lệnh free thật**
  và đường đi khiến site sạch. Miễn trừ kiểu "nhìn như an toàn" mà không nêu cơ
  chế: root-cause tối đa 1 điểm.
- Row mà explanation và repair_diff mâu thuẫn nhau: lấy điểm thấp hơn của hai
  trục, ghi chú vào cột Ghi chú.
- Explanation trích số dòng lệch quá ±2 dòng so với file thật (do chèn/xóa khi
  export): trừ 1 điểm root-cause.
- Không đọc thêm ngữ cảnh ngoài case dir khi chấm (chấm trên đúng bằng chứng
  hệ thống đã có: cột explanation, repair_suggestion, repair_diff, verdict).

## 3. Bảng chấm (điền vào cột trống)

Điền `rc` (0-2), `fx` (0-2), `total` (0-4), `note`. `siteId` đã rút gọn 12 ký
tự đầu; đủ 40 ký tự nằm trong CSV cột `siteId`, row khớp theo số thứ tự.

| # | caseId | siteId (12 ký tự đầu) | function | line | verdict | rc | fx | total | note |
|--:|---|---|---|--:|---|---|---|---|---|
| 1 | CWE401_Memory_Leak__char_calloc_01 | bundle_be6f7e454683 | ..._01_bad | 29 | confirmed_leak | | | | |
| 2 | CWE401_Memory_Leak__char_calloc_01 | bundle_f21ab4c73691 | goodG2B | 48 | likely_false_positive | | | | |
| 3 | CWE401_Memory_Leak__char_calloc_01 | bundle_57e9d611d085 | goodB2G | 62 | likely_false_positive | | | | |
| 4 | CWE401_Memory_Leak__char_calloc_02 | bundle_8ac004de47a5 | ..._02_bad | 31 | confirmed_leak | | | | |
| 5 | CWE401_Memory_Leak__char_calloc_02 | bundle_64b85c92ec25 | goodB2G1 | 56 | likely_false_positive | | | | |
| 6 | CWE401_Memory_Leak__char_calloc_02 | bundle_405200be9784 | goodB2G2 | 82 | likely_false_positive | | | | |
| 7 | CWE401_Memory_Leak__char_calloc_02 | bundle_50b725a959a1 | goodG2B1 | 108 | likely_false_positive | | | | |
| 8 | CWE401_Memory_Leak__char_calloc_02 | bundle_a3a801839317 | goodG2B2 | 128 | likely_false_positive | | | | |
| 9 | CWE401_Memory_Leak__char_calloc_03 | bundle_476e9aeb9930 | ..._03_bad | 31 | confirmed_leak | | | | |
| 10 | CWE401_Memory_Leak__char_calloc_03 | bundle_c524dbb2294b | goodB2G1 | 56 | likely_false_positive | | | | |
| 11 | CWE401_Memory_Leak__char_calloc_03 | bundle_1dac026a0b8c | goodB2G2 | 82 | likely_false_positive | | | | |
| 12 | CWE401_Memory_Leak__char_calloc_03 | bundle_8ec32a1f7265 | goodG2B1 | 108 | likely_false_positive | | | | |
| 13 | CWE401_Memory_Leak__char_calloc_03 | bundle_ed82055542a8 | goodG2B2 | 128 | likely_false_positive | | | | |
| 14 | CWE401_Memory_Leak__char_calloc_04 | bundle_f1751f7d0a89 | ..._04_bad | 37 | confirmed_leak | | | | |
| 15 | CWE401_Memory_Leak__char_calloc_04 | bundle_6afd9e46d7ea | goodB2G1 | 62 | likely_false_positive | | | | |
| 16 | CWE401_Memory_Leak__char_calloc_04 | bundle_6985da6c84cb | goodB2G2 | 88 | likely_false_positive | | | | |
| 17 | CWE401_Memory_Leak__char_calloc_04 | bundle_b0ea9822789f | goodG2B1 | 114 | likely_false_positive | | | | |
| 18 | CWE401_Memory_Leak__char_calloc_04 | bundle_58834e6f8314 | goodG2B2 | 134 | likely_false_positive | | | | |
| 19 | CWE401_Memory_Leak__char_calloc_05 | bundle_62fdf6d04df7 | ..._05_bad | 37 | confirmed_leak | | | | |
| 20 | CWE401_Memory_Leak__char_calloc_05 | bundle_c519286df2cf | goodB2G1 | 62 | likely_false_positive | | | | |

Ví dụ neo để căn chuẩn (chưa điền, chỉ minh họa cách áp dụng): row 1 là
`confirmed_leak` calloc dòng 29, repair_diff đề nghị chèn `free(data);` trước
lệnh thoát dòng 36. Nếu explanation chỉ đúng "data cấp phát dòng 29, không
đường thoát nào giải phóng, thoát cuối ở dòng 36" và diff áp dụng được: rc=2,
fx=2, total=4. Nếu explanation chỉ nói "biến này chưa free": rc=1.

## 4. Tổng hợp và cách báo cáo

- Tổng hợp: mean ± min/max của `total` trên 20 row; tách riêng nhóm
  `confirmed_leak` (5 row) và `likely_false_positive` (15 row) để không để nhóm
  dễ lấn nhóm khó.
- Nếu một row bị hai người chấm chênh ≥2 điểm tổng: chấm lại cùng nhau, ghi
  quyết định cuối vào note; báo tỷ lệ đồng thuận thô (số row chênh ≤1 / 20).
- Kết quả đưa vào đâu: một đoạn ngắn trong §4.11 (hạn chế/hướng phát triển) hoặc
  phụ lục, KHÔNG đụng bảng headline của ch4. Đây là đánh giá chất lượng định
  tính trên mẫu 20 row, không phải metric mới của bảng so sánh.
- Tái lập: nếu CSV được export lại từ cùng sweep đông cứng, nội dung bất biến
  (script sort tên file, cắt 20 case đầu) nên bảng chấm cũ vẫn khớp.
