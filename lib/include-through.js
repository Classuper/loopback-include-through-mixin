'use strict';

const _ = require('lodash');

module.exports = function(Model, options) {
  var modelHasManyThroughRelations, modelRelations;

  Model.on('attached', function() {
    modelRelations = Model.settings.relations || Model.relations;

    if (modelRelations) {
      modelHasManyThroughRelations = [];
      Object.keys(modelRelations).forEach(function(targetModel) {
        var type =
          (modelRelations[targetModel].modelThrough || modelRelations[targetModel].through) ?
            'hasManyThrough' : modelRelations[targetModel].type;

        if (type === 'hasManyThrough') {
          Model.afterRemote('prototype.__get__' + targetModel, controller);
          Model.afterRemote('prototype.__findById__' + targetModel, controller);
          Model.afterRemote('prototype.__create__' + targetModel, controller);
          modelHasManyThroughRelations.push(targetModel);
        }
      });

      if (modelHasManyThroughRelations.length) {
        Model.afterRemote('findById', controller);
        Model.afterRemote('find', controller);
      }
    }
  });

  function controller(ctx, unused, next) {
    if (ctx.methodString.indexOf('prototype.__get__') !== -1) {
      // the original version
      var relationName = ctx.methodString.match(/__([a-zA-Z]+)$/)[1];
      var partialResult = JSON.parse(JSON.stringify(ctx.result));
      injectIncludes(ctx, partialResult, relationName).then(function(partialResult) {
        ctx.result = partialResult;
        next();
      });
    } else if (ctx.methodString.indexOf('prototype.__findById__') !== -1) {
      // the original version
      var relationName = ctx.methodString.match(/__([a-zA-Z]+)$/)[1];
      var partialResult = JSON.parse(JSON.stringify(ctx.result));
      injectIncludes(ctx, partialResult, relationName).then(function(partialResult) {
        ctx.result = partialResult;
        next();
      });
    } else {
      // extension
      var newResult = JSON.parse(JSON.stringify(ctx.result));
      var filter = ctx.args.filter;
      if (filter) {
        var include = filter.include; // string, [string], object

        // only support one level of includes
        var relationNames = [];
        if (_.isString(include)) {
          relationNames.push(include);
        } else if (_.isArray(include)) {
          for (let elm of include) {
            if (typeof elm === 'string') {
              relationNames.push(elm);
            } else if (typeof elm === 'object') {
              for (let prop in elm) {
                relationNames.push(prop);
              }
            }
          }
        } else if (_.isObject(include)) {
          for (let prop in include) {
            relationNames.push(prop);
          }
        }
        relationNames = _.uniq(relationNames);

        let dataProperty
        let dataResult

        if (filter.includeThrough) {
          dataProperty = filter.includeThrough.dataProperty
        }

        if (dataProperty) {
          dataResult = newResult[dataProperty]
          delete filter.includeThrough.dataProperty
        } else {
          dataResult = newResult
        }

        let promises = [];
        for (let relationName of relationNames) {
          if (modelHasManyThroughRelations.includes(relationName)) {
            let partialResult;

            if (_.isArray(dataResult)) {
              partialResult = [];
              for (let i = 0; i < dataResult.length; i++) {
                partialResult.push(dataResult[i][relationName]);
              }
            } else {
              partialResult = dataResult[relationName];
            }

            let promise = injectIncludes(ctx, partialResult, relationName)
              .then(function(partialResult) {
                return new Promise(function(res, rej) {
                  dataResult[relationName] = partialResult;
                  res();
                });
              });
            promises.push(promise);
          }
        }
        if (promises.length) {
          Promise.all(promises).then(function() {
            ctx.result = newResult;
            next();
          });
        } else {
          next();
        }
      } else {
        next();
      }
    }
  }

  function injectIncludes(ctx, partialResult, relationName) {
    return new Promise(function(res, rej) {
      var relationSetting, isRelationRegistered;
      var includeThrough = ctx.args.filter ? ctx.args.filter.includeThrough : false

      if (options.relations) {
        relationSetting = _.find(options.relations, {name: relationName});
        if (relationSetting) {
          isRelationRegistered = true;
        } else if (options.relations.indexOf(relationName) !== -1) {
          isRelationRegistered = true;
          relationSetting = {};
          relationSetting.name = relationName;
        } else {
          isRelationRegistered = false;
        }
      }

      if (!isRelationRegistered && !includeThrough) {
        return res(partialResult);
      }

      if (includeThrough && includeThrough.only) {
        var relationNamesOnly = []
        if (_.isString(includeThrough.only)) {
          relationNamesOnly.push(includeThrough.only);
        } else if (_.isArray(includeThrough.only)) {
           for (let elm of includeThrough.only) {
             relationNamesOnly.push(elm);
           }
        }

        if (relationNamesOnly.indexOf(relationName) === -1) {
          return res(partialResult);
        }
      }

      var relationKey = Model.relations[relationSetting.name].keyTo;
      var throughKey = Model.relations[relationSetting.name].keyThrough;
      var relationModel = Model.relations[relationSetting.name].modelTo;
      var throughModel = Model.relations[relationSetting.name].modelThrough;

      if (!relationModel) {
        return res(partialResult);
      }
      var idName = relationModel.definition.idName() || 'id';

      var query = {where: {}};
      if (ctx.instance) {
        query.where[relationKey] = ctx.instance.id;
      } else {
        query.where[relationKey] = ctx.args.id;
      }

      var dataProperty;
      var dataResult;

      if (ctx.args.filter && ctx.args.filter.includeThrough) {
        dataProperty = ctx.args.filter.includeThrough.dataProperty
      }

      if (dataProperty) {
        dataResult = partialResult[dataProperty]
      } else {
        dataResult = partialResult
      }

      if (Array.isArray(dataResult)) {
        query.where[throughKey] = {
          inq: dataResult.map(function(item) {
            if (_.isArray(item)) {
              return item.map(function(it) {
                return it[idName];
              });
            } else {
              return item[idName];
            }
          }),
        };
      } else {
        query.where[throughKey] = {inq: [dataResult[idName]]};
      }

      if (
        ctx.args.filter &&
        ctx.args.filter.includeThrough &&
        ctx.args.filter.includeThrough.fields
      ) {
        query.fields = [throughKey, ctx.args.filter.includeThrough.fields];
      } else if (options.fields && options.fields[relationSetting.name]) {
        query.fields = [throughKey, options.fields[relationSetting.name]];
      }

      throughModel.find(query, function(err, results) {
        if (err) return res(partialResult);
        else {
          var throughPropertyName = relationSetting.asProperty || throughModel.definition.name;
          var resultsHash = {};
          results.forEach(function(result) {
            resultsHash[result[throughKey].toString()] = result;
          });

          if (Array.isArray(dataResult)) {
            for (var i = 0; i < dataResult.length; i++) {
              if (_.isArray(dataResult[i])) {
                for (let j = 0; j < dataResult[i].length; j++) {
                  if (resultsHash[dataResult[i][j][idName].toString()]) {
                    dataResult[i][j][throughPropertyName] =
                      resultsHash[dataResult[i][j][idName].toString()];
                  }
                }
              } else {
                if (resultsHash[dataResult[i][idName].toString()]) {
                  dataResult[i][throughPropertyName] =
                    resultsHash[dataResult[i][idName].toString()];
                }
              }
            }
          } else {
            dataResult[throughPropertyName] =
              resultsHash[dataResult[idName].toString()];
          }

          if (dataProperty) {
            partialResult[dataProperty] = dataResult
          }

          return res(partialResult);
        }
      });
    });
  };
};
