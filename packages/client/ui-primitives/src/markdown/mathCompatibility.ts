/**
 * Extend upstream dollar-only math syntax with TeX delimiters while reusing its
 * token vocabulary. The dollar construct is dispatched before upstream's
 * `mathFlow`, so the shapes it accepts keep the opening line's text as math
 * instead of fence meta, which the renderer does not read. A `$$` candidate it
 * declines — a `$$` sequence the line does not end after, or a block left open
 * — is left to that upstream flow.
 */

import { factorySpace } from 'micromark-factory-space'
import type {} from 'micromark-extension-math'
import { markdownLineEnding, markdownSpace } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'
import type { Construct, Extension, Previous, State, Tokenizer } from 'micromark-util-types'

// oxlint-disable typescript/no-this-alias -- micromark binds tokenizer context only on the outer callback.

/** Prefixes whose following character is a `\verb` delimiter, not a fence. */
const VERB_DELIMITER_PREFIXES = ['\\verb', '\\verb*'] as const

/** Longest prefix above, in code units. */
const VERB_DELIMITER_TAIL = 6

const previousBackslash: Previous = function (code) {
  if (code !== codes.backslash) return true
  const tail = this.events.at(-1)
  /* v8 ignore next -- a previous code necessarily has a preceding event. */
  if (tail === undefined) return false
  return tail[1].type === types.characterEscape
}

const tokenizeBackslashMathText: Tokenizer = function (effects, ok, nok) {
  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- the text construct is dispatched only for a backslash. */
    if (code !== codes.backslash) return nok(code)
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== codes.leftParenthesis) return nok(code)
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === codes.eof) return nok(code)
    if (code === codes.backslash) {
      return effects.attempt({ partial: true, tokenize: tokenizeClose }, close, afterCloseAttempt)(code)
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return between
    }
    return dataStart(code)
  }

  function afterCloseAttempt(code: number | null): State | undefined {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === codes.backslash ? afterDataBackslash : data
  }

  function afterDataBackslash(code: number | null): State | undefined {
    if (code === codes.backslash) {
      effects.consume(code)
      return data
    }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function close(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }

  function tokenizeClose(closeEffects: Parameters<Tokenizer>[0], closeOk: State, closeNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- this partial construct is attempted only at a backslash. */
      if (code !== codes.backslash) return closeNok(code)
      closeEffects.enter('mathTextSequence')
      closeEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.rightParenthesis) return closeNok(code)
      closeEffects.consume(code)
      closeEffects.exit('mathTextSequence')
      return closeOk
    }
  }

  function tokenizeOpen(openEffects: Parameters<Tokenizer>[0], openOk: State, openNok: State): State {
    return slash

    function slash(code: number | null): State | undefined {
      /* v8 ignore next -- the opening check follows a failed close attempt at a backslash. */
      if (code !== codes.backslash) return openNok(code)
      openEffects.enter(types.chunkString)
      openEffects.consume(code)
      return parenthesis
    }

    function parenthesis(code: number | null): State | undefined {
      if (code !== codes.leftParenthesis) return openNok(code)
      openEffects.consume(code)
      openEffects.exit(types.chunkString)
      return openOk
    }
  }
}

