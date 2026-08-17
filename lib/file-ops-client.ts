/** Client-side helper for POST /api/files/ops (create / rename / delete),
 * shared by DirectoryPicker and FileExplorer so both surfaces speak the same
 * request/response shape. */
export interface FileOpResponse {
  ok?: boolean;
  path?: string;
  error?: string;
  code?: string;
}

export async function postFileOp(body: Record<string, unknown>): Promise<{ ok: boolean; data: FileOpResponse }> {
  const response = await fetch("/api/files/ops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as FileOpResponse;
  return { ok: response.ok, data };
}
