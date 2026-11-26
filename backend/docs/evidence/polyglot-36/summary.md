# Aider Polyglot 6-Language Benchmark Report

- **Benchmark**: `agent-us-aider-polyglot` v1.0.0
- **Preset**: `polyglot-36`
- **Model**: `deepseek-v4.1-flash`
- **Modes**: `raw_full`, `full_aci`, `claude_code`, `mini_swe_agent`
- **Languages**: `cpp`, `go`, `java`, `javascript`, `python`, `rust`
- **Unique Exercises**: 36
- **Shard**: 0/3
- **Dry Run**: false
- **Updated At**: 2026-11-26T18:45:46.696Z

## Overall 4-Way Comparison

| Mode | Solved | Solve Rate | Input Tokens | Output Tokens | Total Tokens | Tokens / Solved | Cache Read Hit Rate | Mean Steps | Mean Latency (ms) | Tamper Violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 24/36 | 66.67% | 2081158 | 110032 | 2191190 | 91300 | 90.70% (1887616/2081158) | 7.5556 | 36428 | 0 |
| `full_aci` | 23/36 | 63.89% | 2598648 | 125932 | 2724580 | 118460 | 91.69% (2382720/2598648) | 8.8611 | 37726 | 0 |
| `claude_code` | 23/36 | 63.89% | 5432811 | 140775 | 5573586 | 242330 | 88.69% (4818176/5432811) | 8.2222 | 43759 | 0 |
| `mini_swe_agent` | 23/36 | 63.89% | 645773 | 66040 | 711813 | 30948 | 72.84% (470400/645773) | 5.1667 | 25993 | 0 |

## Per-Language Solve Rate Matrix

| Language | `raw_full` | `full_aci` | `claude_code` | `mini_swe_agent` |
| --- | ---: | ---: | ---: | ---: |
| `cpp` | 0/6 (0.00%) | 0/6 (0.00%) | 0/6 (0.00%) | 0/6 (0.00%) |
| `go` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| `java` | 0/6 (0.00%) | 0/6 (0.00%) | 0/6 (0.00%) | 0/6 (0.00%) |
| `javascript` | 6/6 (100.00%) | 5/6 (83.33%) | 5/6 (83.33%) | 6/6 (100.00%) |
| `python` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 5/6 (83.33%) |
| `rust` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| **Overall** | **24/36 (66.67%)** | **23/36 (63.89%)** | **23/36 (63.89%)** | **23/36 (63.89%)** |

## Per-Exercise Details

