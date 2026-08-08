#!/usr/bin/env node

const baseUrl = process.env.TESSERA_API_URL?.replace(/\/+$/, "");
const apiKey = process.env.TESSERA_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error("Set TESSERA_API_URL and TESSERA_API_KEY before running.");
}

async function request(path, body = {}, dataRequired = true) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  if (
    !response.ok ||
    envelope.success !== true ||
    envelope.status !== response.status ||
    (dataRequired && !("data" in envelope))
  ) {
    throw new Error(`${path} failed with HTTP ${response.status}`);
  }
  return envelope.data;
}

async function upload(path, fields, filename, type, content) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([content], { type }), filename);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const envelope = await response.json();
  if (!response.ok) {
    throw new Error(`${path} upload failed with HTTP ${response.status}`);
  }
  return envelope.success === true && "data" in envelope
    ? envelope.data
    : envelope;
}

const suffix = `api-check-${Date.now()}`;
let spaceId;

try {
  const space = await request("/spaces/create", { name: suffix, slug: suffix });
  spaceId = space.id;
  const page = await request("/pages/create", {
    spaceId,
    title: "Attachment verification",
  });

  const comment = await request("/comments/create", {
    pageId: page.id,
    content: JSON.stringify({ text: "Created by API verification" }),
    type: "page",
  });
  const comments = await request("/comments", { pageId: page.id, limit: 20 });
  if (!comments.items.some((item) => item.id === comment.id))
    throw new Error("Comment not listed");
  await request("/comments/info", { commentId: comment.id });
  await request("/comments/update", {
    commentId: comment.id,
    content: JSON.stringify({ text: "Updated by API verification" }),
  });

  const attachment = await upload(
    "/files/upload",
    { pageId: page.id },
    "verification.txt",
    "text/plain",
    "Tessera API verification",
  );
  await request("/files/info", { attachmentId: attachment.id });
  await upload(
    "/attachments/upload-image",
    { type: "space-icon", spaceId },
    "verification.png",
    "image/png",
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await request(
    "/attachments/remove-icon",
    { type: "space-icon", spaceId },
    false,
  );
  await request("/comments/delete", { commentId: comment.id }, false);
  console.log(
    "Open API comments/attachments smoke test completed successfully.",
  );
} finally {
  if (spaceId) await request("/spaces/delete", { spaceId }, false);
}
