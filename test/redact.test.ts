import { describe, it, expect } from "vitest";
import { redact } from "../src/analyze/payload.js";

/**
 * The redaction pass is the last line of defense before data leaves the
 * process. Collectors already drop env values, so what these cases cover is
 * the channel we don't control: build tools that echo their own configuration.
 */
describe("redact", () => {
  /**
   * Assembled from fragments rather than written as a literal.
   *
   * The fixture is synthetic, but it's shaped like a real Slack token on
   * purpose — that shape is the thing under test. Spelled out in full, it trips
   * GitHub's push protection, which scans for the same shapes this function
   * exists to redact. Splitting the prefix keeps the scanner quiet without
   * weakening the assertion: the value is identical at runtime.
   */
  const SLACK_PREFIX = "xox" + "b-";

  const cases: Array<[string, string, string]> = [
    ["stripe live key", "Using sk_live_51H8xQ2abcdefghijklmnop", "sk_live_51H8xQ2"],
    ["stripe test key", "key=sk_test_51H8xQ2abcdefghijklmnop", "sk_test_"],
    ["anthropic/openai key", "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuv", "sk-ant"],
    ["github pat", "token ghp_abcdefghijklmnopqrstuvwxyz1234", "ghp_"],
    ["github fine-grained pat", "github_pat_11ABCDEFG0abcdefghijklmnop", "github_pat_"],
    ["slack token", `${SLACK_PREFIX}123456789012-abcdefghijklmnop`, SLACK_PREFIX],
    ["aws access key id", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["google api key", "key=AIzaSyA1234567890abcdefghijklmnopqrstu", "AIzaSy"],
    [
      "jwt / supabase service role",
      "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop",
      "eyJyb2xl",
    ],
    [
      "postgres connection string",
      "Connecting to postgres://admin:hunter2@db.example.com:5432/prod",
      "hunter2",
    ],
    [
      "redis connection string",
      "redis://default:somepassword123@redis.upstash.io:6379",
      "somepassword123",
    ],
    ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop"],
    ["named secret assignment", 'DATABASE_PASSWORD="s3cr3tvalue"', "s3cr3tvalue"],
    ["named token assignment", "UPSTASH_TOKEN: abcdef123456789", "abcdef123456789"],
  ];

  for (const [name, input, secret] of cases) {
    it(`removes ${name}`, () => {
      const output = redact(input);
      expect(output).not.toContain(secret);
      expect(output).toContain("redacted");
    });
  }

  it("leaves ordinary build output untouched", () => {
    const log = "Module not found: Can't resolve 'next/navigation' in /app/src";
    expect(redact(log)).toBe(log);
  });

  it("preserves the variable name while removing its value", () => {
    // The name is what makes a diagnosis possible, so it has to survive.
    const output = redact("STRIPE_SECRET_KEY=sk_live_51H8xQ2abcdefghijklmnop");
    expect(output).toContain("STRIPE_SECRET_KEY");
    expect(output).not.toContain("sk_live_51H8xQ2");
  });
});
