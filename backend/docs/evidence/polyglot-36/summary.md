# Aider Polyglot 6-Language Benchmark Report

- **Benchmark**: `agent-us-aider-polyglot` v1.0.0
- **Preset**: `polyglot-36`
- **Model**: `deepseek-v4.1-flash`
- **Modes**: `raw_full`, `full_aci`, `claude_code`, `mini_swe_agent`
- **Languages**: `cpp`, `go`, `java`, `javascript`, `python`, `rust`
- **Unique Exercises**: 36
- **Shard**: 0/4
- **Dry Run**: false
- **Updated At**: 2026-11-26T20:09:18.855Z

## Overall 4-Way Comparison

| Mode | Solved | Solve Rate | Input Tokens | Output Tokens | Total Tokens | Tokens / Solved | Cache Read Hit Rate | Mean Steps | Mean Latency (ms) | Tamper Violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 36/36 | 100.00% | 1631203 | 102116 | 1733319 | 48148 | 89.14% (1452160/1629069) | 6.25 | 33585 | 0 |
| `full_aci` | 35/36 | 97.22% | 1934346 | 119235 | 2053581 | 58674 | 90.20% (1744768/1934346) | 7.0556 | 34732 | 0 |
| `claude_code` | 35/36 | 97.22% | 4867049 | 132563 | 4999612 | 142846 | 87.64% (4265472/4867049) | 7.3611 | 42930 | 0 |
| `mini_swe_agent` | 35/36 | 97.22% | 438598 | 59272 | 497870 | 14225 | 66.42% (291328/438598) | 4.0278 | 16693 | 0 |

## Per-Language Solve Rate Matrix

| Language | `raw_full` | `full_aci` | `claude_code` | `mini_swe_agent` |
| --- | ---: | ---: | ---: | ---: |
| `cpp` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| `go` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| `java` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| `javascript` | 6/6 (100.00%) | 5/6 (83.33%) | 5/6 (83.33%) | 6/6 (100.00%) |
| `python` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 5/6 (83.33%) |
| `rust` | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) | 6/6 (100.00%) |
| **Overall** | **36/36 (100.00%)** | **35/36 (97.22%)** | **35/36 (97.22%)** | **35/36 (97.22%)** |

## Per-Exercise Details

