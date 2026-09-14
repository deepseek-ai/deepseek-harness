# POSIX flock behavior

`tryLockExclusive(fd)` returns a promise for one `flock(fd, LOCK_EX | LOCK_NB)` attempt. The syscall runs off the JavaScript thread. The caller keeps the descriptor open through completion; the binding does not open, duplicate, or close it. It exposes neither a blocking-wait API nor a shared-lock API.

## Behavior tests

The [native tests](../test/flock.test.js) exercise real descriptors and independent processes. The [C oracle](../test/fixtures/flock-oracle.c) calls the operating system directly, independently of `system.node`.

| Condition | Required observation |
|---|---|
| No conflicting lock | Acquisition resolves to void |
| Same open file description acquires again | Acquisition succeeds without a second ownership record |
| Separate opens of the same file | Exactly one exclusive holder; the contender rejects with EAGAIN/EWOULDBLOCK |
| Different files | Both can be locked |
| Independent C flock holder | The addon cannot acquire, and the C oracle cannot acquire while the addon holds the lock |
| A shared flock holder | The addon's exclusive attempt conflicts |
| Holder remains live | A nonblocking attempt reports contention before the holder unlocks |
| Ordinary read/write by another process | Access is allowed: flock is advisory, not an I/O permission mechanism |
| One unrelated descriptor closes | The actual holder keeps its lock |
| A descriptor inherited by a child remains open | Closing the parent's descriptor does not release the shared open file description's lock |
| Last owning descriptor closes | An already-open contender can acquire |
| Holder process exits or is killed | Acquisition succeeds after process exit, without a stale-lock timeout |
| Invalid descriptor | The promise rejects with EBADF and positive errno |
| Native argument validation fails | The JavaScript entry returns a rejected promise without throwing synchronously |
| Native completion callback | It receives zero or the request's positive errno asynchronously |
| Native completion callback throws | The exception reaches Node's uncaught-exception handler |
| Concurrent success/failure calls | Each completion receives its own syscall errno |
| Worker environment terminates before or during its callback | Native work and cleanup reach completion without taking ownership of the caller's descriptor |

Tests synchronize through IPC or flushed line protocols and await process exit before asserting crash recovery. They do not use fixed sleeps or a millisecond performance threshold to prove nonblocking behavior. The syscall oracle is built only for tests and never included in a published platform package.

## Limits

Locks belong to open file descriptions and follow the host filesystem's flock semantics. Removing or replacing a pathname does not transfer a lock to the replacement inode; the JSONL backend separately checks inode identity. Network filesystems can have different or unsupported lock semantics. Windows does not use this API and retains its existing semaphore implementation.

Node-API compatibility tests reuse the same platform addon under different Node versions. They complement these syscall tests; loading a binary alone does not prove correct locking behavior.
