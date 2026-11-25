#!/bin/bash
# User-local toolchain for building and simulating the RISC-Q RTL (no sudo):
# micromamba env with JDK 21 and Verilator 5, the mill launcher, and RISC-Q with submodules.
set -e
ROOT=$HOME/riscq-rtl
mkdir -p $ROOT && cd $ROOT
if [ ! -x bin/micromamba ]; then
  curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj bin/micromamba
fi
export MAMBA_ROOT_PREFIX=$ROOT/mamba
if [ ! -d $MAMBA_ROOT_PREFIX/envs/rtl ]; then
  ./bin/micromamba create -y -n rtl -c conda-forge openjdk=21 verilator=5 make cxx-compiler zlib python=3.11 >/dev/null
fi
eval "$(./bin/micromamba shell hook -s bash)"
micromamba activate rtl
java -version 2>&1 | head -1
verilator --version
if [ ! -x bin/mill ]; then
  curl -L -o bin/mill https://repo1.maven.org/maven2/com/lihaoyi/mill-dist/1.1.0/mill-dist-1.1.0-mill.sh
  chmod +x bin/mill
fi
if [ ! -d RISC-Q ]; then
  git clone https://github.com/Wu-Quantum-Application-System-Group/RISC-Q.git
fi
cd RISC-Q
git submodule update --init
git log --oneline -1
echo SETUP_DONE
