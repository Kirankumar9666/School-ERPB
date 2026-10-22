/**
 * BulkAddModal — choose the class first, then the file.
 *
 * ## The order matters
 *
 * The class is chosen BEFORE a file can be picked, because every row in the file
 * is saved for that class. Reversing the order lets an admin upload against
 * whatever happened to be selected, which is how a class gets a roster that
 * belongs somewhere else — and the templates are per-class, so there is also
 * nothing sensible to download until the class is known.
 *
 * ## No stored template
 *
 * The download buttons ask the server to build the file for that class each time.
 * Zero files per class are kept: the class id and the column list are all it
 * needs, and a new class appears with a working template immediately.
 *
 * ## Changing the class clears the file
 *
 * A file chosen for LKG A means nothing for UKG A. Rather than silently re-scoping
 * it (which would write children into a class nobody meant) or silently refusing
 * it, the file is cleared and the reason stated.
 */
import { useState } from 'react';
import { Download, Plus } from 'lucide-react';
import Modal from './Modal';
import api from '../services/api';
import toast from '../services/toast';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * The display name of a class row, from whichever source supplied it.
 *
 * Two shapes reach this component: the shared options endpoint sends `label`
 * ("LKG A") plus `studentCount`, while the Student Management page sends the
 * class summary, whose name is `class` ("LKG A"). Reading only `label` left
 * every option blank when the second shape was passed. `section` is the last
 * resort, so a row always renders something rather than an empty line.
 */
const classLabel = (c) => c.label || c.class || (c.section ? `Section ${c.section}` : '');

