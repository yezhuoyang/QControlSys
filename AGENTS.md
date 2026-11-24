# QuantumOS development rule

Every simulated operation must have an executable program representation, a clear physical 3D representation, and a debugger step with a reconstructible state. Keep machine, program, calibration and display geometry explicit. Document units, approximation boundaries and evidence for timing or physical parameters.

Derive the trace from the execution semantics. Derive active hardware, signal plots and inspector values from that trace. Each new operation needs a stable ID, a component in the 3D scene, its causal predecessors, and its state transition. A person and a headless agent must be able to replay the same program and inspect the same result.

Put statements about the verified model beside their proofs. Distinguish those properties from conformance tests, schematic geometry and measured hardware behavior.
