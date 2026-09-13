-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'student', 'parent', 'teacher', 'accountant', 'librarian');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'absent', 'late', 'half_day', 'holiday');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('casual', 'sick', 'earned');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('Permanent', 'Contract', 'Probation', 'Temporary');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('Female', 'Male', 'Other');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "profilePhoto" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Class" (
    "id" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "classTeacherId" TEXT,

    CONSTRAINT "Class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeachingAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "room" TEXT,
    "isClassTeacher" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TeachingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "photo" TEXT,
    "classId" TEXT NOT NULL,
    "admissionYear" INTEGER,
    "rollNumber" TEXT,
    "feeTotal" INTEGER,
    "feeDues" INTEGER,
    "parentName" TEXT,
    "guardianContact" TEXT,
    "address" TEXT,
    "bloodGroup" TEXT,
    "dob" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "photo" TEXT,
    "gender" "Gender",
    "dob" DATE,
    "bloodGroup" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "address" TEXT,
    "emergencyContact" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "role" "Role",
    "qualification" TEXT,
    "dateOfJoining" DATE,
    "experience" TEXT,
    "reportingPrincipal" TEXT,
    "employmentType" "EmploymentType",
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAttendance" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,

    CONSTRAINT "StudentAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAttendance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "workingHours" DOUBLE PRECISION,

    CONSTRAINT "EmployeeAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksEntry" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "obtained" INTEGER NOT NULL,

    CONSTRAINT "MarksEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetablePeriod" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "timeStart" TEXT NOT NULL,
    "timeEnd" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "teacherName" TEXT NOT NULL,
    "room" TEXT,

    CONSTRAINT "TimetablePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyllabusEntry" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "topics" TEXT[],
    "completedPercent" INTEGER NOT NULL,

    CONSTRAINT "SyllabusEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "employeeId" TEXT NOT NULL,
    "casual" INTEGER NOT NULL DEFAULT 0,
    "sick" INTEGER NOT NULL DEFAULT 0,
    "earned" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "LeaveType" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'pending',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "basicPay" INTEGER NOT NULL,
    "hra" INTEGER NOT NULL DEFAULT 0,
    "transportAllowance" INTEGER NOT NULL DEFAULT 0,
    "medicalAllowance" INTEGER NOT NULL DEFAULT 0,
    "providentFund" INTEGER NOT NULL DEFAULT 0,
    "professionalTax" INTEGER NOT NULL DEFAULT 0,
    "tds" INTEGER NOT NULL DEFAULT 0,
    "netSalary" INTEGER NOT NULL,
    "paidOn" DATE,

    CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "targetRoles" "Role"[],
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Class_grade_section_key" ON "Class"("grade", "section");

-- CreateIndex
CREATE UNIQUE INDEX "TeachingAssignment_employeeId_classId_key" ON "TeachingAssignment"("employeeId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_rollNumber_key" ON "Student"("rollNumber");

-- CreateIndex
CREATE INDEX "Student_classId_idx" ON "Student"("classId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE INDEX "StudentAttendance_date_idx" ON "StudentAttendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAttendance_studentId_date_key" ON "StudentAttendance"("studentId", "date");

-- CreateIndex
CREATE INDEX "EmployeeAttendance_date_idx" ON "EmployeeAttendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeAttendance_employeeId_date_key" ON "EmployeeAttendance"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_classId_name_key" ON "Exam"("classId", "name");

-- CreateIndex
CREATE INDEX "MarksEntry_examId_idx" ON "MarksEntry"("examId");

-- CreateIndex
CREATE UNIQUE INDEX "MarksEntry_studentId_examId_subject_key" ON "MarksEntry"("studentId", "examId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "TimetablePeriod_classId_period_key" ON "TimetablePeriod"("classId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "SyllabusEntry_classId_subject_key" ON "SyllabusEntry"("classId", "subject");

-- CreateIndex
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRecord_employeeId_month_key" ON "PayrollRecord"("employeeId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_date_key" ON "Holiday"("date");

-- CreateIndex
CREATE INDEX "AuditEntry_createdAt_idx" ON "AuditEntry"("createdAt");

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_classTeacherId_fkey" FOREIGN KEY ("classTeacherId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeachingAssignment" ADD CONSTRAINT "TeachingAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeachingAssignment" ADD CONSTRAINT "TeachingAssignment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAttendance" ADD CONSTRAINT "StudentAttendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAttendance" ADD CONSTRAINT "EmployeeAttendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksEntry" ADD CONSTRAINT "MarksEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksEntry" ADD CONSTRAINT "MarksEntry_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyllabusEntry" ADD CONSTRAINT "SyllabusEntry_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
