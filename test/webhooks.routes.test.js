"use strict";

process.env.WEBHOOK_RATELIMIT_MAX = "1000";
process.env.WEBHOOK_RATELIMIT_WINDOW = "60";

const express = require("express");
const request = require("supertest");
const { createCacheMock } = require("./helpers/cacheMock");

const mockHelper = createCacheMock();
const { reset } = mockHelper;

jest.mock("../src/services/cache", () => mockHelper.cacheMock);
jest.mock("../src/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockAxiosPost = jest.fn();
const mockAxiosHead = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  post: (...args) => mockAxiosPost(...args),
  head: (...args) => mockAxiosHead(...args),
  get: (...args) => mockAxiosGet(...args),
}));

const webhooksRouter = require("../src/routes/webhooks");
const dispatcher = require("../src/services/webhookDispatcher");
const { errorHandler } = require("../src/middleware/errorHandler");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", webhooksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  reset();
  mockAxiosPost.mockReset();
  mockAxiosHead.mockReset();
  mockAxiosGet.mockReset();
  mockAxiosHead.mockResolvedValue({ status: 200 });
  mockAxiosGet.mockResolvedValue({ status: 200 });
});

describe("POST /api/v1/webhooks", () => {
  const app = buildApp();

  test("creates a webhook with valid input", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["pool.assets_locked"],
        secret: "whsec_user_supplied_secret_long_enough",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^wh_/);
    expect(res.body.events).toEqual(["pool.assets_locked"]);
    expect(res.body.secret).toBe("whsec_user_supplied_secret_long_enough");
    expect(res.body.secret_warning).toMatch(/Store this secret/);
  });

  test("generates a secret when none provided", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({ url: "https://example.com/hook", events: ["*"] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]+$/);
  });

  test("rejects invalid url", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({ url: "not-a-url", events: ["*"] });
    expect(res.status).toBe(400);
  });

  test("rejects unknown event types", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({ url: "https://example.com/hook", events: ["totally.fake"] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.events[1]).toContain(
      "Unknown event type",
    );
    expect(res.body.error.details.fields.events[1]).toContain("totally.fake");
  });

  test("rejects too-short secret", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "short",
      });
    expect(res.status).toBe(400);
  });

  test("accepts webhook filters on registration", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["pool.assets_locked"],
        filters: { asset: "usdc", pool_id: "pool_123" },
      });
    expect(res.status).toBe(201);
    expect(res.body.filters).toEqual({ asset: "USDC", pool_id: "pool_123" });
  });
});