function createMathFlow(marker: number, openMarker: number, closeMarker: number): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const self = this
    let oddBackslashRun = false
    let inComment = false
    let commentHasContent = false
    let crossedLineEnding = false
    let sawClosingFenceSequence = false
    let consumedTail = ''
    let failedClose = false
    const tail = self.events.at(-1)
    const initialSize = tail?.[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0

    return start

    function start(code: number | null): State | undefined {
      /* v8 ignore next -- the flow construct is dispatched only for its marker. */
      if (code !== marker) return nok(code)
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return open
    }

    function open(code: number | null): State | undefined {
      if (code !== openMarker) return nok(code)
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      effects.exit('mathFlowFence')
      return marker === codes.dollarSign ? afterDollarOpen : content
    }

    function afterDollarOpen(code: number | null): State | undefined {
      return code === codes.dollarSign ? nok(code) : content(code)
    }

    function content(code: number | null): State | undefined {
      if (code === codes.eof) return nok(code)
      if (code === marker && marker === codes.dollarSign && !inComment && verbDelimiterAhead()) {
        // The `$` here delimits a `\verb…` region rather than closing the block,
        // so it is content, and a `$` right after it closes an empty region and
        // is content too. A comment holds no commands.
        return verbatimDelimiter(code)
      }
      if (code === marker && closingFenceAllowed()) {
        return effects.attempt(
          { partial: true, tokenize: tokenizeClosingFence },
          closed,
          afterClosingFenceAttempt,
        )(code)
      }
      if (markdownLineEnding(code)) {
        // A close that failed earlier on this candidate ends it at the line
        // ending, which is what the grammar this flow replaced did: a failed
        // `$$x$$ trailing` never reaches the next line.
        if (marker === codes.dollarSign && failedClose) return nok(code)
        // A trailing backslash escapes the line ending, not the next line's
        // first character, so the escape run ends here, and a TeX comment ends
        // with the line. The comment exception covers only a closing fence on a
        // later line, which is where the multi-line block can hide one; the
        // same-line form keeps closing as it did before this flow spanned lines.
        oddBackslashRun = false
        inComment = false
        commentHasContent = false
        consumedTail = ''
        if (marker === codes.dollarSign) crossedLineEnding = true
        // A paragraph-interruption check on the dollar flow must not consume the
        // line ending: that keeps the paragraph open across the line boundary,
        // and the document layer then counts the next line lazy for every
        // construct tried afterwards. Declining leaves the interruption decision
        // to the upstream flow, whose own check short-circuits without consuming
        // and claims only the fences it accepts. The backslash construct has no
        // upstream counterpart and keeps consuming here.
        if (self.interrupt && marker === codes.dollarSign) return nok(code)
        return effects.attempt(nonLazyContinuation, afterContinuation, nok)(code)
      }
      return valueStart(code)
    }

    /**
     * Whether the marker under the scanner may close the block. The dollar flow
     * keeps an escaped `$` and a `%` comment that holds text from closing.
     */
    function closingFenceAllowed(): boolean {
      if (marker !== codes.dollarSign) return true
      return !oddBackslashRun && !(inComment && commentHasContent && crossedLineEnding)
    }

    /** Whether the marker under the scanner is a `\verb` region's delimiter. */
    function verbDelimiterAhead(): boolean {
      return VERB_DELIMITER_PREFIXES.some(prefix => consumedTail.endsWith(prefix))
    }

    function verbatimDelimiter(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = false
      rememberConsumed(code)
      effects.consume(code)
      return verbatimDelimiterClose
    }

    function verbatimDelimiterClose(code: number | null): State | undefined {
      if (code !== marker) return value(code)
      rememberConsumed(code)
      effects.consume(code)
      return value
    }

    /** Record one consumed code unit so a fence can be told from a delimiter. */
    function rememberConsumed(code: number | null): void {
      /* v8 ignore next 2 -- every call site passes a code unit, never EOF. */
      if (code === null) return
      consumedTail = `${consumedTail}${String.fromCharCode(code)}`.slice(-VERB_DELIMITER_TAIL)
    }

    function afterClosingFenceAttempt(code: number | null): State | undefined {
      if (marker === codes.backslash) {
        return effects.check({ partial: true, tokenize: tokenizeOpeningFence }, nok, markerValueStart)(code)
      }
      // A full `$$` that the line does not end after closes nothing there. On
      // the opening line the scan continues, so `$$x$$ trailing` declines at
      // that line's ending while a later `$$` on the same line still closes; on
      // any later line it ends the candidate outright, so a following block is
      // not swallowed. A solitary `$` is content, not a failed fence.
      if (sawClosingFenceSequence) {
        if (crossedLineEnding) return nok(code)
        failedClose = true
      }
      return markerValueStart(code)
    }

    function afterContinuation(code: number | null): State | undefined {
      return effects.attempt(
        { partial: true, tokenize: tokenizeClosingFence },
        closed,
        initialSize
          ? factorySpace(effects, content, types.linePrefix, initialSize + 1)
          : content,
      )(code)
    }

    function valueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      // An unescaped `%` opens a TeX comment wherever it is the first character
      // of a value run, such as a line that starts inside the block. The
      // backslash construct reads neither this state nor the escape run.
      oddBackslashRun = code === codes.backslash
      if (code === codes.percentSign && marker === codes.dollarSign && !inComment) {
        inComment = true
        commentHasContent = false
      } else if (inComment && !markdownSpace(code)) {
        commentHasContent = true
      }
      rememberConsumed(code)
      effects.consume(code)
      return value
    }

    function markerValueStart(code: number | null): State | undefined {
      effects.enter('mathFlowValue')
      oddBackslashRun = false
      if (inComment) commentHasContent = true
      rememberConsumed(code)
      effects.consume(code)
      return valueAfterMarker
    }

    function valueAfterMarker(code: number | null): State | undefined {
      if (code === marker) {
        rememberConsumed(code)
        effects.consume(code)
        return value
      }
      return value(code)
    }

    function value(code: number | null): State | undefined {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit('mathFlowValue')
        return content(code)
      }
      const escaped = oddBackslashRun
      const doubleBackslash = code === codes.backslash && escaped
      oddBackslashRun = code === codes.backslash ? !escaped : false
      // An unescaped `%` starts a TeX comment that runs to the line ending, so
      // a `$$` inside it closes nothing. A `%` the fence follows immediately
      // holds no comment text, which is how writers use it mid-formula
      // (`95%$$`, and `95 %$$` alike); only a comment holding a non-whitespace
      // character suppresses the close, and a `%` inside an open comment is
      // comment text like any other character.
      if (!escaped && code === codes.percentSign && marker === codes.dollarSign && !inComment) {
        inComment = true
        commentHasContent = false
      } else if (inComment && !markdownSpace(code)) {
        commentHasContent = true
      }
      // `\\verb` is a line break followed by letters, not the command, so the
      // pair's second backslash never reaches the tail the command match reads.
      if (doubleBackslash) consumedTail = ''
      else rememberConsumed(code)
      effects.consume(code)
      return value
    }

    function closed(code: number | null): State | undefined {
      effects.exit('mathFlow')
      return ok(code)
    }

    function tokenizeClosingFence(
      closeEffects: Parameters<Tokenizer>[0],
      closeOk: State,
      closeNok: State,
    ): State {
      sawClosingFenceSequence = false
      return factorySpace(closeEffects, sequenceStart, types.linePrefix, constants.tabSize)

      function sequenceStart(code: number | null): State | undefined {
        if (code !== marker) return closeNok(code)
        closeEffects.enter('mathFlowFence')
        closeEffects.enter('mathFlowFenceSequence')
        closeEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== closeMarker) return closeNok(code)
        closeEffects.consume(code)
        closeEffects.exit('mathFlowFenceSequence')
        sawClosingFenceSequence = true
        return factorySpace(closeEffects, after, types.whitespace)
      }

      function after(code: number | null): State | undefined {
        if (code !== codes.eof && !markdownLineEnding(code)) return closeNok(code)
        closeEffects.exit('mathFlowFence')
        return closeOk(code)
      }
    }

    function tokenizeOpeningFence(
      openEffects: Parameters<Tokenizer>[0],
      openOk: State,
      openNok: State,
    ): State {
      return sequenceStart

      function sequenceStart(code: number | null): State | undefined {
        /* v8 ignore next -- the opening check follows a failed close attempt at the marker. */
        if (code !== marker) return openNok(code)
        openEffects.enter(types.chunkString)
        openEffects.consume(code)
        return sequenceEnd
      }

      function sequenceEnd(code: number | null): State | undefined {
        if (code !== openMarker) return openNok(code)
        openEffects.consume(code)
        openEffects.exit(types.chunkString)
        return openOk
      }
    }
  }

  return {
    concrete: true,
    name: marker === codes.dollarSign ? 'dollarMathFlow' : 'backslashMathFlow',
    tokenize,
  }
}

