# Waiting for output

- term: Status
- definition: Pending
- term: Provider
- definition: deepseek-official
- term: Model
- definition: deepseek-v4-flash
- term: Tool calls
- definition: "0"

# Streaming assistant

- term: Source
- definition:
  - 'button "Request #1"'
- term: Status
- definition: Pending
- term: Tokens
- definition: —

# Streaming request

- term: Status
- definition: Pending
- term: Provider
- definition: deepseek-official
- term: Model
- definition: deepseek-v4-flash
- term: Tool calls
- definition: "1"
- term: Result
- definition:
  - button "Assistant Message"

# Settled request

- term: Status
- definition: Completed
- term: Provider
- definition: deepseek-official
- term: Model
- definition: deepseek-v4-flash
- term: Tool calls
- definition: "1"
- term: Subtool calls
- definition: "2"
- term: Result
- definition:
  - button "Assistant Message"

# Settled assistant

- term: Source
- definition:
  - 'button "Request #1"'
- term: Status
- definition: Completed
- term: Tokens
- definition: 235 tok
- term: Reasoning
- definition: 75 tok
- term: Content
- definition: 160 tok
