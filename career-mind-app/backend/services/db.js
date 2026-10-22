const { createClient } = require('@supabase/supabase-js');
const { AppError } = require('./agents');

// Server-side Supabase client. It uses the secret (service role) key, so it
// bypasses Row Level Security: every query here must filter by user itself.
let client = null;

function secretKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function dbEnabled() {
  return !!(process.env.SUPABASE_URL && secretKey());
}

function db() {
  if (!dbEnabled()) {
    throw new AppError('Accounts are not enabled. Set SUPABASE_URL and SUPABASE_SECRET_KEY on the server.', 503);
  }
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, secretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Throws a clean 500 for a Supabase error, logging the details. */
function check({ data, error }, what) {
  if (error) {
    console.error(`DB ${what} failed:`, error.message);
    throw new AppError(`Could not ${what}. Try again shortly.`, 500);
  }
  return data;
}

// For tests: swap in a fake client.
function setClient(fake) {
  client = fake;
}

module.exports = { db, dbEnabled, check, setClient };
