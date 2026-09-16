// 7-Zip emits an ASCII percentage at the start of each refreshed progress line.
#pragma once
#include <cstddef>

struct ExtractionProgress {
    unsigned value = 0;
    unsigned number = 0;
    unsigned digits = 0;
    bool start = true;

    void Read(const char* data, std::size_t length) {
        for (std::size_t i = 0; i < length; ++i) {
            const char c = data[i];
            if (c == '\r' || c == '\n' || c == '\b') {
                start = true; number = 0; digits = 0;
            } else if (start && c == ' ' && digits == 0) {
                continue;
            } else if (start && c >= '0' && c <= '9' && digits < 3) {
                number = number * 10 + c - '0'; ++digits;
            } else {
                if (start && c == '%' && digits && number <= 100 && number > value) value = number;
                start = false;
            }
        }
    }
};
