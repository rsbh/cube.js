/* eslint-disable global-require,no-return-assign */
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import LRUCache from 'lru-cache';
import isDocker from 'is-docker';

import { ApiGateway, UserBackgroundContext } from '@cubejs-backend/api-gateway';
import {
  CancelableInterval,
  createCancelableInterval, displayCLIWarning, formatDuration,
  getAnonymousId,
  getEnv,
  internalExceptions, isDockerImage, requireFromPackage,
  track,
} from '@cubejs-backend/shared';

import type { Application as ExpressApplication } from 'express';
import type { BaseDriver } from '@cubejs-backend/query-orchestrator';
import type { Constructor, Required } from '@cubejs-backend/shared';
import type { CubeStoreDevDriver, CubeStoreHandler, isCubeStoreSupported } from '@cubejs-backend/cubestore-driver';
import type {
  ContextToAppIdFn,
  CreateOptions,
  DatabaseType,
  DbTypeFn,
  ExternalDbTypeFn,
  OrchestratorOptionsFn,
  PreAggregationsSchemaFn,
  RequestContext,
  DriverContext,
  LoggerFn,
} from './types';

import { FileRepository, SchemaFileRepository } from './FileRepository';
import { RefreshScheduler, ScheduledRefreshOptions } from './RefreshScheduler';
import { OrchestratorApi } from './OrchestratorApi';
import { CompilerApi } from './CompilerApi';
import { DevServer } from './DevServer';
import agentCollect from './agentCollect';
import { OrchestratorStorage } from './OrchestratorStorage';
import { prodLogger, devLogger } from './logger';

import DriverDependencies from './DriverDependencies';
import optionsValidate from './optionsValidate';

const { version } = require('../../../package.json');

const checkEnvForPlaceholders = () => {
  const placeholderSubstr = '<YOUR_DB_';
  const credentials = [
    'CUBEJS_DB_HOST',
    'CUBEJS_DB_NAME',
    'CUBEJS_DB_USER',
    'CUBEJS_DB_PASS'
  ];
  if (
    credentials.find((credential) => (
      process.env[credential] && process.env[credential].indexOf(placeholderSubstr) === 0
    ))
  ) {
    throw new Error('Your .env file contains placeholders in DB credentials. Please replace them with your DB credentials.');
  }
};

export type ServerCoreInitializedOptions = Required<
  CreateOptions,
  // This fields are required, because we add default values in constructor
  'dbType' | 'apiSecret' | 'devServer' | 'telemetry' | 'logger' | 'dashboardAppPath' | 'dashboardAppPort' |
  'driverFactory' | 'dialectFactory' |
  'externalDriverFactory' | 'externalDialectFactory' |
  'scheduledRefreshContexts'
>;

function wrapToFnIfNeeded<T, R>(possibleFn: T|((a: R) => T)): (a: R) => T {
  if (typeof possibleFn === 'function') {
    return <any>possibleFn;
  }

  return () => possibleFn;
}

export class CubejsServerCore {
  public readonly repository: FileRepository;

  protected devServer: DevServer|undefined;

  protected readonly orchestratorStorage: OrchestratorStorage = new OrchestratorStorage();

  protected readonly repositoryFactory: ((context: RequestContext) => SchemaFileRepository) | (() => FileRepository);

  protected contextToDbType: DbTypeFn;

  protected contextToExternalDbType: ExternalDbTypeFn;

  protected compilerCache: LRUCache<string, CompilerApi>;

  protected contextToOrchestratorId: any;

  protected readonly preAggregationsSchema: PreAggregationsSchemaFn;

  protected readonly orchestratorOptions: OrchestratorOptionsFn;

  public logger: (type: string, params: Record<string, any>) => void;

  protected preAgentLogger: any;

  protected readonly options: ServerCoreInitializedOptions;

  protected readonly contextToAppId: ContextToAppIdFn = () => process.env.CUBEJS_APP || 'STANDALONE';

  protected readonly standalone: boolean = true;

