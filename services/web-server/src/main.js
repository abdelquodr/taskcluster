require('../../prelude');
const debug = require('debug')('app:main');
const assert = require('assert');
const depthLimit = require('graphql-depth-limit');
const { createComplexityLimitRule } = require('graphql-validation-complexity');
const loader = require('taskcluster-lib-loader');
const config = require('taskcluster-lib-config');
const libReferences = require('taskcluster-lib-references');
const { createServer } = require('http');
const { Client, pulseCredentials } = require('taskcluster-lib-pulse');
const { ApolloServer } = require('apollo-server-express');
const { ApolloServerPluginDrainHttpServer } = require('apollo-server-core');
const taskcluster = require('taskcluster-client');
const tcdb = require('taskcluster-db');
const { Auth } = require('taskcluster-client');
const { MonitorManager } = require('taskcluster-lib-monitor');
const createApp = require('./servers/createApp');
const formatError = require('./servers/formatError');
const clients = require('./clients');
const createContext = require('./createContext');
const createSchema = require('./createSchema');
const createSubscriptionServer = require('./servers/createSubscriptionServer');
const resolvers = require('./resolvers');
const typeDefs = require('./graphql');
const PulseEngine = require('./PulseEngine');
const scanner = require('./login/scanner');

require('./monitor');

