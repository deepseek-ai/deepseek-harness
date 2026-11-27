/** Non-template part of the Desktop sink bridge: sink ownership, metadata JSON, and the JavaScript argument checks. */
#include "desktop-bridge.h"
#include <clocale>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>
#if defined(_WIN32)
#include <locale.h>
#else
#include <xlocale.h>
#endif

namespace dsh_frame_forwarding {
namespace desktop_bridge {
namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;
constexpr size_t kMaxRequestId = 512;
constexpr size_t kMaxRx = 128;
constexpr uint32_t kMaxTimeoutMs = 30000;

/** Decode one code point at `at` the way the WHATWG UTF-8 decoder does, consuming the maximal invalid subpart. */
uint32_t decode_utf8(const unsigned char*& at, const unsigned char* end) {
  const unsigned char lead = *at++;
  if (lead < 0x80) return lead;
  uint32_t code; int needed; unsigned char lower = 0x80, upper = 0xBF;
  if (lead >= 0xC2 && lead <= 0xDF) { needed = 1; code = lead & 0x1F; }
  else if (lead >= 0xE0 && lead <= 0xEF) { needed = 2; code = lead & 0x0F; if (lead == 0xE0) lower = 0xA0; if (lead == 0xED) upper = 0x9F; }
  else if (lead >= 0xF0 && lead <= 0xF4) { needed = 3; code = lead & 0x07; if (lead == 0xF0) lower = 0x90; if (lead == 0xF4) upper = 0x8F; }
  else return 0xFFFD;
  while (needed-- > 0) {
    if (at == end || *at < lower || *at > upper) return 0xFFFD;
    code = (code << 6) | (*at++ & 0x3F);
    lower = 0x80; upper = 0xBF;
  }
  return code;
}

void append_utf16(std::u16string& out, uint32_t code) {
  if (code < 0x10000) { out.push_back(static_cast<char16_t>(code)); return; }
  code -= 0x10000;
  out.push_back(static_cast<char16_t>(0xD800 + (code >> 10)));
  out.push_back(static_cast<char16_t>(0xDC00 + (code & 0x3FF)));
}

void append_utf8(std::string& out, uint32_t code) {
  if (code < 0x80) out.push_back(static_cast<char>(code));
  else if (code < 0x800) { out.push_back(static_cast<char>(0xC0 | (code >> 6))); out.push_back(static_cast<char>(0x80 | (code & 0x3F))); }
  else if (code < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (code >> 12))); out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (code >> 18))); out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
  }
}

void append_escape(std::string& out, char16_t unit) {
  static const char hex[] = "0123456789abcdef";
  out += "\\u";
  for (int shift = 12; shift >= 0; shift -= 4) out.push_back(hex[(unit >> shift) & 0xF]);
}

/** The JSON string literal `JSON.stringify` writes for UTF-16 text, escaping lone surrogates. */
std::string json_string(const std::u16string& text) {
  std::string out = "\"";
  for (size_t index = 0; index < text.size(); ++index) {
    const char16_t unit = text[index];
    switch (unit) {
      case u'"': out += "\\\""; continue;
      case u'\\': out += "\\\\"; continue;
      case u'\b': out += "\\b"; continue;
      case u'\f': out += "\\f"; continue;
      case u'\n': out += "\\n"; continue;
      case u'\r': out += "\\r"; continue;
      case u'\t': out += "\\t"; continue;
      default: break;
    }
    if (unit < 0x20) append_escape(out, unit);
    else if (unit >= 0xD800 && unit <= 0xDBFF && index + 1 < text.size() && text[index + 1] >= 0xDC00 && text[index + 1] <= 0xDFFF) {
      append_utf8(out, 0x10000 + ((static_cast<uint32_t>(unit) - 0xD800) << 10) + (text[index + 1] - 0xDC00));
      ++index;
    } else if (unit >= 0xD800 && unit <= 0xDFFF) append_escape(out, unit);
    else append_utf8(out, unit);
  }
  return out + "\"";
}

/** A number in C notation regardless of the process locale. */
double parse_double(const std::string& text) {
#if defined(_WIN32)
  static const _locale_t classic = _create_locale(LC_NUMERIC, "C");
  return _strtod_l(text.c_str(), nullptr, classic);
#else
  static const locale_t classic = newlocale(LC_NUMERIC_MASK, "C", nullptr);
  return strtod_l(text.c_str(), nullptr, classic);
#endif
}