/** The columns a scoped template carries — mirrors the server's list. */
const TEMPLATE_COLUMNS = ['Name', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

const BulkRowErrors = ({ errors, error }) => {
  if (!error && !errors) return null;
  const rows = errors
    ? Object.entries(errors)
      .map(([key, value]) => ({ key, value }))
      .filter(({ value }) => value && typeof value === 'object' && !Array.isArray(value))
    : [];
  if (!error || rows.length === 0) return null;
  return (
    <div className="bulk-row-errors">
      {rows.map(({ key, value }) => {
        const label = /^row_(\d+)$/.exec(key) ? `Row ${key.replace('row_', '')}` : key;
        const problems = Object.entries(value).map(([column, message]) => (
          Array.isArray(message) ? `${column}: ${message.join(', ')}` : `${column}: ${message}`
        ));
        return (
          <div key={key} className="bulk-row-error">
            <span className="bulk-row-error-label">{label}</span>
            <span>{problems.join(' · ')}</span>
          </div>
        );
      })}
    </div>
  );
};

export default function BulkAddModal({ classes, onClose, onAdded }) {
  /* The class first. `null` means "not chosen yet", which is a different state
     from "the school has no classes at all". */
  const [classId, setClassId] = useState('');
  const [file, setFile] = useState(null);
  const [buskError, setBulkError] = useState('');
  const [bulkErrors, setBulkErrors] = useState(null);
  const [uploaded, setUploaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const chosen = (classes || []).find((c) => c.id === classId) || null;

  /* Pick a class → clear any file chosen for the previous one. Drop and re-create
     the file input's key so the browser cannot replay a hidden value. */
  const [inputKey, setInputKey] = useState(0);
  const pickClass = (id) => {
    if (id === classId) return;
    setClassId(id);
    setFile(null);
    setInputKey((k) => k + 1);
    setBulkError('');
    setBulkErrors(null);
    setUploaded(false);
  };

  /* The template download: server-generated for the chosen class, nothing stored. */
  const downloadTemplate = async (format) => {
    if (!chosen) return;
    const res = await api.get('/admin/students/bulk-template', {
      params: { classId: chosen.id, format },
      responseType: 'blob',
    });
    const disposition = String(res.headers['content-disposition'] || '');
    const match = /filename=\"?([^\";]+)\"?/i.exec(disposition);
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = match ? match[1] : `students-template.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Template for ${classLabel(chosen)} downloaded.`);
  };

  const handleUpload = async (file) => {
    setBulkError('');      // choosing a file always clears any previous error
    setBulkErrors(null);
    setUploaded(false);
    if (!file) return;
    if (!chosen) {
      setBulkError('Choose a class first.');
      setFile(null);
      setInputKey((k) => k + 1);
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('classId', chosen.id); // the scope every row is saved for
      const res = await api.post('/admin/students/bulk', fd);
      toast.success(res.data.message || 'Students added.');
      await onAdded(res.data);
      onClose();
    } catch (err) {
      /* Only place the bulk error is shown, and only after a real attempt. */
      setUploaded(true);
      setBulkError(err.response?.data?.message || 'Bulk upload failed.');
      setBulkErrors(err.response?.data?.errors || null);
    } finally {
      setSaving(false);
    }
  };

  const pickFile = (e) => {
    const chosenFile = e.target.files?.[0];
    e.target.value = ''; // allow re-choosing the same file after a failed attempt
    setFile(chosenFile || null);
    if (chosenFile) handleUpload(chosenFile);
  };

  return (
    <Modal
      title="Bulk Add Students"
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      )}
    >
      {buskError && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{buskError}</div>}
      <BulkRowErrors errors={bulkErrors} error={buskError} />

      {/* ── 1. the class ───────────────────────────────────────────────────── */}
      <div className="form-group">
        <label className="form-label" htmlFor="bulk-class">Class</label>
        {(classes || []).length === 0 ? (
          /* No classes at all: say so and show the way out. */
          <div>
            <div className="text-sm text-muted" style={{ marginBottom: 'var(--sp-sm)' }}>
              Create a class first — every student added this way goes to one class.
            </div>
            <button className="btn btn-primary btn-sm" onClick={onClose}>
              <Plus size={14} /> Create a class
            </button>
          </div>
        ) : (
          <select
            id="bulk-class"
            className="form-input"
            value={classId}
            onChange={(e) => pickClass(e.target.value)}
            disabled={saving}
            aria-label="Class"
          >
            <option value="">Select class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {classLabel(c)}
                {c.studentCount != null ? ` (${c.studentCount})` : ''}
              </option>
            ))}
          </select>
        )}
        {/* The class list is already in level order, so a named level reads
            "LKG A". The rows arrive from the page's class summary, whose display
            name is `class` — not the `label` the shared options endpoint uses —
            so `classLabel` reads whichever the caller supplied rather than
            assuming one, which is what left the options blank. */}
      </div>

      {/* ── 2. the file, only enabled once the class is known ──────────────── */}
      <div className="form-group">
        <label className="form-label" htmlFor="bulk-file">Upload a spreadsheet (.csv or .xlsx)</label>
        <input
          id="bulk-file"
          key={inputKey}
          type="file"
          className="form-input"
          accept=".csv,.xlsx"
          disabled={!chosen || saving}
          onChange={pickFile}
          aria-label="Bulk upload file"
        />
        {!chosen && (classes || []).length > 0 && (
          <div className="text-sm text-muted" style={{ marginTop: 4 }}>
            Choose a class first — this upload saves every row to that one class, and
            the template is built for it.
          </div>
        )}
        {file && (
          <div className="text-sm" style={{ marginTop: 4 }}>
            {file.name} selected
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginLeft: 'var(--sp-sm)' }}
              onClick={() => {
                setFile(null);
                setInputKey((k) => k + 1);
                setBulkError('');
                setBulkErrors(null);
                setUploaded(false);
              }}
              disabled={saving}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* ── 3. the templates, generated per class ─────────────────────────── */}
      {chosen && (
        <div className="info-note" style={{ marginBottom: 'var(--sp-md)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Templates for {classLabel(chosen)}
          </div>
          <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadTemplate('csv')}>
              <Download size={14} /> CSV
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadTemplate('xlsx')}>
              <Download size={14} /> XLSX
            </button>
          </div>
          <div className="text-sm text-muted" style={{ marginTop: 6 }}>
            Columns: {TEMPLATE_COLUMNS.join(', ')} — no Class or Section, because every row
            is saved to {classLabel(chosen)}. Generated fresh each time.
          </div>
        </div>
      )}

      <div className="text-sm text-muted">
        {chosen
          ? `Every row is saved to ${classLabel(chosen)}. Up to 200 students per file. Added atomically — if any row is invalid, nothing is saved. Blank roll numbers get the next free number in ${classLabel(chosen)}.`
          : 'Choose a class to begin. The class applies to every row you upload.'}
      </div>
      {uploaded && bulkErrors && (
        <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
          The file was refused, so nothing was saved. Fix the rows above and try again.
        </div>
      )}
    </Modal>
  );
}
