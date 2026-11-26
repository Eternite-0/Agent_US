# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-26T04:02:17.317Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 5/50 | 16.00% (8/50) | 195143 | 0.00% (n=8) | 1510966 | 50177 | 93.77% (1416832/1510966, n=10) | 165 (3.3) | 893443 | 16.00% (8/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 1/50 | 8.00% (4/50) | 86233 | 57.91% (n=4) | 334431 | 10502 | 85.66% (286464/334431, n=6) | 86 (1.72) | 456922 | 8.00% (4/50) | 28.17% (10323/36639) | 0 | 0 calls / 0 tok / 0 ms |
| `claude_code` | 49/50 | 72.00% (36/50) | 1458418 | -100.06% (n=7) | 51894596 | 608438 | 96.08% (49861248/51894596, n=50) | 1470 (29.4) | 9773978 | 100.00% (50/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `mini_swe_agent` | 28/50 | 58.00% (29/50) | 1112834 | -121.53% (n=8) | 30500859 | 1771334 | 96.05% (29297024/30500859, n=47) | 1907 (38.14) | 15109708 | 80.00% (40/50) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12209` | failed | yes | 17 | 250653 | 10607 | 95.49% | 94824 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 15 | 190976 | 6125 | 94.50% | 63639 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12050` | completed | yes | 11 | 99941 | 4071 | 95.54% | 51919 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12193` | completed | yes | 15 | 188128 | 6198 | 88.99% | 138227 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12039` | failed | no | 6 | 43615 | 2407 | 73.37% | 58395 | no | 0.00% | 0 |
| `raw_full` | `django__django-12304` | failed | no | 2 | 5329 | 109 | 88.87% | 20428 | no | 0.00% | 0 |
| `raw_full` | `django__django-9296` | completed | yes | 11 | 102959 | 2490 | 94.24% | 43760 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12308` | completed | yes | 18 | 260601 | 8697 | 96.07% | 80480 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11951` | failed | yes | 10 | 95580 | 4376 | 93.48% | 49376 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12262` | failed | yes | 20 | 273184 | 5097 | 95.40% | 82887 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11999` | failed | no | 1 | 0 | 0 | N/A | 7106 | no | 0.00% | 0 |
| `raw_full` | `django__django-11964` | failed | no | 1 | 0 | 0 | N/A | 7018 | no | 0.00% | 0 |
| `raw_full` | `django__django-12273` | failed | no | 1 | 0 | 0 | N/A | 6123 | no | 0.00% | 0 |
| `raw_full` | `django__django-11848` | failed | no | 1 | 0 | 0 | N/A | 8533 | no | 0.00% | 0 |
| `raw_full` | `django__django-12774` | failed | no | 1 | 0 | 0 | N/A | 10608 | no | 0.00% | 0 |
| `raw_full` | `django__django-11885` | failed | no | 1 | 0 | 0 | N/A | 10587 | no | 0.00% | 0 |
| `raw_full` | `django__django-11815` | failed | no | 1 | 0 | 0 | N/A | 7165 | no | 0.00% | 0 |
| `raw_full` | `django__django-12713` | failed | no | 1 | 0 | 0 | N/A | 6259 | no | 0.00% | 0 |
| `raw_full` | `django__django-12143` | failed | no | 1 | 0 | 0 | N/A | 8668 | no | 0.00% | 0 |
| `raw_full` | `django__django-11790` | failed | no | 1 | 0 | 0 | N/A | 6980 | no | 0.00% | 0 |
| `raw_full` | `django__django-12708` | failed | no | 1 | 0 | 0 | N/A | 7611 | no | 0.00% | 0 |
| `raw_full` | `django__django-11880` | failed | no | 1 | 0 | 0 | N/A | 7018 | no | 0.00% | 0 |
| `raw_full` | `django__django-12276` | failed | no | 1 | 0 | 0 | N/A | 6445 | no | 0.00% | 0 |
| `raw_full` | `django__django-12406` | failed | no | 1 | 0 | 0 | N/A | 7223 | no | 0.00% | 0 |
| `raw_full` | `django__django-12325` | failed | no | 1 | 0 | 0 | N/A | 7563 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | failed | no | 1 | 0 | 0 | N/A | 3507 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8548` | failed | no | 1 | 0 | 0 | N/A | 3479 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | failed | no | 1 | 0 | 0 | N/A | 3158 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8269` | failed | no | 1 | 0 | 0 | N/A | 3393 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7748` | failed | no | 1 | 0 | 0 | N/A | 3408 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9320` | failed | no | 1 | 0 | 0 | N/A | 4179 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7985` | failed | no | 1 | 0 | 0 | N/A | 3177 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10673` | failed | no | 1 | 0 | 0 | N/A | 3266 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8475` | failed | no | 1 | 0 | 0 | N/A | 3008 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7590` | failed | no | 1 | 0 | 0 | N/A | 3294 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9367` | failed | no | 1 | 0 | 0 | N/A | 3641 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10466` | failed | no | 1 | 0 | 0 | N/A | 4841 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8265` | failed | no | 1 | 0 | 0 | N/A | 4201 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-7757` | failed | no | 1 | 0 | 0 | N/A | 4685 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9281` | failed | no | 1 | 0 | 0 | N/A | 3556 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9229` | failed | no | 1 | 0 | 0 | N/A | 3639 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8551` | failed | no | 1 | 0 | 0 | N/A | 3399 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9698` | failed | no | 1 | 0 | 0 | N/A | 4318 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-11510` | failed | no | 1 | 0 | 0 | N/A | 4310 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8056` | failed | no | 1 | 0 | 0 | N/A | 4119 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9230` | failed | no | 1 | 0 | 0 | N/A | 3980 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8638` | failed | no | 1 | 0 | 0 | N/A | 4056 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10323` | failed | no | 1 | 0 | 0 | N/A | 3768 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9461` | failed | no | 1 | 0 | 0 | N/A | 3992 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10435` | failed | no | 1 | 0 | 0 | N/A | 4227 | no | 0.00% | 0 |
| `full_aci` | `django__django-12209` | failed | no | 1 | 0 | 0 | N/A | 7482 | no | 0.00% | 0 |
| `full_aci` | `django__django-12155` | failed | no | 2 | 5686 | 54 | 0.00% | 13837 | no | 0.00% | 0 |
| `full_aci` | `django__django-12050` | completed | yes | 11 | 88626 | 2791 | 95.90% | 43965 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12193` | failed | no | 1 | 0 | 0 | N/A | 5988 | no | 0.00% | 0 |
| `full_aci` | `django__django-12039` | failed | no | 1 | 0 | 0 | N/A | 9111 | no | 0.00% | 0 |
| `full_aci` | `django__django-12304` | failed | no | 1 | 0 | 0 | N/A | 8844 | no | 0.00% | 0 |
| `full_aci` | `django__django-9296` | failed | yes | 7 | 49746 | 1975 | 77.71% | 56097 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12308` | failed | yes | 9 | 100997 | 2705 | 87.70% | 44230 | yes | 41.23% | 0 |
| `full_aci` | `django__django-11951` | failed | no | 4 | 20061 | 484 | 57.42% | 28620 | no | 0.00% | 0 |
| `full_aci` | `django__django-12262` | failed | yes | 9 | 69315 | 2493 | 90.49% | 38606 | yes | 13.64% | 0 |
| `full_aci` | `django__django-11999` | failed | no | 1 | 0 | 0 | N/A | 7697 | no | 0.00% | 0 |
| `full_aci` | `django__django-11964` | failed | no | 1 | 0 | 0 | N/A | 8520 | no | 0.00% | 0 |
| `full_aci` | `django__django-12273` | failed | no | 1 | 0 | 0 | N/A | 5996 | no | 0.00% | 0 |
| `full_aci` | `django__django-11848` | failed | no | 1 | 0 | 0 | N/A | 6902 | no | 0.00% | 0 |
| `full_aci` | `django__django-12774` | failed | no | 1 | 0 | 0 | N/A | 7885 | no | 0.00% | 0 |
| `full_aci` | `django__django-11885` | failed | no | 1 | 0 | 0 | N/A | 8050 | no | 0.00% | 0 |
| `full_aci` | `django__django-11815` | failed | no | 1 | 0 | 0 | N/A | 8906 | no | 0.00% | 0 |
| `full_aci` | `django__django-12713` | failed | no | 1 | 0 | 0 | N/A | 8807 | no | 0.00% | 0 |
| `full_aci` | `django__django-12143` | failed | no | 1 | 0 | 0 | N/A | 6861 | no | 0.00% | 0 |
| `full_aci` | `django__django-11790` | failed | no | 1 | 0 | 0 | N/A | 8973 | no | 0.00% | 0 |
| `full_aci` | `django__django-12708` | failed | no | 1 | 0 | 0 | N/A | 7141 | no | 0.00% | 0 |
| `full_aci` | `django__django-11880` | failed | no | 1 | 0 | 0 | N/A | 5756 | no | 0.00% | 0 |
| `full_aci` | `django__django-12276` | failed | no | 1 | 0 | 0 | N/A | 7740 | no | 0.00% | 0 |
| `full_aci` | `django__django-12406` | failed | no | 1 | 0 | 0 | N/A | 6329 | no | 0.00% | 0 |
| `full_aci` | `django__django-12325` | failed | no | 1 | 0 | 0 | N/A | 6718 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 1 | 0 | 0 | N/A | 3357 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8548` | failed | no | 1 | 0 | 0 | N/A | 3292 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8035` | failed | no | 1 | 0 | 0 | N/A | 3048 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8269` | failed | no | 1 | 0 | 0 | N/A | 3529 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7748` | failed | no | 1 | 0 | 0 | N/A | 3240 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9320` | failed | no | 1 | 0 | 0 | N/A | 3894 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7985` | failed | no | 1 | 0 | 0 | N/A | 3091 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10673` | failed | no | 1 | 0 | 0 | N/A | 3186 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8475` | failed | no | 1 | 0 | 0 | N/A | 3857 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7590` | failed | no | 1 | 0 | 0 | N/A | 3605 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9367` | failed | no | 1 | 0 | 0 | N/A | 4626 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10466` | failed | no | 1 | 0 | 0 | N/A | 3728 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8265` | failed | no | 1 | 0 | 0 | N/A | 2893 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-7757` | failed | no | 1 | 0 | 0 | N/A | 2786 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9281` | failed | no | 1 | 0 | 0 | N/A | 4192 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9229` | failed | no | 1 | 0 | 0 | N/A | 3417 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8551` | failed | no | 1 | 0 | 0 | N/A | 2783 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9698` | failed | no | 1 | 0 | 0 | N/A | 3838 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-11510` | failed | no | 1 | 0 | 0 | N/A | 3422 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8056` | failed | no | 1 | 0 | 0 | N/A | 3330 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9230` | failed | no | 1 | 0 | 0 | N/A | 3470 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8638` | failed | no | 1 | 0 | 0 | N/A | 3650 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10323` | failed | no | 1 | 0 | 0 | N/A | 3455 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9461` | failed | no | 1 | 0 | 0 | N/A | 3293 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10435` | failed | no | 1 | 0 | 0 | N/A | 4879 | no | 0.00% | 0 |
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
