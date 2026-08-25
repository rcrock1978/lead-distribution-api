/**
 * Published API surface TYPES — the twin of ./index.ts (Zod schemas).
 * `npm run contracts:build` emits THIS file's declarations only (dependency-
 * free .d.ts), synced into the frontend repo by `contracts:sync`. Both halves
 * MUST change together; CI + pre-push drift-check the emitted artifact.
 */
export type LeadStatusApi = 'unsent' | 'sent' | 'duplicate' | 'failed';
export type AssignmentTypeApi = 'AUTO' | 'MANUAL';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiEnvelope<T> =
  | { success: true; data: T; traceId: string }
  | { success: false; error: ApiErrorBody; traceId: string };

export interface WorkingDays {
  /** ISO weekdays 1=Monday … 7=Sunday, non-empty, unique. */
  days: number[];
}

export interface BrokerInput {
  name: string;
  isActive: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
}

export interface BrokerResponse {
  id: number;
  name: string;
  isActive: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
  sentToday: number;
  isOpenNow: boolean;
  isCapped: boolean;
}

export interface BrokerDetailResponse {
  broker: BrokerResponse;
  leads: LeadListItem[];
  todayStats: { assignedToday: number; capUsagePct: number };
}

export interface FormResponse {
  id: number;
  name: string;
  slug: string;
  publicUrl: string;
  createdAt: string;
}

export interface DistributionResponse {
  id: number;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface DistributionMember {
  brokerId: number;
  name: string;
  percentage: number;
  isActiveInDistribution: boolean;
  sentToday: number;
  isOpenNow: boolean;
  isCapped: boolean;
}

export interface DistributionMemberInput {
  brokerId: number;
  percentage: number;
  isActiveInDistribution: boolean;
}

export interface DistributionDetailResponse {
  distribution: DistributionResponse;
  members: DistributionMember[];
  leadHistory: LeadListItem[];
  statusCounts: { sent: number; duplicate: number; unsent: number; failed: number };
}

/** decisionTrace.exclusions entry — every ineligible broker names its rule. */
export interface TraceExclusion {
  brokerId: number;
  rule: 'inactive' | 'closed' | 'off_day' | 'capped' | 'zero_pct';
}

export interface TraceWinner {
  brokerId: number;
  targetPct: number;
  targetAfterLead: number;
  sentTodayBefore: number;
  deficit: number;
}

export interface DecisionTrace {
  totalSentBefore: number;
  distributionTimezone: string;
  candidatesConsidered: number;
  exclusions: TraceExclusion[];
  winner: TraceWinner | null;
  reason?: string;
}

export interface LeadListItem {
  id: number;
  name: string;
  email: string;
  phone: string;
  ipAddress: string;
  status: LeadStatusApi;
  brokerId: number | null;
  brokerName: string | null;
  assignmentType: AssignmentTypeApi | null;
  failureReason: string | null;
  createdAt: string;
}

export interface LeadListResponse {
  items: LeadListItem[];
  nextCursor?: string;
}

/** Full detail INCLUDING decisionTrace (list payloads exclude it by design). */
export interface LeadDetail extends LeadListItem {
  decisionTrace: DecisionTrace;
}

export interface PublicFormResponse {
  name: string;
  slug: string;
}

export interface SubmissionInput {
  name: string;
  email: string;
  phone: string;
  /** Honeypot — must be absent or empty. */
  website?: string;
}

export interface SubmissionAccepted {
  received: boolean;
}

export interface DashboardSummary {
  setup: {
    hasForm: boolean;
    hasDistribution: boolean;
    brokerCount: number;
    workerHealthy: boolean;
  };
  leadCounts: { sent: number; duplicate: number; unsent: number; failed: number };
  recentLeads: LeadListItem[];
  worker: {
    lastBeatAt: string;
    ageSeconds: number;
    processedTotal: number;
    version: string;
  };
}

export interface OutboxStatusResponse {
  depths: Record<string, number>;
  oldestPendingAgeMs: number | null;
  dead: Array<{
    id: string;
    type: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
  }>;
}

export interface LogsTailQuery {
  level?: string;
  event?: string;
  traceId?: string;
  n?: number;
}

export interface LogEvent {
  ts: string;
  level: string;
  event: string;
  process?: string;
  traceId?: string;
  [key: string]: unknown;
}

export interface SimulateResponse {
  selected: { brokerId: number } | null;
  trace: DecisionTrace;
}

export interface UserResponse {
  id: number;
  email: string;
}
