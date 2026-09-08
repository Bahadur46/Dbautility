'use strict';

/**
 * Model definitions that are not bound to one connection.
 *
 * With cluster-wise sign-in there is no single database any more: the same
 * schema has to be compiled once per cluster connection. Model files therefore
 * register their schema here and export a proxy; every property access on that
 * proxy resolves to the model of the connection the current request is running
 * on, so callers keep writing `User.findOne(...)` and never think about it.
 */

const definitions = new Map(); // name -> { schema, collectionName, central }

/** Compile every registered schema onto a connection. Safe to call twice. */
function registerAll(connection) {
  for (const [name, { schema, collectionName }] of definitions) {
    if (!connection.models[name]) connection.model(name, schema, collectionName);
  }
  return connection;
}

/**
 * Register a schema and return the connection-agnostic model proxy.
 *
 * `extras` carries anything a model file hangs off its export alongside the
 * model itself (constant lists, for example), which cannot live on the model
 * because the model does not exist yet.
 *
 * `options.central` marks a model that does NOT belong to a cluster. The audit
 * trail is deployment-wide: it is always resolved against the connection
 * MONGODB_URI names, whichever cluster the request is working on, so there is
 * one trail however many clusters there are. Everything else — the accounts,
 * the login history, the manual index definitions — lives in the cluster's own
 * database and is reached through the cluster's own connection.
 */
function defineModel(name, schema, collectionName, options = {}) {
  const central = Boolean(options.central);
  definitions.set(name, { schema, collectionName, central });

  const extras = {};

  const resolve = () => {
    // Required lazily: the connection manager registers the model files.
    const { activeConnection, centralConnection } = require('../config/clusterConnections');
    const connection = central ? centralConnection() : activeConnection();
    return connection.models[name] || connection.model(name, schema, collectionName);
  };

  // A function target keeps `new Model({...})` working through the proxy.
  return new Proxy(function ModelProxy() {}, {
    get(target, prop, receiver) {
      if (prop === 'schema') return schema;
      const model = resolve();
      const value = Reflect.get(model, prop, receiver);
      if (value === undefined && prop in extras) return extras[prop];
      return typeof value === 'function' ? value.bind(model) : value;
    },
    set(target, prop, value) {
      extras[prop] = value;
      return true;
    },
    has(target, prop) {
      return prop in resolve() || prop in extras;
    },
    construct(target, args) {
      const Model = resolve();
      return new Model(...args);
    },
    apply(target, thisArg, args) {
      const Model = resolve();
      return new Model(...args);
    },
  });
}

module.exports = { defineModel, registerAll, definitions };