/** RFC 8259 reader over NUL-terminated UTF-8, with `JSON.parse` value semantics. */
class Reader {
 public:
  explicit Reader(const char* text) : at_(reinterpret_cast<const unsigned char*>(text)), end_(at_ + std::strlen(text)) {}

  std::string producer_frame(ProducerFrame& frame) {
    enum class Field { missing, invalid, present };
    Field request = Field::missing, generation = Field::missing, revision = Field::missing;
    std::u16string request_id;
    double generation_value = 0, revision_value = 0;
    space();
    if (at_ == end_ || *at_ != '{') return skip() && (space(), at_ == end_) ? "metadata is not a JSON object" : "metadata is not valid JSON";
    ++at_; space();
    if (at_ != end_ && *at_ == '}') ++at_;
    else for (;;) {
      std::u16string key;
      if (!string(&key)) return "metadata is not valid JSON";
      space();
      if (at_ == end_ || *at_++ != ':') return "metadata is not valid JSON";
      space();
      bool valid;
      if (key == u"requestId") {
        const bool text = at_ != end_ && *at_ == '"';
        request_id.clear();
        valid = text ? string(&request_id) : skip();
        request = text ? Field::present : Field::invalid;
      } else if (key == u"generation" || key == u"revision") {
        const bool numeric = at_ != end_ && (*at_ == '-' || (*at_ >= '0' && *at_ <= '9'));
        auto& value = key == u"generation" ? generation_value : revision_value;
        valid = numeric ? number(&value) : skip();
        (key == u"generation" ? generation : revision) = numeric ? Field::present : Field::invalid;
      } else valid = skip();
      if (!valid) return "metadata is not valid JSON";
      space();
      if (at_ == end_) return "metadata is not valid JSON";
      const unsigned char next = *at_++;
      if (next == '}') break;
      if (next != ',') return "metadata is not valid JSON";
      space();
    }
    space();
    if (at_ != end_) return "metadata is not valid JSON";
    if (request != Field::present || request_id.empty() || request_id.size() > kMaxRequestId)
      return "requestId must be a string of 1 to 512 characters";
    if (generation != Field::present || !safe(generation_value)) return "generation must be an integer from 0 to 9007199254740991";
    if (revision != Field::present || !safe(revision_value)) return "revision must be an integer from 0 to 9007199254740991";
    frame.request_id = json_string(request_id);
    frame.generation = static_cast<uint64_t>(generation_value);
    frame.revision = static_cast<uint64_t>(revision_value);
    return {};
  }

 private:
  static bool safe(double value) { return value >= 0 && value <= kMaxSafeInteger && std::floor(value) == value; }

  void space() { while (at_ != end_ && (*at_ == ' ' || *at_ == '\t' || *at_ == '\n' || *at_ == '\r')) ++at_; }

  bool hex(char16_t& unit) {
    unit = 0;
    for (int digit = 0; digit < 4; ++digit) {
      if (at_ == end_) return false;
      const unsigned char next = *at_++;
      unit = static_cast<char16_t>(unit << 4);
      if (next >= '0' && next <= '9') unit = static_cast<char16_t>(unit | (next - '0'));
      else if (next >= 'a' && next <= 'f') unit = static_cast<char16_t>(unit | (next - 'a' + 10));
      else if (next >= 'A' && next <= 'F') unit = static_cast<char16_t>(unit | (next - 'A' + 10));
      else return false;
    }
    return true;
  }

  /** One string, whose UTF-16 units go to `out` when given. */
  bool string(std::u16string* out) {
    if (at_ == end_ || *at_ != '"') return false;
    ++at_;
    for (;;) {
      if (at_ == end_) return false;
      const unsigned char next = *at_;
      if (next == '"') { ++at_; return true; }
      if (next < 0x20) return false;
      if (next != '\\') {
        const auto code = decode_utf8(at_, end_);
        if (out) append_utf16(*out, code);
        continue;
      }
      ++at_;
      if (at_ == end_) return false;
      char16_t unit;
      switch (*at_++) {
        case '"': unit = u'"'; break;
        case '\\': unit = u'\\'; break;
        case '/': unit = u'/'; break;
        case 'b': unit = u'\b'; break;
        case 'f': unit = u'\f'; break;
        case 'n': unit = u'\n'; break;
        case 'r': unit = u'\r'; break;
        case 't': unit = u'\t'; break;
        case 'u': if (!hex(unit)) return false; break;
        default: return false;
      }
      if (out) out->push_back(unit);
    }
  }

