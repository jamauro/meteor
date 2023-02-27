if (Meteor.isServer) {
  // Set up allow/deny rules for test collections

  var allowCollections = {};

  // We create the collections in the publisher (instead of using a method or
  // something) because if we made them with a method, we'd need to follow the
  // method with some subscribes, and it's possible that the method call would
  // be delayed by a wait method and the subscribe messages would be sent before
  // it and fail due to the collection not yet existing. So we are very hacky
  // and use a publish.
  Meteor.publish("allowTests", function (nonce, idGeneration) {
    check(nonce, String);
    check(idGeneration, String);
    var cursors = [];
    var needToConfigure;

    // helper for defining a collection. we are careful to create just one
    // Mongo.Collection even if the sub body is rerun, by caching them.
    var defineCollection = function(name, insecure, transform) {
      var fullName = name + idGeneration + nonce;

      var collection;
      if (_.has(allowCollections, fullName)) {
        collection = allowCollections[fullName];
        if (needToConfigure === true)
          throw new Error("collections inconsistently exist");
        needToConfigure = false;
      } else {
        collection = new Mongo.Collection(
          fullName, {idGeneration: idGeneration, transform: transform});
        allowCollections[fullName] = collection;
        if (needToConfigure === false)
          throw new Error("collections inconsistently don't exist");
        needToConfigure = true;
        collection._insecure = insecure;
        var m = {};
        m["clear-collection-" + fullName] = async function() {
          await collection.removeAsync({});
        };
        Meteor.methods(m);
      }

      cursors.push(collection.find());
      return collection;
    };

    var insecureCollection = defineCollection(
      "collection-insecure", true /*insecure*/);
    // totally locked down collection
    var lockedDownCollection = defineCollection(
      "collection-locked-down", false /*insecure*/);
    // restricted collection with same allowed modifications, both with and
    // without the `insecure` package
    var restrictedCollectionDefaultSecure = defineCollection(
      "collection-restrictedDefaultSecure", false /*insecure*/);
    var restrictedCollectionDefaultInsecure = defineCollection(
      "collection-restrictedDefaultInsecure", true /*insecure*/);
    var restrictedCollectionForUpdateOptionsTest = defineCollection(
      "collection-restrictedForUpdateOptionsTest", true /*insecure*/);
    var restrictedCollectionForPartialAllowTest = defineCollection(
      "collection-restrictedForPartialAllowTest", true /*insecure*/);
    var restrictedCollectionForPartialDenyTest = defineCollection(
      "collection-restrictedForPartialDenyTest", true /*insecure*/);
    var restrictedCollectionForFetchTest = defineCollection(
      "collection-restrictedForFetchTest", true /*insecure*/);
    var restrictedCollectionForFetchAllTest = defineCollection(
      "collection-restrictedForFetchAllTest", true /*insecure*/);
    var restrictedCollectionWithTransform = defineCollection(
      "withTransform", false, function (doc) {
        return doc.a;
      });
    var restrictedCollectionForInvalidTransformTest = defineCollection(
      "collection-restrictedForInvalidTransform", false /*insecure*/);
    var restrictedCollectionForClientIdTest = defineCollection(
      "collection-restrictedForClientIdTest", false /*insecure*/);

    if (needToConfigure) {
      restrictedCollectionWithTransform.allow({
        insertAsync: function (userId, doc) {
          return doc.foo === "foo";
        },
        updateAsync: function (userId, doc) {
          return doc.foo === "foo";
        },
        removeAsync: function (userId, doc) {
          return doc.bar === "bar";
        }
      });
      restrictedCollectionWithTransform.allow({
        // transform: null means that doc here is the top level, not the 'a'
        // element.
        transform: null,
        insertAsync: function (userId, doc) {
          return !!doc.topLevelField;
        },
        updateAsync: function (userId, doc) {
          return !!doc.topLevelField;
        }
      });
      restrictedCollectionForInvalidTransformTest.allow({
        // transform must return an object which is not a mongo id
        transform: function (doc) { return doc._id; },
        insertAsync: function () { return true; }
      });
      restrictedCollectionForClientIdTest.allow({
        // This test just requires the collection to trigger the restricted
        // case.
        insertAsync: function () { return true; }
      });

      // two calls to allow to verify that either validator is sufficient.
      var allows = [{
        insertAsync: function(userId, doc) {
          return doc.canInsert;
        },
        updateAsync: function(userId, doc) {
          return doc.canUpdate;
        },
        removeAsync: function (userId, doc) {
          return doc.canRemove;
        }
      }, {
        insertAsync: function(userId, doc) {
          return doc.canInsert2;
        },
        updateAsync: function(userId, doc, fields, modifier) {
          return -1 !== _.indexOf(fields, 'canUpdate2');
        },
        removeAsync: function(userId, doc) {
          return doc.canRemove2;
        }
      }];

      // two calls to deny to verify that either one blocks the change.
      var denies = [{
        insertAsync: function(userId, doc) {
          return doc.cantInsert;
        },
        removeAsync: function (userId, doc) {
          return doc.cantRemove;
        }
      }, {
        insertAsync: function(userId, doc) {
          // Don't allow explicit ID to be set by the client.
          return _.has(doc, '_id');
        },
        updateAsync: function(userId, doc, fields, modifier) {
          return -1 !== _.indexOf(fields, 'verySecret');
        }
      }];

      _.each([
        restrictedCollectionDefaultSecure,
        restrictedCollectionDefaultInsecure,
        restrictedCollectionForUpdateOptionsTest
      ], function (collection) {
        _.each(allows, function (allow) {
          collection.allow(allow);
        });
        _.each(denies, function (deny) {
          collection.deny(deny);
        });
      });

      // just restrict one operation so that we can verify that others
      // fail
      restrictedCollectionForPartialAllowTest.allow({
        insertAsync: function() {}
      });
      restrictedCollectionForPartialDenyTest.deny({
        insertAsync: function() {}
      });

      // verify that we only fetch the fields specified - we should
      // be fetching just field1, field2, and field3.
      restrictedCollectionForFetchTest.allow({
        insertAsync: function() { return true; },
        updateAsync: function(userId, doc) {
          // throw fields in doc so that we can inspect them in test
          throw new Meteor.Error(
            999, "Test: Fields in doc: " + _.keys(doc).sort().join(','));
        },
        removeAsync: function(userId, doc) {
          // throw fields in doc so that we can inspect them in test
          throw new Meteor.Error(
            999, "Test: Fields in doc: " + _.keys(doc).sort().join(','));
        },
        fetch: ['field1']
      });
      restrictedCollectionForFetchTest.allow({
        fetch: ['field2']
      });
      restrictedCollectionForFetchTest.deny({
        fetch: ['field3']
      });

      // verify that not passing fetch to one of the calls to allow
      // causes all fields to be fetched
      restrictedCollectionForFetchAllTest.allow({
        insertAsync: function() { return true; },
        updateAsync: function(userId, doc) {
          // throw fields in doc so that we can inspect them in test
          throw new Meteor.Error(
            999, "Test: Fields in doc: " + _.keys(doc).sort().join(','));
        },
        removeAsync: function(userId, doc) {
          // throw fields in doc so that we can inspect them in test
          throw new Meteor.Error(
            999, "Test: Fields in doc: " + _.keys(doc).sort().join(','));
        },
        fetch: ['field1']
      });
      restrictedCollectionForFetchAllTest.allow({
        updateAsync: function() { return true; }
      });
    }

    return cursors;
  });
}

