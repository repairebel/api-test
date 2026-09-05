#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

get_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0

  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"

  if [[ "$line" == \"*\" && "$line" == *\" ]]; then
    line="${line:1:-1}"
  fi

  printf '%s' "$line"
}

parse_url_part() {
  local raw_url="$1"
  local part="$2"

  if [[ -z "$raw_url" ]]; then
    return 0
  fi

  node -e '
    const raw = process.argv[1];
    const part = process.argv[2];
    const url = new URL(raw);

    switch (part) {
      case "scheme":
        process.stdout.write((url.protocol || "").replace(/:$/, ""));
        break;
      case "host":
        process.stdout.write(url.hostname);
        break;
      case "port":
        process.stdout.write(url.port);
        break;
      case "user":
        process.stdout.write(decodeURIComponent(url.username));
        break;
      case "pass":
        process.stdout.write(decodeURIComponent(url.password));
        break;
      case "db":
        process.stdout.write((url.pathname || "").replace(/^\/+/, ""));
        break;
      case "sslmode":
        process.stdout.write(url.searchParams.get("sslmode") || "");
        break;
      case "insecure":
        process.stdout.write(url.searchParams.get("insecure") || "");
        break;
      case "redisdb":
        process.stdout.write(((url.pathname || "/0").replace(/^\/+/, "")) || "0");
        break;
      default:
        process.exit(1);
    }
  ' "$raw_url" "$part"
}

upsert_env_value() {
  local key="$1"
  local raw_value="$2"

  node -e '
    const fs = require("fs");
    const envFile = process.argv[1];
    const key = process.argv[2];
    const rawValue = process.argv[3];

    const serialize = (value) => (/^[A-Za-z0-9_./:@?&=%+-]+$/.test(value) ? value : JSON.stringify(value));

    let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    const entry = `${key}=${serialize(rawValue)}`;
    const lines = text ? text.split(/\r?\n/) : [];
    let replaced = false;

    const nextLines = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        replaced = true;
        return entry;
      }

      return line;
    });

    if (!replaced) {
      if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
        nextLines.push(entry);
      } else if (nextLines.length) {
        nextLines.splice(nextLines.length - 1, 0, entry);
      } else {
        nextLines.push(entry);
      }
    }

    fs.writeFileSync(envFile, `${nextLines.join("\n").replace(/\n*$/, "")}\n`);
  ' "$ENV_FILE" "$key" "$raw_value"
}

prompt_with_default() {
  local label="$1"
  local default_value="$2"
  local target_var="$3"
  local reply=""

  read -r -p "$label [$default_value]: " reply
  if [[ -z "$reply" ]]; then
    reply="$default_value"
  fi

  printf -v "$target_var" '%s' "$reply"
}

prompt_optional() {
  local label="$1"
  local default_value="$2"
  local target_var="$3"
  local reply=""

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [press Enter to keep current: $default_value]: " reply
    if [[ -z "$reply" ]]; then
      reply="$default_value"
    fi
  else
    read -r -p "$label [leave blank for none]: " reply
  fi

  printf -v "$target_var" '%s' "$reply"
}

prompt_secret() {
  local label="$1"
  local default_value="$2"
  local target_var="$3"
  local reply=""

  if [[ -n "$default_value" ]]; then
    read -r -s -p "$label [press Enter to keep current]: " reply
  else
    read -r -s -p "$label: " reply
  fi
  printf '\n'

  if [[ -z "$reply" ]]; then
    reply="$default_value"
  fi

  printf -v "$target_var" '%s' "$reply"
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local target_var="$3"
  local reply=""

  while true; do
    read -r -p "$label [$default_value]: " reply
    if [[ -z "$reply" ]]; then
      reply="$default_value"
    fi

    case "${reply,,}" in
      y|yes|true|1)
        printf -v "$target_var" '%s' "yes"
        return 0
        ;;
      n|no|false|0)
        printf -v "$target_var" '%s' "no"
        return 0
        ;;
      *)
        echo "Please answer yes or no."
        ;;
    esac
  done
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  fi
}

