const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
const secondUserId = process.env.TESSERA_SECOND_USER_ID;
if (!baseUrl || !key || !secondUserId) {
  throw new Error(
    "TESSERA_API_URL, TESSERA_API_KEY and TESSERA_SECOND_USER_ID are required",
  );
}
async function post(path, body = {}, dataRequired = true) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (
    !response.ok ||
    payload.success !== true ||
    (dataRequired && !("data" in payload))
  ) {
    throw new Error(`${path} failed with HTTP ${response.status}`);
  }
  return payload.data;
}
let spaceId;
let groupId;
try {
  const suffix = `multi-user-${Date.now()}`;
  const space = await post("/spaces/create", { name: suffix, slug: suffix });
  spaceId = space.id;
  await post(
    "/spaces/members/add",
    { spaceId, role: "reader", userIds: [secondUserId], groupIds: [] },
    false,
  );
  await post(
    "/spaces/members/change-role",
    { spaceId, userId: secondUserId, role: "writer" },
    false,
  );
  await post(
    "/spaces/members/remove",
    { spaceId, userId: secondUserId },
    false,
  );
  const group = await post("/groups/create", { name: suffix });
  groupId = group.id;
  await post(
    "/groups/members/add",
    { groupId, userIds: [secondUserId] },
    false,
  );
  await post(
    "/groups/members/remove",
    { groupId, userId: secondUserId },
    false,
  );
  console.log("Open API multi-user smoke test completed successfully.");
} finally {
  if (groupId) await post("/groups/delete", { groupId }, false);
  if (spaceId) await post("/spaces/delete", { spaceId }, false);
}
