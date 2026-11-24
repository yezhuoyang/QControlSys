# Helios union-find decoder: source, vectors and firmware images

Files from [Helios](https://github.com/NamiLiy/Helios_scalable_QEC) at commit `622d85d` (BSD-3-Clause, see `LICENSE`), and what this project builds from them.

| File | Origin | Use |
| --- | --- | --- |
| `union_find.c` | `software_code/union_find.c`, unmodified | The decoder. The build sets its `#define D` to the distance, as the upstream README instructs |
| `input_data_3_rsc.txt`, `output_data_3_rsc.txt` | `test_benches/test_data/`, unmodified | Upstream's 1000 test syndromes of distance 3 and the expected root of every node |
| `reference-d3.json`, `reference-d5.json`, `reference-d7.json` | written by `make-reference.mjs` | Sampled syndromes with the roots the upstream program returns when compiled with the host gcc. Distance 3 adds three upstream test cases with upstream's roots |
| `uf-d3.elf`, `uf-d5.elf`, `uf-d7.elf` | written by `make-reference.mjs` | The decoder compiled for a RISC-Q core (`rv32i_zmmul`, RISC-Q's `start.S`, `muldiv.c`, `riscq.h`) with the reference syndromes in RAM |
| `images.json` | written by `make-reference.mjs` | Compiler version, command line and SHA-256 of each image |
| `make-reference.mjs` | this project | Regenerates the references and images. Needs gcc and a clang with the riscv32 target |

SHA-256 of the upstream files, which keep their CRLF line ends:

```
29a8af6baafdd401061e31b7f4f8c2c911733474fd445e1853bafc4dfc866abc  union_find.c
9e3303ce400ced7a7f72684e68772832d9ebf887d9d1cc7de32b4fca284d94d2  input_data_3_rsc.txt
ddfdf802395db3adb899be047faca3b0e6856fa19dc3128a0251f00fc4ebabf1  output_data_3_rsc.txt
```

The decoder reports cluster roots, one word `0x00KKIIJJ` (round, row, column) per node. It does not derive a correction. Syndromes of the reference files are sampled by flipping each edge of upstream's decoding graph with probability 0.001 or 0.01.