| Mode | Exercise | Language | Status | Passed | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Latency (ms) | Tamper Restored |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `claude_code` | `cpp/diamond` | `cpp` | completed | no | 7 | 106705 | 2035 | 85.05% | 37156 | no |
| `claude_code` | `cpp/linked-list` | `cpp` | completed | no | 8 | 133273 | 3549 | 87.30% | 35137 | no |
| `claude_code` | `cpp/perfect-numbers` | `cpp` | completed | no | 10 | 151766 | 2478 | 89.49% | 36275 | no |
| `claude_code` | `cpp/space-age` | `cpp` | completed | no | 8 | 118641 | 1904 | 86.96% | 32694 | no |
| `claude_code` | `cpp/sublist` | `cpp` | completed | no | 8 | 134088 | 2706 | 87.25% | 35720 | no |
| `claude_code` | `cpp/zebra-puzzle` | `cpp` | completed | no | 8 | 119295 | 3927 | 87.45% | 40511 | no |
| `claude_code` | `go/dominoes` | `go` | completed | yes | 6 | 87330 | 1637 | 82.81% | 24131 | no |
| `claude_code` | `go/ledger` | `go` | completed | yes | 27 | 898090 | 26095 | 93.62% | 337953 | no |
| `claude_code` | `go/matrix` | `go` | completed | yes | 5 | 80711 | 1736 | 79.93% | 25551 | no |
| `claude_code` | `go/palindrome-products` | `go` | completed | yes | 5 | 71252 | 1860 | 80.30% | 24643 | no |
| `claude_code` | `go/protein-translation` | `go` | completed | yes | 5 | 69070 | 930 | 79.50% | 22115 | no |
| `claude_code` | `go/transpose` | `go` | completed | yes | 5 | 70206 | 2398 | 79.31% | 26939 | no |
| `claude_code` | `java/all-your-base` | `java` | completed | no | 6 | 86196 | 1274 | 83.01% | 18241 | no |
| `claude_code` | `java/custom-set` | `java` | completed | no | 10 | 178227 | 3149 | 89.63% | 33558 | no |
| `claude_code` | `java/hangman` | `java` | completed | no | 9 | 184874 | 8205 | 90.08% | 60074 | no |
| `claude_code` | `java/ocr-numbers` | `java` | completed | no | 6 | 92501 | 2565 | 83.16% | 25462 | no |
| `claude_code` | `java/react` | `java` | completed | no | 7 | 132357 | 7381 | 88.10% | 51561 | no |
| `claude_code` | `java/simple-linked-list` | `java` | completed | no | 7 | 97228 | 1536 | 85.31% | 22621 | no |
| `claude_code` | `javascript/affine-cipher` | `javascript` | completed | no | 8 | 126574 | 2991 | 87.47% | 32006 | no |
| `claude_code` | `javascript/book-store` | `javascript` | completed | yes | 7 | 103335 | 1812 | 85.59% | 29281 | no |
| `claude_code` | `javascript/house` | `javascript` | completed | yes | 5 | 80437 | 1926 | 80.20% | 17714 | no |
| `claude_code` | `javascript/phone-number` | `javascript` | completed | yes | 6 | 84023 | 1340 | 83.02% | 20753 | no |
| `claude_code` | `javascript/rectangles` | `javascript` | completed | yes | 4 | 54318 | 1169 | 75.64% | 13547 | no |
| `claude_code` | `javascript/scale-generator` | `javascript` | completed | yes | 5 | 72872 | 1645 | 78.52% | 19166 | no |
| `claude_code` | `python/bowling` | `python` | completed | yes | 14 | 282141 | 6391 | 92.96% | 53661 | no |
| `claude_code` | `python/poker` | `python` | completed | yes | 9 | 143817 | 2261 | 87.84% | 29086 | no |
| `claude_code` | `python/robot-name` | `python` | completed | yes | 9 | 123390 | 2089 | 89.11% | 27285 | no |
| `claude_code` | `python/scale-generator` | `python` | completed | yes | 9 | 138543 | 3115 | 88.23% | 29450 | no |
| `claude_code` | `python/two-bucket` | `python` | completed | yes | 8 | 113557 | 1846 | 87.58% | 26860 | no |
| `claude_code` | `python/zipper` | `python` | completed | yes | 7 | 113710 | 2017 | 85.78% | 23419 | no |
| `claude_code` | `rust/doubly-linked-list` | `rust` | completed | yes | 14 | 505661 | 28307 | 95.03% | 158422 | no |
| `claude_code` | `rust/gigasecond` | `rust` | completed | yes | 7 | 92401 | 783 | 85.06% | 46443 | no |
| `claude_code` | `rust/grade-school` | `rust` | completed | yes | 7 | 97851 | 1222 | 85.29% | 37941 | no |
| `claude_code` | `rust/poker` | `rust` | completed | yes | 12 | 227116 | 3398 | 91.19% | 50818 | no |
| `claude_code` | `rust/variable-length-quantity` | `rust` | completed | yes | 10 | 157818 | 2108 | 89.54% | 48693 | no |
| `claude_code` | `rust/word-count` | `rust` | completed | yes | 8 | 103437 | 990 | 87.49% | 20454 | no |
| `full_aci` | `cpp/diamond` | `cpp` | completed | no | 11 | 75862 | 2657 | 90.27% | 47195 | no |
| `full_aci` | `cpp/linked-list` | `cpp` | completed | no | 10 | 86858 | 3814 | 91.22% | 66725 | no |
| `full_aci` | `cpp/perfect-numbers` | `cpp` | completed | no | 9 | 51224 | 2245 | 88.71% | 27443 | no |
| `full_aci` | `cpp/space-age` | `cpp` | completed | no | 11 | 67065 | 2906 | 91.23% | 50236 | no |
| `full_aci` | `cpp/sublist` | `cpp` | completed | no | 10 | 78532 | 2872 | 90.46% | 36019 | no |
| `full_aci` | `cpp/zebra-puzzle` | `cpp` | completed | no | 16 | 177164 | 9686 | 94.72% | 84382 | no |
| `full_aci` | `go/dominoes` | `go` | completed | yes | 5 | 25145 | 1127 | 83.48% | 12905 | no |
| `full_aci` | `go/ledger` | `go` | completed | yes | 7 | 86184 | 9384 | 90.30% | 54577 | no |
| `full_aci` | `go/matrix` | `go` | completed | yes | 5 | 29911 | 1549 | 80.45% | 13697 | no |
| `full_aci` | `go/palindrome-products` | `go` | completed | yes | 5 | 26741 | 2132 | 86.64% | 16627 | no |
| `full_aci` | `go/protein-translation` | `go` | completed | yes | 5 | 23912 | 1323 | 82.97% | 14084 | no |
| `full_aci` | `go/transpose` | `go` | completed | yes | 5 | 22477 | 1568 | 81.43% | 14798 | no |
| `full_aci` | `java/all-your-base` | `java` | completed | no | 17 | 117852 | 3154 | 94.27% | 51543 | no |
| `full_aci` | `java/custom-set` | `java` | completed | no | 13 | 120464 | 3168 | 92.02% | 46442 | no |
| `full_aci` | `java/hangman` | `java` | completed | no | 17 | 204011 | 6686 | 94.87% | 63491 | no |
| `full_aci` | `java/ocr-numbers` | `java` | completed | no | 15 | 117429 | 3701 | 92.76% | 48707 | no |
| `full_aci` | `java/react` | `java` | completed | no | 13 | 119201 | 5462 | 94.50% | 50918 | no |
| `full_aci` | `java/simple-linked-list` | `java` | completed | no | 14 | 77714 | 2153 | 93.39% | 36677 | no |
| `full_aci` | `javascript/affine-cipher` | `javascript` | completed | no | 19 | 177639 | 5985 | 94.83% | 64099 | no |
| `full_aci` | `javascript/book-store` | `javascript` | completed | yes | 9 | 52671 | 1696 | 90.16% | 21953 | no |
| `full_aci` | `javascript/house` | `javascript` | completed | yes | 6 | 40711 | 1851 | 84.58% | 19452 | no |
| `full_aci` | `javascript/phone-number` | `javascript` | completed | yes | 7 | 35877 | 1443 | 87.41% | 18950 | no |
| `full_aci` | `javascript/rectangles` | `javascript` | completed | yes | 9 | 59970 | 3258 | 90.50% | 30715 | no |
| `full_aci` | `javascript/scale-generator` | `javascript` | completed | yes | 7 | 84454 | 11854 | 93.67% | 74503 | no |
| `full_aci` | `python/bowling` | `python` | completed | yes | 6 | 38350 | 3477 | 83.78% | 26202 | no |
| `full_aci` | `python/poker` | `python` | completed | yes | 5 | 27911 | 1965 | 81.63% | 15752 | no |
| `full_aci` | `python/robot-name` | `python` | completed | yes | 6 | 26976 | 2603 | 92.53% | 23492 | no |
| `full_aci` | `python/scale-generator` | `python` | completed | yes | 5 | 25322 | 2147 | 86.94% | 17358 | no |
| `full_aci` | `python/two-bucket` | `python` | completed | yes | 4 | 17401 | 1181 | 85.33% | 11652 | no |
| `full_aci` | `python/zipper` | `python` | completed | yes | 4 | 23439 | 1273 | 80.28% | 11959 | no |
| `full_aci` | `rust/doubly-linked-list` | `rust` | failed | yes | 17 | 314795 | 12724 | 95.59% | 205687 | no |
| `full_aci` | `rust/gigasecond` | `rust` | completed | yes | 5 | 18343 | 713 | 84.44% | 10872 | no |
| `full_aci` | `rust/grade-school` | `rust` | completed | yes | 4 | 16844 | 834 | 81.31% | 8948 | no |
| `full_aci` | `rust/poker` | `rust` | completed | yes | 8 | 79398 | 4696 | 89.15% | 33305 | no |
| `full_aci` | `rust/variable-length-quantity` | `rust` | completed | yes | 6 | 37804 | 1926 | 87.02% | 17528 | no |
| `full_aci` | `rust/word-count` | `rust` | completed | yes | 4 | 12997 | 719 | 86.67% | 9258 | no |
| `mini_swe_agent` | `cpp/diamond` | `cpp` | completed | no | 7 | 22805 | 1326 | 76.90% | 26997 | no |
| `mini_swe_agent` | `cpp/linked-list` | `cpp` | completed | no | 11 | 66196 | 3552 | 85.47% | 38146 | no |
| `mini_swe_agent` | `cpp/perfect-numbers` | `cpp` | completed | no | 6 | 19669 | 1447 | 72.89% | 22470 | no |
| `mini_swe_agent` | `cpp/space-age` | `cpp` | completed | no | 5 | 12294 | 980 | 67.68% | 20729 | no |
| `mini_swe_agent` | `cpp/sublist` | `cpp` | completed | no | 6 | 22947 | 1042 | 75.86% | 19648 | no |
| `mini_swe_agent` | `cpp/zebra-puzzle` | `cpp` | completed | no | 9 | 34794 | 3917 | 82.77% | 34448 | no |
| `mini_swe_agent` | `go/dominoes` | `go` | completed | yes | 3 | 7472 | 948 | 53.10% | 8414 | no |
| `mini_swe_agent` | `go/ledger` | `go` | completed | yes | 5 | 23349 | 6287 | 69.62% | 34387 | no |
| `mini_swe_agent` | `go/matrix` | `go` | completed | yes | 3 | 9698 | 1004 | 50.15% | 7865 | no |
| `mini_swe_agent` | `go/palindrome-products` | `go` | completed | yes | 5 | 8667 | 1415 | 62.03% | 12555 | no |
| `mini_swe_agent` | `go/protein-translation` | `go` | completed | yes | 3 | 6078 | 614 | 54.75% | 6483 | no |
| `mini_swe_agent` | `go/transpose` | `go` | completed | yes | 3 | 5352 | 1697 | 50.22% | 12747 | no |
| `mini_swe_agent` | `java/all-your-base` | `java` | completed | no | 5 | 13246 | 839 | 72.47% | 80825 | no |
| `mini_swe_agent` | `java/custom-set` | `java` | completed | no | 7 | 24213 | 1693 | 72.42% | 19306 | no |
| `mini_swe_agent` | `java/hangman` | `java` | completed | no | 7 | 27766 | 4712 | 79.75% | 35395 | no |
| `mini_swe_agent` | `java/ocr-numbers` | `java` | completed | no | 9 | 37956 | 2293 | 81.61% | 146487 | no |
| `mini_swe_agent` | `java/react` | `java` | completed | no | 7 | 18716 | 2640 | 72.49% | 143612 | no |
| `mini_swe_agent` | `java/simple-linked-list` | `java` | completed | no | 6 | 13324 | 1228 | 73.97% | 16080 | no |
| `mini_swe_agent` | `javascript/affine-cipher` | `javascript` | completed | yes | 12 | 60873 | 4549 | 87.05% | 40429 | no |
| `mini_swe_agent` | `javascript/book-store` | `javascript` | completed | yes | 4 | 7748 | 620 | 59.47% | 9775 | no |
| `mini_swe_agent` | `javascript/house` | `javascript` | completed | yes | 6 | 18997 | 718 | 70.75% | 12853 | no |
| `mini_swe_agent` | `javascript/phone-number` | `javascript` | completed | yes | 3 | 5579 | 642 | 48.18% | 8147 | no |
| `mini_swe_agent` | `javascript/rectangles` | `javascript` | completed | yes | 4 | 8549 | 814 | 62.88% | 10282 | no |
| `mini_swe_agent` | `javascript/scale-generator` | `javascript` | completed | yes | 6 | 20292 | 1735 | 73.17% | 18993 | no |
| `mini_swe_agent` | `python/bowling` | `python` | completed | yes | 3 | 11663 | 2110 | 51.58% | 14397 | no |
| `mini_swe_agent` | `python/poker` | `python` | completed | yes | 3 | 8694 | 807 | 48.59% | 7330 | no |
| `mini_swe_agent` | `python/robot-name` | `python` | completed | yes | 4 | 5601 | 1127 | 59.42% | 12080 | no |
| `mini_swe_agent` | `python/scale-generator` | `python` | completed | no | 4 | 14752 | 1759 | 61.61% | 13101 | no |
| `mini_swe_agent` | `python/two-bucket` | `python` | completed | yes | 3 | 5594 | 1040 | 54.92% | 8801 | no |
| `mini_swe_agent` | `python/zipper` | `python` | completed | yes | 3 | 8371 | 624 | 51.99% | 7203 | no |
| `mini_swe_agent` | `rust/doubly-linked-list` | `rust` | completed | yes | 6 | 41619 | 7977 | 71.35% | 43398 | no |
| `mini_swe_agent` | `rust/gigasecond` | `rust` | completed | yes | 3 | 3636 | 256 | 52.81% | 6819 | no |
| `mini_swe_agent` | `rust/grade-school` | `rust` | completed | yes | 3 | 4950 | 375 | 49.13% | 5686 | no |
| `mini_swe_agent` | `rust/poker` | `rust` | completed | yes | 6 | 29490 | 2327 | 73.35% | 17852 | no |
| `mini_swe_agent` | `rust/variable-length-quantity` | `rust` | completed | yes | 3 | 8026 | 587 | 49.44% | 6212 | no |
| `mini_swe_agent` | `rust/word-count` | `rust` | completed | yes | 3 | 6797 | 339 | 52.73% | 5788 | no |
| `raw_full` | `cpp/diamond` | `cpp` | completed | no | 8 | 47551 | 2779 | 88.29% | 33984 | no |
| `raw_full` | `cpp/linked-list` | `cpp` | completed | no | 8 | 64892 | 4688 | 90.54% | 70802 | no |
| `raw_full` | `cpp/perfect-numbers` | `cpp` | completed | no | 8 | 44963 | 2133 | 87.68% | 29679 | no |
| `raw_full` | `cpp/space-age` | `cpp` | completed | no | 8 | 40390 | 2180 | 88.10% | 34271 | no |
| `raw_full` | `cpp/sublist` | `cpp` | completed | no | 8 | 50492 | 1954 | 87.21% | 26815 | no |
| `raw_full` | `cpp/zebra-puzzle` | `cpp` | completed | no | 8 | 52814 | 5302 | 91.85% | 45286 | no |
| `raw_full` | `go/dominoes` | `go` | completed | yes | 6 | 31973 | 2042 | 84.47% | 17011 | no |
| `raw_full` | `go/ledger` | `go` | completed | yes | 8 | 91505 | 9182 | 90.92% | 69732 | no |
| `raw_full` | `go/matrix` | `go` | completed | yes | 5 | 27707 | 1293 | 79.46% | 14544 | no |
| `raw_full` | `go/palindrome-products` | `go` | completed | yes | 7 | 38520 | 2694 | 89.72% | 30887 | no |
| `raw_full` | `go/protein-translation` | `go` | completed | yes | 5 | 22631 | 1007 | 80.88% | 25125 | no |
| `raw_full` | `go/transpose` | `go` | completed | yes | 5 | 18448 | 973 | 72.85% | 19091 | no |
| `raw_full` | `java/all-your-base` | `java` | completed | no | 14 | 87214 | 2302 | 92.32% | 53009 | no |
| `raw_full` | `java/custom-set` | `java` | completed | no | 13 | 114292 | 2956 | 92.06% | 40368 | no |
| `raw_full` | `java/hangman` | `java` | completed | no | 15 | 166310 | 6470 | 94.74% | 58710 | no |
| `raw_full` | `java/ocr-numbers` | `java` | completed | no | 12 | 87568 | 3137 | 92.23% | 54973 | no |
| `raw_full` | `java/react` | `java` | completed | no | 11 | 86342 | 4835 | 92.80% | 53517 | no |
| `raw_full` | `java/simple-linked-list` | `java` | completed | no | 13 | 87136 | 3816 | 93.43% | 63025 | no |
| `raw_full` | `javascript/affine-cipher` | `javascript` | completed | yes | 10 | 62148 | 2442 | 89.39% | 34843 | no |
| `raw_full` | `javascript/book-store` | `javascript` | completed | yes | 4 | 17505 | 784 | 80.43% | 9818 | no |
| `raw_full` | `javascript/house` | `javascript` | completed | yes | 4 | 22429 | 779 | 77.61% | 10475 | no |
| `raw_full` | `javascript/phone-number` | `javascript` | completed | yes | 5 | 20252 | 1247 | 83.43% | 13709 | no |
| `raw_full` | `javascript/rectangles` | `javascript` | completed | yes | 5 | 20148 | 1012 | 82.59% | 12337 | no |
| `raw_full` | `javascript/scale-generator` | `javascript` | completed | yes | 7 | 43428 | 2999 | 90.19% | 26979 | no |
| `raw_full` | `python/bowling` | `python` | completed | yes | 5 | 35982 | 4632 | 83.24% | 29271 | no |
| `raw_full` | `python/poker` | `python` | completed | yes | 5 | 25664 | 1823 | 80.80% | 15685 | no |
| `raw_full` | `python/robot-name` | `python` | completed | yes | 4 | 12217 | 1063 | 88.01% | 10647 | no |
| `raw_full` | `python/scale-generator` | `python` | completed | yes | 4 | 19277 | 1716 | 83.66% | 13821 | no |
| `raw_full` | `python/two-bucket` | `python` | completed | yes | 6 | 30731 | 3211 | 90.38% | 22696 | no |
| `raw_full` | `python/zipper` | `python` | completed | yes | 5 | 28834 | 1996 | 84.79% | 16697 | no |
| `raw_full` | `rust/doubly-linked-list` | `rust` | failed | yes | 19 | 431910 | 18391 | 96.88% | 261057 | no |
| `raw_full` | `rust/gigasecond` | `rust` | completed | yes | 5 | 16626 | 689 | 83.15% | 12053 | no |
| `raw_full` | `rust/grade-school` | `rust` | completed | yes | 5 | 21084 | 1153 | 85.60% | 19910 | no |
| `raw_full` | `rust/poker` | `rust` | completed | yes | 7 | 60558 | 4246 | 86.45% | 27109 | no |
| `raw_full` | `rust/variable-length-quantity` | `rust` | completed | yes | 6 | 34716 | 1445 | 85.17% | 15774 | no |
| `raw_full` | `rust/word-count` | `rust` | completed | yes | 4 | 16901 | 661 | 79.52% | 17703 | no |
