function normalizeSchema(obj) {
  if (!obj || typeof obj !== "object") return null
  if (typeof obj.sessionId !== "string") return null
  if (typeof obj.mode !== "string") return null
  if (typeof obj.task !== "string") return null
  if (typeof obj.outcome !== "string") return null
  if (!Array.isArray(obj.changedFiles)) return null
  
  if (obj.decisions !== undefined && !Array.isArray(obj.decisions)) return null;
  if (obj.unresolvedIssues !== undefined && !Array.isArray(obj.unresolvedIssues)) return null;

  return {
    ...obj,
    decisions: obj.decisions || [],
    unresolvedIssues: obj.unresolvedIssues || []
  }
}
