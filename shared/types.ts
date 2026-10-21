/** Types shared between the API server and the web client. Dates are ISO calendar dates (YYYY-MM-DD). */

export type IsoDate = string;

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export type DateSource = 'explicit' | 'children' | 'sprint' | 'version' | 'none';

export type ScopeSource = 'board' | 'filter' | 'jql';

export interface ScopeRequest {
  source: ScopeSource;
  /** Board ID, saved filter ID, or a JQL string. */
  value: string;
  /** Include epics resolved within the last N days (default 30). Use -1 to include all done epics. */
  doneWithinDays?: number;
}

export interface UserRef {
  accountId: string;
  displayName: string;
  avatarUrl?: string;
}

export interface TeamRef {
  id: string;
  name: string;
}

export interface SprintRef {
  id: number;
  name: string;
  state: 'future' | 'active' | 'closed' | string;
  boardId?: number;
  start?: IsoDate;
  end?: IsoDate;
}

export interface VersionRef {
  id: string;
  name: string;
  projectKey: string;
  released: boolean;
  releaseDate?: IsoDate;
}

export interface Progress {
  todo: number;
  inProgress: number;
  done: number;
  total: number;
}

export interface TimelineItem {
  key: string;
  id: string;
  summary: string;
  url: string;
  projectKey: string;
  projectName: string;
  issueType: string;
  issueTypeIconUrl?: string;
  /** Jira hierarchy level: 1 = epic, 0 = standard work item, -1 = subtask. */
  hierarchyLevel: number;
  status: string;
  statusCategory: StatusCategory;
  parentKey?: string;
  /** Dates stored on the work item in Jira. */
  start?: IsoDate;
  due?: IsoDate;
  /** Dates used for drawing: explicit when present, otherwise rolled up / inferred. */
  effectiveStart?: IsoDate;
  effectiveEnd?: IsoDate;
  dateSource: DateSource;
  assignee?: UserRef;
  team?: TeamRef;
  sprints: SprintRef[];
  fixVersions: VersionRef[];
  /** Child progress for epics (by status category). */
  progress?: Progress;
  childKeys: string[];
}

export interface Dependency {
  /** Jira issue link id. */
  id: string;
  /** The work item that blocks. */
  fromKey: string;
  /** The work item that is blocked. */
  toKey: string;
  type: string;
}

export interface SprintMarker {
  id: number;
  name: string;
  state: string;
  boardId?: number;
  start: IsoDate;
  end: IsoDate;
}

export interface ReleaseMarker {
  /** Releases are grouped across projects by version name. */
  name: string;
  date: IsoDate;
  released: boolean;
  projects: string[];
}

export interface TimelineResponse {
  scope: { jql: string; label: string };
  items: TimelineItem[];
  dependencies: Dependency[];
  sprints: SprintMarker[];
  releases: ReleaseMarker[];
  fields: { startDateFieldId?: string; sprintFieldId?: string; teamFieldId?: string };
  warnings: string[];
  truncated: boolean;
  generatedAt: string;
}

export interface SiteRef {
  cloudId: string;
  name: string;
  url: string;
}

export interface MeResponse {
  authenticated: boolean;
  mode: 'oauth' | 'token' | 'mock';
  user?: UserRef;
  site?: SiteRef;
  /** Present when the OAuth grant covers several Atlassian sites and the user must choose one. */
  sites?: SiteRef[];
}

export interface BoardRef {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
}

export interface UpdateDatesRequest {
  start: IsoDate | null;
  due: IsoDate | null;
}

export interface CreateDependencyRequest {
  fromKey: string;
  toKey: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
