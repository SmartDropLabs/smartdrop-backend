const {
  indexerAirdropParamsSchema,
  indexerRecipientParamsSchema,
  paginationQuerySchema,
} = require("../src/validation/schemas");

describe("Request validation schemas (#527)", () => {
  test("indexerAirdropParamsSchema accepts valid airdrop ids and rejects malformed ids", () => {
    expect(indexerAirdropParamsSchema.safeParse({ id: "airdrop_123:v1" }).success).toBe(true);
    expect(indexerAirdropParamsSchema.safeParse({ id: "bad id with spaces" }).success).toBe(false);
    expect(indexerAirdropParamsSchema.safeParse({ id: "" }).success).toBe(false);
  });

  test("indexerRecipientParamsSchema validates Stellar recipient addresses", () => {
    const validAddr = "G" + "A".repeat(55);
    expect(indexerRecipientParamsSchema.safeParse({ address: validAddr }).success).toBe(true);
    expect(indexerRecipientParamsSchema.safeParse({ address: "short" }).success).toBe(false);
    expect(indexerRecipientParamsSchema.safeParse({ address: "lowercase_address_123456" }).success).toBe(false);
  });

  test("paginationQuerySchema coerces valid page/limit and rejects unknown query fields", () => {
    const parsed = paginationQuerySchema.safeParse({ page: "2", limit: "50" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ page: 2, limit: 50 });
    expect(paginationQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: "5000" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ extra: "1" }).success).toBe(false);
  });
});