  protected maxCompilerCacheKeep: NodeJS.Timeout|null = null;

  protected scheduledRefreshTimerInterval: CancelableInterval|null = null;

  protected driver: BaseDriver|null = null;

  protected apiGatewayInstance: ApiGateway|null = null;

  public readonly event: (name: string, props?: object) => Promise<void>;

  public projectFingerprint: string|null = null;

  public anonymousId: string|null = null;

  public coreServerVersion: string|null = null;

  public constructor(opts: CreateOptions = {}) {
    this.options = this.handleConfiguration(opts);

    this.logger = this.options.logger;
    this.repository = new FileRepository(this.options.schemaPath);
    this.repositoryFactory = this.options.repositoryFactory || (() => this.repository);

    this.contextToDbType = wrapToFnIfNeeded(this.options.dbType);
    this.contextToExternalDbType = wrapToFnIfNeeded(this.options.externalDbType);
    this.preAggregationsSchema = wrapToFnIfNeeded(this.options.preAggregationsSchema);
    this.orchestratorOptions = wrapToFnIfNeeded(this.options.orchestratorOptions);

    this.compilerCache = new LRUCache<string, CompilerApi>({
      max: this.options.compilerCacheSize || 250,
      maxAge: this.options.maxCompilerCacheKeepAlive,
      updateAgeOnGet: this.options.updateCompilerCacheKeepAlive
    });

    if (this.options.contextToAppId) {
      this.contextToAppId = this.options.contextToAppId;
      this.standalone = false;
    }

    if (this.options.contextToDataSourceId) {
      throw new Error('contextToDataSourceId has been deprecated and removed. Use contextToOrchestratorId instead.');
    }

    this.contextToOrchestratorId = this.options.contextToOrchestratorId || this.contextToAppId;

    // proactively free up old cache values occasionally
    if (this.options.maxCompilerCacheKeepAlive) {
      this.maxCompilerCacheKeep = setInterval(
        () => this.compilerCache.prune(),
        this.options.maxCompilerCacheKeepAlive
      );
    }

    this.startScheduledRefreshTimer();

    this.event = async (name, props) => {
      if (!this.options.telemetry) {
        return;
      }

      if (!this.projectFingerprint) {
        try {
          this.projectFingerprint = crypto.createHash('md5')
            .update(JSON.stringify(fs.readJsonSync('package.json')))
            .digest('hex');
        } catch (e) {
          internalExceptions(e);
        }
      }

      if (!this.anonymousId) {
        this.anonymousId = getAnonymousId();
      }

      if (!this.coreServerVersion) {
        this.coreServerVersion = version;
      }

      const internalExceptionsEnv = getEnv('internalExceptions');

      try {
        await track({
          event: name,
          projectFingerprint: this.projectFingerprint,
          coreServerVersion: this.coreServerVersion,
          dockerVersion: getEnv('dockerImageVersion'),
          isDocker: isDocker(),
          internalExceptions: internalExceptionsEnv !== 'false' ? internalExceptionsEnv : undefined,
          ...props
        });
      } catch (e) {
        internalExceptions(e);
      }
    };

    this.initAgent();

    if (this.options.devServer && !this.configFileExists()) {
      this.event('first_server_start');
    }

    if (this.options.devServer) {
      this.devServer = new DevServer(this, {
        dockerVersion: getEnv('dockerImageVersion'),
        externalDbTypeFn: this.contextToExternalDbType
      });
      const oldLogger = this.logger;
      this.logger = ((msg, params) => {
        if (
          msg === 'Load Request' ||
          msg === 'Load Request Success' ||
          msg === 'Orchestrator error' ||
          msg === 'Internal Server Error' ||
          msg === 'User Error' ||
          msg === 'Compiling schema' ||
          msg === 'Recompiling schema' ||
          msg === 'Slow Query Warning'
        ) {
          this.event(msg, { error: params.error });
        }
        oldLogger(msg, params);
      });

      if (!process.env.CI) {
        process.on('uncaughtException', this.onUncaughtException);
      }
    } else {
      const oldLogger = this.logger;
      let loadRequestCount = 0;

      this.logger = ((msg, params) => {
        if (msg === 'Load Request Success') {
          loadRequestCount++;
        }
        oldLogger(msg, params);
      });

      setInterval(() => {
        this.event('Load Request Success Aggregated', { loadRequestSuccessCount: loadRequestCount });
        loadRequestCount = 0;
      }, 60000);

      this.event('Server Start');
    }
  }

