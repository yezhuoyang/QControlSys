/* File layer for bare-metal RISC-Q firmware.
 *
 * Input.  fopen(name, "r") opens the word stream `rq_input` that the build places in RAM.
 *         Each fscanf conversion returns the next word. After the last word of a record of
 *         `rq_record_words` words, the layer reads the batch-time register, so the trace shows
 *         when a record was complete. At the end of the stream fscanf returns EOF.
 * Output. fopen(name, "wb") opens the core's host window. fprintf builds one 32-bit word per
 *         line from the hexadecimal digits of the line: literal digits and %0NX conversions,
 *         most significant first. The word is stored to the next host-window slot. The words
 *         in the host window are therefore the lines of the file, read as hexadecimal.
 * printf and sprintf do nothing. Units: none. Times are read, never interpreted, here.
 */
#include <stdarg.h>
#include <stdint.h>
#include "riscq.h"
#include "stdio.h"

extern const uint32_t rq_input[];
extern const uint32_t rq_input_words;
extern const uint32_t rq_record_words;

struct rq_file {
    uint32_t at;
    uint32_t output;
};

static struct rq_file input_file, output_file;
volatile uint32_t rq_record_time;

FILE *fopen(const char *name, const char *mode) {
    (void)name;
    if (mode[0] == 'r') {
        input_file.at = 0;
        return &input_file;
    }
    output_file.at = 0;
    output_file.output = 1;
    return &output_file;
}

int fclose(FILE *file) {
    (void)file;
    return 0;
}

int printf(const char *format, ...) {
    (void)format;
    return 0;
}

int sprintf(char *text, const char *format, ...) {
    (void)format;
    text[0] = 0;
    return 0;
}

int fscanf(FILE *file, const char *format, ...) {
    (void)format;
    if (file->at >= rq_input_words)
        return -1;
    va_list arguments;
    va_start(arguments, format);
    int *value = va_arg(arguments, int *);
    va_end(arguments);
    *value = (int)rq_input[file->at];
    file->at = file->at + 1;
    if (file->at % rq_record_words == 0)
        rq_record_time = now();
    return 1;
}

static uint32_t hex_digit(char c) {
    if (c >= '0' && c <= '9') return (uint32_t)(c - '0');
    if (c >= 'a' && c <= 'f') return (uint32_t)(c - 'a') + 10;
    if (c >= 'A' && c <= 'F') return (uint32_t)(c - 'A') + 10;
    return 0;
}

int fprintf(FILE *file, const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    uint32_t word = 0;
    for (const char *p = format; *p; p++) {
        if (*p == '%') {
            uint32_t digits = 0;
            for (p++; *p >= '0' && *p <= '9'; p++)
                digits = digits * 10 + (uint32_t)(*p - '0');
            uint32_t value = va_arg(arguments, uint32_t);
            if (digits >= 8)
                word = value;
            else
                word = (word << (4 * digits)) | (value & ((1u << (4 * digits)) - 1));
        } else if (*p == '\n') {
            RQ_MMIO(RQ_HOSTWIN + 4 * file->at) = word;
            file->at = file->at + 1;
            word = 0;
        } else {
            word = (word << 4) | hex_digit(*p);
        }
    }
    va_end(arguments);
    return 0;
}
