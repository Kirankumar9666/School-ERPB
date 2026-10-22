import { TriangleAlert } from 'lucide-react';

/**
 * LoadErrorState — the failure half of the loading / empty / error trio.
 *
 * Every list view in this app has to tell three things apart, and until now
 * only some of them did:
 *
 *   loading  → spinner
 *   empty    → the real "there is nothing here yet" state
 *   failed   → THIS: the request never produced an answer, so we know nothing
 *              about the data either way
 *
 * Rendering the second when the third happened is what made a 500 look like an
 * empty school, an empty fee book, an empty calendar. This block is placed
 * exactly where the empty state would have gone, so a failure can never be
 * mistaken for a genuine "no records".
 *
 * The copy is deliberately generic — no page name, no endpoint, no status code
 * invented here. The one line of specifics is `detail`, which comes from
 * `describeLoadError()` and says what actually went wrong.
 *
 * Usage:
 *   full page   → <LoadErrorState title="..." detail={error} onRetry={retry} />
 *   inline area → <LoadErrorState compact detail={error} onRetry={retry} />
 */
export default function LoadErrorState({
  title,
  subtitle,
  detail,
  onRetry,
  icon: Icon = TriangleAlert,
  compact = false,
}) {
  const block = (
    <div className={`empty-state${compact ? ' text-sm text-muted' : ''}`}>
      <Icon size={compact ? 24 : 40} />
      Couldn&apos;t load this data.
      <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)', maxWidth: 460 }}>
        {detail}
        <br />
        This is a loading problem — nothing has been changed, deleted or emptied.
      </div>
      <button
        type="button"
        className={`btn btn-primary${compact ? ' btn-sm' : ''}`}
        style={{ marginTop: 'var(--sp-md)' }}
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  );

  // No title means the caller is rendering this inside its own layout — an
  // inline region such as a widget, a search result or a calendar panel.
  if (!title) return block;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">{title}</div>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
      </div>
      {block}
    </div>
  );
}
