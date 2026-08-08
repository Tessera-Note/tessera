export interface ITemplate {
  id: string;
  title: string;
  description?: string;
  content?: any;
  icon: string | null;
  spaceId: string | null;
  workspaceId: string;
  creatorId: string;
  lastUpdatedById?: string;
  creator?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}
