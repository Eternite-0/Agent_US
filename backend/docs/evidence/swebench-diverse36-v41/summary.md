# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: full_aci
- **Resumed**: false
- **Updated At**: 2026-11-27T07:02:29.308Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `full_aci` | 7/36 | 60.00% (6/10) | 1150687 | 0.00% (n=6) | 6408800 | 495319 | 87.47% (5605504/6408800, n=15) | 538 (14.9444) | 4835951 | 25.00% (9/36) | 6.78% (20824/306976) | 63 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `full_aci` | `astropy__astropy-7166` | env_error | - | 2 | 2802 | 101 | 73.09% | 8222 | no | 0.00% | 0 |
| `full_aci` | `astropy__astropy-13579` | failed | yes | 60 | 927025 | 108694 | 87.51% | 817576 | yes | 10.19% | 9 |
| `full_aci` | `astropy__astropy-13236` | failed | yes | 17 | 127114 | 4550 | 81.77% | 92832 | yes | 6.78% | 1 |
| `full_aci` | `django__django-11066` | env_error | - | 1 | 0 | 0 | N/A | 8339 | no | 0.00% | 0 |
| `full_aci` | `django__django-11490` | completed | yes | 31 | 230975 | 18884 | 84.79% | 216064 | yes | 0.00% | 5 |
| `full_aci` | `django__django-13964` | env_error | - | 1 | 0 | 0 | N/A | 7113 | no | 0.00% | 0 |
| `full_aci` | `django__django-13089` | completed | yes | 60 | 871330 | 72327 | 88.82% | 615421 | yes | 9.45% | 8 |
| `full_aci` | `matplotlib__matplotlib-22865` | env_error | - | 1 | 0 | 0 | N/A | 4587 | no | 0.00% | 0 |
| `full_aci` | `matplotlib__matplotlib-20488` | env_error | - | 1 | 0 | 0 | N/A | 10323 | no | 0.00% | 0 |
| `full_aci` | `matplotlib__matplotlib-25122` | env_error | - | 1 | 0 | 0 | N/A | 9188 | no | 0.00% | 0 |
| `full_aci` | `mwaskom__seaborn-3069` | completed | no | 60 | 917399 | 100919 | 85.53% | 739378 | no | 5.62% | 9 |
| `full_aci` | `mwaskom__seaborn-3187` | env_error | - | 13 | 107077 | 10339 | 75.79% | 99549 | no | 11.67% | 1 |
| `full_aci` | `pallets__flask-5014` | env_error | - | 1 | 0 | 0 | N/A | 1252 | no | 0.00% | 0 |
| `full_aci` | `psf__requests-2931` | env_error | - | 1 | 0 | 0 | N/A | 1894 | no | 0.00% | 0 |
| `full_aci` | `psf__requests-1921` | env_error | - | 1 | 0 | 0 | N/A | 1782 | no | 0.00% | 0 |
| `full_aci` | `psf__requests-1724` | completed | no | 37 | 406889 | 12963 | 89.59% | 208327 | yes | 0.00% | 3 |
| `full_aci` | `pydata__xarray-3677` | env_error | - | 1 | 0 | 0 | N/A | 1570 | no | 0.00% | 0 |
| `full_aci` | `pydata__xarray-3095` | env_error | - | 11 | 67764 | 3700 | 77.45% | 58515 | no | 0.00% | 1 |
| `full_aci` | `pydata__xarray-6721` | env_error | - | 1 | 0 | 0 | N/A | 2657 | no | 0.00% | 0 |
| `full_aci` | `pylint-dev__pylint-4661` | env_error | - | 1 | 0 | 0 | N/A | 2430 | no | 0.00% | 0 |
| `full_aci` | `pylint-dev__pylint-4604` | completed | no | 60 | 788852 | 28163 | 88.43% | 391232 | yes | 5.92% | 7 |
| `full_aci` | `pylint-dev__pylint-6528` | env_error | - | 1 | 0 | 0 | N/A | 2324 | no | 0.00% | 0 |
| `full_aci` | `pytest-dev__pytest-7205` | failed | no | 60 | 741928 | 25020 | 93.77% | 515436 | yes | 15.30% | 6 |
| `full_aci` | `pytest-dev__pytest-7432` | env_error | - | 3 | 9069 | 2635 | 50.81% | 22078 | no | 0.00% | 0 |
| `full_aci` | `pytest-dev__pytest-10356` | env_error | - | 1 | 0 | 0 | N/A | 2811 | no | 0.00% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-12973` | completed | yes | 21 | 153402 | 10850 | 82.27% | 144443 | yes | 5.30% | 3 |
| `full_aci` | `scikit-learn__scikit-learn-14496` | env_error | - | 1 | 0 | 0 | N/A | 4149 | no | 0.00% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-14087` | completed | yes | 60 | 877200 | 62923 | 87.55% | 547403 | yes | 5.39% | 9 |
| `full_aci` | `sphinx-doc__sphinx-10673` | env_error | - | 1 | 0 | 0 | N/A | 4251 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8269` | env_error | - | 1 | 0 | 0 | N/A | 2885 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9229` | env_error | - | 1 | 0 | 0 | N/A | 3061 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8120` | env_error | - | 1 | 0 | 0 | N/A | 2761 | no | 0.00% | 0 |
| `full_aci` | `sympy__sympy-19783` | env_error | - | 22 | 179974 | 33251 | 79.80% | 270569 | no | 0.00% | 1 |
| `full_aci` | `sympy__sympy-19637` | env_error | - | 1 | 0 | 0 | N/A | 7596 | no | 0.00% | 0 |
| `full_aci` | `sympy__sympy-17139` | env_error | - | 1 | 0 | 0 | N/A | 3725 | no | 0.00% | 0 |
| `full_aci` | `sympy__sympy-16792` | env_error | - | 1 | 0 | 0 | N/A | 4208 | no | 0.00% | 0 |
