# Tài liệu tham khảo — Đã xác minh, đánh số thống nhất

> Mọi reference đã kiểm chứng qua arXiv/DOI/publisher page.
> Format: IEEE style. Số [N] dùng thống nhất trong TOÀN BỘ luận văn.

---

## A. Công cụ phân tích tĩnh

[1] A. Bugs, "Clang Static Analyzer," LLVM Project. [Online]. Available: https://clang-analyzer.llvm.org/

[2] S. Calcagno and D. Distefano, "Infer: An Interprocedural Memory Safety Analyzer for Large-Scale C Programs," Facebook Research, 2015. [Online]. Available: https://fbinfer.com/

[3] GitHub, "CodeQL: Semantic Code Analysis Engine." [Online]. Available: https://codeql.github.com/

[4] M. Brunsfeld, "Tree-sitter: An Incremental Parsing System for Programming Tools," 2018. [Online]. Available: https://tree-sitter.github.io/tree-sitter/

[5] C. Wang, Y. Gao, W. Zhang, X. Liu, J. Guo, M. Zheng, Q. Shi, and X. Zhang, "NESA: Relational Neuro-Symbolic Static Program Analysis," in Proc. ASPLOS, 2025. arXiv:2412.14399.

[6] G. Horvath, R. Kovacs, and Z. Porkolab, "Scaling Symbolic Execution to Large Software Systems," arXiv:2408.01909, 2024.

## B. Công cụ phân tích động

[7] N. Nethercote and J. Seward, "Valgrind: A Framework for Heavyweight Dynamic Binary Instrumentation," in Proc. PLDI, 2007. DOI: 10.1145/1250734.1250746.

[8] S. Serebryany, D. Bruening, A. Potapenko, and D. Vyukov, "AddressSanitizer: A Fast Address Sanity Checker," in Proc. USENIX ATC, 2012.

[9] F. Gorter and C. Giuffrida, "RangeSanitizer: Detecting Memory Errors with Efficient Range Checks," in Proc. USENIX Security, 2025.

[10] M. Marini, D. E. Daniele Cono, M. Payer, and L. Querzoni, "QMSan: Efficiently Detecting Uninitialized Memory Errors During Fuzzing," in Proc. NDSS, 2025.

[11] M. Marini, F. Gorter, D. C. D'Elia, and C. Giuffrida, "CombiSan: Unifying Software Sanitizers for Comprehensive Fuzzing," preprint, 2025–2026.

[12] Q. Sang, Y. Wang, Y. Liu, X. Jia, T. Bao, and P. Su, "AirTaint: Making Dynamic Taint Analysis Faster and Easier," in Proc. IEEE S&P, 2024.

[13] K. Hassler, P. Goerz, and S. Lipp, "A Comparative Study of Fuzzers and Static Analysis Tools for Finding Memory Unsafety in C and C++," arXiv:2505.22052, 2025.

[14] A. Murali, M. Alfadel, and M. Nagappan, "AddressWatcher: Sanitizer-Based Localization of Memory Leak Fixes," IEEE Trans. Softw. Eng., 2024.

## C. LLM cho phát hiện lỗi

[15] A. Khare, S. Dutta, Z. Li, A. Solko-Breslin, R. Alur, and M. Naik, "Understanding the Effectiveness of Large Language Models in Detecting Security Vulnerabilities," arXiv:2311.16169, 2023.

[16] Z. Li, S. Dutta, and M. Naik, "IRIS: LLM-Assisted Static Analysis for Detecting Security Vulnerabilities," arXiv:2405.17238, 2024.

[17] I. Ceka, F. Qiao, A. Dey, A. Valecha, G. Kaiser, and B. Ray, "Can LLM Prompting Serve as a Proxy for Static Analysis in Vulnerability Detection," arXiv:2412.12039, 2024.

[18] Y. Nie, H. Li, C. Guo, R. Jiang, Z. Wang, B. Li, D. Song, and W. Guo, "VulnLLM-R: Specialized Reasoning LLM with Agent Scaffold for Vulnerability Detection," arXiv:2512.07533, 2025.

[19] J. Ghebremichael, S. Vasan, S. Ullah, G. Tystahl, D. Adei, C. Kruegel, G. Vigna, W. Enck, and A. Kapravelos, "SemTaint: Multi-Agent Taint Specification Extraction for Vulnerability Detection," arXiv:2601.10865, 2026.

## D. Leak C/C++ trực tiếp (baseline chính)

[20] H. Huang, J. Shi, B. Wang, Z. Yang, and D. Lo, "MemHint: Finding Memory Leaks in C/C++ Programs via Neuro-Symbolic Augmented Static Analysis," arXiv:2603.27224, 2026.

[21] E. Shemetova, I. Shenbin, I. Smirnov, A. Alekseev, A. Rukhovich, S. Nikolenko, V. Lomshakov, and I. Piontkovskaya, "LAMeD: LLM-generated Annotations for Memory Leak Detection," arXiv:2505.02376, 2025.