const load = loader(
  {
    cfg: {
      requires: ['profile'],
      setup: ({ profile }) => config({
        profile,
        serviceName: 'web-server',
      }),
    },

    monitor: {
      requires: ['cfg', 'profile', 'process'],
      setup: ({ cfg, profile, process }) =>
        MonitorManager.setup({
          serviceName: 'web-server',
          processName: process,
          verify: profile !== 'production',
          ...cfg.monitoring,
        }),
    },

    pulseClient: {
      requires: ['cfg', 'monitor'],
      setup: ({ cfg, monitor }) => {
        if (!cfg.pulse.username) {
          assert(
            process.env.NODE_ENV !== 'production',
            'pulse credentials are required in production',
          );

          return null;
        }

        return new Client({
          monitor: monitor.childMonitor('pulse-client'),
          namespace: cfg.pulse.namespace,
          credentials: pulseCredentials(cfg.pulse),
        });
      },
    },

    pulseEngine: {
      requires: ['pulseClient', 'monitor'],
      setup: ({ pulseClient, monitor }) =>
        new PulseEngine({
          pulseClient,
          monitor: monitor.childMonitor('pulse-engine'),
        }),
    },

    schema: {
      requires: [],
      setup: () =>
        createSchema({
          typeDefs,
          resolvers,
          resolverValidationOptions: {
            requireResolversForResolveType: false,
          },
          validationRules: [depthLimit(10), createComplexityLimitRule(1000)],
        }),
    },

    clients: {
      requires: [],
      setup: () => clients,
    },

    context: {
      requires: ['cfg', 'pulseEngine', 'strategies', 'clients', 'monitor'],
      setup: ({ cfg, pulseEngine, strategies, clients, monitor }) =>
        createContext({
          clients,
          pulseEngine,
          rootUrl: cfg.taskcluster.rootUrl,
          strategies,
          cfg,
          monitor: monitor.childMonitor('context'),
        }),
    },

    generateReferences: {
      requires: ['cfg'],
      setup: ({ cfg }) => libReferences.fromService({
        references: [MonitorManager.reference('web-server')],
      }).generateReferences(),
    },

    app: {
      requires: ['cfg', 'strategies', 'auth', 'monitor', 'db'],
      setup: ({ cfg, strategies, auth, monitor, db }) =>
        createApp({ cfg, strategies, auth, monitor, db }),
    },

    httpServer: {
      requires: ['app', 'schema', 'context', 'monitor'],
      setup: async ({ app, schema, context, monitor }) => {
        const httpServer = createServer(app);
        const server = new ApolloServer({
          schema,
          context,
          formatError,
          tracing: true,
          plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
        });
        await server.start();

        server.applyMiddleware({
          app,
          // Prevent apollo server to overwrite what we already have for cors
          cors: false,
        });

        createSubscriptionServer({
          server: httpServer, // this attaches itself directly to the server
          schema,
          context,
          path: '/subscription',
        });

        return httpServer;
      },
    },

    // Login strategies
    strategies: {
      requires: ['cfg', 'monitor', 'db'],
      setup: ({ cfg, monitor, db }) => {
        const strategies = {};

        Object.keys(cfg.login.strategies || {}).forEach((name) => {
          const Strategy = require('./login/strategies/' + name);
          const options = { name, cfg, monitor, db };

          strategies[name] = new Strategy(options);
        });

        return strategies;
      },
    },

    scanner: {
      requires: ['cfg', 'strategies', 'monitor'],
      setup: async ({ cfg, strategies, monitor }, ownName) => {
        const auth = new Auth({
          credentials: cfg.taskcluster.credentials,
          rootUrl: cfg.taskcluster.rootUrl,
        });
        return monitor.oneShot(ownName, () => scanner(auth, strategies));
      },
    },

    auth: {
      requires: ['cfg'],
      setup: ({ cfg }) => new taskcluster.Auth(cfg.taskcluster),
    },

    db: {
      requires: ['cfg', 'process', 'monitor'],
      setup: ({ cfg, process, monitor }) => tcdb.setup({
        readDbUrl: cfg.postgres.readDbUrl,
        writeDbUrl: cfg.postgres.writeDbUrl,
        serviceName: 'web_server',
        monitor: monitor.childMonitor('db'),
        statementTimeout: process === 'server' ? 30000 : 0,
        azureCryptoKey: cfg.azure.cryptoKey,
        dbCryptoKeys: cfg.postgres.dbCryptoKeys,
      }),
    },

    'cleanup-expire-auth-codes': {
      requires: ['cfg', 'db', 'monitor'],
      setup: ({ cfg, db, monitor }) => {
        return monitor.oneShot('cleanup-expire-authorization-codes', async () => {
          const delay = cfg.app.authorizationCodeExpirationDelay;
          const now = taskcluster.fromNow(delay);

          debug('Expiring authorization codes');
          const count = (await db.fns.expire_authorization_codes(now))[0].expire_authorization_codes;
          debug('Expired ' + count + ' authorization codes');
        });
      },
    },

    'cleanup-expire-access-tokens': {
      requires: ['cfg', 'db', 'monitor'],
      setup: ({ cfg, db, monitor }) => {
        return monitor.oneShot('cleanup-expire-access-tokens', async () => {
          const delay = cfg.app.authorizationCodeExpirationDelay;
          const now = taskcluster.fromNow(delay);

          debug('Expiring access tokens');
          const count = (await db.fns.expire_access_tokens(now))[0].expire_access_tokens;
          debug('Expired ' + count + ' access tokens');
        });
      },
    },

    'cleanup-session-storage': {
      requires: ['cfg', 'monitor', 'db'],
      setup: ({ cfg, monitor, db }) => {
        return monitor.oneShot('cleanup-expire-session-storage', async () => {
          debug('Expiring session storage entries');
          const count = (await db.fns.expire_sessions())[0].expire_sessions;
          debug('Expired ' + count + ' session storage entries');
        });
      },
    },

    devServer: {
      requires: ['cfg', 'httpServer'],
      setup: async ({ cfg, httpServer }) => {
        // apply some sanity-checks
        assert(cfg.server.port, 'config server.port is required');
        assert(
          cfg.taskcluster.rootUrl,
          'config taskcluster.rootUrl is required',
        );

        await new Promise(resolve => httpServer.listen(cfg.server.port, resolve));

        /* eslint-disable no-console */
        console.log(`\n\nWeb server running on port ${cfg.server.port}.`);
        if (cfg.app.playground) {
          console.log(
            `\nOpen the interactive GraphQL Playground and schema explorer in your browser at:
          http://localhost:${cfg.server.port}/playground\n`,
          );
        }
        if (!cfg.pulse.namespace) {
          console.log(
            `\nNo Pulse namespace defined; no Pulse messages will be received.\n`,
          );
        }
        /* eslint-enable no-console */
      },
    },

    server: {
      requires: ['cfg', 'httpServer'],
      setup: async ({ cfg, httpServer }) => {
        await new Promise(resolve => httpServer.listen(cfg.server.port, resolve));
      },
    },
  },
  {
    // default to 'devServer' since webpack does not pass any command-line args
    // when running in development mode
    profile: process.env.NODE_ENV || 'development',
    process: process.argv[2] || 'devServer',
  },
);

if (!module.parent) {
  load.crashOnError(process.argv[2] || 'devServer');
}

module.exports = load;
