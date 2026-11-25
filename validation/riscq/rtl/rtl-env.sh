#!/bin/bash
# Run a command in the RISC-Q RTL environment: bash rtl-env.sh <command...>
ROOT=$HOME/riscq-rtl
export MAMBA_ROOT_PREFIX=$ROOT/mamba
eval "$($ROOT/bin/micromamba shell hook -s bash)"
micromamba activate rtl
export PATH=$ROOT/bin:$PATH
export RISCQ_RVLS=0
cd $ROOT/RISC-Q
exec "$@"
