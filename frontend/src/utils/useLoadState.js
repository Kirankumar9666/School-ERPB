import { useCallback, useState } from 'react';

/**
 * Turns a rejected fetch into one readable line for the error state.
 *
 * Deliberately derived from whatever the failure actually was — the server's
 * own message when it sent one, the status code when it answered but not with
 * a message, and axios' own text (usually "Network Error") when nothing
 * answered at all. Nothing here names a page or an endpoint, so the same
 * sentence is correct everywhere the app fetches data.
 */
export function describeLoadError(err) {
  if (!err) return 'The request did not complete.';
  if (err.response?.data?.message) return err.response.data.message;
  if (err.response) {
    const status = `${err.response.status}${err.response.statusText ? ` ${err.response.statusText}` : ''}`;
    return `The server responded with ${status}.`;
  }
  if (err.message) return err.message;
  return 'The request never reached the server.';
}

/**
 * useLoadState — the loading / error / retry lifecycle every list page needs.
 *
 * WHY THIS EXISTS: the bug this replaces was almost always the same two-line
 * shape, repeated in page after page:
 *
 *     api.get(...).then(setData).finally(() => setLoading(false));
 *
 * `.finally` clears the spinner whether or not the request worked, so a 500 or
 * a dead network left the component rendering its default `[]` — an outage
 * drawn on screen as "there is nothing here". Each page then hand-rolled its
 * own fix, and the pages that never got one are exactly the ones still broken.
 * Owning the three states together makes the failure branch impossible to
 * forget: `error` only ever clears on success or an explicit retry.
 *
 * `reloadKey` is the retry trigger — put it in the dependency array of the
 * effect that loads data and calling `retry()` re-runs it after clearing the
 * previous error. That is the same mechanism the pages that already handled
 * this correctly were using, kept deliberately so their behaviour is unchanged.
 */
export function useLoadState() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  /** Record a failed load so the page renders LoadErrorState instead of "empty". */
  const fail = useCallback((err) => setError(describeLoadError(err)), []);

  /** Clear the failure without reloading — called when a load succeeds. */
  const clearError = useCallback(() => setError(''), []);

  /** Retry: drop the error, show the spinner again, re-run the load effect. */
  const retry = useCallback(() => {
    setError('');
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  return { loading, setLoading, error, setError, reloadKey, retry, fail, clearError };
}

export default useLoadState;
