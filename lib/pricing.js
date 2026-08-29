'use strict';

const INPUT_RATE = 0.1;
const CACHED_INPUT_RATE = INPUT_RATE * 0.25;
const OUTPUT_RATE = 0.4;
const REASONING_RATE = OUTPUT_RATE;

const SCALE = 1_000_000;

const MICROS_PER_MILLION_TOKENS = {
  input: Math.round(INPUT_RATE * SCALE),
  cachedInput: Math.round(CACHED_INPUT_RATE * SCALE),
  output: Math.round(OUTPUT_RATE * SCALE),
  reasoning: Math.round(REASONING_RATE * SCALE),
};

function costMicros({
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
} = {}) {
  const scaled =
    inputTokens * MICROS_PER_MILLION_TOKENS.input +
    cachedInputTokens * MICROS_PER_MILLION_TOKENS.cachedInput +
    (outputTokens + reasoningTokens) * MICROS_PER_MILLION_TOKENS.output;

  return Math.round(scaled / SCALE);
}

module.exports = {
  INPUT_RATE,
  CACHED_INPUT_RATE,
  OUTPUT_RATE,
  REASONING_RATE,
  costMicros,
};
