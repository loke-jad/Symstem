const SONG_SPEC_SCHEMA = {
  type: "object",
  required: ["title", "bpm", "key", "time_sig", "genre", "channels"],
  properties: {
    title: { type: "string" },
    bpm: { type: "number" },
    key: { type: "string" },
    time_sig: { type: "string" },
    genre: { type: "string" },
    channels: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["instrument", "role", "loop_prompt"],
        properties: {
          instrument: { type: "string" },
          role: { type: "string" },
          loop_prompt: { type: "string" },
        },
      },
    },
  },
};

const STEM_CHECK_SCHEMA = {
  type: "object",
  required: ["instruments_heard", "is_single_instrument"],
  properties: {
    instruments_heard: { type: "array", items: { type: "string" } },
    is_single_instrument: { type: "boolean" },
  },
};

export { SONG_SPEC_SCHEMA, STEM_CHECK_SCHEMA };