describe("GET /api/v1/webhooks", () => {
  const app = buildApp();

  test("lists registered webhooks without leaking full secrets", async () => {
    await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://a.com",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    const res = await request(app).get("/api/v1/webhooks");
    expect(res.status).toBe(200);
    // Canonical pagination envelope (#131): array under `data`, not `webhooks`.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].secret_preview).toMatch(/^whsec_/);
    expect(res.body.data[0]).not.toHaveProperty("secret");
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  test("paginates registered webhooks with page/limit query params (#131)", async () => {
    for (const letter of ["a", "b", "c"]) {
      await request(app)
        .post("/api/v1/webhooks")
        .send({
          url: `https://${letter}.com`,
          events: ["*"],
          secret: `whsec_${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}`,
        });
    }

    const res = await request(app).get("/api/v1/webhooks?page=1&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      total_pages: 2,
      has_next: true,
      has_prev: false,
    });
  });
});

describe("GET /api/v1/webhooks/:id", () => {
  const app = buildApp();

  test("returns 404 for unknown webhook", async () => {
    const res = await request(app).get("/api/v1/webhooks/wh_nope");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/webhooks/:id", () => {
  const app = buildApp();

  test("deletes a registered webhook", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    const del = await request(app).delete(
      `/api/v1/webhooks/${created.body.id}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const list = await request(app).get("/api/v1/webhooks");
    expect(list.body.data).toHaveLength(0);
  });

  test("returns 404 when deleting unknown id", async () => {
    const res = await request(app).delete("/api/v1/webhooks/wh_nope");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/webhooks/:id", () => {
  const app = buildApp();

  test("updates active status", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    const res = await request(app)
      .patch(`/api/v1/webhooks/${created.body.id}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe("POST /api/v1/webhooks/:id/test", () => {
  const app = buildApp();

  test("sends a test delivery and returns delivery summary", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });

    const res = await request(app).post(
      `/api/v1/webhooks/${created.body.id}/test`,
    );
    expect(res.status).toBe(202);
    expect(res.body.delivery_id).toMatch(/^dlv_/);
    expect(res.body.status).toBe("success");
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when webhook does not exist", async () => {
    const res = await request(app).post("/api/v1/webhooks/wh_nope/test");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/webhooks/:id/deliveries", () => {
  const app = buildApp();

  test("lists deliveries for a webhook", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    mockAxiosPost.mockResolvedValue({ status: 200 });
    await request(app).post(`/api/v1/webhooks/${created.body.id}/test`);

    const res = await request(app).get(
      `/api/v1/webhooks/${created.body.id}/deliveries`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.deliveries.length).toBeGreaterThan(0);
  });

  test("filters deliveries by status", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });

    mockAxiosPost.mockResolvedValueOnce({ status: 500 });
    const results = await dispatcher.dispatch({
      event_type: "pool.assets_locked",
      event_id: "evt_failed_delivery",
      data: { pool_id: "pool_1" },
    });
    const [{ delivery }] = results;

    mockAxiosPost.mockResolvedValue({ status: 500 });
    await dispatcher.attempt(delivery.id);
    await dispatcher.attempt(delivery.id);

    const res = await request(app).get(
      `/api/v1/webhooks/${created.body.id}/deliveries?status=failed`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deliveries.length).toBeGreaterThan(0);
    expect(res.body.deliveries.every((d) => d.status === "failed")).toBe(true);
  });
});

describe("Full webhook lifecycle (integration)", () => {
  const app = buildApp();

  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  test("create → test → update → list deliveries → delete", async () => {
    // 1. Create
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["pool.created"],
        secret: "whsec_lifecycle_test_secret_1234",
      });
    expect(created.status).toBe(201);
    const { id } = created.body;

    // 2. Test delivery
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    const testRes = await request(app).post(`/api/v1/webhooks/${id}/test`);
    expect(testRes.status).toBe(202);
    expect(testRes.body.status).toBe("success");

    // 3. Update active status
    const patchRes = await request(app)
      .patch(`/api/v1/webhooks/${id}`)
      .send({ active: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.active).toBe(false);

    // 4. List deliveries
    const deliveriesRes = await request(app).get(
      `/api/v1/webhooks/${id}/deliveries`,
    );
    expect(deliveriesRes.status).toBe(200);
    expect(deliveriesRes.body.deliveries.length).toBeGreaterThan(0);

    // 5. Get by ID
    const getRes = await request(app).get(`/api/v1/webhooks/${id}`);
    expect(getRes.status).toBe(200);

    // 6. Delete
    const delRes = await request(app).delete(`/api/v1/webhooks/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    // 7. Verify gone
    const goneRes = await request(app).get(`/api/v1/webhooks/${id}`);
    expect(goneRes.status).toBe(404);
  });

  test("multiple webhooks with different event filters", async () => {
    const wh1 = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://a.com",
        events: ["pool.created"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    const wh2 = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://b.com",
        events: ["price.alert"],
        secret: "whsec_bbbbbbbbbbbbbbbb",
      });
    const wh3 = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://c.com",
        events: ["*"],
        secret: "whsec_cccccccccccccccc",
      });

    expect(wh1.status).toBe(201);
    expect(wh2.status).toBe(201);
    expect(wh3.status).toBe(201);

    const list = await request(app).get("/api/v1/webhooks");
    expect(list.body.data).toHaveLength(3);
    expect(list.body.pagination.total).toBe(3);
  });

  test("PATCH returns 404 for unknown webhook", async () => {
    const res = await request(app)
      .patch("/api/v1/webhooks/wh_nonexistent")
      .send({ active: false });
    expect(res.status).toBe(404);
  });

  test("GET returns 404 for unknown webhook", async () => {
    const res = await request(app).get("/api/v1/webhooks/wh_nonexistent");
    expect(res.status).toBe(404);
  });

  test("DELETE returns 404 for unknown webhook", async () => {
    const res = await request(app).delete("/api/v1/webhooks/wh_nonexistent");
    expect(res.status).toBe(404);
  });

  test("test delivery returns 202 even when target URL fails (fire-and-forget)", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com/hook",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    mockAxiosPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await request(app).post(
      `/api/v1/webhooks/${created.body.id}/test`,
    );
    expect(res.status).toBe(202);
    expect(res.body.delivery_id).toMatch(/^dlv_/);
  });
});

describe("Webhook API contract", () => {
  const app = buildApp();

  test("secret is not returned in GET list response", async () => {
    await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["*"],
        secret: "whsec_supersecretvalue1234",
      });

    const res = await request(app).get("/api/v1/webhooks");
    const webhook = res.body.data[0];
    expect(webhook).not.toHaveProperty("secret");
    expect(webhook).toHaveProperty("secret_preview");
  });

  test("secret is not returned in GET by id response", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["*"],
        secret: "whsec_supersecretvalue1234",
      });

    const res = await request(app).get(`/api/v1/webhooks/${created.body.id}`);
    expect(res.body).not.toHaveProperty("secret");
  });

  test("webhook has default active=true on creation", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({ url: "https://example.com", events: ["*"] });
    expect(res.body.active).toBe(true);
  });

  test("wildcard event subscription is accepted", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    expect(res.status).toBe(201);
    expect(res.body.events).toEqual(["*"]);
  });

  test("multiple valid event types are accepted", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["pool.created", "pool.assets_locked", "price.alert"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });
    expect(res.status).toBe(201);
    expect(res.body.events).toHaveLength(3);
  });

  test("PATCH can update events", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["pool.created"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });

    const res = await request(app)
      .patch(`/api/v1/webhooks/${created.body.id}`)
      .send({ events: ["pool.created", "price.alert"] });
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual(["pool.created", "price.alert"]);
  });

  test("PATCH can update URL", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://old.com",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });

    const res = await request(app)
      .patch(`/api/v1/webhooks/${created.body.id}`)
      .send({ url: "https://new.com" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://new.com");
  });

  test("deliveries endpoint returns empty array for webhook with no deliveries", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks")
      .send({
        url: "https://example.com",
        events: ["*"],
        secret: "whsec_aaaaaaaaaaaaaaaa",
      });

    const res = await request(app).get(
      `/api/v1/webhooks/${created.body.id}/deliveries`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(0);
  });
});