  bool digits() {
    const auto start = at_;
    while (at_ != end_ && *at_ >= '0' && *at_ <= '9') ++at_;
    return at_ != start;
  }

  /** One number, whose value goes to `out` when given. */
  bool number(double* out) {
    const auto start = at_;
    if (at_ != end_ && *at_ == '-') ++at_;
    if (at_ != end_ && *at_ == '0') ++at_;
    else if (!digits()) return false;
    bool integral = true;
    if (at_ != end_ && *at_ == '.') { ++at_; integral = false; if (!digits()) return false; }
    if (at_ != end_ && (*at_ == 'e' || *at_ == 'E')) {
      ++at_; integral = false;
      if (at_ != end_ && (*at_ == '+' || *at_ == '-')) ++at_;
      if (!digits()) return false;
    }
    if (!out) return true;
    const std::string text(start, at_);
    if (integral && text.size() <= 15) {
      double value = 0;
      for (const char digit : text) if (digit != '-') value = value * 10 + (digit - '0');
      *out = text[0] == '-' ? -value : value;
    } else *out = parse_double(text);
    return true;
  }

  bool literal(const char* word) {
    const auto size = std::strlen(word);
    if (static_cast<size_t>(end_ - at_) < size || std::memcmp(at_, word, size) != 0) return false;
    at_ += size;
    return true;
  }

  /** One value of any nesting depth, validated without recursion. */
  bool skip() {
    std::vector<unsigned char> open;
    for (;;) {
      space();
      if (at_ == end_) return false;
      const unsigned char next = *at_;
      bool scalar = true;
      if (next == '{' || next == '[') {
        ++at_; space();
        const unsigned char close = next == '{' ? '}' : ']';
        if (at_ != end_ && *at_ == close) ++at_;
        else {
          open.push_back(close);
          scalar = false;
          if (close == '}') {
            if (!string(nullptr)) return false;
            space();
            if (at_ == end_ || *at_++ != ':') return false;
          }
        }
      } else if (next == '"') { if (!string(nullptr)) return false; }
      else if (next == '-' || (next >= '0' && next <= '9')) { if (!number(nullptr)) return false; }
      else if (!literal("true") && !literal("false") && !literal("null")) return false;
      if (!scalar) continue;
      // A complete value closes containers until one continues with another member or element.
      for (;;) {
        if (open.empty()) return true;
        space();
        if (at_ == end_) return false;
        const unsigned char after = *at_++;
        if (after == open.back()) { open.pop_back(); continue; }
        if (after != ',') return false;
        if (open.back() == '}') {
          space();
          if (!string(nullptr)) return false;
          space();
          if (at_ == end_ || *at_++ != ':') return false;
        }
        break;
      }
    }
  }

  const unsigned char* at_;
  const unsigned char* end_;
};

bool named(napi_env env, napi_value object, const char* name, napi_value& value) {
  bool has = false;
  return napi_has_named_property(env, object, name, &has) == napi_ok && has && napi_get_named_property(env, object, name, &value) == napi_ok;
}

bool integer(napi_env env, napi_value value, double minimum, double maximum, double& out) {
  return napi_get_value_double(env, value, &out) == napi_ok && std::isfinite(out) && out >= minimum && out <= maximum && std::floor(out) == out;
}

napi_value undefined(napi_env env) { napi_value result; napi_get_undefined(env, &result); return result; }

}  // namespace

std::string parse_producer_frame(const char* text, ProducerFrame& frame) { return Reader(text).producer_frame(frame); }

std::string json_string(const std::string& text) {
  std::u16string units;
  auto at = reinterpret_cast<const unsigned char*>(text.data());
  const auto end = at + text.size();
  while (at != end) append_utf16(units, decode_utf8(at, end));
  return json_string(units);
}

std::string error_text(const char* source, const std::string& request_id, const std::string& error) {
  return std::string("{\"source\":\"") + source + "\"" + (request_id.empty() ? "" : ",\"requestId\":" + request_id)
    + ",\"error\":" + json_string(error) + "}";
}

