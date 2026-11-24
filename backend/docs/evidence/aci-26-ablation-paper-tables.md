## ACI Governance Benchmark Summary (agent-us-aci-governance-2.4-s4, suite=aci26, mode=real, sandbox=docker)

### Table 1: Overall Arm Comparison & Success-Normalized Efficiency

| Arm | Profile | Pass (n/N) | Pass Rate (Wilson 95% CI) | Recall | Precision | Useful Tok | Mean Tok | Tok/Pass | Mean Passed Tok | Paired-Pass Tok Red | Cache Hit | Sup Tok | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `raw_full` | 7/14 | 50.0% [26.8%, 73.2%] | 100.0% | 85.1% | 61.8% | 163,670 | 327,339 | 161,944 | 0.0% (n=7) | 68.7% | 0 | 0.0% |
| C | `retrieval_supervisor` | 7/14 | 50.0% [26.8%, 73.2%] | 100.0% | 97.4% | 92.7% | 185,274 | 370,548 | 184,804 | 2.5% (n=3) | 69.4% | 87,415 | 100.0% |
| D | `full_aci` | 8/14 | 57.1% [32.6%, 78.6%] | 100.0% | 97.6% | 97.3% | 173,786 | 304,125 | 154,568 | 11.3% (n=5) | 67.8% | 86,943 | 100.0% |

### Table 2: Per-Task Breakdown

| Task | Arm | Pass (n/N) | Mean Tok | Paired-Pass Tok Red | Recall | Precision | Cache Hit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `aci-01-auth-tenant-boundary` | A | 2/2 | 163,800 | 0.0% (n=2) | 100.0% | 87.5% | 82.9% |
| `aci-01-auth-tenant-boundary` | C | 1/2 | 165,913 | -6.4% (n=1) | 100.0% | 100.0% | 85.2% |
| `aci-01-auth-tenant-boundary` | D | 1/2 | 154,253 | 23.8% (n=1) | 100.0% | 100.0% | 80.8% |
| `aci-02-persistence-wal-ledger` | A | 1/2 | 159,452 | 0.0% (n=1) | 100.0% | 95.0% | 87.6% |
| `aci-02-persistence-wal-ledger` | C | 2/2 | 145,089 | 4.7% (n=1) | 100.0% | 100.0% | 89.7% |
| `aci-02-persistence-wal-ledger` | D | 2/2 | 146,983 | 3.2% (n=1) | 100.0% | 100.0% | 88.8% |
| `aci-03-contract-pipeline-refactor` | A | 2/2 | 153,887 | 0.0% (n=2) | 100.0% | 89.9% | 89.9% |
| `aci-03-contract-pipeline-refactor` | C | 1/2 | 154,352 | 8.2% (n=1) | 100.0% | 90.9% | 89.6% |
| `aci-03-contract-pipeline-refactor` | D | 2/2 | 126,601 | 17.7% (n=2) | 100.0% | 100.0% | 80.6% |
| `aci-04-long-horizon-security-audit` | A | 0/2 | 221,722 | N/A | 100.0% | 80.1% | 42.0% |
| `aci-04-long-horizon-security-audit` | C | 1/2 | 212,092 | N/A | 100.0% | 95.5% | 91.2% |
| `aci-04-long-horizon-security-audit` | D | 0/2 | 227,336 | N/A | 100.0% | 87.5% | 40.7% |
| `aci-05-multi-module-patch-refactor` | A | 1/2 | 162,975 | 0.0% (n=1) | 100.0% | 69.0% | 45.0% |
| `aci-05-multi-module-patch-refactor` | C | 1/2 | 189,136 | N/A | 100.0% | 95.5% | 84.3% |
| `aci-05-multi-module-patch-refactor` | D | 2/2 | 164,523 | -8.4% (n=1) | 100.0% | 100.0% | 82.4% |
| `aci-06-swarm-contract-integration` | A | 0/2 | 76,236 | N/A | 100.0% | 87.5% | 41.3% |
| `aci-06-swarm-contract-integration` | C | 0/2 | 175,973 | N/A | 100.0% | 100.0% | 25.1% |
| `aci-06-swarm-contract-integration` | D | 1/2 | 168,611 | N/A | 100.0% | 100.0% | 88.1% |
| `aci-07-cross-module-evolution` | A | 1/2 | 207,617 | 0.0% (n=1) | 100.0% | 86.7% | 82.5% |
| `aci-07-cross-module-evolution` | C | 1/2 | 254,366 | N/A | 100.0% | 100.0% | 35.4% |
| `aci-07-cross-module-evolution` | D | 0/2 | 228,196 | N/A | 100.0% | 95.8% | 41.2% |

### Table 3: ACI 2.6 Trajectory Eviction, Partial Recovery & Admission Decisions

| Arm | Superseded Evictions | Superseded Saved Tok | Partial Recoveries | Recovery Saved Tok | Anti-Thrashing | Decisions (D/S/Def/Dup/Irr) |
| --- | --- | --- | --- | --- | --- | --- |
| A | 0 | 0 | 0 | 0 | 0 | 168/0/0/0/0 |
| C | 0 | 0 | 13 | 8,782 | 0 | 256/25/1/2/34 |
| D | 45 | 20,972 | 13 | 2,232 | 0 | 249/27/0/1/25 |
