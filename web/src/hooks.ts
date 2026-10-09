import { useQuery } from '@tanstack/react-query';
import { api } from './api';

const long = { staleTime: 60_000 };

export interface UserLite { id: number; name: string; role: string; team_id: number | null; active: boolean; email?: string }
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<UserLite[]>('/api/users'), ...long });
export const useCourses = () => useQuery({ queryKey: ['courses'], queryFn: () => api.get<any[]>('/api/courses'), ...long });
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<any[]>('/api/tags'), ...long });
export const usePipelines = () => useQuery({ queryKey: ['pipelines'], queryFn: () => api.get<any[]>('/api/pipelines'), ...long });
export const useCampaigns = () => useQuery({ queryKey: ['campaigns'], queryFn: () => api.get<any[]>('/api/campaigns'), ...long });
export const useLostReasons = () => useQuery({ queryKey: ['lost-reasons'], queryFn: () => api.get<any[]>('/api/lost-reasons'), ...long });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/api/settings'), ...long });
export const useCustomFields = () => useQuery({ queryKey: ['custom-fields'], queryFn: () => api.get<any[]>('/api/custom-fields'), ...long });
export const useQuickReplies = () => useQuery({ queryKey: ['quick-replies'], queryFn: () => api.get<any[]>('/api/quick-replies'), ...long });
export const useWaAccounts = () => useQuery({ queryKey: ['wa-accounts'], queryFn: () => api.get<any[]>('/api/wa/accounts'), ...long });
export const useTeams = () => useQuery({ queryKey: ['teams'], queryFn: () => api.get<any[]>('/api/teams'), ...long });