require_non_empty() {
  local label="$1"
  local value="$2"

  if [[ -z "$value" ]]; then
    echo "Error: $label cannot be empty." >&2
    exit 1
  fi
}

build_database_url() {
  local db_user="$1"
  local db_pass="$2"
  local db_host="$3"
  local db_port="$4"
  local db_name="$5"
  local db_ssl="$6"
  local db_insecure="$7"

  node -e '
    const [user, pass, host, port, db, ssl, insecure] = process.argv.slice(1);
    const base = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(db)}`;
    if (ssl === "yes") {
      const sslMode = insecure === "yes" ? "no-verify" : "verify-full";
      process.stdout.write(`${base}?sslmode=${sslMode}`);
    } else {
      process.stdout.write(base);
    }
  ' "$db_user" "$db_pass" "$db_host" "$db_port" "$db_name" "$db_ssl" "$db_insecure"
}

build_redis_url() {
  local redis_host="$1"
  local redis_port="$2"
  local redis_user="$3"
  local redis_pass="$4"
  local redis_db="$5"
  local redis_ssl="$6"
  local redis_insecure="$7"

  node -e '
    const [host, port, user, pass, db, ssl, insecure] = process.argv.slice(1);
    const scheme = ssl === "yes" ? "rediss" : "redis";
    let auth = "";

    if (user && pass) {
      auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    } else if (user) {
      auth = `${encodeURIComponent(user)}@`;
    } else if (pass) {
      auth = `:${encodeURIComponent(pass)}@`;
    }

    const query = ssl === "yes" && insecure === "yes" ? "?insecure=true" : "";
    process.stdout.write(`${scheme}://${auth}${host}:${port}/${db || "0"}${query}`);
  ' "$redis_host" "$redis_port" "$redis_user" "$redis_pass" "$redis_db" "$redis_ssl" "$redis_insecure"
}

quote_ident_sql() {
  local value="$1"
  value="${value//\"/\"\"}"
  printf '"%s"' "$value"
}

quote_literal_sql() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

database_exists() {
  local db_host="$1"
  local db_port="$2"
  local db_user="$3"
  local db_pass="$4"
  local db_name="$5"
  local db_ssl="$6"
  local db_insecure="$7"
  local query_result=""
  local pg_sslmode="disable"

  if [[ "$db_ssl" == "yes" ]]; then
    if [[ "$db_insecure" == "yes" ]]; then
      pg_sslmode="require"
    else
      pg_sslmode="verify-full"
    fi
  fi

  query_result="$(PGPASSWORD="$db_pass" PGSSLMODE="$pg_sslmode" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres -tA -v ON_ERROR_STOP=1 \
    -c "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $(quote_literal_sql "$db_name"));" \
    2>/dev/null || true)"

  [[ "$query_result" == "t" ]]
}

create_database_as_postgres_user() {
  local db_host="$1"
  local db_name="$2"
  local db_owner="$3"
  local create_sql="CREATE DATABASE $(quote_ident_sql "$db_name") OWNER $(quote_ident_sql "$db_owner");"

  if [[ "$db_host" != "localhost" && "$db_host" != "127.0.0.1" && "$db_host" != "::1" ]]; then
    return 1
  fi

  if command -v runuser >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
    runuser -u postgres -- psql -d postgres -v ON_ERROR_STOP=1 -c "$create_sql"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "$create_sql"
    return 0
  fi

  return 1
}

get_admin_setup_state() {
  local database_url="$1"

  DB_URL="$database_url" node --input-type=module <<'NODE'
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DB_URL;
const url = new URL(connectionString);
const sslMode = (url.searchParams.get('sslmode') || '').toLowerCase();
const config = { connectionString };

if (sslMode === 'no-verify') {
  config.ssl = { rejectUnauthorized: false };
} else if (sslMode && sslMode !== 'disable') {
  config.ssl = { rejectUnauthorized: true };
}

const pool = new Pool(config);

try {
  const tableCheck = await pool.query(`
    SELECT
      to_regclass('public.admin_users') AS admin_users_table,
      to_regclass('public.users') AS users_table
  `);

  const adminUsersTable = tableCheck.rows[0]?.admin_users_table;
  const usersTable = tableCheck.rows[0]?.users_table;

  if (!adminUsersTable || !usersTable) {
    process.stdout.write('missing,missing');
  } else {
    const adminUsersResult = await pool.query('SELECT COUNT(*)::int AS count FROM public.admin_users');
    const adminAccountsResult = await pool.query(`SELECT COUNT(*)::int AS count FROM public.users WHERE user_type = 'ADMIN'`);
    process.stdout.write(`${adminUsersResult.rows[0].count},${adminAccountsResult.rows[0].count}`);
  }
} finally {
  await pool.end();
}
NODE
}

