import type { ObjectId } from 'mongodb';

export type ActivityLinkDoc = {
  entityType: string;
  entityId: string;
  nameSnapshot?: string;
  orphaned?: boolean;
};

/**
 * MongoDB document shape for `crm_activities`.
 * `overdueNotifiedAt` is internal (anti-duplicate for `crm.activity.overdue`) — not in proto/API.
 */
export type ActivityDoc = {
  _id: ObjectId;
  projectId: string;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: number | null;
  startDate: number | null;
  endDate: number | null;
  allDay: boolean;
  direction: string;
  duration: number | null;
  actualDuration: number | null;
  location: string;
  participants: string[];
  result: string;
  assigneeId: string;
  assigneeName?: string;
  /** FIELD-ACT-departmentId (W-6): подразделение-владелец рядом с assigneeId. */
  departmentId?: string;
  createdBy: string;
  links: ActivityLinkDoc[];
  reminderOffset: string;
  reminderFireAt: number | null;
  reminderState: string;
  completedAt: number | null;
  deletedAt: number | null;
  /** First publish moment of `crm.activity.overdue` (anti-duplicate). */
  overdueNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
