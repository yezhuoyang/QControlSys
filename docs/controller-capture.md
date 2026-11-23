# Comparing a synchronized controller acquisition

Open **Compare a trigger-aligned capture** on the waveform controller. The same comparison runs locally from the project directory with `node validation/board/compare.mjs program.json capture.json`. A digital disagreement returns exit status 2. The report supplies timing and voltage errors in their original units.

The input JSON has `kind` equal to `controller-path-capture`, `version` equal to 1, four nonempty strings named `board`, `firmware`, `trigger` and `connector`, and an `observations` object with these four arrays. The strings identify the acquisition, including the trigger edge used as time zero and the output connector and load.

| Array | Fields per observation | Acquisition point |
| --- | --- | --- |
| issue | atPs, pc, op | Accepted instruction, zero-based program counter and decoded operation name in the loaded program |
| bus | atPs, address, words | Accepted DMA beat, first waveform RAM word address and signed 16-bit samples in transmission order |
| strobe | atPs, code | DAC sample strobe and signed converter code |
| output | atPs, uv | Connector voltage in microvolts at the actual scope sampling instant |

For example an accepted bus beat can be represented by `{"atPs":8000,"address":0,"words":[0,1024]}`. Each channel uses strictly increasing integer picoseconds relative to the common trigger. A simultaneous event on two channels carries the same timestamp. Each digital array covers the whole program. Connector samples may use their own grid anywhere from program start to the end of the replay. The model holds its sampled voltage between strobes, including the initial value before the first strobe.

The comparison pairs digital events by acquisition order and reports counts, payload disagreements, the first divergent row and corresponding simulator event ID. The maximum absolute timestamp difference is computed across paired rows. A missing or extra digital event can shift subsequent ordinal pairs. The voltage report compares against the modeled output at each original timestamp. Timing and voltage acceptance limits depend on the board and instruments. No channel-specific time shifts or voltage fits are applied.