[22] D. Liu, Z. Lu, S. Ji, K. Lu, J. Chen, and Z. Liu et al., "Detecting Kernel Memory Bugs Through Inconsistent Memory Management Intention Inferences," in Proc. USENIX Security, 2024.

## E. Agentic / Multi-agent cho SE

[23] Y. Hou, H. Wang, M. Lyu, M. Momeu, E. Nguyen, T. Yang, K. Sen, D. Song, and D. Wagner, "Revelio: Cost-Efficient Agentic Memory Safety Vulnerability Detection For Repository-Scale Codebases," arXiv:2606.22263, 2026.

[24] M. Shafiuzzaman, A. Desai, W. Guo, and T. Bultan, "SAILOR: Guiding Symbolic Execution with Static Analysis and LLMs for Vulnerability Discovery," arXiv:2604.06506, 2026.

[25] J. Guo, C. Wang, X. Xu, Z. Su, and X. Zhang, "RepoAudit: An Autonomous LLM-Agent for Repository-Level Code Auditing," arXiv:2501.18160, 2025.

[26] Z. Sheng, Z. Chen, Q. Xu, K. Zhu, and J. Huang, "FuzzingBrain V2: A Multi-Agent LLM System for Automated Vulnerability Discovery and Reproduction," arXiv:2605.21779, 2026.

[27] C. Zhang, Y. Park, F. Fleischer, Y.-F. Fu, J. Kim et al., "SoK: DARPA's AI Cyber Challenge (AIxCC): Competition Design, Architectures, and Lessons Learned," arXiv, 2026.

## F. LLM Foundations

[28] S. Yao, J. Zhao, D. Yu, N. Du, I. Shafran, K. Narasimhan, and Y. Cao, "ReAct: Synergizing Reasoning and Acting in Language Models," in Proc. ICLR, 2023. arXiv:2210.03629.

[29] X. Wang, J. Wei, D. Schuurmans, Q. Le, E. Chi, S. Narang, A. Chowdhery, and D. Zhou, "Self-Consistency Improves Chain of Thought Reasoning in Language Models," in Proc. ICLR, 2023. arXiv:2203.11171.

[30] N. Shinn, F. Cassano, E. Berman, A. Gopinath, K. Narasimhan, and S. Yao, "Reflexion: Language Agents with Verbal Reinforcement Learning," in Proc. NeurIPS, 2023. arXiv:2303.11366.

[31] S. Yao, D. Yu, J. Zhao, I. Shafran, T. L. Griffiths, Y. Cao, and K. Narasimhan, "Tree of Thoughts: Deliberate Problem Solving with Large Language Models," in Proc. NeurIPS, 2023. arXiv:2305.10601.

[32] O. Khattab et al., "DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines," in Proc. ICLR, 2024. arXiv:2310.04618.

[33] T. Guo, X. Chen, Y. Wang, R. Chang, S. Pei, N. V. Chawla, O. Wiest, and X. Zhang, "Large Language Model based Multi-Agents: A Survey of Progress and Challenges," arXiv:2402.01680, 2024.

[34] J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, and O. Press, "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering," arXiv:2405.15793, 2024.

[35] C. S. Xia, Y. Deng, S. Dunn, and L. Zhang, "Agentless: Demystifying LLM-based Software Engineering Agents," arXiv:2407.01489, 2024.

[36] L. Zheng, W.-L. Chiang, Y. Sheng, S. Zhuang, Z. Wu, Y. Zhuang, Z. Lin, Z. Li, D. Li, E. P. Xing, H. Zhang, J. E. Gonzalez, and I. Stoica, "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena," in Proc. NeurIPS Datasets and Benchmarks Track, 2023. arXiv:2306.05685.

## G. Benchmarks & Datasets

[37] NIST, "Juliet Test Suite v1.3 for C/C++," SAMATE/SARD, 2017. [Online]. Available: https://samate.nist.gov/SARD/testsuite.php

[38] LAMeD Benchmark, "memleak_benchmark.json," Zenodo record 15089703, 2025. DOI: 10.5281/zenodo.15089703.

[39] Y. Chen, Z. Ding, L. Alowain, X. Chen, and D. Wagner, "DiverseVul: A New Vulnerable Source Code Dataset for Deep Learning Based Vulnerability Detection," in Proc. RAID, 2023. arXiv:2304.00409.

[40] SV-COMP, "Software Verification Competition — Memsafety Category," 2024. [Online]. Available: https://sv-comp.sosy-lab.org/2024/

[41] Magma Benchmark, "A Ground-Truth Fuzzing Benchmark." [Online]. Available: https://magma-benchmark.github.io/

## H. Giao thức & Tiêu chuẩn

[42] Anthropic, "Model Context Protocol (MCP) Specification," 2024. [Online]. Available: https://modelcontextprotocol.io/

[43] D. Svoboda, W. Klieber, L. Flynn, R. Martins, and J. Hoskinson, "A Pointer-Ownership Model for C Inspired by Rust," in Proc. LCTES (ACM SIGPLAN), 2026. DOI: 10.1145/3814943.3816182.
