/**
 * Read budgets shared by the owner host and the served viewer page.
 *
 * One viewer read travels owner host → Relay → page, and each hop may hold it for its own bounded
 * time. The numbers form one ordering: the owner's hold is the shortest, the Relay gives up before
 * the page does, and the page's budget stays above both. Inverting it turns a healthy read into an
 * opaque `signal timed out` in the page instead of the clean answer the inner hop would have sent.
 */

/**
 * Longest wait one `stream-next` poll holds before it reports a retryable wait.
 *
 * A poll that returns `pending` costs one round trip, so this stays short enough that several polls
 * fit inside the Relay's budget for the same read.
 */
export const STREAM_POLL_HOLD_MS = 10_000

/**
 * Most stream values one `stream-next` answer carries.
 *
 * A page applies one answer per round trip, and one delta per round trip spends a full owner →
 * Relay → page trip on a stream that is already producing faster than that. Draining what the
 * stream has queued bounds the cost of a burst without touching the hold a poll uses when nothing
 * is queued: the limit only stops one answer from growing without bound.
 */
export const STREAM_BATCH_MAX = 64

/**
 * How long one `stream-next` answer waits for a value already queued behind its first one.
 *
 * The wait is paid only after a value arrived, and only while the stream keeps answering, so a
 * stream with nothing queued reports its single value at this cost rather than the poll's hold.
 */
export const STREAM_BATCH_WINDOW_MS = 4

/**
 * Slack a held poll may spend beyond its own hold before the host calls itself the slow hop.
 *
 * The hold is a timer race, so a poll answering later than the hold plus this much means something
 * other than the wait itself delayed the answer — which is the fact a reader needs to tell this
 * host apart from the hops around it.
 */
export const STREAM_POLL_SLACK_MS = 2_000

/**
 * Per-read budget of the viewer page, which must exceed every budget the read can meet on its way
 * out: the owner's hold above and the Relay's own answer for a stuck read.
 */
export const VIEWER_READ_TIMEOUT_MS = 25_000