echo "RepairRebel server setup"
echo "Directory: $SCRIPT_DIR"
echo

cd "$SCRIPT_DIR"

CURRENT_DATABASE_URL="$(get_env_value DATABASE_URL)"
CURRENT_REDIS_URL="$(get_env_value REDIS_URL)"
CURRENT_PORT="$(get_env_value PORT)"
CURRENT_NODE_ENV="$(get_env_value NODE_ENV)"
CURRENT_SMTP_HOST="$(get_env_value SMTP_HOST)"
CURRENT_SMTP_PORT="$(get_env_value SMTP_PORT)"
CURRENT_SMTP_USER="$(get_env_value SMTP_USER)"
CURRENT_SMTP_PASS="$(get_env_value SMTP_PASS)"
CURRENT_SMTP_FROM="$(get_env_value SMTP_FROM)"
CURRENT_JWT_ACCESS_SECRET="$(get_env_value JWT_ACCESS_SECRET)"
CURRENT_JWT_REFRESH_SECRET="$(get_env_value JWT_REFRESH_SECRET)"
CURRENT_JWT_ACCESS_EXPIRES_IN="$(get_env_value JWT_ACCESS_EXPIRES_IN)"
CURRENT_JWT_REFRESH_EXPIRES_IN="$(get_env_value JWT_REFRESH_EXPIRES_IN)"
CURRENT_DB_SSLMODE="$(parse_url_part "$CURRENT_DATABASE_URL" sslmode)"
CURRENT_REDIS_SCHEME="$(parse_url_part "$CURRENT_REDIS_URL" scheme)"
CURRENT_REDIS_INSECURE="$(parse_url_part "$CURRENT_REDIS_URL" insecure)"

DEFAULT_NODE_ENV="${CURRENT_NODE_ENV:-production}"
DEFAULT_APP_PORT="${CURRENT_PORT:-6664}"
DEFAULT_DB_HOST="$(parse_url_part "$CURRENT_DATABASE_URL" host)"
DEFAULT_DB_PORT="$(parse_url_part "$CURRENT_DATABASE_URL" port)"
DEFAULT_DB_NAME="$(parse_url_part "$CURRENT_DATABASE_URL" db)"
DEFAULT_DB_USER="$(parse_url_part "$CURRENT_DATABASE_URL" user)"
DEFAULT_DB_PASS="$(parse_url_part "$CURRENT_DATABASE_URL" pass)"
DEFAULT_REDIS_HOST="$(parse_url_part "$CURRENT_REDIS_URL" host)"
DEFAULT_REDIS_PORT="$(parse_url_part "$CURRENT_REDIS_URL" port)"
DEFAULT_REDIS_USER="$(parse_url_part "$CURRENT_REDIS_URL" user)"
DEFAULT_REDIS_PASS="$(parse_url_part "$CURRENT_REDIS_URL" pass)"
DEFAULT_REDIS_DB="$(parse_url_part "$CURRENT_REDIS_URL" redisdb)"

DEFAULT_DB_HOST="${DEFAULT_DB_HOST:-localhost}"
DEFAULT_DB_PORT="${DEFAULT_DB_PORT:-5432}"
DEFAULT_DB_NAME="${DEFAULT_DB_NAME:-repairrebel}"
DEFAULT_DB_USER="${DEFAULT_DB_USER:-postgres}"
DEFAULT_REDIS_HOST="${DEFAULT_REDIS_HOST:-localhost}"
DEFAULT_REDIS_PORT="${DEFAULT_REDIS_PORT:-6379}"
DEFAULT_REDIS_DB="${DEFAULT_REDIS_DB:-0}"
DEFAULT_SMTP_PORT="${CURRENT_SMTP_PORT:-587}"

