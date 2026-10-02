import {Platform} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type {Profile, Match, Interest} from '../shared/matching';

export type EditableProfile = Profile & {version?: string};

const API = (process.env.EXPO_PUBLIC_API_URL || (Platform.OS === 'web' ? '' : 'http://localhost:8788')).replace(/\/$/, '');
const SESSION_KEY = 'sai-session';

export type SourceState = {
  status: string;
  itemCount: number;
  candidateCount: number;
  updated?: string | null;
  summary?: unknown;
  samples: string[];
  counts: Record<string, number>;
  errors?: string[];
  channels?: {id: string; title: string; description: string; url: string}[];
};

export type LinkedInImportJob = {
  jobId: string;
  status: 'pending' | 'ready' | 'failed';
  url: string;
  candidates?: Interest[];
  error?: string;
};

export type Assignment = {
  size: number;
  selected: string[];
  groups: string[][];
  unassigned: string[];
  created?: string;
  bridgeTopics?: Match[];
};

export type Room = {
  id: string;
  owner: string;
  name: string;
  created: string;
  count: number;
  isDemo?: boolean;
};

export type RoomDetails = Omit<Room, 'count'> & {
  count?: number;
  members: Profile[];
  plan: Assignment | null;
};

export type ServiceState = {
  account: {username: string; instagramHandle?: string; linkedinHandle?: string} | null;
  me: EditableProfile | null;
  rooms: Room[];
  friends: Profile[];
  requests: Profile[];
  sent: string[];
  selectedRoom: RoomDetails | null;
  sources?: {youtube: SourceState; linkedin: SourceState} | null;
};

export class ServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ServiceError';
  }
}

export async function serviceRequest<T>(token: string, path = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}/api/app${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal,
  });
  const value = await response.json().catch(() => ({error: '서버 응답을 읽지 못했어요.'}));
  if (!response.ok) throw new ServiceError(value.error || '요청을 처리하지 못했어요. 다시 시도해주세요.', response.status);
  return value as T;
}

export function tokenRead(): Promise<string | null> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.localStorage?.getItem(SESSION_KEY) ?? null);
  return SecureStore.getItemAsync(SESSION_KEY);
}

export async function tokenSave(token: string): Promise<void> {
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(SESSION_KEY, token);
  else await SecureStore.setItemAsync(SESSION_KEY, token);
}

export async function tokenClear(): Promise<void> {
  if (Platform.OS === 'web') globalThis.localStorage?.removeItem(SESSION_KEY);
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export function getServiceState(token: string, roomId?: string, signal?: AbortSignal): Promise<ServiceState> {
  const path = roomId ? `?room=${encodeURIComponent(roomId)}` : '';
  return serviceRequest<ServiceState>(token, path, undefined, signal);
}

export function serviceAction<T>(token: string, action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  return serviceRequest<T>(token, '', {...body, action}, signal);
}

export function getSharedProfile(token: string, id: string, signal?: AbortSignal): Promise<Profile> {
  return serviceRequest<{profile: Profile}>(token, `?profile=${encodeURIComponent(id)}`, undefined, signal).then(value => value.profile);
}
