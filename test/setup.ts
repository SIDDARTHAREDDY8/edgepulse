import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file: build the real schema in the local D1 database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