DEFAULT_DB_SSL="no"
if [[ -n "$CURRENT_DB_SSLMODE" && "$CURRENT_DB_SSLMODE" != "disable" ]]; then
  DEFAULT_DB_SSL="yes"
elif [[ "$DEFAULT_DB_HOST" != "localhost" && "$DEFAULT_DB_HOST" != "127.0.0.1" && "$DEFAULT_DB_HOST" != "::1" ]]; then
  DEFAULT_DB_SSL="yes"
fi

DEFAULT_DB_INSECURE="no"
if [[ "$CURRENT_DB_SSLMODE" == "no-verify" ]]; then
  DEFAULT_DB_INSECURE="yes"
elif [[ "$DEFAULT_DB_HOST" == *.proxy.rlwy.net ]]; then
  DEFAULT_DB_INSECURE="yes"
fi

DEFAULT_REDIS_SSL="no"
if [[ "$CURRENT_REDIS_SCHEME" == "rediss" ]]; then
  DEFAULT_REDIS_SSL="yes"
elif [[ "$DEFAULT_REDIS_HOST" != "localhost" && "$DEFAULT_REDIS_HOST" != "127.0.0.1" && "$DEFAULT_REDIS_HOST" != "::1" ]]; then
  DEFAULT_REDIS_SSL="yes"
fi

DEFAULT_REDIS_INSECURE="no"
if [[ "$CURRENT_REDIS_INSECURE" == "true" ]]; then
  DEFAULT_REDIS_INSECURE="yes"
elif [[ "$DEFAULT_REDIS_HOST" == *.proxy.rlwy.net ]]; then
  DEFAULT_REDIS_INSECURE="yes"
fi

prompt_with_default "Node environment" "$DEFAULT_NODE_ENV" NODE_ENV_VALUE
prompt_with_default "Application port" "$DEFAULT_APP_PORT" APP_PORT_VALUE
prompt_with_default "PostgreSQL host / IP" "$DEFAULT_DB_HOST" DB_HOST_VALUE
prompt_with_default "PostgreSQL port" "$DEFAULT_DB_PORT" DB_PORT_VALUE
prompt_with_default "PostgreSQL database name" "$DEFAULT_DB_NAME" DB_NAME_VALUE
prompt_with_default "PostgreSQL user" "$DEFAULT_DB_USER" DB_USER_VALUE
prompt_secret "PostgreSQL password" "$DEFAULT_DB_PASS" DB_PASS_VALUE
prompt_yes_no "Use PostgreSQL SSL" "$DEFAULT_DB_SSL" DB_SSL_VALUE
DB_INSECURE_VALUE="no"
if [[ "$DB_SSL_VALUE" == "yes" ]]; then
  prompt_yes_no "Allow self-signed PostgreSQL certificates" "$DEFAULT_DB_INSECURE" DB_INSECURE_VALUE
fi
prompt_with_default "Redis host / IP" "$DEFAULT_REDIS_HOST" REDIS_HOST_VALUE
prompt_with_default "Redis port" "$DEFAULT_REDIS_PORT" REDIS_PORT_VALUE
prompt_optional "Redis username" "$DEFAULT_REDIS_USER" REDIS_USER_VALUE
prompt_secret "Redis password" "$DEFAULT_REDIS_PASS" REDIS_PASS_VALUE
prompt_yes_no "Use Redis SSL" "$DEFAULT_REDIS_SSL" REDIS_SSL_VALUE
REDIS_INSECURE_VALUE="no"
if [[ "$REDIS_SSL_VALUE" == "yes" ]]; then
  prompt_yes_no "Allow self-signed Redis certificates" "$DEFAULT_REDIS_INSECURE" REDIS_INSECURE_VALUE
fi
prompt_with_default "Redis database index" "$DEFAULT_REDIS_DB" REDIS_DB_VALUE

