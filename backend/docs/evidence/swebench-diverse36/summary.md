# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-27T11:48:48.197Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 29/36 | 60.61% (20/33) | 1276461 | 0.00% (n=20) | 24331002 | 1198224 | 96.05% (23371136/24331002, n=34) | 1328 (36.8889) | 11610230 | 86.11% (31/36) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 32/36 | 52.78% (19/36) | 1843776 | -28.27% (n=19) | 33426224 | 1605525 | 94.69% (31649920/33426224, n=36) | 1428 (39.6667) | 15124017 | 91.67% (33/36) | 7.11% (44524/625863) | 34 | 116 calls / 105603 tok / 669453 ms |
| `claude_code` | 29/36 | 55.56% (20/36) | 1920692 | -46.41% (n=19) | 37472621 | 941211 | 96.28% (36078848/37472621, n=33) | 1378 (38.2778) | 11755455 | 88.89% (32/36) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `mini_swe_agent` | 19/36 | 47.22% (17/36) | 1082460 | 12.32% (n=17) | 17706156 | 695658 | 95.32% (16876672/17706156, n=32) | 1250 (34.7222) | 8508628 | 83.33% (30/36) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |

## Instance Telemetry

| Arm | Instance ID | Status | Resolved | Steps | Input Tokens | Output Tokens | Cache Hit Rate | Wall-Clock (ms) | Non-Empty Patch | Admission Reduction | Epoch Transitions |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `raw_full` | `astropy__astropy-7166` | completed | no | 60 | 901977 | 47430 | 96.30% | 444677 | yes | 0.00% | 0 |
| `raw_full` | `astropy__astropy-13579` | completed | yes | 24 | 353182 | 10475 | 92.82% | 138508 | yes | 0.00% | 0 |
| `raw_full` | `astropy__astropy-13236` | completed | yes | 37 | 511013 | 13497 | 94.91% | 196582 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11066` | completed | yes | 16 | 117255 | 7872 | 91.04% | 96567 | yes | 0.00% | 0 |
| `raw_full` | `django__django-11490` | completed | yes | 13 | 90096 | 6979 | 88.65% | 81540 | yes | 0.00% | 0 |
| `raw_full` | `django__django-13964` | completed | yes | 15 | 103055 | 3648 | 89.80% | 70451 | yes | 0.00% | 0 |
| `raw_full` | `django__django-13089` | completed | yes | 6 | 20804 | 1044 | 79.37% | 27730 | yes | 0.00% | 0 |
| `raw_full` | `matplotlib__matplotlib-22865` | completed | no | 60 | 1104971 | 67065 | 96.77% | 750862 | yes | 0.00% | 0 |
| `raw_full` | `matplotlib__matplotlib-20488` | completed | yes | 58 | 932907 | 36087 | 96.28% | 412763 | yes | 0.00% | 0 |
| `raw_full` | `matplotlib__matplotlib-25122` | completed | yes | 34 | 670935 | 27434 | 95.35% | 282581 | yes | 0.00% | 0 |
| `raw_full` | `mwaskom__seaborn-3069` | cancelled | no | 53 | 1224458 | 138896 | 96.05% | 900874 | yes | 0.00% | 0 |
| `raw_full` | `mwaskom__seaborn-3187` | completed | yes | 60 | 1305380 | 46904 | 96.68% | 618000 | yes | 0.00% | 0 |
| `raw_full` | `pallets__flask-5014` | completed | yes | 17 | 136986 | 4257 | 90.26% | 76366 | yes | 0.00% | 0 |
| `raw_full` | `psf__requests-2931` | env_error | - | 4 | 8670 | 462 | 73.82% | 11722 | no | 0.00% | 0 |
| `raw_full` | `psf__requests-1921` | completed | no | 12 | 60848 | 2640 | 89.61% | 58176 | yes | 0.00% | 0 |
| `raw_full` | `psf__requests-1724` | failed | no | 60 | 1076089 | 22266 | 96.66% | 335246 | yes | 0.00% | 0 |
| `raw_full` | `pydata__xarray-3677` | completed | yes | 22 | 206334 | 4278 | 93.18% | 109359 | yes | 0.00% | 0 |
| `raw_full` | `pydata__xarray-3095` | completed | yes | 48 | 952629 | 24285 | 96.07% | 309235 | yes | 0.00% | 0 |
| `raw_full` | `pydata__xarray-6721` | completed | yes | 60 | 1582813 | 46694 | 97.12% | 575010 | yes | 0.00% | 0 |
| `raw_full` | `pylint-dev__pylint-4661` | cancelled | no | 54 | 839758 | 150322 | 96.27% | 901790 | no | 0.00% | 0 |
| `raw_full` | `pylint-dev__pylint-4604` | completed | no | 60 | 883807 | 28608 | 96.80% | 374614 | yes | 0.00% | 0 |
| `raw_full` | `pylint-dev__pylint-6528` | completed | yes | 60 | 1326185 | 41387 | 97.05% | 411665 | yes | 0.00% | 0 |
| `raw_full` | `pytest-dev__pytest-7205` | completed | yes | 58 | 1307399 | 37468 | 96.16% | 399021 | yes | 0.00% | 0 |
| `raw_full` | `pytest-dev__pytest-7432` | completed | no | 45 | 713109 | 18608 | 95.56% | 258895 | yes | 0.00% | 0 |
| `raw_full` | `pytest-dev__pytest-10356` | completed | no | 60 | 1370207 | 108154 | 96.84% | 877467 | yes | 0.00% | 0 |
| `raw_full` | `scikit-learn__scikit-learn-12973` | completed | yes | 35 | 413567 | 19851 | 95.02% | 213088 | yes | 0.00% | 0 |
| `raw_full` | `scikit-learn__scikit-learn-14496` | completed | yes | 44 | 815568 | 29880 | 96.08% | 306981 | yes | 0.00% | 0 |
| `raw_full` | `scikit-learn__scikit-learn-14087` | completed | yes | 41 | 733053 | 33322 | 95.51% | 319644 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-10673` | cancelled | no | 39 | 1061434 | 147106 | 95.03% | 903188 | no | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8269` | completed | no | 14 | 128707 | 4710 | 89.61% | 65970 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-9229` | completed | no | 60 | 1599958 | 28757 | 97.03% | 457076 | yes | 0.00% | 0 |
| `raw_full` | `sphinx-doc__sphinx-8120` | env_error | - | 1 | 0 | 0 | N/A | 2877 | no | 0.00% | 0 |
| `raw_full` | `sympy__sympy-19783` | env_error | - | 1 | 0 | 0 | N/A | 4510 | no | 0.00% | 0 |
| `raw_full` | `sympy__sympy-19637` | completed | no | 20 | 130084 | 7318 | 89.94% | 113652 | yes | 0.00% | 0 |
| `raw_full` | `sympy__sympy-17139` | completed | yes | 22 | 169511 | 8802 | 93.18% | 190332 | yes | 0.00% | 0 |
| `raw_full` | `sympy__sympy-16792` | completed | yes | 55 | 1478253 | 21718 | 97.04% | 313211 | yes | 0.00% | 0 |
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
| `claude_code` | `astropy__astropy-7166` | completed | no | 35 | 636475 | 11128 | 95.89% | 214464 | yes | 0.00% | 0 |
| `claude_code` | `astropy__astropy-13579` | completed | yes | 57 | 1859141 | 32147 | 97.19% | 428597 | yes | 0.00% | 0 |
| `claude_code` | `astropy__astropy-13236` | completed | yes | 50 | 1286286 | 13757 | 96.93% | 325732 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11066` | completed | yes | 31 | 632732 | 11411 | 92.05% | 183724 | yes | 0.00% | 0 |
| `claude_code` | `django__django-11490` | completed | yes | 23 | 408075 | 7388 | 94.70% | 129919 | yes | 0.00% | 0 |
| `claude_code` | `django__django-13964` | completed | yes | 36 | 685693 | 15958 | 95.84% | 234867 | yes | 0.00% | 0 |
| `claude_code` | `django__django-13089` | completed | yes | 31 | 734440 | 26743 | 93.83% | 348423 | yes | 0.00% | 0 |
| `claude_code` | `matplotlib__matplotlib-22865` | completed | no | 31 | 766825 | 23192 | 90.47% | 247263 | yes | 0.00% | 0 |
| `claude_code` | `matplotlib__matplotlib-20488` | failed | yes | 96 | 3647552 | 77777 | 97.12% | 906513 | yes | 0.00% | 0 |
| `claude_code` | `matplotlib__matplotlib-25122` | completed | yes | 10 | 182575 | 3159 | 93.31% | 68186 | yes | 0.00% | 0 |
| `claude_code` | `mwaskom__seaborn-3069` | failed | no | 6 | 0 | 0 | N/A | 2112 | no | 0.00% | 0 |
| `claude_code` | `mwaskom__seaborn-3187` | completed | yes | 45 | 1433282 | 15089 | 96.72% | 474756 | yes | 0.00% | 0 |
| `claude_code` | `pallets__flask-5014` | completed | yes | 9 | 129925 | 1635 | 93.69% | 46646 | yes | 0.00% | 0 |
| `claude_code` | `psf__requests-2931` | completed | no | 80 | 2049399 | 37058 | 97.73% | 531284 | yes | 0.00% | 0 |
| `claude_code` | `psf__requests-1921` | completed | no | 12 | 181641 | 3774 | 94.71% | 67848 | yes | 0.00% | 0 |
| `claude_code` | `psf__requests-1724` | completed | no | 24 | 476137 | 9138 | 94.52% | 149510 | yes | 0.00% | 0 |
| `claude_code` | `pydata__xarray-3677` | completed | yes | 19 | 325881 | 3733 | 95.92% | 98482 | yes | 0.00% | 0 |
| `claude_code` | `pydata__xarray-3095` | completed | yes | 21 | 430813 | 8504 | 95.40% | 129928 | yes | 0.00% | 0 |
| `claude_code` | `pydata__xarray-6721` | completed | yes | 47 | 1171954 | 16212 | 97.64% | 349702 | yes | 0.00% | 0 |
| `claude_code` | `pylint-dev__pylint-4661` | failed | no | 91 | 3080311 | 92576 | 97.66% | 887090 | yes | 0.00% | 0 |
| `claude_code` | `pylint-dev__pylint-4604` | completed | no | 66 | 1896465 | 77535 | 97.33% | 691086 | yes | 0.00% | 0 |
| `claude_code` | `pylint-dev__pylint-6528` | completed | yes | 60 | 1954335 | 33038 | 97.08% | 462497 | yes | 0.00% | 0 |
| `claude_code` | `pytest-dev__pytest-7205` | completed | yes | 51 | 1145029 | 19948 | 95.82% | 382127 | yes | 0.00% | 0 |
| `claude_code` | `pytest-dev__pytest-7432` | completed | no | 74 | 1859003 | 41382 | 94.83% | 504401 | yes | 0.00% | 0 |
| `claude_code` | `pytest-dev__pytest-10356` | failed | no | 52 | 1646190 | 126594 | 97.10% | 902145 | yes | 0.00% | 0 |
| `claude_code` | `scikit-learn__scikit-learn-12973` | completed | yes | 13 | 202991 | 4426 | 90.93% | 66174 | yes | 0.00% | 0 |
| `claude_code` | `scikit-learn__scikit-learn-14496` | completed | yes | 22 | 521956 | 11666 | 93.83% | 198997 | yes | 0.00% | 0 |
| `claude_code` | `scikit-learn__scikit-learn-14087` | failed | no | 6 | 0 | 0 | N/A | 4644 | no | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-10673` | failed | no | 6 | 0 | 0 | N/A | 3898 | no | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8269` | completed | no | 39 | 959556 | 20691 | 96.42% | 252948 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-9229` | completed | no | 88 | 3312821 | 44892 | 97.13% | 720395 | yes | 0.00% | 0 |
| `claude_code` | `sphinx-doc__sphinx-8120` | failed | no | 48 | 1290848 | 99585 | 96.74% | 902411 | no | 0.00% | 0 |
| `claude_code` | `sympy__sympy-19783` | completed | yes | 26 | 606444 | 21609 | 90.51% | 224502 | yes | 0.00% | 0 |
| `claude_code` | `sympy__sympy-19637` | completed | no | 12 | 172300 | 2744 | 95.24% | 91639 | yes | 0.00% | 0 |
| `claude_code` | `sympy__sympy-17139` | completed | yes | 16 | 245331 | 6027 | 96.16% | 108651 | yes | 0.00% | 0 |
| `claude_code` | `sympy__sympy-16792` | completed | yes | 45 | 1540215 | 20695 | 95.29% | 413894 | yes | 0.00% | 0 |
| `mini_swe_agent` | `astropy__astropy-7166` | completed | no | 28 | 156334 | 10077 | 91.86% | 131946 | yes | 0.00% | 0 |
| `mini_swe_agent` | `astropy__astropy-13579` | failed | yes | 60 | 1275881 | 95955 | 95.71% | 670470 | yes | 0.00% | 0 |
| `mini_swe_agent` | `astropy__astropy-13236` | failed | yes | 60 | 888368 | 14979 | 95.38% | 307891 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11066` | completed | yes | 12 | 46660 | 2406 | 83.39% | 51002 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-11490` | completed | yes | 26 | 261974 | 6408 | 92.74% | 115970 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-13964` | completed | yes | 56 | 609620 | 13436 | 95.53% | 250462 | yes | 0.00% | 0 |
| `mini_swe_agent` | `django__django-13089` | failed | no | 60 | 712282 | 66632 | 96.05% | 551717 | yes | 0.00% | 0 |
| `mini_swe_agent` | `matplotlib__matplotlib-22865` | failed | no | 60 | 1158494 | 35895 | 96.50% | 416200 | yes | 0.00% | 0 |
| `mini_swe_agent` | `matplotlib__matplotlib-20488` | failed | no | 60 | 1004294 | 19884 | 96.53% | 349783 | yes | 0.00% | 0 |
| `mini_swe_agent` | `matplotlib__matplotlib-25122` | completed | yes | 42 | 660399 | 9630 | 95.46% | 218787 | yes | 0.00% | 0 |
| `mini_swe_agent` | `mwaskom__seaborn-3069` | failed | no | 1 | 0 | 0 | N/A | 1234 | no | 0.00% | 0 |
| `mini_swe_agent` | `mwaskom__seaborn-3187` | failed | yes | 60 | 774892 | 27823 | 96.37% | 324395 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pallets__flask-5014` | completed | yes | 20 | 128497 | 2735 | 89.05% | 73961 | yes | 0.00% | 0 |
| `mini_swe_agent` | `psf__requests-2931` | completed | no | 51 | 429270 | 17978 | 94.11% | 238095 | yes | 0.00% | 0 |
| `mini_swe_agent` | `psf__requests-1921` | completed | no | 19 | 99608 | 4034 | 88.15% | 76084 | yes | 0.00% | 0 |
| `mini_swe_agent` | `psf__requests-1724` | completed | no | 28 | 211016 | 6143 | 89.17% | 109696 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pydata__xarray-3677` | completed | yes | 15 | 63592 | 2048 | 84.94% | 57866 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pydata__xarray-3095` | completed | yes | 19 | 146250 | 3610 | 89.45% | 80705 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pydata__xarray-6721` | failed | yes | 60 | 1590041 | 50146 | 96.46% | 512988 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pylint-dev__pylint-4661` | failed | no | 1 | 0 | 0 | N/A | 2199 | no | 0.00% | 0 |
| `mini_swe_agent` | `pylint-dev__pylint-4604` | failed | no | 31 | 257899 | 17817 | 93.51% | 201433 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pylint-dev__pylint-6528` | failed | no | 24 | 202701 | 12848 | 91.82% | 156753 | no | 0.00% | 0 |
| `mini_swe_agent` | `pytest-dev__pytest-7205` | completed | yes | 60 | 1150195 | 44911 | 96.31% | 398358 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pytest-dev__pytest-7432` | completed | no | 22 | 227791 | 7629 | 90.69% | 109598 | yes | 0.00% | 0 |
| `mini_swe_agent` | `pytest-dev__pytest-10356` | failed | no | 1 | 0 | 0 | N/A | 2584 | no | 0.00% | 0 |
| `mini_swe_agent` | `scikit-learn__scikit-learn-12973` | completed | yes | 12 | 43583 | 2914 | 82.53% | 50660 | yes | 0.00% | 0 |
| `mini_swe_agent` | `scikit-learn__scikit-learn-14496` | completed | yes | 35 | 500044 | 10242 | 94.87% | 161977 | yes | 0.00% | 0 |
| `mini_swe_agent` | `scikit-learn__scikit-learn-14087` | failed | yes | 60 | 947213 | 31062 | 95.97% | 372476 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-10673` | failed | no | 1 | 0 | 0 | N/A | 3005 | no | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8269` | completed | no | 55 | 926545 | 19957 | 96.47% | 327380 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-9229` | failed | no | 60 | 1247395 | 36584 | 96.54% | 397342 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sphinx-doc__sphinx-8120` | failed | no | 60 | 1183803 | 63146 | 96.66% | 487332 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sympy__sympy-19783` | failed | no | 25 | 274822 | 32382 | 91.66% | 903765 | no | 0.00% | 0 |
| `mini_swe_agent` | `sympy__sympy-19637` | completed | no | 16 | 53260 | 2531 | 82.43% | 72253 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sympy__sympy-17139` | completed | yes | 21 | 101972 | 5610 | 89.37% | 112179 | yes | 0.00% | 0 |
| `mini_swe_agent` | `sympy__sympy-16792` | completed | yes | 29 | 371461 | 18206 | 93.80% | 210082 | yes | 0.00% | 0 |
