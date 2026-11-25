#!/bin/bash
# Synthesize RISC-Q's PulseTableSoc for one SocSpec with Yosys (synth_xilinx, UltraScale+ family) and
# report the resources per module: LUT, FF, DSP48E2, block RAM (RAMB36E2/RAMB18E2) and UltraRAM (URAM288).
#   bash rtl-env.sh bash /mnt/.../synth.sh <spec.json, relative to the RISC-Q checkout> <out-dir>
# The RTL comes from RISC-Q's own GenPulseTableSocJson for the same spec. Vivado is not used (it needs a
# licence), so the counts are Yosys's technology mapping of the same RTL to the same primitives: they
# are checked against RISC-Q's Vivado result of record for x6y3 (vivado-scripts/riscvsoc-bd/README.md).
set -e
SPEC=$1
OUT=$2
mkdir -p $OUT
[ -f $OUT/PulseTableSoc.v ] || flock /tmp/quantumos-riscq-mill.lock mill runMain riscq.soc.GenPulseTableSocJson $SPEC $OUT > $OUT/gen.log 2>&1
cd $OUT
cat > synth.ys <<'EOS'
read_verilog -sv PulseTableSoc.v
# RISC-Q's UltraRAM template (byte-write true dual port with output pipeline) is kept as a black box:
# Yosys's URAM mapper has no match for it. Its URAM288 count is its depth × width over 4096 × 72.
blackbox xilinx_ultraram_true_dual_port_bytewrite
hierarchy -top PulseTableSoc
synth_xilinx -family xcup -top PulseTableSoc -noiopad
tee -o stat.txt stat -tech xilinx
tee -q -o stat.json stat -json -tech xilinx
EOS
yosys -q -l synth.log synth.ys
echo SYNTH_DONE
