'use strict';

/**
 * The settings this application ships with.
 *
 * The deployed app reads no Application Settings from its host and carries no
 * .env file — .env is gitignored, so it never reaches the build artifact.
 * These values travel with the code instead, which is what keeps the
 * deployment identical to a developer's machine.
 *
 * Precedence: a real environment variable ALWAYS wins. Nothing here overwrites
 * a value the host or a local .env already provides, so a developer's own
 * .env keeps working exactly as before and a host setting can still override
 * any of this without a code change.
 *
 * NODE_ENV is the one value that is NOT copied from anyone's .env: it is
 * production here, because a machine with no .env at all is a deployment. A
 * developer's .env says development and wins, as it should.
 *
 * SECURITY: this file contains a live database connection string and the token
 * signing secret, and it is committed. Anyone who can read this repository can
 * read the database and mint valid sessions. Rotating either credential means
 * editing this file and deploying — and the old value stays in git history.
 */

/** Fill in a variable only when the environment has not already set one. */
function applyDefaults(defaults, env = process.env) {
  for (const [key, value] of Object.entries(defaults)) {
    if (env[key] === undefined || String(env[key]).trim() === '') {
      env[key] = value;
    }
  }
  return env;
}

const DEFAULTS = {
  "NODE_ENV": "production",
  "MONGODB_URI": "mongodb+srv://bahadur3028_db_user:HDTiC60Z7wBPxaey@clusterdhs.c0ai6pq.mongodb.net/dba_utility?retryWrites=true&w=majority",
  "AUTH_SECRET": "1eeac4e78e162d85d5da186679c9a8c5c9a087982c5b3bc95f45314940c31d0a",
  "CORS_ORIGIN": "https://dba.erpthemes.com,http://dba.erpthemes.com,http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:4173",
  "RATE_LIMIT_WINDOW_MS": "900000",
  "RATE_LIMIT_MAX": "1000",
  "DEFAULT_USER_ID": "u-1001",
  "DEFAULT_USER_NAME": "System Administrator",
  "LOG_VIEW_ACTIONS": "false",
  "CLUSTER_ANANDA_DB": "dba_ananda",
  "CLUSTER_DOTIN_DB": "dba_dotin",
  "CLUSTER_COLSTON_DB": "dba_colston",
  "CLUSTER_KAMDHENU_DB": "dba_kamdhenu",
  "CLUSTER_KAMDHENU_DATA_URI": "mongodb+srv://adminuser_db_user:NIM3lV6tj7X7ym8Jdet@ClusterKamdhenuNew.x3jsp4.mongodb.net/ERP_40019",
  "CLUSTER_COLSTON_DATA_URI": "mongodb+srv://colstonbathindia:Poptnfn2175det@colstoncluster.3ggrl.mongodb.net",
  "CLUSTER_DOTIN_DATA_URI": "mongodb+srv://DotinTestUser:pC1J1J8DKdzHPuJa@dotinclusternew.3sxaxn.mongodb.net/",
};

applyDefaults(DEFAULTS);

module.exports = { DEFAULTS, applyDefaults };

//setting
