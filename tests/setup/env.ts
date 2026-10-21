// Test environment. The test database is separate from development data.
process.env.APP_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://luma_app:luma_app_dev@localhost:5432/luma_test';
process.env.DATABASE_OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://luma_owner:luma_owner_dev@localhost:5432/luma_test';
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.DEV_OTP_ECHO = 'true';
process.env.DEMO_MODE = 'false';
process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_MODEL = '';
process.env.STORAGE_LOCAL_DIR = './storage-test';
