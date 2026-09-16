// Deterministic user-visible progress scenarios; no wall-clock sleeps or file operations.
#include "../installer/progress.h"
#include "../installer/extract-progress.h"
#include <cassert>
#include <cstring>

int main() {
    // Progress tokens can cross pipe reads; filenames and stale redraws cannot inflate them.
    const char* stream = "  0%\b\b\b  4%\r 50% 14 - filename99%\r 9%\r 101%\r 100%";
    for (std::size_t block : {1U, 2U, 7U, 128U}) {
        ExtractionProgress parsed;
        const auto length = std::strlen(stream);
        for (std::size_t offset = 0; offset < length; offset += block) {
            parsed.Read(stream + offset, std::min(block, length - offset));
        }
        assert(parsed.value == 100);
    }
    ExtractionProgress invalid;
    const char* noise = "file 99%\r1234%\r101%\r%";
    invalid.Read(noise, std::strlen(noise));
    assert(invalid.value == 0);

    // Identical work fractions give the same result on fast and slow disks.
    for (std::uint64_t interval : {1000ULL, 10000ULL}) {
        InstallProgress progress(0);
        std::uint64_t now = 0;
        double previous = 0;
        for (int step = 0; step <= 10; ++step) {
            now += interval;
            progress.Advance(1, step / 10.0, now);
            progress.Tick(now + 250);
            assert(progress.value >= previous && progress.value < 100);
            previous = progress.value;
            if (step == 5) assert(progress.value == 48);
        }
        assert(progress.value == 94);
        progress.Advance(1, 0.2, now + 300);
        progress.Advance(0, 1, now + 400);
        assert(progress.stage == 1 && progress.value == 94);
        progress.Advance(2, 0, now + 450);
        progress.Advance(3, 0, now + 500);
        progress.Advance(4, 0, now + 600);
        progress.Advance(4, 0, now + 1000000);
        progress.Tick(now + 1000250);
        assert(progress.value < 100);
        assert(progress.CaptionStage() == 4);
    }

    // A stalled extractor does not creep toward completion merely because time passes.
    InstallProgress stalled(0);
    stalled.Advance(1, 0.5, 0);
    stalled.Advance(1, 0.5, 1000000);
    assert(stalled.value == 48);
    assert(!stalled.succeeded);

    // Replay the recording's short cleanup and also a worker finishing between UI ticks.
    for (std::uint64_t cleanup : {0ULL, 2200ULL}) {
        InstallProgress progress(0);
        progress.Advance(1, 0.5, 25000);
        progress.Advance(1, 1, 53000);
        progress.Advance(2, 0, 53100);
        progress.Advance(3, 0, 53250);
        progress.Advance(4, 0, 53500);
        const auto done = 53500 + cleanup;
        progress.Complete(done);
        double previous = progress.value;
        for (std::uint64_t elapsed = 0; elapsed < 600; elapsed += 16) {
            progress.Advance(4, 1, done + elapsed);
            assert(progress.value >= previous && progress.value < 100);
            previous = progress.value;
        }
        progress.Tick(done + 600);
        assert(progress.value == 100);
        progress.Complete(done + 1000);
        assert(progress.value == 100);
    }
}
