# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci
- **Resumed**: false
- **Updated At**: 2026-11-25T06:51:43.726Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 3/5 | 80.00% (4/5) | 2520877 | 0.00% (n=4) | 9911605 | 171902 | 98.12% (9719552/9906222, n=5) | 182 (36.4) | 1694595 | 100.00% (5/5) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 5/5 | 80.00% (4/5) | 1007970 | 66.61% (n=4) | 3955186 | 76692 | 95.25% (2731008/2867106, n=4) | 155 (31) | 1375810 | 100.00% (5/5) | 15.52% (12990/83679) | 0 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12050` | completed | yes | 24 | 306072 | 7744 | 95.22% | 232657 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 17 | 263073 | 7572 | 95.61% | 177361 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12209` | completed | yes | 41 | 1288897 | 25455 | 98.12% | 331431 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | failed | yes | 60 | 6783994 | 113014 | 98.64% | 734552 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | failed | no | 40 | 1269569 | 18117 | 96.54% | 218594 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12050` | completed | yes | 16 | 183775 | 6939 | 95.91% | 189210 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12155` | completed | yes | 19 | 358662 | 8568 | 95.25% | 242270 | yes | 17.70% | 0 |
| `full_aci` | `django__django-12209` | completed | yes | 39 | 1113286 | 24990 | 92.62% | 439402 | yes | 10.53% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8035` | completed | yes | 42 | 1217320 | 23083 | 97.55% | 242556 | yes | 17.36% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | completed | no | 39 | 1082143 | 13112 | N/A | 262372 | yes | 20.28% | 0 |