if (Meteor.isClient) {
  _.each(['STRING', 'MONGO'], function (idGeneration) {
    // Set up a bunch of test collections... on the client! They match the ones
    // created by setUpAllowTestsCollections.

    var nonce = Random.id();
    // Tell the server to make, configure, and publish a set of collections unique
    // to our test run. Since the method does not unblock, this will complete
    // running on the server before anything else happens.
    Meteor.subscribe('allowTests', nonce, idGeneration);

    // helper for defining a collection, subscribing to it, and defining
    // a method to clear it
    var defineCollection = function(name, transform) {
      var fullName = name + idGeneration + nonce;
      var collection = new Mongo.Collection(
        fullName, {idGeneration: idGeneration, transform: transform});

      collection.callClearMethod = async function () {
        await Meteor.callAsync("clear-collection-" + fullName);
      };
      collection.unnoncedName = name + idGeneration;
      return collection;
    };

    // totally insecure collection
    var insecureCollection = defineCollection("collection-insecure");

    // totally locked down collection
    var lockedDownCollection = defineCollection("collection-locked-down");

    // restricted collection with same allowed modifications, both with and
    // without the `insecure` package
    var restrictedCollectionDefaultSecure = defineCollection(
      "collection-restrictedDefaultSecure");
    var restrictedCollectionDefaultInsecure = defineCollection(
      "collection-restrictedDefaultInsecure");
    var restrictedCollectionForUpdateOptionsTest = defineCollection(
      "collection-restrictedForUpdateOptionsTest");
    var restrictedCollectionForPartialAllowTest = defineCollection(
      "collection-restrictedForPartialAllowTest");
    var restrictedCollectionForPartialDenyTest = defineCollection(
      "collection-restrictedForPartialDenyTest");
    var restrictedCollectionForFetchTest = defineCollection(
      "collection-restrictedForFetchTest");
    var restrictedCollectionForFetchAllTest = defineCollection(
      "collection-restrictedForFetchAllTest");
    var restrictedCollectionWithTransform = defineCollection(
      "withTransform", function (doc) {
        return doc.a;
      });
    var restrictedCollectionForInvalidTransformTest = defineCollection(
      "collection-restrictedForInvalidTransform");
    var restrictedCollectionForClientIdTest = defineCollection(
      "collection-restrictedForClientIdTest");

    // test that if allow is called once then the collection is
    // restricted, and that other mutations aren't allowed
    testAsyncMulti('collection - partial allow, ' + idGeneration, [
      function (test, expect) {
        restrictedCollectionForPartialAllowTest
          .updateAsync('foo', { $set: { updated: true } })
          .catch(
            expect(function (err) {
              test.equal(err.error, 403);
            })
          );
      },
    ]);

    // test that if deny is called once then the collection is
    // restricted, and that other mutations aren't allowed
    testAsyncMulti("collection - partial deny, " + idGeneration, [
      function (test, expect) {
        restrictedCollectionForPartialDenyTest.updateAsync(
          'foo', {$set: {updated: true}}).catch(expect(function (err) {
            test.equal(err.error, 403);
          }));
      }
    ]);


    // test that we only fetch the fields specified
    testAsyncMulti("collection - fetch, " + idGeneration, [
      async function (test, expect) {
        var fetchId = await restrictedCollectionForFetchTest.insertAsync(
          {field1: 1, field2: 1, field3: 1, field4: 1});
        var fetchAllId = await restrictedCollectionForFetchAllTest.insertAsync(
          {field1: 1, field2: 1, field3: 1, field4: 1});
        await restrictedCollectionForFetchTest.updateAsync(
          fetchId, {$set: {updated: true}}).catch(expect(function (err) {
            test.equal(err.reason,
                       "Test: Fields in doc: _id,field1,field2,field3");
          }));
        await restrictedCollectionForFetchTest.removeAsync(
          fetchId).catch(expect(function (err) {
            test.equal(err.reason,
                       "Test: Fields in doc: _id,field1,field2,field3");
          }));

        await restrictedCollectionForFetchAllTest.updateAsync(
          fetchAllId, {$set: {updated: true}}).catch(expect(function (err) {
            test.equal(err.reason,
                       "Test: Fields in doc: _id,field1,field2,field3,field4");
          }));
        await restrictedCollectionForFetchAllTest.removeAsync(
          fetchAllId).catch(expect(function (err) {
            test.equal(err.reason,
                       "Test: Fields in doc: _id,field1,field2,field3,field4");
          }));
      }
    ]);

    (function(){
      testAsyncMulti("collection - restricted factories " + idGeneration, [
        async function (test) {
          await restrictedCollectionWithTransform.callClearMethod().then(async () => {
            test.equal(await restrictedCollectionWithTransform.find().count(), 0);
          });
        },
        async function (test) {
          var self = this;
          await restrictedCollectionWithTransform.insertAsync({
            a: {foo: "foo", bar: "bar", baz: "baz"}
          }).then(res => {
            test.isTrue(res);
            self.item1 = res;
          }).catch(e => {
            test.isFalse(e);
          });
          await restrictedCollectionWithTransform.insertAsync({
            a: {foo: "foo", bar: "quux", baz: "quux"},
            b: "potato"
          }).then(res => {
            test.isTrue(res);
            self.item2 = res;
          }).catch(e => {
            test.isFalse(e);
          });
          await restrictedCollectionWithTransform.insertAsync({
            a: {foo: "adsfadf", bar: "quux", baz: "quux"},
            b: "potato"
          }).catch(e => {
            test.isTrue(e);
          });
          await restrictedCollectionWithTransform.insertAsync({
            a: {foo: "bar"},
            topLevelField: true
          }).then(res => {
            test.isTrue(res);
            self.item3 = res;
          }).catch(e => {
            test.isFalse(e);
          });
        },
        async function (test, expect) {
          var self = this;
          // This should work, because there is an updateAsync allow for things with
          // topLevelField.
          await restrictedCollectionWithTransform.updateAsync(
            self.item3, { $set: { xxx: true } }).then(expect(function (res) {
              test.equal(1, res);
            }));
        },
        async function (test, expect) {
          var self = this;
          test.equal(
              await restrictedCollectionWithTransform.findOneAsync(self.item1),
            {_id: self.item1, foo: "foo", bar: "bar", baz: "baz"});
          await restrictedCollectionWithTransform.removeAsync(self.item1);
          await restrictedCollectionWithTransform.removeAsync(
            self.item2).catch(expect(function (e) {
              test.isTrue(e);
            }));
        }
      ]);
    })();

    testAsyncMulti("collection - insecure, " + idGeneration, [
      async function (test) {
        await insecureCollection.callClearMethod().then(async () => {
          test.equal(await insecureCollection.find().count(), 0);
        });
      },
      async function (test, expect) {
        var id = await insecureCollection.insertAsync({foo: 'bar'});
        test.isTrue(id);
        test.equal(await insecureCollection.find(id).count(), 1);
        test.equal((await insecureCollection.findOneAsync(id)).foo, 'bar');
        test.equal((await insecureCollection.find(id)).count(), 1);
        test.equal((await insecureCollection.findOneAsync(id)).foo, 'bar');
      }
    ]);

    testAsyncMulti("collection - locked down, " + idGeneration, [
      async function (test) {
        await lockedDownCollection.callClearMethod().then(async function() {
          test.equal(await lockedDownCollection.find().count(), 0);
        });
      },
      async function (test) {
        await lockedDownCollection.insertAsync({foo: 'bar'}).catch(async function (err) {
          test.equal(err.error, 403);
          test.equal(await lockedDownCollection.find().count(), 0);
        });
      }
    ]);

    (function () {
      var collection = restrictedCollectionForUpdateOptionsTest;
      var id1, id2;
      testAsyncMulti("collection - updateAsync options, " + idGeneration, [
        // init
        async function (test) {
          await collection.callClearMethod().then(async function () {
            test.equal(await collection.find().count(), 0);
          });
        },
        // put a few objects
        async function (test) {
          var doc = {canInsert: true, canUpdate: true};
          id1 = await collection.insertAsync(doc);
          id2 = await collection.insertAsync(doc);
          await collection.insertAsync(doc);
          await collection.insertAsync(doc).catch(async function (err) {
            test.isFalse(err);
            test.equal(await collection.find().count(), 4);
          });
        },
        // updateAsync by id
        async function (test) {
         await collection.updateAsync(
            id1,
            {$set: {updated: true}}).then(async res => {
              test.equal(res, 1);
              test.equal(await collection.find({updated: true}).count(), 1);
            });
        },
        // updateAsync by id in an object
        async function (test) {
          await collection.updateAsync(
            {_id: id2},
            {$set: {updated: true}}).then( async function (res) {
              test.equal(res, 1);
              test.equal(await collection.find({updated: true}).count(), 2);
            });
        },
        // updateAsync with replacement operator not allowed, and has nice error.
        async function (test) {
          collection.updateAsync(
            {_id: id2},
            {_id: id2, updated: true}).catch(async function (err) {
              test.equal(err.error, 403);
              test.matches(err.reason, /In a restricted/);
              // unchanged
              test.equal(await collection.find({updated: true}).count(), 2);
            });
        },
        // upsert not allowed, and has nice error.
        async function (test) {
          collection.updateAsync(
            {_id: id2},
            {$set: { upserted: true }},
            { upsert: true }).catch(async function (err) {
              test.equal(err.error, 403);
              test.matches(err.reason, /in a restricted/);
              test.equal(await collection.find({ upserted: true }).count(), 0);
            });
        },
        // updateAsync with rename operator not allowed, and has nice error.
        async function (test) {
          collection.updateAsync(
            {_id: id2},
            {$rename: {updated: 'asdf'}}).catch(async function (err) {
              test.equal(err.error, 403);
              test.matches(err.reason, /not allowed/);
              // unchanged
              test.equal(await collection.find({updated: true}).count(), 2);
            });
        },
        // updateAsync method with a non-ID selector is not allowed
        async function (test, expect) {
          // We shouldn't even send the method...
          await test.throwsAsync(async function () {
              await collection.updateAsync(
                  {updated: {$exists: false}},
                  {$set: {updated: true}});
          });
          // ... but if we did, the server would reject it too.
          await Meteor.callAsync(
            '/' + collection._name + '/updateAsync',
            {updated: {$exists: false}},
            {$set: {updated: true}}).catch(async function (err) {
              test.equal(err.error, 403);
              // unchanged
              test.equal(await collection.find({updated: true}).count(), 2);
            });
        },
        // make sure it doesn't think that {_id: 'foo', something: else} is ok.
        async function (test) {
          await test.throwsAsync(async function () {
            await collection.updateAsync(
              {_id: id1, updated: {$exists: false}},
              {$set: {updated: true}});
          });
        },
        // removeAsync method with a non-ID selector is not allowed
        async function (test) {
          // We shouldn't even send the method...
          await test.throwsAsync(async function () {
            await collection.removeAsync({updated: true});
          });
          //TODO Fix
          // ... but if we did, the server would reject it too.
          await Meteor.callAsync(
            '/' + collection._name + '/removeAsync',
            {updated: true}).catch(async function (err) {
              test.equal(err.error, 403);
              // unchanged
              test.equal(await collection.find({updated: true}).count(), 2);
            });
        }
      ]);
    }) ();

    _.each(
      [restrictedCollectionDefaultInsecure, restrictedCollectionDefaultSecure],
      function(collection) {
        var canUpdateId, canRemoveId;

        testAsyncMulti("collection - " + collection.unnoncedName, [
          // init
          function (test, expect) {
            collection.callClearMethod(expect(function () {
              test.equal(collection.find().count(), 0);
            }));
          },

          // insertAsync with no allows passing. request is denied.
          function (test, expect) {
            collection.insertAsync(
              {},
              expect(function (err, res) {
                test.equal(err.error, 403);
                test.equal(collection.find().count(), 0);
              }));
          },
          // insertAsync with one allow and one deny. denied.
          function (test, expect) {
            collection.insertAsync(
              {canInsert: true, cantInsert: true},
              expect(function (err, res) {
                test.equal(err.error, 403);
                test.equal(collection.find().count(), 0);
              }));
          },
          // insertAsync with one allow and other deny. denied.
          function (test, expect) {
            collection.insertAsync(
              {canInsert: true, _id: Random.id()},
              expect(function (err, res) {
                test.equal(err.error, 403);
                test.equal(collection.find().count(), 0);
              }));
          },
          // insertAsync one allow passes. allowed.
          function (test, expect) {
            collection.insertAsync(
              {canInsert: true},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(collection.find().count(), 1);
              }));
          },
          // insertAsync other allow passes. allowed.
          // includes canUpdate for later.
          function (test, expect) {
            canUpdateId = collection.insertAsync(
              {canInsert2: true, canUpdate: true},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(collection.find().count(), 2);
              }));
          },
          // yet a third insertAsync executes. this one has canRemove and
          // cantRemove set for later.
          function (test, expect) {
            canRemoveId = collection.insertAsync(
              {canInsert: true, canRemove: true, cantRemove: true},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(collection.find().count(), 3);
              }));
          },

          // can't updateAsync with a non-operator mutation
          function (test, expect) {
            collection.updateAsync(
              canUpdateId, {newObject: 1},
              expect(function (err, res) {
                test.equal(err.error, 403);
                test.equal(collection.find().count(), 3);
              }));
          },

          // updating dotted fields works as if we are changing their
          // top part
          function (test, expect) {
            collection.updateAsync(
              canUpdateId, {$set: {"dotted.field": 1}},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(res, 1);
                test.equal(collection.findOneAsync(canUpdateId).dotted.field, 1);
              }));
          },
          function (test, expect) {
            collection.updateAsync(
              canUpdateId, {$set: {"verySecret.field": 1}},
              expect(function (err, res) {
                test.equal(err.error, 403);
                test.equal(collection.find({verySecret: {$exists: true}}).count(), 0);
              }));
          },

          // updateAsync doesn't do anything if no docs match
          function (test, expect) {
            collection.updateAsync(
              "doesn't exist",
              {$set: {updated: true}},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(res, 0);
                // nothing has changed
                test.equal(collection.find().count(), 3);
                test.equal(collection.find({updated: true}).count(), 0);
              }));
          },
          // updateAsync fails when access is denied trying to set `verySecret`
          function (test, expect) {
            collection.updateAsync(
              canUpdateId, {$set: {verySecret: true}},
              expect(function (err, res) {
                test.equal(err.error, 403);
                // nothing has changed
                test.equal(collection.find().count(), 3);
                test.equal(collection.find({updated: true}).count(), 0);
              }));
          },
          // updateAsync fails when trying to set two fields, one of which is
          // `verySecret`
          function (test, expect) {
            collection.updateAsync(
              canUpdateId, {$set: {updated: true, verySecret: true}},
              expect(function (err, res) {
                test.equal(err.error, 403);
                // nothing has changed
                test.equal(collection.find().count(), 3);
                test.equal(collection.find({updated: true}).count(), 0);
              }));
          },
          // updateAsync fails when trying to modify docs that don't
          // have `canUpdate` set
          function (test, expect) {
            collection.updateAsync(
              canRemoveId,
              {$set: {updated: true}},
              expect(function (err, res) {
                test.equal(err.error, 403);
                // nothing has changed
                test.equal(collection.find().count(), 3);
                test.equal(collection.find({updated: true}).count(), 0);
              }));
          },
          // updateAsync executes when it should
          function (test, expect) {
            collection.updateAsync(
              canUpdateId,
              {$set: {updated: true}},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(res, 1);
                test.equal(collection.find({updated: true}).count(), 1);
              }));
          },

          // removeAsync fails when trying to modify a doc with no `canRemove` set
          function (test, expect) {
            collection.removeAsync(canUpdateId,
                              expect(function (err, res) {
              test.equal(err.error, 403);
              // nothing has changed
              test.equal(collection.find().count(), 3);
            }));
          },
          // removeAsync fails when trying to modify an doc with `cantRemove`
          // set
          function (test, expect) {
            collection.removeAsync(canRemoveId,
                              expect(function (err, res) {
              test.equal(err.error, 403);
              // nothing has changed
              test.equal(collection.find().count(), 3);
            }));
          },

          // updateAsync the doc to removeAsync cantRemove.
          function (test, expect) {
            collection.updateAsync(
              canRemoveId,
              {$set: {cantRemove: false, canUpdate2: true}},
              expect(function (err, res) {
                test.isFalse(err);
                test.equal(res, 1);
                test.equal(collection.find({cantRemove: true}).count(), 0);
              }));
          },

          // now remove can remove it.
          function (test, expect) {
            collection.removeAsync(canRemoveId,
                              expect(function (err, res) {
              test.isFalse(err);
              test.equal(res, 1);
              // successfully removed
              test.equal(collection.find().count(), 2);
            }));
          },

          // try to remove a doc that doesn't exist. see we remove no docs.
          function (test, expect) {
            collection.removeAsync('some-random-id-that-never-matches',
                              expect(function (err, res) {
              test.isFalse(err);
              test.equal(res, 0);
              // nothing removed
              test.equal(collection.find().count(), 2);
            }));
          },

          // methods can still bypass restrictions
          function (test, expect) {
            collection.callClearMethod(
              expect(function (err, res) {
                test.isFalse(err);
                // successfully removed
                test.equal(collection.find().count(), 0);
            }));
          }
        ]);
      });
    testAsyncMulti(
      "collection - allow/deny transform must return object, " + idGeneration,
      [async function (test) {
        await restrictedCollectionForInvalidTransformTest.insertAsync({}).catch(function (err) {
          test.isTrue(err);
        });
      }]);
    testAsyncMulti(
      "collection - restricted collection allows client-side id, " + idGeneration,
      [async function (test, expect) {
        var self = this;
        self.id = Random.id();
        await restrictedCollectionForClientIdTest.insertAsync({_id: self.id}).then(expect(async function (res) {
          test.equal(res, self.id);
          test.equal(await restrictedCollectionForClientIdTest.findOneAsync(self.id),
                     {_id: self.id});
        }));
      }]);
  });  // end idGeneration loop
}  // end if isClient



