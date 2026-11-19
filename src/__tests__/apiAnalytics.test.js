'use strict';

const { analyticsMiddleware, getSnapshot, resetCounters } = require('../analytics/apiAnalytics');

function makeResMock(statusCode = 200) {
  const listeners = {};
  return {
    statusCode,
    on(event, cb) {
      listeners[event] = cb;
    },
    emit(event) {
      if (listeners[event]) listeners[event]();
    },
  };
}

function makeReqMock(method, path, routePath = null) {
  return {
    method,
    path,
    url: path,
    route: routePath ? { path: routePath } : null,
  };
}

beforeEach(() => resetCounters());

describe('analyticsMiddleware', () => {
  it('records a request after response finishes', () => {
    const middleware = analyticsMiddleware();
    const req = makeReqMock('GET', '/health');
    const res = makeResMock(200);
    middleware(req, res, () => {});
    res.emit('finish');

    const { routes } = getSnapshot();
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('GET');
    expect(routes[0].path).toBe('/health');
    expect(routes[0].requests).toBe(1);
    expect(routes[0].statusCodes[200]).toBe(1);
  });

  it('accumulates multiple requests on the same route', () => {
    const middleware = analyticsMiddleware();
    for (let i = 0; i < 3; i++) {
      const req = makeReqMock('POST', '/relay/execute', '/relay/execute');
      const res = makeResMock(201);
      middleware(req, res, () => {});
      res.emit('finish');
    }
    const { routes } = getSnapshot();
    expect(routes[0].requests).toBe(3);
  });

  it('tracks different status codes separately', () => {
    const middleware = analyticsMiddleware();
    [200, 200, 404, 500].forEach((code) => {
      const req = makeReqMock('GET', '/api/thing');
      const res = makeResMock(code);
      middleware(req, res, () => {});
      res.emit('finish');
    });
    const { routes } = getSnapshot();
    const r = routes[0];
    expect(r.statusCodes[200]).toBe(2);
    expect(r.statusCodes[404]).toBe(1);
    expect(r.statusCodes[500]).toBe(1);
  });

  it('uses req.route.path when available for normalisation', () => {
    const middleware = analyticsMiddleware();
    const req = makeReqMock('GET', '/users/123', '/users/:id');
    const res = makeResMock(200);
    middleware(req, res, () => {});
    res.emit('finish');

    const { routes } = getSnapshot();
    expect(routes[0].path).toBe('/users/:id');
  });

  it('calls next()', () => {
    const middleware = analyticsMiddleware();
    const next = jest.fn();
    middleware(makeReqMock('GET', '/'), makeResMock(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('getSnapshot', () => {
  it('returns empty routes when no requests have been recorded', () => {
    expect(getSnapshot()).toEqual({ routes: [] });
  });

  it('sorts routes by request count descending', () => {
    const middleware = analyticsMiddleware();
    const fire = (path, times) => {
      for (let i = 0; i < times; i++) {
        const req = makeReqMock('GET', path);
        const res = makeResMock(200);
        middleware(req, res, () => {});
        res.emit('finish');
      }
    };
    fire('/b', 2);
    fire('/a', 5);
    fire('/c', 1);
    const { routes } = getSnapshot();
    expect(routes[0].path).toBe('/a');
    expect(routes[1].path).toBe('/b');
    expect(routes[2].path).toBe('/c');
  });
});

describe('resetCounters', () => {
  it('clears all recorded data', () => {
    const middleware = analyticsMiddleware();
    const req = makeReqMock('DELETE', '/things/1');
    const res = makeResMock(204);
    middleware(req, res, () => {});
    res.emit('finish');
    expect(getSnapshot().routes).toHaveLength(1);
    resetCounters();
    expect(getSnapshot().routes).toHaveLength(0);
  });
});
