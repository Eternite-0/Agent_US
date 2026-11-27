# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: full_aci
- **Resumed**: false
- **Updated At**: 2026-11-27T10:05:47.267Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `full_aci` | 32/36 | 52.78% (19/36) | 1843776 | 0.00% (n=19) | 33426224 | 1605525 | 94.69% (31649920/33426224, n=36) | 1428 (39.6667) | 15124017 | 91.67% (33/36) | 7.11% (44524/625863) | 34 | 116 calls / 105603 tok / 669453 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `full_aci` | `astropy__astropy-7166` | completed | no | 12 | 68439 | 5746 | 82.29% | 74144 | yes | 0.00% | 0 |
| `full_aci` | `astropy__astropy-13579` | completed | yes | 60 | 1387494 | 64847 | 94.34% | 686889 | yes | 0.00% | 2 |
| `full_aci` | `astropy__astropy-13236` | completed | yes | 60 | 1638784 | 19699 | 94.20% | 324378 | yes | 1.94% | 3 |
| `full_aci` | `django__django-11066` | completed | yes | 23 | 221213 | 15522 | 90.38% | 213024 | yes | 7.78% | 1 |
| `full_aci` | `django__django-11490` | completed | yes | 35 | 694359 | 26832 | 88.36% | 295856 | yes | 7.57% | 2 |
| `full_aci` | `django__django-13964` | completed | yes | 42 | 453783 | 11558 | 94.38% | 284688 | yes | 0.00% | 1 |
| `full_aci` | `django__django-13089` | completed | yes | 60 | 788764 | 87022 | 92.63% | 836657 | yes | 3.07% | 2 |
| `full_aci` | `matplotlib__matplotlib-22865` | completed | no | 60 | 1170670 | 67656 | 94.45% | 655542 | yes | 0.00% | 2 |
| `full_aci` | `matplotlib__matplotlib-20488` | completed | yes | 49 | 684908 | 49745 | 94.42% | 559347 | yes | 0.00% | 2 |
| `full_aci` | `matplotlib__matplotlib-25122` | completed | yes | 32 | 494991 | 11046 | 95.11% | 162443 | yes | 13.60% | 1 |
| `full_aci` | `mwaskom__seaborn-3069` | completed | no | 60 | 4179319 | 90105 | 96.78% | 715248 | yes | 6.23% | 1 |
| `full_aci` | `mwaskom__seaborn-3187` | completed | yes | 30 | 669700 | 13380 | 89.39% | 257798 | yes | 7.80% | 1 |
| `full_aci` | `pallets__flask-5014` | completed | yes | 17 | 104861 | 3730 | 87.64% | 88560 | yes | 34.51% | 1 |
| `full_aci` | `psf__requests-2931` | completed | no | 25 | 200561 | 7028 | 91.26% | 125431 | yes | 0.00% | 0 |
| `full_aci` | `psf__requests-1921` | completed | no | 14 | 88722 | 3782 | 89.16% | 71194 | yes | 0.00% | 0 |
| `full_aci` | `psf__requests-1724` | completed | no | 16 | 176595 | 8810 | 83.93% | 135581 | yes | 0.00% | 0 |
| `full_aci` | `pydata__xarray-3677` | completed | yes | 60 | 1330825 | 58245 | 96.01% | 586109 | yes | 6.20% | 1 |
| `full_aci` | `pydata__xarray-3095` | completed | yes | 43 | 787287 | 11612 | 90.71% | 293269 | yes | 34.13% | 1 |
| `full_aci` | `pydata__xarray-6721` | completed | yes | 15 | 130812 | 4002 | 90.81% | 89254 | yes | 0.00% | 0 |
| `full_aci` | `pylint-dev__pylint-4661` | cancelled | no | 45 | 723603 | 144102 | 95.59% | 901966 | no | 0.00% | 0 |
| `full_aci` | `pylint-dev__pylint-4604` | completed | no | 60 | 2578915 | 86023 | 97.25% | 593720 | yes | 4.63% | 0 |
| `full_aci` | `pylint-dev__pylint-6528` | completed | yes | 60 | 1467883 | 20524 | 94.79% | 277074 | yes | 6.20% | 2 |
| `full_aci` | `pytest-dev__pytest-7205` | completed | yes | 60 | 962325 | 46608 | 93.19% | 533129 | yes | 18.98% | 2 |
| `full_aci` | `pytest-dev__pytest-7432` | completed | no | 60 | 845558 | 45136 | 95.10% | 519921 | yes | 12.86% | 1 |
| `full_aci` | `pytest-dev__pytest-10356` | completed | no | 45 | 2784231 | 75435 | 96.97% | 690310 | yes | 0.00% | 1 |
| `full_aci` | `scikit-learn__scikit-learn-12973` | completed | no | 10 | 57312 | 2252 | 84.20% | 69189 | yes | 12.37% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-14496` | completed | yes | 36 | 629305 | 31888 | 93.56% | 348921 | yes | 6.00% | 1 |
| `full_aci` | `scikit-learn__scikit-learn-14087` | completed | yes | 60 | 1570717 | 79949 | 88.65% | 693377 | yes | 0.00% | 4 |
| `full_aci` | `sphinx-doc__sphinx-10673` | cancelled | no | 39 | 903548 | 137423 | 94.52% | 903695 | no | 5.79% | 1 |
| `full_aci` | `sphinx-doc__sphinx-8269` | completed | no | 16 | 127298 | 3712 | 91.70% | 56890 | yes | 0.00% | 1 |
| `full_aci` | `sphinx-doc__sphinx-9229` | completed | no | 60 | 1849817 | 26069 | 96.94% | 318583 | yes | 13.95% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8120` | cancelled | no | 40 | 709513 | 131489 | 95.00% | 902631 | no | 1.85% | 0 |
| `full_aci` | `sympy__sympy-19783` | cancelled | no | 36 | 619491 | 126183 | 94.63% | 902535 | yes | 6.21% | 0 |
| `full_aci` | `sympy__sympy-19637` | completed | no | 7 | 28902 | 1727 | 80.60% | 38084 | yes | 0.00% | 0 |
| `full_aci` | `sympy__sympy-17139` | completed | yes | 21 | 136748 | 5890 | 91.73% | 181071 | yes | 0.00% | 0 |
| `full_aci` | `sympy__sympy-16792` | completed | yes | 60 | 2158971 | 80748 | 97.04% | 737509 | yes | 5.54% | 0 |
