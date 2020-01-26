import { Pool, PoolConfig, PoolClient } from 'pg';
import { Backend, QueryResult } from './backend';
import url from 'url';

export class PgBackend implements Backend {
  private client: Pool | PoolClient;

  constructor(databaseUrlOrClient: string | PoolClient) {
    if (typeof databaseUrlOrClient === `string`) {
      const databaseUrl = databaseUrlOrClient;
      const { auth, hostname, port, pathname } = url.parse(databaseUrl);
      const [user, password] = (auth || '').split(':');

      const config: PoolConfig = {
        user,
        password,
        host: hostname || undefined,
        port: parseInt(port || '5432', 10),
        database: (pathname || '').slice(1),
        ssl:
          process.env.NODE_ENV !== `test` &&
          !process.env.MAMMOTH_DISABLE_SSL &&
          process.env.PGSSLROOTCERT
            ? {
                // sslmode: 'verify-full',
                // sslrootcert: process.env.PGSSLROOTCERT,
              }
            : false,
      };

      this.client = new Pool(config);
    } else {
      const client = databaseUrlOrClient;
      this.client = client;
    }

    if (!this.client) {
      throw new Error(`Could not find client: ${databaseUrlOrClient}`);
    }
  }

  async query(text: string, parameters?: any[]): Promise<QueryResult> {
    const result = await this.client.query(text, parameters);

    return {
      rows: result.rows,
      count: result.rowCount,
    };
  }

  async destroy() {
    if (`end` in this.client) {
      await this.client.end();
    }
  }

  async transaction<T>(callback: (backend: Backend) => Promise<T>): Promise<T> {
    if (`release` in this.client) {
      // Because the client has a release we assume this is an existing pool client. This means
      // we're already inside a transaction so we just invoke the callback.
      return Promise.resolve(callback(this));
    }

    const client = await this.client.connect();

    try {
      await client.query(`BEGIN`);

      const backend = new PgBackend(client);
      const result = await Promise.resolve(callback(backend));

      await client.query(`COMMIT`);
      return result;
    } catch (e) {
      await client.query(`ROLLBACK`);

      throw e;
    } finally {
      client.release();
    }
  }
}