  protected isReadyForQueryProcessing(): boolean {
    const dbType = this.options.dbType || <DatabaseType | undefined>process.env.CUBEJS_DB_TYPE;

    return typeof dbType !== 'undefined';
  }

  public startScheduledRefreshTimer(): [boolean, string|null] {
    if (!this.isReadyForQueryProcessing()) {
      return [false, 'Instance is not ready for query processing, refresh scheduler is disabled'];
    }

    if (this.scheduledRefreshTimerInterval) {
      return [true, null];
    }

    const scheduledRefreshTimer = this.detectScheduledRefreshTimer(
      this.options.scheduledRefreshTimer,
    );
    if (scheduledRefreshTimer) {
      this.scheduledRefreshTimerInterval = createCancelableInterval(
        () => this.handleScheduledRefreshInterval({}),
        {
          interval: scheduledRefreshTimer,
          onDuplicatedExecution: (intervalId) => this.logger('Refresh Scheduler Interval Error', {
            error: `Previous interval #${intervalId} was not finished with ${scheduledRefreshTimer} interval`
          }),
          onDuplicatedStateResolved: (intervalId, elapsed) => this.logger('Refresh Scheduler Long Execution', {
            warning: `Interval #${intervalId} finished after ${formatDuration(elapsed)}`
          })
        }
      );

      return [true, null];
    }

    return [false, 'Instance configured without scheduler refresh timer, refresh scheduler is disabled'];
  }

  private requireCubeStoreDriver = () => requireFromPackage<{
    isCubeStoreSupported: typeof isCubeStoreSupported,
    CubeStoreHandler: typeof CubeStoreHandler,
    CubeStoreDevDriver: typeof CubeStoreDevDriver,
  }>('@cubejs-backend/cubestore-driver', {
    relative: isDockerImage(),
  });