const tokenizeNonLazyContinuation: Tokenizer = function (effects, ok, nok) {
  const self = this

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (code === codes.eof) return ok(code)
    /* v8 ignore next -- continuation constructs are attempted only after a line ending. */
    if (!markdownLineEnding(code)) return nok(code)
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }

  function lineStart(code: number | null): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation,
}

const backslashMathText: Construct = {
  name: 'backslashMathText',
  previous: previousBackslash,
  tokenize: tokenizeBackslashMathText,
}

const backslashMathFlow = createMathFlow(
  codes.backslash,
  codes.leftSquareBracket,
  codes.rightSquareBracket,
)

const dollarMathFlow = createMathFlow(
  codes.dollarSign,
  codes.dollarSign,
  codes.dollarSign,
)

const backslashMath: Extension = {
  flow: {
    [codes.backslash]: backslashMathFlow,
    [codes.dollarSign]: dollarMathFlow,
  },
  text: { [codes.backslash]: backslashMathText },
}

/**
 * TeX backslash delimiters and display-dollar blocks as a micromark syntax
 * extension reusing `micromark-extension-math`'s token vocabulary; the caller
 * must also register `math()` on the same parse so the emitted tokens compile
 * to standard math nodes. Both `$$<math>$$` on one line and a `$$<math>` block
 * closed by a trailing `$$` parse as one math node, and a closing `$$` may sit
 * at the end of a content line.
 * @returns The micromark syntax extension.
 */
export function mathCompatibility(): Extension {
  return backslashMath
}
