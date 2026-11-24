/* File layer for bare-metal RISC-Q firmware (riscq/decoders/libc/rq_libc.c). It lets a
 * program written against <stdio.h> files run unmodified on a control core: reads come from
 * a word stream in the core's RAM, and each written line is one word in the host window. */
#ifndef RQ_STDIO_H
#define RQ_STDIO_H

#include <stddef.h>

typedef struct rq_file FILE;

FILE *fopen(const char *name, const char *mode);
int fclose(FILE *file);
int fscanf(FILE *file, const char *format, ...);
int fprintf(FILE *file, const char *format, ...);
int printf(const char *format, ...);
int sprintf(char *text, const char *format, ...);

#endif
