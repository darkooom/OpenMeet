declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    SETUP_TOKEN?: string;
    ENCRYPTION_KEY?: string;
    PUBLIC_BASE_URL?: string;
    ALLOWED_HOSTS?: string;
    APP_VERSION?: string;
    OPENMEET_TEST_MODE?: string;
  }
}
