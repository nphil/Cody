/**
 * Engine prompts put the question on line 1 and the details after it (omp's
 * saved-reset consent lists one line per account). The dock header is a single
 * ellipsized line, so it keeps the first line and the card body shows the rest.
 */
export function splitExtensionTitle(title: string): { headline: string; details: string } {
  const text = title.replace(/\r\n?/g, "\n").trim();
  const at = text.indexOf("\n");
  if (at < 0) return { headline: text, details: "" };
  return { headline: text.slice(0, at).trim(), details: text.slice(at + 1).trim() };
}
