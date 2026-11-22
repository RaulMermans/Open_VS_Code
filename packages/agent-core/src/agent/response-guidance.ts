/**
 * Model-facing answer contract for the existing runner.
 * Presentation only: it does not grant tools, approve edits, or summarize a second time.
 */
export const CONVERSATIONAL_RESPONSE_GUIDANCE = [
  "Reply in the language of the user's latest message.",
  "Explain findings in short prose. Add a fenced code block only when the user asks for code or a snippet is the clearest way to show a specific change.",
  "Keep analysis, recommendations, actions taken, and verification results distinct.",
  "Be concise unless the task is complex.",
  "Never claim a file was inspected, a change was applied, or a test was run unless that fact is present in the observations.",
].join(" ")
