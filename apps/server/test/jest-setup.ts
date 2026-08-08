/**
 * Specs that import real Nest modules reach EnvironmentModule, whose
 * ConfigModule.forRoot validates the environment at import time and calls
 * process.exit(1) when a required variable is missing. On a CI runner there is
 * no .env, so the worker dies before any test runs and jest reports only
 * "child process exceptions".
 *
 * These are throwaway values for the validators, never used to connect to
 * anything. Assigned only when absent, so a developer's real .env still wins.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.APP_SECRET ??= 'test-only-value-not-a-real-secret-0000';
