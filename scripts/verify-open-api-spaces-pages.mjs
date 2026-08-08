#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const apiBaseUrl = process.env.TESSERA_API_URL?.replace(/\/+$/, "");
const apiKey = process.env.TESSERA_API_KEY;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPagination(data, operation, limit) {
  assert(
    data && Array.isArray(data.items) && data.meta,
    `${operation} did not return paginated items and metadata`,
  );
  assert(
    data.meta.limit === limit,
    `${operation} returned an unexpected limit`,
  );
  assert(
    typeof data.meta.hasNextPage === "boolean" &&
      typeof data.meta.hasPrevPage === "boolean" &&
      (typeof data.meta.nextCursor === "string" ||
        data.meta.nextCursor === null) &&
      (typeof data.meta.prevCursor === "string" ||
        data.meta.prevCursor === null),
    `${operation} returned invalid cursor metadata`,
  );
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

function safeErrorMessages(error) {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(safeErrorMessages);
  }

  return [safeErrorMessage(error)];
}

function requireSupportedNodeVersion() {
  const majorVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert(majorVersion >= 18, "Node.js 18 or later is required");
}

function requireConfiguration() {
  const missing = [];
  if (!apiBaseUrl) missing.push("TESSERA_API_URL");
  if (!apiKey) missing.push("TESSERA_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`,
    );
  }
}

async function post(path, body = {}, { requireData = true } = {}) {
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`POST ${path} request failed`);
  }

  if (!response.ok) {
    throw new Error(`POST ${path} failed with HTTP ${response.status}`);
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`POST ${path} returned a non-JSON response`);
  }

  if (
    !envelope ||
    envelope.success !== true ||
    envelope.status !== response.status ||
    (requireData && !Object.hasOwn(envelope, "data"))
  ) {
    throw new Error(`POST ${path} returned an invalid success envelope`);
  }

  return envelope.data;
}