  protected handleConfiguration(opts: CreateOptions): ServerCoreInitializedOptions {
    optionsValidate(opts);

    const skipOnEnv = [
      // Default EXT_DB variables
      'CUBEJS_EXT_DB_URL',
      'CUBEJS_EXT_DB_HOST',
      'CUBEJS_EXT_DB_NAME',
      'CUBEJS_EXT_DB_PORT',
      'CUBEJS_EXT_DB_USER',
      'CUBEJS_EXT_DB_PASS',
      // Cube Store variables
      'CUBEJS_CUBESTORE_HOST',
      'CUBEJS_CUBESTORE_PORT',
      'CUBEJS_CUBESTORE_USER',
      'CUBEJS_CUBESTORE_PASS',
    ];

    const definedExtDBVariables = skipOnEnv.filter((field) => process.env[field] !== undefined);

    const externalDbType = opts.externalDbType ||
      <DatabaseType|undefined>process.env.CUBEJS_EXT_DB_TYPE ||
      (getEnv('devMode') || definedExtDBVariables.length > 0) && 'cubestore' ||
      undefined;

    const devServer = process.env.NODE_ENV !== 'production' || getEnv('devMode');
    const logger: LoggerFn = opts.logger || (
      process.env.NODE_ENV !== 'production'
        ? devLogger(process.env.CUBEJS_LOG_LEVEL)
        : prodLogger(process.env.CUBEJS_LOG_LEVEL)
    );

    let externalDriverFactory = externalDbType && (
      () => new (CubejsServerCore.lookupDriverClass(externalDbType))({
        url: process.env.CUBEJS_EXT_DB_URL,
        host: process.env.CUBEJS_EXT_DB_HOST,
        database: process.env.CUBEJS_EXT_DB_NAME,
        port: process.env.CUBEJS_EXT_DB_PORT,
        user: process.env.CUBEJS_EXT_DB_USER,
        password: process.env.CUBEJS_EXT_DB_PASS,
      })
    );

    let externalDialectFactory = () => typeof externalDbType === 'string' &&
      CubejsServerCore.lookupDriverClass(externalDbType).dialectClass &&
      CubejsServerCore.lookupDriverClass(externalDbType).dialectClass();

    if (!devServer && getEnv('externalDefault') && !externalDbType) {
      displayCLIWarning(
        'Cube Store is not found. Please follow this documentation to configure Cube Store https://cube.dev/docs/caching/running-in-production'
      );
    }

    if (externalDbType === 'cubestore' && devServer && !opts.serverless) {
      if (!definedExtDBVariables.length) {
        const cubeStorePackage = this.requireCubeStoreDriver();
        if (cubeStorePackage.isCubeStoreSupported()) {
          const cubeStoreHandler = new cubeStorePackage.CubeStoreHandler({
            stdout: (data) => {
              console.log(data.toString().trim());
            },
            stderr: (data) => {
              console.log(data.toString().trim());
            },
            onRestart: (code) => logger('Cube Store Restarting', {
              warning: `Instance exit with ${code}, restarting`,
            }),
          });

          console.log(`🔥 Cube Store (${version}) is assigned to 3030 port.`);

          // Start Cube Store on startup in official docker images
          if (isDockerImage()) {
            cubeStoreHandler.acquire().catch(
              (e) => this.logger('Cube Store Start Error', {
                error: e.message,
              })
            );
          }

          // Lazy loading for Cube Store
          externalDriverFactory = () => new cubeStorePackage.CubeStoreDevDriver(cubeStoreHandler);
          externalDialectFactory = () => cubeStorePackage.CubeStoreDevDriver.dialectClass();
        } else {
          logger('Cube Store is not supported on your system', {
            warning: (
              `You are using ${process.platform} platform with ${process.arch} architecture, ` +
              'which is not supported by Cube Store.'
            ),
          });
        }
      }
    }

    const options: ServerCoreInitializedOptions = {
      dbType: <DatabaseType | undefined>process.env.CUBEJS_DB_TYPE,
      externalDbType,
      devServer,
      driverFactory: (ctx) => {
        const dbType = this.contextToDbType(ctx);

        if (dbType) {
          return CubejsServerCore.createDriver(dbType);
        }

        return null;
      },
      dialectFactory: (ctx) => CubejsServerCore.lookupDriverClass(ctx.dbType).dialectClass &&
        CubejsServerCore.lookupDriverClass(ctx.dbType).dialectClass(),
      externalDriverFactory,
      externalDialectFactory,
      apiSecret: process.env.CUBEJS_API_SECRET,
      telemetry: getEnv('telemetry'),
      scheduledRefreshTimeZones: process.env.CUBEJS_SCHEDULED_REFRESH_TIMEZONES &&
        process.env.CUBEJS_SCHEDULED_REFRESH_TIMEZONES.split(',').map(t => t.trim()),
      scheduledRefreshContexts: async () => [null],
      basePath: '/cubejs-api',
      dashboardAppPath: 'dashboard-app',
      dashboardAppPort: 3000,
      scheduledRefreshConcurrency: parseInt(process.env.CUBEJS_SCHEDULED_REFRESH_CONCURRENCY, 10),
      preAggregationsSchema: getEnv('preAggregationsSchema') || (
        devServer ? 'dev_pre_aggregations' : 'prod_pre_aggregations'
      ),
      schemaPath: process.env.CUBEJS_SCHEMA_PATH || 'schema',
      logger,
      scheduledRefreshTimer: getEnv('scheduledRefresh') !== undefined ? getEnv('scheduledRefresh') : getEnv('refreshTimer'),
      sqlCache: true,
      livePreview: getEnv('livePreview'),
      ...opts,
      jwt: {
        key: getEnv('jwtKey'),
        algorithms: getEnv('jwtAlgorithms'),
        issuer: getEnv('jwtIssuer'),
        audience: getEnv('jwtAudience'),
        subject: getEnv('jwtSubject'),
        jwkUrl: getEnv('jwkUrl'),
        claimsNamespace: getEnv('jwtClaimsNamespace'),
        ...opts.jwt,
      }
    };

    if (opts.contextToAppId && !opts.scheduledRefreshContexts) {
      options.logger('Multitenancy Without ScheduledRefreshContexts', {
        warning: (
          'You are using multitenancy without configuring scheduledRefreshContexts, which can lead to issues where the ' +
          'security context will be undefined while Cube.js will do background refreshing: ' +
          'https://cube.dev/docs/config#options-reference-scheduled-refresh-contexts'
        ),
      });
    }

    if (options.devServer && !options.apiSecret) {
      options.apiSecret = crypto.randomBytes(16).toString('hex');

      displayCLIWarning(
        `Option apiSecret is required in dev mode. Cube.js has generated it as ${options.apiSecret}`
      );
    }

    // Create schema directory to protect error on new project with dev mode (docker flow)
    if (options.devServer && !this.configFileExists()) {
      const repositoryPath = path.join(process.cwd(), options.schemaPath);

      if (!fs.existsSync(repositoryPath)) {
        fs.mkdirSync(repositoryPath);
      }
    }

    if (!options.devServer || this.configFileExists()) {
      const fieldsForValidation: (keyof ServerCoreInitializedOptions)[] = [
        'driverFactory',
        'dbType'
      ];

      if (!options.jwt?.jwkUrl) {
        // apiSecret is required only for auth by JWT, for JWK it's not needed
        fieldsForValidation.push('apiSecret');
      }

      const invalidFields = fieldsForValidation.filter((field) => options[field] === undefined);
      if (invalidFields.length) {
        throw new Error(
          `${invalidFields.join(', ')} ${invalidFields.length === 1 ? 'is' : 'are'} required option(s)`
        );
      }
    }

    return options;
  }

