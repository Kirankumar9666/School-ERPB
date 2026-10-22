/**
 * Async route error propagation for Express 4.
 *
 * Express 4 invokes route handlers synchronously and only catches SYNCHRONOUS
 * throws. An `async` handler that rejects therefore never reaches `next(err)`:
 * the request is left with no response at all, the client hangs until it times
 * out, and the app's global error handler — which would have logged the cause
 * and answered 500 — never runs. The `unhandledRejection` guard in app.js keeps
 * the process alive, but it cannot produce a response for a request that is
 * already in flight.
 *
 * This wraps each handler so a rejection becomes `next(err)`. Express 5 does
 * this natively and this file can be deleted the day the app moves to it.
 *
 * Applied per router (not by patching `express.Router`) so it is an explicit,
 * greppable decision at each `const router = express.Router()` rather than a
 * monkey-patch whose presence you have to infer. Only the verb methods are
 * wrapped: `router.use` middleware in this app is all synchronous, and wrapping
 * it would insert a microtask before every downstream handler for no gain.
 */

/**
 * One handler → a sync-looking handler that forwards rejections to `next`.
 *
 * ## Arity must be preserved
 *
 * Express decides what KIND of function it is looking at purely from the number
 * of declared parameters: four means error middleware, anything else means an
 * ordinary handler. A flat three-parameter wrapper silently demotes an error
 * handler to a normal one, and Express then calls it with `(req, res, next)` — so
 * a `function (err, req, res, next)` handler receives `req` as its error, `next`
 * as its response, and `undefined` as its `next`. The first symptom is an
 * inscrutable `TypeError: next is not a function` thrown from the error handler
 * on a request that had nothing wrong with it at all.
 *
 * That is not hypothetical: `documentUploadError` is registered as a positional
 * handler after a multer middleware on four routes, so every JSON request to them
 * — one with no attachment, which multer skips — walked straight into it.
 *
 * Two wrappers rather than a computed one, because a handler's arity has to be
 * visible in the source for a reader to trust it, and `asyncRoute` is on the hot
 * path of every request.
 */
const asyncRoute = (handler) => (
  handler.length === 4
    /* Error middleware: same four parameters, so Express still routes errors to
       it, and a rejection inside it reaches `next` instead of vanishing. */
    ? function wrappedErrorHandler(err, req, res, next) {
      Promise.resolve(handler(err, req, res, next)).catch(next);
    }
    : function wrapped(req, res, next) {
      // `Promise.resolve(...)` also normalises a non-promise return, so a handler
      // that is not declared async is unaffected.
      Promise.resolve(handler(req, res, next)).catch(next);
    }
);

/**
 * Make every route registered on `router` from now on forward async failures to
 * Express's error pipeline. Call it immediately after creating the router.
 * @param {import('express').Router} router
 */
const wrapAsync = (router) => {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method];
    router[method] = function wrappedVerb(path, ...handlers) {
      return original.call(this, path, ...handlers.map(asyncRoute));
    };
  }
  return router;
};

module.exports = { asyncRoute, wrapAsync };