async function run() {
  requireSupportedNodeVersion();
  requireConfiguration();

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const initialSpaceName = `Open API smoke ${suffix}`;
  const updatedSpaceName = `Open API smoke updated ${suffix}`;
  const spaceSlug = `open-api-smoke-${suffix}`;
  const targetSpaceName = `Open API smoke target ${suffix}`;
  const targetSpaceSlug = `open-api-smoke-target-${suffix}`;
  const initialPageTitle = `Open API page ${suffix}`;
  const updatedPageTitle = `Open API page updated ${suffix}`;
  let spaceId;
  let cleanupSpaceId;
  let targetSpaceId;
  let targetCleanupSpaceId;
  let primaryError;

  try {
    const space = await post("/spaces/create", {
      name: initialSpaceName,
      slug: spaceSlug,
    });
    assert(
      typeof space?.id === "string",
      "Space creation did not return an id",
    );
    cleanupSpaceId = space.id;
    assert(
      space.slug === spaceSlug,
      "Space creation returned an unexpected slug",
    );
    assert(
      space.name === initialSpaceName,
      "Space creation returned an unexpected name",
    );

    const spaceInfo = await post("/spaces/info", { spaceId: space.id });
    assert(spaceInfo?.id === space.id, "Space info returned the wrong space");
    assert(
      spaceInfo.slug === spaceSlug,
      "Space info returned an unexpected slug",
    );
    assert(
      spaceInfo.name === initialSpaceName,
      "Space info returned an unexpected name",
    );
    spaceId = space.id;

    const spaces = await post("/spaces", { limit: 100 });
    assertPagination(spaces, "Space list", 100);
    assert(
      spaces.items.some((item) => item.id === spaceId),
      "Created space is missing from the space list",
    );

    const updatedSpace = await post("/spaces/update", {
      spaceId,
      name: updatedSpaceName,
    });
    assert(
      updatedSpace?.name === updatedSpaceName,
      "Space update did not persist the name",
    );

    const members = await post("/spaces/members", { spaceId, limit: 100 });
    assertPagination(members, "Space members", 100);

    const targetSpace = await post("/spaces/create", {
      name: targetSpaceName,
      slug: targetSpaceSlug,
    });
    assert(
      typeof targetSpace?.id === "string",
      "Target space creation did not return an id",
    );
    targetCleanupSpaceId = targetSpace.id;
    assert(
      targetSpace.slug === targetSpaceSlug,
      "Target space creation returned an unexpected slug",
    );
    assert(
      targetSpace.name === targetSpaceName,
      "Target space creation returned an unexpected name",
    );

    const targetSpaceInfo = await post("/spaces/info", {
      spaceId: targetSpace.id,
    });
    assert(
      targetSpaceInfo?.id === targetSpace.id,
      "Target space info returned the wrong space",
    );
    assert(
      targetSpaceInfo.slug === targetSpaceSlug,
      "Target space info returned an unexpected slug",
    );
    assert(
      targetSpaceInfo.name === targetSpaceName,
      "Target space info returned an unexpected name",
    );
    targetSpaceId = targetSpace.id;

    const page = await post("/pages/create", {
      spaceId,
      title: initialPageTitle,
    });
    assert(typeof page?.id === "string", "Page creation did not return an id");
    assert(
      typeof page.position === "string",
      "Page creation did not return a position",
    );

    const pageInfo = await post("/pages/info", { pageId: page.id });
    assert(pageInfo?.id === page.id, "Page info returned the wrong page");

    const updatedPage = await post("/pages/update", {
      pageId: page.id,
      title: updatedPageTitle,
    });
    assert(
      updatedPage?.title === updatedPageTitle,
      "Page update did not persist the title",
    );

    const sidebarPages = await post("/pages/sidebar-pages", {
      spaceId,
      limit: 100,
    });
    assertPagination(sidebarPages, "Sidebar pages", 100);
    assert(
      sidebarPages.items.some((item) => item.id === page.id),
      "Created page is missing from sidebar pages",
    );

    const initialBreadcrumbs = await post("/pages/breadcrumbs", {
      pageId: page.id,
    });
    assert(
      Array.isArray(initialBreadcrumbs),
      "Page breadcrumbs did not return an array",
    );
    assert(
      initialBreadcrumbs.some((item) => item.id === page.id),
      "Page breadcrumbs omit the created page",
    );

    const duplicate = await post("/pages/duplicate", { pageId: page.id });
    assert(
      typeof duplicate?.id === "string" && duplicate.id !== page.id,
      "Page duplication did not return a distinct page",
    );

    await post(
      "/pages/move",
      {
        pageId: page.id,
        parentPageId: duplicate.id,
        position: page.position,
      },
      { requireData: false },
    );
    const movedPage = await post("/pages/info", { pageId: page.id });
    assert(
      movedPage?.parentPageId === duplicate.id,
      "Page move did not persist the parent page",
    );

    const movedBreadcrumbs = await post("/pages/breadcrumbs", {
      pageId: page.id,
    });
    assert(
      Array.isArray(movedBreadcrumbs),
      "Moved-page breadcrumbs did not return an array",
    );
    assert(
      movedBreadcrumbs.some((item) => item.id === duplicate.id),
      "Moved-page breadcrumbs omit the parent page",
    );

    await post(
      "/pages/move-to-space",
      { pageId: duplicate.id, spaceId: targetSpaceId },
      { requireData: false },
    );
    const movedDuplicate = await post("/pages/info", { pageId: duplicate.id });
    assert(
      movedDuplicate?.spaceId === targetSpaceId,
      "Page move-to-space did not persist the target space",
    );

    await post("/pages/delete", { pageId: page.id }, { requireData: false });
    const trashedPages = await post("/pages/trash", {
      spaceId: targetSpaceId,
      limit: 100,
    });
    assertPagination(trashedPages, "Trashed pages", 100);
    assert(
      trashedPages.items.some((item) => item.id === page.id),
      "Trashed page is missing from trash",
    );

    const restoredPage = await post("/pages/restore", { pageId: page.id });
    assert(
      restoredPage?.id === page.id,
      "Page restore returned the wrong page",
    );

    const restoredPageInfo = await post("/pages/info", { pageId: page.id });
    assert(
      !restoredPageInfo?.deletedAt,
      "Restored page is still marked as deleted",
    );

    const history = await post("/pages/history", {
      pageId: page.id,
      limit: 100,
    });
    assertPagination(history, "Page history", 100);
    if (history.items.length > 0) {
      const historyId = history.items[0]?.id;
      assert(
        typeof historyId === "string",
        "Page history item did not return an id",
      );
      const historyInfo = await post("/pages/history/info", { historyId });
      assert(
        historyInfo?.id === historyId,
        "Page history info returned the wrong entry",
      );
    }

    const recentPages = await post("/pages/recent", {
      spaceId: targetSpaceId,
      limit: 100,
    });
    assertPagination(recentPages, "Recent pages", 100);
    assert(
      recentPages.items.some((item) => item.id === page.id),
      "Restored page is missing from recent pages",
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const temporarySpaceId of [targetCleanupSpaceId, cleanupSpaceId]) {
      if (!temporarySpaceId) continue;

      try {
        await post(
          "/spaces/delete",
          { spaceId: temporarySpaceId },
          { requireData: false },
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    if (primaryError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Smoke test and cleanup both failed",
      );
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Temporary space cleanup failed");
    }
  }
}

try {
  await run();
  console.log("Open API spaces/pages smoke test completed successfully.");
} catch (error) {
  for (const message of safeErrorMessages(error)) {
    console.error(`Open API spaces/pages smoke test failed: ${message}`);
  }
  process.exitCode = 1;
}