if [[ -z "$CURRENT_SMTP_HOST" ]]; then
  prompt_with_default "SMTP host" "smtp.example.com" SMTP_HOST_VALUE
else
  SMTP_HOST_VALUE="$CURRENT_SMTP_HOST"
fi

if [[ -z "$CURRENT_SMTP_PORT" ]]; then
  prompt_with_default "SMTP port" "$DEFAULT_SMTP_PORT" SMTP_PORT_VALUE
else
  SMTP_PORT_VALUE="$CURRENT_SMTP_PORT"
fi

if [[ -z "$CURRENT_SMTP_USER" ]]; then
  prompt_with_default "SMTP user" "change-me@example.com" SMTP_USER_VALUE
else
  SMTP_USER_VALUE="$CURRENT_SMTP_USER"
fi

if [[ -z "$CURRENT_SMTP_PASS" ]]; then
  prompt_secret "SMTP password" "" SMTP_PASS_VALUE
else
  SMTP_PASS_VALUE="$CURRENT_SMTP_PASS"
fi

if [[ -z "$CURRENT_SMTP_FROM" ]]; then
  prompt_with_default "SMTP from" "Repairebel <no-reply@example.com>" SMTP_FROM_VALUE
else
  SMTP_FROM_VALUE="$CURRENT_SMTP_FROM"
fi

JWT_ACCESS_SECRET_VALUE="${CURRENT_JWT_ACCESS_SECRET:-$(generate_secret)}"
JWT_REFRESH_SECRET_VALUE="${CURRENT_JWT_REFRESH_SECRET:-$(generate_secret)}"
JWT_ACCESS_EXPIRES_IN_VALUE="${CURRENT_JWT_ACCESS_EXPIRES_IN:-15m}"
JWT_REFRESH_EXPIRES_IN_VALUE="${CURRENT_JWT_REFRESH_EXPIRES_IN:-7d}"

DATABASE_URL_VALUE="$(build_database_url "$DB_USER_VALUE" "$DB_PASS_VALUE" "$DB_HOST_VALUE" "$DB_PORT_VALUE" "$DB_NAME_VALUE" "$DB_SSL_VALUE" "$DB_INSECURE_VALUE")"
REDIS_URL_VALUE="$(build_redis_url "$REDIS_HOST_VALUE" "$REDIS_PORT_VALUE" "$REDIS_USER_VALUE" "$REDIS_PASS_VALUE" "$REDIS_DB_VALUE" "$REDIS_SSL_VALUE" "$REDIS_INSECURE_VALUE")"

require_non_empty "SMTP host" "$SMTP_HOST_VALUE"
require_non_empty "SMTP user" "$SMTP_USER_VALUE"
require_non_empty "SMTP password" "$SMTP_PASS_VALUE"
require_non_empty "SMTP from" "$SMTP_FROM_VALUE"

if [[ -f "$ENV_FILE" ]]; then
  ENV_BACKUP_FILE="$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"
  cp "$ENV_FILE" "$ENV_BACKUP_FILE"
  echo "Backed up existing .env to $ENV_BACKUP_FILE"
fi

touch "$ENV_FILE"

upsert_env_value "NODE_ENV" "$NODE_ENV_VALUE"
upsert_env_value "PORT" "$APP_PORT_VALUE"
upsert_env_value "DATABASE_URL" "$DATABASE_URL_VALUE"
upsert_env_value "REDIS_URL" "$REDIS_URL_VALUE"
upsert_env_value "JWT_ACCESS_SECRET" "$JWT_ACCESS_SECRET_VALUE"
upsert_env_value "JWT_REFRESH_SECRET" "$JWT_REFRESH_SECRET_VALUE"
upsert_env_value "JWT_ACCESS_EXPIRES_IN" "$JWT_ACCESS_EXPIRES_IN_VALUE"
upsert_env_value "JWT_REFRESH_EXPIRES_IN" "$JWT_REFRESH_EXPIRES_IN_VALUE"
upsert_env_value "SMTP_HOST" "$SMTP_HOST_VALUE"
upsert_env_value "SMTP_PORT" "$SMTP_PORT_VALUE"
upsert_env_value "SMTP_USER" "$SMTP_USER_VALUE"
upsert_env_value "SMTP_PASS" "$SMTP_PASS_VALUE"
upsert_env_value "SMTP_FROM" "$SMTP_FROM_VALUE"

