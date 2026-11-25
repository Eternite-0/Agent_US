# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci
- **Resumed**: false
- **Updated At**: 2026-11-25T10:24:22.187Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 22/28 | 60.00% (15/25) | 2393403 | 0.00% (n=15) | 35180609 | 720433 | 97.34% (32014848/32890499, n=27) | 931 (33.25) | 9105255 | 96.43% (27/28) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 22/25 | 60.00% (15/25) | 1339535 | 51.88% (n=11) | 19659282 | 433737 | 95.82% (18785536/19605724, n=25) | 718 (28.72) | 5082954 | 100.00% (25/25) | 15.15% (63333/417998) | 1 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12209` | completed | yes | 41 | 1288897 | 25455 | 98.12% | 331431 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 17 | 263073 | 7572 | 95.61% | 177361 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12050` | completed | yes | 24 | 306072 | 7744 | 95.22% | 232657 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12193` | completed | yes | 20 | 224686 | 5040 | 91.26% | 178103 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12039` | completed | no | 19 | 446496 | 7604 | 94.60% | 88151 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12304` | completed | no | 25 | 383780 | 8696 | 96.32% | 113273 | yes | 0.00% | 0 |
| `raw_full` | `django__django-9296` | completed | yes | 14 | 157501 | 2961 | 93.62% | 50548 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12308` | completed | no | 21 | 311869 | 7288 | 95.96% | 106759 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11951` | completed | no | 25 | 361139 | 5536 | 92.65% | 199622 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12262` | completed | no | 19 | 355660 | 6239 | 95.16% | 80603 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11999` | completed | no | 22 | 301524 | 6674 | 92.37% | 197175 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11964` | completed | yes | 20 | 375556 | 12641 | 92.16% | 308876 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12273` | completed | yes | 38 | 1015187 | 24881 | 97.80% | 235576 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11848` | completed | yes | 31 | 661749 | 20519 | 97.85% | 203263 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12774` | completed | yes | 43 | 889741 | 13613 | 95.35% | 469040 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11885` | completed | yes | 52 | 2821223 | 46339 | 98.63% | 411040 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11815` | completed | - | 57 | 2595294 | 55276 | 98.61% | 420789 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12713` | completed | yes | 17 | 232654 | 4774 | 94.24% | 96978 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12143` | completed | yes | 55 | 2541246 | 69992 | 98.68% | 517949 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11790` | completed | no | 13 | 149489 | 4202 | 93.67% | 56948 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12708` | completed | yes | 50 | 1522286 | 22656 | 96.23% | 630797 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12276` | completed | no | 24 | 375502 | 6110 | 95.10% | 104710 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12406` | cancelled | yes | 31 | 1380559 | 46382 | 93.70% | 905902 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12325` | reconciling | no | 60 | 2284727 | 39716 | N/A | 522549 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | failed | no | 40 | 1269569 | 18117 | 96.54% | 218594 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | failed | yes | 60 | 6783994 | 113014 | 98.64% | 734552 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7748` | cancelled | - | 33 | 1190002 | 46354 | 93.62% | 901916 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10673` | failed | - | 60 | 4691134 | 85038 | 98.63% | 610093 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12209` | completed | yes | 39 | 1113286 | 24990 | 92.62% | 439402 | yes | 10.53% | 0 |
| `full_aci` | `django__django-12155` | completed | yes | 19 | 358662 | 8568 | 95.25% | 242270 | yes | 17.70% | 0 |
| `full_aci` | `django__django-12050` | completed | yes | 16 | 183775 | 6939 | 95.91% | 189210 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12193` | completed | yes | 26 | 363783 | 5906 | 96.09% | 92387 | yes | 8.30% | 0 |
| `full_aci` | `django__django-12039` | completed | yes | 15 | 276817 | 5008 | 89.98% | 154441 | yes | 12.97% | 0 |
| `full_aci` | `django__django-12304` | completed | no | 20 | 374424 | 12184 | 96.03% | 115964 | yes | 0.00% | 0 |
| `full_aci` | `django__django-9296` | completed | yes | 18 | 210651 | 4514 | 94.97% | 63532 | yes | 19.65% | 0 |
| `full_aci` | `django__django-12308` | completed | yes | 20 | 272641 | 7213 | 95.92% | 92967 | yes | 12.21% | 0 |
| `full_aci` | `django__django-11951` | completed | no | 24 | 318281 | 5519 | 92.74% | 141315 | yes | 26.73% | 0 |
| `full_aci` | `django__django-12262` | completed | no | 20 | 291933 | 7700 | 94.88% | 90825 | yes | 9.02% | 0 |
| `full_aci` | `django__django-11999` | completed | yes | 36 | 838175 | 16813 | 97.77% | 193707 | yes | 26.14% | 0 |
| `full_aci` | `django__django-11964` | completed | yes | 21 | 340029 | 10099 | 91.85% | 277911 | yes | 18.70% | 0 |
| `full_aci` | `django__django-12273` | failed | no | 40 | 1543649 | 28695 | 97.66% | 292251 | yes | 7.66% | 0 |
| `full_aci` | `django__django-11848` | completed | no | 18 | 326245 | 15314 | 95.69% | 132107 | yes | 6.87% | 0 |
| `full_aci` | `django__django-12774` | completed | yes | 27 | 369538 | 6999 | 96.50% | 101783 | yes | 12.46% | 0 |
| `full_aci` | `django__django-11885` | completed | yes | 45 | 1624478 | 29179 | 98.14% | 319830 | yes | 23.21% | 0 |
| `full_aci` | `django__django-12713` | completed | yes | 26 | 370324 | 7082 | 96.12% | 105617 | yes | 14.52% | 0 |
| `full_aci` | `django__django-12143` | failed | no | 39 | 1405434 | 53325 | 94.24% | 339402 | yes | 0.00% | 1 |
| `full_aci` | `django__django-11790` | completed | no | 18 | 215383 | 4891 | 90.81% | 111300 | yes | 5.62% | 0 |
| `full_aci` | `django__django-12708` | completed | yes | 34 | 984486 | 15131 | 96.71% | 161381 | yes | 6.79% | 0 |
| `full_aci` | `django__django-12276` | completed | no | 26 | 382963 | 6083 | 95.89% | 109767 | yes | 14.57% | 0 |
| `full_aci` | `django__django-12406` | completed | no | 48 | 3492339 | 90213 | 98.66% | 586100 | yes | 8.58% | 0 |
| `full_aci` | `django__django-12325` | completed | yes | 21 | 287938 | 7635 | 96.15% | 98765 | yes | 12.89% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 60 | 2496728 | 30654 | 91.56% | 388164 | yes | 37.12% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8035` | completed | yes | 42 | 1217320 | 23083 | 97.55% | 242556 | yes | 17.36% | 0 |
