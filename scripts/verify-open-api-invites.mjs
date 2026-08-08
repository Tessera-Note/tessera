const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
if (!baseUrl || !key)
  throw new Error("TESSERA_API_URL and TESSERA_API_KEY are required");
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
  )
    throw new Error(`${path} failed with HTTP ${response.status}`);
  return payload.data;
}
let invitationId;
try {
  const invites = await post("/workspace/invites", { limit: 20 });
  if (!Array.isArray(invites?.items))
    throw new Error("Invite list is not paginated");
  const email = `api-invite-${Date.now()}@example.invalid`;
  await post(
    "/workspace/invites/create",
    { emails: [email], groupIds: [], role: "member" },
    false,
  );
  const createdInvites = await post("/workspace/invites", { limit: 100 });
  const invite = createdInvites.items.find((item) => item.email === email);
  if (!invite?.id) throw new Error("Created invitation is missing from list");
  invitationId = invite.id;
  await post("/workspace/invites/info", { invitationId });
  await post("/workspace/invites/link", { invitationId });
  await post("/workspace/invites/resend", { invitationId }, false);
  await post("/workspace/invites/revoke", { invitationId }, false);
  invitationId = undefined;
  console.log("Open API invitations smoke test completed successfully.");
} finally {
  if (invitationId)
    await post("/workspace/invites/revoke", { invitationId }, false);
}
