LongMemEval-S, BM25 top-24 pool, 443 questions with evidence in the pool (57 skipped: retriever missed all evidence)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 6756 | 0.0% |
| top-8 | 84.6% | 79.2% | 84.6% | 2052 | 69.6% |
| cabar | 90.3% | 86.2% | 93.6% | 1432 | 78.8% |
| top-k @ cabar tokens | 78.8% | 74.3% | 78.8% | 1728 | 74.4% |
| cabar capped-adaptive | 75.1% | 66.8% | 91.6% | 890 | 86.8% |
| top-k @ capped tokens | 72.6% | 66.4% | 72.6% | 1144 | 83.1% |
| prism | 93.6% | 91.0% | 94.6% | 2481 | 63.3% |

knowledge-update (72 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 6324 | 0.0% |
| top-8 | 92.1% | 87.5% | 92.1% | 1949 | 69.2% |
| cabar | 93.5% | 87.5% | 97.1% | 1382 | 78.1% |
| top-k @ cabar tokens | 89.2% | 83.3% | 89.2% | 1659 | 73.8% |
| cabar capped-adaptive | 82.7% | 72.2% | 96.4% | 835 | 86.8% |
| top-k @ capped tokens | 84.9% | 77.8% | 84.9% | 1050 | 83.4% |
| prism | 95.7% | 91.7% | 97.1% | 2362 | 62.7% |

multi-session (118 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 7155 | 0.0% |
| top-8 | 75.5% | 61.9% | 75.5% | 2222 | 68.9% |
| cabar | 87.8% | 78.8% | 90.4% | 1454 | 79.7% |
| top-k @ cabar tokens | 65.9% | 53.4% | 65.9% | 1781 | 75.1% |
| cabar capped-adaptive | 65.5% | 50.0% | 86.5% | 925 | 87.1% |
| top-k @ capped tokens | 57.2% | 42.4% | 57.2% | 1266 | 82.3% |
| prism | 92.6% | 87.3% | 92.6% | 2610 | 63.5% |

single-session-assistant (52 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 6797 | 0.0% |
| top-8 | 98.1% | 98.1% | 98.1% | 2001 | 70.6% |
| cabar | 88.5% | 88.5% | 98.1% | 1490 | 78.1% |
| top-k @ cabar tokens | 94.2% | 94.2% | 94.2% | 1828 | 73.1% |
| cabar capped-adaptive | 61.5% | 61.5% | 98.1% | 920 | 86.5% |
| top-k @ capped tokens | 94.2% | 94.2% | 94.2% | 1081 | 84.1% |
| prism | 94.2% | 94.2% | 98.1% | 2511 | 63.1% |

single-session-preference (20 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 4610 | 0.0% |
| top-8 | 70.4% | 60.0% | 70.4% | 1378 | 70.1% |
| cabar | 81.5% | 75.0% | 88.9% | 1104 | 76.1% |
| top-k @ cabar tokens | 55.6% | 55.0% | 55.6% | 1285 | 72.1% |
| cabar capped-adaptive | 59.3% | 50.0% | 85.2% | 815 | 82.3% |
| top-k @ capped tokens | 51.9% | 50.0% | 51.9% | 1033 | 77.6% |
| prism | 85.2% | 80.0% | 88.9% | 1661 | 64.0% |

single-session-user (62 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 6153 | 0.0% |
| top-8 | 95.3% | 95.2% | 95.3% | 1976 | 67.9% |
| cabar | 96.9% | 96.8% | 96.9% | 1306 | 78.8% |
| top-k @ cabar tokens | 93.8% | 93.5% | 93.8% | 1555 | 74.7% |
| cabar capped-adaptive | 93.8% | 93.5% | 96.9% | 810 | 86.8% |
| top-k @ capped tokens | 90.6% | 90.3% | 90.6% | 1065 | 82.7% |
| prism | 96.9% | 96.8% | 96.9% | 2257 | 63.3% |

temporal-reasoning (119 q)

| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|---|
| send-all | 100.0% | 100.0% | 100.0% | 7278 | 0.0% |
| top-8 | 84.9% | 78.2% | 84.9% | 2119 | 70.9% |
| cabar | 90.6% | 88.2% | 93.4% | 1534 | 78.9% |
| top-k @ cabar tokens | 80.7% | 73.9% | 80.7% | 1837 | 74.8% |
| cabar capped-adaptive | 80.2% | 71.4% | 91.5% | 930 | 87.2% |
| top-k @ capped tokens | 73.1% | 61.3% | 73.1% | 1168 | 84.0% |
| prism | 93.4% | 91.6% | 94.3% | 2668 | 63.3% |