  protected reloadEnvVariables() {
    this.options.dbType = this.options.dbType || <DatabaseType | undefined>process.env.CUBEJS_DB_TYPE;
    this.options.externalDbType = this.options.externalDbType || <DatabaseType|undefined>process.env.CUBEJS_EXT_DB_TYPE;

    this.contextToDbType = wrapToFnIfNeeded(this.options.dbType);
    this.contextToExternalDbType = wrapToFnIfNeeded(this.options.externalDbType);
  }

  public configFileExists(): boolean {
    return (Boolean(process.env.CUBEJS_DB_TYPE) || fs.existsSync('./cube.js'));
  }

  protected detectScheduledRefreshTimer(scheduledRefreshTimer: number | boolean): number | false {
    if (scheduledRefreshTimer && (typeof scheduledRefreshTimer === 'number')) {
      return parseInt(<any>scheduledRefreshTimer, 10) * 1000;
    }

    if (scheduledRefreshTimer) {
      return 30000;
    }

    return false;
  }

  protected initAgent() {
    if (process.env.CUBEJS_AGENT_ENDPOINT_URL) {
      const oldLogger = this.logger;
      this.preAgentLogger = oldLogger;
      this.logger = (msg, params) => {
        oldLogger(msg, params);
        agentCollect(
          {
            msg,
            ...params
          },
          process.env.CUBEJS_AGENT_ENDPOINT_URL,
          oldLogger
        );
      };
    }
  }

  protected async flushAgent() {
    if (process.env.CUBEJS_AGENT_ENDPOINT_URL) {
      await agentCollect(
        { msg: 'Flush Agent' },
        process.env.CUBEJS_AGENT_ENDPOINT_URL,
        this.preAgentLogger
      );
    }
  }

  public static create(options?: CreateOptions) {
    return new CubejsServerCore(options);
  }

