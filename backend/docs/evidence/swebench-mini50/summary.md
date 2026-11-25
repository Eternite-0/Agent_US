# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci
- **Resumed**: false
- **Updated At**: 2026-11-25T12:44:11.488Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 35/50 | 36.00% (18/50) | 3314561 | 0.00% (n=18) | 58497753 | 1164337 | 97.09% (54571392/56207643, n=49) | 1630 (32.6) | 14471307 | 98.00% (49/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 35/50 | 42.00% (21/50) | 2963502 | 30.03% (n=13) | 61124185 | 1109362 | 96.69% (59051904/61070627, n=50) | 1792 (35.84) | 13552121 | 100.00% (50/50) | 20.31% (235519/1159547) | 4 | 0 calls / 0 tok / 0 ms |

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
| `raw_full` | `django__django-11815` | completed | no | 57 | 2595294 | 55276 | 98.61% | 420789 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12713` | completed | yes | 17 | 232654 | 4774 | 94.24% | 96978 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12143` | completed | yes | 55 | 2541246 | 69992 | 98.68% | 517949 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11790` | completed | no | 13 | 149489 | 4202 | 93.67% | 56948 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12708` | completed | yes | 50 | 1522286 | 22656 | 96.23% | 630797 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11880` | completed | no | 22 | 270672 | 4618 | 95.71% | 79981 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12276` | completed | no | 24 | 375502 | 6110 | 95.10% | 104710 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12406` | cancelled | yes | 31 | 1380559 | 46382 | 93.70% | 905902 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12325` | reconciling | no | 60 | 2284727 | 39716 | N/A | 522549 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | failed | no | 40 | 1269569 | 18117 | 96.54% | 218594 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8548` | failed | no | 47 | 2506294 | 38516 | 96.23% | 743843 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | failed | yes | 60 | 6783994 | 113014 | 98.64% | 734552 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8269` | failed | no | 16 | 263562 | 9998 | 92.95% | 89870 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7748` | cancelled | no | 33 | 1190002 | 46354 | 93.62% | 901916 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9320` | completed | yes | 15 | 229211 | 7292 | 87.90% | 146495 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7985` | cancelled | no | 49 | 2445707 | 44870 | 96.40% | 902269 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10673` | failed | no | 60 | 4691134 | 85038 | 98.63% | 610093 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8475` | completed | no | 30 | 736569 | 12353 | 96.36% | 133803 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7590` | completed | no | 26 | 680466 | 27026 | 96.33% | 199703 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9367` | failed | no | 18 | 277316 | 7822 | 94.81% | 80684 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10466` | failed | yes | 20 | 383325 | 11465 | 95.50% | 104169 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8265` | completed | no | 52 | 1868939 | 19661 | 97.55% | 251472 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7757` | completed | no | 20 | 369557 | 6742 | 93.93% | 82919 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9281` | failed | no | 29 | 595063 | 12182 | 94.17% | 274656 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9229` | completed | no | 60 | 2920947 | 37635 | 98.09% | 342680 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8551` | failed | yes | 31 | 890162 | 21482 | 96.82% | 172814 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9698` | failed | no | 14 | 162757 | 4461 | 93.27% | 55614 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-11510` | completed | no | 42 | 1683615 | 32015 | 97.93% | 273395 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8056` | completed | no | 45 | 1539918 | 26844 | 97.44% | 247807 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9230` | completed | no | 32 | 775174 | 18321 | 94.02% | 397870 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8638` | completed | no | 44 | 2040520 | 44785 | 97.63% | 309052 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10323` | completed | no | 22 | 403289 | 6443 | 95.38% | 84160 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9461` | failed | no | 43 | 1893382 | 36632 | 98.02% | 275844 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10435` | completed | no | 22 | 380699 | 12741 | 96.36% | 116952 | yes | 0.00% | 0 |
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
| `full_aci` | `django__django-11815` | completed | no | 35 | 912543 | 30859 | 97.47% | 243750 | yes | 5.76% | 0 |
| `full_aci` | `django__django-12713` | completed | yes | 26 | 370324 | 7082 | 96.12% | 105617 | yes | 14.52% | 0 |
| `full_aci` | `django__django-12143` | failed | no | 39 | 1405434 | 53325 | 94.24% | 339402 | yes | 0.00% | 1 |
| `full_aci` | `django__django-11790` | completed | no | 18 | 215383 | 4891 | 90.81% | 111300 | yes | 5.62% | 0 |
| `full_aci` | `django__django-12708` | completed | yes | 34 | 984486 | 15131 | 96.71% | 161381 | yes | 6.79% | 0 |
| `full_aci` | `django__django-11880` | completed | no | 19 | 227373 | 4947 | 90.75% | 137627 | yes | 3.67% | 0 |
| `full_aci` | `django__django-12276` | completed | no | 26 | 382963 | 6083 | 95.89% | 109767 | yes | 14.57% | 0 |
| `full_aci` | `django__django-12406` | completed | no | 48 | 3492339 | 90213 | 98.66% | 586100 | yes | 8.58% | 0 |
| `full_aci` | `django__django-12325` | completed | yes | 21 | 287938 | 7635 | 96.15% | 98765 | yes | 12.89% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 60 | 2496728 | 30654 | 91.56% | 388164 | yes | 37.12% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8548` | failed | no | 60 | 3053921 | 36549 | 94.90% | 782069 | yes | 8.31% | 1 |
| `full_aci` | `sphinx-doc__sphinx-8035` | completed | yes | 42 | 1217320 | 23083 | 97.55% | 242556 | yes | 17.36% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8269` | failed | no | 33 | 671234 | 12950 | 96.41% | 144066 | yes | 43.93% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7748` | failed | no | 54 | 2533685 | 39155 | 98.33% | 353939 | yes | 36.97% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9320` | failed | yes | 40 | 1252658 | 28475 | 98.09% | 222692 | yes | 14.66% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7985` | cancelled | no | 45 | 1567601 | 45204 | 95.14% | 902111 | yes | 35.56% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10673` | completed | yes | 57 | 3208779 | 41586 | 98.58% | 422784 | yes | 6.54% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8475` | completed | no | 35 | 686596 | 9556 | 94.26% | 283293 | yes | 47.28% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7590` | failed | no | 59 | 2639774 | 38176 | 98.55% | 349352 | yes | 32.37% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9367` | completed | no | 20 | 280541 | 5603 | 95.50% | 77572 | yes | 17.39% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10466` | failed | no | 60 | 2454967 | 31387 | 98.50% | 304522 | yes | 13.40% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8265` | failed | no | 59 | 2679908 | 38667 | 98.32% | 410643 | yes | 37.21% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7757` | failed | no | 31 | 736269 | 17771 | 93.29% | 373518 | yes | 40.03% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9281` | completed | yes | 45 | 1171331 | 18193 | 95.81% | 507941 | yes | 20.85% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9229` | failed | no | 60 | 2741860 | 38245 | 95.82% | 344306 | yes | 10.81% | 1 |
| `full_aci` | `sphinx-doc__sphinx-8551` | completed | yes | 57 | 2793212 | 34177 | 98.10% | 329819 | yes | 42.31% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9698` | failed | no | 20 | 256916 | 5543 | 94.91% | 74935 | yes | 21.83% | 0 |
| `full_aci` | `sphinx-doc__sphinx-11510` | completed | no | 60 | 3039944 | 39509 | 96.95% | 871546 | yes | 7.55% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8056` | completed | no | 36 | 871765 | 18416 | 96.76% | 175874 | yes | 13.10% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9230` | completed | yes | 31 | 612233 | 13177 | 96.90% | 154122 | yes | 25.88% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8638` | failed | yes | 60 | 3245730 | 57963 | 98.59% | 411477 | yes | 16.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10323` | completed | no | 24 | 502023 | 10227 | 96.79% | 123107 | yes | 3.37% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9461` | completed | no | 60 | 3158331 | 53164 | 96.08% | 392139 | yes | 4.98% | 1 |
| `full_aci` | `sphinx-doc__sphinx-10435` | completed | no | 14 | 165709 | 6126 | 94.39% | 75963 | yes | 0.00% | 0 |
