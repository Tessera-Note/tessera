const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
const userId = process.env.TESSERA_SECOND_USER_ID;
if (!baseUrl || !key || !userId)
  throw new Error(
    "TESSERA_API_URL, TESSERA_API_KEY and TESSERA_SECOND_USER_ID are required",
  );
async function post(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true)
    throw new Error(`${path} failed with HTTP ${response.status}`);
  return payload.data;
}
await post("/workspace/members/change-role", { userId, role: "member" });
await post("/workspace/members/deactivate", { userId });
await post("/workspace/members/activate", { userId });
await post("/workspace/members/delete", { userId });
console.log("Open API workspace-member smoke test completed successfully.");