  public async initApp(app: ExpressApplication) {
    checkEnvForPlaceholders();

    const apiGateway = this.apiGateway();
    apiGateway.initApp(app);

    if (this.options.devServer) {
      this.devServer.initDevEnv(app, this.options);
    } else {
      app.get('/', (req, res) => {
        res.status(200)
          .send('<html><body>Cube.js server is running in production mode. <a href="https://cube.dev/docs/deployment#production-mode">Learn more about production mode</a>.</body></html>');
      });
    }
  }

  public initSubscriptionServer(sendMessage) {
    checkEnvForPlaceholders();

    const apiGateway = this.apiGateway();
    return apiGateway.initSubscriptionServer(sendMessage);
  }

  protected apiGateway(): ApiGateway {
    if (this.apiGatewayInstance) {
      return this.apiGatewayInstance;
    }

    return this.apiGatewayInstance = new ApiGateway(
      this.options.apiSecret,
      this.getCompilerApi.bind(this),
      this.getOrchestratorApi.bind(this),
      this.logger,
      {
        standalone: this.standalone,
        dataSourceStorage: this.orchestratorStorage,
        basePath: this.options.basePath,
        checkAuthMiddleware: this.options.checkAuthMiddleware,
        checkAuth: this.options.checkAuth,
        queryTransformer: this.options.queryTransformer,
        extendContext: this.options.extendContext,
        playgroundAuthSecret: getEnv('playgroundAuthSecret'),
        jwt: this.options.jwt,
        refreshScheduler: () => new RefreshScheduler(this),
        scheduledRefreshContexts: this.options.scheduledRefreshContexts,
        scheduledRefreshTimeZones: this.options.scheduledRefreshTimeZones
      }
    );
  }

  public getCompilerApi(context: RequestContext) {
    const appId = this.contextToAppId(context);
    let compilerApi = this.compilerCache.get(appId);
    const currentSchemaVersion = this.options.schemaVersion && (() => this.options.schemaVersion(context));

    if (!compilerApi) {
      compilerApi = this.createCompilerApi(
        this.repositoryFactory(context), {
          dbType: (dataSourceContext) => this.contextToDbType({ ...context, ...dataSourceContext }),
          externalDbType: this.contextToExternalDbType(context),
          dialectClass: (dialectContext) => this.options.dialectFactory &&
            this.options.dialectFactory({ ...context, ...dialectContext }),
          externalDialectClass: this.options.externalDialectFactory && this.options.externalDialectFactory(context),
          schemaVersion: currentSchemaVersion,
          preAggregationsSchema: this.preAggregationsSchema(context),
          context,
          allowJsDuplicatePropsInSchema: this.options.allowJsDuplicatePropsInSchema
        }
      );

      this.compilerCache.set(appId, compilerApi);
    }

    compilerApi.schemaVersion = currentSchemaVersion;
    return compilerApi;
  }

  public async resetInstanceState() {
    await this.orchestratorStorage.releaseConnections();

    this.orchestratorStorage.clear();
    this.compilerCache.reset();

    this.reloadEnvVariables();

    this.startScheduledRefreshTimer();
  }

