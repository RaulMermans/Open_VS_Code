const REDACTED_KEYS = ["password", "secret", "token", "api_key", "aws_access_key", "credential", "key", "authorization", "bearer"]

function redactSecrets(text) {
  let result = text;
  
  // 1. Specific multi-word headers first
  // Replaces "Authorization: Bearer <secret>" with "Authorization: ***REDACTED***"
  const authRegex = /((?:Authorization|authorization)['"]?\s*[:=]\s*['"]?)(?:Bearer|Basic|bearer|basic)\s+[^\s'"]+/gi;
  result = result.replace(authRegex, "$1***REDACTED***");

  const bearerRegex = /(Bearer\s+)[^\s'"]+/gi;
  result = result.replace(bearerRegex, "$1***REDACTED***");

  // 2. Generic single-word keys
  for (const key of REDACTED_KEYS) {
    const regex = new RegExp(`(${key}['"]?\\s*[:=]\\s*['"]?)(?!\\*\\*\\*REDACTED\\*\\*\\*)([^\\s'"]+)`, "gi");
    result = result.replace(regex, "$1***REDACTED***");
  }

  return result;
}

console.log(redactSecrets("Authorization: Bearer abc123def"));
console.log(redactSecrets("authorization: bearer abc123def"));
console.log(redactSecrets('{"authorization": "Bearer abc123def"}'));
console.log(redactSecrets("Authorization: Basic xyz789"));
console.log(redactSecrets("Bearer abc123def"));
console.log(redactSecrets("password=SECRET_VALUE"));
console.log(redactSecrets("authorization=abc"));
