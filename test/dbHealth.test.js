"use strict";

const mockConfig = { databaseUrl: "postgres://localhost/smartdrop" };
const mockKnexFactory = jest.fn();

jest.mock("../src/config", () => mockConfig);
jest.mock("knex", () => mockKnexFactory);

function loadDbHealth() {
  jest.resetModules();
  return require("../src/services/dbHealth");
}

describe("database health check", () => {
  beforeEach(() => {
    mockConfig.databaseUrl = "postgres://localhost/smartdrop";
    mockKnexFactory.mockReset();
  });

  test("pings a configured database and reports success", async () => {
    const raw = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    mockKnexFactory.mockReturnValue({ raw });
    const { checkDatabase } = loadDbHealth();

    await expect(checkDatabase()).resolves.toEqual({
      configured: true,
      checked: true,
      status: "ok",
    });
    expect(mockKnexFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "pg",
        acquireConnectionTimeout: 1000,
      }),
    );
    expect(raw).toHaveBeenCalledWith("SELECT 1");
  });

  test("reports an error when the database ping fails", async () => {
    mockKnexFactory.mockReturnValue({
      raw: jest.fn().mockRejectedValue(new Error("offline")),
    });
    const { checkDatabase } = loadDbHealth();

    await expect(checkDatabase()).resolves.toEqual({
      configured: true,
      checked: true,
      status: "error",
    });
  });

  test("does not create a client when the database is not configured", async () => {
    mockConfig.databaseUrl = null;
    const { checkDatabase } = loadDbHealth();

    await expect(checkDatabase()).resolves.toEqual({
      configured: false,
      checked: false,
      status: "unavailable",
    });
    expect(mockKnexFactory).not.toHaveBeenCalled();
  });
});
