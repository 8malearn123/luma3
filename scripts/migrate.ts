import { loadDotEnv } from './load-env';
import { migrate } from '../src/server/db/migrator';

loadDotEnv();
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required to run migrations');
  process.exit(1);
}
migrate({ connectionString: url, appRole: process.env.DB_APP_ROLE || 'luma_app', log: (m) => console.log(`[migrate] ${m}`) })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[migrate] ${err.message}`);
    process.exit(1);
  });
