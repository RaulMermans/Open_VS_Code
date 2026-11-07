export interface ProtocolFixtureCase {
  readonly name: string
  readonly payload: unknown
  readonly expectedModel?: string
  readonly expectedContent?: string
  readonly expectedToolCalls?: readonly {
    readonly id: string
    readonly name: string
    readonly arguments: unknown
  }[]
  readonly expectedFinishReason?: string
  readonly expectedUsage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
  readonly expectedMetadata?: Record<string, unknown>
  readonly shouldThrow?: boolean
  readonly expectedErrorCode?: string
}

export const PROTOCOL_FIXTURES = {
  // 1. Normal assistant response with plain text and full usage
  normalAssistantResponse: {
    id: "chatcmpl-001",
    object: "chat.completion",
    created: 1724600000,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello! I am ready to inspect the repository.",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 150,
      completion_tokens: 12,
      total_tokens: 162,
    },
  },

  // 2. Single tool call with JSON-stringified arguments in tool_calls
  singleToolCallJsonString: {
    id: "chatcmpl-002",
    object: "chat.completion",
    created: 1724600001,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_001",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 220,
      completion_tokens: 24,
      total_tokens: 244,
    },
  },

  // 3. Single tool call with pre-parsed structured object arguments
  singleToolCallStructuredObject: {
    id: "chatcmpl-003",
    object: "chat.completion",
    created: 1724600002,
    model: "local-proxy-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_search_001",
              type: "function",
              function: {
                name: "search_text",
                arguments: { query: "authenticateUser" },
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 180,
      completion_tokens: 30,
    },
  },

  // 4. Multiple tool calls in a single turn
  multipleToolCalls: {
    id: "chatcmpl-004",
    object: "chat.completion",
    created: 1724600003,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Let me check both files at once.",
          tool_calls: [
            {
              id: "call_multi_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "src/a.ts" }),
              },
            },
            {
              id: "call_multi_2",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "src/b.ts" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 310,
      completion_tokens: 52,
      total_tokens: 362,
    },
  },

  // 5. Empty content (null) with tool calls
  nullContentWithToolCall: {
    id: "chatcmpl-005",
    object: "chat.completion",
    created: 1724600004,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_find_001",
              type: "function",
              function: {
                name: "find_files",
                arguments: "{}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },

  // 6. Tool call with missing ID (should get deterministic synthetic ID)
  toolCallMissingId: {
    id: "chatcmpl-006",
    object: "chat.completion",
    created: 1724600005,
    model: "minimalist-backend",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "list_directory",
                arguments: JSON.stringify({ path: "." }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },

  // 7. Legacy function_call format
  legacyFunctionCall: {
    id: "chatcmpl-007",
    object: "chat.completion",
    created: 1724600006,
    model: "legacy-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          function_call: {
            name: "read_file",
            arguments: JSON.stringify({ path: "package.json" }),
          },
        },
        finish_reason: "function_call",
      },
    ],
  },

  // 8. Missing usage information
  missingUsage: {
    id: "chatcmpl-008",
    object: "chat.completion",
    created: 1724600007,
    model: "no-usage-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Done without token usage metadata.",
        },
        finish_reason: "stop",
      },
    ],
  },

  // 9. Extra unknown metadata
  extraUnknownMetadata: {
    id: "chatcmpl-009",
    object: "chat.completion",
    created: 1724600008,
    model: "qwen2.5-coder:7b",
    system_fingerprint: "fp_ollama_v032",
    service_tier: "default",
    custom_backend_field: { engine: "mlx", kv_cache: "q8_0" },
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Answer with extra metadata.",
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 50 },
    },
  },

  // 10. Malformed argument JSON string (unparseable JSON)
  malformedArgumentsJson: {
    id: "chatcmpl-010",
    object: "chat.completion",
    created: 1724600009,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bad_json_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{ path: unquoted_invalid_json }",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },

  // 11. Malformed tool_calls (not an array)
  malformedToolCallsNotArray: {
    id: "chatcmpl-011",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: "invalid_not_an_array",
        },
      },
    ],
  },

  // 12. Malformed tool call item (missing function/name)
  malformedToolCallMissingName: {
    id: "chatcmpl-012",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_no_name",
              type: "function",
              function: {
                arguments: "{}",
              },
            },
          ],
        },
      },
    ],
  },

  // 13. Backend error envelope
  backendErrorResponse: {
    error: {
      message: "model 'qwen-unknown' not found, try pulling it first",
      type: "not_found",
      code: 404,
    },
  },

  // 14. Missing choices
  missingChoices: {
    id: "chatcmpl-014",
    object: "chat.completion",
    model: "qwen2.5-coder:7b",
    choices: [],
  },

  // 15. Empty assistant message with no tool calls and no content
  emptyAssistantMessageWithoutTools: {
    id: "chatcmpl-015",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
        },
      },
    ],
  },

  // 16. Local backend quirk: tool call JSON emitted directly inside message.content
  contentJsonToolCall: {
    id: "chatcmpl-435",
    object: "chat.completion",
    created: 1787682894,
    model: "qwen2.5-coder:7b",
    system_fingerprint: "fp_ollama",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "{\"name\": \"list_directory\", \"arguments\": {\"path\": \".\"}}",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 159,
      completion_tokens: 16,
      total_tokens: 175,
    },
  },

  // 17. Local backend quirk: tool call inside <tool_call> tags
  contentToolCallTags: {
    id: "chatcmpl-436",
    object: "chat.completion",
    created: 1787682895,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"README.md\"}}\n</tool_call>",
        },
        finish_reason: "stop",
      },
    ],
  },

  // 18. Local backend quirk: tool call inside markdown code fence
  contentQwenFunctionTags: {
    id: "chatcmpl-438",
    object: "chat.completion",
    created: 1787682897,
    model: "qwen3-coder:30b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I'll search first.\n\n<function=search_text>\n<parameter=query>\nformatNote\n</parameter>\n</function>\n</tool_call>",
        },
        finish_reason: "stop",
      },
    ],
  },

  contentMarkdownJsonToolCall: {
    id: "chatcmpl-437",
    object: "chat.completion",
    created: 1787682896,
    model: "qwen2.5-coder:7b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "```json\n{\"name\": \"search_text\", \"arguments\": {\"query\": \"test\"}}\n```",
        },
        finish_reason: "stop",
      },
    ],
  },
} as const
