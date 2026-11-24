# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci
- **Resumed**: true
- **Updated At**: 2026-11-24T22:38:27.117Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 4/5 | 80.00% (4/5) | 953302 | 0.00% (n=4) | 3749736 | 63472 | 90.41% (3390208/3749736) | 173 (34.6) | 1467597 | 100.00% (5/5) | 0.00% (0/0) | 0 |
| `full_aci` | 3/5 | 80.00% (4/5) | 801761 | -76.41% (n=4) | 3129194 | 77851 | 39.46% (1200896/3043660) | 169 (33.8) | 1762774 | 100.00% (5/5) | 20.98% (22076/105226) | 1 |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12209` | completed | yes | 32 | 712901 | 14039 | 96.44% | 208892 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | cancelled | yes | 42 | 0 | 0 | 0.00% | 623349 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 15 | 170161 | 5353 | 94.71% | 124805 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | completed | no | 60 | 2602319 | 30061 | 97.67% | 318548 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12050` | completed | yes | 24 | 264355 | 14019 | 0.00% | 192003 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12209` | completed | yes | 39 | 1227037 | 25647 | 84.02% | 363147 | yes | 8.01% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8035` | cancelled | yes | 34 | 0 | 0 | 0.00% | 622602 | yes | 10.60% | 0 |
| `full_aci` | `django__django-12155` | completed | yes | 15 | 255431 | 13235 | 94.66% | 173119 | yes | 18.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 43 | 1106355 | 17552 | 0.00% | 300193 | yes | 34.94% | 1 |
| `full_aci` | `django__django-12050` | completed | yes | 38 | 540371 | 21417 | 0.00% | 303713 | yes | 5.33% | 0 |