AttachedSink::AttachedSink(dsh_shared_texture_sink_v2* sink, const std::string& rx, uint32_t timeout_ms)
    : sink(sink), rx_json(json_string(rx)), timeout_ms(timeout_ms) {
  sink->retain(sink->ctx);
}

void Bridge::attach(dsh_shared_texture_sink_v2* sink, const std::string& rx, uint32_t timeout_ms, std::weak_ptr<void> owner) {
  auto attached = std::make_shared<const AttachedSink>(sink, rx, timeout_ms);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    attached_.swap(attached);
    owner_ = std::move(owner);
  }
  // `attached` now holds the previous sink, released outside the lock.
}

void Bridge::set_deliverable(const Deliverable* state) {
  std::lock_guard<std::mutex> lock(mutex_);
  has_deliverable_ = state != nullptr;
  deliverable_ = state ? *state : Deliverable{};
}

bool Bridge::lease(Lease& lease) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!attached_) return false;
  lease.owner = owner_.lock();
  if (!lease.owner) return false;
  lease.attached = attached_;
  lease.has_deliverable = has_deliverable_;
  lease.deliverable = deliverable_;
  return true;
}

void Bridge::detach(const dsh_shared_texture_sink_v2* sink) {
  std::shared_ptr<const AttachedSink> detached;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!attached_ || attached_->sink != sink) return;
    detached.swap(attached_);
  }
}

napi_value throw_error(napi_env env, const char* text) {
  napi_throw_error(env, nullptr, text);
  return nullptr;
}

napi_value attach(napi_env env, const napi_value* args, Bridge& bridge, std::weak_ptr<void> owner) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok || length < 1 || length > kMaxRx)
    return throw_error(env, "Expected an rx of 1 to 128 printable ASCII characters");
  std::string rx(length, '\0');
  napi_get_value_string_utf8(env, args[0], &rx[0], length + 1, &length);
  for (const char character : rx) {
    if (character < 0x20 || character > 0x7E) return throw_error(env, "Expected an rx of 1 to 128 printable ASCII characters");
  }
  napi_valuetype type;
  void* data = nullptr;
  if (napi_typeof(env, args[1], &type) != napi_ok || type != napi_external || napi_get_value_external(env, args[1], &data) != napi_ok || !data)
    return throw_error(env, "Expected a Desktop shared-texture sink external");
  auto sink = static_cast<dsh_shared_texture_sink_v2*>(data);
  if (sink->magic != DSH_SHARED_TEXTURE_SINK_MAGIC || sink->version != DSH_SHARED_TEXTURE_SINK_VERSION)
    return throw_error(env, "Unsupported Desktop shared-texture sink ABI");
  double timeout = 0;
  if (!integer(env, args[2], 1, kMaxTimeoutMs, timeout)) return throw_error(env, "Expected a presentation timeout of 1 to 30000 ms");
  bridge.attach(sink, rx, static_cast<uint32_t>(timeout), std::move(owner));
  return undefined(env);
}

napi_value set_deliverable(napi_env env, napi_value state, Bridge& bridge) {
  napi_valuetype type;
  if (napi_typeof(env, state, &type) != napi_ok) return throw_error(env, "Expected a deliverable state or null");
  if (type == napi_null) { bridge.set_deliverable(nullptr); return undefined(env); }
  napi_value connection, visible, generation;
  Deliverable deliverable;
  double connection_id = 0, max_generation = 0;
  if (type != napi_object || !named(env, state, "connectionId", connection) || !named(env, state, "visible", visible)
      || !named(env, state, "maxGeneration", generation) || !integer(env, connection, 1, kMaxSafeInteger, connection_id)
      || napi_get_value_bool(env, visible, &deliverable.visible) != napi_ok || !integer(env, generation, 0, kMaxSafeInteger, max_generation))
    return throw_error(env, "Expected { connectionId, visible, maxGeneration } or null");
  deliverable.connection = static_cast<uint64_t>(connection_id);
  deliverable.max_generation = static_cast<uint64_t>(max_generation);
  bridge.set_deliverable(&deliverable);
  return undefined(env);
}

}  // namespace desktop_bridge
}  // namespace dsh_frame_forwarding
