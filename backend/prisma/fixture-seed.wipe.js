/**
 * The destructive half of the fixture seed, on its own.
 *
 * `seed()` (prisma/seed.js) builds the fixtures; this deletes what is there
 * before it does. The two are separated so the guard has one obvious door, and so
 * `demo-seed.js` can reuse the fixture body WITHOUT the wipe by calling `seed()`
 * with `{ wipe: false }`.
 *
 * Refuses loudly when the database is not a test database. Called only from
 * `seed()`, which has already been through the guard.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
const wipeAll = async (prisma) => {
  /* Reverse-dependency order (idempotent re-seed).

     `attendanceConfirmation` has no foreign key at all, so nothing cascades it
     away — it has to be named here or a re-seed leaves the previous run's
     confirmed windows behind and the 1-hour edit lock fires on a date nobody
     marked. The other late additions (employmentEnd, payrollPayment) do
     cascade from their parents, but are listed anyway so the order stays
     readable rather than depending on a reader knowing which FKs exist. */
  const models = [
    'auditEntry', 'marksEntry', 'exam', 'studentAttendance', 'employeeAttendance',
    'attendanceConfirmation', 'studentEnrollment', 'feePayment', 'studentFee',
    'teachingAssignment', 'leaveRequest', 'leaveBalance', 'payrollPayment', 'payrollRecord',
    'employeeDocument', 'studentDocument', 'achievement', 'syllabusEntry', 'timetablePeriod',
    'reminder', 'announcement', 'holiday', 'employmentEnd', 'student', 'academicYear',
    'class', 'employee', 'user', 'setting',
  ];
  for (const model of models) {
    await prisma[model].deleteMany();
  }

  /* Grade levels are NOT deleted, deliberately, and this is why.

     `gradeLevel` has always sat outside this list, and the rows are re-inserted
     by `seed()` with `skipDuplicates` — a level a test added mid-run therefore
     survives the next file's wipe. Since the final-class flag now lives on that
     row, a leftover flag would leak from one test file into the next and make
     `topGradeBasis: 'final_class'` appear in a file that never set it.

     So the wipe RESETS the flag instead of deleting the row: every level goes
     back to "not final" and each file starts from a school with no final class,
     which is the state the fixture represents. The rows themselves are left
     alone so no class is orphaned and no order is disturbed. */
  await prisma.gradeLevel.updateMany({ where: { isFinal: true }, data: { isFinal: false } });
};

module.exports = { wipeAll };