  public getOrchestratorApi(context: RequestContext): OrchestratorApi {
    const orchestratorId = this.contextToOrchestratorId(context);

    if (this.orchestratorStorage.has(orchestratorId)) {
      return this.orchestratorStorage.get(orchestratorId);
    }

    const driverPromise: Record<string, Promise<BaseDriver>> = {};
    let externalPreAggregationsDriverPromise: Promise<BaseDriver>|null = null;

    const externalDbType = this.contextToExternalDbType(context);

    const orchestratorApi = this.createOrchestratorApi({
      getDriver: async (dataSource = 'default') => {
        if (driverPromise[dataSource]) {
          return driverPromise[dataSource];
        }

        // eslint-disable-next-line no-return-assign
        return driverPromise[dataSource] = (async () => {
          let driver: BaseDriver | null = null;

          try {
            driver = await this.options.driverFactory({ ...context, dataSource });
            if (driver.setLogger) {
              driver.setLogger(this.logger);
            }

            await driver.testConnection();

            return driver;
          } catch (e) {
            driverPromise[dataSource] = null;

            if (driver) {
              await driver.release();
            }

            throw e;
          }
        })();
      },
      getExternalDriverFactory: this.options.externalDriverFactory && (async () => {
        if (externalPreAggregationsDriverPromise) {
          return externalPreAggregationsDriverPromise;
        }

        // eslint-disable-next-line no-return-assign
        return externalPreAggregationsDriverPromise = (async () => {
          let driver: BaseDriver|null = null;

          try {
            driver = await this.options.externalDriverFactory(context);
            if (driver.setLogger) {
              driver.setLogger(this.logger);
            }

            await driver.testConnection();

            return driver;
          } catch (e) {
            externalPreAggregationsDriverPromise = null;

            if (driver) {
              await driver.release();
            }

            throw e;
          }
        })();
      }),
      redisPrefix: orchestratorId,
      orchestratorOptions: {
        skipExternalCacheAndQueue: externalDbType === 'cubestore',
        ...this.options.orchestratorOptions,
        // OrchestratorOptionsFn should have an ability to override static configuration form cube.js file
        ...this.orchestratorOptions(context),
      }
    });

    this.orchestratorStorage.set(orchestratorId, orchestratorApi);

    return orchestratorApi;
  }

  protected createCompilerApi(repository, options) {
    options = options || {};
    return new CompilerApi(repository, options.dbType || this.options.dbType, {
      schemaVersion: options.schemaVersion || this.options.schemaVersion,
      devServer: this.options.devServer,
      logger: this.logger,
      externalDbType: options.externalDbType,
      preAggregationsSchema: options.preAggregationsSchema,
      allowUngroupedWithoutPrimaryKey: this.options.allowUngroupedWithoutPrimaryKey,
      compileContext: options.context,
      dialectClass: options.dialectClass,
      externalDialectClass: options.externalDialectClass,
      allowJsDuplicatePropsInSchema: options.allowJsDuplicatePropsInSchema,
      sqlCache: this.options.sqlCache,
    });
  }

  protected createOrchestratorApi(options: any = {}): OrchestratorApi {
    return new OrchestratorApi(
      options.getDriver || this.getDriver.bind(this),
      this.logger,
      {
        redisPrefix: options.redisPrefix || process.env.CUBEJS_APP,
        externalDriverFactory: options.getExternalDriverFactory,
        ...options.orchestratorOptions,
        contextToDbType: this.contextToDbType.bind(this)
      }
    );
  }

  /**
   * @internal Please dont use this method directly, use refreshTimer
   */
  public handleScheduledRefreshInterval = async (options) => {
    const contexts = await this.options.scheduledRefreshContexts();
    if (contexts.length < 1) {
      this.logger('Refresh Scheduler Error', {
        error: 'At least one context should be returned by scheduledRefreshContexts'
      });
    }

    return Promise.all(contexts.map(async context => {
      const queryingOptions: any = { ...options, concurrency: this.options.scheduledRefreshConcurrency };

      if (this.options.scheduledRefreshTimeZones) {
        queryingOptions.timezones = this.options.scheduledRefreshTimeZones;
      }

      return this.runScheduledRefresh(context, queryingOptions);
    }));
  };

  protected getRefreshScheduler() {
    return new RefreshScheduler(this);
  }

  /**
   * @internal Please dont use this method directly, use refreshTimer
   */
  public async runScheduledRefresh(context: UserBackgroundContext|null, queryingOptions?: ScheduledRefreshOptions) {
    return this.getRefreshScheduler().runScheduledRefresh(
      this.migrateBackgroundContext(context),
      queryingOptions
    );
  }

  protected warningBackgroundContextShow: boolean = false;

