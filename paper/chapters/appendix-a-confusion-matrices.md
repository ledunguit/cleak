# Phụ lục A: Bảng kết quả chi tiết

## A.1. Full confusion matrices — 9-baseline ablation (Juliet n=50, stratified)

| ID | Baseline | TP | FP | FN | TN | P | R | F1 | Acc | MCC | ECE | FP/KLOC | Token |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| B1 | Static only | 42 | 11 | 11 | 146 | 0.792 | 0.792 | 0.792 | 0.934 | 0.800 | 0.548 | 0.672 | 0 |
| B2 | Dynamic only | 35 | 0 | 24 | 0 | 1.000 | 0.593 | 0.745 | — | — | 0.041 | 0.000 | 0 |
| B3 | Rule-based ensemble | 48 | 11 | 5 | 146 | 0.814 | 0.906 | 0.857 | 0.924 | 0.827 | 0.161 | 0.672 | 0 |
| B4 | LLM + static | 50 | 18 | 3 | 139 | 0.735 | 0.943 | 0.826 | 0.898 | 0.750 | 0.054 | 1.121 | 1,310,030 |
| B5 | LLM + dynamic | 35 | 0 | 24 | 0 | 1.000 | 0.593 | 0.745 | — | — | 0.003 | 0.000 | 37,529 |
| B6 | LLM + all (no planner/sel) | 48 | 1 | 5 | 156 | 0.980 | 0.906 | 0.941 | 0.971 | 0.923 | 0.129 | 0.062 | 455,434 |
| B6a | + planner only | 48 | 1 | 5 | 156 | 0.980 | 0.906 | 0.941 | 0.971 | 0.923 | 0.125 | 0.062 | 463,047 |
| B6b | + tool_selector only | 48 | 2 | 5 | 155 | 0.960 | 0.906 | 0.932 | 0.967 | 0.911 | 0.128 | 0.123 | 4,239,560 |
| B7 | Full adaptive | 48 | 2 | 5 | 155 | 0.960 | 0.906 | 0.932 | 0.967 | 0.911 | 0.130 | 0.123 | 4,115,938 |

*Lưu ý: B2 và B5 có TN=0 vì dynamic-only không enumerate site sạch (positive-only, giống Clang). Acc/MCC không tính được.*

## A.2. Full confusion matrices — n=100 stratified

| ID | Baseline | TP | FP | FN | TN | P | R | F1 | ECE |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| B1 | Static only | 78 | 22 | 24 | 289 | 0.780 | 0.765 | 0.772 | 0.542 |
| B2 | Dynamic only | 68 | 0 | 46 | 0 | 1.000 | 0.596 | 0.747 | 0.060 |
| B3 | Rule-based ensemble | 90 | 22 | 12 | 289 | 0.804 | 0.882 | 0.841 | 0.139 |
| B4 | LLM + static | 97 | 41 | 5 | 270 | 0.703 | 0.951 | 0.808 | 0.064 |
| B5 | LLM + dynamic | 67 | 0 | 45 | 0 | 1.000 | 0.598 | 0.749 | 0.004 |
| B6 | LLM + all (no planner/sel) | 86 | 0 | 16 | 311 | 1.000 | 0.843 | 0.915 | 0.112 |
| B6a | + planner only | 89 | 0 | 13 | 311 | 1.000 | 0.873 | 0.932 | 0.120 |
| B6b | + tool_selector only | 88 | 2 | 14 | 309 | 0.978 | 0.863 | 0.917 | 0.123 |
| B7 | Full adaptive | 88 | 2 | 14 | 309 | 0.978 | 0.863 | 0.917 | 0.122 |

## A.3. 2×2 ablation (Juliet n=30)

| | TP | FP | FN | TN | P | R | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| no_llm, dynamic off | 29 | 7 | 3 | 38 | 0.806 | 0.906 | 0.853 |
| no_llm, dynamic on | 29–30 | 7 | 2–3 | 38 | 0.806–0.811 | 0.906–0.938 | 0.853–0.865 |
| llm_assisted, dynamic off | 29 | 7 | 3 | 38 | 0.806 | 0.906 | 0.853 |
| llm_assisted, dynamic on | 29–30 | 7 | 2–3 | 38 | 0.806–0.811 | 0.906–0.938 | 0.853–0.865 |

*TP dao động 29↔30 do flow-variant 12 (`globalReturnsTrueOrFalse()`) leak trên ~50% run.*

## A.4. Static evidence-tool ablation (B1, n=50)

| Static tools | TP | FP | FN | TN | P | R | F1 | ECE |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| none (candidateScan only) | 42 | 11 | 11 | 146 | 0.792 | 0.792 | 0.792 | 0.548 |
| + functionSummary | 42 | 11 | 11 | 146 | 0.792 | 0.792 | 0.792 | 0.492 |
| + pathConstraints | 42 | 11 | 11 | 146 | 0.792 | 0.792 | 0.792 | 0.503 |
| + both (default) | 50 | 13 | 3 | 146 | 0.794 | 0.943 | 0.862 | 0.555 |
| + interproceduralFlow | 50 | 13 | 3 | 146 | 0.794 | 0.943 | 0.862 | 0.554 |
| + scanBuild | 50 | 13 | 3 | 146 | 0.794 | 0.943 | 0.862 | 0.547 |

## A.5. LAMeD results (41 cases)

| Cấu hình | Sites | TP | FP | FN | Recall | Precision |
|---|--:|--:|--:|--:|--:|--:|
| default 2-tool | 44 | 11 | 0 | 33 | 0.250 | 1.000 |
| + interproceduralFlow | 44 | 12 | 0 | 32 | 0.273 | 1.000 |
| Clang SA baseline | 43 | 0 | 0 | 43 | 0.000 | — |

## A.6. Consensus ablation — verdict stability

| Judge arm | Campaign | Case stability | Flip rate | Modal agreement |
|---|---|---|---|---|
| single-LLM (K=1) | A | 22/30 (73.3%) | 8/30 (26.7%) | 26/30 (86.7%) |
| single-LLM (K=1) | B | 26/30 (86.7%) | 4/30 (13.3%) | 28/30 (93.3%) |
| consensus (K=3) | A | 28/30 (93.3%) | 2/30 (6.7%) | 29/30 (96.7%) |
| consensus (K=3) | B | 28/30 (93.3%) | 2/30 (6.7%) | 29/30 (96.7%) |

## A.7. LLM variance (multi-run, 3 runs)

| Config | Metric | Mean | Std | Min | Max |
|---|---|---|---|---|---|
| B6a | Precision | 0.973 | 0.031 | 0.940 | 1.000 |
| B6a | Recall | 0.899 | 0.011 | 0.887 | 0.906 |
| B6a | F1 | 0.935 | 0.020 | 0.913 | 0.950 |
| B6a | Accuracy | 0.968 | 0.010 | 0.957 | 0.976 |
| B6a | MCC | 0.915 | 0.027 | 0.885 | 0.937 |
| B6a | ECE | 0.129 | 0.004 | 0.126 | 0.133 |
| B7 | Precision | 0.973 | 0.012 | 0.959 | 0.980 |
| B7 | Recall | 0.906 | 0.019 | 0.887 | 0.925 |
| B7 | F1 | 0.938 | 0.015 | 0.922 | 0.951 |
| B7 | ECE | 0.125 | 0.004 | 0.121 | 0.127 |
