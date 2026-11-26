# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-26T10:37:17.666Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 33/50 | 61.22% (30/49) | 1493410 | 0.00% (n=30) | 42965292 | 1837017 | 95.98% (41177344/42901710, n=50) | 1434 (28.68) | 17891656 | 88.00% (44/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 33/50 | 61.22% (30/49) | 1424755 | -21.52% (n=29) | 41101536 | 1641124 | 95.81% (39248129/40962810, n=50) | 1517 (30.34) | 19373840 | 86.00% (43/50) | 19.85% (199420/1004819) | 3 | 0 calls / 0 tok / 0 ms |
| `claude_code` | 49/50 | 72.00% (36/50) | 1458418 | 21.45% (n=29) | 51894596 | 608438 | 96.08% (49861248/51894596, n=50) | 1470 (29.4) | 9773978 | 100.00% (50/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `mini_swe_agent` | 28/50 | 58.00% (29/50) | 1112834 | 19.72% (n=28) | 30500859 | 1771334 | 96.05% (29297024/30500859, n=47) | 1907 (38.14) | 15109708 | 80.00% (40/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12209` | failed | yes | 17 | 250653 | 10607 | 95.49% | 94824 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 15 | 190976 | 6125 | 94.50% | 63639 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12050` | completed | yes | 11 | 99941 | 4071 | 95.54% | 51919 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12193` | completed | yes | 15 | 188128 | 6198 | 88.99% | 138227 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12039` | completed | yes | 23 | 411158 | 7479 | 96.01% | 97792 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12304` | completed | yes | 15 | 197316 | 7128 | 95.88% | 84255 | yes | 0.00% | 0 |
| `raw_full` | `django__django-9296` | completed | yes | 11 | 102959 | 2490 | 94.24% | 43760 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12308` | completed | yes | 18 | 260601 | 8697 | 96.07% | 80480 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11951` | failed | yes | 10 | 95580 | 4376 | 93.48% | 49376 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12262` | failed | yes | 20 | 273184 | 5097 | 95.40% | 82887 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11999` | completed | yes | 13 | 180531 | 7720 | 95.79% | 72262 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11964` | completed | yes | 16 | 257251 | 7932 | 94.39% | 86591 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12273` | completed | yes | 39 | 1161811 | 23002 | 98.16% | 235069 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11848` | completed | yes | 11 | 116703 | 3804 | 86.65% | 94184 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12774` | completed | yes | 15 | 198441 | 5536 | 94.63% | 77476 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11885` | completed | yes | 40 | 1930324 | 46656 | 98.50% | 386428 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11815` | completed | yes | 34 | 879664 | 23110 | 97.22% | 192408 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12713` | completed | yes | 18 | 257614 | 5404 | 94.85% | 98617 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12143` | completed | yes | 32 | 517070 | 8837 | 96.87% | 181438 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11790` | completed | yes | 13 | 160749 | 4013 | 93.96% | 56874 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12708` | completed | yes | 26 | 665846 | 11173 | 95.91% | 123779 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11880` | completed | no | 14 | 139771 | 3329 | 94.88% | 58378 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12276` | completed | no | 33 | 566018 | 7204 | 96.61% | 124528 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12406` | completed | yes | 41 | 1718064 | 33129 | 98.25% | 319690 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12325` | completed | yes | 60 | 2426854 | 39226 | 98.61% | 507266 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | completed | no | 16 | 259659 | 5271 | 94.89% | 67081 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8548` | failed | no | 60 | 3280356 | 41841 | 98.33% | 379621 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | cancelled | yes | 33 | 1290017 | 113104 | 82.13% | 901775 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8269` | completed | no | 28 | 543925 | 10076 | 96.34% | 118468 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7748` | completed | no | 60 | 3725580 | 54230 | 98.41% | 464587 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9320` | failed | yes | 60 | 1688226 | 52447 | 97.02% | 588252 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7985` | completed | no | 55 | 4164557 | 76028 | 96.21% | 877698 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10673` | cancelled | no | 29 | 1088108 | 109619 | 84.60% | 902615 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8475` | completed | no | 15 | 217079 | 6573 | 90.50% | 82467 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7590` | cancelled | no | 33 | 716492 | 146812 | 95.29% | 902010 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9367` | completed | no | 12 | 133588 | 4898 | 91.41% | 63830 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10466` | cancelled | yes | 52 | 1362370 | 130581 | 97.13% | 903417 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8265` | cancelled | no | 25 | 388769 | 44909 | 94.03% | 902243 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7757` | completed | yes | 19 | 272005 | 4347 | 94.68% | 76290 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9281` | cancelled | yes | 37 | 807710 | 40738 | 95.51% | 902199 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9229` | completed | no | 60 | 3238660 | 61116 | 98.42% | 485845 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8551` | cancelled | no | 35 | 847382 | 119671 | 94.71% | 903673 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9698` | env_error | - | 7 | 47562 | 1942 | 81.27% | 465583 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-11510` | cancelled | no | 38 | 1006566 | 125270 | 93.42% | 902765 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8056` | completed | no | 60 | 1698768 | 97550 | 97.07% | 828174 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9230` | completed | yes | 13 | 145633 | 16365 | 91.41% | 241370 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8638` | cancelled | no | 34 | 707996 | 98650 | 93.25% | 902669 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10323` | completed | yes | 16 | 306273 | 20204 | 92.86% | 319490 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9461` | cancelled | no | 32 | 759778 | 112279 | 90.87% | 902079 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10435` | failed | no | 45 | 1021026 | 50153 | 96.40% | 405308 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12209` | completed | yes | 35 | 898412 | 15992 | 97.37% | 173474 | yes | 6.38% | 0 |
| `full_aci` | `django__django-12155` | completed | yes | 14 | 207466 | 8450 | 95.32% | 83247 | yes | 21.94% | 0 |
| `full_aci` | `django__django-12050` | completed | yes | 11 | 88626 | 2791 | 95.90% | 43965 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12193` | completed | yes | 17 | 160953 | 4833 | 95.75% | 70924 | yes | 13.96% | 0 |
| `full_aci` | `django__django-12039` | completed | yes | 16 | 292703 | 7188 | 94.50% | 76161 | yes | 10.63% | 0 |
| `full_aci` | `django__django-12304` | completed | yes | 16 | 226781 | 6821 | 94.94% | 84693 | yes | 0.00% | 0 |
| `full_aci` | `django__django-9296` | failed | yes | 7 | 49746 | 1975 | 77.71% | 56097 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12308` | failed | yes | 9 | 100997 | 2705 | 87.70% | 44230 | yes | 41.23% | 0 |
| `full_aci` | `django__django-11951` | completed | yes | 15 | 143683 | 4043 | 88.91% | 100114 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12262` | failed | yes | 9 | 69315 | 2493 | 90.49% | 38606 | yes | 13.64% | 0 |
| `full_aci` | `django__django-11999` | completed | yes | 19 | 264224 | 6285 | 95.82% | 79024 | yes | 16.33% | 0 |
| `full_aci` | `django__django-11964` | completed | yes | 19 | 366056 | 6948 | 95.08% | 92861 | yes | 24.96% | 0 |
| `full_aci` | `django__django-12273` | completed | yes | 60 | 2716234 | 40433 | 98.58% | 386383 | yes | 8.67% | 0 |
| `full_aci` | `django__django-11848` | completed | yes | 18 | 278687 | 9923 | 95.76% | 89970 | yes | 15.64% | 0 |
| `full_aci` | `django__django-12774` | completed | yes | 27 | 488197 | 11282 | 93.81% | 262268 | yes | 0.00% | 0 |
| `full_aci` | `django__django-11885` | cancelled | yes | 52 | 3071813 | 52742 | 96.68% | 907250 | yes | 22.08% | 0 |
| `full_aci` | `django__django-11815` | completed | yes | 32 | 630479 | 12823 | 97.02% | 151230 | yes | 24.24% | 0 |
| `full_aci` | `django__django-12713` | completed | yes | 26 | 426166 | 7430 | 93.35% | 226993 | yes | 3.54% | 0 |
| `full_aci` | `django__django-12143` | completed | yes | 41 | 1772898 | 46892 | 98.28% | 466070 | yes | 12.67% | 0 |
| `full_aci` | `django__django-11790` | completed | yes | 12 | 153444 | 4888 | 93.34% | 58492 | yes | 16.95% | 0 |
| `full_aci` | `django__django-12708` | completed | yes | 33 | 847486 | 13145 | 97.25% | 156452 | yes | 26.35% | 0 |
| `full_aci` | `django__django-11880` | completed | no | 8 | 54383 | 1417 | 94.85% | 34928 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12276` | completed | no | 23 | 333685 | 5205 | 95.44% | 84516 | yes | 13.10% | 0 |
| `full_aci` | `django__django-12406` | completed | yes | 46 | 2061453 | 33523 | 97.81% | 309989 | yes | 4.35% | 0 |
| `full_aci` | `django__django-12325` | completed | yes | 30 | 652742 | 13057 | 94.44% | 323015 | yes | 10.28% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 30 | 692093 | 9413 | 95.51% | 126360 | yes | 36.19% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8548` | completed | no | 55 | 2848570 | 35916 | 96.39% | 358626 | yes | 29.68% | 1 |
| `full_aci` | `sphinx-doc__sphinx-8035` | failed | yes | 57 | 1434011 | 27436 | 96.81% | 389680 | yes | 25.39% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8269` | completed | no | 27 | 447640 | 7396 | 96.39% | 101665 | yes | 16.98% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7748` | completed | no | 45 | 1816777 | 35791 | 98.07% | 290240 | yes | 19.72% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9320` | completed | yes | 13 | 173163 | 3910 | 93.43% | 339119 | yes | 17.77% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7985` | cancelled | no | 35 | 1512482 | 53960 | 94.50% | 902578 | yes | 37.21% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10673` | cancelled | no | 42 | 1338672 | 148595 | 90.66% | 901898 | no | 7.57% | 1 |
| `full_aci` | `sphinx-doc__sphinx-8475` | completed | no | 38 | 815638 | 18836 | 95.48% | 233124 | yes | 40.24% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7590` | env_error | - | 10 | 85310 | 6592 | 90.02% | 493133 | no | 13.15% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9367` | completed | no | 38 | 372545 | 6899 | 97.05% | 457820 | yes | 13.09% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10466` | completed | no | 30 | 587869 | 72469 | 88.31% | 783726 | no | 15.94% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8265` | cancelled | no | 47 | 1379009 | 51404 | 96.37% | 902155 | yes | 21.84% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7757` | completed | yes | 55 | 1378459 | 25198 | 96.91% | 356691 | yes | 39.68% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9281` | completed | yes | 42 | 858863 | 45653 | 96.39% | 393356 | yes | 10.14% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9229` | failed | no | 53 | 1590909 | 109175 | 96.79% | 868288 | yes | 4.98% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8551` | cancelled | no | 33 | 651425 | 89772 | 94.71% | 901583 | no | 26.01% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9698` | completed | yes | 15 | 171997 | 3558 | 93.02% | 485596 | yes | 29.54% | 0 |
| `full_aci` | `sphinx-doc__sphinx-11510` | cancelled | no | 41 | 1158756 | 130091 | 94.84% | 902847 | no | 19.10% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8056` | cancelled | no | 49 | 1176284 | 92774 | 95.69% | 901635 | yes | 20.34% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9230` | completed | yes | 31 | 576388 | 41102 | 95.18% | 443345 | yes | 22.58% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8638` | cancelled | no | 30 | 717479 | 89049 | 85.42% | 902633 | no | 15.22% | 1 |
| `full_aci` | `sphinx-doc__sphinx-10323` | cancelled | yes | 26 | 470388 | 44395 | 94.52% | 901900 | yes | 17.74% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9461` | completed | no | 58 | 2208538 | 95320 | 95.87% | 732250 | yes | 15.81% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10435` | cancelled | no | 22 | 281642 | 73136 | 90.62% | 902640 | no | 0.00% | 0 |
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
| `mini_swe_agent` | `sphinx-doc__sphinx-8035` | failed | no | 2 | 0 | 0 | N/A | 3519 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8269` | completed | no | 57 | 1016029 | 16182 | 96.30% | 196433 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-7748` | failed | no | 2 | 0 | 0 | N/A | 3576 | no | 0.00% | 0 |
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
| `mini_swe_agent` | `sphinx-doc__sphinx-11510` | failed | no | 2 | 0 | 0 | N/A | 3438 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8056` | failed | no | 60 | 1139224 | 80625 | 96.63% | 852762 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9230` | completed | yes | 32 | 337441 | 14403 | 94.26% | 138703 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8638` | failed | no | 60 | 1440198 | 73770 | 96.80% | 836887 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10323` | completed | yes | 53 | 842693 | 11428 | 96.85% | 172084 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9461` | failed | no | 60 | 1529213 | 107938 | 97.01% | 549225 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10435` | failed | no | 32 | 258759 | 24963 | 93.79% | 902740 | no | 0.00% | 0 |
