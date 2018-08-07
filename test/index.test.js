const path = require('path');
const assume = require('assume');
const Cache = require('../lib/');
const rimraf = require('rimraf');
const sinon = require('sinon');

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

describe('Out of Band cache', () => {
  const cachePath = path.resolve(__dirname, '../.cache');

  beforeEach(done => {
    rimraf(cachePath, done);
  });

  it('does not prevent a failed request from being retried later on', async function () {
    const cache = new Cache({
      maxAge: 60 * 60 * 1000,
      fsCachePath: cachePath,
      maxStaleness: 60 * 60 * 1000
    });
    let value;

    async function willCrash() {
      await cache.get('some-key', {}, async (key, staleItem) => {
        assume(key).equals('some-key');
        assume(staleItem).is.falsey();
        throw new Error('Aaaa!');
      });
    }

    try {
      await willCrash();
    } catch (e) {
      assume(e).matches(/Aaaa!/);
    }

    value = await cache.get('some-key', {}, async () => 'Some value');
    assume(value).deep.equals({ fromCache: false, value: 'Some value' });

    async function willAlsoCrash() {
      return await cache.get('some-key', {}, async () => {
        throw new Error('Got unexpected cache miss');
      });
    }

    try {
      value = await willAlsoCrash();
    } catch (e) {
      assume(e).to.be.truthy();
    }

    assume(value).deep.equals({ fromCache: true, value: 'Some value' });
  });

  it('always provides at least 1 cache', function () {
    const justMemory = new Cache({});
    assume(justMemory._caches).has.length(1);

    const withFile = new Cache({ fsCachePath: cachePath });
    assume(withFile._caches).has.length(2);
  });

  describe('get', function () {
    it('never uses the cache if we specifically want to skip it', async function () {
      const skipper = new Cache({});
      const getter = async i => i;

      const first = await skipper.get('data', {}, getter);
      const second = await skipper.get('data', { skipCache: true }, getter);
      const third = await skipper.get('data', {}, getter);

      assume(first.fromCache).is.falsey();
      assume(second.fromCache).is.falsey();
      assume(third.fromCache).is.truthy();
    });

    it('refreshes on a previously uncached key', async function () {
      const uncached = new Cache({});
      uncached._refresh = async (key) => {
        assume(key).equals('data');
        return true;
      };

      const calledRefresh = await uncached.get('data', {});
      assume(calledRefresh).is.truthy();
    });

    it('refreshes on an expired item', async function () {
      const fridge = new Cache({ maxAge: -10, maxStaleness: -10 }); // items are immediately stale
      const getter = async i => i;

      await fridge.get('old milk', {}, getter);
      await sleep(100);
      const expired = await fridge.get('old milk', { maxAge: 10, maxStaleness: 10 }, getter);

      assume(expired.fromCache).is.falsey();
    });
  });

  describe('_refresh', function () {
    it('immediately returns an existing pending refresh', async function () {
      const cache = new Cache({});
      cache._pendingRefreshes.nuclearLaunchCodes = 12345;
      const stub = sinon.stub();

      const value = await cache._refresh('nuclearLaunchCodes', null, stub);
      assume(JSON.stringify(value)).equals(JSON.stringify({ value: 12345, fromCache: false }));
      assume(stub.called).is.falsey();
    });

    it('deletes a pending refresh if the getter crashes', async function () {
      const cache = new Cache({});
      const badGetter = async () => {
        throw new Error('that was no bueno');
      };

      let caught;
      try {
        await cache._refresh('data', null, badGetter);
      } catch (err) {
        caught = true;
        assume(err).matches('that was no bueno');
        assume(cache._pendingRefreshes.data).does.not.exist();
      }

      assume(caught).is.truthy();
    });

    it('gradually removes each pending request as they complete', async function () {
      const cache = new Cache({});

      const slowGetter = async (i) => {
        await sleep(500);
        return i;
      };

      const tasks = Array(10).fill(0).map((_, i) => {
        // no await because we want to proceed before they resolve
        return cache._refresh(i, null, slowGetter);
      });

      assume(Object.entries(cache._pendingRefreshes)).has.length(10);

      await Promise.all(tasks);
      assume(Object.entries(cache._pendingRefreshes)).has.length(0);
    });
  });
});