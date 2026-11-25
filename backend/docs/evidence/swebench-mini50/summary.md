# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-25T19:59:12.489Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 35/50 | 36.00% (18/50) | 3314561 | 0.00% (n=18) | 58497753 | 1164337 | 97.09% (54571392/56207643, n=49) | 1630 (32.6) | 14471307 | 98.00% (49/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 35/50 | 42.00% (21/50) | 2963502 | 30.03% (n=13) | 61124185 | 1109362 | 96.69% (59051904/61070627, n=50) | 1792 (35.84) | 13552121 | 100.00% (50/50) | 20.31% (235519/1159547) | 4 | 0 calls / 0 tok / 0 ms |
| `claude_code` | 49/50 | 72.00% (36/50) | 1458418 | 43.26% (n=17) | 51894596 | 608438 | 96.08% (49861248/51894596, n=50) | 1470 (29.4) | 9773978 | 100.00% (50/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `mini_swe_agent` | 28/50 | 61.70% (29/47) | 1112834 | 48.84% (n=15) | 30500859 | 1771334 | 96.05% (29297024/30500859, n=47) | 1901 (38.02) | 17807670 | 80.00% (40/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |

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
| `claude_code` | `django__django-12209` | completed | yes | 25 | 553628 | 7964 | 95.58% | 108742 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12155` | completed | yes | 24 | 542047 | 11839 | 93.84% | 208199 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12050` | completed | yes | 14 | 232669 | 3350 | 92.37% | 57301 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12193` | completed | no | 19 | 322283 | 4221 | 94.13% | 75475 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12039` | completed | yes | 10 | 208356 | 5417 | 82.01% | 54224 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12304` | completed | yes | 13 | 232058 | 4823 | 91.56% | 62519 | yes | 0.00% | 0 |
| `claude_code` | `django__django-9296` | completed | yes | 17 | 268684 | 2396 | 93.28% | 61150 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12308` | completed | yes | 16 | 301937 | 5111 | 93.31% | 130837 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11951` | completed | yes | 12 | 172029 | 2168 | 89.44% | 58799 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12262` | completed | yes | 27 | 520900 | 6827 | 95.34% | 114108 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11999` | completed | yes | 14 | 298173 | 5856 | 90.66% | 108802 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11964` | completed | yes | 12 | 256710 | 5882 | 88.65% | 106263 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12273` | completed | yes | 28 | 758612 | 18464 | 86.96% | 167116 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11848` | completed | yes | 10 | 152787 | 3126 | 87.30% | 62188 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12774` | completed | yes | 20 | 422518 | 8213 | 95.00% | 99785 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11885` | completed | yes | 54 | 2144308 | 20193 | 97.85% | 397856 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11815` | completed | yes | 18 | 320503 | 4757 | 93.49% | 82527 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12713` | completed | yes | 22 | 425151 | 6519 | 95.02% | 151305 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12143` | completed | yes | 12 | 173200 | 2117 | 90.01% | 66823 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11790` | completed | yes | 12 | 190689 | 2933 | 90.82% | 47557 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12708` | completed | yes | 29 | 737087 | 9639 | 95.88% | 122752 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11880` | completed | no | 20 | 313328 | 3533 | 94.25% | 77000 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12276` | completed | no | 23 | 412687 | 3770 | 94.82% | 92363 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12406` | completed | yes | 29 | 735038 | 10639 | 94.87% | 204599 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12325` | completed | yes | 34 | 707248 | 18745 | 86.33% | 167464 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8721` | completed | no | 28 | 770790 | 14753 | 94.49% | 242964 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8548` | completed | yes | 90 | 5565225 | 43936 | 98.61% | 609066 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8035` | completed | yes | 38 | 1290799 | 17429 | 97.08% | 298287 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8269` | completed | no | 27 | 653336 | 7359 | 89.28% | 617306 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-7748` | completed | yes | 51 | 1852817 | 18544 | 97.57% | 249158 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9320` | completed | yes | 13 | 263025 | 5011 | 89.74% | 87427 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-7985` | completed | no | 27 | 823578 | 14130 | 94.31% | 219823 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-10673` | completed | yes | 65 | 3468831 | 32162 | 97.43% | 446414 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8475` | completed | no | 16 | 278822 | 3699 | 92.64% | 58675 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-7590` | completed | yes | 24 | 646264 | 10258 | 95.17% | 112824 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9367` | completed | no | 15 | 275883 | 6083 | 91.31% | 113957 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-10466` | completed | yes | 47 | 1637880 | 19607 | 96.54% | 230815 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8265` | completed | no | 34 | 1140137 | 24128 | 95.20% | 331407 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-7757` | completed | yes | 13 | 234188 | 3220 | 91.17% | 48603 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9281` | completed | yes | 12 | 201806 | 3783 | 90.95% | 48303 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9229` | completed | no | 85 | 4324853 | 33545 | 96.97% | 657571 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8551` | completed | yes | 48 | 1828638 | 21526 | 97.66% | 232869 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9698` | completed | yes | 9 | 138497 | 1978 | 85.95% | 49755 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-11510` | failed | no | 106 | 6996986 | 51292 | 98.36% | 903178 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8056` | completed | no | 24 | 611429 | 12449 | 95.75% | 168443 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9230` | completed | yes | 19 | 372106 | 14604 | 83.45% | 185329 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8638` | completed | yes | 51 | 2011014 | 17579 | 96.63% | 248620 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-10323` | completed | yes | 13 | 242211 | 2823 | 91.21% | 49541 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9461` | completed | no | 81 | 4402878 | 40935 | 98.48% | 582943 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-10435` | completed | no | 20 | 459973 | 9103 | 85.96% | 94946 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12209` | failed | yes | 60 | 860908 | 118717 | 96.64% | 655212 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12155` | completed | yes | 26 | 201331 | 6415 | 93.01% | 91429 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12050` | completed | yes | 18 | 48644 | 2902 | 88.68% | 63153 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12193` | completed | yes | 49 | 535990 | 15487 | 95.88% | 178609 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12039` | completed | yes | 24 | 302015 | 10538 | 93.96% | 104469 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12304` | completed | yes | 28 | 197709 | 7028 | 93.42% | 102527 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-9296` | completed | yes | 10 | 34057 | 1153 | 83.44% | 40839 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12308` | failed | yes | 60 | 938875 | 49013 | 96.65% | 359952 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11951` | completed | yes | 13 | 47224 | 2182 | 87.01% | 39315 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12262` | completed | yes | 46 | 472149 | 9340 | 95.32% | 145079 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11999` | completed | yes | 30 | 465027 | 15510 | 94.52% | 134824 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11964` | completed | yes | 21 | 212893 | 8670 | 92.59% | 87448 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12273` | failed | yes | 45 | 769322 | 70707 | 95.67% | 905992 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11848` | completed | yes | 15 | 80652 | 9492 | 89.67% | 71950 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12774` | completed | yes | 30 | 221355 | 13320 | 93.68% | 128901 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11885` | failed | yes | 60 | 1203299 | 69498 | 96.33% | 823658 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11815` | completed | yes | 44 | 503787 | 26577 | 95.96% | 221489 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12713` | completed | yes | 39 | 326573 | 11313 | 94.77% | 167670 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12143` | completed | yes | 25 | 169547 | 5820 | 90.75% | 135878 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11790` | completed | yes | 24 | 240977 | 8866 | 92.42% | 90396 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12708` | completed | yes | 33 | 397213 | 23890 | 94.35% | 180931 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11880` | completed | no | 14 | 44952 | 1793 | 87.13% | 38350 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12276` | completed | no | 27 | 155244 | 4032 | 92.51% | 77358 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12406` | failed | no | 51 | 988844 | 175022 | 96.05% | 905217 | no | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12325` | failed | yes | 60 | 806051 | 116477 | 96.39% | 631661 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8721` | failed | no | 60 | 1351378 | 32156 | 96.88% | 293060 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8548` | failed | no | 60 | 2058649 | 156933 | 97.28% | 760192 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8035` | env_error | - | 0 | 0 | 0 | N/A | 902816 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8269` | completed | no | 57 | 1016029 | 16182 | 96.30% | 196433 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-7748` | env_error | - | 0 | 0 | 0 | N/A | 902718 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9320` | completed | yes | 30 | 262299 | 12430 | 94.04% | 115605 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-7985` | failed | no | 60 | 1035605 | 89997 | 96.80% | 514177 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10673` | failed | no | 45 | 792535 | 62318 | 96.02% | 902989 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8475` | completed | no | 48 | 1021813 | 11618 | 95.33% | 156748 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-7590` | failed | no | 60 | 851137 | 104858 | 96.49% | 528689 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9367` | completed | no | 6 | 21050 | 1715 | 66.89% | 34289 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10466` | failed | yes | 60 | 1013709 | 42795 | 96.85% | 310769 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8265` | failed | no | 60 | 1401735 | 39179 | 96.91% | 305119 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-7757` | completed | yes | 41 | 501423 | 5964 | 95.32% | 111387 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9281` | completed | yes | 18 | 91617 | 5305 | 90.25% | 65742 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9229` | failed | no | 60 | 1680439 | 31958 | 96.63% | 472291 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8551` | failed | no | 60 | 1344530 | 54786 | 97.08% | 366483 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9698` | completed | yes | 27 | 284745 | 6251 | 93.05% | 130494 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-11510` | env_error | - | 0 | 0 | 0 | N/A | 902961 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8056` | failed | no | 60 | 1139224 | 80625 | 96.63% | 852762 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9230` | completed | yes | 32 | 337441 | 14403 | 94.26% | 138703 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8638` | failed | no | 60 | 1440198 | 73770 | 96.80% | 836887 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10323` | completed | yes | 53 | 842693 | 11428 | 96.85% | 172084 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9461` | failed | no | 60 | 1529213 | 107938 | 97.01% | 549225 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10435` | failed | no | 32 | 258759 | 24963 | 93.79% | 902740 | no | 0.00% | 0 |
