HotpotQA distractor dev, 7405 questions, BM25 over the 10 paragraphs (tail disabled: verbatim picks only)

| Arm | Both gold paragraphs kept | Gold paragraphs kept | Avg tokens | Tokens saved vs send-all |
|---|---|---|---|---|
| send all 10 | 100.0% | 100.0% | 1433 | 0.0% |
| top-2 | 31.5% | 62.0% | 262 | 81.7% |
| cabar, 2 units | 32.7% | 62.8% | 205 | 85.7% |
| top-k at cabar-2 tokens | 30.0% | 60.1% | 253 | 82.3% |
| cabar, 2 units, costExponent 0.5 | 33.8% | 63.8% | 226 | 84.2% |
| top-3 | 48.1% | 72.2% | 413 | 71.2% |
| cabar, 3 units | 50.6% | 73.7% | 331 | 76.9% |
| top-k at cabar-3 tokens | 44.8% | 69.7% | 391 | 72.7% |
| cabar, 3 units, costExponent 0.5 | 50.4% | 73.8% | 365 | 74.6% |
| top-4 | 59.4% | 78.7% | 566 | 60.5% |
| cabar, 4 units | 62.7% | 80.5% | 470 | 67.2% |
| top-k at cabar-4 tokens | 55.5% | 76.1% | 535 | 62.7% |
| cabar, 4 units, costExponent 0.5 | 61.4% | 80.0% | 513 | 64.2% |