echo
echo "Updated server .env with PostgreSQL and Redis settings."
echo "DATABASE_URL=$DATABASE_URL_VALUE"
echo "REDIS_URL=$REDIS_URL_VALUE"
echo "POSTGRES_SSL=$DB_SSL_VALUE"
echo "REDIS_SSL=$REDIS_SSL_VALUE"
echo "POSTGRES_SSL_INSECURE=$DB_INSECURE_VALUE"
echo "REDIS_SSL_INSECURE=$REDIS_INSECURE_VALUE"
echo
echo "Removing node_modules and package-lock.json if they exist..."
rm -rf "$SCRIPT_DIR/node_modules"
rm -f "$SCRIPT_DIR/package-lock.json"

echo "Installing TypeScript dev dependency..."
npm install --save-dev typescript

echo "Installing project dependencies..."
npm install

echo "Building server..."
npm run build

echo
echo "Running database setup (create if needed, migrate, seed baseline data)..."
DB_SETUP_ARGS=()
if database_exists "$DB_HOST_VALUE" "$DB_PORT_VALUE" "$DB_USER_VALUE" "$DB_PASS_VALUE" "$DB_NAME_VALUE" "$DB_SSL_VALUE" "$DB_INSECURE_VALUE"; then
  echo "Database \"$DB_NAME_VALUE\" already exists. Skipping create step."
  DB_SETUP_ARGS=(-- --no-create)
elif create_database_as_postgres_user "$DB_HOST_VALUE" "$DB_NAME_VALUE" "$DB_USER_VALUE"; then
  echo "Created database \"$DB_NAME_VALUE\" with owner \"$DB_USER_VALUE\" via postgres OS user."
  DB_SETUP_ARGS=(-- --no-create)
else
  echo "Could not create database via postgres OS user. Falling back to application-level create step."
fi

npm run db:setup "${DB_SETUP_ARGS[@]}"

echo
echo "Checking admin bootstrap status..."
ADMIN_SETUP_STATE="$(get_admin_setup_state "$DATABASE_URL_VALUE")"
IFS=',' read -r ADMIN_USERS_COUNT ADMIN_ACCOUNTS_COUNT <<< "$ADMIN_SETUP_STATE"

if [[ "$ADMIN_USERS_COUNT" == "missing" || "$ADMIN_ACCOUNTS_COUNT" == "missing" ]]; then
  echo "Skipping initial admin setup because admin tables are not present in this database yet."
elif [[ "$ADMIN_USERS_COUNT" -gt 0 ]]; then
  echo "Admin setup skipped because the database already has an admin user."
elif [[ "$ADMIN_ACCOUNTS_COUNT" -gt 0 ]]; then
  echo "Repairing admin access for an existing ADMIN account..."
  npx tsx src/scripts/seed-admin.ts
else
  echo "No admin user found in the database. Creating the initial super admin."
  prompt_with_default "Initial admin name" "Super Admin" ADMIN_NAME_VALUE
  prompt_with_default "Initial admin email" "admin@repairrebel.com" ADMIN_EMAIL_VALUE
  prompt_secret "Initial admin password" "" ADMIN_PASSWORD_VALUE

  require_non_empty "Initial admin name" "$ADMIN_NAME_VALUE"
  require_non_empty "Initial admin email" "$ADMIN_EMAIL_VALUE"
  require_non_empty "Initial admin password" "$ADMIN_PASSWORD_VALUE"

  ADMIN_NAME="$ADMIN_NAME_VALUE" \
  ADMIN_EMAIL="$ADMIN_EMAIL_VALUE" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD_VALUE" \
  npx tsx src/scripts/seed-admin.ts
fi

echo
echo "RepairRebel server setup is complete."
echo "Schema file: $SCRIPT_DIR/database-schema.sql"
echo "Seed file:   $SCRIPT_DIR/database-seed.sql"
