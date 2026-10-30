import { loadConfig } from './config.js';
import { AppDatabase, backupIfDue } from './database.js';
import { AppStore } from './domain.js';
import { RoomEventBroker } from './events.js';
import { buildApp } from './app.js';

const config = loadConfig();
const database = new AppDatabase(config.databasePath);
const store = new AppStore(database);
const events = new RoomEventBroker();
const app = await buildApp({ config, database, store, events });

const backupTimer = setInterval(() => {
  void backupIfDue(database, config.backupDir).catch((error: unknown) => {
    app.log.error({ err: error }, 'Scheduled backup failed');
  });
}, 60 * 60 * 1000);
backupTimer.unref();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  clearInterval(backupTimer);
  await app.close();
  database.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  database.close();
  process.exit(1);
}
