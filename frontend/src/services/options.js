/**
 * Reference options (enum lists + classes) for form selects.
 *
 * The lists live on the server — enum values come from the Prisma schema enums
 * and the two zod-validated lists in constants/options.js, and classes are read
 * from the classes table. Screens fetch them instead of keeping a local copy,
 * so a schema change can never drift from the UI.
 */
import api from './api';

/**
 * GET /school/options.
 * @returns {Promise<{enums: object, classes: Array<{id: string, grade: string, section: string, label: string, studentCount: number}>}>}
 */
export const loadOptions = () => api.get('/school/options').then((r) => r.data.data);

/**
 * Human label for a lowercase option value.
 * 'casual' → 'Casual', 'half-day' → 'Half-day'
 * @param {string} value
 */
export const optionLabel = (value) =>
  String(value ?? '').charAt(0).toUpperCase() + String(value ?? '').slice(1);