  protected migrateBackgroundContext(ctx: UserBackgroundContext | null): RequestContext|null {
    let result: any = null;

    // We renamed authInfo to securityContext, but users can continue to use both ways
    if (ctx) {
      if (ctx.securityContext && !ctx.authInfo) {
        result = {
          ...ctx,
          authInfo: ctx.securityContext,
        };
      } else if (ctx.authInfo) {
        result = {
          ...ctx,
          securityContext: ctx.authInfo,
        };

        if (this.warningBackgroundContextShow) {
          this.logger('auth_info_deprecation', {
            warning: (
              'authInfo was renamed to securityContext, please migrate: ' +
              'https://github.com/cube-js/cube.js/blob/master/DEPRECATION.md#checkauthmiddleware'
            )
          });

          this.warningBackgroundContextShow = false;
        }
      }
    }

    return result;
  }

  public async getDriver(ctx: DriverContext): Promise<BaseDriver> {
    if (!this.driver) {
      const driver = await this.options.driverFactory(ctx);
      await driver.testConnection(); // TODO mutex
      this.driver = driver;
    }

    return this.driver;
  }

  public static createDriver(dbType: DatabaseType): BaseDriver {
    checkEnvForPlaceholders();

    return new (CubejsServerCore.lookupDriverClass(dbType))();
  }

  protected static lookupDriverClass(dbType): Constructor<BaseDriver> & { dialectClass?: () => any; } {
    // eslint-disable-next-line global-require,import/no-dynamic-require
    const module = require(CubejsServerCore.driverDependencies(dbType || process.env.CUBEJS_DB_TYPE));
    if (module.default) {
      return module.default;
    }

    return module;
  }

  public static driverDependencies(dbType: DatabaseType) {
    if (DriverDependencies[dbType]) {
      return DriverDependencies[dbType];
    } else if (fs.existsSync(path.join('node_modules', `${dbType}-cubejs-driver`))) {
      return `${dbType}-cubejs-driver`;
    }

    throw new Error(`Unsupported db type: ${dbType}`);
  }

  public async testConnections() {
    return this.orchestratorStorage.testConnections();
  }

  public async releaseConnections() {
    await this.orchestratorStorage.releaseConnections();

    if (this.maxCompilerCacheKeep) {
      clearInterval(this.maxCompilerCacheKeep);
    }

    if (this.scheduledRefreshTimerInterval) {
      await this.scheduledRefreshTimerInterval.cancel();
    }
  }

  public async beforeShutdown() {
    if (this.maxCompilerCacheKeep) {
      clearInterval(this.maxCompilerCacheKeep);
    }

    if (this.scheduledRefreshTimerInterval) {
      await this.scheduledRefreshTimerInterval.cancel(true);
    }
  }

  protected causeErrorPromise: Promise<any>|null = null;

  protected onUncaughtException = async (e: Error) => {
    console.error(e.stack || e);

    if (e.message && e.message.indexOf('Redis connection to') !== -1) {
      console.log('🛑 Cube.js Server requires locally running Redis instance to connect to');
      if (process.platform.indexOf('win') === 0) {
        console.log('💾 To install Redis on Windows please use https://github.com/MicrosoftArchive/redis/releases');
      } else if (process.platform.indexOf('darwin') === 0) {
        console.log('💾 To install Redis on Mac please use https://redis.io/topics/quickstart or `$ brew install redis`');
      } else {
        console.log('💾 To install Redis please use https://redis.io/topics/quickstart');
      }
    }

    if (!this.causeErrorPromise) {
      this.causeErrorPromise = this.event('Dev Server Fatal Error', {
        error: (e.stack || e.message || e).toString()
      });
    }

    await this.causeErrorPromise;

    process.exit(1);
  };

  public async shutdown() {
    if (this.devServer) {
      if (!process.env.CI) {
        process.removeListener('uncaughtException', this.onUncaughtException);
      }
    }

    if (this.apiGatewayInstance) {
      this.apiGatewayInstance.release();
    }

    return this.orchestratorStorage.releaseConnections();
  }

  public static version() {
    return version;
  }
}
