const dotenv = require('dotenv');
const { execSync } = require('child_process');
const { existsSync } = require('fs');

// Fallback: map DATABASE_URL to DATABASE_CONNECTION_URI when not explicitly set.
// PaaS platforms (Render, Railway, etc.) typically provide DATABASE_URL,
// but Prisma schemas in this project read DATABASE_CONNECTION_URI.
// This must run BEFORE dotenv.config() so that dotenv does not override with
// the default .env value (which points to the Docker-internal hostname).
if (!process.env.DATABASE_CONNECTION_URI && process.env.DATABASE_URL) {
  process.env.DATABASE_CONNECTION_URI = process.env.DATABASE_URL;
}

// For psql_bouncer: map DATABASE_URL to DATABASE_BOUNCER_CONNECTION_URI when not set.
if (process.env.DATABASE_PROVIDER === 'psql_bouncer') {
  if (!process.env.DATABASE_BOUNCER_CONNECTION_URI && process.env.DATABASE_URL) {
    process.env.DATABASE_BOUNCER_CONNECTION_URI = process.env.DATABASE_URL;
  }
}

dotenv.config();

const { DATABASE_PROVIDER } = process.env;
const databaseProviderDefault = DATABASE_PROVIDER ?? 'postgresql';

if (!DATABASE_PROVIDER) {
  console.warn(`DATABASE_PROVIDER is not set in the .env file, using default: ${databaseProviderDefault}`);
}

// Função para determinar qual pasta de migrations usar
// Função para determinar qual pasta de migrations usar
function getMigrationsFolder(provider) {
  switch (provider) {
    case 'psql_bouncer':
      return 'postgresql-migrations'; // psql_bouncer usa as migrations do postgresql
    default:
      return `${provider}-migrations`;
  }
}

const migrationsFolder = getMigrationsFolder(databaseProviderDefault);

let command = process.argv
  .slice(2)
  .join(' ')
  .replace(/DATABASE_PROVIDER/g, databaseProviderDefault);

// Substituir referências à pasta de migrations pela pasta correta
const migrationsPattern = new RegExp(`${databaseProviderDefault}-migrations`, 'g');
command = command.replace(migrationsPattern, migrationsFolder);

if (command.includes('rmdir') && existsSync('prisma\\migrations')) {
  try {
    execSync('rmdir /S /Q prisma\\migrations', { stdio: 'inherit' });
  } catch (error) {
    console.error(`Error removing directory: prisma\\migrations`);
    process.exit(1);
  }
} else if (command.includes('rmdir')) {
  console.warn(`Directory 'prisma\\migrations' does not exist, skipping removal.`);
}

try {
  execSync(command, { stdio: 'inherit' });
} catch (error) {
  console.error(`Error executing command: ${command}`);
  process.exit(1);
}