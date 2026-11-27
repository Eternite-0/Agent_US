# SWE-bench Verified Benchmark Summary

- **Benchmark**: agent-us-swebench-verified v1.0.0
- **Mode**: dataset
- **Model**: deepseek-v4.1-flash
- **Max Steps**: 60
- **Arms**: raw_full, full_aci, claude_code, mini_swe_agent
- **Resumed**: false
- **Updated At**: 2026-11-27T01:18:37.632Z

## Per-Arm Metrics

| Arm | Instances | Resolved Rate (%) | Tokens / Resolved | Paired Resolved Token Reduction | Total Input Tokens | Total Output Tokens | Real Provider Cache Hit Rate | Steps (Mean) | Wall-Clock Time (ms) | Non-Empty Patch Rate | ACI Admission Token Reduction Rate | DTOC Epoch Transitions | Supervisor Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw_full` | 29/36 | 60.61% (20/33) | 1276461 | 0.00% (n=20) | 24331002 | 1198224 | 96.05% (23371136/24331002, n=34) | 1328 (36.8889) | 11610230 | 86.11% (31/36) | 0.00% (0/0) | 0 | 0 calls / 0 tok / 0 ms |
| `full_aci` | 30/36 | 59.38% (19/32) | 1366838 | -22.04% (n=19) | 24764458 | 1205472 | 96.10% (23799168/24764458, n=32) | 1297 (36.0278) | 11353644 | 88.89% (32/36) | 12.34% (58165/471304) | 0 | 0 calls / 0 tok / 0 ms |
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
| `full_aci` | `astropy__astropy-7166` | completed | no | 52 | 841016 | 24552 | 95.73% | 326073 | yes | 5.34% | 0 |
| `full_aci` | `astropy__astropy-13579` | completed | yes | 24 | 350807 | 14408 | 93.48% | 151122 | yes | 4.80% | 0 |
| `full_aci` | `astropy__astropy-13236` | completed | yes | 42 | 558684 | 10849 | 95.47% | 228101 | yes | 21.72% | 0 |
| `full_aci` | `django__django-11066` | completed | yes | 10 | 62550 | 2536 | 86.77% | 48471 | yes | 5.09% | 0 |
| `full_aci` | `django__django-11490` | completed | yes | 34 | 376039 | 7847 | 95.17% | 158349 | yes | 5.46% | 0 |
| `full_aci` | `django__django-13964` | completed | yes | 33 | 311988 | 5634 | 94.85% | 155540 | yes | 3.58% | 0 |
| `full_aci` | `django__django-13089` | completed | yes | 49 | 732480 | 66087 | 95.87% | 585025 | yes | 5.65% | 0 |
| `full_aci` | `matplotlib__matplotlib-22865` | completed | no | 60 | 1225937 | 78264 | 96.96% | 696485 | yes | 8.81% | 0 |
| `full_aci` | `matplotlib__matplotlib-20488` | completed | yes | 49 | 906197 | 74698 | 93.79% | 628323 | yes | 15.55% | 0 |
| `full_aci` | `matplotlib__matplotlib-25122` | completed | yes | 34 | 666616 | 31201 | 94.74% | 307181 | yes | 10.14% | 0 |
| `full_aci` | `mwaskom__seaborn-3069` | env_error | - | 1 | 0 | 0 | N/A | 1311 | no | 0.00% | 0 |
| `full_aci` | `mwaskom__seaborn-3187` | completed | yes | 60 | 1603636 | 38616 | 94.74% | 520945 | yes | 18.24% | 0 |
| `full_aci` | `pallets__flask-5014` | completed | yes | 9 | 46970 | 1278 | 89.11% | 36660 | yes | 0.00% | 0 |
| `full_aci` | `psf__requests-2931` | completed | no | 27 | 264535 | 18041 | 93.10% | 183831 | yes | 7.65% | 0 |
| `full_aci` | `psf__requests-1921` | completed | no | 8 | 37205 | 2124 | 84.63% | 34526 | yes | 0.00% | 0 |
| `full_aci` | `psf__requests-1724` | completed | no | 8 | 56680 | 1711 | 90.11% | 40180 | yes | 0.00% | 0 |
| `full_aci` | `pydata__xarray-3677` | completed | yes | 23 | 289331 | 6977 | 93.26% | 128678 | yes | 10.19% | 0 |
| `full_aci` | `pydata__xarray-3095` | completed | yes | 60 | 1134474 | 16040 | 96.81% | 289051 | yes | 3.33% | 0 |
| `full_aci` | `pydata__xarray-6721` | completed | yes | 60 | 1592717 | 29483 | 97.48% | 382587 | yes | 3.77% | 0 |
| `full_aci` | `pylint-dev__pylint-4661` | cancelled | no | 51 | 965746 | 144654 | 96.12% | 901790 | yes | 13.91% | 0 |
| `full_aci` | `pylint-dev__pylint-4604` | completed | no | 60 | 1252084 | 35289 | 96.87% | 440938 | yes | 13.73% | 0 |
| `full_aci` | `pylint-dev__pylint-6528` | completed | yes | 60 | 1437428 | 59073 | 97.03% | 530988 | yes | 13.31% | 0 |
| `full_aci` | `pytest-dev__pytest-7205` | completed | yes | 60 | 1132889 | 30370 | 96.81% | 368168 | yes | 30.48% | 0 |
| `full_aci` | `pytest-dev__pytest-7432` | completed | no | 48 | 852120 | 36837 | 96.14% | 375562 | yes | 27.13% | 0 |
| `full_aci` | `pytest-dev__pytest-10356` | completed | no | 60 | 1358791 | 104092 | 96.95% | 749310 | yes | 6.80% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-12973` | completed | yes | 33 | 525670 | 17462 | 94.67% | 204544 | yes | 6.75% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-14496` | completed | yes | 54 | 1123646 | 50137 | 96.62% | 454859 | yes | 2.30% | 0 |
| `full_aci` | `scikit-learn__scikit-learn-14087` | completed | yes | 60 | 1290211 | 49513 | 97.05% | 490004 | yes | 11.83% | 0 |
| `full_aci` | `sphinx-doc__sphinx-10673` | env_error | - | 1 | 0 | 0 | N/A | 3052 | no | 0.00% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8269` | completed | no | 10 | 62829 | 1855 | 87.20% | 42292 | yes | 22.79% | 0 |
| `full_aci` | `sphinx-doc__sphinx-9229` | completed | no | 60 | 1536223 | 104777 | 96.97% | 800477 | yes | 9.98% | 0 |
| `full_aci` | `sphinx-doc__sphinx-8120` | env_error | - | 1 | 0 | 0 | N/A | 2664 | no | 0.00% | 0 |
| `full_aci` | `sympy__sympy-19783` | env_error | - | 1 | 0 | 0 | N/A | 3654 | no | 0.00% | 0 |
| `full_aci` | `sympy__sympy-19637` | completed | no | 12 | 54897 | 2826 | 86.74% | 67993 | yes | 0.00% | 0 |
| `full_aci` | `sympy__sympy-17139` | failed | yes | 23 | 164058 | 12911 | 93.31% | 147979 | yes | 0.00% | 0 |
| `full_aci` | `sympy__sympy-16792` | completed | no | 60 | 1950004 | 125330 | 97.02% | 866931 | yes | 18.94% | 0 |
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
