import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ADMIN_TOKEN: string;
      RATE_LIMIT_PER_MINUTE?: string;
      ALLOWED_ORIGINS?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