| Mode | Exercise | Language | Status | Passed | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Latency (ms) | Tamper Restored |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `claude_code` | `cpp/diamond` | `cpp` | completed | yes | 5 | 71235 | 1290 | 79.24% | 34834 | no |
| `claude_code` | `cpp/linked-list` | `cpp` | completed | yes | 6 | 91448 | 2057 | 82.16% | 40129 | no |
| `claude_code` | `cpp/perfect-numbers` | `cpp` | completed | yes | 5 | 67503 | 1005 | 79.64% | 32494 | no |
| `claude_code` | `cpp/space-age` | `cpp` | completed | yes | 4 | 53559 | 948 | 74.56% | 30876 | no |
| `claude_code` | `cpp/sublist` | `cpp` | completed | yes | 5 | 76503 | 1553 | 78.97% | 32931 | no |
| `claude_code` | `cpp/zebra-puzzle` | `cpp` | completed | yes | 5 | 74593 | 4340 | 81.34% | 47418 | no |
| `claude_code` | `go/dominoes` | `go` | completed | yes | 6 | 87330 | 1637 | 82.81% | 24131 | no |
| `claude_code` | `go/ledger` | `go` | completed | yes | 27 | 898090 | 26095 | 93.62% | 337953 | no |
| `claude_code` | `go/matrix` | `go` | completed | yes | 5 | 80711 | 1736 | 79.93% | 25551 | no |
| `claude_code` | `go/palindrome-products` | `go` | completed | yes | 5 | 71252 | 1860 | 80.30% | 24643 | no |
| `claude_code` | `go/protein-translation` | `go` | completed | yes | 5 | 69070 | 930 | 79.50% | 22115 | no |
| `claude_code` | `go/transpose` | `go` | completed | yes | 5 | 70206 | 2398 | 79.31% | 26939 | no |
| `claude_code` | `java/all-your-base` | `java` | completed | yes | 7 | 100572 | 1228 | 85.27% | 24687 | no |
| `claude_code` | `java/custom-set` | `java` | completed | yes | 5 | 81893 | 1787 | 79.24% | 19691 | no |
| `claude_code` | `java/hangman` | `java` | completed | yes | 6 | 119570 | 9942 | 85.96% | 60619 | no |
| `claude_code` | `java/ocr-numbers` | `java` | completed | yes | 4 | 58368 | 2006 | 75.44% | 20180 | no |
| `claude_code` | `java/react` | `java` | completed | yes | 7 | 121592 | 5477 | 86.85% | 39424 | no |
| `claude_code` | `java/simple-linked-list` | `java` | completed | yes | 4 | 52553 | 864 | 75.26% | 15854 | no |
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
| `full_aci` | `cpp/diamond` | `cpp` | completed | yes | 8 | 47556 | 1819 | 88.82% | 41456 | no |
| `full_aci` | `cpp/linked-list` | `cpp` | completed | yes | 5 | 31925 | 2599 | 81.79% | 39329 | no |
| `full_aci` | `cpp/perfect-numbers` | `cpp` | completed | yes | 6 | 29671 | 1084 | 84.99% | 30564 | no |
| `full_aci` | `cpp/space-age` | `cpp` | completed | yes | 6 | 28215 | 1587 | 86.65% | 36618 | no |
| `full_aci` | `cpp/sublist` | `cpp` | completed | yes | 6 | 35005 | 1263 | 83.37% | 30113 | no |
| `full_aci` | `cpp/zebra-puzzle` | `cpp` | completed | yes | 8 | 62395 | 5894 | 92.11% | 62857 | no |
| `full_aci` | `go/dominoes` | `go` | completed | yes | 5 | 25145 | 1127 | 83.48% | 12905 | no |
| `full_aci` | `go/ledger` | `go` | completed | yes | 7 | 86184 | 9384 | 90.30% | 54577 | no |
| `full_aci` | `go/matrix` | `go` | completed | yes | 5 | 29911 | 1549 | 80.45% | 13697 | no |
| `full_aci` | `go/palindrome-products` | `go` | completed | yes | 5 | 26741 | 2132 | 86.64% | 16627 | no |
| `full_aci` | `go/protein-translation` | `go` | completed | yes | 5 | 23912 | 1323 | 82.97% | 14084 | no |
| `full_aci` | `go/transpose` | `go` | completed | yes | 5 | 22477 | 1568 | 81.43% | 14798 | no |
| `full_aci` | `java/all-your-base` | `java` | completed | yes | 10 | 53293 | 1572 | 89.83% | 30269 | no |
| `full_aci` | `java/custom-set` | `java` | completed | yes | 9 | 69969 | 2403 | 89.09% | 37556 | no |
| `full_aci` | `java/hangman` | `java` | completed | yes | 11 | 142199 | 12209 | 94.97% | 91946 | no |
| `full_aci` | `java/ocr-numbers` | `java` | completed | yes | 7 | 44445 | 3019 | 88.99% | 29916 | no |
| `full_aci` | `java/react` | `java` | completed | yes | 6 | 41927 | 6813 | 88.23% | 48041 | no |
| `full_aci` | `java/simple-linked-list` | `java` | completed | yes | 9 | 42474 | 1545 | 90.41% | 23308 | no |
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
| `mini_swe_agent` | `cpp/diamond` | `cpp` | completed | yes | 3 | 6002 | 665 | 59.71% | 25656 | no |
| `mini_swe_agent` | `cpp/linked-list` | `cpp` | completed | yes | 3 | 9046 | 1176 | 56.60% | 26632 | no |
| `mini_swe_agent` | `cpp/perfect-numbers` | `cpp` | completed | yes | 3 | 5985 | 496 | 62.02% | 22748 | no |
| `mini_swe_agent` | `cpp/space-age` | `cpp` | completed | yes | 3 | 5340 | 801 | 59.93% | 25546 | no |
| `mini_swe_agent` | `cpp/sublist` | `cpp` | completed | yes | 4 | 13167 | 594 | 69.02% | 24533 | no |
| `mini_swe_agent` | `cpp/zebra-puzzle` | `cpp` | completed | yes | 4 | 7654 | 2184 | 66.89% | 34103 | no |
| `mini_swe_agent` | `go/dominoes` | `go` | completed | yes | 3 | 7472 | 948 | 53.10% | 8414 | no |
| `mini_swe_agent` | `go/ledger` | `go` | completed | yes | 5 | 23349 | 6287 | 69.62% | 34387 | no |
| `mini_swe_agent` | `go/matrix` | `go` | completed | yes | 3 | 9698 | 1004 | 50.15% | 7865 | no |
| `mini_swe_agent` | `go/palindrome-products` | `go` | completed | yes | 5 | 8667 | 1415 | 62.03% | 12555 | no |
| `mini_swe_agent` | `go/protein-translation` | `go` | completed | yes | 3 | 6078 | 614 | 54.75% | 6483 | no |
| `mini_swe_agent` | `go/transpose` | `go` | completed | yes | 3 | 5352 | 1697 | 50.22% | 12747 | no |
| `mini_swe_agent` | `java/all-your-base` | `java` | completed | yes | 3 | 5989 | 545 | 55.57% | 9039 | no |
| `mini_swe_agent` | `java/custom-set` | `java` | completed | yes | 3 | 10414 | 939 | 49.16% | 10799 | no |
| `mini_swe_agent` | `java/hangman` | `java` | completed | yes | 6 | 18153 | 5610 | 75.45% | 37406 | no |
| `mini_swe_agent` | `java/ocr-numbers` | `java` | completed | yes | 4 | 10729 | 1083 | 69.20% | 16545 | no |
| `mini_swe_agent` | `java/react` | `java` | completed | yes | 5 | 9984 | 4137 | 56.41% | 26906 | no |
| `mini_swe_agent` | `java/simple-linked-list` | `java` | completed | yes | 3 | 4288 | 671 | 59.70% | 9421 | no |
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
| `raw_full` | `cpp/diamond` | `cpp` | completed | yes | 5 | 22068 | 1044 | 80.04% | 31004 | no |
| `raw_full` | `cpp/linked-list` | `cpp` | completed | yes | 6 | 38694 | 2622 | 84.02% | 37250 | no |
| `raw_full` | `cpp/perfect-numbers` | `cpp` | completed | yes | 4 | 18016 | 1158 | 79.57% | 28020 | no |
| `raw_full` | `cpp/space-age` | `cpp` | completed | yes | 4 | 17252 | 1240 | 80.87% | 28365 | no |
| `raw_full` | `cpp/sublist` | `cpp` | completed | yes | 5 | 27966 | 1538 | 80.55% | 29177 | no |
| `raw_full` | `cpp/zebra-puzzle` | `cpp` | completed | yes | 7 | 43561 | 5621 | 91.68% | 55414 | no |
| `raw_full` | `go/dominoes` | `go` | completed | yes | 6 | 31973 | 2042 | 84.47% | 17011 | no |
| `raw_full` | `go/ledger` | `go` | completed | yes | 8 | 91505 | 9182 | 90.92% | 69732 | no |
| `raw_full` | `go/matrix` | `go` | completed | yes | 5 | 27707 | 1293 | 79.46% | 14544 | no |
| `raw_full` | `go/palindrome-products` | `go` | completed | yes | 7 | 38520 | 2694 | 89.72% | 30887 | no |
| `raw_full` | `go/protein-translation` | `go` | completed | yes | 5 | 22631 | 1007 | 80.88% | 25125 | no |
| `raw_full` | `go/transpose` | `go` | completed | yes | 5 | 18448 | 973 | 72.85% | 19091 | no |
| `raw_full` | `java/all-your-base` | `java` | completed | yes | 8 | 44334 | 2216 | 88.64% | 41175 | no |
| `raw_full` | `java/custom-set` | `java` | completed | yes | 9 | 68702 | 2693 | 88.87% | 30826 | no |
| `raw_full` | `java/hangman` | `java` | completed | yes | 6 | 47790 | 7479 | 88.39% | 52304 | no |
| `raw_full` | `java/ocr-numbers` | `java` | completed | yes | 9 | 51467 | 1844 | 89.53% | 28337 | no |
| `raw_full` | `java/react` | `java` | completed | yes | 9 | 71815 | 5759 | 91.61% | 60961 | no |
| `raw_full` | `java/simple-linked-list` | `java` | completed | yes | 7 | 28344 | 1422 | 87.91% | 39262 | no |
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
