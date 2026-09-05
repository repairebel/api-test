import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

type Flags = {
  schemaOnly: boolean;
  dataOnly: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags = new Set(argv);
  return {
    schemaOnly: flags.has('--schema-only'),
    dataOnly: flags.has('--data-only'),
  };
}

function getProjectRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '../..');
}

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

async function runPgDump(args: string[], outputPath: string, databaseUrl: string) {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { flags: 'w' });
    const child = spawn('pg_dump', args, {
      env: { ...process.env, PGPASSWORD: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.pipe(output);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      output.close();
      reject(error);
    });

    child.on('close', (code) => {
      output.close();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pg_dump failed for ${databaseUrl}: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = requireDatabaseUrl();
  const projectRoot = getProjectRoot();

  const shouldDumpSchema = !flags.dataOnly;
  const shouldDumpData = !flags.schemaOnly;

  if (shouldDumpSchema) {
    const schemaPath = path.join(projectRoot, 'database-schema.sql');
    console.log(`Writing schema dump to ${schemaPath}...`);
    await runPgDump(
      ['--schema-only', '--no-owner', '--no-privileges', databaseUrl],
      schemaPath,
      databaseUrl,
    );
  }

  if (shouldDumpData) {
    const dataPath = path.join(projectRoot, 'database-seed.sql');
    console.log(`Writing data dump to ${dataPath}...`);
    await runPgDump(
      ['--data-only', '--inserts', '--no-owner', '--no-privileges', databaseUrl],
      dataPath,
      databaseUrl,
    );
  }

  console.log('Database dump complete.');
}

main().catch((error) => {
  console.error('Database dump failed:', error);
  process.exit(1);
});
