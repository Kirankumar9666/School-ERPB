import { useId, useRef } from 'react';
import { CalendarClock, Paperclip, Upload, X } from 'lucide-react';

/**
 * Shared announcement form pieces. `AnnouncementPdfField` is used by BOTH the
 * admin Announcements page and the Employee Portal's "Push Announcement" dialog;
 * `AnnouncementFields` supplies the Employee Portal's text half (the admin form
 * keeps its own markup around the extra Audience block).
 *
 * The PDF field reuses the same file-picker markup as the document uploads
 * (.doc-file-row): the native input is visually hidden and a styled label acts
 * as the "Choose File" button, with the picked file's real name beside it.
 * The server re-validates the upload (extension + MIME + `%PDF-` magic bytes),
 * so the `accept` filter here is only a convenience.
 *
 * The form rules live in `utils/announcement.js` (`validateAnnouncement`) so
 * this file exports components only.
 */

/** Optional PDF attachment picker: Choose File + the picked name + Remove. */
export function AnnouncementPdfField({ file, onChange, onClear, disabled = false }) {
  const inputRef = useRef(null);
  // Unique per mounted field, so the "Choose File" label points at THIS input
  // (both portals can have one on screen at the same time).
  const inputId = useId();

  return (
    <div className="form-group">
      <label className="form-label"><Paperclip size={13} /> Attachment (PDF, optional)</label>
      <div className="doc-file-row">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="application/pdf,.pdf"
          className="doc-file-input"
          disabled={disabled}
          onChange={(e) => {
            // Clear the native value first so re-picking the SAME file after a
            // remove still fires a change event.
            onChange(e.target.files?.[0] || null);
            e.target.value = '';
          }}
        />
        <label className="btn btn-secondary" htmlFor={inputId}>
          <Upload size={16} /> Choose File
        </label>
        <span className="doc-file-name" title={file?.name || ''}>
          {file ? file.name : 'No file chosen'}
        </span>
        {file && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClear}
            disabled={disabled}
            aria-label="Remove attachment"
            title="Remove attachment"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
        Recipients can download the PDF from their announcements list. PDF only, up to 5 MB.
      </div>
    </div>
  );
}

/**
 * Title / Category / Body / Show window — the text half of an announcement.
 *
 * The admin Announcements page keeps its own inline markup for these (it has the
 * extra Audience-tag block and its own button row), but the field set, the
 * labels and the validation below are the same ones — so the Employee Portal's
 * push dialog offers exactly what an admin sees, minus the audience tags.
 *
 * The Audience tags are deliberately NOT here: a broad admin publish picks
 * roles, while a targeted send picks a class or all employees, so the audience
 * control stays with the flow that owns it.
 *
 * `value` is `{ title, body, category, showFrom, showUntil }`; `onChange(next)`
 * receives a new object.
 */
export function AnnouncementFields({ value, onChange, categories, optionLabel = (c) => c, disabled = false }) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <>
      <div className="form-grid-2">
        <div className="form-group">
          <label className="form-label">Title *</label>
          <input
            className="form-input" value={value.title} disabled={disabled}
            onChange={(e) => set({ title: e.target.value })} placeholder="e.g. PTM on Saturday"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Category</label>
          <select
            className="form-input" value={value.category} disabled={disabled}
            onChange={(e) => set({ category: e.target.value })}
          >
            {categories.map((c) => <option key={c} value={c}>{optionLabel(c)}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Body *</label>
        <textarea
          className="form-input" rows={4} value={value.body} disabled={disabled}
          onChange={(e) => set({ body: e.target.value })} placeholder="Announcement details..."
        />
      </div>
      <div className="form-grid-2">
        <div className="form-group">
          <label className="form-label"><CalendarClock size={13} /> Show from (blank = today)</label>
          <input
            type="date" className="form-input" value={value.showFrom} disabled={disabled}
            onChange={(e) => set({ showFrom: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label className="form-label"><CalendarClock size={13} /> Show until *</label>
          <input
            type="date" className="form-input" required value={value.showUntil} disabled={disabled}
            onChange={(e) => set({ showUntil: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}
