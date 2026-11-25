# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, codex_cli, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-25T16:41:31.714Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 3/5 | 80.00% (4/5) | 2520877 | 0.00% (n=4) | 9911605 | 171902 | 98.12% (9719552/9906222, n=5) | 182 (36.4) | 1694595 | 100.00% (5/5) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 4/5 | 80.00% (4/5) | 1366001 | 66.61% (n=4) | 5369771 | 94234 | 93.55% (4973312/5316213, n=5) | 176 (35.2) | 1501602 | 100.00% (5/5) | 24.20% (27424/113328) | 0 | 0 calls / 0 tok / 0 ms |
| `claude_code` | 5/5 | 60.00% (3/5) | 1754697 | 32.31% (n=3) | 5197458 | 66633 | 96.11% (4995328/5197458, n=5) | 164 (32.8) | 1348080 | 100.00% (5/5) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `codex_cli` | 0/5 | 0.00% (0/5) | N/A | N/A | 0 | 0 | N/A (0/0, n=0) | 0 (0) | 21196 | 0.00% (0/5) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `mini_swe_agent` | 0/5 | N/A | N/A | N/A | 0 | 0 | N/A (0/0, n=0) | 0 (0) | 62347 | 0.00% (0/5) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `django__django-12209` | completed | yes | 41 | 1288897 | 25455 | 98.12% | 331431 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8035` | failed | yes | 60 | 6783994 | 113014 | 98.64% | 734552 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12155` | completed | yes | 17 | 263073 | 7572 | 95.61% | 177361 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8721` | failed | no | 40 | 1269569 | 18117 | 96.54% | 218594 | yes | 0.00% | 0 |
| `raw_full` | `django__django-12050` | completed | yes | 24 | 306072 | 7744 | 95.22% | 232657 | yes | 0.00% | 0 |
| `full_aci` | `django__django-12209` | completed | yes | 39 | 1113286 | 24990 | 92.62% | 439402 | yes | 10.53% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8035` | completed | yes | 42 | 1217320 | 23083 | 97.55% | 242556 | yes | 17.36% | 0 |
| `full_aci` | `django__django-12155` | completed | yes | 19 | 358662 | 8568 | 95.25% | 242270 | yes | 17.70% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8721` | failed | no | 60 | 2496728 | 30654 | 91.56% | 388164 | yes | 37.12% | 0 |
| `full_aci` | `django__django-12050` | completed | yes | 16 | 183775 | 6939 | 95.91% | 189210 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12209` | completed | yes | 27 | 596064 | 7099 | 95.88% | 125614 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8035` | completed | no | 47 | 1828773 | 19984 | 96.33% | 249070 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12155` | completed | yes | 24 | 560221 | 14081 | 93.81% | 321991 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8721` | completed | no | 58 | 2106146 | 23949 | 97.04% | 609951 | yes | 0.00% | 0 |
| `claude_code` | `django__django-12050` | completed | yes | 8 | 106254 | 1520 | 87.22% | 41454 | yes | 0.00% | 0 |
| `codex_cli` | `django__django-12209` | failed | no | 0 | 0 | 0 | N/A | 5306 | no | 0.00% | 0 |
| `codex_cli` | `sphinx-doc__sphinx-8035` | failed | no | 0 | 0 | 0 | N/A | 2208 | no | 0.00% | 0 |
| `codex_cli` | `django__django-12155` | failed | no | 0 | 0 | 0 | N/A | 5289 | no | 0.00% | 0 |
| `codex_cli` | `sphinx-doc__sphinx-8721` | failed | no | 0 | 0 | 0 | N/A | 2290 | no | 0.00% | 0 |
| `codex_cli` | `django__django-12050` | failed | no | 0 | 0 | 0 | N/A | 6103 | no | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12209` | env_error | - | 0 | 0 | 0 | N/A | 12897 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8035` | env_error | - | 0 | 0 | 0 | N/A | 11177 | no | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12155` | env_error | - | 0 | 0 | 0 | N/A | 16329 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8721` | env_error | - | 0 | 0 | 0 | N/A | 9065 | no | 0.00% | 0 |
| `mini_swe_agent` | `django__django-12050` | env_error | - | 0 | 0 | 0 | N/A | 12879 | no | 0.00% | 0 |
