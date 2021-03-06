var cassandra = require('cassandra-driver')
var async = require('async')
var _ = require('lodash')
var fs = require('fs')
var path = require('path')
var debug = require('debug')('cassandra-framework')

var types = {}
var declaratives = {}
var dynamics = {}

function getType (type) {
  if (_.isString(type) && declaratives[type]) { return declaratives[type] }
  return _.find(dynamics, function (dynamic) {
    return dynamic.isTypeApplicable(type)
  })
}

function normalizeProperty (details, property) {
  if (!_.isPlainObject(details)) { details = { type: details } }
  if (property && !details.field) { details.field = _.snakeCase(property) }
  details.Type = getType(details.type)
  if (details.Type) { return details }
}

function normalizeSchema (_schema) {
  var schema = {}
  _.each(_schema, function (_details, property) {
    var details = normalizeProperty(_details, property)
    if (details) { schema[property] = details }
  })
  return schema
}

var utils = {
  getType: getType,
  normalizeProperty: normalizeProperty,
  normalizeSchema: normalizeSchema,
}

var typeFiles = fs.readdirSync(path.join(__dirname, 'types'))
_.each(typeFiles, function (typeFile) {
  var name = path.parse(typeFile).name
  if (name === 'base') { return }
  var type = require('./types/' + name)(utils)
  types[name] = type
  var camelCase = _.camelCase(name)
  var pascalCase = camelCase.substr(0, 1).toUpperCase() + camelCase.substr(1)
  types[pascalCase] = type // alias
  if (type.isTypeApplicable) {
    dynamics[name] = type
  } else {
    declaratives[name] = type
  }
})

var Model = require('./model')

function ORM (options) {
  this.client = new cassandra.Client(options)
  this.types = types
  this.Model = Model(this.client, utils)
  return this
}

/**
 * save models (via cassandra's native batch)
 *
 * does NOT fully support changing a counter's PK
 * - cassandra will silent make the deleted counter unavailable
 * - it works fine when SELECTing afterwards - deleted counter won't show
 * - but if subsequently reuses the deleted counter, it will start off
 *   from last deleted value, instead of from zero - silently
 *
 * @method save
 * @param {...Model|Model[]} models the models to save
 * @param {Function} [cb] callback
 * @return {void}
 */
ORM.prototype.save = function (/* ...models[, cb] */) {
  var _this = this

  var models, cb
  if (_.isArray(arguments[0])) {
    models = arguments[0]
    cb = arguments[1]
  } else {
    models = Array.prototype.slice.call(arguments, 0, arguments.length)
    if (_.isFunction(models[models.length-1])) {
      cb = models[models.length-1]
      models = models.slice(0, models.length-1)
    }
  }

  async.waterfall([
    function (cb) {
      async.each(models, function (model, cb) { model.validate(cb) }, cb)
    },

    function (cb) {
      var queries = []
      var counterQueries = []

      _.each(models, function (model) {
        if (model.isCounter()) {
          counterQueries.push(model.getSaveQueries())
        } else {
          queries.push(model.getSaveQueries())
        }
      })

      queries = _.flatten(queries)
      counterQueries = _.flatten(counterQueries)

      debug(queries.concat(counterQueries))

      async.parallel([
        function (cb) {
          if (!queries.length) { return cb(null) }
          _this.client.batch(queries, cb)
        },

        function (cb) {
          if (!counterQueries.length) { return cb(null) }
          _this.client.batch(counterQueries, { counter: true }, cb)
        },
      ], cb)
    }
  ], cb)
}

module.exports = ORM
