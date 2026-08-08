const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
if (!baseUrl || !key)
  throw new Error("TESSERA_API_URL and TESSERA_API_KEY are required");
async function post(path, body = {}, required = true) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.success !== true || (required && !("data" in json)))
    throw new Error(`${path} failed (${res.status})`);
  return json.data;
}
let groupId;
try {
  const me = await post("/users/me");
  if (!(me?.id ?? me?.user?.id)) throw new Error("User profile missing id");
  const workspace = await post("/workspace/info");
  if (!workspace?.id) throw new Error("Workspace info missing id");
  const members = await post("/workspace/members", { limit: 20 });
  if (!Array.isArray(members?.items))
    throw new Error("Workspace members not paginated");
  const groups = await post("/groups", { limit: 20 });
  if (!Array.isArray(groups?.items)) throw new Error("Groups not paginated");
  const group = await post("/groups/create", {
    name: `API verification ${Date.now()}`,
  });
  groupId = group.id;
  await post("/groups/info", { groupId });
  const groupMembers = await post("/groups/members", { groupId, limit: 20 });
  if (!Array.isArray(groupMembers?.items))
    throw new Error("Group members not paginated");
  await post("/groups/update", {
    groupId,
    name: `API verification updated ${Date.now()}`,
  });
  await post("/groups/delete", { groupId }, false);
  groupId = undefined;
  console.log("Open API workspace/groups smoke test completed successfully.");
} finally {
  if (groupId) await post("/groups/delete", { groupId }, false);
}
