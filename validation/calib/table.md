# System-call calibration

Generated 2026-11-25T13:24:40.709Z from 65 conforming runs.

| Platform | Design | Field | Programs | Ops | Derived | Needed min / p50 / p99 / max | Slack at p50 | Audits |
|---|---|---|---|---|---|---|---|---|
| neutral | atoms-moving | `reset_ns` | 11 | 2280 | 100000 | 100000 / 100000 / 100000 / 100000 | 0 | Zhou2025 1000, CainXu2026 100000 |
| neutral | atoms-moving | `gate1q_ns` | 11 | 1297 | 8000 | 8000 / 8000 / 8000 / 8000 | 0 | Zhou2025 1000, CainXu2026 10000 |
| neutral | atoms-moving | `route_latency_ns` | 11 | 2390 | 187570 | 73340 / 92766 / 161114 / 187568 | 94804 | Zhou2025 500000, CainXu2026 1000 |
| neutral | atoms-moving | `gate2q_ns` | 11 | 7681 | 16270 | 270 / 16270 / 16270 / 16270 | 0 | Zhou2025 100000, CainXu2026 20000 |
| neutral | atoms-moving | `measure_ns` | 11 | 2413 | 508070 | 500066 / 508066 / 508066 / 508066 | 4 | Zhou2025 500000, CainXu2026 400000 |
| neutral | atoms-moving | `decoder_latency_ns` | 11 | 66 | 190480 | 154 / 35678 / 190480 / 190480 | 154802 | Zhou2025 1.00e+6, CainXu2026 1.00e+6 |
| neutral | atoms-moving | `pauli_frame_update_ns` | 6 | 9 | 330 | 182 / 182 / 322 / 322 | 148 | Zhou2025 40, CainXu2026 1000 |
| neutral | atoms-moving | `magic_state_latency_ns` | 1 | 2 | 2.07e+6 | 2.07e+6 / 2.07e+6 / 2.07e+6 / 2.07e+6 | 0 | Zhou2025 3.40e+7, CainXu2026 1000 |
| neutral | atoms-moving | `decoders` | – | – | 1 | derived | – | Zhou2025 100000, CainXu2026 1.00e+12 |
| neutral | atoms-moving | `classical_data_bandwidth` | – | – | 100 | derived | – | Zhou2025 1.00e+8, CainXu2026 1.00e+6 |
| neutral | atoms-moving | `max_parallel_gates` | – | – | 16 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-moving | `qubit_routing_bandwidth` | – | – | 4 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-moving | `ancilla_bandwidth` | – | – | 64 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-moving | `factories` | – | – | 1 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-moving | `qubits` | – | – | 131 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-static | `reset_ns` | 11 | 2280 | 100000 | 100000 / 100000 / 100000 / 100000 | 0 | Zhou2025 1000, CainXu2026 100000 |
| neutral | atoms-static | `gate1q_ns` | 11 | 1297 | 8000 | 8000 / 8000 / 8000 / 8000 | 0 | Zhou2025 1000, CainXu2026 10000 |
| neutral | atoms-static | `route_latency_ns` | 11 | 2390 | 117440 | 0 / 0 / 95016 / 117440 | 117440 | Zhou2025 500000, CainXu2026 1000 |
| neutral | atoms-static | `gate2q_ns` | 11 | 7681 | 16270 | 270 / 16270 / 16270 / 16270 | 0 | Zhou2025 100000, CainXu2026 20000 |
| neutral | atoms-static | `measure_ns` | 11 | 2413 | 508070 | 500066 / 508066 / 508066 / 508066 | 4 | Zhou2025 500000, CainXu2026 400000 |
| neutral | atoms-static | `decoder_latency_ns` | 11 | 66 | 190480 | 154 / 35678 / 190480 / 190480 | 154802 | Zhou2025 1.00e+6, CainXu2026 1.00e+6 |
| neutral | atoms-static | `pauli_frame_update_ns` | 6 | 9 | 330 | 182 / 182 / 322 / 322 | 148 | Zhou2025 40, CainXu2026 1000 |
| neutral | atoms-static | `magic_state_latency_ns` | 1 | 2 | 2.07e+6 | 2.07e+6 / 2.07e+6 / 2.07e+6 / 2.07e+6 | 0 | Zhou2025 3.40e+7, CainXu2026 1000 |
| neutral | atoms-static | `decoders` | – | – | 1 | derived | – | Zhou2025 100000, CainXu2026 1.00e+12 |
| neutral | atoms-static | `classical_data_bandwidth` | – | – | 100 | derived | – | Zhou2025 1.00e+8, CainXu2026 1.00e+6 |
| neutral | atoms-static | `max_parallel_gates` | – | – | 16 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-static | `qubit_routing_bandwidth` | – | – | 4 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-static | `ancilla_bandwidth` | – | – | 64 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-static | `factories` | – | – | 1 | derived | – | Zhou2025 –, CainXu2026 – |
| neutral | atoms-static | `qubits` | – | – | 131 | derived | – | Zhou2025 –, CainXu2026 – |
| qccd | ions-modules | `reset_ns` | 11 | 2280 | 10000 | 10000 / 10000 / 10000 / 10000 | 0 | – |
| qccd | ions-modules | `gate1q_ns` | 11 | 1297 | 5000 | 5000 / 5000 / 5000 / 5000 | 0 | – |
| qccd | ions-modules | `route_latency_ns` | 11 | 2390 | 1.50e+6 | 0 / 0 / 1.37e+6 / 1.50e+6 | 1.50e+6 | – |
| qccd | ions-modules | `gate2q_ns` | 11 | 7681 | 35000 | 25000 / 35000 / 35000 / 35000 | 0 | – |
| qccd | ions-modules | `measure_ns` | 11 | 2413 | 125070 | 120066 / 125066 / 125066 / 125066 | 4 | – |
| qccd | ions-modules | `decoder_latency_ns` | 11 | 66 | 190630 | 154 / 35678 / 190480 / 190480 | 154952 | – |
| qccd | ions-modules | `pauli_frame_update_ns` | 6 | 9 | 330 | 182 / 182 / 322 / 322 | 148 | – |
| qccd | ions-modules | `magic_state_latency_ns` | 1 | 2 | 886530 | 886530 / 886530 / 886530 / 886530 | 0 | – |
| qccd | ions-modules | `decoders` | – | – | 1 | derived | – | – |
| qccd | ions-modules | `classical_data_bandwidth` | – | – | 100 | derived | – | – |
| qccd | ions-modules | `max_parallel_gates` | – | – | 16 | derived | – | – |
| qccd | ions-modules | `qubit_routing_bandwidth` | – | – | 32 | derived | – | – |
| qccd | ions-modules | `ancilla_bandwidth` | – | – | 64 | derived | – | – |
| qccd | ions-modules | `factories` | – | – | 1 | derived | – | – |
| qccd | ions-modules | `qubits` | – | – | 131 | derived | – | – |
| qccd | ions-qccd | `reset_ns` | 10 | 2206 | 10000 | 10000 / 10000 / 10000 / 10000 | 0 | – |
| qccd | ions-qccd | `gate1q_ns` | 10 | 1254 | 5000 | 5000 / 5000 / 5000 / 5000 | 0 | – |
| qccd | ions-qccd | `route_latency_ns` | 10 | 2312 | 1.50e+6 | 869800 / 1.05e+6 / 1.31e+6 / 1.50e+6 | 446600 | – |
| qccd | ions-qccd | `gate2q_ns` | 10 | 7426 | 35000 | 25000 / 35000 / 35000 / 35000 | 0 | – |
| qccd | ions-qccd | `measure_ns` | 10 | 2334 | 125070 | 120066 / 125066 / 125066 / 125066 | 4 | – |
| qccd | ions-qccd | `decoder_latency_ns` | 10 | 64 | 190630 | 154 / 35678 / 190480 / 190480 | 154952 | – |
| qccd | ions-qccd | `pauli_frame_update_ns` | 5 | 8 | 330 | 182 / 182 / 322 / 322 | 148 | – |
| qccd | ions-qccd | `magic_state_latency_ns` | 1 | 2 | 886530 | 886530 / 886530 / 886530 / 886530 | 0 | – |
| qccd | ions-qccd | `decoders` | – | – | 1 | derived | – | – |
| qccd | ions-qccd | `classical_data_bandwidth` | – | – | 100 | derived | – | – |
| qccd | ions-qccd | `max_parallel_gates` | – | – | 16 | derived | – | – |
| qccd | ions-qccd | `qubit_routing_bandwidth` | – | – | 32 | derived | – | – |
| qccd | ions-qccd | `ancilla_bandwidth` | – | – | 64 | derived | – | – |
| qccd | ions-qccd | `factories` | – | – | 1 | derived | – | – |
| qccd | ions-qccd | `qubits` | – | – | 131 | derived | – | – |
| superconducting | sc-A | `reset_ns` | 11 | 2280 | 160 | 160 / 160 / 160 / 160 | 0 | GE2021 250, Gidney2025 250, Beverland2022 100, Pinnacle 200, Jacinto2026 250 |
| superconducting | sc-A | `gate1q_ns` | 11 | 1297 | 36 | 36 / 36 / 36 / 36 | 0 | GE2021 25, Gidney2025 25, Beverland2022 50, Pinnacle 100, Jacinto2026 25 |
| superconducting | sc-A | `route_latency_ns` | 11 | 2390 | 2 | 0 / 0 / 0 / 0 | 2 | GE2021 100, Gidney2025 100, Beverland2022 400, Pinnacle 1000, Jacinto2026 100 |
| superconducting | sc-A | `gate2q_ns` | 11 | 7681 | 472 | 400 / 472 / 472 / 472 | 0 | GE2021 50, Gidney2025 50, Beverland2022 50, Pinnacle 100, Jacinto2026 50 |
| superconducting | sc-A | `measure_ns` | 11 | 2413 | 1440 | 1044 / 1236 / 1440 / 1440 | 204 | GE2021 550, Gidney2025 550, Beverland2022 100, Pinnacle 200, Jacinto2026 475 |
| superconducting | sc-A | `decoder_latency_ns` | 11 | 66 | 2.02e+6 | 154 / 71356 / 761920 / 761920 | 1.94e+6 | GE2021 10000, Gidney2025 10000, Beverland2022 10000, Pinnacle 10000, Jacinto2026 10000 |
| superconducting | sc-A | `pauli_frame_update_ns` | 6 | 9 | 322 | 182 / 182 / 322 / 322 | 140 | GE2021 40, Gidney2025 40, Beverland2022 40, Pinnacle 40, Jacinto2026 40 |
| superconducting | sc-A | `magic_state_latency_ns` | 1 | 2 | 135000 | 81724 / 81724 / 81724 / 81724 | 53276 | GE2021 135000, Gidney2025 150000, Beverland2022 72800, Pinnacle 18000, Jacinto2026 109300 |
| superconducting | sc-A | `decoders` | – | – | 1 | derived | – | GE2021 12276, Gidney2025 1550, Beverland2022 25481, Pinnacle 166, Jacinto2026 100000 |
| superconducting | sc-A | `classical_data_bandwidth` | – | – | 500 | derived | – | GE2021 1.79e+7, Gidney2025 922272, Beverland2022 4.31e+7, Pinnacle 2.40e+7, Jacinto2026 1.00e+8 |
| superconducting | sc-A | `max_parallel_gates` | – | – | 131 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-A | `qubit_routing_bandwidth` | – | – | 65500 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-A | `ancilla_bandwidth` | – | – | 819 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-A | `factories` | – | – | 1 | provisional | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-A | `qubits` | – | – | 131 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-B | `reset_ns` | 11 | 2280 | 160 | 160 / 160 / 160 / 160 | 0 | GE2021 250, Gidney2025 250, Beverland2022 100, Pinnacle 200, Jacinto2026 250 |
| superconducting | sc-B | `gate1q_ns` | 11 | 1297 | 36 | 36 / 36 / 36 / 36 | 0 | GE2021 25, Gidney2025 25, Beverland2022 50, Pinnacle 100, Jacinto2026 25 |
| superconducting | sc-B | `route_latency_ns` | 11 | 2390 | 2 | 0 / 0 / 0 / 0 | 2 | GE2021 100, Gidney2025 100, Beverland2022 400, Pinnacle 1000, Jacinto2026 100 |
| superconducting | sc-B | `gate2q_ns` | 11 | 7681 | 472 | 400 / 472 / 472 / 472 | 0 | GE2021 50, Gidney2025 50, Beverland2022 50, Pinnacle 100, Jacinto2026 50 |
| superconducting | sc-B | `measure_ns` | 11 | 2413 | 1440 | 1044 / 1236 / 1440 / 1440 | 204 | GE2021 550, Gidney2025 550, Beverland2022 100, Pinnacle 200, Jacinto2026 475 |
| superconducting | sc-B | `decoder_latency_ns` | 11 | 66 | 191410 | 154 / 35678 / 190520 / 190520 | 155732 | GE2021 10000, Gidney2025 10000, Beverland2022 10000, Pinnacle 10000, Jacinto2026 10000 |
| superconducting | sc-B | `pauli_frame_update_ns` | 6 | 9 | 322 | 182 / 182 / 322 / 322 | 140 | GE2021 40, Gidney2025 40, Beverland2022 40, Pinnacle 40, Jacinto2026 40 |
| superconducting | sc-B | `magic_state_latency_ns` | 1 | 2 | 135000 | 81724 / 81724 / 81724 / 81724 | 53276 | GE2021 135000, Gidney2025 150000, Beverland2022 72800, Pinnacle 18000, Jacinto2026 109300 |
| superconducting | sc-B | `decoders` | – | – | 2 | derived | – | GE2021 12276, Gidney2025 1550, Beverland2022 25481, Pinnacle 166, Jacinto2026 100000 |
| superconducting | sc-B | `classical_data_bandwidth` | – | – | 500 | derived | – | GE2021 1.79e+7, Gidney2025 922272, Beverland2022 4.31e+7, Pinnacle 2.40e+7, Jacinto2026 1.00e+8 |
| superconducting | sc-B | `max_parallel_gates` | – | – | 131 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-B | `qubit_routing_bandwidth` | – | – | 65500 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-B | `ancilla_bandwidth` | – | – | 819 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-B | `factories` | – | – | 1 | provisional | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |
| superconducting | sc-B | `qubits` | – | – | 131 | derived | – | GE2021 –, Gidney2025 –, Beverland2022 –, Pinnacle –, Jacinto2026 – |

Not conforming or failed:

- measurement-d3 on ions-qccd: listing line 143: zone of the route's hub is full (12 ions, capacity 12; the route gathers 13; others there: )