// A few simple server-only tests which don't need to coordinate collections
// with the client..
if (Meteor.isServer) {
  Tinytest.add("collection - allow and deny validate options", function (test) {
    var collection = new Mongo.Collection(null);

    test.throws(function () {
      collection.allow({invalidOption: true});
    });
    test.throws(function () {
      collection.deny({invalidOption: true});
    });

    _.each(['insertAsync', 'updateAsync', 'removeAsync', 'fetch'], function (key) {
      var options = {};
      options[key] = true;
      test.throws(function () {
        collection.allow(options);
      });
      test.throws(function () {
        collection.deny(options);
      });
    });

    _.each(['insertAsync', 'updateAsync', 'removeAsync'], function (key) {
      var options = {};
      options[key] = false;
      test.throws(function () {
        collection.allow(options);
      });
      test.throws(function () {
        collection.deny(options);
      });
    });

    _.each(['insertAsync', 'updateAsync', 'removeAsync'], function (key) {
      var options = {};
      options[key] = undefined;
      test.throws(function () {
        collection.allow(options);
      });
      test.throws(function () {
        collection.deny(options);
      });
    });

    _.each(['insertAsync', 'updateAsync', 'removeAsync'], function (key) {
      var options = {};
      options[key] = ['an array']; // this should be a function, not an array
      test.throws(function () {
        collection.allow(options);
      });
      test.throws(function () {
        collection.deny(options);
      });
    });

    test.throws(function () {
      collection.allow({fetch: function () {}}); // this should be an array
    });
  });

  Tinytest.add("collection - calling allow restricts", function (test) {
    var collection = new Mongo.Collection(null);
    test.equal(collection._restricted, false);
    collection.allow({
      insertAsync: function() {}
    });
    test.equal(collection._restricted, true);
  });

  Tinytest.add("collection - global insecure", function (test) {
    // note: This test alters the global insecure status, by sneakily hacking
    // the global Package object!
    var insecurePackage = Package.insecure;

    Package.insecure = {};
    var collection = new Mongo.Collection(null);
    test.equal(collection._isInsecure(), true);

    Package.insecure = undefined;
    test.equal(collection._isInsecure(), false);

    delete Package.insecure;
    test.equal(collection._isInsecure(), false);

    collection._insecure = true;
    test.equal(collection._isInsecure(), true);

    if (insecurePackage)
      Package.insecure = insecurePackage;
    else
      delete Package.insecure;
  });
}
